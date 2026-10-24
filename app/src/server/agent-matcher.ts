/**
 * Match the agent paths a generated orchestration declares against
 * the real agent files in the workspace. The diagram-to-orchestration
 * flow asks the designer agent to use `agents/<name>.md` paths drawn
 * from the available-agents list it was given, but the LLM sometimes:
 *
 *   - hallucinates a name that doesn't exist
 *   - uses a near-miss spelling (`agents/pm-agent.md` vs `agents/pm.md`)
 *   - extracts a label from the diagram that has no agent yet
 *     (`agents/answer-quiz.md` when no such file is on disk)
 *
 * For each leaf node with an `agent` field, this module computes:
 *   - exact match (path equality, normalized)
 *   - normalized-name match (strip suffixes like -qa / -agent, ignore
 *     case + separators)
 *   - substring containment
 *   - Levenshtein-within-threshold
 * and returns a match report the UI uses to surface ✓/✗ per phase,
 * with a remap suggestion if the LLM picked a near-miss.
 */

import { compositeKey, type Node } from '../types';

export type MatchSource = 'exact' | 'normalized' | 'substring' | 'levenshtein';

export type AgentMatch = {
  /** The agent path the orchestration node declares as-is. */
  declared: string;
  /** Where in the tree this declaration lives — the leaf phase's name. */
  phaseName: string;
  /** When matched, the agent file path we resolved to (in the form
   *  the schema expects, e.g. `agents/pm.md`). */
  matched: string | null;
  /** How we matched, when matched != null. Helps the UI surface
   *  confidence — exact > normalized > substring > levenshtein. */
  matchSource: MatchSource | null;
  /** When matched via fuzzy, the bare agent name (without the
   *  `agents/` prefix or `.md` suffix) — convenient for one-liner
   *  UI captions. */
  matchedName: string | null;
};

export type MatchReport = {
  matches: AgentMatch[];
  /** Phases the matcher couldn't resolve. UI shows the
   *  "✨ Generate the N missing agents" button for these. */
  unmatched: AgentMatch[];
};

/** Walk every leaf node (anything with an `agent: string` field) in
 *  the orchestration and match its agent path against the workspace
 *  agent list. Composites (phases/parallel/etc.) recurse into their
 *  children. */
export function matchAgents(
  orchestration: Node,
  availableAgentNames: string[],
): MatchReport {
  const matches: AgentMatch[] = [];
  const normalizedIndex = buildNormalizedIndex(availableAgentNames);
  function visit(node: Node): void {
    if (typeof node.agent === 'string' && node.agent.length > 0) {
      matches.push(resolveOne(node.agent, node.name, normalizedIndex));
    }
    if (Array.isArray(node.agents)) {
      for (const a of node.agents) {
        matches.push(resolveOne(a, node.name, normalizedIndex));
      }
    }
    const kind = compositeKey(node);
    if (kind === 'phases' || kind === 'parallel' || kind === 'converge') {
      for (const child of (node[kind] as Node[] | undefined) ?? []) visit(child);
    }
    if (node.loop?.body) visit(node.loop.body);
    if (node.map?.body) visit(node.map.body);
    if (node.route?.branches) {
      for (const b of Object.values(node.route.branches)) visit(b);
      if (node.route.default) visit(node.route.default);
    }
    if (node.onError) visit(node.onError);
  }
  visit(orchestration);
  return {
    matches,
    unmatched: matches.filter(m => m.matched === null),
  };
}

type NormalizedIndex = {
  byExact: Map<string, string>;
  byNormalized: Map<string, string>;
  all: string[];
};

function buildNormalizedIndex(names: string[]): NormalizedIndex {
  const byExact = new Map<string, string>();
  const byNormalized = new Map<string, string>();
  for (const name of names) {
    byExact.set(name, name);
    // Normalized: lowercase, strip -qa / -agent suffixes, remove
    // separators (so `BillingHostQA` ≈ `billing-host`).
    const n = normalize(name);
    if (n && !byNormalized.has(n)) byNormalized.set(n, name);
    const stripped = stripSuffixes(n);
    if (stripped && stripped !== n && !byNormalized.has(stripped)) {
      byNormalized.set(stripped, name);
    }
  }
  return { byExact, byNormalized, all: [...names] };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^agents\//, '')
    .replace(/\.md$/, '')
    .replace(/[-_\s]+/g, '');
}

function stripSuffixes(normalized: string): string {
  return normalized
    .replace(/(qa|agent|bot|worker|runner|orchestrator)$/g, '')
    .replace(/[-_]+$/, '');
}

