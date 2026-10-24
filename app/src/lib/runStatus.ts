// Shared run-status derivation. The Pipeline / Graph / Tree views and the
// sidebar all need to know "which orchestration node is running / done /
// errored right now" so they can highlight live progress. The logic used to
// live (unexported) inside RunsPage's `findActivePhase` + `groupEvents`; this
// module factors the node-level slice of it so every view shares one source of
// truth, keyed by `phaseName` — which is exactly the orchestration `Node.name`.

import type { Node } from '../types';
import { childNodesOf } from './node-walk';
import type { RunEvent } from '../llm/executor';

export type NodeRunStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export type RunStatusInfo = {
  /** Node name → its derived status. Nodes never touched by the run are
   *  absent unless `allNodeNames` seeded them as 'pending'. */
  statusByNode: Map<string, NodeRunStatus>;
  /** The leaf phase currently executing (last phase-start still open), or
   *  null. Used to drive the pulse animation + animated edge-into-node. */
  activePhase: string | null;
  /** loop node name → current iteration number (1-based, from the stream). */
  loopIterByNode: Map<string, number>;
  /** map node name → { iteration, total } fan-out progress. */
  mapProgressByNode: Map<string, { iteration: number; total: number }>;
  /** route node name → the branch key the router picked. */
  routeDecisionByNode: Map<string, string>;
  /** loop node name → why it stopped (until / whileOutput / judge / cap) +
   *  the iteration it stopped on. Surfaces the "why did the loop stop" the
   *  event stream knows but the canvas was throwing away. */
  loopStopByNode: Map<string, { iteration: number; reason: string }>;
};

/** Status palette — kept in sync with RunsPage's StatusDot so all surfaces
 *  agree on what "running" blue / "done" green look like. */
export const STATUS_COLOR: Record<NodeRunStatus, string> = {
  pending: '#d1d5db',
  running: '#2563eb',
  done: '#059669',
  error: '#dc2626',
  skipped: '#9ca3af',
};

/** A short glyph per status for compact badges/dots. */
export const STATUS_ICON: Record<NodeRunStatus, string> = {
  pending: '·',
  running: '◉',
  done: '✓',
  error: '✗',
  skipped: '⊘',
};

/** Fresh empty info — used when there is no run to reflect. A factory (not a
 *  shared frozen constant) so callers can never accidentally mutate the maps. */
export function emptyRunStatus(): RunStatusInfo {
  return {
    statusByNode: new Map(),
    activePhase: null,
    loopIterByNode: new Map(),
    mapProgressByNode: new Map(),
    routeDecisionByNode: new Map(),
    loopStopByNode: new Map(),
  };
}

/** Every node `name` reachable in the tree — recursing every composite via
 *  the shared `childNodesOf` walker (array composites, loop/map bodies, route
 *  branches + switch cases + defaults, the `onError` recovery branch, and the
 *  `onStall.recover` fix-up phase — recovery paths are their own Nodes too, so
 *  they light up if they run; the hand-rolled walk this replaced missed
 *  `onStall.recover`). `agents` / `conversation` children are agent-path
 *  strings, not Nodes, so they contribute no names. Used to seed pending
 *  status for not-yet-started nodes while a run is live. */
export function collectNodeNames(node: Node): string[] {
  const out: string[] = [];
  const visit = (n: Node | undefined | null) => {
    if (!n || typeof n !== 'object') return;
    if (n.name) out.push(n.name);
    for (const child of childNodesOf(n)) visit(child);
  };
  visit(node);
  return out;
}

/** The leaf phase currently executing — the last `phase-start` that has no
 *  matching terminal event yet. Mirrors RunsPage.findActivePhase exactly so
 *  the views agree with the chat console on "what's running now." */
function findActivePhase(events: RunEvent[]): string | null {
  const open = new Set<string>();
  let last: string | null = null;
  for (const e of events) {
    if (e.type === 'phase-start') {
      open.add(e.phaseName);
      last = e.phaseName;
    } else if (
      e.type === 'phase-end' ||
      e.type === 'phase-error' ||
      e.type === 'phase-skipped'
    ) {
      open.delete(e.phaseName);
      if (last === e.phaseName) last = null;
    }
  }
  return last && open.has(last) ? last : null;
}

/** Single pass over the event stream → per-node status + loop/map/route
 *  progress. When `allNodeNames` is supplied every name is seeded 'pending'
 *  first, so nodes that haven't started yet render dimmed while the run is
 *  live (the "follow along" effect). Re-entrant nodes (loop bodies) stay
 *  'running' until they finish — a fresh start never downgrades an error. */
export function deriveRunStatus(
  events: RunEvent[],
  allNodeNames?: string[],
): RunStatusInfo {
  const info = emptyRunStatus();
  const {
    statusByNode,
    loopIterByNode,
    mapProgressByNode,
    routeDecisionByNode,
    loopStopByNode,
  } = info;

  if (allNodeNames) {
    for (const name of allNodeNames) statusByNode.set(name, 'pending');
  }

  const setUnlessError = (name: string, status: NodeRunStatus) => {
    if (statusByNode.get(name) === 'error') return;
    statusByNode.set(name, status);
  };

  for (const e of events) {
    switch (e.type) {
      case 'phase-start':
      case 'composite-start':
        setUnlessError(e.phaseName, 'running');
        break;
      case 'phase-end':
      case 'composite-end':
        setUnlessError(e.phaseName, 'done');
        break;
      case 'phase-skipped':
        setUnlessError(e.phaseName, 'skipped');
        break;
      case 'phase-error':
        statusByNode.set(e.phaseName, 'error');
        break;
      case 'loop-iteration':
        loopIterByNode.set(e.phaseName, e.iteration);
        setUnlessError(e.phaseName, 'running');
        break;
      case 'loop-stopped':
        loopIterByNode.set(e.phaseName, e.iteration);
        loopStopByNode.set(e.phaseName, {
          iteration: e.iteration,
          reason: e.reason,
        });
        setUnlessError(e.phaseName, 'done');
        break;
      case 'map-iteration':
        mapProgressByNode.set(e.phaseName, {
          iteration: e.iteration,
          total: e.total,
        });
        setUnlessError(e.phaseName, 'running');
        break;
      case 'route-decision':
        routeDecisionByNode.set(e.phaseName, e.branch);
        break;
      default:
        break;
    }
  }

  info.activePhase = findActivePhase(events);
  return info;
}
