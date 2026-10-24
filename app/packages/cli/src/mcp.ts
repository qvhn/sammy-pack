/**
 * sammy-pack MCP server (stdio).
 *
 * EMBEDS the orchestration engine and opens the SAME run-store sqlite
 * file the web UI uses, so it is fully self-contained — no separate web
 * server process is required — AND any run started here shows up in the
 * web dashboard's Runs page (they read one `runs.db`).
 *
 * It reuses the server-side run plumbing verbatim:
 *   - makeLoadRunContext  → load orchestration JSON + agent markdown +
 *                           sibling orchestrations from the workspace
 *   - createRunRunner     → build the executor event source (provider
 *                           registry, Claude Agent SDK stream fn, MCP/
 *                           hooks, credential resolution)
 *   - startRun            → upsert the run row, launch the executor in
 *                           the background, return the id
 *
 * So this is exactly the path POST /api/runs/start drives — not a
 * reimplementation.
 *
 * Tools exposed:
 *   - list_orchestrations
 *   - start_run({ orchestration, input?, provider?, model? })
 *   - get_run({ id })
 *   - cancel_run({ id })
 *   - resume_run({ id })
 *
 * Workspace resolution (env, all optional):
 *   SAMMY_REPO_ROOT   workspace root (default: cwd). Orchestrations are
 *                     read from SAMMY_ORCH_DIR, else <root>/orchestrations,
 *                     else <root>/examples. Agents from <root>/agents.
 *   SAMMY_ORCH_DIR    explicit orchestrations directory (overrides the
 *                     orchestrations/ → examples/ search).
 *   SAMMY_RUN_DB      explicit runs.db FILE path. Its DIRECTORY becomes
 *                     the store root (better-sqlite3 backend always names
 *                     the file `runs.db`, so the basename must be runs.db
 *                     — a different basename is honored by using its dir).
 *   DATABASE_URL      if set, the store is Postgres (shared with the web
 *                     UI's Postgres) instead of sqlite.
 *
 * Provider keys come from the environment (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY / GEMINI_API_KEY / AWS_*), falling back to the
 * workspace credentials.json — identical to run-runner's resolution.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// The engine + server plumbing. The CLI runs through `tsx`, so these
// reach-up imports resolve against the in-repo source — the same modules
// serve.ts / sammy-pack-api.ts use. (Kept as source imports rather than
// the published `sammy-pack` bundle because createRunRunner /
// makeLoadRunContext are server-side glue that depend on the Claude
// Agent SDK and are intentionally not in the core SDK bundle.)
import { startRun } from '../../../src/server/run-controller';
import { openRunStore, type RunStore } from '../../../src/server/run-store';
import { makeLoadRunContext } from '../../../src/server/run-context';
import { createRunRunner } from '../../../src/server/run-runner';
import { cancel as cancelRun, resume as resumeRun } from '../../../src/server/run-controller';
import type { Node } from '../../../src/types';

const log = (...a: unknown[]): void => {
  // MUST go to stderr — stdout is the JSON-RPC channel.
  console.error('[sammy-pack mcp]', ...a);
};

/** Resolve workspace + store roots from env. */
function resolveWorkspace(): {
  repoRoot: string;
  storeRoot: string;
  orchDir: string;
  agentsDir: string;
} {
  const repoRoot = process.env.SAMMY_REPO_ROOT
    ? path.resolve(process.env.SAMMY_REPO_ROOT)
    : process.cwd();

  // Store root: where openRunStore will look for / create runs.db. When
  // SAMMY_RUN_DB names an explicit file, its directory is the store root
  // (the sqlite backend hardcodes the `runs.db` filename).
  const storeRoot = process.env.SAMMY_RUN_DB
    ? path.dirname(path.resolve(process.env.SAMMY_RUN_DB))
    : repoRoot;

  // Orchestration dir: explicit SAMMY_ORCH_DIR wins; the per-call loader
  // also tries orchestrations/ then examples/ (see resolveOrchDir).
  const orchDir = process.env.SAMMY_ORCH_DIR
    ? path.resolve(process.env.SAMMY_ORCH_DIR)
    : repoRoot;

  const agentsDir = path.join(repoRoot, 'agents');
  return { repoRoot, storeRoot, orchDir, agentsDir };
}

/** Pick the directory orchestration JSON lives in. Priority:
 *  SAMMY_ORCH_DIR (if set + exists) → <root>/orchestrations → <root>/examples. */
async function resolveOrchDir(repoRoot: string): Promise<string> {
  const explicit = process.env.SAMMY_ORCH_DIR;
  if (explicit) {
    const p = path.resolve(explicit);
    if (await dirExists(p)) return p;
  }
  const orchestrations = path.join(repoRoot, 'orchestrations');
  if (await dirExists(orchestrations)) return orchestrations;
  return path.join(repoRoot, 'examples');
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

type OrchSummary = {
  name: string;
  description: string | null;
  file: string;
};

/** Scan a directory for orchestration JSON files, returning the root
 *  node's name/description for each. The `name` used to start a run is
 *  the FILE basename (without .json) — that's what loadRunContext keys
 *  on — not the in-JSON `name` field. */
async function scanOrchestrations(dir: string): Promise<OrchSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: OrchSummary[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith('.json')) continue;
    const base = f.replace(/\.json$/, '');
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      const node = JSON.parse(raw) as Partial<Node>;
      out.push({
        name: base,
        description:
          typeof node.description === 'string' ? node.description : null,
        file: path.join(dir, f),
      });
    } catch {
      // Unreadable / non-JSON — list it by filename so it's visible.
      out.push({ name: base, description: null, file: path.join(dir, f) });
    }
  }
  return out;
}

