/**
 * run-result — what a run produced, read back from its events.
 *
 * The Result card (Pipelines page, Runs page, the finish notice) answers three
 * questions about a run: did it work, what did it make, and what next. Every
 * answer here is derived from the durable event stream the run already
 * records — no engine field backs it — so the card works for runs that
 * finished before it existed, and for live runs as their events arrive.
 *
 * The "what did it make" part is a best guess from the step outputs: links an
 * agent wrote in its answer, ranked so a pull request beats an issue beats any
 * other link. Nothing is invented — a title is only shown when the output gives
 * one as the text of a markdown link.
 */

import type { RunEvent } from '../llm/executor';
import { computeDegradation, type DegradationReason } from '../server/degradation';
import type { Node } from '../types';
import { childNodesOf } from './node-walk';
import { foldSpend } from './spend';

export type RunResultState =
  | 'running'
  | 'waiting'
  | 'done'
  | 'degraded'
  | 'failed'
  | 'cancelled';

export type ResultLinkKind = 'pull-request' | 'merge-request' | 'issue' | 'link';

export type ResultLink = {
  kind: ResultLinkKind;
  url: string;
  /** Short reference: `owner/repo #12`, `ABC-123`, or host + path. */
  ref: string;
  /** Only when the output named it as a markdown link's text. */
  title?: string;
  /** The step whose output carried it. */
  phaseName: string;
};

export type RunResult = {
  state: RunResultState;
  /** Interrupted runs read as failed, with this set so the card can say so. */
  interrupted: boolean;
  /** waiting: the step held at a lock gate; null when the pause is something
   *  else (a durable wait, an idle terminal). */
  gatedPhase: string | null;
  /** failed: the step that failed (null when the run failed before one ran). */
  failedPhase: string | null;
  error: string | null;
  degradationReasons: DegradationReason[];
  /** Wall time, start to end (or to now while it runs) — includes time spent
   *  waiting at a gate. */
  durationMs: number;
  costUsd: number;
  /** Distinct steps that finished. */
  stepsDone: number;
  /** Their names, in the order they finished. */
  doneSteps: string[];
  /** Steps in the pipeline, when its shape makes that countable (no loops,
   *  maps, branches or subflows); null otherwise. */
  stepsTotal: number | null;
  /** running: the step executing now. */
  currentPhase: string | null;
  /** Gates approved during the run. */
  approvals: number;
  hero: ResultLink | null;
  /** Every other link the outputs carried, deduped, best first. */
  links: ResultLink[];
  branches: string[];
  artifacts: number;
  /** The last finished step's answer (failed: the failing step's partial
   *  output when it streamed any). */
  output: { phaseName: string; text: string } | null;
  /** Finished steps whose output can seed a fork ("retry from"). */
  forkPoints: string[];
};

/** The slice of a Run this module reads — the store's Run satisfies it, and
 *  so does a server run record (which may add `degradationReasons`). */
export type RunLike = {
  status: string;
  startedAt: number;
  endedAt?: number;
  events: RunEvent[];
  orchestrationSnapshot?: Node;
  costUsd?: number;
  degradationReasons?: DegradationReason[] | null;
  pendingWait?: unknown;
  stateJson?: { pendingWait?: unknown } | null;
  pausedFor?: string | null;
};

type AnyEvent = {
  type: string;
  phaseName?: string;
  output?: unknown;
  error?: unknown;
  text?: unknown;
  agentPath?: unknown;
  reason?: unknown;
  decision?: unknown;
  name?: unknown;
  dropped?: unknown;
  worktrees?: Array<{ branch?: unknown }>;
};

/** The session leg's own phase in a harness run — the agent's narration,
 *  not a step of the pipeline. */
const HARNESS_PHASE = 'harness';

