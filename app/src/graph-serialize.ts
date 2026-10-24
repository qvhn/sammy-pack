// Graph → orchestration serialization. Extracted verbatim from
// GraphEditor.web.tsx so it can be unit-tested: that file imports
// `@xyflow/react` + its CSS at module scope, which the jest preset can't load.
// This module is deliberately free of any @xyflow/react import — it operates on
// MINIMAL STRUCTURAL shapes (`GraphNodeInput` / `GraphEdgeInput`) that the
// editor's richer `FlowPhaseNode` / `FlowEdge` satisfy structurally, so the
// call sites pass their arrays unchanged.

import { compositeKey, type Node } from './types';

export type EdgeType = 'handoff' | 'parallel' | 'converge';

/**
 * Visual-only edge that draws the loop-back arrow from the last body child to
 * the first. Carried as data.type so the serializer can filter it out.
 */
export type DecorativeEdgeType = 'loop-back';

export type CompositeMeta = {
  name: string;
  lock?: boolean;
  merger?: string;
  description?: string;
};

export type EdgeData = {
  type: EdgeType | DecorativeEdgeType;
  composite?: CompositeMeta;
};

/**
 * Structural subset of a graph node that `serializeGraph` actually reads — only
 * the id, the node `type` (to skip container wrappers), and `parentComposite`.
 * The editor's `FlowPhaseNode` (= `Node<PhaseNodeData>`) is a structural
 * superset, so it's assignable to this without a cast and this module needs no
 * dependency on @xyflow/react.
 */
export type GraphNodeInput = {
  id: string;
  type?: string;
  data?: { parentComposite?: string };
};

/** Structural subset of a graph edge that `serializeGraph` reads. */
export type GraphEdgeInput = {
  source: string;
  target: string;
  data?: EdgeData;
};

/**
 * Recursively walk every named phase in an orchestration and collect them
 * into a flat map. Used for lookups during graph build + serialize, since
 * flattened composites surface their children as top-level graph nodes.
 */
export function collectAllPhases(node: Node, into: Map<string, Node>) {
  if (node.name) into.set(node.name, node);
  for (const key of ['phases', 'parallel', 'converge'] as const) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      for (const child of arr) collectAllPhases(child, into);
    }
  }
  if (node.loop?.body) collectAllPhases(node.loop.body, into);
  // map.body is a single Node; the flattenMap branch surfaces its inner
  // children as clickable graph nodes, so the lookup table needs to know
  // about both the body wrapper and its descendants for the side panel to
  // resolve them. Without this, clicking a phase inside a map container
  // does nothing.
  if (node.map?.body) collectAllPhases(node.map.body, into);
  if (node.route?.branches) {
    for (const branch of Object.values(node.route.branches)) {
      collectAllPhases(branch, into);
    }
    if (node.route.default) collectAllPhases(node.route.default, into);
  }
}

/**
 * Serialize the visual graph (nodes + edges) back into the orchestration's
 * `phases` array.
 *
 * Handles:
 *  - Linear chains of handoff edges.
 *  - Forks (N>1 outgoing same-type non-handoff edges) where all branches
 *    rejoin at a common downstream node — wraps the branches in a
 *    composite phase. If the fork edges carry composite metadata
 *    (from a flattened load), the composite's original name / lock /
 *    merger / description are preserved.
 *  - Atomic composite nodes (phases / subflow / non-flattened
 *    parallel-converge at start/end) pass through unchanged.
 */
