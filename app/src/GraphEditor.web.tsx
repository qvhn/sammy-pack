import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  compositeChildCount,
  compositeKey,
  type CompositeKey,
  type Node,
} from './types';
import {
  collectAllPhases,
  serializeGraph,
  type CompositeMeta,
  type EdgeData,
  type EdgeType,
} from './graph-serialize';
import { STATUS_COLOR, type NodeRunStatus } from './lib/runStatus';
import { Tooltip } from './lib/Tooltip';
import {
  complexityDescription,
  complexityLabel,
  computeComplexity,
  TIER_COLOR,
} from './lib/complexity';
import {
  acceptsChildren,
  addChildPhase,
  insertPhaseAfter,
  uniqueName,
  wrapInComposite,
} from './lib/orchestrationMutate';
import type { GraphEditorProps } from './GraphEditorProps';

/** Kinds that can be added as a child INTO an array composite from the
 *  side panel's "Add child" row. */
type AddChildKind = 'phase' | 'agents' | 'phases' | 'parallel' | 'converge' | 'loop';

// Vertical layout: main chain flows top → bottom.
// Sequential phases are stacked at LANE_X with ROW_SPACING between them.
// Flattened parallel/converge branches spread horizontally inside a container.
const LANE_X = 320;
const TOP_Y = 60;
const ROW_SPACING = 220;
const BRANCH_SPACING = 240;

// Alignment snap tolerance (px). Used both for the magenta guide overlay
// during a drag and for snapping a node onto a neighbour's centerline when
// it's released within this distance, so the guide "clicks" into place.
const SNAP_PX = 6;

// dataTransfer key for drag-from-palette. The palette item writes the node
// kind under this MIME type on dragStart; the canvas onDrop reads it back to
// know what to create at the drop point (the drag-a-shape-in gesture).
const PALETTE_DND_MIME = 'application/sammy-node-kind';
type PaletteDragKind =
  | 'phase'
  | 'agents'
  | 'phases'
  | 'parallel'
  | 'converge'
  | 'loop'
  | 'conversation'
  | 'route';

// Container sizing for flattened composites. Children are positioned RELATIVE
// to the container at (CONTAINER_PADDING + j * (CHILD_WIDTH + CHILD_GAP),
// CONTAINER_PADDING_TOP).
const CHILD_WIDTH = 200;
const CHILD_HEIGHT = 100;
const CHILD_GAP = 50;
const CONTAINER_PADDING = 24;
const CONTAINER_PADDING_TOP = 38;
const CONTAINER_PADDING_BOTTOM = 24;

// Prop contract lives in GraphEditorProps so the native stub (GraphEditor.tsx)
// and this web implementation share one source of truth and can't drift.
type Props = GraphEditorProps;

type PhaseNodeData = {
  phase: Node;
  composite: CompositeKey | null;
  isSubflow: boolean;
  /** name of the parent composite if this graph node was flattened out of one */
  parentComposite?: string;
  /** True when buildGraph rendered an atomic CompositeNodeView for a
   *  composite that COULD have flattened (phases ≥ 2, map with phases body,
   *  loop in middle) — collapsed by the user. The atomic view shows an
   *  "Expand" button only in this case. */
  isCollapsedFlatten?: boolean;
  /** True when this phase is the subject of at least one hard
   *  validation error in the current run. Rendered as a red border +
   *  ⚠ badge so the Graph view matches the inline marker the
   *  Pipeline and Tree views show. */
  hasError?: boolean;
  /** First error message for this phase — used as the title attribute
   *  on the ⚠ badge so the user gets a native browser tooltip on
   *  hover. */
  errorMessage?: string;
  /** Live run status — drives status border / glow / pulse + a status dot. */
  runStatus?: NodeRunStatus;
};

type FlowPhaseNode = FlowNode<PhaseNodeData>;
type FlowEdge = Edge<EdgeData>;

const EDGE_COLOR: Record<EdgeType, string> = {
  handoff: '#9ca3af',
  parallel: '#059669',
  converge: '#d97706',
};

// Per-composite collapse state — backed by localStorage so a user who's
// chosen to keep a heavy composite as a single pill keeps that choice
// across reloads. The set holds names of composites the user explicitly
// collapsed back; the default (absence) means "flatten if applicable".
const COLLAPSED_KEY = (name: string) => `sammy.graph.flatten-collapsed.${name}`;
function loadCollapsedSet(orchestration: Node): Set<string> {
  const out = new Set<string>();
  try {
    if (typeof localStorage === 'undefined') return out;
    function visit(node: Node) {
      if (node.name && localStorage.getItem(COLLAPSED_KEY(node.name)) === '1') {
        out.add(node.name);
      }
      for (const key of ['phases', 'parallel', 'converge'] as const) {
        const arr = node[key];
        if (Array.isArray(arr)) for (const c of arr) visit(c);
      }
      if (node.map?.body) visit(node.map.body);
      if (node.loop?.body) visit(node.loop.body);
    }
    visit(orchestration);
  } catch {
    /* ignore */
  }
  return out;
}
function persistCollapsed(name: string, val: boolean) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (val) localStorage.setItem(COLLAPSED_KEY(name), '1');
    else localStorage.removeItem(COLLAPSED_KEY(name));
  } catch {
    /* ignore */
  }
}

/** Toggle callback handed to ContainerNodeView + CompositeNodeView via
 *  context so they can flip a composite's flatten-or-collapse state
 *  without prop-drilling through ReactFlow's node-data. */
const CollapseCtx = createContext<(name: string) => void>(() => {});

// Inline rename. Each node renderer reads `renamingId` to decide
// whether to show its label as an <input>; on commit it calls
// `commit(oldName, newName)`, on cancel it calls `cancel()`.
const RenameCtx = createContext<{
  renamingId: string | null;
  commit: (oldName: string, newName: string) => void;
  cancel: () => void;
}>({ renamingId: null, commit: () => {}, cancel: () => {} });

// Canvas-A — hover-arrow quick-add. The hovered node renders two
// directional handles (up/down); clicking either spawns a connected
// phase in that direction. Tracked at the GraphInner level
// (onNodeMouseEnter/Leave) and pushed through context so the
// renderers can paint the handles without prop drilling.
const HoverCtx = createContext<{
  hoveredId: string | null;
  onAddAbove: (nodeId: string) => void;
  onAddBelow: (nodeId: string) => void;
}>({ hoveredId: null, onAddAbove: () => {}, onAddBelow: () => {} });

// Canvas-A — mid-edge "+" insert. Edges that hover their source ID
// render a "+" button at their midpoint; clicking it inserts a new
// phase between source and target (= insertPhaseAfter(source)).
const EdgeInsertCtx = createContext<{
  hoveredEdgeId: string | null;
  onInsert: (sourceId: string) => void;
}>({ hoveredEdgeId: null, onInsert: () => {} });

const COMPOSITE_COLOR: Record<CompositeKey, string> = {
  phases: '#2563eb',
  parallel: '#059669',
  converge: '#d97706',
  agents: '#6b7280',
  loop: '#0891b2',
  conversation: '#e11d48',
  route: '#65a30d',
  switch: '#0d9488',
  map: '#7c3aed',
};

function edgeForType(
  source: string,
  target: string,
  type: EdgeType,
  composite?: CompositeMeta,
  id?: string,
  orientation: 'tb' | 'lr' = 'tb',
): FlowEdge {
  const label = composite ? `${type} · ${composite.name}` : type;
  return {
    id: id ?? `e-${source}-${target}-${type}`,
    source,
    target,
    // Pin handles so xyflow doesn't auto-route forward edges through the
    // side handles (which are reserved for loop-back). Orientation switches
    // between vertical chain (default) and horizontal row (LR — used inside
    // bundled-phases / map containers).
    sourceHandle: orientation === 'lr' ? 'right-out' : 'bottom',
    targetHandle: orientation === 'lr' ? 'left-in' : 'top',
    type: 'insertable',
    label,
    labelStyle: { fontSize: 10, fill: EDGE_COLOR[type], fontWeight: 600 },
    labelBgStyle: { fill: '#f9fafb' },
    style: {
      stroke: EDGE_COLOR[type],
      strokeWidth: type === 'handoff' ? 1.5 : 2,
      strokeDasharray: type === 'converge' ? '6 4' : undefined,
    },
    data: composite ? { type, composite } : { type },
  };
}


/**
 * Insert `newPhase` immediately after the phase named `selectedNodeId`,
 * walking the orchestration tree to find its containing array (root
 * `phases`, or nested `parallel` / `converge` / `phases` inside a
 * composite). If selectedNodeId is null or not found, append to root —
 * the documented fallback for a caller with no selection.
 *
 * Why this matters: a palette / "+ X" handler that does
 * `phases: [...phases, newPhase]` appends to root regardless of what the
 * user has selected, so clicking "Phase" with `architect` selected lands
 * the new phase at the end of the root list (after `reviewer`), violating
 * selection-as-intent. This helper is the single dispatcher every add
 * handler goes through, so the user's selection drives where insertion
 * lands.
 *
 * Note: only the JSON ordering is fixed here — visual layout
 * positioning is left to the caller. The current callers position new
 * nodes at `[LANE_X, TOP_Y + phases.length * ROW_SPACING]` (bottom), so
 * the new node appears at the right index in the data model but may still
 * render below the selected node.
 */

// Mirror of insertPhaseAfter. Walks the tree, finds the parent array
// containing the reference node, splices in newPhase at the reference
// node's index (so it lands BEFORE it). Used by Canvas-A's upward
// hover-arrow.
function insertPhaseBefore(
  orchestration: Node,
  referenceNodeId: string | null,
  newPhase: Node,
): Node {
  if (!referenceNodeId) {
    return {
      ...orchestration,
      phases: [newPhase, ...(orchestration.phases ?? [])],
    };
  }
  let inserted = false;
  function visit(node: Node): Node {
    if (inserted) return node;
    const next = { ...node };
    for (const key of ['phases', 'parallel', 'converge'] as const) {
      const arr = next[key];
      if (!Array.isArray(arr)) continue;
      const idx = arr.findIndex(p => p.name === referenceNodeId);
      if (idx !== -1) {
        next[key] = [
          ...arr.slice(0, idx),
          newPhase,
          ...arr.slice(idx),
        ];
        inserted = true;
        return next;
      }
      const recursed: Node[] = [];
      for (const child of arr) {
        recursed.push(inserted ? child : visit(child));
      }
      next[key] = recursed;
      if (inserted) return next;
    }
    if (next.map?.body) {
      const updated = visit(next.map.body);
      if (inserted) next.map = { ...next.map, body: updated };
    }
    if (next.loop?.body) {
      const updated = visit(next.loop.body);
      if (inserted) next.loop = { ...next.loop, body: updated };
    }
    if (next.route?.branches) {
      const updatedBranches: Record<string, Node> = {};
      for (const [k, v] of Object.entries(next.route.branches)) {
        updatedBranches[k] = inserted ? (v as Node) : visit(v as Node);
      }
      if (inserted) next.route = { ...next.route, branches: updatedBranches };
    }
    return next;
  }
  const result = visit(orchestration);
  if (!inserted) {
    return {
      ...orchestration,
      phases: [newPhase, ...(orchestration.phases ?? [])],
    };
  }
  return result;
}

/**
 * Mutate a phase anywhere in the tree by name. Returns a new tree.
 * `updater` returns the replacement node, or `null` to delete.
 */
function mutatePhaseByName(
  node: Node,
  name: string,
  updater: (phase: Node) => Node | null,
): Node | null {
  if (node.name === name) return updater(node);
  const next = { ...node };
  for (const key of ['phases', 'parallel', 'converge'] as const) {
    const arr = next[key];
    if (Array.isArray(arr)) {
      const mapped: Node[] = [];
      for (const child of arr) {
        const updated = mutatePhaseByName(child, name, updater);
        if (updated !== null) mapped.push(updated);
      }
      (next as Record<string, unknown>)[key] = mapped;
    }
  }
  // Single-Node bodies (map / loop) and route branches must recurse too —
  // otherwise edits to phases inside an expanded map container are dropped
  // on save. Deletion of these inner phases is NOT supported here (the
  // body slot is required); the updater returning null is treated as a
  // no-op for these slots.
  if (next.map?.body) {
    const updated = mutatePhaseByName(next.map.body, name, updater);
    if (updated !== null) {
      next.map = { ...next.map, body: updated };
    }
  }
  if (next.loop?.body) {
    const updated = mutatePhaseByName(next.loop.body, name, updater);
    if (updated !== null) {
      next.loop = { ...next.loop, body: updated };
    }
  }
  if (next.route?.branches) {
    const branches: Record<string, Node> = {};
    for (const [key, branch] of Object.entries(next.route.branches)) {
      const updated = mutatePhaseByName(branch, name, updater);
      if (updated !== null) branches[key] = updated;
    }
    next.route = { ...next.route, branches };
    if (next.route.default) {
      const updated = mutatePhaseByName(next.route.default, name, updater);
      if (updated !== null) next.route.default = updated;
    }
  }
  return next;
}

function updateOrchestrationPhase(
  orchestration: Node,
  name: string,
  updater: (phase: Node) => Node | null,
): Node {
  const phases = (orchestration.phases ?? [])
    .map(p => mutatePhaseByName(p, name, updater))
    .filter((p): p is Node => p !== null);
  return { ...orchestration, phases };
}

/**
 * Build the graph from the orchestration schema.
 *
 * Flattening rules (v1):
 *  - Top-level `parallel` / `converge` composites that have BOTH a predecessor
 *    AND a successor in the parent chain are expanded: each child becomes its
 *    own graph node, with typed edges from the predecessor and handoff edges
 *    to the successor. Composite metadata (name / lock / merger / description)
 *    rides along on the fork edges so it survives the round-trip.
 *  - Composites at position 0 or N-1, and `phases` composites at any position,
 *    stay atomic (a single node with a badge).
 *  - Nested composites are never flattened.
 */
