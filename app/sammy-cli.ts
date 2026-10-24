/**
 * sammy-cli — a thin HTTP client to the dev server's run store, so a CLI /
 * skill run can be MIRRORED into the web UI (and queried back).
 *
 * The web UI and the CLI share one durable run store (the dev server's
 * `runs.db`, served at /api/runs). This CLI writes/reads that store over HTTP,
 * which means:
 *   - CLI → UI: a skill executing an orchestration calls `run-open` →
 *     `run-phase` → `run-close`; the run shows up live in the UI Runs page and
 *     as a status dot on the Pipelines list (the UI polls the store).
 *   - UI → CLI: `run-status <id>` and `run-in-progress` read the same store, so
 *     you can check on a run (started anywhere) from the terminal.
 *
 * Requires the dev server to be running (default http://localhost:5173 — set
 * SAMMY_BASE_URL or pass --base to point elsewhere). Pure HTTP, no DB driver,
 * no build step: run with `npx tsx app/sammy-cli.ts <command>`.
 *
 * Commands:
 *   run-open   <orchestration> [--input <text>]   → prints the new run id
 *   run-phase  <id> <phaseName> <start|end> [text] → append a phase event
 *   run-close  <id> <done|error> [text]            → mark the run terminal
 *   run-status <id>                                → one run's status + last event
 *   run-in-progress                                → list currently-running runs
 *   preview    <orchestration> [flags]             → resolve the plan, no side effects
 *
 * The `preview` command is PURE + OFFLINE — it does not need the dev server. It
 * resolves an orchestration to the concrete plan that WILL run (every command,
 * value, branch) with no side effects, and flags structural incoherence inline.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  previewOrchestration,
  planHasErrors,
  type PreviewOptions,
} from './src/llm/preview';
import {
  renderPlanText,
  renderPlanJson,
  renderDiffText,
} from './src/llm/preview-render';
import type { Node } from './src/types';

type Json = Record<string, unknown>;
type RunEventLite = { type: string; ts: number } & Json;
type Run = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt?: number | null;
  status: string;
  events: RunEventLite[];
  eventVersion?: number;
};

function baseUrl(args: string[]): string {
  const i = args.indexOf('--base');
  if (i >= 0 && args[i + 1]) return args[i + 1].replace(/\/$/, '');
  const env = process.env.SAMMY_BASE_URL;
  return (env ? env : 'http://localhost:5173').replace(/\/$/, '');
}

function optValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function die(msg: string): never {
  process.stderr.write(`sammy-cli: ${msg}\n`);
  process.exit(1);
}

async function getRun(base: string, id: string): Promise<Run> {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(id)}`);
  if (res.status === 404) die(`run "${id}" not found`);
  if (!res.ok) die(`GET /api/runs/${id} → HTTP ${res.status}`);
  return (await res.json()) as Run;
}

async function putRun(base: string, run: Run): Promise<void> {
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  });
  if (!res.ok) die(`POST /api/runs → HTTP ${res.status}: ${await res.text()}`);
}

async function listRuns(base: string): Promise<Run[]> {
  const res = await fetch(`${base}/api/runs`);
  if (!res.ok) die(`GET /api/runs → HTTP ${res.status}`);
  return (await res.json()) as Run[];
}

/** A run id the UI accepts (isSafeName) and that sorts by time. */
function newRunId(): string {
  const rnd = Math.floor(performance.now() * 1000) % 100000;
  return `cli-${Date.now()}-${rnd}`;
}

async function cmdRunOpen(base: string, args: string[]): Promise<void> {
  const orch = args[0];
  if (!orch) die('usage: run-open <orchestration> [--input <text>]');
  const input = optValue(args, '--input');
  const id = newRunId();
  const now = Date.now();
  await putRun(base, {
    id,
    orchestrationName: orch,
    startedAt: now,
    status: 'running',
    events: [{ type: 'run-start', orchestrationName: orch, ts: now }],
    eventVersion: 1,
    ...(input ? { initialInput: input } : {}),
  } as Run);
  // The id on stdout (and nothing else) so callers can capture it.
  process.stdout.write(`${id}\n`);
}

async function cmdRunPhase(base: string, args: string[]): Promise<void> {
  const [id, phaseName, edge, ...rest] = args;
  if (!id || !phaseName || (edge !== 'start' && edge !== 'end')) {
    die('usage: run-phase <id> <phaseName> <start|end> [text]');
  }
  const text = rest.filter(a => a !== '--base' && a !== base).join(' ');
  const run = await getRun(base, id);
  const ev: RunEventLite =
    edge === 'start'
      ? { type: 'phase-start', phaseName, ts: Date.now() }
      : { type: 'phase-end', phaseName, ts: Date.now(), output: text || '' };
  run.events = [...(run.events ?? []), ev];
  run.eventVersion = (run.eventVersion ?? run.events.length - 1) + 1;
  await putRun(base, run);
  process.stdout.write(`ok (${run.events.length} events)\n`);
}

