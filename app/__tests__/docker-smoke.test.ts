/**
 * IMAGE SMOKE — the shipped container, black-box, over its published port.
 *
 * SKIPPED unless TEST_DOCKER_IMAGE names a built image (same convention as
 * postgres-store.test.ts and integration-queue-sources.test.ts). Build from
 * `git archive`, never from the working tree — `agents/` and `examples/` are
 * git ALLOWLIST directories that may hold imported, untracked content which
 * .dockerignore cannot distinguish (see .dockerignore):
 *
 *   git archive --format=tar HEAD | docker build -t sammy-pack:smoke -
 *   docker compose -f docker-compose.test.yml up -d --wait postgres
 *   cd app && TEST_DOCKER_IMAGE=sammy-pack:smoke npm run test:docker
 *
 * WHY THIS EXISTS: every other suite mounts the API in-process over a temp
 * workspace. None of them executes the Dockerfile — the runtime stage's
 * ENV (SAMMY_BIND_HOST=0.0.0.0, SAMMY_REPO_ROOT=/data), the pruned
 * node_modules + re-added tsx, the /data seed, the `node` user, procps, the
 * HEALTHCHECK's own probe — or the two-process Postgres topology where a
 * dedicated worker container drains what a server container accepted. Those
 * are precisely the things that are green in jest and broken in `docker run`.
 *
 * Every assertion here is made through HTTP against the container, with the
 * HARDENED posture an operator is told to run (bearer token, gated reads, a
 * read-only identity), so the suite doubles as the end-to-end check of the
 * security seams: bearer gate, owner scoping, the SSE identity channel, the
 * role gate on trigger ingress, the cross-site guard, root /metrics.
 *
 * Two topologies:
 *   A. single container, SQLite on a named volume — including a `docker
 *      restart` with a run parked at a durable wait, which proves the volume,
 *      the checkpoint replay and the orchestration-snapshot pin all survive
 *      the process boundary the image actually has.
 *   B. server + worker containers on the throwaway Postgres from
 *      docker-compose.test.yml (TEST_DOCKER_PG_URL, reached through
 *      host.docker.internal) — a trigger accepted by the server is executed
 *      by the worker.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  eventsOfType,
  leafOutputs,
  sleep,
  waitFor,
  type ApiRun,
} from './lifecycle-harness.helpers';

jest.setTimeout(180_000);

const IMAGE = process.env.TEST_DOCKER_IMAGE;
const PG_URL = process.env.TEST_DOCKER_PG_URL;
const suite = IMAGE ? describe : describe.skip;
const pgSuite = IMAGE && PG_URL ? describe : describe.skip;

const TOKEN = 'smoke-bearer-token';
const RUN_TAG = randomBytes(4).toString('hex');

// ─── docker plumbing ─────────────────────────────────────────────────────────

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

type Container = { id: string; name: string; baseUrl: string };

/** `docker run -d` with the port published on an ephemeral loopback port, so
 *  two suites (or a developer's own server on 5173) never collide. */
function startServer(
  name: string,
  env: Record<string, string>,
  opts: { volume: string; command?: string[] },
): Container {
  const args = [
    'run', '-d', '--init', '--name', name,
    '-p', '127.0.0.1:0:5173',
    '-v', `${opts.volume}:/data`,
    // Linux needs the explicit host-gateway alias; Docker Desktop resolves
    // host.docker.internal already and ignores the duplicate harmlessly.
    '--add-host', 'host.docker.internal:host-gateway',
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE as string);
  if (opts.command) args.push(...opts.command);
  const id = docker(...args);
  return { id, name, baseUrl: publishedUrl(id) };
}

/** The host side of the `:0` publish. Re-read after every `docker restart`:
 *  an ephemeral mapping is re-allocated when the container starts again. */
function publishedUrl(id: string): string {
  const port = docker('port', id, '5173').split('\n')[0].split(':').pop();
  return `http://127.0.0.1:${port}`;
}