function buildGraph(
  orchestration: Node,
  collapsedSet: Set<string> = new Set(),
): {
  nodes: FlowPhaseNode[];
  edges: FlowEdge[];
} {
  const phases = orchestration.phases ?? [];
  const layout = orchestration._layout ?? {};
  const nodes: FlowPhaseNode[] = [];
  const edges: FlowEdge[] = [];
  let tails: string[] = [];

  /**
   * Build a graph node from a Phase + an explicit position. Callers are
   * responsible for picking the position (consulting _layout themselves if
   * they want to honor stored positions — we used to read layout in here too,
   * but that bypassed the cursorY clamping we do for atomic phases after a
   * tall container).
   */
  function makeNode(
    phase: Node,
    position: { x: number; y: number },
    parentComposite?: string,
  ): FlowPhaseNode {
    const composite = compositeKey(phase);
    return {
      id: phase.name,
      type: composite ? 'composite' : phase.subflow ? 'subflow' : 'phase',
      position,
      data: {
        phase,
        composite,
        isSubflow: !!phase.subflow,
        parentComposite,
      },
    };
  }

  // Track running y position so phases AFTER tall containers don't overlap.
  let cursorY = TOP_Y;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const composite = compositeKey(phase);
    const flattenable =
      (composite === 'parallel' || composite === 'converge') &&
      i > 0 &&
      i < phases.length - 1;
    // Sequential composites (phases / map) can flatten at any position —
    // they don't need a predecessor or successor to read sensibly. The
    // i>0 && i<N-1 guard is only meaningful for fork composites
    // (parallel / converge), which would have nothing to fork-into at
    // the ends. Loop keeps the predecessor-and-successor requirement
    // since its loop-back arrow assumes both directions exist.
    const isUserCollapsed = collapsedSet.has(phase.name);
    const couldFlattenPhases =
      composite === 'phases' && (phase.phases?.length ?? 0) >= 2;
    const couldFlattenLoop =
      composite === 'loop' && i > 0 && i < phases.length - 1;
    // Maps whose body is itself a phases composite expand inline like
    // flattenPhases — same L→R container, children come from the map
    // body's phases. (Atomic-body maps stay collapsed.)
    const couldFlattenMap =
      composite === 'map' &&
      !!phase.map?.body &&
      compositeKey(phase.map.body) === 'phases' &&
      (phase.map.body.phases?.length ?? 0) >= 1;
    const flattenPhases = couldFlattenPhases && !isUserCollapsed;
    const flattenLoop = couldFlattenLoop && !isUserCollapsed;
    const flattenMap = couldFlattenMap && !isUserCollapsed;
    const couldFlatten =
      couldFlattenPhases || couldFlattenLoop || couldFlattenMap;

    if (flattenable) {
      const children = phase[composite] as Node[];
      const meta: CompositeMeta = {
        name: phase.name,
        lock: phase.lock,
        merger: phase.merger,
        description: phase.description,
      };
      const childIds: string[] = [];
      const total = children.length;

      // Container box. Sized to fit the children with padding. Stored layout
      // remembers the container's absolute position; auto-position centers it
      // on LANE_X at this row.
      const containerWidth =
        CONTAINER_PADDING * 2 + total * CHILD_WIDTH + (total - 1) * CHILD_GAP;
      const containerHeight =
        CONTAINER_PADDING_TOP + CHILD_HEIGHT + CONTAINER_PADDING_BOTTOM;
      const groupStored = layout[phase.name];
      const groupX = groupStored
        ? groupStored[0]
        : LANE_X + CHILD_WIDTH / 2 - containerWidth / 2;
      const groupY = groupStored
        ? Math.max(groupStored[1], cursorY)
        : cursorY;

      nodes.push({
        id: phase.name,
        type: 'container',
        position: { x: groupX, y: groupY },
        // xyflow uses style.width / style.height for parent sizing
        style: { width: containerWidth, height: containerHeight },
        data: { phase, composite, isSubflow: false },
        selectable: true,
        // Parent node renders below children automatically; pin z-index for clarity
        zIndex: -1,
      } as FlowPhaseNode);

      children.forEach((child, j) => {
        const xRel =
          CONTAINER_PADDING + j * (CHILD_WIDTH + CHILD_GAP);
        const yRel = CONTAINER_PADDING_TOP;
        nodes.push({
          ...makeNode(child, { x: xRel, y: yRel }, phase.name),
          parentId: phase.name,
          extent: 'parent',
        } as FlowPhaseNode);
        childIds.push(child.name);
        for (const t of tails) {
          edges.push(edgeForType(t, child.name, composite, meta));
        }
      });
      tails = childIds;
      cursorY = groupY + containerHeight + 80;
    } else if (flattenPhases) {
      // Horizontal container — children laid out left-to-right with handoff
      // edges between siblings using right-out → left-in handles. External
      // entry enters children[0] via its top handle (from above), external
      // exit leaves children[last] via its bottom handle (downward), so the
      // outer chain stays top-to-bottom while the bundled phases read L→R.
      const children = phase.phases!;
      const total = children.length;
      const containerWidth =
        CONTAINER_PADDING * 2 + total * CHILD_WIDTH + (total - 1) * CHILD_GAP;
      const containerHeight =
        CONTAINER_PADDING_TOP + CHILD_HEIGHT + CONTAINER_PADDING_BOTTOM;
      const groupStored = layout[phase.name];
      const groupX = groupStored
        ? groupStored[0]
        : LANE_X + CHILD_WIDTH / 2 - containerWidth / 2;
      const groupY = groupStored
        ? Math.max(groupStored[1], cursorY)
        : cursorY;

      nodes.push({
        id: phase.name,
        type: 'container',
        position: { x: groupX, y: groupY },
        style: { width: containerWidth, height: containerHeight },
        data: { phase, composite, isSubflow: false },
        selectable: true,
        zIndex: -1,
      } as FlowPhaseNode);

      children.forEach((child, j) => {
        const xRel = CONTAINER_PADDING + j * (CHILD_WIDTH + CHILD_GAP);
        const yRel = CONTAINER_PADDING_TOP;
        nodes.push({
          ...makeNode(child, { x: xRel, y: yRel }, phase.name),
          parentId: phase.name,
          extent: 'parent',
        } as FlowPhaseNode);
      });
      for (let j = 0; j < total - 1; j++) {
        edges.push(
          edgeForType(
            children[j].name,
            children[j + 1].name,
            'handoff',
            undefined,
            undefined,
            'lr',
          ),
        );
      }
      for (const t of tails) {
        edges.push(edgeForType(t, children[0].name, 'handoff'));
      }
      tails = [children[total - 1].name];
      cursorY = groupY + containerHeight + 80;
    } else if (flattenMap) {
      // Same LR layout as flattenPhases, but the children come from the
      // map's body (which must itself be a `phases` composite with ≥1
      // children — the common pattern for fan-out-over-array QA suites).
      // Children's parentComposite points at the OUTER map node so the
      // serializer can reconstruct `phase.map.body.phases = collected`.
      const innerBody = phase.map!.body;
      const children = innerBody.phases!;
      const total = children.length;
      const containerWidth =
        CONTAINER_PADDING * 2 + total * CHILD_WIDTH + (total - 1) * CHILD_GAP;
      const containerHeight =
        CONTAINER_PADDING_TOP + CHILD_HEIGHT + CONTAINER_PADDING_BOTTOM;
      const groupStored = layout[phase.name];
      const groupX = groupStored
        ? groupStored[0]
        : LANE_X + CHILD_WIDTH / 2 - containerWidth / 2;
      const groupY = groupStored
        ? Math.max(groupStored[1], cursorY)
        : cursorY;

      nodes.push({
        id: phase.name,
        type: 'container',
        position: { x: groupX, y: groupY },
        style: { width: containerWidth, height: containerHeight },
        data: { phase, composite, isSubflow: false },
        selectable: true,
        zIndex: -1,
      } as FlowPhaseNode);

      children.forEach((child, j) => {
        const xRel = CONTAINER_PADDING + j * (CHILD_WIDTH + CHILD_GAP);
        const yRel = CONTAINER_PADDING_TOP;
        nodes.push({
          ...makeNode(child, { x: xRel, y: yRel }, phase.name),
          parentId: phase.name,
          extent: 'parent',
        } as FlowPhaseNode);
      });
      for (let j = 0; j < total - 1; j++) {
        edges.push(
          edgeForType(
            children[j].name,
            children[j + 1].name,
            'handoff',
            undefined,
            undefined,
            'lr',
          ),
        );
      }
      for (const t of tails) {
        edges.push(edgeForType(t, children[0].name, 'handoff'));
      }
      tails = [children[total - 1].name];
      cursorY = groupY + containerHeight + 80;
    } else if (flattenLoop) {
      // No container box for loops — body children render flat in the main
      // chain, with a loop-back arrow conveying the iteration semantics.
      // Nested rule: if a body child is itself a parallel/converge composite
      // with ≥2 branches AND it isn't the last body child, render it as a
      // nested container so its branches stay visible.
      const body = phase.loop!.body;
      const bodyKind = compositeKey(body);
      const bodyChildren: Node[] =
        bodyKind === 'phases' && Array.isArray(body.phases) && body.phases.length > 0
          ? body.phases
          : [body];
      const total = bodyChildren.length;
      let prevTails: string[] = tails;
      let firstBodyNodeId: string | null = null;

      for (let j = 0; j < total; j++) {
        const child = bodyChildren[j];
        const childKind = compositeKey(child);
        const childBranches =
          childKind === 'parallel' || childKind === 'converge'
            ? (child[childKind] as Node[])
            : null;
        // Inside a loop, even the LAST body child can flatten because the
        // loop-back arrow + the external-next handoffs together provide the
        // rejoin point. (Outside a loop — e.g. flattenPhases — a parallel
        // last child has nothing to rejoin to and must stay atomic.)
        const nestFlattenable =
          !!childBranches && childBranches.length >= 2;

        if (nestFlattenable && childKind) {
          // Nested parallel/converge container.
          const branches = childBranches!;
          const meta: CompositeMeta = {
            name: child.name,
            lock: child.lock,
            merger: child.merger,
            description: child.description,
          };
          const branchCount = branches.length;
          const containerWidth =
            CONTAINER_PADDING * 2 +
            branchCount * CHILD_WIDTH +
            (branchCount - 1) * CHILD_GAP;
          const containerHeight =
            CONTAINER_PADDING_TOP + CHILD_HEIGHT + CONTAINER_PADDING_BOTTOM;
          const groupStored = layout[child.name];
          const groupX = groupStored
            ? groupStored[0]
            : LANE_X + CHILD_WIDTH / 2 - containerWidth / 2;
          const groupY = groupStored
            ? Math.max(groupStored[1], cursorY)
            : cursorY;

          nodes.push({
            id: child.name,
            type: 'container',
            position: { x: groupX, y: groupY },
            style: { width: containerWidth, height: containerHeight },
            data: {
              phase: child,
              composite: childKind,
              isSubflow: false,
              parentComposite: phase.name,
            },
            selectable: true,
            zIndex: -1,
          } as FlowPhaseNode);

          const branchIds: string[] = [];
          branches.forEach((branch, k) => {
            const xRel = CONTAINER_PADDING + k * (CHILD_WIDTH + CHILD_GAP);
            const yRel = CONTAINER_PADDING_TOP;
            nodes.push({
              ...makeNode(branch, { x: xRel, y: yRel }, child.name),
              parentId: child.name,
              extent: 'parent',
            } as FlowPhaseNode);
            branchIds.push(branch.name);
            for (const t of prevTails) {
              edges.push(
                edgeForType(t, branch.name, childKind as 'parallel' | 'converge', meta),
              );
            }
          });
          if (firstBodyNodeId === null) firstBodyNodeId = branchIds[0];
          prevTails = branchIds;
          cursorY = groupY + containerHeight + 80;
        } else {
          // Atomic body child.
          const stored = layout[child.name];
          const yPos = stored ? Math.max(stored[1], cursorY) : cursorY;
          const xPos = stored ? stored[0] : LANE_X;
          nodes.push(makeNode(child, { x: xPos, y: yPos }, phase.name));
          for (const t of prevTails) {
            edges.push(edgeForType(t, child.name, 'handoff'));
          }
          if (firstBodyNodeId === null) firstBodyNodeId = child.name;
          prevTails = [child.name];
          cursorY = yPos + ROW_SPACING;
        }
      }

      // Loop-back arrow: one per tail → first body node. Routed around the
      // right side via the hidden side handles. data.type='loop-back' so the
      // serializer skips it.
      if (firstBodyNodeId && total >= 2) {
        const backLabel = `↻ loop · up to ${phase.loop?.maxIterations ?? '?'}×`;
        prevTails.forEach((tail, idx) => {
          edges.push({
            id: `loop-back-${phase.name}-${idx}`,
            source: tail,
            sourceHandle: 'right-out',
            target: firstBodyNodeId!,
            targetHandle: 'right-in',
            type: 'smoothstep',
            label: idx === 0 ? backLabel : undefined,
            labelStyle: { fontSize: 10, fill: '#0891b2', fontWeight: 700 },
            labelBgStyle: { fill: '#ecfeff' },
            style: {
              stroke: '#0891b2',
              strokeWidth: 2,
              strokeDasharray: '8 4',
            },
            data: { type: 'loop-back' },
            pathOptions: { offset: 60, borderRadius: 20 },
          } as FlowEdge);
        });
      }

      tails = prevTails;
    } else {
      const stored = layout[phase.name];
      const yPos = stored ? Math.max(stored[1], cursorY) : cursorY;
      const fallback = { x: stored ? stored[0] : LANE_X, y: yPos };
      const atomicNode = makeNode(phase, fallback);
      // When the user collapsed an otherwise-flattenable composite, flag it
      // so CompositeNodeView can render an "Expand" button. Pure atomic
      // composites (e.g. parallel at end of chain, route, conversation)
      // don't get the flag and render with the usual ▸/▾ text preview only.
      if (couldFlatten) {
        atomicNode.data = { ...atomicNode.data, isCollapsedFlatten: true };
      }
      nodes.push(atomicNode);
      for (const t of tails) {
        edges.push(edgeForType(t, phase.name, 'handoff'));
      }
      tails = [phase.name];
      cursorY = yPos + ROW_SPACING;
    }
  }

  return { nodes, edges };
}

// Inline rename label. Renders the phase name as a <span>; flips to
// an <input> when the page-level rename state has selected this
// node. Enter commits; Esc / blur cancels. Click events stop
// propagating so editing doesn't also trigger node selection / drag.
function NodeNameLabel({ name }: { name: string }) {
  const { renamingId, commit, cancel } = useContext(RenameCtx);
  const isRenaming = renamingId === name;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (isRenaming) {
      setDraft(name);
      // Defer the focus to the next tick so React Flow's
      // node-double-click handler completes before we steal focus.
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isRenaming, name]);
  if (!isRenaming) {
    return <span style={nodeName}>{name}</span>;
  }
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={e =>
        setDraft((e.target as unknown as { value: string }).value)
      }
      onKeyDown={e => {
        if (e.key === 'Enter') {
          commit(name, draft);
        } else if (e.key === 'Escape') {
          cancel();
        }
        // Stop propagation so the global keydown handler doesn't
        // also nudge or fit-view while the user is typing.
        e.stopPropagation();
      }}
      onBlur={() => commit(name, draft)}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      style={nodeNameInput}
    />
  );
}

// Canvas-C — alignment guide lines. Sits inside <ReactFlow> so it
// can use useReactFlow().flowToScreenPosition to project the
// flow-space coordinates the drag handler computed into the screen-
// space the absolutely-positioned divs need. Re-projects on every
// guide change; the React Flow viewport transform is read each
// render so panning/zooming during a drag stays aligned.
function AlignmentGuides({
  vertical,
  horizontal,
}: {
  vertical: number[];
  horizontal: number[];
}) {
  const reactFlow = useReactFlow();
  if (vertical.length === 0 && horizontal.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9,
      }}>
      {vertical.map((flowX, i) => {
        const screen = reactFlow.flowToScreenPosition({ x: flowX, y: 0 });
        return (
          <div
            key={`v-${i}-${flowX}`}
            style={{
              position: 'absolute',
              left: screen.x,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: '#ec4899',
              opacity: 0.7,
            }}
          />
        );
      })}
      {horizontal.map((flowY, i) => {
        const screen = reactFlow.flowToScreenPosition({ x: 0, y: flowY });
        return (
          <div
            key={`h-${i}-${flowY}`}
            style={{
              position: 'absolute',
              top: screen.y,
              left: 0,
              right: 0,
              height: 1,
              backgroundColor: '#ec4899',
              opacity: 0.7,
            }}
          />
        );
      })}
    </div>
  );
}

// Canvas-B context menu primitives. Single row + horizontal rule
// inside the floating menu div above. Kept inline so we don't need
// a separate styles block — these styles are scoped to the menu's
// 4-px-vertical-padding container.
function ContextMenuItem({
  label,
  hint,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        width: '100%',
        textAlign: 'left',
        padding: '6px 12px',
        backgroundColor: 'transparent',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 12,
        color: danger ? '#dc2626' : disabled ? '#9ca3af' : '#111827',
        fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
      }}>
      <span>{label}</span>
      {hint && (
        <span
          style={{
            fontSize: 11,
            color: '#9ca3af',
            fontFamily: 'Menlo, monospace',
          }}>
          {hint}
        </span>
      )}
    </button>
  );
}

function ContextMenuDivider() {
  return (
    <div
      style={{
        height: 1,
        backgroundColor: '#e5e7eb',
        margin: '4px 0',
      }}
    />
  );
}

// Canvas-A — the hover-arrow overlay. Renders two up/down pills
// just above and below the node card. Click down -> spawn-and-rename
// a phase below; up -> above. The arrows live inside each node's
// container so they inherit React Flow's translate(x,y); no extra
// positioning math.
function HoverArrows({ phaseName }: { phaseName: string }) {
  const { hoveredId, onAddAbove, onAddBelow } = useContext(HoverCtx);
  if (hoveredId !== phaseName) return null;
  function stop(e: { stopPropagation: () => void }) {
    e.stopPropagation();
  }
  return (
    <>
      <button
        type="button"
        onMouseDown={stop}
        onClick={e => {
          stop(e);
          onAddAbove(phaseName);
        }}
        aria-label={`Add a phase above ${phaseName}`}
        title="Add phase above"
        style={hoverArrowStyle('up')}>
        ↑
      </button>
      <button
        type="button"
        onMouseDown={stop}
        onClick={e => {
          stop(e);
          onAddBelow(phaseName);
        }}
        aria-label={`Add a phase below ${phaseName}`}
        title="Add phase below"
        style={hoverArrowStyle('down')}>
        ↓
      </button>
    </>
  );
}