/** Compact, token-cheap summary of a run for get_run. */
function summarizeRun(run: {
  id: string;
  orchestrationName: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  lastOutput: string | null;
  completedLeaves: string[] | null;
  events: Array<Record<string, unknown> & { type: string; ts?: number }>;
}): Record<string, unknown> {
  const events = run.events ?? [];

  // Latest phase state per phase name.
  const phaseState: Record<string, string> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  for (const ev of events) {
    if (ev.type === 'phase-start' && typeof ev.phaseName === 'string') {
      phaseState[ev.phaseName] = 'running';
    } else if (ev.type === 'phase-end' && typeof ev.phaseName === 'string') {
      phaseState[ev.phaseName] = 'done';
      if (typeof ev.costUsd === 'number') costUsd += ev.costUsd;
    } else if (ev.type === 'phase-error' && typeof ev.phaseName === 'string') {
      phaseState[ev.phaseName] = 'error';
    }
    const usage = ev.usage as
      | { inputTokens?: number; outputTokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.inputTokens === 'number') tokensIn += usage.inputTokens;
      if (typeof usage.outputTokens === 'number')
        tokensOut += usage.outputTokens;
    }
    if (typeof ev.costUsd === 'number' && ev.type !== 'phase-end') {
      costUsd += ev.costUsd;
    }
  }

  // Last ~8 events, trimmed of bulky fields.
  const latest = events.slice(-8).map(ev => {
    const slim: Record<string, unknown> = { type: ev.type };
    if (typeof ev.ts === 'number') slim.ts = ev.ts;
    if (typeof ev.phaseName === 'string') slim.phaseName = ev.phaseName;
    if (typeof ev.error === 'string') slim.error = ev.error;
    if (typeof ev.status === 'string') slim.status = ev.status;
    if (typeof ev.reason === 'string') slim.reason = ev.reason;
    return slim;
  });

  return {
    id: run.id,
    orchestration: run.orchestrationName,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.endedAt ? run.endedAt - run.startedAt : null,
    completedLeaves: run.completedLeaves ?? [],
    phaseState,
    tokens:
      tokensIn || tokensOut
        ? { input: tokensIn, output: tokensOut }
        : null,
    costUsd: costUsd || null,
    lastOutput:
      run.lastOutput && run.lastOutput.length > 2000
        ? run.lastOutput.slice(0, 2000) + '…'
        : run.lastOutput,
    latestEvents: latest,
  };
}

const ok = (obj: unknown) => ({
  content: [
    { type: 'text' as const, text: JSON.stringify(obj, null, 2) },
  ],
});
const fail = (msg: string) => ({
  content: [{ type: 'text' as const, text: msg }],
  isError: true,
});

/** Build the configured McpServer (engine embedded, store opened) WITHOUT
 *  attaching a transport. `runMcpServer` wraps this with stdio; tests can
 *  connect an in-memory transport. */