async function cmdRunClose(base: string, args: string[]): Promise<void> {
  const [id, status, ...rest] = args;
  if (!id || (status !== 'done' && status !== 'error' && status !== 'cancelled')) {
    die('usage: run-close <id> <done|error|cancelled> [text]');
  }
  const text = rest.filter(a => a !== '--base' && a !== base).join(' ');
  const run = await getRun(base, id);
  const now = Date.now();
  run.events = [
    ...(run.events ?? []),
    { type: 'run-end', ts: now, ...(text ? { text } : {}) },
  ];
  run.eventVersion = (run.eventVersion ?? run.events.length - 1) + 1;
  run.status = status;
  run.endedAt = now;
  await putRun(base, run);
  process.stdout.write(`closed ${id} as ${status}\n`);
}

async function cmdRunStatus(base: string, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die('usage: run-status <id>');
  const run = await getRun(base, id);
  const last = run.events?.[run.events.length - 1];
  const dur = run.endedAt ? `${Math.round((run.endedAt - run.startedAt) / 100) / 10}s` : 'live';
  process.stdout.write(
    `${run.id}  ${run.status.toUpperCase()}  ${run.orchestrationName}  (${dur})\n` +
      `  started ${new Date(run.startedAt).toLocaleString()}\n` +
      `  ${run.events?.length ?? 0} events` +
      (last ? `; last: ${last.type}${last.phaseName ? ` (${last.phaseName})` : ''}` : '') +
      '\n',
  );
}

async function cmdRunInProgress(base: string): Promise<void> {
  const runs = await listRuns(base);
  const live = runs
    .filter(r => r.status === 'running' || r.status === 'paused')
    .sort((a, b) => b.startedAt - a.startedAt);
  if (live.length === 0) {
    process.stdout.write('no runs in progress\n');
    return;
  }
  process.stdout.write(`${live.length} run(s) in progress:\n`);
  for (const r of live) {
    const age = Math.round((Date.now() - r.startedAt) / 1000);
    process.stdout.write(
      `  ${r.status === 'paused' ? '⏸' : '▶'} ${r.id}  ${r.orchestrationName}  (${age}s ago)\n`,
    );
  }
}

