/**
 * Shared, name-based tree mutations for orchestration `Node`s.
 *
 * All three editor views (Pipeline / Tree / Graph) operate on the same
 * `Node` tree and persist via `onChange(newTree)`. Historically each view
 * reimplemented its own insert/delete/update logic, which let their
 * editing capabilities drift (e.g. the Pipeline view couldn't add children
 * to composites at all). These helpers are the single source of truth for
 * structural edits so the views can share one implementation.
 *
 * Everything here is pure: it returns a new tree and never mutates the
 * input. Nodes are addressed by their unique `name`.
 *
 * Which fields hold child Nodes is NOT decided here. `childNodesOf`
 * (lib/node-walk.ts) is the single, schema-parity-tested answer, and every
 * walker in this module derives from it — see `mapChildNodes` for how. This
 * module used to keep its own list (`phases` / `parallel` / `converge` /
 * `loop` / `map` / `route`), which drifted from the executor's: it never
 * learned `switch.cases` / `switch.default`, `onError` or `onStall.recover`,
 * so a switch node rendered N cases that could not be selected, renamed,
 * deleted or duplicated, and a duplicated subtree kept duplicate names inside
 * them although the executor requires names to be unique.
 */
import { compositeKey, type Node } from '../types';
import { childNodesOf } from './node-walk';
import { collectNodeNames } from './runStatus';

/** The direct child `Node`s of a composite (empty for leaves and for the
 *  string-list composites `agents` / `conversation.participants`, which
 *  carry agent PATHS, not nodes). `childNodesOf` verbatim, minus any
 *  nullish array slot a half-edited tree may hold. */
export function childNodes(node: Node): Node[] {
  return childNodesOf(node).filter(Boolean);
}

/**
 * Rebuild `node` with each direct child `Node` replaced by `f(child)`, or
 * REMOVED from its slot when `f` returns null. Leaves and string-list
 * composites pass through unchanged, and a node none of whose children
 * changed comes back as the SAME reference.
 *
 * Derived from `childNodesOf` by IDENTITY rather than from a table of child
 * paths: the set of children is whatever that walker says, and this finds
 * each one wherever it sits in the node — an array slot, a keyed branch /
 * case, a single body — and rebuilds just that slot. There is no second list
 * of paths here to go stale, which is how the previous one did.
 *
 * Removal per slot: an array child is filtered out; a keyed (route branch /
 * switch case) or single-body (loop / map / default / onError /
 * onStall.recover) child drops its key, which serialises identically to the
 * explicit `undefined` the old per-kind code left behind — the validator
 * surfaces a body-less loop / map / switch the same way it always has.
 */
function mapChildNodes(node: Node, f: (child: Node) => Node | null): Node {
  const kids = new Set<unknown>(childNodesOf(node).filter(Boolean));
  if (kids.size === 0) return node;

  // Rebuild `value`, swapping any child found at or beneath it. Children are
  // never entered (their own subtrees belong to `f`), and a value with no
  // changed child beneath it is returned as the same reference, so unrelated
  // structure (a JSON-schema `input`, a `retry` policy) is never cloned.
  const swap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (kids.has(value)) return f(value as Node) ?? REMOVED;
    let changed = false;
    if (Array.isArray(value)) {
      const next: unknown[] = [];
      for (const v of value) {
        const sv = swap(v);
        if (sv !== v) changed = true;
        if (sv !== REMOVED) next.push(sv);
      }
      return changed ? next : value;
    }
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = swap(v);
      if (sv !== v) changed = true;
      if (sv !== REMOVED) next[k] = sv;
    }
    return changed ? next : value;
  };

  // A node is never its own child, so swapping the node walks its fields.
  return swap(node) as Node;
}

/** Sentinel `mapChildNodes` threads through its rebuild for a child its
 *  callback removed — never escapes the function. */
const REMOVED: unique symbol = Symbol('removed');

/** True when `node` is an array composite — the only kind a SIBLING can be
 *  spliced into. Every other child slot (a body, a branch, a case, a
 *  recovery phase) holds exactly one node per key. */
function isArrayComposite(
  node: Node,
): 'phases' | 'parallel' | 'converge' | null {
  const k = compositeKey(node);
  return k === 'phases' || k === 'parallel' || k === 'converge' ? k : null;
}

/** Depth-first find of the first node named `name` (names are unique). */
export function findNodeByName(root: Node, name: string): Node | null {
  if (root.name === name) return root;
  for (const c of childNodes(root)) {
    const found = findNodeByName(c, name);
    if (found) return found;
  }
  return null;
}

