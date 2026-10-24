/**
 * The SINGLE source of truth for "which fields of a `Node` hold child Nodes".
 *
 * Why this module exists (the drift story): the executor, the validator, and
 * the run-status derivation each grew their OWN hand-rolled child walk — and
 * they drifted. `collectSandboxesInto` / `collectTools` missed `switch` cases
 * (so a sandbox declared above a `switch` silently didn't reach the case-body
 * leaves, and tools inside cases went unvalidated); `orchestrationUsesCodeRun`
 * knew about `switch` but not `onStall.recover` (so a `code.run` buried in a
 * stall-recovery phase dodged the run-start preflight). Every new composite
 * kind had to be added to N walkers by hand, and forgetting one produced no
 * error — just a silent hole in whatever policy/validation that walker fed.
 *
 * `childNodesOf` enumerates every DIRECT child `Node` of a node, exactly once:
 *
 *   - `phases[]` / `parallel[]` / `converge[]`  — the array composites
 *   - `loop.body` / `map.body`                  — the single-body composites
 *   - `route.branches{}` + `route.default`      — keyed branches + fallback
 *   - `switch.cases{}` + `switch.default`       — keyed cases + fallback
 *   - `onError`                                 — the recovery branch
 *   - `onStall.recover`                         — the stall fix-up phase
 *
 * Deliberately NOT children (they are references, not inline node bodies):
 *   - `subflow`                    — an orchestration NAME, resolved at
 *                                    dispatch time; a static walk can't see
 *                                    inside it (callers that need to descend —
 *                                    e.g. `maxStallTimeoutInSubtree` — resolve
 *                                    it themselves against the registry)
 *   - `agents[]`                   — agent PATH strings (the executor
 *                                    synthesizes child nodes at dispatch)
 *   - `conversation.participants`  — agent PATH strings, same reason
 *
 * Walkers keep their own accumulation logic and recurse through this. A
 * parity test (node-walk.test.ts) derives the child-carrying properties from
 * the published orchestration JSON schema and asserts this function covers
 * each — so a future composite kind can't be silently missed again.
 */

import type { Node } from '../types';

export function childNodesOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const arr of [node.phases, node.parallel, node.converge] as (
    | Node[]
    | undefined
  )[]) {
    if (Array.isArray(arr)) for (const child of arr) out.push(child);
  }
  if (node.loop?.body) out.push(node.loop.body);
  if (node.map?.body) out.push(node.map.body);
  if (node.route?.branches) {
    for (const b of Object.values(node.route.branches)) out.push(b);
    if (node.route.default) out.push(node.route.default);
  }
  if (node.switch?.cases) {
    for (const b of Object.values(node.switch.cases)) out.push(b);
    if (node.switch.default) out.push(node.switch.default);
  }
  if (node.onError) out.push(node.onError);
  if (node.onStall?.recover) out.push(node.onStall.recover);
  return out;
}