// The calibration flywheel from the terminal: record a human's override of a
// judge decision as a labeled correction that grows the calibration corpus.
//   sammy-cli record-correction --dataset severity-calibration --corrected critical --run <id>
//   sammy-cli record-correction --dataset severity-calibration --corrected high --input "Login broken on iOS"
async function cmdRecordCorrection(base: string, args: string[]): Promise<void> {
  const dataset = optValue(args, '--dataset');
  const corrected = optValue(args, '--corrected');
  const runId = optValue(args, '--run');
  const input = optValue(args, '--input');
  const predicted = optValue(args, '--predicted');
  if (!dataset || !corrected || (!runId && !input)) {
    die(
      'usage: record-correction --dataset <name> --corrected <label> ' +
        '(--run <id> | --input <text>) [--predicted <label>]',
    );
  }
  const res = await fetch(`${base}/api/corrections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetName: dataset, corrected, runId, input, predicted }),
  });
  if (!res.ok) die(`record-correction failed: ${res.status} ${await res.text()}`);
  const r = (await res.json()) as {
    dataset: string;
    rows: number;
    action: string;
    rowId: string;
  };
  process.stdout.write(
    `✓ ${r.action} correction in "${r.dataset}" (row ${r.rowId}); ` +
      `corpus now ${r.rows} rows. Re-run the eval to recalibrate.\n`,
  );
}

// ── preview — resolve an orchestration to its concrete plan, no side effects ──

/** Repo root relative to this file (app/sammy-cli.ts → repo root is one up). */
function repoRoot(): string {
  return path.resolve(__dirname, '..');
}

/** Candidate directories an orchestration name resolves against, in priority
 *  order: a top-level `orchestrations/` (if present), then `examples/`. */
function orchDirs(): string[] {
  const root = repoRoot();
  const dirs = [path.join(root, 'orchestrations'), path.join(root, 'examples')];
  return dirs.filter(d => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function readJson(file: string): Node | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Node;
  } catch {
    return null;
  }
}

/** Resolve an orchestration by NAME (orchestrations/ then examples/) or by an
 *  explicit / repo-relative PATH. Returns the parsed node + the file it came
 *  from, or null with the candidates it tried. */
function resolveOrchestration(
  ref: string,
): { node: Node; file: string } | { tried: string[] } {
  const tried: string[] = [];
  // 1. Explicit path (absolute or relative to cwd / repo root).
  const pathCandidates = [
    ref,
    path.resolve(process.cwd(), ref),
    path.resolve(repoRoot(), ref),
  ];
  for (const p of pathCandidates) {
    if (p.endsWith('.json')) {
      tried.push(p);
      const node = readJson(p);
      if (node) return { node, file: p };
    }
  }
  // 2. By name in the orchestration directories.
  for (const dir of orchDirs()) {
    const file = path.join(dir, `${ref}.json`);
    tried.push(file);
    const node = readJson(file);
    if (node) return { node, file };
  }
  return { tried };
}

/** Load every sibling orchestration (for subflow resolution) keyed by name.
 *  Mirrors makeLoadRunContext: a domain-imported (symlinked) entry shadows a
 *  shipped one of the same name. Best-effort — a parse failure is skipped. */
function loadAllOrchestrations(): Map<string, Node> {
  const byName = new Map<string, Node>();
  for (const dir of orchDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const node = readJson(path.join(dir, f));
      if (node && typeof node.name === 'string') {
        // First dir wins by priority order (orchestrations/ before examples/).
        if (!byName.has(node.name)) byName.set(node.name, node);
      }
    }
  }
  return byName;
}

/** Parse `--vars k=v,k=v` (repeatable; commas split pairs). */
function parseVars(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--vars') continue;
    const spec = args[i + 1];
    if (!spec) continue;
    for (const pair of spec.split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Build PreviewOptions from the parsed flags. */
function previewOptsFrom(
  args: string[],
  orchestrationByName: Map<string, Node>,
): PreviewOptions {
  const depthRaw = optValue(args, '--depth');
  const depth = depthRaw != null ? Number.parseInt(depthRaw, 10) : undefined;
  return {
    vars: parseVars(args),
    initialInput: optValue(args, '--input'),
    maxDepth: depth != null && Number.isFinite(depth) ? depth : undefined,
    noLint: args.includes('--no-lint'),
    orchestrationByName,
  };
}

async function cmdPreview(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref || ref.startsWith('--')) {
    die(
      'usage: preview <orchestration> [--vars k=v,…] [--input <json>] ' +
        '[--json] [--depth N] [--no-lint] [--diff <other-orchestration|k=v,…>]',
    );
  }
  const resolved = resolveOrchestration(ref);
  if ('tried' in resolved) {
    die(
      `orchestration "${ref}" not found. Tried:\n  ${resolved.tried.join('\n  ')}`,
    );
  }
  const all = loadAllOrchestrations();
  // Ensure the resolved root is in the map even if it lives outside the
  // standard dirs (explicit path), so subflow self-refs cycle-detect.
  if (typeof resolved.node.name === 'string' && !all.has(resolved.node.name)) {
    all.set(resolved.node.name, resolved.node);
  }
  const asJson = args.includes('--json');
  const opts = previewOptsFrom(args, all);

  // --diff: preview two configs side by side. The argument is EITHER another
  // orchestration name/path, OR a `k=v,…` vars override applied to the SAME
  // orchestration (the appEnv=dev vs appEnv=stg comparison).
  const diffArg = optValue(args, '--diff');
  if (diffArg) {
    const planA = previewOrchestration(resolved.node, opts);
    let planB;
    let labelB: string;
    const other = resolveOrchestration(diffArg);
    if (!('tried' in other)) {
      planB = previewOrchestration(other.node, opts);
      labelB = other.node.name ?? diffArg;
    } else {
      // Treat the arg as vars overrides on the same orchestration.
      const overrideVars = parseVars(['--vars', diffArg]);
      if (Object.keys(overrideVars).length === 0) {
        die(
          `--diff "${diffArg}" is neither a resolvable orchestration nor a k=v vars spec.`,
        );
      }
      planB = previewOrchestration(resolved.node, {
        ...opts,
        vars: { ...opts.vars, ...overrideVars },
      });
      labelB = diffArg;
    }
    const labelA =
      Object.keys(opts.vars ?? {}).length > 0
        ? Object.entries(opts.vars!)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')
        : resolved.node.name ?? ref;
    process.stdout.write(renderDiffText(planA, planB, labelA, labelB) + '\n');
    // Exit 1 if EITHER config has an error finding.
    if (planHasErrors(planA) || planHasErrors(planB)) process.exit(1);
    return;
  }

  const plan = previewOrchestration(resolved.node, opts);
  process.stdout.write(
    (asJson ? renderPlanJson(plan) : renderPlanText(plan)) + '\n',
  );
  // Exit 1 on any error-level finding so CI can gate; warnings don't fail.
  if (planHasErrors(plan)) process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1);
  const base = baseUrl(args);
  switch (cmd) {
    case 'run-open':
      return cmdRunOpen(base, args);
    case 'run-phase':
      return cmdRunPhase(base, args);
    case 'run-close':
      return cmdRunClose(base, args);
    case 'run-status':
      return cmdRunStatus(base, args);
    case 'run-in-progress':
      return cmdRunInProgress(base);
    case 'record-correction':
      return cmdRecordCorrection(base, args);
    case 'preview':
      // Pure + offline — does not touch `base` / the dev server.
      return cmdPreview(args);
    default:
      die(
        `unknown command "${cmd ?? ''}". Commands: run-open, run-phase, ` +
          'run-close, run-status, run-in-progress, record-correction, preview',
      );
  }
}

main().catch(err => die(err instanceof Error ? err.message : String(err)));