/** Replace the node named `name` with `updater(node)`, anywhere in the tree. */
export function updateNodeByName(
  root: Node,
  name: string,
  updater: (n: Node) => Node,
): Node {
  function rec(n: Node): Node {
    if (n.name === name) return updater(n);
    return mapChildNodes(n, rec);
  }
  return rec(root);
}

/** Remove the node named `name` from its parent composite, anywhere in the
 *  tree — an array child, a route branch / switch case, or the sole body of
 *  a loop / map / onError / onStall (which leaves it body-less; the validator
 *  surfaces that). The common case is removing array children. */
export function deleteNodeByName(root: Node, name: string): Node {
  function rec(n: Node): Node {
    return mapChildNodes(n, c => (c.name === name ? null : rec(c)));
  }
  return rec(root);
}

/** Append `child` to the array of the composite named `parentName`. Only
 *  array composites (phases / parallel / converge) take children this way;
 *  other kinds (loop/map have one body, route/conversation/agents have
 *  their own shapes) are unchanged. */
export function addChildPhase(root: Node, parentName: string, child: Node): Node {
  return updateNodeByName(root, parentName, parent => {
    const k = compositeKey(parent);
    if (k === 'phases' || k === 'parallel' || k === 'converge') {
      return { ...parent, [k]: [...((parent[k] as Node[]) ?? []), child] };
    }
    return parent;
  });
}

/** True when the composite named `parentName` accepts appended children
 *  (i.e. it's a phases/parallel/converge array). */
export function acceptsChildren(node: Node): boolean {
  const k = compositeKey(node);
  return k === 'phases' || k === 'parallel' || k === 'converge';
}

/**
 * Add `child` into the node named `parentName`, making that node a parent if
 * it isn't one yet — so you can "add a child to any phase," not just to
 * phases that already have children.
 *
 * - array composite (phases/parallel/converge) → append `child`.
 * - leaf (agent/subflow/a2a/code/bodyless) → PROMOTE it to a `phases` group:
 *   the original node (its body + all decorators) becomes the first child so
 *   nothing is lost, and `child` is added after it. The group keeps the
 *   original's name + description.
 * - other composites (loop/map/route/conversation) → unchanged here; those
 *   have their own structured adders (set body, add branch, add participant).
 */
export function addOrPromoteChild(root: Node, parentName: string, child: Node): Node {
  return updateNodeByName(root, parentName, parent => {
    const k = compositeKey(parent);
    if (k === 'phases' || k === 'parallel' || k === 'converge') {
      return { ...parent, [k]: [...((parent[k] as Node[]) ?? []), child] };
    }
    if (!k) {
      // Leaf → promote. Move the whole original (body + decorators) onto a
      // first child; the group inherits name + description only.
      const firstChild: Node = { ...parent, name: `${parent.name}-1` };
      delete (firstChild as { description?: string }).description;
      const group: Node = { name: parent.name, phases: [firstChild, child] };
      if (parent.description) group.description = parent.description;
      return group;
    }
    return parent;
  });
}

function insertSibling(
  root: Node,
  refName: string,
  newPhase: Node,
  where: 'before' | 'after',
): Node {
  function rec(n: Node): Node {
    const k = isArrayComposite(n);
    if (k) {
      const cur = (n[k] as Node[]) ?? [];
      const idx = cur.findIndex(c => c?.name === refName);
      if (idx >= 0) {
        const at = where === 'after' ? idx + 1 : idx;
        return {
          ...n,
          [k]: [...cur.slice(0, at), newPhase, ...cur.slice(at)],
        };
      }
    }
    // Not a direct child here — keep looking through EVERY child slot (an
    // array composite's `onError` holds a subtree too), not just the array.
    return mapChildNodes(n, rec);
  }
  return rec(root);
}

/** Insert `newPhase` immediately before the node named `refName` within its
 *  containing array composite. */
export const insertSiblingBefore = (root: Node, refName: string, p: Node): Node =>
  insertSibling(root, refName, p, 'before');

/** Insert `newPhase` immediately after the node named `refName`. */
export const insertSiblingAfter = (root: Node, refName: string, p: Node): Node =>
  insertSibling(root, refName, p, 'after');