function PhaseNodeView({ data, selected }: NodeProps<FlowPhaseNode>) {
  const { phase, parentComposite, hasError, errorMessage, runStatus } = data;
  const accent = parentComposite ? '#059669' : '#2563eb';
  return (
    <div style={nodeStyles(selected, accent, hasError, runStatus)}>
      <HoverArrows phaseName={phase.name} />
      <Handle type="target" id="top" position={Position.Top} style={handleStyle} />
      <Handle
        type="target"
        id="left-in"
        position={Position.Left}
        style={sideHandleStyle}
      />
      <Handle
        type="target"
        id="right-in"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <div style={nodeHeader}>
        <NodeNameLabel name={phase.name} />
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <StatusDotEl status={runStatus} />
          {hasError && (
            <span style={errorBadge} title={errorMessage}>
              ⚠
            </span>
          )}
          {phase.lock && <span style={lockBadge}>locked</span>}
        </div>
      </div>
      {parentComposite && (
        <div style={{ ...compositeBadge, backgroundColor: '#0596691a', color: '#059669' }}>
          in {parentComposite}
        </div>
      )}
      {phase.agent && <div style={agentPath}>{phase.agent}</div>}
      {phase.description && (
        <div style={descriptionText}>{truncate(phase.description, 80)}</div>
      )}
      {hasError && errorMessage && (
        <div style={errorMessageText}>{errorMessage}</div>
      )}
      <Handle
        type="source"
        id="right-out"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <Handle type="source" id="bottom" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

/** Walk a composite phase + emit a child-summary line for each leaf.
 *  Used inside CompositeNodeView so users can see what's inside a
 *  map / phases / loop / route / conversation / parallel / converge
 *  without leaving the graph view. Caps at 12 entries with a "+N
 *  more" tail to keep the card compact.
 *
 *  Each entry is a short {prefix, name, meta} tuple — the renderer
 *  decides the visual treatment. */
type ChildSummaryEntry = { prefix: string; name: string; meta?: string };
function summarizeCompositeChildren(
  phase: Node,
  composite: CompositeKey,
): ChildSummaryEntry[] {
  function summarizeNode(n: Node): ChildSummaryEntry {
    const inner = compositeKey(n);
    if (n.agent) {
      const last = n.agent.split('/').pop()?.replace(/\.md$/, '') ?? n.agent;
      return { prefix: '🤖', name: n.name, meta: last };
    }
    if (n.subflow) return { prefix: '🔗', name: n.name, meta: `→ ${n.subflow}` };
    if (inner) {
      const count = compositeChildCount(n, inner);
      return { prefix: '◆', name: n.name, meta: `${inner}·${count}` };
    }
    return { prefix: '○', name: n.name };
  }
  if (composite === 'agents') {
    const list = (phase.agents ?? []) as string[];
    return list.map((p, i) => {
      const last = p.split('/').pop()?.replace(/\.md$/, '') ?? p;
      return { prefix: `${i + 1}.`, name: last, meta: 'agent' };
    });
  }
  if (composite === 'phases' || composite === 'parallel' || composite === 'converge') {
    const children = (phase[composite] as Node[] | undefined) ?? [];
    return children.map((c, i) => {
      const s = summarizeNode(c);
      return { ...s, prefix: composite === 'phases' ? `${i + 1}.` : s.prefix };
    });
  }
  if (composite === 'loop' && phase.loop?.body) {
    const body = summarizeNode(phase.loop.body);
    const extras: ChildSummaryEntry[] = [body];
    if (phase.loop.judge) {
      const judge = phase.loop.judge.split('/').pop()?.replace(/\.md$/, '') ?? phase.loop.judge;
      extras.push({ prefix: '⚖', name: 'judge', meta: judge });
    }
    return extras;
  }
  if (composite === 'map' && phase.map?.body) {
    const body = summarizeNode(phase.map.body);
    return [{ prefix: 'Σ', name: 'over', meta: phase.map.over }, body];
  }
  if (composite === 'route' && phase.route?.branches) {
    const entries: ChildSummaryEntry[] = [];
    if (phase.route.router) {
      const r = phase.route.router.split('/').pop()?.replace(/\.md$/, '') ?? phase.route.router;
      entries.push({ prefix: '⋔', name: 'router', meta: r });
    }
    for (const [key, branch] of Object.entries(phase.route.branches)) {
      const s = summarizeNode(branch);
      entries.push({ ...s, prefix: `"${key}"`, meta: s.meta ?? s.name });
    }
    if (phase.route.default) {
      const s = summarizeNode(phase.route.default);
      entries.push({ ...s, prefix: 'default', meta: s.meta ?? s.name });
    }
    return entries;
  }
  if (composite === 'conversation' && phase.conversation) {
    return phase.conversation.participants.map((p, i) => {
      const last = p.split('/').pop()?.replace(/\.md$/, '') ?? p;
      return { prefix: `T${i + 1}`, name: last };
    });
  }
  return [];
}

function CompositeNodeView({ data, selected }: NodeProps<FlowPhaseNode>) {
  const { phase, composite, isCollapsedFlatten, hasError, errorMessage, runStatus } =
    data;
  const toggleCollapsed = useContext(CollapseCtx);
  const childCount = composite ? compositeChildCount(phase, composite) : 0;
  const childLabel =
    composite === 'loop'
      ? `up to ${childCount}×`
      : composite === 'route'
        ? `${childCount} branch${childCount === 1 ? '' : 'es'}`
        : composite === 'conversation'
          ? `${childCount} participant${childCount === 1 ? '' : 's'}`
          : `${childCount}`;
  const compColor = composite ? COMPOSITE_COLOR[composite] : '#6b7280';
  // Expand state: localStorage-backed so a user who's opened a
  // composite to peek inside doesn't lose the view on re-render.
  const storageKey = `sammy.graph.composite-expanded.${phase.name}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  function toggleExpand(e: { stopPropagation(): void }): void {
    e.stopPropagation();
    setExpanded(prev => {
      const next = !prev;
      try {
        if (typeof localStorage !== 'undefined') {
          if (next) localStorage.setItem(storageKey, '1');
          else localStorage.removeItem(storageKey);
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  const summary = composite ? summarizeCompositeChildren(phase, composite) : [];
  const summaryCap = 12;
  const visible = summary.slice(0, summaryCap);
  const overflow = summary.length - visible.length;
  return (
    <div style={nodeStyles(selected, compColor, hasError, runStatus)}>
      <HoverArrows phaseName={phase.name} />
      <Handle type="target" id="top" position={Position.Top} style={handleStyle} />
      <Handle
        type="target"
        id="left-in"
        position={Position.Left}
        style={sideHandleStyle}
      />
      <Handle
        type="target"
        id="right-in"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <div style={nodeHeader}>
        <NodeNameLabel name={phase.name} />
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <StatusDotEl status={runStatus} />
          {hasError && (
            <span style={errorBadge} title={errorMessage}>
              ⚠
            </span>
          )}
          {phase.lock && <span style={lockBadge}>locked</span>}
        </div>
      </div>
      {hasError && errorMessage && (
        <div style={errorMessageText}>{errorMessage}</div>
      )}
      <button
        onClick={toggleExpand}
        style={{
          ...compositeBadge,
          backgroundColor: `${compColor}1a`,
          color: compColor,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          padding: '3px 8px',
          fontFamily: 'inherit',
        }}
        title={expanded ? 'Click to collapse' : 'Click to expand and see children'}>
        {expanded ? '▾' : '▸'} {composite} · {childLabel}
      </button>
      {isCollapsedFlatten && (
        <button
          onClick={e => {
            e.stopPropagation();
            toggleCollapsed(phase.name);
          }}
          title="Expand back into a graph container"
          style={{
            marginTop: 4,
            fontSize: 10,
            fontWeight: 600,
            color: compColor,
            backgroundColor: 'transparent',
            border: `1px dashed ${compColor}66`,
            borderRadius: 4,
            padding: '2px 6px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'left',
          }}>
          ⊞ Expand into row
        </button>
      )}
      {expanded && summary.length > 0 && (
        <div
          style={{
            marginTop: 4,
            padding: 6,
            borderLeft: `2px solid ${compColor}`,
            backgroundColor: '#f9fafb',
            borderRadius: 4,
            gap: 3,
            display: 'flex',
            flexDirection: 'column',
          }}>
          {visible.map((entry, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                fontSize: 11,
                lineHeight: 1.4,
              }}>
              <span style={{ color: compColor, fontFamily: 'Menlo', minWidth: 18, fontWeight: 600 }}>
                {entry.prefix}
              </span>
              <span style={{ color: '#111827', fontWeight: 500 }}>{entry.name}</span>
              {entry.meta && (
                <span style={{ color: '#6b7280', fontFamily: 'Menlo', fontSize: 10 }}>
                  · {entry.meta}
                </span>
              )}
            </div>
          ))}
          {overflow > 0 && (
            <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic' }}>
              … and {overflow} more (open in Pipeline view)
            </div>
          )}
        </div>
      )}
      {composite === 'converge' && phase.merger && (
        <div style={mergerText}>merger: {phase.merger}</div>
      )}
      {composite === 'loop' && phase.loop?.until && (
        <div style={mergerText}>stop: {phase.loop.until}</div>
      )}
      {phase.description && (
        <div style={descriptionText}>{truncate(phase.description, 80)}</div>
      )}
      <Handle
        type="source"
        id="right-out"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <Handle type="source" id="bottom" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

function SubflowNodeView({ data, selected }: NodeProps<FlowPhaseNode>) {
  const { phase, hasError, errorMessage, runStatus } = data;
  return (
    <div style={nodeStyles(selected, '#7c3aed', hasError, runStatus)}>
      <HoverArrows phaseName={phase.name} />
      <Handle type="target" id="top" position={Position.Top} style={handleStyle} />
      <Handle
        type="target"
        id="left-in"
        position={Position.Left}
        style={sideHandleStyle}
      />
      <Handle
        type="target"
        id="right-in"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <div style={nodeHeader}>
        <NodeNameLabel name={phase.name} />
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {hasError && (
            <span style={errorBadge} title={errorMessage}>
              ⚠
            </span>
          )}
          {phase.lock && <span style={lockBadge}>locked</span>}
        </div>
      </div>
      <div style={{ ...compositeBadge, backgroundColor: '#7c3aed1a', color: '#7c3aed' }}>
        subflow
      </div>
      <div style={agentPath}>{phase.subflow}</div>
      {hasError && errorMessage && (
        <div style={errorMessageText}>{errorMessage}</div>
      )}
      <Handle
        type="source"
        id="right-out"
        position={Position.Right}
        style={sideHandleStyle}
      />
      <Handle type="source" id="bottom" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

function ContainerNodeView({ data, selected }: NodeProps<FlowPhaseNode>) {
  const { phase, composite, hasError, errorMessage, runStatus } = data;
  const toggleCollapsed = useContext(CollapseCtx);
  const baseColor = composite ? COMPOSITE_COLOR[composite] : '#6b7280';
  const statusColor =
    runStatus && runStatus !== 'pending' ? STATUS_COLOR[runStatus] : undefined;
  const color = hasError ? '#dc2626' : statusColor ?? baseColor;
  const childCount = composite ? compositeChildCount(phase, composite) : 0;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        border: `2px solid ${color}`,
        borderRadius: 12,
        backgroundColor: hasError ? '#fef2f266' : `${baseColor}0d`,
        boxSizing: 'border-box',
        position: 'relative',
        boxShadow: hasError
          ? `0 0 0 3px ${color}33`
          : selected
            ? `0 0 0 3px ${color}33`
            : undefined,
      }}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <button
        onClick={e => {
          e.stopPropagation();
          toggleCollapsed(phase.name);
        }}
        title="Collapse to a single pill"
        style={{
          position: 'absolute',
          top: -11,
          left: 14,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 1,
          paddingBottom: 1,
          fontSize: 10,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: 1,
          backgroundColor: '#f9fafb',
          borderRadius: 4,
          border: `1px solid ${color}33`,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}>
        ▾ {phase.name} · {composite} · {childCount}
      </button>
      {phase.lock && (
        <div
          style={{
            position: 'absolute',
            top: -11,
            right: 14,
            fontSize: 9,
            fontWeight: 700,
            color: '#dc2626',
            backgroundColor: '#fee2e2',
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 1,
            paddingBottom: 1,
            borderRadius: 4,
            textTransform: 'uppercase',
          }}>
          locked
        </div>
      )}
      {hasError && (
        <div
          title={errorMessage}
          style={{
            position: 'absolute',
            top: -11,
            right: phase.lock ? 60 : 14,
            fontSize: 11,
            fontWeight: 700,
            color: '#dc2626',
            backgroundColor: '#fee2e2',
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 1,
            paddingBottom: 1,
            borderRadius: 4,
          }}>
          ⚠
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

const NODE_TYPES = {
  phase: PhaseNodeView,
  composite: CompositeNodeView,
  subflow: SubflowNodeView,
  container: ContainerNodeView,
};

// Canvas-A — custom edge that renders a "+" pill at its midpoint when
// hovered. Click the pill to splice a new phase between source and
// target (insertPhaseAfter(source) — sequencing is implicit from
// phases[] order, so the visual effect is "edge a -> + -> b" becomes
// "a -> new -> b"). Reuses React Flow's getSmoothStepPath for path
// math + EdgeLabelRenderer for DOM-aware overlay positioning.
function InsertableEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    label,
    labelStyle,
    labelBgStyle,
    markerEnd,
    source,
  } = props;
  const { hoveredEdgeId, onInsert } = useContext(EdgeInsertCtx);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const isHovered = hoveredEdgeId === id;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        markerEnd={markerEnd}
      />
      <EdgeLabelRenderer>
        {label != null && (
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 4}px)`,
              padding: '1px 5px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              pointerEvents: 'none',
              ...(labelBgStyle as React.CSSProperties),
              ...(labelStyle as React.CSSProperties),
            }}>
            {label as string}
          </div>
        )}
        {isHovered && (
          <button
            type="button"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onInsert(source);
            }}
            aria-label="Insert phase on this edge"
            title="Insert phase here"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              width: 22,
              height: 22,
              borderRadius: 999,
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: '2px solid #ffffff',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
              pointerEvents: 'auto',
              fontFamily: 'inherit',
              lineHeight: 1,
              zIndex: 11,
            }}>
            +
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = {
  insertable: InsertableEdge,
};

export function GraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

/** Generate a name not in use anywhere in the orchestration tree. */
function uniqueChildName(orchestration: Node, base: string): string {
  const used = new Set<string>();
  function visit(node: Node) {
    if (node.name) used.add(node.name);
    for (const key of ['phases', 'parallel', 'converge'] as const) {
      const arr = node[key];
      if (Array.isArray(arr)) for (const c of arr) visit(c);
    }
  }
  for (const p of orchestration.phases ?? []) visit(p);
  let i = 1;
  let name = `${base}-${i}`;
  while (used.has(name)) {
    i += 1;
    name = `${base}-${i}`;
  }
  return name;
}

