/**
 * Health / capability endpoint backing logic.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this, there was no `/api/health` and capability was inferred from a
 * single misleading `harnessGated` flag: a server launched with `CLAUDECODE=1`
 * was *assumed* unable to run agents, yet in practice it ran 400+ tool-uses
 * fine. That false signal delayed a real diagnosis for hours. This module
 * exposes the REAL, queryable capability signals instead of a guess:
 *
 *   - codeRun     : is the `code.run` shell escape hatch enabled? (env flag)
 *   - store       : is the run store actually reachable? (cheap live probe)
 *   - agentTools  : can this process actually drive an agent tool-call?
 *                   EMPIRICAL — but expensive, so OPT-IN + cached (see below).
 *
 * The builder is pure / injectable so its SHAPE can be unit-tested without a
 * live server, a real store, or spawning an agent.
 */

import { codeRunAllowlist, codeRunMode } from '../llm/code-run-policy';

export { codeRunAllowlist, codeRunMode };
import type { RunStore } from './run-store';

/** Health-check capability snapshot. */
export type AgentToolsStatus = 'ok' | 'failed' | 'unknown';
export type StoreStatus = 'ok' | 'unreachable';
export type HealthStatus = 'ok' | 'degraded';

export interface HealthCapabilities {
  /** Whether the `code.run` external-shell escape hatch is enabled. */
  codeRun: boolean;
  /** Whether the run store answered a cheap liveness probe. */
  store: StoreStatus;
  /**
   * Whether this process can actually drive an agent tool-call. EMPIRICAL
   * when probed (see {@link probeAgentTools}); `'unknown'` until then. Never
   * spawns an agent implicitly — the default health check returns the cached
   * value or `'unknown'`.
   */
  agentTools: AgentToolsStatus;
}

export interface Health {
  /** `'ok'` when the store is reachable, else `'degraded'`. */
  status: HealthStatus;
  /** The run-store backend in use, for at-a-glance ops context. */
  backend: RunStore['backend'];
  capabilities: HealthCapabilities;
  /** Epoch millis the snapshot was built. */
  ts: number;
}

/**
 * Whether `code.run` is usable at all — unrestricted (SAMMY_ALLOW_CODE_RUN)
 * or allowlisted (SAMMY_CODE_RUN_ALLOW). Delegates to the SAME policy module
 * the executor's runtime gate reads, so the two cannot drift.
 */
export function codeRunEnabled(): boolean {
  return codeRunMode() !== 'off';
}

/**
 * Cheap store liveness probe. `listRuns(1)` is the lightest read the store
 * offers (one header row, no events). Resolves `'ok'` if it returns,
 * `'unreachable'` if it throws (e.g. a dead Postgres connection). Never
 * throws itself — a health check must not 500.
 */
