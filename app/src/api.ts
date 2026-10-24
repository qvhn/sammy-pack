import {
  deleteRemoteOrchestration,
  listRemoteAgents,
  listRemoteOrchestrations,
  writeRemoteOrchestration,
} from './connectors/github';
import { getConnectionToken } from './store/connections';
import { getActiveWorkspace } from './store/workspace';
import type { PreviewFinding, PreviewNode } from './llm/preview';
import type { Node, Workspace } from './types';

/**
 * Web dev-mode API client. By default talks to the Vite middleware in
 * sammy-pack-api.ts which reads/writes local repo files.
 *
 * If the user has activated a remote workspace (Workspaces page), reads
 * are routed through the appropriate connector. Writes for remote workspaces
 * are not yet implemented and throw.
 */

/** The server's own words for a failed response. Every API error is sent as
 *  `{ error: string }` (`sendError` in sammy-pack-api.ts), and several of
 *  them exist to tell the operator what to do next ("Re-enter the secret
 *  …", "daily budget of $5.00 exceeded"). Returns that string; a non-JSON
 *  body comes back trimmed as-is; an unreadable body is ''. Never throws, so
 *  a caller can read it from inside its own error path. */
export async function readErrorBody(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON — the raw body is the message */
  }
  return body.trim();
}

/** The Error a store client throws for a failed request: `<label> failed:
 *  <status> — <server text>`. The store clients used to throw the bare
 *  status, so a 400 whose whole point was its message ("Re-enter the
 *  secret …") reached the toast as `failed: 400`. */
export async function requestFailure(label: string, res: Response): Promise<Error> {
  const detail = await readErrorBody(res);
  return new Error(`${label} failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

function requireConnectionToken(ws: Workspace): string {
  const type = ws.connection as 'github' | 'bitbucket' | 'gitlab';
  const token = getConnectionToken(type);
  if (!token) {
    throw new Error(
      `Active workspace "${ws.name}" needs a ${type} token — set one on the Connections page.`,
    );
  }
  return token;
}

export async function listOrchestrations(): Promise<Node[]> {
  const ws = getActiveWorkspace();
  if (ws) {
    if (ws.connection === 'github') {
      return listRemoteOrchestrations(ws, requireConnectionToken(ws));
    }
    throw new Error(`Connection "${ws.connection}" not yet implemented.`);
  }
  const res = await fetch('/api/orchestrations');
  return json<Node[]>(res);
}

/** Fetch a single orchestration by name (GET /api/orchestrations/:name).
 *  Used to lazily resolve a `subflow` reference so the Pipeline view can
 *  expand a sub-orchestration's phases inline. Remote workspaces have no
 *  per-file read endpoint in the connector yet, so they fall back to
 *  filtering the listing — same routing shape as listOrchestrations(). */
export async function getOrchestration(name: string): Promise<Node> {
  const ws = getActiveWorkspace();
  if (ws) {
    if (ws.connection === 'github') {
      const all = await listRemoteOrchestrations(ws, requireConnectionToken(ws));
      const hit = all.find(o => o.name === name);
      if (!hit) throw new Error(`Orchestration "${name}" not found`);
      return hit;
    }
    throw new Error(`Connection "${ws.connection}" not yet implemented.`);
  }
  const res = await fetch(`/api/orchestrations/${encodeURIComponent(name)}`);
  return json<Node>(res);
}

export async function saveOrchestration(node: Node): Promise<Node> {
  const ws = getActiveWorkspace();
  if (ws) {
    if (ws.connection === 'github') {
      await writeRemoteOrchestration(ws, requireConnectionToken(ws), node);
      return node;
    }
    throw new Error(`Connection "${ws.connection}" not yet implemented.`);
  }
  const res = await fetch(`/api/orchestrations/${encodeURIComponent(node.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(node),
  });
  return json<Node>(res);
}

export async function deleteOrchestration(name: string): Promise<void> {
  const ws = getActiveWorkspace();
  if (ws) {
    if (ws.connection === 'github') {
      await deleteRemoteOrchestration(ws, requireConnectionToken(ws), name);
      return;
    }
    throw new Error(`Connection "${ws.connection}" not yet implemented.`);
  }
  const res = await fetch(`/api/orchestrations/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

/**
 * Atomic rename. Saves the orchestration under its new name first, then
 * deletes the old file. If the save fails, the old file stays untouched.
 * If the delete fails, the old file is left orphaned (UI will show two
 * entries until the user manually cleans up) — that's still safer than
 * losing data.
 */
export async function renameOrchestration(
  oldName: string,
  next: Node,
): Promise<Node> {
  if (next.name === oldName) return saveOrchestration(next);
  const saved = await saveOrchestration(next);
  try {
    await deleteOrchestration(oldName);
  } catch (err) {
    console.warn(
      `[api] renamed to "${next.name}" but couldn't delete old "${oldName}":`,
      err,
    );
  }
  return saved;
}