/** A collision-free phase name derived from `base` (base, base-2, base-3…). */
export function uniqueName(root: Node, base: string): string {
  const names = new Set(collectNodeNames(root));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Move the node named `name` to be a child of the array composite named
 * `toParentName`, at `index` (clamped to the array bounds). Delete-then-insert,
 * so reordering within the same parent works and `index` is the FINAL position.
 *
 * No-op (returns `root` unchanged) when: the node is missing, name ===
 * toParentName, the target isn't an array composite, or the target lives inside
 * the node's own subtree (which would create a cycle).
 */
export function moveNode(
  root: Node,
  name: string,
  toParentName: string,
  index: number,
): Node {
  if (name === toParentName) return root;
  const node = findNodeByName(root, name);
  if (!node) return root;
  // Refuse to move a node into its own descendant.
  if (findNodeByName(node, toParentName)) return root;
  const target = findNodeByName(root, toParentName);
  if (!target || !acceptsChildren(target)) return root;
  const without = deleteNodeByName(root, name);
  return updateNodeByName(without, toParentName, parent => {
    const k = compositeKey(parent);
    if (k === 'phases' || k === 'parallel' || k === 'converge') {
      const arr = [...((parent[k] as Node[]) ?? [])];
      const at = Math.max(0, Math.min(index, arr.length));
      arr.splice(at, 0, node);
      return { ...parent, [k]: arr };
    }
    return parent;
  });
}

/**
 * Insert a deep copy of the node named `name` immediately after it, with every
 * node in the copied subtree given a collision-free name (so refs stay valid
 * and the validator's name-uniqueness invariant holds). No-op if `name` isn't
 * found.
 */
export function duplicateNode(root: Node, name: string): Node {
  const node = findNodeByName(root, name);
  if (!node) return root;
  const copy = dedupeSubtreeNames(clone(node), root);
  return insertSiblingAfter(root, name, copy);
}

/**
 * Wrap the node named `name` in a fresh single-child composite of `kind` — the
 * original node becomes the child/body, the wrapper gets a unique name. Only
 * the kinds that are valid with one child: `phases` (group), `loop`, `map`.
 * (`parallel`/`converge` require ≥2 children, so wrapping those is a
 * multi-select op, not this one.)
 */
export function wrapInComposite(
  root: Node,
  name: string,
  kind: 'phases' | 'loop' | 'map',
): Node {
  return updateNodeByName(root, name, node => {
    const wrapperName = uniqueName(root, `${name}-${kind}`);
    if (kind === 'loop')
      return { name: wrapperName, loop: { body: node, maxIterations: 3 } };
    if (kind === 'map')
      return { name: wrapperName, map: { over: '${items}', body: node } };
    return { name: wrapperName, phases: [node] };
  });
}

/** Structured deep clone (JSON fallback for runtimes without structuredClone). */
function clone<T>(v: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(v)
    : (JSON.parse(JSON.stringify(v)) as T);
}

/** Rename every node in `subtree` to a name not already used in `root` (or
 *  earlier in the subtree) — so a duplicated subtree carries no name
 *  collisions, root-down. */
function dedupeSubtreeNames(subtree: Node, root: Node): Node {
  const taken = new Set(collectNodeNames(root));
  const uniq = (base: string): string => {
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  };
  function rec(n: Node): Node {
    const nm = uniq(n.name);
    taken.add(nm);
    return mapChildNodes({ ...n, name: nm }, rec);
  }
  return rec(subtree);
}

/**
 * Insert `newPhase` immediately after the selected node, so the user's
 * selection drives where an insertion lands rather than everything appending
 * to the root.
 *
 * Lives in a shared module rather than inside `GraphEditor.web.tsx`, because
 * a component-internal function cannot be imported by its own unit test. That
 * pushes the test into copying the logic to a fixture and asserting against
 * the copy, which cannot catch drift: deleting the real implementation leaves
 * such a test green.
 */
export function insertPhaseAfter(
  orchestration: Node,
  selectedNodeId: string | null,
  newPhase: Node,
): Node {
  if (!selectedNodeId) {
    // No selection — append to root (existing behavior).
    return {
      ...orchestration,
      phases: [...(orchestration.phases ?? []), newPhase],
    };
  }

  let inserted = false;

  function visit(node: Node): Node {
    if (inserted) return node;
    const k = isArrayComposite(node);
    if (k) {
      const arr = (node[k] as Node[]) ?? [];
      // Is the selected node a direct child here? If yes, splice in
      // newPhase immediately after it and stop.
      const idx = arr.findIndex(p => p?.name === selectedNodeId);
      if (idx !== -1) {
        inserted = true;
        return {
          ...node,
          [k]: [...arr.slice(0, idx + 1), newPhase, ...arr.slice(idx + 1)],
        };
      }
    }
    // Otherwise recurse into children — selection may be deeper: a map /
    // loop body, a route branch, a switch case, an onError or onStall.recover
    // subtree. The walk used to spell out three of those slots by hand and
    // so could not reach a selection inside a switch case; it now goes
    // wherever `childNodesOf` says a child lives.
    return mapChildNodes(node, visit);
  }

  const result = visit(orchestration);

  // Selection stale / not found — fall back to root append so the user
  // still gets a node out of their click rather than nothing.
  if (!inserted) {
    return {
      ...orchestration,
      phases: [...(orchestration.phases ?? []), newPhase],
    };
  }

  return result;
}