function resolveOne(
  declared: string,
  phaseName: string,
  idx: NormalizedIndex,
): AgentMatch {
  const bare = declared.replace(/^agents\//, '').replace(/\.md$/, '');

  // 1. Exact match on the file's bare name.
  if (idx.byExact.has(bare)) {
    return ok(declared, phaseName, idx.byExact.get(bare)!, 'exact');
  }
  // 2. Normalized + suffix-stripped.
  const n = normalize(declared);
  const ns = stripSuffixes(n);
  if (idx.byNormalized.has(n)) {
    return ok(declared, phaseName, idx.byNormalized.get(n)!, 'normalized');
  }
  if (ns && idx.byNormalized.has(ns)) {
    return ok(declared, phaseName, idx.byNormalized.get(ns)!, 'normalized');
  }
  // 3. Substring containment (either direction). Guard against
  //    over-matching short candidates: `dev` substring-includes
  //    `devleed` would pick the 3-char file when `dev-lead` is a
  //    much better Levenshtein match. Require BOTH names to be
  //    ≥ 4 chars AND the shorter to be ≥ 60% of the longer length
  //    so a "label is a strict initial fragment" case still wins
  //    (e.g. `billing-host` ⊂ `billing-host-qa`).
  let subHit: string | null = null;
  for (const candidate of idx.all) {
    const cn = normalize(candidate);
    if (cn.length < 4 || n.length < 4) continue;
    const ratio = Math.min(cn.length, n.length) / Math.max(cn.length, n.length);
    if (ratio < 0.6) continue;
    if (cn.includes(n) || n.includes(cn)) {
      subHit = candidate;
      break;
    }
  }
  if (subHit) return ok(declared, phaseName, subHit, 'substring');
  // 4. Levenshtein within 25% of the longer length, AND with both
  //    sides at least 3 chars. The short-name guard exists because
  //    single-letter labels (A, B, C from a diagram template) would
  //    otherwise silently snap to whichever agent has the shortest
  //    name — `pm.md` always wins for single chars because
  //    distance("a", "pm") = 2 fits the historical limit. The
  //    matcher had no way to distinguish "this label is too generic
  //    to ground in the agent list" from "this is a real
  //    near-miss," so it always picked something. That's worse than
  //    leaving the user to fill the path in.
  //
  //    The 3-char floor is conservative: a "QA" abbreviation
  //    legitimately maps to "qa" — but `qa` is 2 chars, so the
  //    normalization path (step 2) handles that case before we get
  //    here. We're only filtering at the Levenshtein step.
  const MIN_LEVENSHTEIN_LEN = 3;
  let best: { name: string; dist: number } | null = null;
  if (n.length >= MIN_LEVENSHTEIN_LEN) {
    for (const candidate of idx.all) {
      const cn = normalize(candidate);
      if (cn.length < MIN_LEVENSHTEIN_LEN) continue;
      const d = levenshtein(n, cn);
      const limit = Math.max(2, Math.floor(Math.max(n.length, cn.length) * 0.25));
      if (d <= limit && (!best || d < best.dist)) {
        best = { name: candidate, dist: d };
      }
    }
  }
  if (best) return ok(declared, phaseName, best.name, 'levenshtein');

  return {
    declared,
    phaseName,
    matched: null,
    matchSource: null,
    matchedName: null,
  };
}

function ok(
  declared: string,
  phaseName: string,
  matchedName: string,
  matchSource: MatchSource,
): AgentMatch {
  return {
    declared,
    phaseName,
    matched: `agents/${matchedName}.md`,
    matchSource,
    matchedName,
  };
}

/** Iterative Levenshtein. O(m·n) memory; for our use case (<100
 *  candidates × names < 50 chars) totally fine. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Apply a match report back to the orchestration: any declared path
 *  that resolved to a different name (normalized / substring /
 *  levenshtein) gets rewritten to the canonical `agents/<match>.md`
 *  path. Exact matches and unresolved paths are left alone. */
export function applyMatchesToOrchestration(
  orchestration: Node,
  report: MatchReport,
): Node {
  // Build a quick lookup so we don't re-walk the matches array per node.
  const rewriteByPhase = new Map<string, Map<string, string>>();
  for (const m of report.matches) {
    if (!m.matched || m.matchSource === 'exact') continue;
    if (m.matched === m.declared) continue;
    let inner = rewriteByPhase.get(m.phaseName);
    if (!inner) {
      inner = new Map();
      rewriteByPhase.set(m.phaseName, inner);
    }
    inner.set(m.declared, m.matched);
  }
  function rewrite(node: Node): Node {
    const inner = rewriteByPhase.get(node.name);
    const next: Node = { ...node };
    if (inner && typeof node.agent === 'string') {
      const r = inner.get(node.agent);
      if (r) next.agent = r;
    }
    if (inner && Array.isArray(node.agents)) {
      next.agents = node.agents.map(a => inner.get(a) ?? a);
    }
    const kind = compositeKey(node);
    if (kind === 'phases' || kind === 'parallel' || kind === 'converge') {
      const arr = (node[kind] as Node[] | undefined) ?? [];
      (next as Record<string, unknown>)[kind] = arr.map(rewrite);
    }
    if (node.loop?.body) {
      next.loop = { ...node.loop, body: rewrite(node.loop.body) };
    }
    if (node.map?.body) {
      next.map = { ...node.map, body: rewrite(node.map.body) };
    }
    if (node.route?.branches) {
      const branches: Record<string, Node> = {};
      for (const [k, b] of Object.entries(node.route.branches)) {
        branches[k] = rewrite(b);
      }
      next.route = {
        ...node.route,
        branches,
        default: node.route.default ? rewrite(node.route.default) : undefined,
      };
    }
    if (node.onError) next.onError = rewrite(node.onError);
    return next;
  }
  return rewrite(orchestration);
}