// Pure subtree helpers — functions of their arguments only, closing over
// nothing from the component. They lived inside GraphInner, which made them
// new identities on every render and therefore an unstable dependency of the
// duplicate-phase callback. Module scope removes them from the dependency
// graph entirely and makes them independently testable.
// Walks the cloned subtree and renames every phase to avoid
// collisions in the target orchestration. Composite children's
// names also get the suffix so route branches / parallel siblings
// stay distinct.
function renameSubtree(node: Node, taken: Set<string>): Node {
  const seed = `${node.name}-copy`;
  let candidate = seed;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${seed}-${i++}`;
  }
  taken.add(candidate);
  const next: Node = { ...node, name: candidate };
  for (const key of ['phases', 'parallel', 'converge'] as const) {
    const arr = node[key] as Node[] | undefined;
    if (arr) {
      (next as Record<string, unknown>)[key] = arr.map(c =>
        renameSubtree(c, taken),
      );
    }
  }
  if (node.loop?.body) {
    next.loop = { ...node.loop, body: renameSubtree(node.loop.body, taken) };
  }
  if (node.map?.body) {
    next.map = { ...node.map, body: renameSubtree(node.map.body, taken) };
  }
  if (node.route?.branches) {
    const branches: Record<string, Node> = {};
    for (const [k, v] of Object.entries(node.route.branches)) {
      branches[k] = renameSubtree(v, taken);
    }
    next.route = {
      ...node.route,
      branches,
      default: node.route.default
        ? renameSubtree(node.route.default, taken)
        : undefined,
    };
  }
  return next;
}

// Collect every name already used in the orchestration so the
// rename helper can pick fresh candidates.
function collectTakenNames(root: Node, into: Set<string>): void {
  into.add(root.name);
  for (const key of ['phases', 'parallel', 'converge'] as const) {
    const arr = root[key] as Node[] | undefined;
    if (arr) arr.forEach(c => collectTakenNames(c, into));
  }
  if (root.loop?.body) collectTakenNames(root.loop.body, into);
  if (root.map?.body) collectTakenNames(root.map.body, into);
  if (root.route?.branches) {
    Object.values(root.route.branches).forEach(b =>
      collectTakenNames(b, into),
    );
  }
  if (root.route?.default) collectTakenNames(root.route.default, into);
}

function GraphInner({
  orchestration,
  onChange,
  availableOrchestrations,
  selectedNodeName,
  onSelectionChange,
  errorNodeNames,
  errorMessageByNode,
  runStatusByNode,
  liveActivePhase,
}: Props) {
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() =>
    loadCollapsedSet(orchestration),
  );
  const toggleCollapsed = useCallback((name: string) => {
    setCollapsedSet(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
        persistCollapsed(name, false);
      } else {
        next.add(name);
        persistCollapsed(name, true);
      }
      return next;
    });
  }, []);

  const seed = useMemo(
    () => buildGraph(orchestration, collapsedSet),
    [orchestration, collapsedSet],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowPhaseNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(seed.edges);
  // Selection state — controlled vs uncontrolled:
  //   - When the parent passes `selectedNodeName` + `onSelectionChange`,
  //     the component is controlled. The internal `_internalSelectedNodeId`
  //     state is unused; reads come from props.
  //   - When the parent passes neither, the component falls back to its
  //     internal state — preserves the standalone behavior used by the
  //     AB-compare page and any other caller that doesn't lift selection.
  // The `setSelectedNodeId` writer below normalizes the two by writing
  // to internal state AND calling `onSelectionChange` when provided.
  const [_internalSelectedNodeId, _setInternalSelectedNodeId] = useState<string | null>(null);
  const selectedNodeId = selectedNodeName !== undefined
    ? selectedNodeName
    : _internalSelectedNodeId;
  // Latest-value refs so the writer below can be identity-STABLE.
  //
  // It used to be `useCallback(..., [selectedNodeId, onSelectionChange])`,
  // i.e. a NEW function on every selection change. That is what made nine
  // downstream callbacks fail `exhaustive-deps`: each had captured an older
  // writer, and an older writer resolves the functional form
  // (`setSelectedNodeId(prev => ...)`) against a STALE `selectedNodeId`. The
  // lint errors were pointing at a real stale-closure class, not at noise.
  //
  // Reading through refs removes the dependency instead of suppressing the
  // warning: the writer is created once, always sees the current selection,
  // and every consumer's dep array becomes correct by construction. Refs are
  // assigned during render (the standard "latest ref" pattern) because the
  // writer is only ever invoked from an event handler or effect, never during
  // the render that updates them.
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const setSelectedNodeId = useCallback(
    (next: string | null | ((prev: string | null) => string | null)) => {
      const resolved =
        typeof next === 'function'
          ? (next as (p: string | null) => string | null)(selectedNodeIdRef.current)
          : next;
      _setInternalSelectedNodeId(resolved);
      onSelectionChangeRef.current?.(resolved);
    },
    [],
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [nextEdgeType, setNextEdgeType] = useState<EdgeType>('handoff');
  // Double-click → swap a node's name <span> for an <input>. Cleared
  // on Enter / Esc / blur. Only one node can be in rename mode at a
  // time. Tracked here because the renamer lives inside the
  // individual node renderers, but the trigger (onNodeDoubleClick)
  // fires from ReactFlow at this level.
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  // Canvas-A — which node is the cursor hovering, so we know where
  // to paint the up/down add-arrow handles. Throttled in the
  // ReactFlow handlers (debounce via React batching is sufficient
  // — these fire on every mouseenter, not per-pixel).
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  // Canvas-B — right-click context menu. Position is in viewport
  // coords (clientX/clientY); the menu div sits position:fixed.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    kind: 'node' | 'edge' | 'pane';
    targetId: string | null;
  } | null>(null);
  // Canvas-B — clipboard. Stores a deep-clone of the last copied
  // phase subtree. Cmd+V pastes after the current selection (or
  // appends to root). Cmd+D does Copy+Paste in one keystroke.
  const clipboardRef = useRef<Node | null>(null);
  // Indirection ref for the clipboard handlers — declared here so the
  // arrow-nudge / Cmd+C/V/X/D useEffect (which appears above the
  // handler definitions later in the body) can read them by ref
  // without hitting JS's temporal dead zone. Updated by a useEffect
  // that runs after the handlers are defined.
  const clipboardHandlersRef = useRef<{
    copy: (id: string) => void;
    paste: () => void;
    cut: (id: string) => void;
    duplicate: (id: string) => void;
  } | null>(null);
  // Canvas-C — alignment guides. During a node drag, when the dragged
  // node's x or y matches another node's x or y (within a small
  // snap threshold), render a thin magenta line spanning the canvas
  // at that coordinate. Cleared on drag-stop. Stored as canvas-space
  // flow coordinates so we can project to screen each frame.
  const [alignGuides, setAlignGuides] = useState<{
    vertical: number[];
    horizontal: number[];
  }>({ vertical: [], horizontal: [] });
  // Canvas-A — drag-from-port-to-pane spawn needs to remember which
  // node + handle initiated the drag so it can wire the edge once
  // we know the drop position.
  const dragOriginRef = useRef<{
    nodeId: string;
    handleId: string | null;
    handleType: 'source' | 'target' | null;
  } | null>(null);
  const reactFlow = useReactFlow();

  // Resync graph only when the active flow changes (different orchestration loaded).
  // We intentionally do NOT depend on seed — those re-memoize on every prop update,
  // which would wipe out the user's edge edits and selection.
  useEffect(() => {
    const fresh = buildGraph(orchestration, loadCollapsedSet(orchestration));
    setCollapsedSet(loadCollapsedSet(orchestration));
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setBanner(null);
    // Keyed on the orchestration NAME only, deliberately — see above. The
    // directive lives HERE rather than above `useEffect` because this rule
    // reports at the dependency array, so a disable above the hook call does
    // not apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration.name]);

  // Decorate each node with hasError + errorMessage drawn from the
  // page-level validation. Runs whenever the error set changes — does
  // not rebuild the graph (would wipe out positions and selection).
  // Just updates the `data` slot of each node in place.
  useEffect(() => {
    if (!errorNodeNames) return;
    setNodes(curr =>
      curr.map(n => {
        const phaseName = n.data?.phase?.name;
        const hasError = !!(phaseName && errorNodeNames.has(phaseName));
        const errorMessage = phaseName
          ? errorMessageByNode?.get(phaseName)
          : undefined;
        if (n.data?.hasError === hasError && n.data?.errorMessage === errorMessage) {
          return n;
        }
        return {
          ...n,
          data: { ...n.data, hasError, errorMessage },
        };
      }),
    );
  }, [errorNodeNames, errorMessageByNode, setNodes]);

  // Inject the running-node pulse keyframes once (graph is raw DOM).
  useEffect(() => {
    ensurePulseStyle();
  }, []);

  // Decorate each node with its live run status — same in-place `data` update
  // as the error effect (does not rebuild the graph). runStatusByNode is a
  // fresh Map per stream event, so this re-runs as the run progresses.
  useEffect(() => {
    setNodes(curr =>
      curr.map(n => {
        const phaseName = n.data?.phase?.name;
        const runStatus = phaseName ? runStatusByNode?.get(phaseName) : undefined;
        if (n.data?.runStatus === runStatus) return n;
        return { ...n, data: { ...n.data, runStatus } };
      }),
    );
  }, [runStatusByNode, setNodes]);

  // Animate the edges that lead INTO the currently-running phase, so the eye
  // follows the flow toward the live node. Clears when nothing is running.
  useEffect(() => {
    setEdges(curr =>
      curr.map(e => {
        const animated = !!liveActivePhase && e.target === liveActivePhase;
        if (!!e.animated === animated) return e;
        return { ...e, animated };
      }),
    );
  }, [liveActivePhase, setEdges]);

  // Reconcile graph when phases OR the user's collapse choices change: rebuild
  // nodes + edges from the schema. Keep a manual in-memory position ONLY for
  // PINNED nodes (those the user dragged → present in _layout). Un-pinned
  // nodes always take the fresh auto-layout position, so inserting (or
  // deleting) a phase re-flows the chain and shifts everything downstream to
  // make room, instead of stranding the new node at the bottom or
  // overlapping a neighbour. buildGraph is deterministic, so a
  // non-structural edit (rename, edge-type) reproduces the same positions
  // and nothing visibly jumps.
  useEffect(() => {
    const fresh = buildGraph(orchestration, collapsedSet);
    const pinned = orchestration._layout ?? {};
    setNodes(prev => {
      const prevById = new Map(prev.map(n => [n.id, n]));
      return fresh.nodes.map(n => {
        const existing = prevById.get(n.id);
        return existing && pinned[n.id]
          ? { ...n, position: existing.position }
          : n;
      });
    });
    setEdges(fresh.edges);
    // Structural edits only — see above. Same placement reason as the resync
    // effect: this rule reports at the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration.phases, collapsedSet]);

  const allPhases = useMemo(() => {
    const m = new Map<string, Node>();
    for (const p of orchestration.phases ?? []) collectAllPhases(p, m);
    return m;
  }, [orchestration.phases]);

  const selectedPhase = useMemo(() => {
    if (selectedNodeId) return allPhases.get(selectedNodeId) ?? null;
    // Fallback: when xyflow's selection has exactly one node but our explicit
    // onNodeClick didn't fire (e.g. click via drag-select), still show its
    // side panel.
    if (multiSelectedIds.length === 1) {
      return allPhases.get(multiSelectedIds[0]) ?? null;
    }
    return null;
  }, [selectedNodeId, multiSelectedIds, allPhases]);

  const selectedEdge = useMemo(
    () => edges.find(e => e.id === selectedEdgeId) ?? null,
    [selectedEdgeId, edges],
  );

  // Persist phase order/structure to schema based on the current graph.
  //
  // Positions are pinned to `_layout` ONLY for the ids in `pinIds` — the
  // node(s) the user just dragged. Previously this loop wrote EVERY visible
  // node's position on every call, so any edit (even creating an edge or
  // renaming) froze the entire auto-layout: "drag one node, pin them all".
  // That trap (and its stale-pin cascades, e.g. the giant architect→phase-1
  // gap) is why manual tweaks fought the layout. Pinning is now opt-in:
  // structure-only callers pass no ids and leave positions untouched.
  const syncToSchema = useCallback(
    (
      currentNodes: FlowPhaseNode[],
      currentEdges: FlowEdge[],
      pinIds?: string[],
    ) => {
      const result = serializeGraph(currentNodes, currentEdges, orchestration);
      const layout = { ...(orchestration._layout ?? {}) };
      if (pinIds && pinIds.length) {
        const byId = new Map(currentNodes.map(n => [n.id, n]));
        for (const id of pinIds) {
          const n = byId.get(id);
          if (n) {
            layout[id] = [Math.round(n.position.x), Math.round(n.position.y)];
          }
        }
      }
      if (result.kind === 'ok') {
        onChange({ ...orchestration, phases: result.phases, _layout: layout });
        setBanner(null);
      } else {
        onChange({ ...orchestration, _layout: layout });
        setBanner(result.reason);
      }
    },
    [orchestration, onChange],
  );

  const handleDragStop = useCallback<OnNodeDrag<FlowPhaseNode>>(
    (_event, node, draggedNodes) => {
      // The 3rd arg is the full multi-select drag set (xyflow OnNodeDrag);
      // fall back to the single node. We pin ONLY these — never the rest.
      const moved =
        draggedNodes && draggedNodes.length ? draggedNodes : [node];
      const movedIds = new Set(moved.map(n => n.id));
      // Snap each released node onto a stationary neighbour's edge when it
      // lands within SNAP_PX, so the alignment guides actually "click" into
      // place instead of being purely cosmetic. Snapping
      // on release (not mid-drag) keeps it jitter-free.
      const posById = new Map<string, { x: number; y: number }>();
      for (const m of moved) {
        let { x, y } = m.position;
        for (const other of nodes) {
          if (movedIds.has(other.id)) continue;
          if (Math.abs(other.position.x - x) < SNAP_PX) x = other.position.x;
          if (Math.abs(other.position.y - y) < SNAP_PX) y = other.position.y;
        }
        posById.set(m.id, { x, y });
      }
      const updatedNodes = nodes.map(n =>
        posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n,
      );
      setNodes(updatedNodes);
      syncToSchema(updatedNodes, edges, [...movedIds]);
      setAlignGuides({ vertical: [], horizontal: [] });
    },
    [nodes, edges, setNodes, syncToSchema],
  );

  // Canvas-C — alignment guides during drag. Fires on every mouse
  // move while a node is being dragged. Compares the dragged node's
  // center against every other node's center; any x or y match
  // within SNAP px goes into the guides set so the overlay renders
  // a magenta line at that coordinate. (SNAP_PX is module-scoped so
  // handleDragStop can reuse it for snap-on-release.)
  const handleDrag = useCallback<OnNodeDrag<FlowPhaseNode>>(
    (_event, node) => {
      // Card half-size — approximate, since each node's actual
      // bounding rect varies. 90 × 30 hits the middle of the
      // 180-wide / 60-tall default phase card so the centerline
      // anchors against other phases' centerlines.
      const cx = node.position.x + 90;
      const cy = node.position.y + 30;
      const vMatches: number[] = [];
      const hMatches: number[] = [];
      for (const other of nodes) {
        if (other.id === node.id) continue;
        const ocx = other.position.x + 90;
        const ocy = other.position.y + 30;
        if (Math.abs(ocx - cx) < SNAP_PX) vMatches.push(ocx);
        if (Math.abs(ocy - cy) < SNAP_PX) hMatches.push(ocy);
      }
      setAlignGuides({
        vertical: [...new Set(vMatches)],
        horizontal: [...new Set(hMatches)],
      });
    },
    [nodes],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const newEdge = edgeForType(
        connection.source,
        connection.target,
        nextEdgeType,
      );
      const nextEdges = addEdge(newEdge, edges);
      setEdges(nextEdges);
      syncToSchema(nodes, nextEdges);
    },
    [edges, nodes, setEdges, syncToSchema, nextEdgeType],
  );

  // Where a freshly-added node sits is now handled by the auto-layout:
  // click-adds insert into the phases[] array and stay un-pinned, so
  // buildGraph slots the node into the chain (right after the selection /
  // hovered node) and shifts everything downstream to make room. Only
  // deliberate placements (drag-from-palette drop, drag-to-pane spawn,
  // "Add phase here") pin a position. See the reconcile effect above.

  // `pos` is supplied when the node is created by dropping a palette item
  // on the canvas (drag-from-palette) — it pins the node exactly where the
  // user dropped it. Omitted on a plain palette click, which falls back to
  // auto-placement next to the selection.
  const handleAddPhase = useCallback((pos?: [number, number]) => {
    const name = uniqueChildName(orchestration, 'phase');
    const newPhase: Node = { name };
    const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
    const layout = { ...(orchestration._layout ?? {}) };
    // Only pin when dropped at a specific point (drag-from-palette). A plain
    // click leaves the node un-pinned so buildGraph slots it into the chain
    // right after the selection and shifts everything below down.
    if (pos) layout[name] = pos;
    next._layout = layout;
    onChange(next);
    setSelectedNodeId(name);
    setSelectedEdgeId(null);
    // Canvas-A — palette adds also drop into inline-rename mode so the
    // user can keep typing instead of being shoved through the side
    // panel for each new node. Pairs with hover-arrow adds + drag-to-
    // pane spawns + mid-edge inserts: every "new node" path lands the
    // user on the same fast keyboard rhythm.
    setRenamingNodeId(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedNodeId]);

  // Canvas-A — hover-arrow up. Inserts a new phase BEFORE the hovered node
  // in its parent array. Left un-pinned so buildGraph places it directly
  // above the hovered node and shifts the rest down to make room. Lands the
  // user in inline-rename mode.
  const handleAddAbove = useCallback(
    (nodeId: string) => {
      const newName = uniqueChildName(orchestration, 'phase');
      const newPhase: Node = { name: newName };
      const next = insertPhaseBefore(orchestration, nodeId, newPhase);
      onChange(next);
      setSelectedNodeId(newName);
      setSelectedEdgeId(null);
      setRenamingNodeId(newName);
    },
    [orchestration, onChange, setSelectedNodeId],
  );

  // Canvas-A — hover-arrow down. Inserts a new phase AFTER the hovered node,
  // anchored to whichever node the cursor is hovering (not the selection).
  // Left un-pinned so buildGraph places it directly below and shifts the
  // rest down. Lets the user keep typing names without reaching for the
  // side palette.
  const handleAddBelow = useCallback(
    (nodeId: string) => {
      const newName = uniqueChildName(orchestration, 'phase');
      const newPhase: Node = { name: newName };
      const next = insertPhaseAfter(orchestration, nodeId, newPhase);
      onChange(next);
      setSelectedNodeId(newName);
      setSelectedEdgeId(null);
      setRenamingNodeId(newName);
    },
    [orchestration, onChange, setSelectedNodeId],
  );

  // Canvas-A — mid-edge "+" insert. Splits an existing handoff edge
  // by inserting a new phase between the source and target. Because
  // edges in sammy are derived from the phases[] array order (not
  // stored independently), splitting "phase-a → phase-b" is the
  // same operation as "insert after phase-a." The visual result is
  // edge a→new + edge new→b, which is what we want.
  const handleInsertOnEdge = useCallback(
    (sourceId: string) => {
      handleAddBelow(sourceId);
    },
    [handleAddBelow],
  );

  // Add a CHILD directly INTO the selected array composite
  // (phases/parallel/converge) — the "nest a phase inside this one" gesture
  // the Graph view was missing (it used to tell users to switch to Pipeline).
  // Reuses the shared addChildPhase mutation and selects the new child so
  // it's immediately editable.
  const handleAddChild = useCallback(
    (kind: AddChildKind) => {
      if (!selectedNodeId) return;
      const name = uniqueChildName(
        orchestration,
        kind === 'phase' ? 'phase' : `${kind}-group`,
      );
      let child: Node;
      switch (kind) {
        case 'agents':
          child = { name, agents: ['agents/'] };
          break;
        case 'phases':
          child = { name, phases: [] };
          break;
        case 'parallel':
          child = { name, parallel: [] };
          break;
        case 'converge':
          child = { name, converge: [], merger: '' };
          break;
        case 'loop': {
          const bodyName = uniqueChildName(
            { ...orchestration, phases: [...(orchestration.phases ?? []), { name }] },
            'phase',
          );
          child = {
            name,
            loop: { body: { name: bodyName, agent: 'agents/' }, maxIterations: 3 },
          };
          break;
        }
        case 'phase':
        default:
          child = { name, agent: 'agents/' };
          break;
      }
      const next = addChildPhase(orchestration, selectedNodeId, child);
      onChange(next);
      setSelectedNodeId(child.name);
      setSelectedEdgeId(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orchestration, onChange, selectedNodeId],
  );

  const handleAddComposite = useCallback(
    (kind: 'parallel' | 'converge' | 'phases', pos?: [number, number]) => {
      const phases = orchestration.phases ?? [];
      const groupName = uniqueChildName(orchestration, `${kind}-group`);
      const child1 = uniqueChildName(orchestration, 'phase');
      const tempScope: Node = {
        ...orchestration,
        phases: [...phases, { name: child1 }],
      };
      const child2 = uniqueChildName(tempScope, 'phase');

      const childNodes: Node[] = [{ name: child1 }, { name: child2 }];
      const newPhase: Node = { name: groupName, [kind]: childNodes };
      if (kind === 'converge') newPhase.merger = '';

      const layout = { ...(orchestration._layout ?? {}) };
      // Only pin when dropped at a point (drag-from-palette); a plain click
      // leaves the group un-pinned so it slots into the chain after the
      // selection and shifts the rest down. Flattened children are laid out
      // by their container either way.
      if (pos) {
        const [groupX, groupY] = pos;
        layout[groupName] = [groupX, groupY];
        // Spread the children horizontally around groupX (so when flattened
        // they show up as parallel branches at the same row).
        layout[child1] = [groupX - BRANCH_SPACING / 2, groupY];
        layout[child2] = [groupX + BRANCH_SPACING / 2, groupY];
      }

      const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
      next._layout = layout;
      onChange(next);
      setSelectedNodeId(groupName);
      setSelectedEdgeId(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orchestration, onChange, selectedNodeId],
  );

  const handleAddAgentsChain = useCallback((pos?: [number, number]) => {
    const groupName = uniqueChildName(orchestration, 'multi-agent');
    const newPhase: Node = {
      name: groupName,
      agents: ['agents/agent-a.md', 'agents/agent-b.md'],
    };
    const layout = { ...(orchestration._layout ?? {}) };
    // Pin only on drop (drag-from-palette); a click auto-flows + shifts.
    if (pos) layout[groupName] = pos;
    const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
    next._layout = layout;
    onChange(next);
    setSelectedNodeId(groupName);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedNodeId]);

  const handleAddLoop = useCallback((pos?: [number, number]) => {
    const phases = orchestration.phases ?? [];
    const groupName = uniqueChildName(orchestration, 'loop');
    const bodyName = uniqueChildName(
      { ...orchestration, phases: [...phases, { name: groupName }] },
      'loop-body',
    );
    const newPhase: Node = {
      name: groupName,
      loop: {
        body: { name: bodyName, agent: '' },
        maxIterations: 3,
      },
    };
    const layout = { ...(orchestration._layout ?? {}) };
    // Pin only on drop (drag-from-palette); a click auto-flows + shifts.
    if (pos) layout[groupName] = pos;
    const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
    next._layout = layout;
    onChange(next);
    setSelectedNodeId(groupName);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedNodeId]);

  const handleAddConversation = useCallback((pos?: [number, number]) => {
    const groupName = uniqueChildName(orchestration, 'conversation');
    const newPhase: Node = {
      name: groupName,
      conversation: {
        participants: ['agents/critic.md', 'agents/writer.md'],
        rounds: 4,
      },
    };
    const layout = { ...(orchestration._layout ?? {}) };
    // Pin only on drop (drag-from-palette); a click auto-flows + shifts.
    if (pos) layout[groupName] = pos;
    const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
    next._layout = layout;
    onChange(next);
    setSelectedNodeId(groupName);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedNodeId]);

  const handleAddRoute = useCallback((pos?: [number, number]) => {
    const phases = orchestration.phases ?? [];
    const groupName = uniqueChildName(orchestration, 'route');
    const branchA = uniqueChildName(
      { ...orchestration, phases: [...phases, { name: groupName }] },
      'branch-a',
    );
    const branchB = uniqueChildName(
      {
        ...orchestration,
        phases: [...phases, { name: groupName }, { name: branchA }],
      },
      'branch-b',
    );
    const newPhase: Node = {
      name: groupName,
      route: {
        router: 'agents/router.md',
        branches: {
          [branchA]: { name: branchA, agent: '' },
          [branchB]: { name: branchB, agent: '' },
        },
      },
    };
    const layout = { ...(orchestration._layout ?? {}) };
    // Pin only on drop (drag-from-palette); a click auto-flows + shifts.
    if (pos) layout[groupName] = pos;
    const next = insertPhaseAfter(orchestration, selectedNodeId, newPhase);
    next._layout = layout;
    onChange(next);
    setSelectedNodeId(groupName);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedNodeId]);

  // Drag-from-palette drop. Reads the node kind off the drag payload,
  // projects the drop point into flow space, snaps to the 20px grid (to
  // match snapToGrid), and dispatches to the matching add-handler with the
  // drop position so the node is created exactly where the user let go —
  // the "drag a shape onto the canvas" gesture.
  const handlePaletteDrop = useCallback(
    (event: React.DragEvent) => {
      const kind = event.dataTransfer.getData(
        PALETTE_DND_MIME,
      ) as PaletteDragKind;
      if (!kind) return;
      event.preventDefault();
      const flow = reactFlow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const pos: [number, number] = [
        Math.round(flow.x / 20) * 20,
        Math.round(flow.y / 20) * 20,
      ];
      switch (kind) {
        case 'phase':
          handleAddPhase(pos);
          break;
        case 'agents':
          handleAddAgentsChain(pos);
          break;
        case 'phases':
        case 'parallel':
        case 'converge':
          handleAddComposite(kind, pos);
          break;
        case 'loop':
          handleAddLoop(pos);
          break;
        case 'conversation':
          handleAddConversation(pos);
          break;
        case 'route':
          handleAddRoute(pos);
          break;
      }
    },
    [
      reactFlow,
      handleAddPhase,
      handleAddAgentsChain,
      handleAddComposite,
      handleAddLoop,
      handleAddConversation,
      handleAddRoute,
    ],
  );

  // Commit an inline rename. Walks the tree to update the node's
  // `name` field plus the `_layout` key so the position survives. If
  // the new name collides with an existing phase, rejects via the
  // banner — names are the schema's primary key and have to be
  // unique. Identical name (no actual rename) is a no-op.
  const commitRename = useCallback(
    (oldName: string, rawNewName: string) => {
      setRenamingNodeId(null);
      const newName = rawNewName.trim();
      if (!newName || newName === oldName) return;
      const existingNames = new Set<string>();
      (function collect(n: Node) {
        existingNames.add(n.name);
        for (const k of ['phases', 'parallel', 'converge'] as const) {
          const arr = n[k] as Node[] | undefined;
          if (arr) arr.forEach(collect);
        }
        if (n.loop?.body) collect(n.loop.body);
        if (n.map?.body) collect(n.map.body);
        if (n.route?.branches) Object.values(n.route.branches).forEach(collect);
        if (n.route?.default) collect(n.route.default);
      })(orchestration);
      if (existingNames.has(newName)) {
        setBanner(
          `A phase named "${newName}" already exists — names must be unique.`,
        );
        return;
      }
      const next = updateOrchestrationPhase(orchestration, oldName, p => ({
        ...p,
        name: newName,
      }));
      const layout = { ...(next._layout ?? {}) };
      if (layout[oldName]) {
        layout[newName] = layout[oldName];
        delete layout[oldName];
      }
      onChange({ ...next, _layout: layout });
      if (selectedNodeId === oldName) setSelectedNodeId(newName);
      setBanner(null);
    },
    [orchestration, onChange, selectedNodeId, setSelectedNodeId],
  );

  // Reset every pinned position so the auto-layout algorithm re-places
  // every node from scratch. With syncToSchema now pinning only dragged
  // nodes, this is rarely needed — but it stays as the escape hatch for a
  // layout the user has manually tangled (or legacy stale pins).
  //
  // Clearing _layout alone is NOT enough to reflow visually: the reconcile
  // effect (deps: orchestration.phases) doesn't fire on a _layout-only
  // change, and even when it does it preserves existing in-memory
  // positions. So we re-seed the canvas directly from a fresh auto-layout
  // pass against the cleared orchestration.
  const handleResetLayout = useCallback(() => {
    const cleared = { ...orchestration, _layout: {} };
    onChange(cleared);
    const fresh = buildGraph(cleared, collapsedSet);
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setBanner('Auto-layout reset — every node re-positioned.');
  }, [orchestration, onChange, collapsedSet, setNodes, setEdges, setSelectedNodeId]);

  // Arrow-key nudge + fit-to-selection + select-all + Cmd+0 fit-all.
  // Skips when the focus is inside an <input> / <textarea> / contentEditable
  // so typing in the rename field or side-panel form doesn't move nodes.
  useEffect(() => {
    type KEvt = {
      key: string;
      shiftKey?: boolean;
      metaKey?: boolean;
      ctrlKey?: boolean;
      target?: EventTarget | null;
      preventDefault: () => void;
    };
    const w = globalThis as unknown as {
      addEventListener?: (k: string, fn: (e: KEvt) => void) => void;
      removeEventListener?: (k: string, fn: (e: KEvt) => void) => void;
    };
    if (!w.addEventListener) return;
    function isEditableTarget(t: EventTarget | null | undefined): boolean {
      if (!t) return false;
      const tag = (t as { tagName?: string }).tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      const isCE = (t as { isContentEditable?: boolean }).isContentEditable;
      return !!isCE;
    }
    function onKey(e: KEvt): void {
      if (isEditableTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+0 → fit-to-selection if any selected, else fit-all.
      if (mod && e.key === '0') {
        const ids =
          multiSelectedIds.length > 0
            ? multiSelectedIds
            : selectedNodeId
              ? [selectedNodeId]
              : [];
        if (ids.length > 0) {
          reactFlow.fitView({
            duration: 250,
            padding: 0.25,
            nodes: ids.map(id => ({ id })),
          });
        } else {
          reactFlow.fitView({ duration: 250, padding: 0.2 });
        }
        e.preventDefault();
        return;
      }
      // Cmd/Ctrl+A → select all top-level phases. (RF's built-in is
      // pane-scoped only; this hits every node currently rendered.)
      if (mod && e.key === 'a') {
        const allIds = nodes.map(n => n.id);
        setMultiSelectedIds(allIds);
        setNodes(curr => curr.map(n => ({ ...n, selected: true })));
        e.preventDefault();
        return;
      }
      // Canvas-B clipboard keybindings — only fire when a node is
      // selected (Cmd+C/X/D) or when there's content to paste (Cmd+V
      // anywhere). Indirected through clipboardHandlersRef because
      // handleCopy/Cut/Paste/Duplicate are declared LATER in the
      // component body — referencing them directly here would hit
      // JS's temporal dead zone on first render.
      const activeId =
        selectedNodeId ??
        (multiSelectedIds.length === 1 ? multiSelectedIds[0] : null);
      const ch = clipboardHandlersRef.current;
      if (mod && e.key === 'c' && activeId) {
        ch?.copy(activeId);
        e.preventDefault();
        return;
      }
      if (mod && e.key === 'x' && activeId) {
        ch?.cut(activeId);
        e.preventDefault();
        return;
      }
      if (mod && e.key === 'v') {
        ch?.paste();
        e.preventDefault();
        return;
      }
      if (mod && e.key === 'd' && activeId) {
        ch?.duplicate(activeId);
        e.preventDefault();
        return;
      }
      // F2 → enter rename mode on the selected node. The conventional
      // rename keybinding.
      if (e.key === 'F2' && activeId) {
        setRenamingNodeId(activeId);
        e.preventDefault();
        return;
      }
      // Escape → dismiss the right-click menu if open. (Esc also
      // cancels rename mode via NodeNameLabel's own handler — no
      // conflict because that listener stops propagation first.)
      if (e.key === 'Escape' && contextMenu) {
        setContextMenu(null);
        e.preventDefault();
        return;
      }
      // Arrow-key nudge — works on whatever's selected (multi or single).
      // Step = grid (20px); Shift = 5× (100px). Updates _layout in the
      // orchestration so the change persists across re-renders.
      const isArrow =
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight';
      if (!isArrow) return;
      const ids =
        multiSelectedIds.length > 0
          ? multiSelectedIds
          : selectedNodeId
            ? [selectedNodeId]
            : [];
      if (ids.length === 0) return;
      const step = (e.shiftKey ? 100 : 20);
      const dx =
        e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy =
        e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const layout = { ...(orchestration._layout ?? {}) };
      for (const id of ids) {
        const cur = layout[id];
        const nodePos = nodes.find(n => n.id === id)?.position;
        const baseX = cur ? cur[0] : nodePos?.x ?? LANE_X;
        const baseY = cur ? cur[1] : nodePos?.y ?? TOP_Y;
        layout[id] = [baseX + dx, baseY + dy];
      }
      onChange({ ...orchestration, _layout: layout });
      e.preventDefault();
    }
    w.addEventListener('keydown', onKey);
    return () => w.removeEventListener?.('keydown', onKey);
  }, [
    orchestration,
    onChange,
    selectedNodeId,
    multiSelectedIds,
    nodes,
    reactFlow,
    setNodes,
    contextMenu,
  ]);

  const handleEditField = useCallback(
    (field: keyof Node, value: unknown) => {
      if (!selectedNodeId) return;
      const renamed =
        field === 'name' && typeof value === 'string' && value !== selectedNodeId
          ? value
          : null;
      const next = updateOrchestrationPhase(orchestration, selectedNodeId, p => {
        const updated = { ...p } as Node;
        if (value === '' || value === false || value === undefined) {
          delete (updated as Record<string, unknown>)[field as string];
        } else {
          (updated as Record<string, unknown>)[field as string] = value;
        }
        return updated;
      });
      if (renamed) {
        const layout = { ...(next._layout ?? {}) };
        if (layout[selectedNodeId]) {
          layout[renamed] = layout[selectedNodeId];
          delete layout[selectedNodeId];
        }
        onChange({ ...next, _layout: layout });
        setSelectedNodeId(renamed);
      } else {
        onChange(next);
      }
    },
    [selectedNodeId, orchestration, onChange, setSelectedNodeId],
  );

  /** Edit a field inside `phase.loop` for a specific loop-composite name. */
  const handleEditLoopField = useCallback(
    (loopName: string, field: string, value: unknown) => {
      const next = updateOrchestrationPhase(orchestration, loopName, p => {
        if (!p.loop) return p;
        const newLoop = { ...p.loop } as Record<string, unknown>;
        if (value === '' || value === false || value === undefined) {
          delete newLoop[field];
        } else {
          newLoop[field] = value;
        }
        return { ...p, loop: newLoop } as Node;
      });
      onChange(next);
    },
    [orchestration, onChange],
  );

  /** If the selected node is a body child of a flattened loop, this is that
   * parent loop composite. Lets the side panel surface its conditions. */
  const parentLoopOfSelected = useMemo(() => {
    const id =
      selectedNodeId ?? (multiSelectedIds.length === 1 ? multiSelectedIds[0] : null);
    if (!id) return null;
    const selNode = nodes.find(n => n.id === id);
    const parentName = selNode?.data?.parentComposite;
    if (!parentName) return null;
    const parent = allPhases.get(parentName);
    return parent?.loop ? parent : null;
  }, [selectedNodeId, multiSelectedIds, nodes, allPhases]);

  // Canvas-B clipboard ops. findPhaseByName walks the tree (nested
  // composites included) and returns a copy of the matching phase or
  // null. Used by Copy and Duplicate.
  const findPhaseByName = useCallback(
    (root: Node, target: string): Node | null => {
      if (root.name === target) return JSON.parse(JSON.stringify(root));
      for (const key of ['phases', 'parallel', 'converge'] as const) {
        const arr = root[key] as Node[] | undefined;
        if (arr) {
          for (const c of arr) {
            const hit = findPhaseByName(c, target);
            if (hit) return hit;
          }
        }
      }
      if (root.loop?.body) {
        const hit = findPhaseByName(root.loop.body, target);
        if (hit) return hit;
      }
      if (root.map?.body) {
        const hit = findPhaseByName(root.map.body, target);
        if (hit) return hit;
      }
      if (root.route?.branches) {
        for (const b of Object.values(root.route.branches)) {
          const hit = findPhaseByName(b, target);
          if (hit) return hit;
        }
      }
      return null;
    },
    [],
  );

  const handleCopy = useCallback(
    (targetId: string) => {
      const found = findPhaseByName(orchestration, targetId);
      if (found) clipboardRef.current = found;
    },
    [orchestration, findPhaseByName],
  );

  const handlePaste = useCallback(() => {
    if (!clipboardRef.current) return;
    const taken = new Set<string>();
    collectTakenNames(orchestration, taken);
    const cloned = renameSubtree(clipboardRef.current, taken);
    // Un-pinned: the pasted (or duplicated) subtree slots into the chain
    // after the selection and shifts the rest down — same as a palette add.
    const next = insertPhaseAfter(orchestration, selectedNodeId, cloned);
    onChange(next);
    setSelectedNodeId(cloned.name);
    setSelectedEdgeId(null);
  }, [orchestration, selectedNodeId, onChange, setSelectedNodeId]);

  const handleDuplicate = useCallback(
    (targetId: string) => {
      handleCopy(targetId);
      handlePaste();
    },
    [handleCopy, handlePaste],
  );

  // Wrap a node in a loop / group composite via the shared op. Drop the old
  // pin for the wrapped node so the new wrapper (and the now-nested body)
  // auto-layout into the chain — same un-pinned behavior as paste, so no
  // stale (0,0) position or jump.
  const handleWrap = useCallback(
    (targetId: string, kind: 'loop' | 'phases') => {
      const wrapperName = uniqueName(orchestration, `${targetId}-${kind}`);
      const next = wrapInComposite(orchestration, targetId, kind);
      const layout = { ...(next._layout ?? {}) };
      delete layout[targetId];
      onChange({ ...next, _layout: layout });
      setSelectedNodeId(wrapperName);
      setSelectedEdgeId(null);
    },
    [orchestration, onChange, setSelectedNodeId],
  );

  const handleCut = useCallback(
    (targetId: string) => {
      const found = findPhaseByName(orchestration, targetId);
      if (!found) return;
      clipboardRef.current = found;
      const next = updateOrchestrationPhase(orchestration, targetId, () => null);
      const layout = { ...(next._layout ?? {}) };
      delete layout[targetId];
      onChange({ ...next, _layout: layout });
      if (selectedNodeId === targetId) setSelectedNodeId(null);
    },
    [findPhaseByName, orchestration, onChange, selectedNodeId, setSelectedNodeId],
  );

  // Sync the clipboard handlers into clipboardHandlersRef so the
  // earlier-declared keyboard listener can call them without
  // triggering JS's temporal dead zone.
  useEffect(() => {
    clipboardHandlersRef.current = {
      copy: handleCopy,
      paste: handlePaste,
      cut: handleCut,
      duplicate: handleDuplicate,
    };
  }, [handleCopy, handlePaste, handleCut, handleDuplicate]);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return;
    const next = updateOrchestrationPhase(orchestration, selectedNodeId, () => null);
    const layout = { ...(next._layout ?? {}) };
    delete layout[selectedNodeId];
    const nextEdges = edges.filter(
      e => e.source !== selectedNodeId && e.target !== selectedNodeId,
    );
    setEdges(nextEdges);
    onChange({ ...next, _layout: layout });
    setSelectedNodeId(null);
  }, [selectedNodeId, orchestration, edges, setEdges, onChange, setSelectedNodeId]);

  const handleEdgeTypeChange = useCallback(
    (newType: EdgeType) => {
      if (!selectedEdgeId) return;
      const target = edges.find(e => e.id === selectedEdgeId);
      const composite = target?.data?.composite;
      const nextEdges = edges.map(e => {
        if (e.id !== selectedEdgeId) return e;
        return edgeForType(e.source, e.target, newType, composite, e.id);
      });
      setEdges(nextEdges);
      syncToSchema(nodes, nextEdges);
    },
    [selectedEdgeId, edges, nodes, setEdges, syncToSchema],
  );

  const handleEdgeCompositeFieldChange = useCallback(
    (field: keyof CompositeMeta, value: string | boolean | undefined) => {
      if (!selectedEdgeId) return;
      const target = edges.find(e => e.id === selectedEdgeId);
      if (!target) return;
      const currentMeta = target.data?.composite ?? { name: target.id };
      const newMeta: CompositeMeta = { ...currentMeta };
      if (value === '' || value === undefined || value === false) {
        delete (newMeta as Record<string, unknown>)[field as string];
      } else {
        (newMeta as Record<string, unknown>)[field as string] = value;
      }
      if (!newMeta.name) newMeta.name = currentMeta.name;
      // Propagate to all sibling fork edges (same source + same type).
      const sibIds = new Set(
        edges
          .filter(
            e =>
              e.source === target.source &&
              e.data?.type === target.data?.type &&
              e.data?.type !== 'handoff',
          )
          .map(e => e.id),
      );
      const nextEdges = edges.map(e =>
        sibIds.has(e.id)
          ? edgeForType(
              e.source,
              e.target,
              // Decorative 'loop-back' isn't a real fork EdgeType — fall back
              // to 'handoff' (these are fork siblings being re-typed).
              e.data?.type && e.data.type !== 'loop-back'
                ? e.data.type
                : 'handoff',
              newMeta,
              e.id,
            )
          : e,
      );
      setEdges(nextEdges);
      syncToSchema(nodes, nextEdges);
    },
    [selectedEdgeId, edges, nodes, setEdges, syncToSchema],
  );

  const handleDeleteEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    const nextEdges = edges.filter(e => e.id !== selectedEdgeId);
    setEdges(nextEdges);
    setSelectedEdgeId(null);
    syncToSchema(nodes, nextEdges);
  }, [selectedEdgeId, edges, nodes, setEdges, syncToSchema]);

  /**
   * Selected graph-node IDs resolved to top-level phases of the orchestration.
   *
   * If the user selects a flattened child (e.g. `unit` inside `qa.parallel`),
   * we resolve it back to its parent composite (`qa`). That way selecting any
   * combination of visible nodes works naturally — `implement + unit + ui +
   * review` collapses to `[implement, qa, review]` for the group/loop action.
   *
   * The result preserves the order phases appear in `orchestration.phases`.
   */
  const selectedTopLevel = useMemo(() => {
    const topLevelNames = new Set(
      (orchestration.phases ?? []).map(p => p.name),
    );
    const resolved = new Set<string>();
    for (const id of multiSelectedIds) {
      if (topLevelNames.has(id)) {
        resolved.add(id);
        continue;
      }
      const node = nodes.find(n => n.id === id);
      const parent = node?.data?.parentComposite;
      if (parent && topLevelNames.has(parent)) resolved.add(parent);
    }
    return (orchestration.phases ?? [])
      .map(p => p.name)
      .filter(n => resolved.has(n));
  }, [multiSelectedIds, orchestration.phases, nodes]);

  function wrapSelectionAs(kind: 'phases' | 'loop') {
    if (selectedTopLevel.length === 0) {
      setBanner('Select at least one top-level phase to group.');
      return;
    }
    const topByIndex = new Map<string, number>();
    (orchestration.phases ?? []).forEach((p, i) => topByIndex.set(p.name, i));
    const sortedIndices = selectedTopLevel
      .map(id => topByIndex.get(id))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b);
    const contiguous = sortedIndices.every(
      (idx, i) => i === 0 || idx === sortedIndices[i - 1] + 1,
    );
    if (!contiguous) {
      setBanner(
        'Selected phases must be contiguous in the chain to group (no gaps).',
      );
      return;
    }

    const phases = orchestration.phases ?? [];
    const start = sortedIndices[0];
    const end = sortedIndices[sortedIndices.length - 1];
    const children = phases.slice(start, end + 1);
    const baseName = kind === 'loop' ? 'loop' : 'group';
    const groupName = uniqueChildName(orchestration, baseName);

    let newComposite: Node;
    if (kind === 'phases') {
      newComposite = { name: groupName, phases: children };
    } else {
      // loop with a phases body if >1 child, single body otherwise
      const bodyName = uniqueChildName(
        { ...orchestration, phases: [...phases, { name: groupName }] },
        'loop-body',
      );
      const body: Node =
        children.length === 1
          ? children[0]
          : { name: bodyName, phases: children };
      newComposite = {
        name: groupName,
        loop: { body, maxIterations: 5, until: '[APPROVED]' },
      };
    }

    // Carry the group's layout from the first child's position (so it lands
    // where the user saw the first member).
    const layout = { ...(orchestration._layout ?? {}) };
    const firstChildPos = layout[children[0].name];
    if (firstChildPos) layout[groupName] = firstChildPos;
    // Drop layout entries for children that are now hidden inside the composite.
    for (const c of children) delete layout[c.name];

    const newPhases = [
      ...phases.slice(0, start),
      newComposite,
      ...phases.slice(end + 1),
    ];
    onChange({ ...orchestration, phases: newPhases, _layout: layout });
    setSelectedNodeId(groupName);
    setMultiSelectedIds([]);
    setBanner(null);
  }

  const handleGroupSelected = useCallback(() => {
    wrapSelectionAs('phases');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedTopLevel]);

  const handleWrapInLoop = useCallback(() => {
    wrapSelectionAs('loop');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration, onChange, selectedTopLevel]);

  /** Expand a phases/loop composite back into its constituent phases. */
  const handleUngroup = useCallback(() => {
    if (!selectedNodeId) return;
    const phases = orchestration.phases ?? [];
    const idx = phases.findIndex(p => p.name === selectedNodeId);
    if (idx < 0) {
      setBanner('Can only ungroup top-level composites.');
      return;
    }
    const target = phases[idx];
    let children: Node[] = [];
    if (Array.isArray(target.phases)) {
      children = target.phases;
    } else if (target.loop) {
      const body = target.loop.body;
      children = Array.isArray(body.phases) ? body.phases : [body];
    } else {
      setBanner('Only phases or loop composites can be ungrouped.');
      return;
    }
    const layout = { ...(orchestration._layout ?? {}) };
    delete layout[target.name];
    // Auto-position the released children at row positions starting at the
    // composite's old slot.
    const baseY =
      layout[target.name]?.[1] ?? TOP_Y + idx * ROW_SPACING;
    children.forEach((c, j) => {
      if (!layout[c.name]) layout[c.name] = [LANE_X, baseY + j * ROW_SPACING];
    });
    const newPhases = [
      ...phases.slice(0, idx),
      ...children,
      ...phases.slice(idx + 1),
    ];
    onChange({ ...orchestration, phases: newPhases, _layout: layout });
    setSelectedNodeId(children[0]?.name ?? null);
    setMultiSelectedIds([]);
  }, [selectedNodeId, orchestration, onChange, setSelectedNodeId]);

  return (
    <CollapseCtx.Provider value={toggleCollapsed}>
    <RenameCtx.Provider value={{
      renamingId: renamingNodeId,
      commit: commitRename,
      cancel: () => setRenamingNodeId(null),
    }}>
    <HoverCtx.Provider value={{
      hoveredId: hoveredNodeId,
      onAddAbove: handleAddAbove,
      onAddBelow: handleAddBelow,
    }}>
    <EdgeInsertCtx.Provider value={{
      hoveredEdgeId,
      onInsert: handleInsertOnEdge,
    }}>
    <div style={canvasWrap}>
      <Palette
        nextEdgeType={nextEdgeType}
        onPickEdgeType={setNextEdgeType}
        onAddPhase={() => handleAddPhase()}
        onAddParallelGroup={() => handleAddComposite('parallel')}
        onAddConvergeGroup={() => handleAddComposite('converge')}
        onAddPhaseGroup={() => handleAddComposite('phases')}
        onAddAgentsChain={() => handleAddAgentsChain()}
        onAddLoop={() => handleAddLoop()}
        onAddConversation={() => handleAddConversation()}
        onAddRoute={() => handleAddRoute()}
        selectedTopLevelCount={selectedTopLevel.length}
        onGroupSelected={handleGroupSelected}
        onWrapInLoop={handleWrapInLoop}
        onResetLayout={handleResetLayout}
      />
      <div
        style={canvasArea}
        onDragOver={e => {
          // Only intercept palette drags; let other DnD pass through.
          if (e.dataTransfer.types.includes(PALETTE_DND_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={handlePaletteDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, n) => {
            setSelectedNodeId(n.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, e) => {
            setSelectedEdgeId(e.id);
            setSelectedNodeId(null);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          onNodeDrag={handleDrag}
          onNodeDragStop={handleDragStop}
          onConnect={handleConnect}
          // Drawing edges "felt off" because a connection only registered if
          // you released exactly on the 10px handle. A bigger snap radius lets
          // you drop *near* a target node and it connects; the dashed blue
          // connection line makes the in-progress drag obvious.
          connectionRadius={40}
          connectionLineStyle={{ stroke: '#2563eb', strokeWidth: 2, strokeDasharray: '4 4' }}
          onNodeMouseEnter={(_e, n) => setHoveredNodeId(n.id)}
          onNodeMouseLeave={() => setHoveredNodeId(null)}
          onPaneMouseLeave={() => {
            setHoveredNodeId(null);
            setHoveredEdgeId(null);
          }}
          onEdgeMouseEnter={(_e, ed) => setHoveredEdgeId(ed.id)}
          onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          edgeTypes={EDGE_TYPES}
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            setContextMenu({
              x: (e as unknown as MouseEvent).clientX,
              y: (e as unknown as MouseEvent).clientY,
              kind: 'node',
              targetId: n.id,
            });
          }}
          onEdgeContextMenu={(e, ed) => {
            e.preventDefault();
            setContextMenu({
              x: (e as unknown as MouseEvent).clientX,
              y: (e as unknown as MouseEvent).clientY,
              kind: 'edge',
              targetId: ed.id,
            });
          }}
          onPaneContextMenu={evt => {
            const e = evt as unknown as MouseEvent;
            e.preventDefault();
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              kind: 'pane',
              targetId: null,
            });
          }}
          // Canvas-A drag-to-pane spawn. onConnectStart fires when the
          // user grabs a node port; we remember the origin. onConnectEnd
          // fires when the drag releases — if it released on empty pane
          // (not on a real handle), we synthesize a new node + edge at
          // the drop position. onConnect (existing) handles the
          // node->node case.
          onConnectStart={(_e, params) => {
            dragOriginRef.current = {
              nodeId: params.nodeId ?? '',
              handleId: params.handleId ?? null,
              handleType: params.handleType ?? null,
            };
          }}
          onConnectEnd={evt => {
            const origin = dragOriginRef.current;
            dragOriginRef.current = null;
            if (!origin || !origin.nodeId) return;
            const target = (evt as unknown as { target?: Element }).target;
            const tCls = target?.className;
            const tStr =
              typeof tCls === 'string'
                ? tCls
                : (tCls as { baseVal?: string } | undefined)?.baseVal ?? '';
            if (tStr.includes('react-flow__handle')) return;
            const me = evt as unknown as MouseEvent;
            const point = Number.isFinite(me.clientX)
              ? { x: me.clientX, y: me.clientY }
              : null;
            if (!point) return;
            const flowPos = reactFlow.screenToFlowPosition({
              x: point.x,
              y: point.y,
            });
            const newName = uniqueChildName(orchestration, 'phase');
            const newPhase: Node = { name: newName };
            const isSource = origin.handleType === 'source';
            const next = isSource
              ? insertPhaseAfter(orchestration, origin.nodeId, newPhase)
              : insertPhaseBefore(orchestration, origin.nodeId, newPhase);
            const layout = { ...(orchestration._layout ?? {}) };
            layout[newName] = [Math.round(flowPos.x), Math.round(flowPos.y)];
            next._layout = layout;
            onChange(next);
            setSelectedNodeId(newName);
            setSelectedEdgeId(null);
            setRenamingNodeId(newName);
          }}
          onSelectionChange={({ nodes: ns }) => {
            const next = ns.map(n => n.id);
            setMultiSelectedIds(prev =>
              prev.length === next.length && prev.every((id, i) => id === next[i])
                ? prev
                : next,
            );
          }}
          nodesConnectable
          multiSelectionKeyCode={['Meta', 'Shift']}
          // Delete / Backspace on selected node fires onNodesDelete →
          // we route to the same handler the side-panel Delete button
          // uses. Lets graph editing feel like a real canvas.
          deleteKeyCode={['Backspace', 'Delete']}
          onNodesDelete={deleted => {
            if (deleted.length === 0) return;
            // Route the first deletion through the existing single-node
            // delete handler; ReactFlow already removed the node from
            // its internal state but our orchestration is the source
            // of truth.
            for (const d of deleted) {
              setSelectedNodeId(d.id);
              handleDeleteNode();
            }
          }}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          snapToGrid
          snapGrid={[20, 20]}
          // A click with sub-pixel jitter must not register as a drag (which
          // would needlessly pin the node). 4px is below an intentional drag.
          nodeDragThreshold={4}
          onNodeDoubleClick={(_e, n) => setRenamingNodeId(n.id)}
          proOptions={{ hideAttribution: true }}>
          <Background gap={20} color="#e5e7eb" />
          <Controls showInteractive={false} />
          {/* Structural-complexity badge — tier + score for the whole tree,
              colored by tier. A generic, domain-agnostic metric (see
              lib/complexity.ts); the same number shows on the pipeline list +
              detail line so the heavy flows are spottable everywhere. */}
          <Panel position="top-right">
            <ComplexityPanelBadge orchestration={orchestration} />
          </Panel>
          {/* Display-only: pointer-events off so the minimap never steals a
              click from a node badge/button sitting over it (the bottom-left
              region). Pan via the canvas drag; the minimap stays as an
              orientation overview. */}
          <MiniMap position="bottom-left" style={{ pointerEvents: 'none' }} />
          <AlignmentGuides
            vertical={alignGuides.vertical}
            horizontal={alignGuides.horizontal}
          />
        </ReactFlow>

        {banner && (
          <div style={bannerStyle}>
            <strong style={{ marginRight: 6 }}>⚠️</strong>
            {banner}
          </div>
        )}

        {contextMenu && (
          <>
            <div
              onClick={() => setContextMenu(null)}
              onContextMenu={e => {
                e.preventDefault();
                setContextMenu(null);
              }}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 99,
              }}
            />
            <div
              style={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 100,
                minWidth: 200,
                backgroundColor: '#ffffff',
                borderRadius: 6,
                border: '1px solid #e5e7eb',
                boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                padding: '4px 0',
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              }}>
              {contextMenu.kind === 'node' && contextMenu.targetId && (
                <>
                  <ContextMenuItem
                    label="Rename"
                    hint="F2"
                    onClick={() => {
                      setRenamingNodeId(contextMenu.targetId);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Add phase above"
                    hint="hover ↑"
                    onClick={() => {
                      handleAddAbove(contextMenu.targetId!);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Add phase below"
                    hint="hover ↓"
                    onClick={() => {
                      handleAddBelow(contextMenu.targetId!);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuDivider />
                  <ContextMenuItem
                    label="Duplicate"
                    hint="⌘D"
                    onClick={() => {
                      handleDuplicate(contextMenu.targetId!);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Wrap in loop"
                    onClick={() => {
                      handleWrap(contextMenu.targetId!, 'loop');
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Wrap in group"
                    onClick={() => {
                      handleWrap(contextMenu.targetId!, 'phases');
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Cut"
                    hint="⌘X"
                    onClick={() => {
                      handleCut(contextMenu.targetId!);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Copy"
                    hint="⌘C"
                    onClick={() => {
                      handleCopy(contextMenu.targetId!);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Paste below"
                    hint="⌘V"
                    disabled={!clipboardRef.current}
                    onClick={() => {
                      // Select first so paste lands beneath this node.
                      setSelectedNodeId(contextMenu.targetId);
                      setTimeout(() => handlePaste(), 0);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuDivider />
                  <ContextMenuItem
                    label="Delete"
                    danger
                    hint="⌫"
                    onClick={() => {
                      setSelectedNodeId(contextMenu.targetId);
                      setTimeout(() => handleDeleteNode(), 0);
                      setContextMenu(null);
                    }}
                  />
                </>
              )}
              {contextMenu.kind === 'edge' && contextMenu.targetId && (
                <>
                  <ContextMenuItem
                    label="Insert phase here"
                    onClick={() => {
                      const ed = edges.find(e => e.id === contextMenu.targetId);
                      if (ed) handleInsertOnEdge(ed.source);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuDivider />
                  {(['handoff', 'parallel', 'converge'] as const).map(t => {
                    const ed = edges.find(e => e.id === contextMenu.targetId);
                    const current = ed?.data?.type;
                    return (
                      <ContextMenuItem
                        key={t}
                        label={`Set type: ${t}${current === t ? ' ✓' : ''}`}
                        onClick={() => {
                          setSelectedEdgeId(contextMenu.targetId);
                          // Defer one tick so handleEdgeTypeChange sees
                          // the newly-set selection.
                          setTimeout(() => handleEdgeTypeChange(t), 0);
                          setContextMenu(null);
                        }}
                      />
                    );
                  })}
                </>
              )}
              {contextMenu.kind === 'pane' && (
                <>
                  <ContextMenuItem
                    label="Add phase here"
                    onClick={() => {
                      const flowPos = reactFlow.screenToFlowPosition({
                        x: contextMenu.x,
                        y: contextMenu.y,
                      });
                      const newName = uniqueChildName(orchestration, 'phase');
                      const newPhase: Node = { name: newName };
                      const next = {
                        ...orchestration,
                        phases: [...(orchestration.phases ?? []), newPhase],
                      };
                      const layout = { ...(orchestration._layout ?? {}) };
                      layout[newName] = [
                        Math.round(flowPos.x),
                        Math.round(flowPos.y),
                      ];
                      onChange({ ...next, _layout: layout });
                      setSelectedNodeId(newName);
                      setRenamingNodeId(newName);
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Paste here"
                    hint="⌘V"
                    disabled={!clipboardRef.current}
                    onClick={() => {
                      handlePaste();
                      setContextMenu(null);
                    }}
                  />
                  <ContextMenuItem
                    label="Reset auto-layout"
                    onClick={() => {
                      handleResetLayout();
                      setContextMenu(null);
                    }}
                  />
                </>
              )}
            </div>
          </>
        )}

        {selectedPhase && !selectedEdge && (
          <NodeSidePanel
            phase={selectedPhase}
            parentLoop={parentLoopOfSelected}
            isTopLevel={
              (orchestration.phases ?? []).some(p => p.name === selectedPhase.name)
            }
            availableOrchestrations={(availableOrchestrations ?? []).filter(
              n => n !== orchestration.name,
            )}
            onClose={() => {
              // Clearing selectedNodeId alone leaves the side panel open
              // because of the multiSelectedIds fallback above: ReactFlow's
              // internal selection still has this node selected, so the
              // fallback resolves selectedPhase to the same node. Force
              // every node to selected:false to flush both states.
              setSelectedNodeId(null);
              setNodes(ns =>
                ns.map(n => (n.selected ? { ...n, selected: false } : n)),
              );
            }}
            onEdit={handleEditField}
            onEditLoop={handleEditLoopField}
            onDelete={handleDeleteNode}
            onUngroup={handleUngroup}
            onAddChild={handleAddChild}
          />
        )}

        {selectedEdge && (
          <EdgeSidePanel
            edge={selectedEdge}
            onClose={() => setSelectedEdgeId(null)}
            onChangeType={handleEdgeTypeChange}
            onChangeCompositeField={handleEdgeCompositeFieldChange}
            onDelete={handleDeleteEdge}
          />
        )}
      </div>
    </div>
    </EdgeInsertCtx.Provider>
    </HoverCtx.Provider>
    </RenameCtx.Provider>
    </CollapseCtx.Provider>
  );
}

/** Collapsible palette section. Persists open/closed state in localStorage. */
function PaletteSection({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `sammy.palette.section.${title.toLowerCase()}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === 'open') return true;
      if (v === 'closed') return false;
    } catch {
      /* */
    }
    return defaultOpen;
  });

  function toggle() {
    setOpen(prev => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? 'open' : 'closed');
      } catch {
        /* */
      }
      return next;
    });
  }

  return (
    <div style={paletteSection}>
      <button onClick={toggle} style={sectionHeaderButton}>
        <span style={sectionChevron}>{open ? '▼' : '▶'}</span>
        <span style={paletteHeader}>
          {title}
          {badge ? ` · ${badge}` : ''}
        </span>
      </button>
      {open && <div style={sectionBody}>{children}</div>}
    </div>
  );
}