export function deriveRunResult(run: RunLike, now: number = Date.now()): RunResult {
  const events = run.events as unknown as AnyEvent[];
  const isHarness = events.some(e => e.type === 'harness-start');
  const isStep = (name: string | undefined): name is string =>
    !!name && !(isHarness && name === HARNESS_PHASE);

  const doneSteps = new Set<string>();
  const leafStarts = new Set<string>();
  const forkPoints: string[] = [];
  const open = new Set<string>();
  let current: string | null = null;
  let lastEnd: { phaseName: string; text: string } | null = null;
  let lastError: { phaseName: string; error: string } | null = null;
  let runError: string | null = null;
  let interruptedReason: string | null = null;
  let approvals = 0;
  let branches: string[] = [];
  const artifacts = new Set<string>();
  const partial = new Map<string, string>();

  for (const e of events) {
    switch (e.type) {
      case 'phase-start':
        if (e.phaseName) {
          open.add(e.phaseName);
          if (isStep(e.phaseName)) current = e.phaseName;
          if (typeof e.agentPath === 'string') leafStarts.add(e.phaseName);
          partial.delete(e.phaseName);
        }
        break;
      case 'phase-delta':
        if (e.phaseName && typeof e.text === 'string') {
          partial.set(e.phaseName, (partial.get(e.phaseName) ?? '') + e.text);
        }
        break;
      case 'phase-end':
      case 'phase-error':
      case 'phase-skipped':
        if (!e.phaseName) break;
        open.delete(e.phaseName);
        if (current === e.phaseName) current = null;
        if (e.type === 'phase-end') {
          if (isStep(e.phaseName)) doneSteps.add(e.phaseName);
          if (leafStarts.has(e.phaseName) && !forkPoints.includes(e.phaseName)) {
            forkPoints.push(e.phaseName);
          }
          const text = typeof e.output === 'string' ? e.output : '';
          if (text.trim()) lastEnd = { phaseName: e.phaseName, text };
        } else if (e.type === 'phase-error') {
          lastError = { phaseName: e.phaseName, error: String(e.error ?? '') };
        }
        break;
      case 'run-error':
        runError = String(e.error ?? '');
        break;
      case 'run-interrupted':
        interruptedReason = String(e.reason ?? '');
        break;
      case 'budget-halted':
        runError = String(e.reason ?? 'Budget reached');
        break;
      case 'gate-decision':
        if (e.decision === 'approve') approvals++;
        break;
      case 'worktrees-ready':
        if (Array.isArray(e.worktrees)) {
          branches = e.worktrees
            .map(w => (typeof w.branch === 'string' ? w.branch : ''))
            .filter(Boolean);
        }
        break;
      case 'artifact':
        if (typeof e.name === 'string' && e.dropped !== true) artifacts.add(e.name);
        break;
    }
  }
  // A step still open is the one running (or the one a failure stopped in).
  if (current && !open.has(current)) current = null;

  const state = stateOf(run.status, run);
  const interrupted = run.status === 'interrupted';
  const degradationReasons =
    state === 'done' || state === 'degraded' ? degradationOf(run) : [];

  const failedPhase =
    state === 'failed' ? (lastError?.phaseName ?? (current && isStep(current) ? current : null)) : null;
  const error =
    state === 'failed'
      ? (interrupted ? interruptedReason : null) || runError || lastError?.error || null
      : null;

  let output = lastEnd;
  if (state === 'failed' && failedPhase) {
    const text = partial.get(failedPhase);
    if (text && text.trim()) output = { phaseName: failedPhase, text };
  }

  const found = collectLinks(events);
  const end = run.endedAt ?? (state === 'running' || state === 'waiting' ? now : run.startedAt);
  const spent = foldSpend(run.events as Parameters<typeof foldSpend>[0]);

  return {
    state: degradationReasons.length > 0 ? 'degraded' : state,
    interrupted,
    gatedPhase: state === 'waiting' ? gatedPhaseOf(run) : null,
    failedPhase,
    error,
    degradationReasons,
    durationMs: Math.max(0, end - run.startedAt),
    costUsd: events.length > 0 ? spent.costUsd : (run.costUsd ?? 0),
    stepsDone: doneSteps.size,
    doneSteps: [...doneSteps],
    stepsTotal: run.orchestrationSnapshot ? countSteps(run.orchestrationSnapshot) : null,
    currentPhase: state === 'running' ? current : null,
    approvals,
    hero: found[0] ?? null,
    links: found.slice(1),
    branches,
    artifacts: artifacts.size,
    output,
    forkPoints,
  };
}

function stateOf(status: string, run: RunLike): RunResultState {
  switch (status) {
    case 'done':
      return 'done';
    case 'error':
    case 'interrupted':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'waiting';
    default:
      return run.endedAt ? 'done' : 'running';
  }
}

/** The server's verdict when the record carries it; otherwise the same
 *  derivation the server runs, over the events this client holds. */
function degradationOf(run: RunLike): DegradationReason[] {
  if (Array.isArray(run.degradationReasons)) return run.degradationReasons;
  if (run.events.length === 0) return [];
  return computeDegradation(run.events as unknown as Parameters<typeof computeDegradation>[0])
    .reasons;
}

/** The phase a paused run is gated at — the RunsPage rule: the last
 *  lock-gate, unless a resume or a durable wait came after it. */
export function gatedPhaseOf(run: RunLike): string | null {
  if (run.pendingWait || run.stateJson?.pendingWait) return null;
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i] as AnyEvent;
    if (e.type === 'wait-started') return null;
    if (e.type === 'run-resumed') return null;
    if (e.type === 'lock-gate' && e.phaseName) return e.phaseName;
  }
  return run.events.length === 0 ? (run.pausedFor ?? null) : null;
}

/** Steps in a pipeline of fixed shape: one per leaf, plus a converge's
 *  merger. Null when the shape repeats or branches (loop, map, route,
 *  switch, conversation, subflow, agents chain, onError) — any count would
 *  be a guess. */
export function countSteps(node: Node): number | null {
  const n = node as Node & Record<string, unknown>;
  for (const k of ['loop', 'map', 'route', 'switch', 'conversation', 'subflow', 'agents', 'onError']) {
    if (n[k] != null) return null;
  }
  const kids = childNodesOf(node);
  if (kids.length === 0) {
    return ['agent', 'code', 'http', 'wait', 'a2a', 'skill'].some(k => n[k] != null) ? 1 : 0;
  }
  let total = Array.isArray(n.converge) ? 1 : 0;
  for (const k of kids) {
    const c = countSteps(k);
    if (c == null) return null;
    total += c;
  }
  return total;
}

