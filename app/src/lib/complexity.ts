import type { Node } from '../types';

/**
 * Orchestration complexity metric.
 *
 * A single, framework-level number (plus the raw signals behind it) that
 * answers "how much is going on in this orchestration?" — surfaced as a badge
 * in the pipeline list and the detail / graph view so a reviewer can spot the
 * heavy, hard-to-reason-about flows at a glance.
 *
 * It is deliberately GENERIC: it reads only the orchestration JSON shape (the
 * node tree + a few decorators), never anything domain-specific. The same
 * function scores any orchestration regardless of what its agents do.
 *
 * ── Signals (each is a structural property of the tree) ──────────────────────
 *  - nodeCount          total nodes (every composite + every leaf)
 *  - maxDepth           deepest nesting level (a flat `phases` list is depth 1)
 *  - maxFanout          widest parallel branch set — the largest `parallel` /
 *                       `converge` array, or a parallel `map` (counts as its
 *                       fan-out width, see below)
 *  - loops              count of `loop` nodes (refinement — re-runs a body)
 *  - maps               count of `map` nodes (fan-out over an array)
 *  - serialMaps         count of `map` nodes forced serial (`map.serial`)
 *  - subflows           count of `subflow` references (nests another flow)
 *  - distinctAgents     unique agent paths referenced anywhere
 *  - distinctTools      unique declared `tools` across all nodes
 *  - branches           count of `route` / `switch` decision nodes
 *
 * ── Why each signal adds complexity ──────────────────────────────────────────
 * Depth and fan-out drive how hard the run is to reason about and how much it
 * costs to operate (fan-out is concurrent subprocesses; see
 * docs/AUTHORING_ORCHESTRATIONS.md §4). Loops/maps add non-linear control flow
 * and a token blast radius. Subflows hide whole trees behind one node. Distinct
 * agents/tools widen the surface area (more moving parts, more dependencies).
 *
 * ── The score ────────────────────────────────────────────────────────────────
 * A weighted sum of the signals, tuned so a small linear pipeline lands in
 * "trivial/simple" and a deep, wide, loop-and-subflow-heavy flow lands in
 * "complex". The exact weights are heuristic — the goal is a stable RELATIVE
 * ordering and a coarse tier, not a precise cost prediction. Tiers:
 *
 *   trivial   < 10     a couple of phases, no nesting
 *   simple    10–24    a normal linear / lightly-branched flow
 *   moderate  25–49    real structure — fan-out, a loop, a few agents
 *   complex   50–99    deep + wide, multiple loops/maps/subflows
 *   intricate ≥ 100    a large composite system; review the cost model
 */
export type ComplexityTier =
  | 'trivial'
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'intricate';

export type ComplexitySignals = {
  nodeCount: number;
  maxDepth: number;
  maxFanout: number;
  loops: number;
  maps: number;
  serialMaps: number;
  subflows: number;
  distinctAgents: number;
  distinctTools: number;
  branches: number;
};

export type Complexity = {
  score: number;
  tier: ComplexityTier;
  signals: ComplexitySignals;
};

/** Per-signal contribution weights for the score. Heuristic; see the tiers
 *  note above. Kept here (not inline) so the metric is auditable in one place. */
const WEIGHTS = {
  node: 1, // each node is a unit of work to read
  depth: 4, // nesting is the steepest reasoning cost
  fanout: 3, // wide fan-out is concurrent load + harder to follow
  loop: 6, // a loop is non-linear control + a token blast radius
  map: 4, // fan-out over data, often LLM-determined width
  serialMap: 2, // serial maps add latency but bounded concurrency
  subflow: 5, // a subflow hides a whole tree behind one node
  agent: 2, // each distinct agent is a moving part / dependency
  tool: 1, // each distinct tool widens the dependency surface
  branch: 3, // route/switch fork the path → more cases to reason about
} as const;

function tierFor(score: number): ComplexityTier {
  if (score < 10) return 'trivial';
  if (score < 25) return 'simple';
  if (score < 50) return 'moderate';
  if (score < 100) return 'complex';
  return 'intricate';
}

/**
 * Walk an orchestration tree and compute its complexity signals + score.
 *
 * Pure and cheap — visits every node once. Walks every composite body kind
 * (phases / agents / parallel / converge / loop / map / route / switch /
 * conversation / subflow) plus the `onError` recovery subtree, so nested
 * structure is fully counted. `conversation` participants and `agents` chains
 * count toward the distinct-agent set; `subflow` is a reference (the referenced
 * tree is not inlined here — counting it as one node + one subflow matches how
 * the graph shows it).
 */