function Palette({
  nextEdgeType,
  onPickEdgeType,
  onAddPhase,
  onAddParallelGroup,
  onAddConvergeGroup,
  onAddPhaseGroup,
  onAddAgentsChain,
  onAddLoop,
  onAddConversation,
  onAddRoute,
  selectedTopLevelCount,
  onGroupSelected,
  onWrapInLoop,
  onResetLayout,
}: {
  nextEdgeType: EdgeType;
  onPickEdgeType: (t: EdgeType) => void;
  onAddPhase: () => void;
  onAddParallelGroup: () => void;
  onAddConvergeGroup: () => void;
  onAddPhaseGroup: () => void;
  onAddAgentsChain: () => void;
  onAddLoop: () => void;
  onAddConversation: () => void;
  onAddRoute: () => void;
  selectedTopLevelCount: number;
  onGroupSelected: () => void;
  onWrapInLoop: () => void;
  onResetLayout: () => void;
}) {
  return (
    <div style={paletteWrap}>
      <PaletteSection title="Basic">
        <PaletteItem
          icon="◇"
          label="Phase"
          hint="single agent (fill in path after)"
          onPress={onAddPhase}
          color="#2563eb"
          dragKind="phase"
        />
        <PaletteItem
          icon="▤"
          label="Multi-agent"
          hint="phase with a serial chain of agents"
          onPress={onAddAgentsChain}
          color="#6b7280"
          dragKind="agents"
        />
        <PaletteItem
          icon="▥"
          label="Phase group"
          hint="nested sequence of phases"
          onPress={onAddPhaseGroup}
          color="#7c3aed"
          dragKind="phases"
        />
      </PaletteSection>

      <PaletteSection title="Fan-out">
        <PaletteItem
          icon="⫴"
          label="Parallel group"
          hint="branches run concurrently, no shared outputs"
          onPress={onAddParallelGroup}
          color="#059669"
          dragKind="parallel"
        />
        <PaletteItem
          icon="⋈"
          label="Converge group"
          hint="branches rejoin via a merger agent"
          onPress={onAddConvergeGroup}
          color="#d97706"
          dragKind="converge"
        />
      </PaletteSection>

      <PaletteSection title="Control flow">
        <PaletteItem
          icon="↻"
          label="Loop"
          hint="run body up to N times, optional stop signal"
          onPress={onAddLoop}
          color="#0891b2"
          dragKind="loop"
        />
        <PaletteItem
          icon="💬"
          label="Conversation"
          hint="participants alternate turns over a shared transcript"
          onPress={onAddConversation}
          color="#e11d48"
          dragKind="conversation"
        />
        <PaletteItem
          icon="⋔"
          label="Route"
          hint="router agent picks one of N labelled branches"
          onPress={onAddRoute}
          color="#65a30d"
          dragKind="route"
        />
      </PaletteSection>

      <PaletteSection
        title="Actions"
        badge={selectedTopLevelCount > 0 ? `${selectedTopLevelCount} selected` : undefined}>
        <div style={paletteHint}>
          Shift/⌘-click any nodes, then wrap. Flattened composite children
          (e.g. parallel branches) automatically resolve to their parent
          composite. Selection must be contiguous in the chain.
        </div>
        <button
          onClick={onGroupSelected}
          disabled={selectedTopLevelCount < 1}
          style={{
            ...actionButton,
            opacity: selectedTopLevelCount < 1 ? 0.5 : 1,
          }}>
          ▥ Group as phase
        </button>
        <button
          onClick={onWrapInLoop}
          disabled={selectedTopLevelCount < 1}
          style={{
            ...actionButton,
            opacity: selectedTopLevelCount < 1 ? 0.5 : 1,
          }}>
          ↻ Wrap in loop
        </button>
      </PaletteSection>

      <PaletteSection title="Layout">
        <div style={paletteHint}>
          The auto-layout algorithm only positions nodes that haven&apos;t
          been dragged. Once you drag anything, every visible node gets
          pinned — re-running auto-layout requires clearing those pins.
        </div>
        <button onClick={onResetLayout} style={actionButton}>
          ⤺ Reset auto-layout
        </button>
        <div style={paletteHint}>
          Keyboard: Arrows nudge selected nodes by 20px (Shift = 100px) ·
          ⌘0 fits the view to selection (or all if none) · double-click a
          node to rename · ⌘A selects every node.
        </div>
      </PaletteSection>

      <PaletteSection title="Next edge">
        <div style={paletteHint}>
          Type used when you drag from one node's right handle to another's left.
        </div>
        {(['handoff', 'parallel', 'converge'] as const).map(t => {
          const active = t === nextEdgeType;
          return (
            <button
              key={t}
              onClick={() => onPickEdgeType(t)}
              style={{
                ...edgeChip,
                borderColor: active ? EDGE_COLOR[t] : '#d1d5db',
                backgroundColor: active ? `${EDGE_COLOR[t]}1a` : '#ffffff',
                color: active ? EDGE_COLOR[t] : '#374151',
                fontWeight: active ? 700 : 500,
              }}>
              <span style={{ marginRight: 6 }}>{t === 'handoff' ? '→' : t === 'parallel' ? '⇉' : '↪'}</span>
              {t}
            </button>
          );
        })}
      </PaletteSection>

      <PaletteSection title="Tips" defaultOpen={false}>
        <div style={paletteHint}>Click a node to edit · click an edge to change type · drag to connect</div>
      </PaletteSection>
    </div>
  );
}