// ─── Links ───────────────────────────────────────────────────────────────

const RANK: Record<ResultLinkKind, number> = {
  'pull-request': 0,
  'merge-request': 1,
  issue: 2,
  link: 3,
};

const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`*]+/g;

/** Every link the step outputs carry, best first: by kind, then the latest
 *  step first (the last step's answer is the run's answer). */
export function collectLinks(events: ReadonlyArray<{ type: string }>): ResultLink[] {
  const seen = new Map<string, ResultLink & { order: number }>();
  let order = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as AnyEvent;
    if (e.type !== 'phase-end' || typeof e.output !== 'string' || !e.phaseName) continue;
    for (const link of linksIn(e.output, e.phaseName)) {
      const key = canonical(link.url);
      const had = seen.get(key);
      if (!had) seen.set(key, { ...link, order: order++ });
      else if (!had.title && link.title) had.title = link.title;
    }
  }
  return [...seen.values()]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.order - b.order)
    .map(({ order: _order, ...l }) => l);
}

/** The links in one output, in order: markdown links (with their text),
 *  then bare URLs. */
export function linksIn(text: string, phaseName: string): ResultLink[] {
  const out: ResultLink[] = [];
  const titled = new Map<string, string>();
  for (const m of text.matchAll(MD_LINK)) {
    const label = m[1].trim();
    titled.set(canonical(m[2]), label);
  }
  for (const m of text.matchAll(BARE_URL)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const link = classify(url, phaseName);
    if (!link) continue;
    const label = titled.get(canonical(url));
    if (label && isTitle(label, link)) link.title = label;
    out.push(link);
  }
  return out;
}

function canonical(url: string): string {
  return url.replace(/[.,;:!?]+$/, '').replace(/\/+$/, '').replace(/#.*$/, '').toLowerCase();
}

/** A markdown label is a title unless it only restates the link. */
function isTitle(label: string, link: ResultLink): boolean {
  const l = label.replace(/[`*_]/g, '').trim();
  if (!l) return false;
  if (/^https?:\/\//i.test(l)) return false;
  if (canonical(l) === canonical(link.url)) return false;
  const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  if (compact(l) === compact(link.ref)) return false;
  // `owner/repo#12`, `#12`, `PR #12`, `ABC-123` — references, not titles.
  if (/^(?:(?:pr|pull request|mr|issue)\s*)?(?:[\w.-]+\/[\w.-]+)?\s*[#!]\d+$/i.test(l)) return false;
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(l)) return false;
  return true;
}

export function classify(url: string, phaseName: string): ResultLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // A server a step started for itself (QA's dev server) is gone once the
  // run ends — not something the run produced.
  if (/^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.replace(/^www\./, '');

  // GitHub (and GitHub Enterprise): /owner/repo/pull/N, /owner/repo/issues/N
  if (parts.length >= 4 && /^\d+$/.test(parts[3])) {
    const repo = `${parts[0]}/${parts[1]}`;
    if (parts[2] === 'pull' || parts[2] === 'pulls') {
      return { kind: 'pull-request', url, ref: `${repo} #${parts[3]}`, phaseName };
    }
    if (parts[2] === 'issues') {
      return { kind: 'issue', url, ref: `${repo} #${parts[3]}`, phaseName };
    }
  }
  // GitLab: /group[/sub]/repo/-/merge_requests/N, /-/issues/N
  const dash = parts.indexOf('-');
  if (dash > 0 && parts.length > dash + 2 && /^\d+$/.test(parts[dash + 2])) {
    const repo = parts.slice(0, dash).join('/');
    if (parts[dash + 1] === 'merge_requests') {
      return { kind: 'merge-request', url, ref: `${repo} !${parts[dash + 2]}`, phaseName };
    }
    if (parts[dash + 1] === 'issues') {
      return { kind: 'issue', url, ref: `${repo} #${parts[dash + 2]}`, phaseName };
    }
  }
  // Jira: /browse/KEY-123
  const browse = parts.indexOf('browse');
  if (browse >= 0 && /^[A-Z][A-Z0-9]+-\d+$/.test(parts[browse + 1] ?? '')) {
    return { kind: 'issue', url, ref: parts[browse + 1], phaseName };
  }
  const path = parts.length > 0 ? `/${parts.join('/')}` : '';
  const ref = `${host}${path}`;
  return { kind: 'link', url, ref: ref.length > 48 ? `${ref.slice(0, 47)}…` : ref, phaseName };
}

/** A label for a link's kind, for the card and the notice. */
export function linkKindLabel(kind: ResultLinkKind): string {
  switch (kind) {
    case 'pull-request':
      return 'Pull request';
    case 'merge-request':
      return 'Merge request';
    case 'issue':
      return 'Issue';
    default:
      return 'Link';
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
