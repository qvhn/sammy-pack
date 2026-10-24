/**
 * Lifecycle / chaos test harness.
 *
 * The unit/component tests in this suite verify each part in isolation;
 * production failed at the LIFECYCLE SEAMS between them — restart with a
 * paused run, resume inside a map iteration, cancel racing a concurrency
 * queue, trigger re-registration across a re-mount, env drift, cron
 * double-fires, crash recovery. This helper boots the REAL stack for those
 * seams:
 *
 *   REAL: `mountSammyApi` on a plain connect + http.Server (the serve.ts
 *         production path), a REAL `SqliteRunStore` on a runs.db in a
 *         per-test temp workspace, the REAL executor (`runOrchestration`)
 *         driven through the REAL HTTP endpoints (/api/runs/start, /gate,
 *         /resume, /cancel, /api/triggers, /api/orchestrations).
 *   FAKE: nothing is mocked — instead the workloads are `code.source`
 *         phases (pure in-process vm transforms: no LLM, no network, no
 *         subprocess) and `lock: true` gates, so runs execute in
 *         milliseconds and deterministically. `code.run` appears only in
 *         the env-drift case, where the preflight halt IS the assertion.
 *
 * "Process death" is simulated by tearing down everything a real crash
 * loses — the run-controller's in-memory active map (`_resetForTests`),
 * the HTTP server, and the sqlite handle — then re-mounting a fresh
 * closure against the SAME runs.db file, exactly like a serve.ts restart.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import * as cron from 'node-cron';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import {
  destroyAllPollers,
  livePollerNames,
} from '../src/server/poll-registry';
import { _resetForTests as _resetRunController } from '../src/server/run-controller';

// ─── Env hygiene ────────────────────────────────────────────────────────────
// mountSammyApi changes behavior on all of these. The harness pins a known
// configuration per test file and restores whatever the outer environment had.

const MANAGED_ENV_KEYS = [
  'DATABASE_URL',
  'SAMMY_DISABLE_INPROCESS_WORKER',
  'SAMMY_API_TOKEN',
  'SAMMY_JWKS_URI',
  'SAMMY_JWT_PUBLIC_KEY',
  'SAMMY_JWT_SECRET',
  'SAMMY_AUTO_RESUME',
  'SAMMY_CRON_AUTO_PAUSE',
  'SAMMY_HEALTH_PROBE',
  'SAMMY_CONNECTIONS_FILE',
  'SAMMY_ALLOW_CODE_RUN',
  'SAMMY_WEBHOOK_SECRET',
  'SAMMY_MAX_QUEUE_DEPTH',
  'SAMMY_MAX_BODY_BYTES',
  'SAMMY_POLL_TIMEOUT_MS',
  'SAMMY_POLL_MAX_BODY_BYTES',
  // Posture + policy knobs added since the list was first written. Each one
  // changes an HTTP outcome the lifecycle cases assert on (a 403 for a
  // read-role identity, gated reads, refused unsigned ingress, a public
  // /metrics, stream-tool policing, import containment, sweep cadence), so
  // an ambient value in the developer's shell — SAMMY_READONLY_USERS=alice
  // was the one that surfaced — failed dozens of cases that never set it.
  'SAMMY_READONLY_USERS',
  'SAMMY_REQUIRE_AUTH_READS',
  'SAMMY_JWT_ROLE_CLAIM',
  'SAMMY_REQUIRE_SIGNED_TRIGGERS',
  'SAMMY_METRICS_PUBLIC',
  'SAMMY_NOTIFY_ALLOWED_HOSTS',
  'SAMMY_LLM_STREAM_TOOLS',
  'SAMMY_LLM_STREAM_TOOL_ALLOWLIST',
  'SAMMY_LLM_STREAM_PERMISSION_MODE',
  'SAMMY_IMPORT_ROOTS',
  'SAMMY_ORPHAN_SWEEP_MS',
  'SAMMY_RETENTION_BATCH',
  // Where repository URLs are looked up as local clones (repo-locate).
  'SAMMY_REPO_ROOTS',
  'SAMMY_GIT_USER_NAME',
  'SAMMY_GIT_USER_EMAIL',
  'SAMMY_AGENT_AMBIENT_MCP',
  'SAMMY_GH_CLI_FALLBACK',
] as const;

/** Snapshot the managed env keys and pin the harness baseline: no Postgres,
 *  no auth gates, no auto-resume, no in-process delivery worker (deliveries
 *  stay observable as durable rows instead of racing into runs), and
 *  SAMMY_ALLOW_CODE_RUN unset (the env-drift case toggles it explicitly).
 *  Returns a restore fn for afterAll. */
export function pinTestEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of MANAGED_ENV_KEYS) saved.set(k, process.env[k]);
  for (const k of MANAGED_ENV_KEYS) delete process.env[k];
  process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ─── Workspace ──────────────────────────────────────────────────────────────

/** Create a throwaway workspace (repo-root shaped) for one test file. */
export async function makeWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `sammy-lifecycle-${prefix}-`));
}

/** Write an orchestration JSON into the workspace's examples/ dir (the
 *  directory the mount's boot scan + loadRunContext read). */