function NodeSidePanel({
  phase,
  parentLoop,
  isTopLevel,
  availableOrchestrations,
  onClose,
  onEdit,
  onEditLoop,
  onDelete,
  onUngroup,
  onAddChild,
}: {
  phase: Node;
  parentLoop: Node | null;
  isTopLevel: boolean;
  availableOrchestrations: string[];
  onClose: () => void;
  onEdit: (field: keyof Node, value: unknown) => void;
  onEditLoop: (loopName: string, field: string, value: unknown) => void;
  onDelete: () => void;
  onUngroup: () => void;
  onAddChild: (kind: AddChildKind) => void;
}) {
  const composite = compositeKey(phase);
  const canUngroup =
    isTopLevel && (composite === 'phases' || composite === 'loop');
  // Show loop conditions if the selected phase IS a loop, or is a body child
  // of one (then it surfaces the parent loop's conditions for easy editing).
  const loopForFields: Node | null =
    composite === 'loop' && phase.loop ? phase : parentLoop;
  // Body type controls which body field the leaf phase uses.
  // - 'agent'   → phase.agent is the LLM file path
  // - 'subflow' → phase.subflow nests another orchestration by name
  // Mutually exclusive: setting one clears the other. Composite phases
  // (phases/loop/route/etc.) bypass this picker entirely.
  const currentBodyKind: 'agent' | 'subflow' =
    phase.subflow ? 'subflow' : 'agent';
  function switchBodyKind(next: 'agent' | 'subflow'): void {
    if (next === currentBodyKind) return;
    if (next === 'agent') {
      onEdit('subflow', undefined);
      if (!phase.agent) onEdit('agent', 'agents/');
    } else {
      onEdit('agent', undefined);
      // Default to first available orchestration (or empty if none).
      onEdit('subflow', availableOrchestrations[0] ?? '');
    }
  }
  return (
    <div style={panel}>
      <div style={panelHeader}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Edit phase</span>
        <button onClick={onClose} style={panelClose}>×</button>
      </div>

      <Field label="Name">
        <input
          type="text"
          value={phase.name}
          onChange={e => onEdit('name', e.target.value)}
          style={inputStyle}
        />
      </Field>

      {composite ? (
        acceptsChildren(phase) ? (
          <Field
            label={`Children (${
              Array.isArray(phase[composite]) ? (phase[composite] as unknown[]).length : 0
            })`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(
                [
                  ['phase', '◇ Phase'],
                  ['agents', '▤ Multi-agent'],
                  ['phases', '▥ Group'],
                  ['parallel', '⫴ Parallel'],
                  ['converge', '⋈ Converge'],
                  ['loop', '↻ Loop'],
                ] as Array<[AddChildKind, string]>
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  onClick={() => onAddChild(kind)}
                  style={addChildButton}
                  title={`Add a ${kind} inside this ${composite}`}>
                  + {label}
                </button>
              ))}
            </div>
            <div style={panelHint}>
              Adds inside this {composite}. The new child is selected so you can
              fill it in — nest as deep as you like.
            </div>
          </Field>
        ) : (
          <div style={panelHint}>
            Composite phase ({composite} ·{' '}
            {compositeChildCount(phase, composite)} children). Edit its
            branches/body in Pipeline or Tree view; rename / lock / describe
            here.
          </div>
        )
      ) : (
        <>
          <Field label="Body">
            <div style={{ display: 'flex', gap: 4 }}>
              {(['agent', 'subflow'] as const).map(kind => {
                const active = currentBodyKind === kind;
                return (
                  <button
                    key={kind}
                    onClick={() => switchBodyKind(kind)}
                    style={{
                      flex: 1,
                      padding: '5px 10px',
                      fontSize: 11,
                      fontWeight: 600,
                      border: '1px solid ' + (active ? '#2563eb' : '#d1d5db'),
                      borderRadius: 6,
                      background: active ? '#2563eb' : '#ffffff',
                      color: active ? '#ffffff' : '#374151',
                      cursor: 'pointer',
                    }}>
                    {kind === 'agent' ? '🤖 Agent' : '🔗 Subflow'}
                  </button>
                );
              })}
            </div>
          </Field>

          {currentBodyKind === 'agent' && (
            <Field label="Agent path">
              <input
                type="text"
                value={phase.agent ?? ''}
                onChange={e => onEdit('agent', e.target.value)}
                placeholder="agents/pm.md"
                style={inputStyle}
              />
            </Field>
          )}

          {currentBodyKind === 'subflow' && (
            <Field label="Subflow (orchestration to nest)">
              {availableOrchestrations.length === 0 ? (
                <div style={panelHint}>
                  No other orchestrations exist yet — create one first to nest it here.
                </div>
              ) : (
                <select
                  value={phase.subflow ?? ''}
                  onChange={e => onEdit('subflow', e.target.value)}
                  style={inputStyle}>
                  <option value="">— pick an orchestration —</option>
                  {availableOrchestrations.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
              <div style={panelHint}>
                The selected orchestration runs inline here. State is shared:
                its `as:` writes propagate to this orchestration's downstream
                phases. Cycles (A nests B nests A) are detected on save.
              </div>
            </Field>
          )}
        </>
      )}

      <Field label="Description">
        <textarea
          value={phase.description ?? ''}
          onChange={e => onEdit('description', e.target.value)}
          placeholder="What does this phase do?"
          style={{ ...inputStyle, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </Field>

      <label style={lockRow}>
        <input
          type="checkbox"
          checked={!!phase.lock}
          onChange={e => onEdit('lock', e.target.checked)}
        />
        <span style={{ fontSize: 12 }}>Lock (require human approval)</span>
      </label>

      {loopForFields?.loop && (
        <div style={loopFieldsWrap}>
          <div style={loopFieldsHeader}>
            Loop conditions
            {loopForFields !== phase && ` · ${loopForFields.name}`}
          </div>
          <Field label="Max iterations">
            <input
              type="number"
              min={1}
              max={100}
              value={loopForFields.loop.maxIterations}
              onChange={e =>
                onEditLoop(
                  loopForFields.name,
                  'maxIterations',
                  Math.max(1, parseInt(e.target.value || '1', 10)),
                )
              }
              style={inputStyle}
            />
          </Field>
          <Field label="Stop when output contains (until)">
            <input
              type="text"
              value={loopForFields.loop.until ?? ''}
              onChange={e => onEditLoop(loopForFields.name, 'until', e.target.value)}
              placeholder="[APPROVED]"
              style={inputStyle}
            />
          </Field>
          <Field label="Loop WHILE output contains (whileOutput)">
            <input
              type="text"
              value={loopForFields.loop.whileOutput ?? ''}
              onChange={e =>
                onEditLoop(loopForFields.name, 'whileOutput', e.target.value)
              }
              placeholder="needs-work"
              style={inputStyle}
            />
          </Field>
          <Field label="Judge agent (decides STOP/CONTINUE)">
            <input
              type="text"
              value={loopForFields.loop.judge ?? ''}
              onChange={e => onEditLoop(loopForFields.name, 'judge', e.target.value)}
              placeholder="agents/critique.md"
              style={inputStyle}
            />
          </Field>
          <label style={lockRow}>
            <input
              type="checkbox"
              checked={!!loopForFields.loop.retryOnFailure}
              onChange={e =>
                onEditLoop(loopForFields.name, 'retryOnFailure', e.target.checked)
              }
            />
            <span style={{ fontSize: 12 }}>Retry on failure</span>
          </label>
        </div>
      )}

      {canUngroup && (
        <button onClick={onUngroup} style={ungroupButton}>
          ⊟ Ungroup ({composite === 'loop' ? 'unwrap loop body' : 'release children'})
        </button>
      )}

      <button onClick={onDelete} style={dangerButton}>
        Delete phase
      </button>
    </div>
  );
}

function EdgeSidePanel({
  edge,
  onClose,
  onChangeType,
  onChangeCompositeField,
  onDelete,
}: {
  edge: FlowEdge;
  onClose: () => void;
  onChangeType: (next: EdgeType) => void;
  onChangeCompositeField: (
    field: keyof CompositeMeta,
    value: string | boolean | undefined,
  ) => void;
  onDelete: () => void;
}) {
  // Decorative 'loop-back' edges aren't user-editable fork types; treat as
  // 'handoff' for this panel (they don't normally surface here).
  const currentType: EdgeType =
    edge.data?.type && edge.data.type !== 'loop-back'
      ? edge.data.type
      : 'handoff';
  const composite = edge.data?.composite;
  const showComposite = currentType !== 'handoff';

  return (
    <div style={panel}>
      <div style={panelHeader}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Edit connection</span>
        <button onClick={onClose} style={panelClose}>×</button>
      </div>

      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
        <span style={codeStyle}>{edge.source}</span>{' '}→{' '}
        <span style={codeStyle}>{edge.target}</span>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
        Connection type
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['handoff', 'parallel', 'converge'] as const).map(t => (
          <button
            key={t}
            onClick={() => onChangeType(t)}
            style={{
              flex: 1,
              padding: '8px 4px',
              border: `1px solid ${t === currentType ? EDGE_COLOR[t] : '#d1d5db'}`,
              backgroundColor: t === currentType ? `${EDGE_COLOR[t]}1a` : '#ffffff',
              color: t === currentType ? EDGE_COLOR[t] : '#374151',
              fontWeight: t === currentType ? 700 : 500,
              fontSize: 11,
              borderRadius: 5,
              cursor: 'pointer',
            }}>
            {t}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 14, lineHeight: 1.5 }}>
        {currentType === 'handoff' && 'Sequential — target runs after source.'}
        {currentType === 'parallel' && 'Parallel branch — runs alongside siblings (no shared outputs).'}
        {currentType === 'converge' && 'Converge branch — siblings may produce conflicting outputs; needs a merger.'}
      </div>

      {showComposite && (
        <>
          <div style={panelDivider} />
          <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
            Composite group
          </div>
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 10 }}>
            Settings shared by all sibling fork edges. Applies to the composite phase
            that wraps these branches in the schema.
          </div>

          <Field label="Composite name">
            <input
              type="text"
              value={composite?.name ?? ''}
              onChange={e => onChangeCompositeField('name', e.target.value)}
              placeholder={`${currentType}-group-1`}
              style={inputStyle}
            />
          </Field>

          {currentType === 'converge' && (
            <Field label="Merger (agent path)">
              <input
                type="text"
                value={composite?.merger ?? ''}
                onChange={e => onChangeCompositeField('merger', e.target.value)}
                placeholder="agents/synthesizer.md"
                style={inputStyle}
              />
            </Field>
          )}

          <label style={lockRow}>
            <input
              type="checkbox"
              checked={!!composite?.lock}
              onChange={e => onChangeCompositeField('lock', e.target.checked)}
            />
            <span style={{ fontSize: 12 }}>Composite lock</span>
          </label>
        </>
      )}

      <button onClick={onDelete} style={dangerButton}>
        Delete connection
      </button>
    </div>
  );
}

function PaletteItem({
  icon,
  label,
  hint,
  onPress,
  color,
  dragKind,
}: {
  icon: string;
  label: string;
  hint: string;
  onPress: () => void;
  color: string;
  /** When set, the item can be dragged onto the canvas to create a node of
   *  this kind at the drop point. Clicking still appends via
   *  onPress. Omit for action items (e.g. "Group as phase") that aren't
   *  spatial node-creators. */
  dragKind?: PaletteDragKind;
}) {
  return (
    <button
      onClick={onPress}
      draggable={dragKind != null}
      onDragStart={
        dragKind
          ? e => {
              e.dataTransfer.setData(PALETTE_DND_MIME, dragKind);
              e.dataTransfer.effectAllowed = 'copy';
            }
          : undefined
      }
      style={dragKind ? paletteItemDraggable : paletteItem}>
      <div style={paletteItemRow}>
        <span style={{ ...paletteItemIcon, color }}>{icon}</span>
        <span style={paletteItemLabel}>{label}</span>
      </div>
      <div style={paletteItemHint}>{hint}</div>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// -------- Inline styles (plain React DOM, this file is web-only) --------

const canvasWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  width: '100%',
  height: '100%',
  backgroundColor: '#f9fafb',
};

const canvasArea: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  height: '100%',
};

const paletteWrap: React.CSSProperties = {
  width: 220,
  flexShrink: 0,
  borderRight: '1px solid #e5e7eb',
  backgroundColor: '#ffffff',
  overflowY: 'auto',
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const paletteSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const paletteHeader: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const sectionHeaderButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '4px 0',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
};

const sectionChevron: React.CSSProperties = {
  fontSize: 8,
  color: '#9ca3af',
  width: 10,
};

const sectionBody: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingTop: 4,
};