function startWorker(name: string, env: Record<string, string>, volume: string): string {
  const args = [
    'run', '-d', '--init', '--no-healthcheck', '--name', name,
    '-v', `${volume}:/data`,
    '--add-host', 'host.docker.internal:host-gateway',
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE as string, 'node', '--import', 'tsx', 'worker.ts');
  return docker(...args);
}

function rm(...names: string[]): void {
  for (const n of names) {
    try { docker('rm', '-f', '-v', n); } catch { /* already gone */ }
  }
}

function rmVolume(name: string): void {
  try { docker('volume', 'rm', '-f', name); } catch { /* already gone */ }
}

/** Both streams: `docker logs` replays the container's stdout AND stderr on
 *  the matching host streams, and the lines that explain a failure — a
 *  `[serve] fatal:`, a worker's `console.error` — are on stderr. */
function logs(name: string): string {
  const r = spawnSync('docker', ['logs', '--tail', '80', name], { encoding: 'utf8' });
  if (r.error) return '(no logs)';
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

/** The container's process state, as `docker inspect` reports it. `health`
 *  is the image HEALTHCHECK's verdict (`starting` / `healthy` / `unhealthy`),
 *  or `none` when the container was started with `--no-healthcheck`. */
function inspectState(name: string): { running: boolean; exitCode: number; health: string } {
  const raw = docker(
    'inspect', '--format',
    '{{.State.Running}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    name,
  );
  const [running, exitCode, health] = raw.split(' ');
  return { running: running === 'true', exitCode: Number(exitCode), health };
}

/** Run a throwaway shell in a minimal image against a named volume — how an
 *  operator pre-populates or inspects /data without the app image. */
function onVolume(volume: string, script: string): string {
  return docker('run', '--rm', '-v', `${volume}:/data`, 'alpine:3.20', 'sh', '-c', script);
}

/** The image HEALTHCHECK's own probe, polled from the host. */
async function waitReady(c: Container): Promise<void> {
  await waitFor(
    async () => {
      try {
        const r = await fetch(`${c.baseUrl}/api/readyz`);
        return r.status === 200;
      } catch {
        return false;
      }
    },
    `${c.name} readyz`,
    { timeoutMs: 90_000, intervalMs: 500 },
  ).catch(e => {
    throw new Error(`${String(e)}\n--- ${c.name} logs ---\n${logs(c.name)}`);
  });
}

// ─── HTTP as a given identity ────────────────────────────────────────────────

type Who = { owner?: string; token?: string | null; extra?: Record<string, string> };

function headersFor(who: Who, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (who.token !== null) h.authorization = `Bearer ${who.token ?? TOKEN}`;
  if (who.owner) h['x-sammy-user'] = who.owner;
  if (json) h['content-type'] = 'application/json';
  return { ...h, ...(who.extra ?? {}) };
}

async function get(c: Container, path: string, who: Who = {}): Promise<Response> {
  return fetch(`${c.baseUrl}${path}`, { headers: headersFor(who) });
}

async function send(
  c: Container,
  method: string,
  path: string,
  body: unknown,
  who: Who = {},
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${c.baseUrl}${path}`, {
    method,
    headers: headersFor(who, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

async function getRunAs(c: Container, id: string, owner: string): Promise<ApiRun> {
  const r = await get(c, `/api/runs/${id}`, { owner });
  if (!r.ok) throw new Error(`GET /api/runs/${id} as ${owner} → ${r.status}`);
  return (await r.json()) as ApiRun;
}

async function waitForRunAs(
  c: Container,
  id: string,
  owner: string,
  statuses: string[],
): Promise<ApiRun> {
  return waitFor(
    async () => {
      const run = await getRunAs(c, id, owner);
      return statuses.includes(run.status) ? run : null;
    },
    `run ${id} → ${statuses.join('|')}`,
    { timeoutMs: 60_000, intervalMs: 250 },
  );
}

// ─── Orchestrations the suite deploys through the API ───────────────────────

const ECHO = `smoke-echo-${RUN_TAG}`;
const HOOK = `smoke-hook-${RUN_TAG}`;
const PARK = `smoke-park-${RUN_TAG}`;

/** One orchestration, all four HTTP ingress kinds, so the method check can be
 *  asserted on REGISTERED names (an unknown name is a 404 before any method
 *  check, which would make the assertion vacuous). */
const echoOrch = {
  name: ECHO,
  triggers: [
    { kind: 'webhook', path: HOOK, method: 'POST' },
    { kind: 'events', event: `${HOOK}.happened` },
    { kind: 'deployment', environment: `${HOOK}-env` },
    { kind: 'queue', queue: `${HOOK}-jobs` },
  ],
  phases: [{ name: 'echo', code: { source: "return 'fired:' + (input || '');" } }],
};

/** seed → durable wait → after. `seed` embeds Math.random() so a checkpoint
 *  REPLAY carries it verbatim and a re-execution cannot reproduce it. */
const parkOrch = (afterSource: string) => ({
  name: PARK,
  phases: [
    { name: 'seed', code: { source: "return 'seed-' + Math.random();" } },
    { name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } },
    { name: 'after', code: { source: afterSource } },
  ],
});

// ═════════════════════════════════════════════════════════════════════════════

suite('image smoke — topology A: single container, SQLite, hardened posture', () => {
  const VOLUME = `sammy-smoke-${RUN_TAG}`;
  const NAME = `sammy-smoke-${RUN_TAG}`;
  let c: Container;

  const hardened = {
    SAMMY_API_TOKEN: TOKEN,
    SAMMY_REQUIRE_AUTH_READS: '1',
    SAMMY_READONLY_USERS: 'viewer',
  };

  beforeAll(async () => {
    rm(NAME);
    rmVolume(VOLUME);
    c = startServer(NAME, hardened, { volume: VOLUME });
    await waitReady(c);
  });

  afterAll(() => {
    rm(NAME);
    rmVolume(VOLUME);
  });

  it('boots: the HEALTHCHECK probe, livez and health answer without a token', async () => {
    // Probes carry no identity and must never be gated — otherwise an
    // orchestrator's readiness check fails for an authorization reason.
    for (const p of ['livez', 'readyz', 'health']) {
      const r = await fetch(`${c.baseUrl}/api/${p}`);
      expect([p, r.status]).toEqual([p, 200]);
    }
  });

  it('seeds /data from the image (the named-volume first-use contract)', async () => {
    const r = await get(c, '/api/orchestrations', { owner: 'alice' });
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{ name: string }> | Record<string, unknown>;
    const names = Array.isArray(list) ? list.map(o => o.name) : Object.keys(list);
    expect(names.length).toBeGreaterThan(10); // examples/ shipped in the image
  });

  it('gates reads behind the bearer token when SAMMY_REQUIRE_AUTH_READS=1', async () => {
    expect((await get(c, '/api/runs', { token: null })).status).toBe(401);
    expect((await get(c, '/api/runs', { owner: 'alice' })).status).toBe(200);
  });

  it('deploys an orchestration through PUT and runs it to completion', async () => {
    const put = await send(c, 'PUT', `/api/orchestrations/${ECHO}`, echoOrch, { owner: 'alice' });
    expect(put.status).toBeLessThan(300);

    const start = await send(c, 'POST', '/api/runs/start',
      { orchestrationName: ECHO, initialInput: 'hello' }, { owner: 'alice' });
    expect(start.status).toBe(200);
    const id = String(start.body?.id);
    const run = await waitForRunAs(c, id, 'alice', ['done', 'error']);
    expect(run.status).toBe('done');
    expect(leafOutputs(run).echo).toBe('fired:hello');
  });

  describe('owner scoping and the SSE identity channel', () => {
    let id: string;
    beforeAll(async () => {
      const start = await send(c, 'POST', '/api/runs/start',
        { orchestrationName: ECHO, initialInput: 'mine' }, { owner: 'alice' });
      id = String(start.body?.id);
      await waitForRunAs(c, id, 'alice', ['done']);
    });

    it('another owner reads the run as MISSING, on every door', async () => {
      expect((await get(c, `/api/runs/${id}`, { owner: 'bob' })).status).toBe(404);
      expect((await get(c, `/api/runs/${id}/events`, { owner: 'bob' })).status).toBe(404);
      expect((await send(c, 'POST', `/api/runs/${id}/cancel`, undefined, { owner: 'bob' })).status).toBe(404);
      expect((await send(c, 'DELETE', `/api/runs/${id}`, undefined, { owner: 'bob' })).status).toBe(404);
    });

    it('the owner streams events with the token in the Authorization header', async () => {
      const r = await get(c, `/api/runs/${id}/events`, { owner: 'alice' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      expect(await r.text()).toContain('"type":"run-end"');
    });

    it('an anonymous caller cannot stream by spoofing X-Sammy-User', async () => {
      // The read-exempt branch of the bearer gate let /events through with
      // the identity header intact: no token + a chosen X-Sammy-User streamed
      // any run. Under gated reads the stream is a read like any other, so
      // the answer is the gate's own 401 — not a 404 that would mean the
      // identity header was honoured far enough to look the run up.
      const r = await get(c, `/api/runs/${id}/events`, { owner: 'alice', token: null });
      expect(r.status).toBe(401);
    });

    it('an EventSource (no headers) can authenticate through the query string', async () => {
      // EventSource cannot set headers, so the UI's `new EventSource(url)`
      // has exactly one channel. The token travels as ?token= and is verified
      // by the same code path as the Authorization header; the identity as
      // ?owner=, at the same trust level the header has in this posture.
      const r = await fetch(
        `${c.baseUrl}/api/runs/${id}/events?token=${TOKEN}&owner=alice`,
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('"type":"run-end"');
      // And a wrong token in the query is still a wrong token.
      const bad = await fetch(`${c.baseUrl}/api/runs/${id}/events?token=nope&owner=alice`);
      expect(bad.status).toBe(401);
    });
  });

  describe('roles, cross-site guard, trigger ingress, root /metrics', () => {
    it('a self-identified read-role caller (X-Sammy-User listed in SAMMY_READONLY_USERS) is refused a run start', async () => {
      // In this posture the identity is whatever the caller asserts in the
      // header; the property is that the role gate applies to THAT identity
      // — a token-holding caller who names a read-only user gets the read
      // role, not the write role the token alone would imply.
      const r = await send(c, 'POST', '/api/runs/start', { orchestrationName: ECHO }, { owner: 'viewer' });
      expect(r.status).toBe(403);
      expect(r.body?.error).toMatch(/"read" role/);
    });

    it('an AUTHENTICATED read-role caller cannot fire a trigger either', async () => {
      // Trigger ingress was exempt from the role gate: a viewer refused on
      // /api/runs/start could start the same orchestration via its webhook.
      // The identity only counts when the request proved it (the bearer
      // token here); the next case covers the anonymous sender.
      const r = await send(c, 'POST', `/api/triggers/${HOOK}`, { from: 'viewer' }, { owner: 'viewer' });
      expect(r.status).toBe(403);
    });

    it('an anonymous sender cannot pick an owner: X-Sammy-User is stripped on unauthenticated ingress', async () => {
      // Under the bearer posture ingress is exempt from the token (senders
      // authenticate by HMAC), but a token-less request used to keep its
      // identity header — so anyone could start a run AS alice, resolving
      // her owner-scoped credentials and spending her per-owner cap. Now the
      // fire is attributed to `system`, and naming a read-role owner buys
      // nothing either way.
      const tag = `anon-${RUN_TAG}`;
      const r = await send(c, 'POST', `/api/triggers/${HOOK}`, { tag }, { owner: 'alice', token: null });
      expect(r.status).toBe(202);
      const run = await waitFor(
        async () => {
          const res = await get(c, '/api/runs', { owner: 'system' });
          const rows = (await res.json()) as Array<{ orchestrationName: string; status: string; initialInput?: string }>;
          return rows.find(x => x.orchestrationName === ECHO && String(x.initialInput ?? '').includes(tag) && x.status === 'done') ?? null;
        },
        'anonymous fire landed as system',
        { timeoutMs: 60_000, intervalMs: 300 },
      );
      expect(run.status).toBe('done');
      const asAlice = await get(c, '/api/runs', { owner: 'alice' });
      const aliceRows = (await asAlice.json()) as Array<{ initialInput?: string }>;
      expect(aliceRows.some(x => String(x.initialInput ?? '').includes(tag))).toBe(false);
    });

    it('a browser-originated cross-site write is refused, on /api/runs and on ingress', async () => {
      const cross = { extra: { 'sec-fetch-site': 'cross-site' } };
      const a = await send(c, 'POST', '/api/runs/start', { orchestrationName: ECHO }, { owner: 'alice', ...cross });
      expect(a.status).toBe(403);
      const b = await send(c, 'POST', `/api/triggers/${HOOK}`, { x: 1 }, { token: null, ...cross });
      expect(b.status).toBe(403);
    });

    it('an unsigned webhook from a non-browser sender is accepted and EXECUTED in-process', async () => {
      const r = await send(c, 'POST', `/api/triggers/${HOOK}`, { order: RUN_TAG }, { token: null });
      expect(r.status).toBe(202);
      // Anonymous ingress has no identity → the run belongs to `system`.
      const run = await waitFor(
        async () => {
          const res = await get(c, '/api/runs', { owner: 'system' });
          const rows = (await res.json()) as Array<{ id: string; orchestrationName: string; status: string; initialInput?: string }>;
          return rows.find(x => x.orchestrationName === ECHO && String(x.initialInput ?? '').includes(RUN_TAG) && x.status === 'done') ?? null;
        },
        'triggered run done',
        { timeoutMs: 60_000, intervalMs: 300 },
      );
      expect(run.status).toBe('done');
    });

    it('trigger ingress is POST-only on every mounted path', async () => {
      // The umbrella /api/triggers enforced POST; the three NAMED mounts did
      // not, so a GET fired an event/deploy/queue trigger.
      for (const p of [
        `/api/triggers/${HOOK}`,
        `/api/events/${HOOK}.happened`,
        `/api/deploy/${HOOK}-env`,
        `/api/queue/${HOOK}-jobs`,
      ]) {
        const r = await fetch(`${c.baseUrl}${p}`);
        expect([p, r.status]).toEqual([p, 405]);
      }
    });

    it('root /metrics honours gated reads', async () => {
      // Mounted outside /api, it escaped every gate — including
      // SAMMY_REQUIRE_AUTH_READS — and exposed run/cost counters anonymously.
      expect((await fetch(`${c.baseUrl}/metrics`)).status).toBe(401);
      const ok = await fetch(`${c.baseUrl}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('sammy_');
    });
  });

  describe('docker restart with a run parked at a durable wait', () => {
    let id: string;
    let seedBefore: string;
    let eventsBefore: number;

    beforeAll(async () => {
      const put = await send(c, 'PUT', `/api/orchestrations/${PARK}`,
        parkOrch("return 'after:' + input;"), { owner: 'alice' });
      expect(put.status).toBeLessThan(300);
      const start = await send(c, 'POST', '/api/runs/start', { orchestrationName: PARK }, { owner: 'alice' });
      expect(start.status).toBe(200);
      id = String(start.body?.id);
      const parked = await waitForRunAs(c, id, 'alice', ['paused']);
      seedBefore = leafOutputs(parked).seed;
      eventsBefore = parked.events.length;
      expect(seedBefore).toMatch(/^seed-0\./);

      // Mutate the orchestration ON DISK while the run is parked — the resumed
      // leg must run what the run STARTED under, not today's file.
      const mutate = await send(c, 'PUT', `/api/orchestrations/${PARK}`,
        parkOrch("return 'MODIFIED-AFTER-PAUSE';"), { owner: 'alice' });
      expect(mutate.status).toBeLessThan(300);

      docker('restart', NAME);
      c.baseUrl = publishedUrl(c.id);
      await waitReady(c);
    });

    it('the parked run survives the restart with its checkpoint intact', async () => {
      const run = await getRunAs(c, id, 'alice');
      expect(run.status).toBe('paused');
      expect(leafOutputs(run).seed).toBe(seedBefore);
      expect(run.events.length).toBeGreaterThanOrEqual(eventsBefore);
    });

    it('a signal after the restart resumes it: seed REPLAYED, snapshot PINNED', async () => {
      const sig = await send(c, 'POST', `/api/runs/${id}/signal`, { signal: 'go' }, { owner: 'alice' });
      expect(sig.status).toBe(200);
      const run = await waitForRunAs(c, id, 'alice', ['done', 'error']);
      expect(run.status).toBe('done');
      const out = leafOutputs(run);
      // Replay, not re-execution: Math.random() output carried verbatim.
      expect(out.seed).toBe(seedBefore);
      // The pin: the on-disk edit made while parked is NOT what ran.
      expect(out.after).not.toBe('MODIFIED-AFTER-PAUSE');
      expect(out.after).toMatch(/^after:/);
      expect(eventsOfType(run, 'run-end').length).toBe(1);
    });
  });

  describe('SIGTERM with a run parked at a durable wait (the orchestrator stop path)', () => {
    // `docker stop`, a compose down and a Kubernetes pod delete all deliver
    // SIGTERM and wait a grace period (10s by default) before SIGKILL. The
    // image runs under --init so the signal reaches node; serve.ts closes the
    // listener (which runs the worker/store cleanup) and exits 0 — within its
    // own 5s keep-alive cap, well inside the grace period. A non-zero exit
    // here is what makes a routine deploy look like a crash in the
    // orchestrator's eyes; a run row that does not survive it is data loss.
    let id: string;
    let seedBefore: string;

    beforeAll(async () => {
      const start = await send(c, 'POST', '/api/runs/start', { orchestrationName: PARK }, { owner: 'alice' });
      expect(start.status).toBe(200);
      id = String(start.body?.id);
      seedBefore = leafOutputs(await waitForRunAs(c, id, 'alice', ['paused'])).seed;
      // Pin the seed here, as the restart case does: `undefined === undefined`
      // would let "row intact" pass with no checkpoint to compare.
      expect(seedBefore).toMatch(/^seed-0\./);
    });

    it('exits 0 within the stop grace period', async () => {
      docker('kill', '-s', 'TERM', NAME);
      const state = await waitFor(
        async () => {
          const s = inspectState(NAME);
          return s.running ? null : s;
        },
        `${NAME} stopped after SIGTERM`,
        { timeoutMs: 10_000, intervalMs: 200 },
      ).catch(e => {
        throw new Error(`${String(e)}\n--- ${NAME} logs ---\n${logs(NAME)}`);
      });
      expect(state.exitCode).toBe(0);
      expect(logs(NAME)).toContain('SIGTERM — shutting down');
    });

    it('the parked run row is intact on the next start', async () => {
      docker('start', NAME);
      c.baseUrl = publishedUrl(c.id);
      await waitReady(c);
      const run = await getRunAs(c, id, 'alice');
      expect(run.status).toBe('paused');
      expect(leafOutputs(run).seed).toBe(seedBefore);
      // And it is still a live wait, not a tombstone: the signal lands.
      const sig = await send(c, 'POST', `/api/runs/${id}/signal`, { signal: 'go' }, { owner: 'alice' });
      expect(sig.status).toBe(200);
      expect((await waitForRunAs(c, id, 'alice', ['done', 'error'])).status).toBe('done');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

suite('image smoke — named-volume and boot-failure semantics', () => {
  // These answer "what does the image do" questions a docs writer and an
  // operator otherwise guess at. Each case owns its container + volume so it
  // cannot disturb topology A's state.

  describe('a PRE-EXISTING /data volume is left alone — not re-seeded', () => {
    // Docker copies the image's baked /data into a named volume ONLY when the
    // volume is empty at first mount. An operator who provisions the volume
    // by hand (or carries one over from an earlier image) gets exactly what
    // they put there: their files survive, and the image's bundled examples
    // are NOT copied in. Consequence for upgrades: a new image's examples
    // never reach an existing volume — that is a deliberate operator step
    // (docs/DOCKER.md), not something a restart does.
    const VOLUME = `sammy-smoke-pre-${RUN_TAG}`;
    const NAME = `sammy-smoke-pre-${RUN_TAG}`;
    let c: Container;

    beforeAll(async () => {
      rm(NAME);
      rmVolume(VOLUME);
      // The volume root takes the ownership of whoever creates it. The image's
      // first-use seed copies node:node along with the files; a hand-made
      // volume does not, so chown to the image's `node` uid or the server
      // cannot create runs.db in it.
      onVolume(
        VOLUME,
        'mkdir -p /data/examples && echo pre-existing > /data/examples/.sentinel && chown -R 1000:1000 /data',
      );
      c = startServer(NAME, { SAMMY_API_TOKEN: TOKEN }, { volume: VOLUME });
      await waitReady(c);
    });

    afterAll(() => {
      rm(NAME);
      rmVolume(VOLUME);
    });

    it('the sentinel survives the server start', () => {
      expect(onVolume(VOLUME, 'cat /data/examples/.sentinel')).toBe('pre-existing');
    });

    it('the image’s examples were NOT seeded into it', async () => {
      // The only thing under /data/examples is the sentinel — none of the
      // shipped orchestrations (topology A asserts > 10 of them on a fresh
      // volume) made it across.
      expect(onVolume(VOLUME, 'ls -A /data/examples')).toBe('.sentinel');
      const r = await get(c, '/api/orchestrations', { owner: 'alice' });
      expect(r.status).toBe(200);
      const list = (await r.json()) as Array<{ name: string }> | Record<string, unknown>;
      const names = Array.isArray(list) ? list.map(o => o.name) : Object.keys(list);
      expect(names).toEqual([]);
    });
  });

  describe('DATABASE_URL at a closed port', () => {
    // NOT a 503 + unhealthy: an unreachable store at BOOT is a fatal error —
    // openRunStore's Postgres init throws, mountSammyApi rejects, serve.ts
    // logs `[serve] fatal:` and exits 1. Under compose's `restart:
    // unless-stopped` that is a crash loop, which is the loud outcome an
    // operator wants for a misconfigured DATABASE_URL (the alternative, a
    // server that answers readyz 503 forever, is the quiet one). The
    // readyz-503 path is for a store that dies AFTER boot. The HEALTHCHECK
    // never probes: the container is gone before start_period, and Docker
    // records a stopped monitored container as `unhealthy`.
    const VOLUME = `sammy-smoke-nodb-${RUN_TAG}`;
    const NAME = `sammy-smoke-nodb-${RUN_TAG}`;

    beforeAll(() => {
      rm(NAME);
      rmVolume(VOLUME);
      // Not startServer(): that reads the published port back, and this
      // container may already be gone by then.
      docker(
        'run', '-d', '--init', '--name', NAME,
        '-v', `${VOLUME}:/data`,
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', 'DATABASE_URL=postgres://sammy:sammy@host.docker.internal:1/sammy',
        '-e', `SAMMY_API_TOKEN=${TOKEN}`,
        IMAGE as string,
      );
    });

    afterAll(() => {
      rm(NAME);
      rmVolume(VOLUME);
    });

    it('exits non-zero with a fatal log naming the store, and never becomes healthy', async () => {
      const state = await waitFor(
        async () => {
          const s = inspectState(NAME);
          return s.running ? null : s;
        },
        `${NAME} exited`,
        { timeoutMs: 60_000, intervalMs: 500 },
      ).catch(e => {
        throw new Error(`${String(e)}\n--- ${NAME} logs ---\n${logs(NAME)}`);
      });
      expect(state.exitCode).not.toBe(0);
      expect(state.health).not.toBe('healthy');
      expect(logs(NAME)).toContain('[serve] fatal:');
    });
  });

  // SAMMY_AUTO_RESUME after a SIGKILL mid-leaf is deliberately NOT covered
  // here. The only way to hold a run row at `running` across a SIGKILL is a
  // leaf that is still executing when the kill lands, and the dead process's
  // lease then stays valid for DEFAULT_LEASE_TTL_MS (a 120s constant, not an
  // env knob) before the boot sweep may reclaim and resume it — a two-minute
  // wait inside a smoke test, on top of a `code.run sleep` that needs
  // SAMMY_ALLOW_CODE_RUN=1. The seam is covered in-process by
  // lifecycle-crash-recovery.test.ts against the same store code.
});

// ═════════════════════════════════════════════════════════════════════════════

pgSuite('image smoke — topology B: server + dedicated worker on Postgres', () => {
  const VOLUME = `sammy-smoke-pg-${RUN_TAG}`;
  const SERVER = `sammy-smoke-pg-server-${RUN_TAG}`;
  const WORKER = `sammy-smoke-pg-worker-${RUN_TAG}`;
  let c: Container;

  const env = {
    DATABASE_URL: PG_URL as string,
    SAMMY_API_TOKEN: TOKEN,
    SAMMY_REQUIRE_AUTH_READS: '1',
  };

  beforeAll(async () => {
    rm(SERVER, WORKER);
    rmVolume(VOLUME);
    // The server only ACCEPTS; a worker container owns the queue.
    c = startServer(SERVER, { ...env, SAMMY_DISABLE_INPROCESS_WORKER: '1' }, { volume: VOLUME });
    await waitReady(c);
    startWorker(WORKER, env, VOLUME);
    // The worker has no http surface; give it a moment to connect.
    await sleep(3_000);
  });

  afterAll(() => {
    rm(SERVER, WORKER);
    rmVolume(VOLUME);
  });

  it('readyz reports the Postgres store as the backend, and ready', async () => {
    // Pinned on the JSON, not a substring: every readyz body says "ready"
    // (or "not-ready"), so a text match proved nothing about WHICH store
    // the container opened.
    const r = await fetch(`${c.baseUrl}/api/readyz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; backend: string; store: string };
    expect(body.backend).toBe('postgres');
    expect(body.store).toBe('ok');
    expect(body.status).toBe('ready');
  });

  it('a trigger accepted by the server is executed by the worker container', async () => {
    const put = await send(c, 'PUT', `/api/orchestrations/${ECHO}`, echoOrch, { owner: 'alice' });
    expect(put.status).toBeLessThan(300);
    const fire = await send(c, 'POST', `/api/triggers/${HOOK}`, { via: 'worker', tag: RUN_TAG }, { token: null });
    expect(fire.status).toBe(202);

    const run = await waitFor(
      async () => {
        const res = await get(c, '/api/runs', { owner: 'system' });
        const rows = (await res.json()) as Array<{ id: string; orchestrationName: string; status: string; initialInput?: string }>;
        return rows.find(x => x.orchestrationName === ECHO && String(x.initialInput ?? '').includes(RUN_TAG) && x.status === 'done') ?? null;
      },
      'worker-executed run done',
      { timeoutMs: 90_000, intervalMs: 500 },
    ).catch(e => {
      throw new Error(`${String(e)}\n--- worker logs ---\n${logs(WORKER)}\n--- server logs ---\n${logs(SERVER)}`);
    });
    expect(run.status).toBe('done');
    // The worker, not the server, ran it. No run-row fact can say so: the
    // run's `lease_owner` is the executing store's per-process random UUID,
    // which no API surface returns, and `run-start` carries no host — so
    // this is proven by elimination. The server boot line says its drain
    // was disabled (and the "started" line is absent), so the worker's
    // loop is the only consumer alive; the worker says it is draining.
    const server = logs(SERVER);
    expect(server).toContain('in-process delivery worker DISABLED');
    expect(server).not.toContain('delivery worker started');
    expect(logs(WORKER)).toContain('draining the durable trigger queue');
  });

  it('owner scoping holds on the Postgres store too', async () => {
    const start = await send(c, 'POST', '/api/runs/start', { orchestrationName: ECHO, initialInput: 'pg' }, { owner: 'alice' });
    expect(start.status).toBe(200);
    const id = String(start.body?.id);
    expect((await get(c, `/api/runs/${id}`, { owner: 'bob' })).status).toBe(404);
    expect((await get(c, `/api/runs/${id}`, { owner: 'alice' })).status).toBe(200);
  });
});