export async function writeOrchestration(
  tmpRoot: string,
  node: Record<string, unknown> & { name: string },
): Promise<void> {
  const dir = path.join(tmpRoot, 'examples');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${node.name}.json`),
    JSON.stringify(node, null, 2) + '\n',
    'utf8',
  );
}

// ─── Mount / restart ────────────────────────────────────────────────────────

export type Mount = {
  baseUrl: string;
  tmpRoot: string;
  store: SqliteRunStore;
  server: http.Server;
  /** Tear down this mount the way a process death would: drop the
   *  run-controller's in-memory state, sever sockets, close the db handle.
   *  Safe to call twice. */
  kill(): Promise<void>;
};

/** Boot the full API surface exactly the way serve.ts does — connect stack +
 *  http.Server + mountSammyApi — against `tmpRoot` as the repo root, with a
 *  directly-constructed SqliteRunStore (same injection seam the existing
 *  serve-mount tests use, since boot's openRunStore uses a dynamic import
 *  jest can't resolve). Re-mounting over the same tmpRoot = a restart against
 *  the same durable runs.db. */
export async function mountServer(tmpRoot: string): Promise<Mount> {
  const store = new SqliteRunStore(tmpRoot);
  await store.init();
  const app = connect();
  const server = http.createServer(app);
  await mountSammyApi(
    {
      middlewares: app,
      // repoRoot() resolves two levels up from the vite-style root, so this
      // hands the mount `tmpRoot` — identical to serve.ts's construction.
      config: { root: path.join(tmpRoot, 'app', 'web') },
      httpServer: server,
    },
    { store },
  );
  await new Promise<void>(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let dead = false;
  const kill = async (): Promise<void> => {
    if (dead) return;
    dead = true;
    // What a crash loses, in the order a crash loses it: in-memory controller
    // state first (any live pump aborts), then the socket, then the db handle.
    _resetRunController();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Node's fetch pools keep-alive connections; make close() deterministic.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await store.close();
  };

  return { baseUrl, tmpRoot, store, server, kill };
}

/** Remove every node-cron task the API registered (their names are
 *  `sammy:cron:<orch>:<expr>`). node-cron's registry is process-global —
 *  exactly the restart-leak surface one of the cases pins — so only the
 *  trigger tests call this, in their afterAll. */
export function destroySammyCronTasks(): void {
  const getTasks = (
    cron as unknown as {
      getTasks?: () => Map<string, { name?: string; destroy?: () => void }>;
    }
  ).getTasks;
  if (typeof getTasks !== 'function') return;
  for (const task of getTasks().values()) {
    if (typeof task?.name === 'string' && task.name.startsWith('sammy:cron:')) {
      try {
        task.destroy?.();
      } catch {
        /* already destroyed */
      }
    }
  }
}

/** Stop every polling timer in the PROCESS-GLOBAL poll registry, and return
 *  the names stopped. The polling twin of destroySammyCronTasks: both
 *  registries outlive a mount on purpose, so a test that mounts must clear
 *  them or its pollers keep fetching into the next test. */
export function destroySammyPollers(): string[] {
  return destroyAllPollers();
}

/** Names of the live pollers — the registry truth, as opposed to what any one
 *  mount's closure happens to remember. */
export function livePollers(): string[] {
  return livePollerNames();
}

/** All live node-cron tasks whose deterministic name starts with the given
 *  prefix (destroyed tasks drop out of the registry automatically). */
export function sammyCronTasksNamed(
  prefix: string,
): Array<{ name?: string; execute?: () => Promise<unknown> }> {
  const getTasks = (
    cron as unknown as {
      getTasks?: () => Map<
        string,
        { name?: string; execute?: () => Promise<unknown> }
      >;
    }
  ).getTasks;
  if (typeof getTasks !== 'function') return [];
  const out: Array<{ name?: string; execute?: () => Promise<unknown> }> = [];
  for (const task of getTasks().values()) {
    if (typeof task?.name === 'string' && task.name.startsWith(prefix)) {
      out.push(task);
    }
  }
  return out;
}

// ─── HTTP client helpers ────────────────────────────────────────────────────

export async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T = unknown>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export async function putJson<T = unknown>(
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

// ─── Run-shaped accessors ───────────────────────────────────────────────────

export type ApiEvent = Record<string, unknown> & { type: string; ts?: number };

/** GET /api/runs/:id response shape. The endpoint maps null → undefined
 *  (dropped keys) for the optional columns, so they're optional here — a
 *  paused run has NO `endedAt` key, a finished one has NO `pausedFor`. */
export type ApiRun = {
  id: string;
  orchestrationName: string;
  status: string;
  pausedFor?: string;
  startedAt: number;
  endedAt?: number;
  initialInput?: string;
  lastOutput?: string;
  completedLeaves?: string[];
  stateJson?: { leafOutputs?: Record<string, string> };
  events: ApiEvent[];
};

export async function getRun(baseUrl: string, id: string): Promise<ApiRun> {
  return getJson<ApiRun>(`${baseUrl}/api/runs/${id}`);
}

export type RunListEntry = {
  id: string;
  orchestrationName: string;
  status: string;
  pausedFor?: string;
  initialInput?: string;
};

export async function listRuns(baseUrl: string): Promise<RunListEntry[]> {
  return getJson<RunListEntry[]>(`${baseUrl}/api/runs`);
}

export type StartResult = { id: string | null; concurrency?: string };

export async function startRun(
  baseUrl: string,
  orchestrationName: string,
  initialInput?: string,
): Promise<StartResult> {
  const { status, body } = await postJson<StartResult>(
    `${baseUrl}/api/runs/start`,
    { orchestrationName, ...(initialInput !== undefined ? { initialInput } : {}) },
  );
  if (status !== 200) {
    throw new Error(`start ${orchestrationName} → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function approveGate(
  baseUrl: string,
  id: string,
  message?: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson<Record<string, unknown>>(
    `${baseUrl}/api/runs/${id}/gate`,
    { decision: 'approve', ...(message ? { message } : {}) },
  );
  if (status !== 200) {
    throw new Error(`gate approve ${id} → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function cancelRun(
  baseUrl: string,
  id: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson<Record<string, unknown>>(
    `${baseUrl}/api/runs/${id}/cancel`,
  );
  if (status !== 200) {
    throw new Error(`cancel ${id} → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function resumeRun(
  baseUrl: string,
  id: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson<Record<string, unknown>>(
    `${baseUrl}/api/runs/${id}/resume`,
  );
  if (status !== 200) {
    throw new Error(`resume ${id} → ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** GET /api/runs/:id/events — the SSE surface. For a finished run the server
 *  replays the durable log, writes `[DONE]`, and ends the response, so a
 *  plain text read terminates. Returns the parsed events (without [DONE]). */
export async function readEventStream(
  baseUrl: string,
  id: string,
): Promise<ApiEvent[]> {
  const res = await fetch(`${baseUrl}/api/runs/${id}/events`);
  if (!res.ok) throw new Error(`events ${id} → ${res.status}`);
  const text = await res.text();
  const events: ApiEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') break;
    events.push(JSON.parse(payload) as ApiEvent);
  }
  return events;
}

// ─── Polling ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Poll `probe` until it returns a truthy value; throw (with the label +
 *  last-seen detail) on timeout. Default 25s / 15ms — every workload here is
 *  a code.source run that settles in milliseconds, so the budget is pure
 *  headroom for a loaded machine: the full suite runs ~10 jest workers, each
 *  mounting its own server, beside the Docker test containers, and at 8s
 *  this timed out under that load often enough to flake (`lifecycle-cancel-
 *  queue`, once in four full runs). Raising it cannot mask a defect — a run
 *  that genuinely stalls never settles, so the case still fails, just
 *  later. */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  const intervalMs = opts?.intervalMs ?? 15;
  const start = Date.now();
  let last: unknown;
  for (;;) {
    const v = await probe();
    if (v) return v;
    last = v;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor(${label}) timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Wait until the run's status is one of `statuses` and (optionally) an extra
 *  predicate holds — the extra predicate is what makes "paused AGAIN at the
 *  NEXT gate" race-free (status alone can match the previous pause). */
export async function waitForRun(
  baseUrl: string,
  id: string,
  statuses: string[],
  also?: (run: ApiRun) => boolean,
  label?: string,
): Promise<ApiRun> {
  return waitFor(
    async () => {
      const run = await getRun(baseUrl, id);
      if (!statuses.includes(run.status)) return null;
      if (also && !also(run)) return null;
      return run;
    },
    label ?? `run ${id} → ${statuses.join('|')}`,
  );
}

// ─── Event inspection ───────────────────────────────────────────────────────

export function eventsOfType(run: { events: ApiEvent[] }, type: string): ApiEvent[] {
  return run.events.filter(e => e.type === type);
}

/** The lock-gate events' iteration-scoped replayKeys, in emission order. */
export function lockGateKeys(run: { events: ApiEvent[] }): string[] {
  return eventsOfType(run, 'lock-gate').map(e =>
    typeof e.replayKey === 'string' ? (e.replayKey as string) : String(e.phaseName),
  );
}

export function leafOutputs(run: ApiRun): Record<string, string> {
  return run.stateJson?.leafOutputs ?? {};
}

// ─── Self-test ──────────────────────────────────────────────────────────────
// This module lives under __tests__/ (the harness may only add files here)
// and the jest preset's testMatch (`**/__tests__/**/*.[jt]s?(x)`) picks up
// every .ts file in the directory — an export-only module would fail the run
// with "must contain at least one test". This block keeps the file a valid
// (and honest) suite; the real lifecycle cases live in lifecycle-*.test.ts.
describe('lifecycle harness helpers', () => {
  it('exports the mount/restart seams the lifecycle cases build on', () => {
    expect(typeof mountServer).toBe('function');
    expect(typeof pinTestEnv).toBe('function');
    expect(typeof writeOrchestration).toBe('function');
    expect(typeof waitForRun).toBe('function');
    expect(typeof readEventStream).toBe('function');
    expect(typeof destroySammyCronTasks).toBe('function');
  });
});