// ── Preview (symbolic dry-run) ─────────────────────────────────────

/** POST /api/preview response: the plan's findings flattened into one list
 *  (`phase` names the owning node; root findings carry none), the PreviewNode
 *  phase tree, and the terminal text renderer's output. */
export type PreviewResult = {
  findings: Array<PreviewFinding & { phase?: string }>;
  tree: PreviewNode[];
  rendered: string;
};

/** Resolve an orchestration to the concrete plan that WOULD run — no side
 *  effects, no agents dispatched, no run created. Local workspace only (the
 *  dev server owns the walker; remote workspaces have no preview endpoint). */
export async function previewOrchestration(
  name: string,
  opts?: {
    vars?: Record<string, string>;
    input?: string;
    depth?: number;
    lint?: boolean;
  },
): Promise<PreviewResult> {
  const res = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestrationName: name, ...(opts ?? {}) }),
  });
  return json<PreviewResult>(res);
}

/** Where a repository URL lives on this machine (GET /api/repos/locate):
 *  `local` is a clone whose origin matches, else null with `cloneTo` — where
 *  POST /api/repos/clone would put one. Local workspace only. */
export type RepoLocation = { url: string; local: string | null; cloneTo: string | null };

export async function locateRepo(url: string): Promise<RepoLocation> {
  const res = await fetch(`/api/repos/locate?url=${encodeURIComponent(url)}`);
  return json<RepoLocation>(res);
}

/** Clone `url` into the first repo search root; returns the clone's path
 *  (the existing one when it is already cloned). */
export async function cloneRepoUrl(url: string): Promise<{ local: string }> {
  const res = await fetch('/api/repos/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return json<{ local: string }>(res);
}

export type AgentFile = { name: string; raw: string };

/** One scan result from POST /api/agents/scan. */
export type ScannedAgent = {
  suggestedName: string;
  sourcePath: string;
  preview: string;
};

/** Scan a filesystem directory for agent .md files. Dev-server only —
 *  not implemented for remote workspaces (they have no filesystem). */
export async function scanAgentSources(
  dirPath: string,
  recursive = true,
): Promise<ScannedAgent[]> {
  const res = await fetch('/api/agents/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dirPath, recursive }),
  });
  return json<ScannedAgent[]>(res);
}

export type ImportResult = {
  imported: string[];
  /** Subset of `imported` that landed as real copies instead of
   *  symlinks (Windows without symlink support). These won't track
   *  source edits — re-import to refresh. */
  copied?: string[];
  skipped: Array<{ from: string; as: string; reason: string }>;
};

/** Link agent files into the local agents/ dir so they appear in
 *  listAgents() like first-class local agents. Prefers symlinks (read
 *  live — source edits propagate); on Windows without symlink support
 *  falls back to a copy (see ImportResult.copied). */
export async function importAgents(
  sources: Array<{ from: string; as: string }>,
): Promise<ImportResult> {
  const res = await fetch('/api/agents/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources }),
  });
  return json<ImportResult>(res);
}

/** Copy agent file contents into the local agents/ dir. Used when the
 *  source is a browser-picked folder (can't get absolute path → can't
 *  symlink). Writes real .md files; changes to the source will NOT
 *  propagate — re-pick + re-import to update. */
export async function importAgentContents(
  sources: Array<{ as: string; content: string }>,
): Promise<{ imported: string[]; copied?: string[]; skipped: Array<{ as: string; reason: string }> }> {
  const res = await fetch('/api/agents/import-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources }),
  });
  return json<{ imported: string[]; copied?: string[]; skipped: Array<{ as: string; reason: string }> }>(res);
}