export function serializeGraph(
  graphNodes: GraphNodeInput[],
  graphEdges: GraphEdgeInput[],
  orchestration: Node,
):
  | { kind: 'ok'; phases: Node[] }
  | { kind: 'error'; reason: string } {
  if (graphNodes.length === 0) return { kind: 'ok', phases: [] };

  const nodeIds = new Set(graphNodes.map(n => n.id));
  const phaseMap = new Map<string, Node>();
  for (const p of orchestration.phases ?? []) collectAllPhases(p, phaseMap);

  const outgoing = new Map<string, GraphEdgeInput[]>();
  const incoming = new Map<string, GraphEdgeInput[]>();
  for (const n of graphNodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of graphEdges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    // Decorative edges (loop-back, etc.) are visual-only; they don't
    // participate in chain semantics so the serializer ignores them.
    if (e.data?.type === 'loop-back') continue;
    outgoing.get(e.source)!.push(e);
    incoming.get(e.target)!.push(e);
  }

  const roots = graphNodes
    // Container wrappers don't participate in chain flow.
    .filter(n => n.type !== 'container')
    .map(n => n.id)
    .filter(id => (incoming.get(id) ?? []).length === 0);
  if (roots.length !== 1) {
    return {
      kind: 'error',
      reason:
        roots.length === 0
          ? 'Graph has a cycle (no root node).'
          : `Graph has ${roots.length} root nodes — only one entry phase is supported.`,
    };
  }

  function reachable(from: string): Set<string> {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of outgoing.get(cur) ?? []) stack.push(e.target);
    }
    return seen;
  }

  function topoOrder(start: string): string[] {
    const visited = new Set<string>();
    const order: string[] = [];
    function dfs(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      for (const e of outgoing.get(id) ?? []) dfs(e.target);
      order.push(id);
    }
    dfs(start);
    return order.reverse();
  }

  function findJoin(branchStarts: string[]): string | null {
    if (branchStarts.length === 0) return null;
    const reachSets = branchStarts.map(reachable);
    const common = new Set<string>();
    for (const id of reachSets[0]) {
      if (reachSets.every(s => s.has(id))) common.add(id);
    }
    for (const b of branchStarts) common.delete(b);
    if (common.size === 0) return null;
    const order = topoOrder(roots[0]);
    for (const id of order) if (common.has(id)) return id;
    return null;
  }

  const usedNames = new Set<string>(graphNodes.map(n => n.id));
  for (const n of phaseMap.keys()) usedNames.add(n);
  function uniqueName(base: string): string {
    let i = 1;
    let name = `${base}-${i}`;
    while (usedNames.has(name)) {
      i += 1;
      name = `${base}-${i}`;
    }
    usedNames.add(name);
    return name;
  }

  const reachableFromRoot = reachable(roots[0]);
  const unreachable = graphNodes
    // Container nodes are decorative wrappers — no edges connect to them
    // directly, so they're not reachable. Skip them in the unreachable check.
    .filter(n => n.type !== 'container')
    .map(n => n.id)
    .filter(id => !reachableFromRoot.has(id));
  if (unreachable.length > 0) {
    return {
      kind: 'error',
      reason: `${unreachable.length} node(s) disconnected from the chain: ${unreachable.join(', ')}.`,
    };
  }

  const visited = new Set<string>();

  function walk(
    start: string,
    until: string | null,
  ): { kind: 'ok'; phases: Node[] } | { kind: 'error'; reason: string } {
    const result: Node[] = [];
    let cursor: string | null = start;

    while (cursor && cursor !== until) {
      if (visited.has(cursor)) {
        return { kind: 'error', reason: `Cycle detected at "${cursor}".` };
      }

      // If this node is inside a flattened phases/loop container, collect
      // all consecutive siblings inside the same parent and reconstruct the
      // composite. Parallel/converge children are handled by the fork branch
      // below — their incoming edges are fork-typed, not handoff.
      const cursorNode = graphNodes.find(n => n.id === cursor);
      const parentName = cursorNode?.data?.parentComposite;
      const parent = parentName ? phaseMap.get(parentName) : null;
      const parentKind = parent ? compositeKey(parent) : null;
      if (parent && (parentKind === 'phases' || parentKind === 'loop' || parentKind === 'map')) {
        const collected: Node[] = [];
        let groupCursor: string | null = cursor;
        while (groupCursor) {
          if (visited.has(groupCursor)) {
            return { kind: 'error', reason: `Cycle detected at "${groupCursor}".` };
          }
          const cn = graphNodes.find(n => n.id === groupCursor);
          if (cn?.data?.parentComposite !== parentName) break;
          visited.add(groupCursor);
          const cPhase = phaseMap.get(groupCursor);
          if (!cPhase) {
            return {
              kind: 'error',
              reason: `Unknown phase "${groupCursor}" inside group "${parentName}".`,
            };
          }
          collected.push(cPhase);
          const cOuts = outgoing.get(groupCursor) ?? [];
          if (cOuts.length === 0) {
            groupCursor = null;
            break;
          }
          if (cOuts.length > 1) {
            return {
              kind: 'error',
              reason: `Node "${groupCursor}" inside group "${parentName}" has multiple outgoing edges.`,
            };
          }
          const nextCursor: string = cOuts[0].target;
          const nn = graphNodes.find(n => n.id === nextCursor);
          if (nn?.data?.parentComposite !== parentName) {
            // Reached the boundary — next node is outside this group.
            cursor = nextCursor;
            groupCursor = null;
            break;
          }
          groupCursor = nextCursor;
        }
        if (groupCursor === null && collected.length > 0) {
          // last collected has no outgoing edge — chain ends here
          const lastOuts = outgoing.get(collected[collected.length - 1].name) ?? [];
          if (lastOuts.length === 0) {
            // pure end
          }
          if (lastOuts.length === 1) {
            const last = lastOuts[0].target;
            const lastNeighbor = graphNodes.find(n => n.id === last);
            if (lastNeighbor?.data?.parentComposite !== parentName) {
              cursor = last;
            }
          }
        }
        // Build composite phase
        if (parentKind === 'phases') {
          result.push({ ...parent, phases: collected });
        } else if (parentKind === 'map') {
          // Map's body is a single Node by schema. We flatten when it's a
          // phases composite, so reconstruct by writing collected back into
          // body.phases (preserving the body's name + any other fields).
          const innerBody = parent.map?.body;
          if (!innerBody || compositeKey(innerBody) !== 'phases') {
            return {
              kind: 'error',
              reason: `Map "${parent.name}" body is no longer a phases composite — can't merge ${collected.length} child(ren) back.`,
            };
          }
          result.push({
            ...parent,
            map: { ...parent.map!, body: { ...innerBody, phases: collected } },
          });
        } else {
          // loop
          const bodyName = parent.loop?.body?.name ?? `${parent.name}-body`;
          const newBody: Node =
            collected.length === 1
              ? collected[0]
              : { name: bodyName, phases: collected };
          result.push({
            ...parent,
            loop: { ...parent.loop!, body: newBody },
          });
        }
        // cursor was advanced to first node outside the group (or null if chain ended).
        // If chain ended fully (no outgoing from last), return.
        if (collected.length > 0) {
          const lastOuts = outgoing.get(collected[collected.length - 1].name) ?? [];
          // Compare the cursor (a node id/name) to the last collected node's
          // name — not the Node object. Previously this compared a string to a
          // Node (always false), so this "chain ended" early-return was dead.
          if (lastOuts.length === 0 && cursor === collected[collected.length - 1].name) {
            return { kind: 'ok', phases: result };
          }
        }
        continue;
      }

      visited.add(cursor);
      const phase = phaseMap.get(cursor);
      if (!phase) {
        return { kind: 'error', reason: `Unknown phase "${cursor}".` };
      }

      const outs: GraphEdgeInput[] = outgoing.get(cursor) ?? [];

      if (outs.length === 0) {
        result.push(phase);
        return { kind: 'ok', phases: result };
      }

      if (outs.length === 1) {
        const e: GraphEdgeInput = outs[0];
        const t = e.data?.type ?? 'handoff';
        if (t !== 'handoff') {
          return {
            kind: 'error',
            reason: `Lone outgoing edge from "${cursor}" should be "handoff" (got "${t}"). Add a sibling branch or change the type.`,
          };
        }
        result.push(phase);
        cursor = e.target;
        continue;
      }

      // Fork (outs.length > 1).
      const types = new Set(outs.map((o: GraphEdgeInput) => o.data?.type ?? 'handoff'));
      if (types.size > 1) {
        return {
          kind: 'error',
          reason: `Edges from "${cursor}" have mixed types (${[...types].join(', ')}). Use one type for the whole fork.`,
        };
      }
      const forkType = [...types][0] as EdgeType;
      if (forkType === 'handoff') {
        return {
          kind: 'error',
          reason: `"${cursor}" has ${outs.length} outgoing "handoff" edges. Change them to "parallel" or "converge" to define a fork.`,
        };
      }

      const branchStarts = outs.map((o: GraphEdgeInput) => o.target);
      const join = findJoin(branchStarts);
      if (!join) {
        return {
          kind: 'error',
          reason: `Branches from "${cursor}" don't rejoin — every branch must reach a common downstream node.`,
        };
      }

      // Read composite metadata (preserved from a flattened load). All fork edges
      // should agree; we take the first non-empty.
      const compositeMeta = outs.find((o: GraphEdgeInput) => o.data?.composite)?.data
        ?.composite;

      const branches: Node[] = [];
      for (const bStart of branchStarts) {
        const r = walk(bStart, join);
        if (r.kind === 'error') return r;
        if (r.phases.length === 1) {
          branches.push(r.phases[0]);
        } else {
          branches.push({ name: uniqueName('branch'), phases: r.phases });
        }
      }

      const composite: Node = {
        name: compositeMeta?.name ?? uniqueName(`${forkType}-group`),
        [forkType]: branches,
      };
      if (compositeMeta?.lock) composite.lock = true;
      if (forkType === 'converge' && compositeMeta?.merger) {
        composite.merger = compositeMeta.merger;
      }
      if (compositeMeta?.description) composite.description = compositeMeta.description;

      result.push(phase);
      result.push(composite);
      cursor = join;
    }

    return { kind: 'ok', phases: result };
  }

  return walk(roots[0], null);
}