export function computeComplexity(root: Node): Complexity {
  let nodeCount = 0;
  let maxDepth = 0;
  let maxFanout = 0;
  let loops = 0;
  let maps = 0;
  let serialMaps = 0;
  let subflows = 0;
  let branches = 0;
  const agents = new Set<string>();
  const tools = new Set<string>();

  function visit(n: Node, depth: number): void {
    nodeCount++;
    if (depth > maxDepth) maxDepth = depth;

    // ── leaf / agent references ──
    if (n.agent) agents.add(n.agent);
    for (const a of n.agents ?? []) agents.add(a);
    for (const p of n.conversation?.participants ?? []) agents.add(p);
    if (n.merger) agents.add(n.merger);
    if (n.loop?.judge) agents.add(n.loop.judge);
    if (n.route?.router) agents.add(n.route.router);
    for (const t of n.tools ?? []) tools.add(t);

    // ── structural signals ──
    if (n.subflow) subflows++;
    if (n.loop) loops++;
    if (n.route || n.switch) branches++;
    if (n.map) {
      maps++;
      if (n.map.serial) serialMaps++;
      // A parallel map fans out over its array. Its runtime width is
      // data-dependent (the array can be LLM-determined), so the only static
      // width bound is an explicit `concurrency` cap; use it as a fan-out
      // signal when present. The map itself already contributes via the `map`
      // weight regardless.
      else if (n.map.concurrency && n.map.concurrency > maxFanout) {
        maxFanout = n.map.concurrency;
      }
    }

    // ── fan-out width (the widest concurrent branch set) ──
    for (const arr of [n.parallel, n.converge] as (Node[] | undefined)[]) {
      if (Array.isArray(arr) && arr.length > maxFanout) maxFanout = arr.length;
    }

    // ── recurse into every composite Node[] body + the recovery subtree ──
    // (`n.agents` is a string[] of agent paths, NOT child nodes — it's folded
    // into the distinct-agent set above, never walked here.)
    for (const arr of [n.phases, n.parallel, n.converge] as (
      | Node[]
      | undefined
    )[]) {
      if (Array.isArray(arr)) for (const c of arr) visit(c, depth + 1);
    }
    if (n.loop?.body) visit(n.loop.body, depth + 1);
    if (n.map?.body) visit(n.map.body, depth + 1);
    if (n.route?.branches) {
      for (const b of Object.values(n.route.branches)) if (b) visit(b, depth + 1);
      if (n.route.default) visit(n.route.default, depth + 1);
    }
    if (n.switch?.cases) {
      for (const c of Object.values(n.switch.cases)) if (c) visit(c, depth + 1);
      if (n.switch.default) visit(n.switch.default, depth + 1);
    }
    if (n.onError) visit(n.onError, depth + 1);
  }

  // Root is depth 1 so a flat `phases: [...]` list reads as "one level deep".
  visit(root, 1);

  const signals: ComplexitySignals = {
    nodeCount,
    maxDepth,
    maxFanout,
    loops,
    maps,
    serialMaps,
    subflows,
    distinctAgents: agents.size,
    distinctTools: tools.size,
    branches,
  };

  const score = Math.round(
    signals.nodeCount * WEIGHTS.node +
      signals.maxDepth * WEIGHTS.depth +
      signals.maxFanout * WEIGHTS.fanout +
      signals.loops * WEIGHTS.loop +
      signals.maps * WEIGHTS.map +
      signals.serialMaps * WEIGHTS.serialMap +
      signals.subflows * WEIGHTS.subflow +
      signals.distinctAgents * WEIGHTS.agent +
      signals.distinctTools * WEIGHTS.tool +
      signals.branches * WEIGHTS.branch,
  );

  return { score, tier: tierFor(score), signals };
}

/** Display color per tier (badge background). Greens → ambers → reds as the
 *  flow gets heavier, matching the rest of the UI's status palette. */
export const TIER_COLOR: Record<ComplexityTier, string> = {
  trivial: '#6b7280',
  simple: '#059669',
  moderate: '#0891b2',
  complex: '#d97706',
  intricate: '#dc2626',
};

/** A compact human label for the badge, e.g. "moderate · 32". */
export function complexityLabel(c: Complexity): string {
  return `${c.tier} · ${c.score}`;
}

/** A self-explanatory tooltip / a11y description: what the tier+score MEAN
 *  (the band scale) plus the signals that drove the score, e.g.
 *  "Complexity: moderate (score 32 of trivial<10 · simple<25 · moderate<50 ·
 *   complex<100 · intricate 100+). Driven by: 9 nodes, depth 3, fan-out 3,
 *   1 loop, 4 agents." Only non-zero signals are listed to stay readable. */
export function complexityDescription(c: Complexity): string {
  const s = c.signals;
  const parts: string[] = [`${s.nodeCount} node${s.nodeCount === 1 ? '' : 's'}`];
  if (s.maxDepth > 1) parts.push(`depth ${s.maxDepth}`);
  if (s.maxFanout > 0) parts.push(`fan-out ${s.maxFanout}`);
  if (s.loops > 0) parts.push(`${s.loops} loop${s.loops === 1 ? '' : 's'}`);
  if (s.maps > 0) parts.push(`${s.maps} map${s.maps === 1 ? '' : 's'}`);
  if (s.serialMaps > 0) parts.push(`${s.serialMaps} serial-map`);
  if (s.subflows > 0)
    parts.push(`${s.subflows} subflow${s.subflows === 1 ? '' : 's'}`);
  if (s.branches > 0)
    parts.push(`${s.branches} branch${s.branches === 1 ? '' : 'es'}`);
  if (s.distinctAgents > 0)
    parts.push(`${s.distinctAgents} agent${s.distinctAgents === 1 ? '' : 's'}`);
  if (s.distinctTools > 0)
    parts.push(`${s.distinctTools} tool${s.distinctTools === 1 ? '' : 's'}`);
  return (
    `Complexity: ${c.tier} (score ${c.score} of trivial<10 · simple<25 · ` +
    `moderate<50 · complex<100 · intricate 100+). Driven by: ${parts.join(', ')}.`
  );
}