export async function probeStore(
  store: Pick<RunStore, 'listRuns'>,
): Promise<StoreStatus> {
  try {
    await store.listRuns(1);
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

/**
 * Pure, injectable health-snapshot builder. Takes already-resolved signals so
 * the response SHAPE can be asserted in a unit test without a live server, a
 * real store, or an agent. Callers resolve `store` via {@link probeStore},
 * `codeRun` via {@link codeRunEnabled}, and `probedAgentTools` via the agent
 * probe cache (default `'unknown'`).
 */
export function buildHealth(opts: {
  backend: RunStore['backend'];
  store: StoreStatus;
  codeRun: boolean;
  /** Cached agent-tools result; `'unknown'` when never probed. */
  probedAgentTools?: AgentToolsStatus;
}): Health {
  const agentTools = opts.probedAgentTools ?? 'unknown';
  return {
    status: opts.store === 'ok' ? 'ok' : 'degraded',
    backend: opts.backend,
    capabilities: {
      codeRun: opts.codeRun,
      store: opts.store,
      agentTools,
    },
    ts: Date.now(),
  };
}

// ───────────────────────── agent-tools probe (opt-in, cached) ─────────────
//
// SAFETY CONTRACT
// ---------------
// Running a real agent costs tokens and can hang. So:
//   1. The DEFAULT `/api/health` NEVER spawns an agent. It reads the cache
//      (or `'unknown'`).
//   2. The probe is OPT-IN: `GET /api/health?probe=1` or boot flag
//      SAMMY_HEALTH_PROBE=1.
//   3. The result is CACHED for the process lifetime — repeat probes are free
//      (no re-spawn).
//   4. The probe MUST run under a SHORT hard timeout (~30s) so a hung agent
//      can't wedge the health endpoint.

/** Hard timeout for one agent-tools probe. Short by design — a health check
 *  must fail fast, not hang on a stuck agent. */
export const AGENT_PROBE_TIMEOUT_MS = 30_000;

/** Process-lifetime cache of the empirical agent-tools result. `undefined`
 *  means "never probed" → the endpoint reports `'unknown'`. */
let cachedAgentTools: AgentToolsStatus | undefined;

/** Read the cached agent-tools result without ever probing. The default
 *  (no-probe) health path uses this — it returns `'unknown'` until a probe
 *  has run at least once. */
export function getCachedAgentTools(): AgentToolsStatus {
  return cachedAgentTools ?? 'unknown';
}

/** Test/seam hook: seed or reset the cache. */
export function setCachedAgentTools(v: AgentToolsStatus | undefined): void {
  cachedAgentTools = v;
}

/**
 * Run ONE trivial agent tool-call and return whether it succeeded, caching
 * the result for the process lifetime. Idempotent + cheap after the first
 * call (returns the cache). Opt-in only — call sites gate on `?probe=1` /
 * SAMMY_HEALTH_PROBE=1.
 *
 * ── CURRENT STATE: DOCUMENTED SEAM ────────────────────────────────────────
 * This returns `'unknown'` (the safe default) rather than spawning an agent.
 * A real probe was deliberately left unwired in this pass because doing it
 * *cleanly* reaches into executor/sdk-stream internals owned by other agents
 * (credential scope, injected secrets, the per-agent token ceiling) — a
 * correct endpoint + documented seam beats a fragile/expensive call. The
 * endpoint, the cheap signals (codeRun/store), the opt-in gating, and this
 * cache are all real and tested; only the agent dispatch below is a stub.
 *
 * ── HOW TO FINISH (one focused change, mirrors `createRunRunner`) ─────────
 *   1. Import `runOrchestration` (+ `RunEvent`) from '../llm/executor' and
 *      `streamSdk` from './sdk-stream' (the same server-side agent path the
 *      run-runner uses at run-runner.ts ~329; it calls streamSdk with
 *      apiKey: '' and a server-built stream fn).
 *   2. Build a trivial one-agent orchestration whose single agent node has
 *      the Bash tool and a prompt like "Run the shell command `echo ok` and
 *      reply with its output." Pass `agentsOverride` with that inline agent
 *      so the executor does not self-fetch over HTTP.
 *   3. Drive it: `for await (const ev of runOrchestration({ orchestration,
 *      apiKey: '', model, streamFn: streamSdk, allowAgentTools: true,
 *      waitForApproval: async () => true, cancelled }))`. Race the loop
 *      against a `setTimeout(AGENT_PROBE_TIMEOUT_MS)`; on timeout set
 *      `cancelled.v = true` and treat the probe as `'failed'`.
 *   4. Success = a `phase-end` (or `run-end` status:'done') with no
 *      `run-error`/`phase-error` AND the echoed `ok` present in output;
 *      anything else (timeout/auth/tool-denied) = `'failed'`.
 *   5. Assign the boolean to `cachedAgentTools` and return it.
 * Keep the timeout + cache guarantees above intact when wiring this.
 */
export async function probeAgentTools(_opts?: {
  model?: string;
  timeoutMs?: number;
}): Promise<AgentToolsStatus> {
  // Cached? Return immediately — never re-spawn.
  if (cachedAgentTools !== undefined) return cachedAgentTools;
  // SEAM: no real agent dispatch yet (see "HOW TO FINISH" above). We do NOT
  // cache 'unknown' — leaving the cache empty so a future, wired probe still
  // runs once.
  return 'unknown';
}