const paletteHint: React.CSSProperties = {
  fontSize: 10,
  color: '#6b7280',
  lineHeight: 1.45,
  paddingBottom: 4,
};

const paletteItem: React.CSSProperties = {
  display: 'block',
  textAlign: 'left',
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #e5e7eb',
  backgroundColor: '#ffffff',
  borderRadius: 6,
  cursor: 'pointer',
};

// Draggable palette items get a grab cursor to advertise the drag-to-canvas
// affordance.
const paletteItemDraggable: React.CSSProperties = {
  ...paletteItem,
  cursor: 'grab',
};

const paletteItemRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const paletteItemIcon: React.CSSProperties = {
  fontSize: 16,
  width: 18,
  textAlign: 'center',
  fontWeight: 700,
};

const paletteItemLabel: React.CSSProperties = {
  fontSize: 12,
  color: '#111827',
  fontWeight: 600,
};

const paletteItemHint: React.CSSProperties = {
  fontSize: 10,
  color: '#6b7280',
  marginTop: 2,
  marginLeft: 26,
  lineHeight: 1.35,
};

const edgeChip: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 5,
  fontSize: 12,
  cursor: 'pointer',
  marginTop: 4,
};

const handleStyle: React.CSSProperties = {
  width: 13,
  height: 13,
  background: '#6b7280',
  border: '2px solid #ffffff',
  cursor: 'crosshair',
};

const sideHandleStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  background: 'transparent',
  border: 'none',
  // Hidden visually; used for routing loop-back / side connections only.
};

function nodeStyles(
  selected: boolean,
  accent: string,
  hasError?: boolean,
  runStatus?: NodeRunStatus,
): React.CSSProperties {
  const errorAccent = '#dc2626';
  const statusColor = runStatus ? STATUS_COLOR[runStatus] : undefined;
  const running = runStatus === 'running';
  const pending = runStatus === 'pending';
  // Precedence: validation error > live run status > selection > default.
  // Pending is special-cased to a faint dashed outline (not-yet-run).
  const borderColor = hasError
    ? errorAccent
    : statusColor && !pending
      ? statusColor
      : selected
        ? accent
        : '#d1d5db';
  const boxShadow = hasError
    ? `0 0 0 3px ${errorAccent}33`
    : statusColor && !pending
      ? `0 0 0 3px ${statusColor}40`
      : selected
        ? `0 0 0 3px ${accent}33`
        : '0 1px 3px rgba(0,0,0,0.08)';
  return {
    minWidth: 180,
    maxWidth: 220,
    backgroundColor: hasError ? '#fef2f2' : running ? '#eff6ff' : '#ffffff',
    borderRadius: 8,
    borderWidth: 2,
    borderStyle: pending ? 'dashed' : 'solid',
    borderColor,
    opacity: pending ? 0.55 : 1,
    padding: '10px 12px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    boxShadow,
    // The pulse keyframes (injected once, see ensurePulseStyle) drive the
    // box-shadow while the node is the one running.
    animation: running && !hasError ? 'sammy-pulse 1.4s ease-in-out infinite' : undefined,
    position: 'relative',
  };
}

// Pulse keyframes for the running node — injected once into <head> (the
// graph is raw DOM, so it uses CSS @keyframes rather than RN Animated).
const PULSE_KEYFRAMES = `@keyframes sammy-pulse {
  0%, 100% { box-shadow: 0 0 0 3px ${STATUS_COLOR.running}55; }
  50% { box-shadow: 0 0 0 8px ${STATUS_COLOR.running}11; }
}
/* Make connection handles easy to find + grab when drawing edges between
   components — they turn blue on node hover and grow when grabbed. */
.react-flow__handle { transition: transform 0.1s ease, background 0.1s ease; }
.react-flow__node:hover .react-flow__handle { background: #2563eb; }
.react-flow__handle:hover { background: #1d4ed8 !important; transform: scale(1.6); }`;
function ensurePulseStyle() {
  try {
    const g = globalThis as unknown as {
      document?: {
        getElementById(id: string): unknown;
        createElement(t: string): { id: string; textContent: string };
        head: { appendChild(n: unknown): void };
      };
    };
    const doc = g.document;
    if (!doc || doc.getElementById('sammy-pulse-style')) return;
    const el = doc.createElement('style');
    el.id = 'sammy-pulse-style';
    el.textContent = PULSE_KEYFRAMES;
    doc.head.appendChild(el);
  } catch {
    /* SSR / no document — animation simply won't run */
  }
}

/** Small colored status dot for a graph node header. */
function StatusDotEl({ status }: { status?: NodeRunStatus }) {
  if (!status) return null;
  return (
    <span
      title={status}
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        background: STATUS_COLOR[status],
        display: 'inline-block',
      }}
    />
  );
}

/** Complexity badge overlaid on the graph canvas (top-right Panel). Shows the
 *  whole orchestration's tier + score; the title attribute spells out the
 *  signals behind it. Recomputed only when the tree changes. */
function ComplexityPanelBadge({ orchestration }: { orchestration: Node }) {
  const complexity = useMemo(
    () => computeComplexity(orchestration),
    [orchestration],
  );
  const color = TIER_COLOR[complexity.tier];
  // Styled hover bubble explaining the tier+score (same component the pipeline
  // list badge uses). Replaces the old native `title` so both badges share one
  // tooltip look.
  return (
    <Tooltip text={complexityDescription(complexity)}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          borderRadius: 12,
          border: `1px solid ${color}`,
          background: '#ffffff',
          color,
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'Menlo, monospace',
          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
        }}>
        <span aria-hidden>◆</span>
        <span>{complexityLabel(complexity)}</span>
      </div>
    </Tooltip>
  );
}

const errorBadge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#dc2626',
  backgroundColor: '#fee2e2',
  padding: '2px 6px',
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
};

const errorMessageText: React.CSSProperties = {
  fontSize: 10,
  color: '#dc2626',
  marginTop: 4,
  fontStyle: 'italic',
  lineHeight: 1.3,
};

const nodeHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const nodeName: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: '#111827',
};

const nodeNameInput: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: '#111827',
  border: '1px solid #2563eb',
  borderRadius: 4,
  padding: '2px 4px',
  outline: 'none',
  fontFamily: 'inherit',
  flex: 1,
  minWidth: 0,
};

function hoverArrowStyle(direction: 'up' | 'down'): React.CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    [direction === 'up' ? 'top' : 'bottom']: -26,
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 700,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    boxShadow: '0 2px 4px rgba(37, 99, 235, 0.4)',
    zIndex: 10,
    pointerEvents: 'auto',
    fontFamily: 'inherit',
    lineHeight: 1,
  };
}

const lockBadge: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: '#dc2626',
  backgroundColor: '#fee2e2',
  padding: '2px 6px',
  borderRadius: 4,
  textTransform: 'uppercase',
};

const agentPath: React.CSSProperties = {
  fontFamily: 'Menlo, monospace',
  fontSize: 10,
  color: '#6b7280',
  marginTop: 4,
};

const descriptionText: React.CSSProperties = {
  fontSize: 11,
  color: '#6b7280',
  fontStyle: 'italic',
  marginTop: 6,
};

const compositeBadge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 4,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginTop: 6,
  alignSelf: 'flex-start',
  display: 'inline-block',
};

const mergerText: React.CSSProperties = {
  fontFamily: 'Menlo, monospace',
  fontSize: 10,
  color: '#d97706',
  marginTop: 4,
};


const bannerStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  right: 160,
  zIndex: 9,
  backgroundColor: '#fffbeb',
  borderRadius: 6,
  border: '1px solid #fde68a',
  color: '#92400e',
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 500,
};

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  right: 12,
  bottom: 12,
  width: 290,
  zIndex: 9,
  backgroundColor: '#ffffff',
  borderRadius: 10,
  border: '1px solid #e5e7eb',
  padding: 14,
  boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
  overflowY: 'auto',
};

const panelHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
};

const panelClose: React.CSSProperties = {
  width: 24,
  height: 24,
  border: 'none',
  background: 'transparent',
  fontSize: 18,
  color: '#6b7280',
  cursor: 'pointer',
  lineHeight: 1,
};

const panelDivider: React.CSSProperties = {
  height: 1,
  backgroundColor: '#e5e7eb',
  marginBottom: 14,
};

const panelHint: React.CSSProperties = {
  fontSize: 11,
  color: '#92400e',
  backgroundColor: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: 6,
  padding: 8,
  marginBottom: 10,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 12,
  border: '1px solid #d1d5db',
  borderRadius: 5,
  color: '#111827',
};

const lockRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 14,
};

const dangerButton: React.CSSProperties = {
  width: '100%',
  padding: '8px',
  borderRadius: 6,
  border: '1px solid #fecaca',
  backgroundColor: '#fee2e2',
  color: '#b91c1c',
  fontWeight: 600,
  fontSize: 12,
  cursor: 'pointer',
};

const loopFieldsWrap: React.CSSProperties = {
  marginTop: 4,
  marginBottom: 10,
  paddingTop: 10,
  borderTop: '1px solid #e5e7eb',
};

const loopFieldsHeader: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#0891b2',
  textTransform: 'uppercase',
  letterSpacing: 1,
  marginBottom: 8,
};

const ungroupButton: React.CSSProperties = {
  width: '100%',
  padding: '8px',
  borderRadius: 6,
  border: '1px solid #c7d2fe',
  backgroundColor: '#eef2ff',
  color: '#4338ca',
  fontWeight: 600,
  fontSize: 12,
  cursor: 'pointer',
  marginBottom: 8,
};

const actionButton: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  border: '1px solid #c7d2fe',
  backgroundColor: '#eef2ff',
  color: '#4338ca',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  marginTop: 4,
};

const addChildButton: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px dashed #93c5fd',
  backgroundColor: '#eff6ff',
  color: '#1d4ed8',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'Menlo, monospace',
  fontSize: 11,
  backgroundColor: '#f3f4f6',
  padding: '1px 4px',
  borderRadius: 3,
};