export async function buildMcpServer(): Promise<McpServer> {
  const { repoRoot, storeRoot, agentsDir } = resolveWorkspace();
  log(`repoRoot=${repoRoot}`);
  log(`storeRoot=${storeRoot} (runs.db shared with the web UI)`);

  // Open the run store ONCE — shared with the web UI (same runs.db / same
  // Postgres). openRunStore(root) → <root>/runs.db unless DATABASE_URL.
  let store: RunStore;
  try {
    store = await openRunStore(storeRoot);
    log(`run store backend: ${store.backend}`);
  } catch (err) {
    log('failed to open run store:', (err as Error).message);
    throw err;
  }

  const runner = createRunRunner({ root: repoRoot });

  const server = new McpServer({
    name: 'sammy-pack',
    version: '0.1.0-alpha.0',
  });

  // ── list_orchestrations ────────────────────────────────────────────
  server.registerTool(
    'list_orchestrations',
    {
      title: 'List orchestrations',
      description:
        'List the orchestration JSON files in the workspace (SAMMY_ORCH_DIR, ' +
        'else ./orchestrations, else ./examples). Returns the file name (used ' +
        'as the `orchestration` arg to start_run) plus the root node name/description.',
      inputSchema: {},
    },
    async () => {
      const dir = await resolveOrchDir(repoRoot);
      const list = await scanOrchestrations(dir);
      return ok({ dir, count: list.length, orchestrations: list });
    },
  );

  // ── start_run ───────────────────────────────────────────────────────
  server.registerTool(
    'start_run',
    {
      title: 'Start a run',
      description:
        'Start a server-owned run of an orchestration. The executor runs in ' +
        'the background against the shared run store, so the run is visible in ' +
        'the web dashboard. Returns the run id immediately. Provider API keys ' +
        'come from the environment / workspace credentials.',
      inputSchema: {
        orchestration: z
          .string()
          .describe('Orchestration file name (without .json), as listed by list_orchestrations.'),
        input: z
          .string()
          .optional()
          .describe('Initial input for the first phase.'),
        provider: z
          .enum(['anthropic', 'openai', 'gemini'])
          .optional()
          .describe('Provider hint — only used to pick a default model when `model` is omitted; per-node `provider` in the JSON still routes individual phases.'),
        model: z
          .string()
          .optional()
          .describe('Run-wide default model (e.g. claude-sonnet-4-6, gpt-4o-mini).'),
      },
    },
    async ({ orchestration, input, provider, model }) => {
      // Resolve the orchestration + agents from the chosen dir. The loader
      // is bound to the dir we actually scan so file lookups agree.
      const orchDir = await resolveOrchDir(repoRoot);
      const loadRunContext = makeLoadRunContext({
        examplesDir: orchDir,
        agentsDir,
      });
      const ctx = await loadRunContext(orchestration);
      if (!ctx) {
        const list = await scanOrchestrations(orchDir);
        return fail(
          `Orchestration "${orchestration}" not found in ${orchDir}. ` +
            `Available: ${list.map(o => o.name).join(', ') || '(none)'}`,
        );
      }

      const defaultModel =
        model ??
        (provider === 'openai'
          ? 'gpt-4o-mini'
          : provider === 'gemini'
            ? 'gemini-2.0-flash'
            : 'claude-sonnet-4-6');

      try {
        const { id } = await startRun({
          store,
          orchestrationName: orchestration,
          initialInput: input,
          orchestrationSnapshot: ctx.orchestration,
          buildEventSource: signal =>
            runner.buildExecutorSource(
              ctx,
              { initialInput: input, model: defaultModel },
              signal,
            ),
        });
        return ok({
          id,
          orchestration,
          model: defaultModel,
          message:
            'Run started in the background. Use get_run to poll status, or ' +
            'open the web dashboard Runs page.',
        });
      } catch (err) {
        return fail(`Failed to start run: ${(err as Error).message}`);
      }
    },
  );

  // ── get_run ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_run',
    {
      title: 'Get run status',
      description:
        'Read a run from the shared store. Returns status, per-phase state, ' +
        'token/cost rollup, and the latest events.',
      inputSchema: {
        id: z.string().describe('Run id returned by start_run.'),
      },
    },
    async ({ id }) => {
      try {
        const run = await store.getRun(id);
        if (!run) return fail(`Unknown run id: ${id}`);
        return ok(summarizeRun(run));
      } catch (err) {
        return fail(`Failed to read run: ${(err as Error).message}`);
      }
    },
  );

  // ── cancel_run ──────────────────────────────────────────────────────
  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel a run',
      description:
        'Abort an in-flight run. Only affects a run whose executor is live ' +
        'in THIS process (the one this MCP server started); a run owned by ' +
        'another process / the web server is not cancellable from here.',
      inputSchema: {
        id: z.string().describe('Run id to cancel.'),
      },
    },
    async ({ id }) => {
      const cancelled = cancelRun(id);
      return ok({
        id,
        cancelled,
        message: cancelled
          ? 'Abort signalled.'
          : 'No live run with that id in this process (already finished, or owned elsewhere).',
      });
    },
  );

  // ── resume_run ──────────────────────────────────────────────────────
  server.registerTool(
    'resume_run',
    {
      title: 'Resume a run',
      description:
        'Resume a paused or interrupted run: replays completed leaves and ' +
        're-executes from the cut point, against the shared store.',
      inputSchema: {
        id: z.string().describe('Run id to resume.'),
      },
    },
    async ({ id }) => {
      try {
        const stored = await store.getRun(id);
        if (!stored) return fail(`Unknown run id: ${id}`);
        const orchDir = await resolveOrchDir(repoRoot);
        const loadRunContext = makeLoadRunContext({
          examplesDir: orchDir,
          agentsDir,
        });
        // The seventh resume path. Pin to the run's own snapshot like the
        // six in sammy-pack-api.ts: a resume runs the definition the run
        // started under, not whatever the file says today — and a missing
        // file is not fatal when the snapshot exists (the orchestration may
        // have been renamed or deleted while the run was parked).
        const ctx = await loadRunContext(stored.orchestrationName, {
          orchestrationOverride: stored.orchestrationSnapshot as Node | null,
        });
        if (!ctx) {
          return fail(
            `Orchestration "${stored.orchestrationName}" not found and the run has no snapshot — cannot resume.`,
          );
        }
        const result = await resumeRun({
          store,
          id,
          buildEventSource: (signal, replayOutputs, autoApproveLocks) =>
            runner.buildExecutorSource(
              ctx,
              { replayOutputs, autoApproveLocks },
              signal,
            ),
        });
        if (!result.ok) return fail(result.reason);
        return ok({ id, resumed: true });
      } catch (err) {
        return fail(`Failed to resume run: ${(err as Error).message}`);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('connected over stdio — tools registered.');
}