export async function saveAgent(name: string, raw: string): Promise<AgentFile> {
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  return json<AgentFile>(res);
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

export async function listAgents(): Promise<AgentFile[]> {
  const ws = getActiveWorkspace();
  if (ws) {
    if (ws.connection === 'github') {
      return listRemoteAgents(ws, requireConnectionToken(ws));
    }
    throw new Error(`Connection "${ws.connection}" not yet implemented.`);
  }
  const res = await fetch('/api/agents');
  return json<AgentFile[]>(res);
}

/** Fetch a docs/ authoring guide's raw markdown (default the orchestration-
 *  authoring guide). Returns null on any failure so callers can degrade
 *  gracefully — the guide ENRICHES a prompt; its absence must never break the
 *  feature. Only served by the local server (not the GitHub workspace path). */
export async function getAuthoringGuide(
  name = 'authoring',
): Promise<string | null> {
  try {
    const res = await fetch(`/api/guide/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { raw?: unknown };
    return typeof body.raw === 'string' ? body.raw : null;
  } catch {
    return null;
  }
}

export type { Workspace };

export async function listWorkspaces(): Promise<Workspace[]> {
  // Workspaces are always read locally — they describe where else to go,
  // and we don't want a chicken-and-egg with the active workspace.
  const res = await fetch('/api/workspaces');
  return json<Workspace[]>(res);
}

export async function saveWorkspace(ws: Workspace): Promise<Workspace> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ws.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ws),
  });
  return json<Workspace>(res);
}

export async function deleteWorkspace(name: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

export async function listRuns<T = unknown>(limit?: number): Promise<T[]> {
  // Same logic — runs are local-only for now. `limit` caps the rows the
  // server returns (latest-first) — pass it from monitors/pollers that want
  // the recent few, not the whole history.
  const qs =
    typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? `?limit=${limit}`
      : '';
  const res = await fetch(`/api/runs${qs}`);
  return json<T[]>(res);
}

export async function getRun<T = unknown>(id: string): Promise<T> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
  return json<T>(res);
}

/** A LIGHTWEIGHT run status snapshot (GET /api/runs/:id/summary) — header
 *  fields + event-derived counts, WITHOUT the events array. Use this for
 *  monitoring/polling instead of getRun (whose payload is the full event
 *  stream — >1MB on a big run). */
export type RunSummary = {
  id: string;
  orchestrationName: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  phasesStarted: number;
  phasesEnded: number;
  toolUses: number;
  lastEventType: string | null;
  lastEventTs: number | null;
};

export async function getRunSummary(id: string): Promise<RunSummary> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}/summary`);
  return json<RunSummary>(res);
}

export async function saveRun<T extends { id: string }>(run: T): Promise<T> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  return json<T>(res);
}

export async function deleteRun(id: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

/** Loose typing on purpose — the SDK accepts several shapes
 *  (stdio / sse / http / sdk-instance). The UI mostly cares about the
 *  keys; the dev-server forwards the value blob unchanged to the SDK. */
export type McpServerConfig = Record<string, unknown> & {
  type?: 'stdio' | 'sse' | 'http' | 'sdk' | 'claudeai-proxy';
};

export async function listMcpServers(): Promise<Record<string, McpServerConfig>> {
  const res = await fetch('/api/mcp-servers');
  return json<Record<string, McpServerConfig>>(res);
}

export type McpServerStatus = {
  name: string;
  kind: string;
  status: 'ok' | 'unreachable' | 'unknown';
  message?: string;
};

export async function checkMcpServerStatus(): Promise<McpServerStatus[]> {
  const res = await fetch('/api/mcp-servers/status');
  return json<McpServerStatus[]>(res);
}

export async function saveMcpServers(
  registry: Record<string, McpServerConfig>,
): Promise<Record<string, McpServerConfig>> {
  const res = await fetch('/api/mcp-servers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registry),
  });
  return json<Record<string, McpServerConfig>>(res);
}

/** Hook spec stored in the workspace hooks/hooks.json. Mirrors the
 *  SDK's settings.json shape for shell-command hooks. */
export type HookSpec = {
  event: string;
  matcher?: string;
  command: string;
  args?: string[];
  timeoutSeconds?: number;
};

/** Dataset: a named collection of input rows with optional expected
 *  outputs. Used by the evals pipeline to score orchestration runs
 *  against canonical fixtures. Lives at datasets/<name>.json. */
export type DatasetRow = {
  id: string;
  input: string;
  expectedOutput?: string;
  tags?: string[];
  /** Free-form metadata: where the row came from, who added it, etc. */
  metadata?: Record<string, unknown>;
};

export type Dataset = {
  name: string;
  description?: string;
  rows: DatasetRow[];
  createdAt: number;
  updatedAt: number;
};

export async function listDatasets(): Promise<Dataset[]> {
  const res = await fetch('/api/datasets');
  return json<Dataset[]>(res);
}
export async function getDataset(name: string): Promise<Dataset> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(name)}`);
  return json<Dataset>(res);
}
export async function saveDataset(ds: Dataset): Promise<Dataset> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(ds.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ds),
  });
  return json<Dataset>(res);
}
export async function deleteDataset(name: string): Promise<void> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

/** Scorer: one criterion the eval runs each row's output through.
 *  - exact:    output trimmed === expectedOutput trimmed
 *  - contains: output includes the substring
 *  - regex:    output matches the regex
 *  - llm-judge: a judge agent (markdown file) scores the output
 *  Numeric score: 0 or 1 for the boolean scorers; 0..1 for llm-judge. */
export type Scorer =
  | { type: 'exact' }
  | { type: 'contains'; substring?: string }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'llm-judge'; judgeAgent: string; criteria: string };

export type Eval = {
  name: string;
  description?: string;
  orchestrationName: string;
  datasetName: string;
  scorers: Scorer[];
  /** Optional cap on dataset rows per run; full set when unset. */
  sampleSize?: number;
  createdAt: number;
  updatedAt: number;
};

export async function listEvals(): Promise<Eval[]> {
  const res = await fetch('/api/evals');
  return json<Eval[]>(res);
}
export async function getEval(name: string): Promise<Eval> {
  const res = await fetch(`/api/evals/${encodeURIComponent(name)}`);
  return json<Eval>(res);
}
export async function saveEval(e: Eval): Promise<Eval> {
  const res = await fetch(`/api/evals/${encodeURIComponent(e.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(e),
  });
  return json<Eval>(res);
}
export async function deleteEval(name: string): Promise<void> {
  const res = await fetch(`/api/evals/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
}

/** Aggregated observability digest computed server-side from runs/*.json.
 *  See sammy-pack-api.ts for shape details — kept loose here because
 *  the page shape is the consumer and types would otherwise drift. */
export type ObservabilityDigest = {
  totals: {
    runs: number;
    done: number;
    error: number;
    cancelled: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  perOrchestration: Array<{
    name: string;
    runCount: number;
    doneCount: number;
    errorCount: number;
    cancelledCount: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastRanAt: number;
  }>;
  perPhase: Array<{
    orchestration: string;
    phaseName: string;
    runs: number;
    errors: number;
    avgDurationMs: number;
    p95DurationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  daily: Array<{
    day: string;
    runCount: number;
    doneCount: number;
    errorCount: number;
    costUsd: number;
  }>;
  recent: Array<{
    id: string;
    orchestrationName: string;
    status: string;
    startedAt: number;
    durationMs?: number;
  }>;
  /** Per switch/route node: which branches were actually taken, and how
   *  often, across all runs. The UI cross-references this with the declared
   *  branches to flag never-taken (dead) ones. */
  branchCoverage: Array<{
    orchestration: string;
    phaseName: string;
    taken: Array<{ branch: string; count: number }>;
  }>;
};

export async function getObservability(): Promise<ObservabilityDigest> {
  const res = await fetch('/api/observability');
  return json<ObservabilityDigest>(res);
}

/** Token & cost dashboard digest — computed server-side in
 *  sammy-pack-api.ts (GET /api/cost) so the browser doesn't load every
 *  run's full event log. See that handler for shape details. */
export type CostDigest = {
  /** Today / this-calendar-month USD spend, bucketed by the run store. */
  spend: { todayUsd: number; monthUsd: number };
  totals: { runs: number; inputTokens: number; outputTokens: number; costUsd: number };
  perRun: Array<{
    id: string;
    orchestrationName: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** How many agents/phases in this run hit the token-ceiling breaker. */
    ceilingTrips: number;
  }>;
  /** Per-run → per-phase breakdown, keyed by run id. */
  perPhase: Record<
    string,
    Array<{
      phaseName: string;
      agentPath?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      durationMs?: number;
      /** True if the SDK circuit-breaker aborted this agent. */
      aborted: boolean;
    }>
  >;
  /** Flat list of every circuit-breaker trip across all runs. */
  ceilingTrips: Array<{
    runId: string;
    orchestrationName: string;
    phaseName: string;
    approxTokens?: number;
  }>;
};

export async function getCostDigest(): Promise<CostDigest> {
  const res = await fetch('/api/cost');
  return json<CostDigest>(res);
}

export type SchemaDoc = { name: string; content: unknown };

export async function listSchemas(): Promise<SchemaDoc[]> {
  const res = await fetch('/api/schemas');
  return json<SchemaDoc[]>(res);
}

/** Git commit touching a versioned file (agent or orchestration). */
export type VersionCommit = {
  sha: string;
  date: string;
  author: string;
  message: string;
};

export async function listVersions(
  scope: 'agents' | 'examples',
  name: string,
): Promise<VersionCommit[]> {
  const res = await fetch(`/api/versions/${scope}/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return json<VersionCommit[]>(res);
}

export async function getVersionContent(
  scope: 'agents' | 'examples',
  name: string,
  sha: string,
): Promise<{ sha: string; content: string }> {
  const res = await fetch(
    `/api/versions/${scope}/${encodeURIComponent(name)}/${encodeURIComponent(sha)}`,
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return json<{ sha: string; content: string }>(res);
}

export async function listHooks(): Promise<Record<string, HookSpec>> {
  const res = await fetch('/api/hooks');
  return json<Record<string, HookSpec>>(res);
}

export async function saveHooks(
  registry: Record<string, HookSpec>,
): Promise<Record<string, HookSpec>> {
  const res = await fetch('/api/hooks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(registry),
  });
  return json<Record<string, HookSpec>>(res);
}

// ─── Global agent-concurrency cap ────────────────────────────────────────
// The process-wide limit on how many agent-SDK subprocesses run at once
// (the gate that stops a wide fan-out / cron burst from overloading the
// machine). Backed server-side by SAMMY_MAX_CONCURRENT_AGENTS; adjustable
// live via the Settings page.
export type AgentSlots = { limit: number; inUse: number; waiting: number };

export async function getAgentSlots(): Promise<AgentSlots> {
  const res = await fetch('/api/agent-slots');
  return json<AgentSlots>(res);
}

export async function setAgentSlots(limit: number): Promise<AgentSlots> {
  const res = await fetch('/api/agent-slots', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  return json<AgentSlots>(res);
}

// ─── Agent execution queue (the concurrency-cap waitlist) ────────────────
// Leaf agent dispatches blocked because the global concurrency cap is
// saturated. The Queue view lists these; reorderAgentQueue reprioritizes one.
export type QueuedAgent = {
  /** Stable per-waiter id — what reorderAgentQueue targets. */
  id: string;
  kind: 'agent';
  /** Owning run id (null for anonymous in-browser / CLI dispatches). */
  runId: string | null;
  orchestrationName: string | null;
  phaseName: string | null;
  /** 0-based grant position (0 = next to get a slot). */
  position: number;
  enqueuedAt: number;
  waitedMs: number;
  /** Which cap is gating this item. Today there's one: the global pool. */
  blockedBy: 'agent-concurrency-cap';
};

export type AgentQueue = AgentSlots & { queued: QueuedAgent[] };

export async function getAgentQueue(): Promise<AgentQueue> {
  const res = await fetch('/api/agent-queue');
  return json<AgentQueue>(res);
}

/** Move a queued dispatch one place sooner/later, or to an absolute
 *  0-based position. Returns the post-move queue snapshot. */
export async function reorderAgentQueue(
  arg: { id: string; dir: 'up' | 'down' } | { id: string; toIndex: number },
): Promise<AgentQueue> {
  const res = await fetch('/api/agent-queue/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(arg),
  });
  return json<AgentQueue>(res);
}
