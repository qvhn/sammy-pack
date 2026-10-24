import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  compositeChildCount,
  compositeKey,
  type CompositeKey,
  type Node,
} from './types';
import { usePulse } from './lib/usePulse';
import { STATUS_COLOR, type NodeRunStatus } from './lib/runStatus';
import { getOrchestration } from './api';
import {
  acceptsChildren,
  addOrPromoteChild,
  deleteNodeByName,
  duplicateNode,
  findNodeByName,
  updateNodeByName,
  wrapInComposite,
} from './lib/orchestrationMutate';
import { formatMapOver } from './lib/mapOver';

/** Per-composite presentation: the relation-bar label, accent color and a
 *  short icon. Mirrors OrchestrationTree's COMPOSITE_* maps (kept local — the
 *  Pipeline view's bar wording differs slightly). */
const KIND_META: Record<CompositeKey, { label: string; color: string; icon: string }> = {
  agents: { label: 'agents · serial', color: '#6b7280', icon: '⋯' },
  phases: { label: 'phases', color: '#2563eb', icon: '↳' },
  parallel: { label: 'parallel', color: '#059669', icon: '∥' },
  converge: { label: 'converge', color: '#d97706', icon: '⤚' },
  loop: { label: 'loop', color: '#0891b2', icon: '↻' },
  conversation: { label: 'conversation', color: '#e11d48', icon: '💬' },
  route: { label: 'route', color: '#65a30d', icon: '⌥' },
  switch: { label: 'switch · cases', color: '#0d9488', icon: '⋔' },
  map: { label: 'map · fan-out', color: '#7c3aed', icon: '⇉' },
};

/** Presentation for an EXPANDED subflow reference — a name-only pointer to
 *  another orchestration whose phases we resolve + inline. Kept separate from
 *  KIND_META (which is keyed by CompositeKey; `subflow` is not a composite kind)
 *  but mirrors its shape so the relation bar / nested rail render identically. */
const SUBFLOW_META = { label: 'subflow', color: '#0ea5e9', icon: '⤳' } as const;

/** Module-level cache of resolved subflow orchestrations, keyed by name. A
 *  collapse → re-expand (or the same subflow referenced from several nodes)
 *  reuses the fetched Node instead of re-hitting the network. Stores both
 *  pending promises (so concurrent expands de-dupe) and settled results. */
const subflowCache = new Map<
  string,
  | { state: 'loading'; promise: Promise<Node> }
  | { state: 'ok'; node: Node }
  | { state: 'error'; message: string }
>();

/** Resolve a subflow orchestration by name through the api client, caching the
 *  result. Returns the cached entry synchronously when settled; otherwise kicks
 *  off (or reuses) the in-flight fetch. The caller re-renders via `tick`. */
function loadSubflow(name: string): Promise<Node> {
  const existing = subflowCache.get(name);
  if (existing?.state === 'loading') return existing.promise;
  if (existing?.state === 'ok') return Promise.resolve(existing.node);
  // 'error' or absent → (re)issue the fetch.
  const promise = getOrchestration(name).then(
    node => {
      subflowCache.set(name, { state: 'ok', node });
      return node;
    },
    err => {
      subflowCache.set(name, {
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    },
  );
  subflowCache.set(name, { state: 'loading', promise });
  return promise;
}

/** A node is a subflow reference when it carries a non-empty `subflow` name.
 *  The executor reads `node.subflow` (and, when the node's body is nested, the
 *  same key lives on the node object itself — there is no separate `body`
 *  wrapper in this schema), so a single check covers both representations. */
function subflowName(node: Node): string | null {
  const n = typeof node.subflow === 'string' ? node.subflow.trim() : '';
  return n.length > 0 ? n : null;
}

/** Distinct, informative display for a non-agent / script leaf. The schema's
 *  `codeBody` allows EITHER `source` (inline JS, vm-sandboxed) OR `run` (an
 *  external shell command); both are valid bodies the executor supports, so
 *  they get a kind chip + a monospace, single-line preview rather than the
 *  "(no body)" placeholder. Mirrors OrchestrationTree's helper (kept local —
 *  same reasoning as the KIND_META vs COMPOSITE_* maps). Returns null for a
 *  leaf with no recognized body. */
function scriptDisplay(
  phase: Node,
): { label: string; preview: string } | null {
  if (phase.code && typeof phase.code === 'object') {
    if (typeof phase.code.run === 'string' && phase.code.run.length > 0) {
      return { label: 'SCRIPT', preview: previewLine(phase.code.run, 120) };
    }
    if (typeof phase.code.source === 'string' && phase.code.source.length > 0) {
      return { label: 'CODE', preview: previewLine(phase.code.source, 120) };
    }
  }
  if (phase.http && typeof phase.http === 'object' && typeof phase.http.url === 'string') {
    return {
      label: 'HTTP',
      preview: previewLine(`${(phase.http.method ?? 'GET').toUpperCase()} ${phase.http.url}`, 120),
    };
  }
  if (phase.wait && typeof phase.wait === 'object') {
    const w = phase.wait;
    return {
      label: 'WAIT',
      preview: w.signal ? `signal ${w.signal}` : w.until ? `until ${w.until}` : `${w.seconds ?? 0}s`,
    };
  }
  return null;
}

/** Collapse a (possibly multi-line) string to its first non-empty line and
 *  truncate to `max` chars with an ellipsis — a single, scannable preview. */
function previewLine(text: string, max: number): string {
  const firstLine =
    text.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

/** Live-run context threaded down the recursive PhaseColumn tree, so every
 *  nested node can color itself by status and show loop/map/route progress. */
export type PipelineLive = {
  statusByNode?: Map<string, NodeRunStatus>;
  isLive?: boolean;
  loopIterByNode?: Map<string, number>;
  mapProgressByNode?: Map<string, { iteration: number; total: number }>;
  routeDecisionByNode?: Map<string, string>;
  loopStopByNode?: Map<string, { iteration: number; reason: string }>;
};

// Per-orchestration+node collapse state, localStorage-backed — mirrors the
// Graph view's flatten-collapsed pattern so a user's expand/collapse choices
// survive reloads. Default is expanded (absent key).
const COLLAPSE_KEY = (orch: string, node: string) =>
  `sammy.pipeline.collapsed.${orch}.${node}`;
// `defaultCollapsed` is the kind's baseline (false for composites — default
// expanded; true for subflows — default collapsed). Only the non-default choice
// is stored: a present key means "collapsed", its absence means "expanded" for
// composites, while for subflows a present key means "expanded" and its absence
// means "collapsed". This keeps storage sparse and lets a kind's default change
// without rewriting prior keys.
function loadCollapsed(orch: string, node: string, defaultCollapsed = false): boolean {
  try {
    if (typeof localStorage === 'undefined') return defaultCollapsed;
    const present = localStorage.getItem(COLLAPSE_KEY(orch, node)) === '1';
    // The stored '1' always means "the non-default state" for this kind.
    return present ? !defaultCollapsed : defaultCollapsed;
  } catch {
    return defaultCollapsed;
  }
}
function persistCollapsed(
  orch: string,
  node: string,
  val: boolean,
  defaultCollapsed = false,
) {
  try {
    if (typeof localStorage === 'undefined') return;
    // Store a key only when the value differs from the kind default.
    if (val !== defaultCollapsed) localStorage.setItem(COLLAPSE_KEY(orch, node), '1');
    else localStorage.removeItem(COLLAPSE_KEY(orch, node));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** When a map's `over` is an inline JSON array literal, return its items as
 *  strings so the relation bar can render them as a compact vertical list
 *  instead of one long horizontal string that stretches the whole lane.
 *  Returns null for non-literal expressions (e.g. `${state.items}`), which
 *  stay inline. */
function mapOverItems(over: string): string[] | null {
  try {
    const v = JSON.parse(over.trim());
    if (Array.isArray(v)) {
      return v.map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
    }
  } catch {
    /* not a literal array */
  }
  return null;
}

type Props = {
  orchestration: Node;
  onChange: (next: Node) => void;
  /** Phases harvested from other orchestrations, offered in the "pick existing" tab. */
  availablePhases?: Node[];
  /** Names of phases that have at least one hard error (severity:
   *  'error') in the current validation pass. PhaseCards in this set
   *  render with a red border + ⚠ badge so the user can see which
   *  phase the validation banner is pointing at without scanning
   *  every node. */
  errorNodeNames?: Set<string>;
  /** First error message per node, keyed by name. Used as the
   *  tooltip on the ⚠ badge. */
  errorMessageByNode?: Map<string, string>;
  /** Name of the phase the user currently has selected — surfaces a
   *  subtle highlight on the matching card so selection persists
   *  across view switches. When unset, no card is highlighted. */
  selectedNodeName?: string | null;
  /** Called when the user clicks a phase card. Lets the parent lift
   *  selection state to share it with the other views. */
  onSelectionChange?: (name: string | null) => void;
  /** Live run status (per node) + loop/map/route progress, so the pipeline
   *  can be followed while it runs. Absent ⇒ neutral (editor-only) styling. */
  live?: PipelineLive;
};

export function PipelineEditor({
  orchestration,
  onChange,
  availablePhases = [],
  errorNodeNames,
  errorMessageByNode,
  selectedNodeName,
  onSelectionChange,
  live,
}: Props) {
  const phases = orchestration.phases ?? [];
  const orchName = orchestration.name ?? '';
  const [addAt, setAddAt] = useState<number | null>(null);
  // Name of the phase being edited in the docked panel. Name-based (not
  // an index) so the panel can edit ANY node — top-level or a nested
  // child — via the shared name-based mutations.
  const [editName, setEditName] = useState<string | null>(null);
  // When set, the AddPhaseModal appends the new phase as a CHILD of this
  // composite (vs. `addAt`, which inserts at a top-level index).
  const [addChildParent, setAddChildParent] = useState<string | null>(null);
  // Tracks which phase the user is currently hovering. When set, the
  // `+` buttons that aren't immediately before or after the hovered
  // phase fade — so "where will my next click insert" is visually
  // obvious. Null when nothing hovered (default state, all + buttons
  // at full opacity, no preference).
  const [hoveredPhaseIdx, setHoveredPhaseIdx] = useState<number | null>(null);

  // Top-level insert (the lane's "+" buttons). Nested structural edits go
  // through the shared name-based mutations (addChildPhase / updateNodeByName
  // / deleteNodeByName) so every depth is editable, not just the root.
  function insertAt(index: number, phase: Node) {
    onChange({
      ...orchestration,
      phases: [...phases.slice(0, index), phase, ...phases.slice(index)],
    });
  }

  const uniqueAvailable = useMemo(() => {
    const seen = new Set<string>();
    const out: Node[] = [];
    for (const p of availablePhases) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      out.push(p);
    }
    return out;
  }, [availablePhases]);

  // PR 20 (F17) — selected phase opens in a docked panel on the
  // right instead of a centered Modal. Mirrors the Graph view's
  // NodeSidePanel pattern: the canvas stays visible while you edit,
  // so changes can be read in context. Add-phase still uses a Modal
  // (it's a tabbed picker, not an in-place edit, and benefits from
  // the focus-trap behavior).
  const editingPhase = editName ? findNodeByName(orchestration, editName) : null;
  const submitRef = useRef<(() => void) | null>(null);

  // PR 20 — Cmd/Ctrl+Enter saves and Esc closes the docked panel.
  // Replaces the keyboard handling that the Modal-based EditPhaseModal
  // used to own via `onSubmitShortcut`. We listen at the window level
  // because the panel doesn't trap focus the way a Modal does — the
  // canvas next to it is still interactive.
  useEffect(() => {
    if (!editName) return;
    type KEvt = { key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault: () => void };
    const w = globalThis as unknown as {
      addEventListener?: (k: string, fn: (e: KEvt) => void) => void;
      removeEventListener?: (k: string, fn: (e: KEvt) => void) => void;
    };
    if (!w.addEventListener) return;
    function onKey(e: KEvt) {
      if (e.key === 'Escape') {
        setEditName(null);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        submitRef.current?.();
        e.preventDefault();
      }
    }
    w.addEventListener('keydown', onKey);
    return () => w.removeEventListener?.('keydown', onKey);
  }, [editName]);

  return (
    <View style={styles.containerRow}>
      <View style={styles.pipelineColumn}>
      {/* Outer vertical scroll so composites that expand DOWNWARD (nested
          children, loop bodies) stay reachable in tall orchestrations; the
          inner ScrollView keeps the lane scrolling horizontally. RN
          ScrollView is single-axis, so we nest one of each. */}
      <ScrollView
        style={styles.pipelineVScroll}
        contentContainerStyle={styles.pipelineVContent}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pipeline}>
        {/* "+ before first" — dimmed when the user is hovering a later
            phase, since their cursor signals intent further down. */}
        <AddButton
          onPress={() => setAddAt(0)}
          dim={hoveredPhaseIdx !== null && hoveredPhaseIdx > 0}
        />
        {phases.map((phase, i) => {
          const runStatus = phase.name
            ? live?.statusByNode?.get(phase.name)
            : undefined;
          return (
            <View
              key={`${phase.name}-${i}`}
              style={styles.phaseRow}
              {...({
                // RN-Web Pressable supports onHoverIn/Out but a plain
                // View doesn't — we rely on the web bridge translating
                // these through. Cast keeps TS happy without the DOM lib.
                onMouseEnter: () => setHoveredPhaseIdx(i),
                onMouseLeave: () => setHoveredPhaseIdx(p => (p === i ? null : p)),
              } as unknown as object)}>
              {/* The inbound arrow animates blue when the phase it leads
                  into is the one currently running. */}
              <Arrow
                active={!!live?.isLive && runStatus === 'running'}
                done={runStatus === 'done'}
              />
              {/* PhaseColumn renders the card + (for composites) the
                  nested children beneath it. Clicking any card — top-level
                  or nested — selects it and opens the docked edit panel;
                  composites also get a "+ child" affordance. */}
              <PhaseColumn
                phase={phase}
                depth={0}
                orchName={orchName}
                live={live}
                selectedNodeName={selectedNodeName}
                onSelectionChange={onSelectionChange}
                errorNodeNames={errorNodeNames}
                errorMessageByNode={errorMessageByNode}
                onEditNode={setEditName}
                onAddChild={setAddChildParent}
              />
              <Arrow />
              {/* "+ after phase i" — bright when this phase is hovered;
                  dim when a different phase is. The active one stands
                  out so the user knows the next click means here. */}
              <AddButton
                onPress={() => setAddAt(i + 1)}
                dim={hoveredPhaseIdx !== null && hoveredPhaseIdx !== i}
              />
            </View>
          );
        })}
      </ScrollView>
      </ScrollView>

      {phases.length === 0 && (
        <Text style={styles.emptyHint}>Empty pipeline. Tap + to add a phase.</Text>
      )}

      <AddPhaseModal
        visible={addAt !== null || addChildParent !== null}
        availablePhases={uniqueAvailable}
        title={addChildParent ? `Add child to "${addChildParent}"` : undefined}
        onClose={() => {
          setAddAt(null);
          setAddChildParent(null);
        }}
        onSubmit={phase => {
          if (addChildParent) {
            // Appends into a composite, or promotes a leaf into a group
            // (original kept as the first child) so you can add a child to
            // ANY phase, not just ones that already have children.
            onChange(addOrPromoteChild(orchestration, addChildParent, phase));
          } else if (addAt !== null) {
            insertAt(addAt, phase);
          }
          setAddAt(null);
          setAddChildParent(null);
        }}
      />
      </View>

      {editingPhase && (
        <View style={styles.dockedPanel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelHeaderText}>Edit phase</Text>
            <Pressable
              onPress={() => setEditName(null)}
              accessibilityLabel="Close edit panel"
              style={styles.panelClose}>
              <Text style={styles.panelCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.panelScroll}>
            <PhaseForm
              initial={editingPhase}
              submitLabel="Save"
              submitRef={submitRef}
              onSubmit={phase => {
                if (editName)
                  onChange(updateNodeByName(orchestration, editName, () => phase));
                setEditName(null);
              }}
              onDelete={() => {
                if (editName) onChange(deleteNodeByName(orchestration, editName));
                setEditName(null);
              }}
            />
          </ScrollView>
          {/* Structural actions — the same shared mutations the Graph view
              offers, so the views reach parity. */}
          <View style={styles.panelActions}>
            <Pressable
              onPress={() => {
                if (editName) onChange(duplicateNode(orchestration, editName));
                setEditName(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Duplicate this phase"
              style={styles.panelActionBtn}>
              <Text style={styles.panelActionText}>⎘ Duplicate</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (editName)
                  onChange(wrapInComposite(orchestration, editName, 'loop'));
                setEditName(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Wrap this phase in a loop"
              style={styles.panelActionBtn}>
              <Text style={styles.panelActionText}>↻ Wrap in loop</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (editName)
                  onChange(wrapInComposite(orchestration, editName, 'phases'));
                setEditName(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Wrap this phase in a group"
              style={styles.panelActionBtn}>
              <Text style={styles.panelActionText}>▢ Wrap in group</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

/** A node in the pipeline view: its card, plus — when it is an expanded
 *  composite — a relation bar and its children nested beneath a left rail
 *  (with a loop-back arc for loops). Recurses for nested composites, so a
 *  parallel-inside-a-loop renders as deeply as the orchestration nests.
 *
 *  `onEditNode(name)` opens the docked edit panel for any card — top-level
 *  or nested. `onAddChild(parentName)` is threaded so each composite can
 *  offer a "+ child" button. Both recurse to arbitrary depth. */
function PhaseColumn({
  phase,
  depth,
  orchName,
  live,
  selectedNodeName,
  onSelectionChange,
  errorNodeNames,
  errorMessageByNode,
  onEditNode,
  onAddChild,
  pathPrefix = '',
  subflowAncestors,
}: {
  phase: Node;
  depth: number;
  orchName: string;
  live?: PipelineLive;
  selectedNodeName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  errorNodeNames?: Set<string>;
  errorMessageByNode?: Map<string, string>;
  onEditNode?: (name: string) => void;
  onAddChild?: (parentName: string) => void;
  /** Slash-joined ancestry of resolved subflow phase names, e.g. "scope/" —
   *  prefixed onto this node's name when looking up live run status, so a
   *  fetched subflow child matches the run's nested-phase identity. Empty for
   *  in-tree nodes (status keyed by bare name, unchanged). */
  pathPrefix?: string;
  /** Set of subflow names already expanded on the path from the root to here.
   *  A subflow that would re-enter one renders a cycle leaf instead of
   *  recursing, so a cyclic reference can't fan out forever. */
  subflowAncestors?: ReadonlySet<string>;
}) {
  const composite = compositeKey(phase);
  const name = phase.name ?? '';
  const sub = subflowName(phase);
  // Live-run status: try the slash-joined nested path first (set when this node
  // is a fetched subflow descendant), then fall back to the bare name. In-tree
  // nodes have an empty prefix → behavior is unchanged.
  const runStatus = name
    ? live?.statusByNode?.get(pathPrefix + name) ?? live?.statusByNode?.get(name)
    : undefined;

  // A subflow reference is expandable (like a composite) but its body is
  // resolved lazily over the network, not held inline. `expandable` covers
  // both so the toggle + collapse machinery is shared.
  const expandable = !!composite || !!sub;

  // Collapse state. Composites default EXPANDED (absent key); subflows default
  // COLLAPSED so the first render doesn't fan out a fetch per subflow across
  // the whole tree — the user opts in with one click. Persisted per
  // orchestration + node so the choice survives reloads / view switches.
  // Subflow keys are namespaced by the resolved path so the same subflow
  // referenced at two nodes keeps independent collapse state.
  const collapseKey = sub ? `subflow:${pathPrefix}${name}` : name;
  const [collapsed, setCollapsed] = useState(() =>
    composite
      ? loadCollapsed(orchName, collapseKey)
      : sub
        ? loadCollapsed(orchName, collapseKey, true)
        : false,
  );
  useEffect(() => {
    if (composite) setCollapsed(loadCollapsed(orchName, collapseKey));
    else if (sub) setCollapsed(loadCollapsed(orchName, collapseKey, true));
  }, [orchName, collapseKey, composite, sub]);
  function toggle() {
    setCollapsed(c => {
      const next = !c;
      // Persist relative to the kind's default (subflow=collapsed) so we only
      // store the non-default choice, mirroring the composite path.
      persistCollapsed(orchName, collapseKey, next, sub ? true : false);
      return next;
    });
  }
  const expanded = expandable && !collapsed;

  // Cycle guard: would expanding this subflow re-enter one already open on the
  // ancestor path? If so, render a cycle leaf instead of recursing.
  const isCycle = !!sub && !!subflowAncestors?.has(sub);

  return (
    <View style={cstyles.column}>
      <PhaseCard
        phase={phase}
        composite={composite}
        runStatus={runStatus}
        isLive={!!live?.isLive}
        isSelected={!!(name && name === selectedNodeName)}
        hasError={!!(name && errorNodeNames?.has(name))}
        errorMessage={name ? errorMessageByNode?.get(name) : undefined}
        collapsed={collapsed}
        onToggle={expandable ? toggle : undefined}
        onPress={() => {
          onSelectionChange?.(name || null);
          if (name) onEditNode?.(name);
        }}
      />
      {/* "+ child" on a LEAF — promotes it into a group (original kept as
       *  the first child) so a child can be added to ANY phase, not just
       *  ones that are already composites. Array composites get their own
       *  "+ child" under the children in CompositeBody. A subflow leaf is a
       *  name-only reference (its body lives in another orchestration), so it
       *  gets the expand affordance instead of a "+ child" promote. */}
      {onAddChild && name && !composite && !sub ? (
        <Pressable
          onPress={() => onAddChild(name)}
          style={[cstyles.addChildBtn, { borderColor: '#93c5fd', marginTop: 6 }]}
          accessibilityRole="button"
          accessibilityLabel={`Nest a child inside ${name} (turns this phase into a group)`}>
          <Text style={[cstyles.addChildText, { color: '#2563eb' }]}>↳ + child</Text>
        </Pressable>
      ) : null}
      {expanded && composite && (
        <CompositeBody
          phase={phase}
          composite={composite}
          depth={depth}
          orchName={orchName}
          live={live}
          selectedNodeName={selectedNodeName}
          onSelectionChange={onSelectionChange}
          errorNodeNames={errorNodeNames}
          errorMessageByNode={errorMessageByNode}
          onEditNode={onEditNode}
          onAddChild={onAddChild}
          pathPrefix={pathPrefix}
          subflowAncestors={subflowAncestors}
        />
      )}
      {expanded && sub && (
        <SubflowBody
          subflow={sub}
          parentName={name}
          isCycle={isCycle}
          depth={depth}
          orchName={orchName}
          live={live}
          selectedNodeName={selectedNodeName}
          onSelectionChange={onSelectionChange}
          errorNodeNames={errorNodeNames}
          errorMessageByNode={errorMessageByNode}
          onEditNode={onEditNode}
          onAddChild={onAddChild}
          // Fetched children's live status is keyed by the nested path —
          // prefix with THIS subflow phase's name so e.g. "scope/classify"
          // matches the run's slash-joined phase identity.
          pathPrefix={`${pathPrefix}${name}/`}
          subflowAncestors={subflowAncestors}
        />
      )}
    </View>
  );
}

/** The expanded body of a `subflow` reference: lazily fetch the referenced
 *  orchestration and render its `phases` under a left rail, reusing PhaseColumn
 *  so subflows-within-subflows expand too. Shows loading / error / cycle states.
 *  The fetched children inherit a `pathPrefix` so their live status matches the
 *  run's nested-phase identity, and `subflowAncestors` is extended with this
 *  subflow's name so a downstream re-entry trips the cycle guard. */
function SubflowBody({
  subflow,
  parentName,
  isCycle,
  depth,
  orchName,
  live,
  selectedNodeName,
  onSelectionChange,
  errorNodeNames,
  errorMessageByNode,
  onEditNode,
  onAddChild,
  pathPrefix,
  subflowAncestors,
}: {
  subflow: string;
  parentName: string;
  isCycle: boolean;
  depth: number;
  orchName: string;
  live?: PipelineLive;
  selectedNodeName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  errorNodeNames?: Set<string>;
  errorMessageByNode?: Map<string, string>;
  onEditNode?: (name: string) => void;
  onAddChild?: (parentName: string) => void;
  pathPrefix: string;
  subflowAncestors?: ReadonlySet<string>;
}) {
  const meta = SUBFLOW_META;
  // `tick` forces a re-render when the async fetch settles (the cache itself is
  // module-level, not React state). Skipped entirely on a cycle (no fetch).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isCycle) return;
    const cached = subflowCache.get(subflow);
    if (cached?.state === 'ok' || cached?.state === 'error') return; // already settled
    let alive = true;
    loadSubflow(subflow).finally(() => {
      if (alive) setTick(t => t + 1);
    });
    return () => {
      alive = false;
    };
  }, [subflow, isCycle]);

  // The set passed DOWN to fetched children — this subflow added to the path.
  const childAncestors = useMemo(() => {
    const s = new Set(subflowAncestors ?? []);
    s.add(subflow);
    return s;
  }, [subflowAncestors, subflow]);

  if (isCycle) {
    return (
      <View style={cstyles.body}>
        <View style={cstyles.rail}>
          <View style={cstyles.subflowCycle}>
            <Text style={cstyles.subflowCycleText}>↩ cycle: {subflow}</Text>
          </View>
        </View>
      </View>
    );
  }

  const cached = subflowCache.get(subflow);
  const childPhases =
    cached?.state === 'ok' ? cached.node.phases ?? [] : [];

  return (
    <View style={cstyles.body}>
      <RelationBar
        meta={meta}
        detail={`→ ${subflow}`}
        name={parentName}
        // The subflow bar edits the PARENT phase (the subflow reference),
        // matching how CompositeBody's bar edits its parent composite.
        onPress={
          parentName && onEditNode
            ? () => {
                onSelectionChange?.(parentName);
                onEditNode(parentName);
              }
            : undefined
        }
      />
      <View style={[cstyles.rail, { borderLeftColor: meta.color }]}>
        {cached?.state === 'loading' || cached === undefined ? (
          <View style={cstyles.subflowStatus}>
            <Text style={cstyles.subflowStatusText}>resolving subflow…</Text>
          </View>
        ) : cached.state === 'error' ? (
          <Pressable
            onPress={() => {
              // Re-issue the fetch — clear the error entry, then reload.
              subflowCache.delete(subflow);
              loadSubflow(subflow).finally(() => setTick(t => t + 1));
              setTick(t => t + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Retry loading subflow ${subflow}`}
            style={cstyles.subflowError}>
            <Text style={cstyles.subflowErrorText}>
              ⚠ couldn&apos;t load &quot;{subflow}&quot;: {cached.message} — tap to
              retry
            </Text>
          </Pressable>
        ) : childPhases.length === 0 ? (
          <View style={cstyles.subflowStatus}>
            <Text style={cstyles.subflowStatusText}>
              (subflow &quot;{subflow}&quot; has no phases)
            </Text>
          </View>
        ) : (
          childPhases.map((c, i) => (
            <PhaseColumn
              key={`${c?.name ?? 'child'}-${i}`}
              phase={c}
              depth={depth + 1}
              orchName={orchName}
              live={live}
              selectedNodeName={selectedNodeName}
              onSelectionChange={onSelectionChange}
              errorNodeNames={errorNodeNames}
              errorMessageByNode={errorMessageByNode}
              onEditNode={onEditNode}
              onAddChild={onAddChild}
              pathPrefix={pathPrefix}
              subflowAncestors={childAncestors}
            />
          ))
        )}
      </View>
    </View>
  );
}

/** The expanded body of a composite phase: a relation bar naming the kind
 *  (with live loop/map progress) + the children nested under a left rail. */
function CompositeBody({
  phase,
  composite,
  depth,
  orchName,
  live,
  selectedNodeName,
  onSelectionChange,
  errorNodeNames,
  errorMessageByNode,
  onEditNode,
  onAddChild,
  pathPrefix = '',
  subflowAncestors,
}: {
  phase: Node;
  composite: CompositeKey;
  depth: number;
  orchName: string;
  live?: PipelineLive;
  selectedNodeName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  errorNodeNames?: Set<string>;
  errorMessageByNode?: Map<string, string>;
  onEditNode?: (name: string) => void;
  onAddChild?: (parentName: string) => void;
  /** See PhaseColumn — slash-joined subflow ancestry for live-status lookup;
   *  threaded onto this composite's children unchanged (a composite does not
   *  add a path segment; only a resolved subflow does). */
  pathPrefix?: string;
  subflowAncestors?: ReadonlySet<string>;
}) {
  const meta = KIND_META[composite];
  const name = phase.name ?? '';
  // Live progress lookups honor the subflow path prefix (with a bare-name
  // fallback), matching PhaseColumn's runStatus resolution.
  const liveGet = <T,>(m: Map<string, T> | undefined): T | undefined =>
    m ? m.get(pathPrefix + name) ?? m.get(name) : undefined;
  const loopIter = liveGet(live?.loopIterByNode);
  const mapProg = liveGet(live?.mapProgressByNode);
  const routePick = liveGet(live?.routeDecisionByNode);

  // Relation-bar detail text per kind (with live progress folded in).
  // `lines` (optional) renders below the header as a compact vertical list —
  // used by `map` so a long `over [...]` array doesn't elongate the lane.
  let detail = '';
  let lines: string[] | null = null;
  if (composite === 'loop' && phase.loop) {
    const max = phase.loop.maxIterations;
    const stop = liveGet(live?.loopStopByNode);
    detail = max ? `up to ${max}×` : 'until stop';
    if (loopIter != null) detail += ` · iteration ${loopIter}${max ? `/${max}` : ''}`;
    // Surface WHY the loop stopped (until / whileOutput / judge / cap) — the
    // event stream knew, the canvas was dropping it.
    if (stop) detail += ` · stopped: ${stop.reason}`;
  } else if (composite === 'map' && phase.map) {
    const items = mapOverItems(phase.map.over);
    if (items) {
      // Array literal → show "over" + the items as a wrapped vertical list.
      detail = mapProg
        ? `over · ${mapProg.iteration}/${mapProg.total}`
        : `over · ${items.length} item${items.length === 1 ? '' : 's'}`;
      const MAX = 12;
      lines = items.slice(0, MAX).map(s => `• ${s}`);
      if (items.length > MAX) lines.push(`• …+${items.length - MAX} more`);
    } else {
      // Non-literal (e.g. ${state.items}) — short enough to stay inline.
      detail = `over ${formatMapOver(phase.map.over)}`;
      if (mapProg) detail += ` · ${mapProg.iteration}/${mapProg.total}`;
    }
  } else if (composite === 'conversation' && phase.conversation) {
    detail = `${phase.conversation.rounds ?? '?'} rounds`;
  } else if (composite === 'route' && phase.route?.router) {
    detail = `router: ${phase.route.router}`;
  } else if (composite === 'switch' && phase.switch?.on) {
    detail = `on: ${phase.switch.on}`;
  }

  const childCol = (child: Node, key: string) => (
    <PhaseColumn
      key={key}
      phase={child}
      depth={depth + 1}
      orchName={orchName}
      live={live}
      selectedNodeName={selectedNodeName}
      onSelectionChange={onSelectionChange}
      errorNodeNames={errorNodeNames}
      errorMessageByNode={errorMessageByNode}
      onEditNode={onEditNode}
      onAddChild={onAddChild}
      pathPrefix={pathPrefix}
      subflowAncestors={subflowAncestors}
    />
  );

  // Clicking a composite's relation bar (↻ LOOP, ↳ PHASES, ⫴ PARALLEL …)
  // selects + edits the PARENT composite, so users don't have to trace the
  // rail back up to the parent card to edit it.
  const editParent =
    name && onEditNode
      ? () => {
          onSelectionChange?.(name);
          onEditNode(name);
        }
      : undefined;

  return (
    <View style={cstyles.body}>
      <RelationBar
        meta={meta}
        detail={detail}
        lines={lines}
        name={name}
        onPress={editParent}
      />
      <View style={[cstyles.rail, { borderLeftColor: meta.color }]}>
        {(composite === 'phases' ||
          composite === 'parallel' ||
          composite === 'converge') &&
          (((phase[composite] as Node[]) ?? []).map((c, i) =>
            childCol(c, `${c?.name ?? 'child'}-${i}`),
          ))}

        {acceptsChildren(phase) && onAddChild && name ? (
          <Pressable
            onPress={() => onAddChild(name)}
            style={[cstyles.addPhaseRow, { borderColor: meta.color + '88' }]}
            accessibilityRole="button"
            accessibilityLabel={`Add a phase to ${name}`}>
            <Text style={[cstyles.addChildText, { color: meta.color }]}>+ add phase</Text>
          </Pressable>
        ) : null}

        {composite === 'converge' && phase.merger ? (
          <View style={cstyles.mergerRow}>
            <Text style={[cstyles.mergerLabel, { color: meta.color }]}>▸ merger:</Text>
            <Text style={cstyles.agentPath}>{phase.merger}</Text>
          </View>
        ) : null}

        {composite === 'loop' && phase.loop?.body ? (
          <LoopArc
            color={meta.color}
            max={phase.loop.maxIterations}
            iter={loopIter}
            onPress={editParent}>
            {childCol(phase.loop.body, 'loop-body')}
          </LoopArc>
        ) : null}

        {composite === 'map' && phase.map?.body
          ? childCol(phase.map.body, 'map-body')
          : null}

        {composite === 'route' && phase.route ? (
          <>
            {Object.entries(phase.route.branches ?? {}).map(([k, branch]) => (
              <View key={k} style={cstyles.branch}>
                <Text
                  style={[
                    cstyles.branchKey,
                    routePick === k && cstyles.branchKeyActive,
                  ]}>
                  case "{k}":{routePick === k ? '  ◀ taken' : ''}
                </Text>
                {branch ? childCol(branch, `branch-${k}`) : null}
              </View>
            ))}
            {phase.route.default ? (
              <View style={cstyles.branch}>
                <Text
                  style={[
                    cstyles.branchKey,
                    routePick === 'default' && cstyles.branchKeyActive,
                  ]}>
                  default:{routePick === 'default' ? '  ◀ taken' : ''}
                </Text>
                {childCol(phase.route.default, 'route-default')}
              </View>
            ) : null}
          </>
        ) : null}

        {composite === 'switch' && phase.switch ? (
          <>
            {phase.switch.on ? (
              <View style={cstyles.mergerRow}>
                <Text style={[cstyles.mergerLabel, { color: meta.color }]}>▸ on:</Text>
                <Text style={cstyles.agentPath}>{phase.switch.on}</Text>
              </View>
            ) : null}
            {Object.entries(phase.switch.cases ?? {}).map(([k, branch]) => (
              <View key={k} style={cstyles.branch}>
                <Text
                  style={[
                    cstyles.branchKey,
                    routePick === k && cstyles.branchKeyActive,
                  ]}>
                  case "{k}":{routePick === k ? '  ◀ taken' : ''}
                </Text>
                {branch ? childCol(branch, `switch-case-${k}`) : null}
              </View>
            ))}
            {phase.switch.default ? (
              <View style={cstyles.branch}>
                <Text
                  style={[
                    cstyles.branchKey,
                    routePick === 'default' && cstyles.branchKeyActive,
                  ]}>
                  default:{routePick === 'default' ? '  ◀ taken' : ''}
                </Text>
                {childCol(phase.switch.default, 'switch-default')}
              </View>
            ) : null}
          </>
        ) : null}

        {composite === 'agents' &&
          ((phase.agents ?? []) as string[]).map((p, i, arr) => (
            <AgentRow key={i} path={p} last={i === arr.length - 1} />
          ))}

        {composite === 'conversation' &&
          ((phase.conversation?.participants ?? []) as string[]).map((p, i) => (
            <View key={i} style={cstyles.agentRow}>
              <Text style={cstyles.participantLabel}>participant:</Text>
              <Text style={cstyles.agentPath}>{p}</Text>
            </View>
          ))}
      </View>
    </View>
  );
}

/** The colored header bar that names a composite relation + live detail.
 *  `lines` (optional) renders as a compact vertical list under the header —
 *  used by `map` so a long `over [...]` array wraps instead of stretching. */
function RelationBar({
  meta,
  detail,
  lines,
  name,
  onPress,
}: {
  meta: { label: string; color: string; icon: string };
  detail: string;
  lines?: string[] | null;
  /** Parent composite name — used for the a11y label when clickable. */
  name?: string;
  /** When set, the bar is a button that edits the parent composite. */
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `Edit ${name ?? meta.label}` : undefined}
      style={[
        cstyles.relationBar,
        { backgroundColor: meta.color + '14', borderColor: meta.color + '55' },
      ]}>
      <View style={cstyles.relationHeader}>
        <Text style={[cstyles.relationIcon, { color: meta.color }]}>{meta.icon}</Text>
        <Text style={[cstyles.relationLabel, { color: meta.color }]}>{meta.label}</Text>
        {detail ? <Text style={cstyles.relationDetail}>{detail}</Text> : null}
        {onPress ? <Text style={cstyles.relationEditHint}>✎</Text> : null}
      </View>
      {lines && lines.length > 0 ? (
        <View style={cstyles.relationLines}>
          {lines.map((ln, i) => (
            <Text key={i} style={cstyles.relationLineText}>
              {ln}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Left-side return bracket for a loop body — the "loops back" arc. No SVG
 *  (none installed); a bordered View with rounded left corners + an up-arrow
 *  at the top reads as "flow returns to the start." */
function LoopArc({
  color,
  max,
  iter,
  children,
  onPress,
}: {
  color: string;
  max?: number;
  iter?: number;
  children: React.ReactNode;
  /** When set, the "loops back" bar edits the parent loop. */
  onPress?: () => void;
}) {
  return (
    <View style={cstyles.loopWrap}>
      <View style={cstyles.loopRow}>
        <View style={[cstyles.loopArcCol, { borderColor: color }]}>
          <Text style={[cstyles.loopArcArrow, { color }]}>▲</Text>
        </View>
        <View style={cstyles.loopBody}>{children}</View>
      </View>
      <Pressable
        onPress={onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={onPress ? 'Edit loop' : undefined}
        style={[cstyles.loopBackBar, { borderColor: color }]}>
        <Text style={[cstyles.loopBackText, { color }]}>
          ↻ loops back{max ? ` · up to ${max}×` : ''}
          {iter != null ? ` (now ${iter})` : ''}
        </Text>
      </Pressable>
    </View>
  );
}

/** A single agent path in a serial `agents` chain, with a ↓ to the next. */
function AgentRow({ path, last }: { path: string; last: boolean }) {
  return (
    <View>
      <View style={cstyles.agentRow}>
        <Text style={cstyles.agentPath}>{path}</Text>
      </View>
      {!last ? <Text style={cstyles.serialArrow}>↓</Text> : null}
    </View>
  );
}

function PhaseCard({
  phase,
  composite,
  runStatus,
  isLive = false,
  onPress,
  isSelected = false,
  hasError = false,
  errorMessage,
  collapsed = false,
  onToggle,
}: {
  phase: Node;
  /** Composite kind (null for leaf phases). Drives the collapse toggle + tag. */
  composite: CompositeKey | null;
  /** Live run status for this node — colors the border + status dot, and
   *  drives the pulse glow when running. */
  runStatus?: NodeRunStatus;
  isLive?: boolean;
  onPress: () => void;
  /** True when this phase is the currently-selected node in the
   *  page-level selection state. Renders a subtle outline so view
   *  switches preserve "which card am I on." Distinct from hasError
   *  — both can be true at once (red border wins visually). */
  isSelected?: boolean;
  /** True when this phase is the subject of at least one hard
   *  validation error. Renders the card with a red border + ⚠ badge
   *  in the header. */
  hasError?: boolean;
  /** First error message for this phase — used as a hover tooltip
   *  on the ⚠ badge. Available as a `title` attribute on web. */
  errorMessage?: string;
  /** Whether this composite is collapsed (children hidden). */
  collapsed?: boolean;
  /** Toggle collapse — only passed for composite phases. */
  onToggle?: () => void;
}) {
  // Hook is always called (top-level) so the rules of hooks hold even when
  // the node isn't running.
  const pulse = usePulse(isLive && runStatus === 'running');
  const statusColor = runStatus ? STATUS_COLOR[runStatus] : undefined;
  const childCount = composite ? compositeChildCount(phase, composite) : 0;
  return (
    // `cardWrap` is the positioning context only (so the absolute glow ring can
    // extend OUTSIDE the card). The bordered, rounded card itself is `cardBox`:
    // ONE container holding two sibling regions — (a) the header/body
    // select-Pressable and (b), for parent phases, the collapse/expand footer
    // Pressable. The border / background / radius + all status, error, selection
    // and pending styling live on `cardBox` so the footer sits INSIDE the box
    // (sharing its background and bottom corner radii) rather than reading as a
    // detached pill below it. `cardBox` has `overflow: 'hidden'` so the footer's
    // top hairline clips cleanly to the rounded corners; the glow stays on
    // `cardWrap` (outside the clip) so it isn't cut off. The two regions are
    // siblings (NOT nested) so the footer is its own independent hit-target and
    // can't steal — or be stolen from — the card's select tap.
    <View style={cstyles.cardWrap}>
      <View
        style={[
          cstyles.cardBox,
          // Selection highlight first so status / error styling (more
          // important) can override the border color when they apply.
          isSelected && styles.phaseCardSelected,
          statusColor ? { borderColor: statusColor } : null,
          runStatus === 'pending' ? cstyles.cardPending : null,
          hasError && styles.phaseCardError,
        ]}>
        <Pressable onPress={onPress} style={cstyles.cardSelect}>
          <View style={styles.phaseCardHeader}>
          <View style={cstyles.cardTitleRow}>
            <Text style={styles.phaseName}>{phase.name}</Text>
            {statusColor ? (
              <Animated.View
                style={[
                  cstyles.statusDot,
                  { backgroundColor: statusColor },
                  isLive && runStatus === 'running' ? { opacity: pulse } : null,
                ]}
              />
            ) : null}
          </View>
          {phase.lock && <Text style={styles.lockBadge}>🔒</Text>}
          {hasError && (
            <Text
              style={styles.errorBadge}
              // Title attribute → native browser tooltip on web. RN
              // ignores it; that's fine — the red border still flags
              // the card.
              {...({ title: errorMessage } as unknown as object)}>
              ⚠
            </Text>
          )}
        </View>
        {phase.agent && <Text style={styles.phaseAgent}>{phase.agent}</Text>}
        {phase.subflow && (
          <>
            <Text style={styles.phaseAgent}>subflow: {phase.subflow}</Text>
            {/* Unobtrusive subflow indicator — the small ⤳ icon + kind label.
                The expand/collapse bar at the card's bottom edge (rendered in
                cardWrap below) is the affordance now; no "expand to inline"
                wording here. */}
            <Text style={[styles.compositeTag, { color: SUBFLOW_META.color }]}>
              {SUBFLOW_META.icon} {SUBFLOW_META.label}
            </Text>
          </>
        )}
        {composite && (
          <Text style={[styles.compositeTag, { color: KIND_META[composite].color }]}>
            {KIND_META[composite].icon} {composite}
            {childCount ? ` · ${childCount}` : ''}
            {collapsed ? ' (collapsed)' : ''}
          </Text>
        )}
        {!phase.agent &&
          !composite &&
          !phase.subflow &&
          (() => {
            // A `code` leaf is a valid body — show the distinct script
            // display (kind chip + monospace preview) instead of the
            // "(no body)" placeholder, which is reserved for truly empty
            // leaves.
            const script = scriptDisplay(phase);
            if (script) {
              return (
                <View style={styles.scriptRow}>
                  <Text style={styles.scriptChip}>{script.label}</Text>
                  <Text
                    style={styles.scriptPreview}
                    numberOfLines={1}
                    ellipsizeMode="tail">
                    {script.preview}
                  </Text>
                </View>
              );
            }
            return <Text style={styles.phaseEmpty}>(no body)</Text>;
          })()}
        </Pressable>
        {/* Collapse/expand FOOTER — only on PARENT phases (composites and
            subflows; `onToggle` is supplied exactly for those). It is a sibling
            of the select-Pressable inside the same bordered `cardBox`, so it
            reads as the bottom of the box (shared background + bottom corner
            radii via cardBox's `overflow: 'hidden'`), separated from the body by
            a subtle top hairline. Being a separate full-width Pressable — NOT
            nested in the select-Pressable — its entire area is its own reliable
            tap target for `toggle()` and it never triggers the card's
            select/edit onPress. Leaf phases get no footer. */}
        {onToggle ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed }}
            accessibilityLabel={`${collapsed ? 'Expand' : 'Collapse'} ${phase.name ?? 'phase'}`}
            style={cstyles.expandFooter}>
            <Text style={cstyles.expandBarIcon}>{collapsed ? '⌄' : '⌃'}</Text>
          </Pressable>
        ) : null}
      </View>
      {/* Pulsing glow ring while this node is the one running. */}
      {isLive && runStatus === 'running' ? (
        <Animated.View
          pointerEvents="none"
          style={[cstyles.glow, { opacity: pulse }]}
        />
      ) : null}
    </View>
  );
}

function AddButton({
  onPress,
  dim = false,
}: {
  onPress: () => void;
  /** Visually de-emphasize this button when a sibling button is the
   *  "natural" next click — e.g. when the user is hovering a phase
   *  card, only the + immediately after that card stays at full
   *  opacity. Helps the user find which + means "insert here." */
  dim?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.addButton, dim && styles.addButtonDim]}
      accessibilityLabel="Add phase">
      <Text style={styles.addButtonText}>+</Text>
    </Pressable>
  );
}

function Arrow({ active = false, done = false }: { active?: boolean; done?: boolean }) {
  // `active` = leads into the node currently running → blue (eye follows the
  // live flow); `done` = leads into a completed node → green, so finished
  // connector bars read green alongside the green node borders.
  return (
    <Text style={[styles.arrow, done && styles.arrowDone, active && styles.arrowActive]}>→</Text>
  );
}

type ModalProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Called when the user presses Cmd/Ctrl+Enter while the modal is
   *  visible. Lets the caller submit the form without reaching for
   *  the Save button — saves a mouse trip per phase edit. Caller
   *  should noop when the form isn't submittable. */
  onSubmitShortcut?: () => void;
};

function Modal({ visible, onClose, children, onSubmitShortcut }: ModalProps) {
  // Keyboard shortcuts: Esc closes the modal, Cmd/Ctrl+Enter triggers
  // the submit shortcut. Attached to document while the modal is
  // visible; cleaned up on close so other surfaces (the toolbar,
  // graph canvas) don't see the listener.
  //
  // RN-Web tsconfig doesn't include DOM types — cast through
  // globalThis for `document` and explicitly type the KeyboardEvent
  // shape we use. Same pattern as ConnectionsPage's window-hash nav.
  useEffect(() => {
    if (!visible) return;
    type KbdEvt = {
      key: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      preventDefault?: () => void;
    };
    type DocLike = {
      addEventListener(type: string, listener: (e: KbdEvt) => void): void;
      removeEventListener(type: string, listener: (e: KbdEvt) => void): void;
    };
    const g = globalThis as unknown as { document?: DocLike };
    const doc = g.document;
    if (!doc) return;
    const handler = (e: KbdEvt) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onClose();
        return;
      }
      if (
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey) &&
        onSubmitShortcut
      ) {
        e.preventDefault?.();
        onSubmitShortcut();
      }
    };
    doc.addEventListener('keydown', handler);
    return () => doc.removeEventListener('keydown', handler);
  }, [visible, onClose, onSubmitShortcut]);

  if (!visible) return null;
  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalPanel}>{children}</View>
    </View>
  );
}

function AddPhaseModal({
  visible,
  availablePhases,
  onClose,
  onSubmit,
  title,
}: {
  visible: boolean;
  availablePhases: Node[];
  onClose: () => void;
  onSubmit: (phase: Node) => void;
  title?: string;
}) {
  const [tab, setTab] = useState<'create' | 'pick'>('create');
  // Filter for the "pick existing" list — it can hold dozens of phases
  // harvested from every orchestration, so a flat list is unusable.
  const [pickQuery, setPickQuery] = useState('');
  // Submit handle wired through Modal → PhaseForm so Cmd/Ctrl+Enter
  // triggers Save from anywhere inside the panel. Only active when
  // the "create" tab is open (the pick list submits via row click).
  const submitRef = useRef<(() => void) | null>(null);

  const pq = pickQuery.trim().toLowerCase();
  const filteredPhases = pq
    ? availablePhases.filter(
        p =>
          p.name.toLowerCase().includes(pq) ||
          (p.agent ?? '').toLowerCase().includes(pq) ||
          (p.description ?? '').toLowerCase().includes(pq),
      )
    : availablePhases;

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      onSubmitShortcut={
        tab === 'create' ? () => submitRef.current?.() : undefined
      }>
      <View style={styles.modalHeader}>
        <Text style={styles.modalTitle}>{title ?? 'Add phase'}</Text>
        <Pressable onPress={onClose}>
          <Text style={styles.modalClose}>×</Text>
        </Pressable>
      </View>

      <View style={styles.tabRow}>
        <Pressable
          onPress={() => setTab('create')}
          style={[styles.tab, tab === 'create' && styles.tabActive]}>
          <Text style={[styles.tabText, tab === 'create' && styles.tabTextActive]}>
            Create new
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setTab('pick')}
          style={[styles.tab, tab === 'pick' && styles.tabActive]}>
          <Text style={[styles.tabText, tab === 'pick' && styles.tabTextActive]}>
            Pick existing ({availablePhases.length})
          </Text>
        </Pressable>
      </View>

      {tab === 'create' ? (
        <ScrollView style={styles.createScroll}>
          <PhaseForm
            onSubmit={onSubmit}
            submitLabel="Add to pipeline"
            submitRef={submitRef}
          />
        </ScrollView>
      ) : (
        <View>
          {availablePhases.length > 8 && (
            <TextInput
              value={pickQuery}
              onChangeText={setPickQuery}
              placeholder={`Search ${availablePhases.length} phases…`}
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.pickSearch}
            />
          )}
          <ScrollView style={styles.pickList}>
            {availablePhases.length === 0 ? (
              <Text style={styles.emptyHint}>No reusable phases yet.</Text>
            ) : filteredPhases.length === 0 ? (
              <Text style={styles.emptyHint}>
                No phases match "{pickQuery.trim()}".
              </Text>
            ) : (
              filteredPhases.map((p, i) => (
                <Pressable
                  key={`${p.name}-${i}`}
                  onPress={() => onSubmit({ ...p })}
                  accessibilityRole="button"
                  accessibilityLabel={`Add phase ${p.name}`}
                  style={styles.pickItem}>
                  <Text style={styles.phaseName}>{p.name}</Text>
                  {p.agent && <Text style={styles.phaseAgent}>{p.agent}</Text>}
                  {p.description && (
                    <Text style={styles.pickDesc}>{p.description}</Text>
                  )}
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}

/** Inline editor for switch cases / route branches — rows of value/key → the
 *  agent that runs for it, with add/remove. A blank agent leaves a scaffold
 *  the user can flesh out (into a richer branch) in Tree view. */
function CaseRowsEditor({
  itemLabel,
  keyPlaceholder,
  rows,
  onChange,
}: {
  itemLabel: string;
  keyPlaceholder: string;
  rows: Array<{ key: string; agent: string }>;
  onChange: (rows: Array<{ key: string; agent: string }>) => void;
}) {
  const setRow = (
    i: number,
    patch: Partial<{ key: string; agent: string }>,
  ) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <View style={styles.caseRows}>
      {rows.map((r, i) => (
        <View key={i} style={styles.caseRow}>
          <TextInput
            value={r.key}
            onChangeText={t => setRow(i, { key: t })}
            placeholder={keyPlaceholder}
            style={[styles.input, styles.caseKeyInput]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.caseArrow}>→</Text>
          <TextInput
            value={r.agent}
            onChangeText={t => setRow(i, { agent: t })}
            placeholder="agents/x.md"
            style={[styles.input, styles.caseAgentInput]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={() => onChange(rows.filter((_, j) => j !== i))}
            style={styles.caseRemove}
            accessibilityLabel={`Remove ${itemLabel}`}>
            <Text style={styles.caseRemoveText}>×</Text>
          </Pressable>
        </View>
      ))}
      <Pressable
        onPress={() => onChange([...rows, { key: '', agent: '' }])}
        style={styles.caseAddBtn}>
        <Text style={styles.caseAddText}>+ Add {itemLabel}</Text>
      </Pressable>
    </View>
  );
}

export function PhaseForm({
  initial,
  onSubmit,
  onDelete,
  submitLabel,
  submitRef,
}: {
  initial?: Node;
  onSubmit: (phase: Node) => void;
  onDelete?: () => void;
  submitLabel: string;
  /** Optional handle so the enclosing modal can trigger submit from
   *  a Cmd/Ctrl+Enter keyboard shortcut. The ref's `.current` is set
   *  to the form's submit function while the form is mounted. */
  submitRef?: { current: (() => void) | null };
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [agent, setAgent] = useState(initial?.agent ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [lock, setLock] = useState(initial?.lock ?? false);

  // ─── Body kind (B.1) ───
  // Every phase has exactly one body. The picker below lets the user
  // switch a leaf phase into a composite (or vice-versa) without
  // dropping to JSON or to Tree view. Composite bodies with
  // structured children still defer to Tree view for child-level
  // edits — the form only owns the kind choice and the leaf-shaped
  // fields per kind.
  type BodyKind =
    | 'agent'
    | 'code'
    | 'subflow'
    | 'agents'
    | 'phases'
    | 'parallel'
    | 'converge'
    | 'loop'
    | 'conversation'
    | 'route'
    | 'switch'
    | 'map';
  function deriveInitialKind(n: Node | undefined): BodyKind {
    if (!n) return 'agent';
    const c = compositeKey(n);
    if (c) return c;
    if (n.subflow) return 'subflow';
    if (n.code) return 'code';
    return 'agent';
  }
  const originalKind = deriveInitialKind(initial);
  const [bodyKind, setBodyKind] = useState<BodyKind>(originalKind);
  const [codeSource, setCodeSource] = useState(initial?.code?.source ?? '');
  const [subflow, setSubflow] = useState(initial?.subflow ?? '');
  const [agentsCsv, setAgentsCsv] = useState(
    initial?.agents ? initial.agents.join(', ') : '',
  );
  // Map/loop/conversation have shallow text fields we can edit
  // in-place. Children-bearing kinds (phases / parallel / converge /
  // route) are managed in Tree view; we preserve their existing
  // arrays/objects on submit but don't expose child edits here.
  const [mapOver, setMapOver] = useState(initial?.map?.over ?? '');
  const [loopMaxIter, setLoopMaxIter] = useState(
    initial?.loop?.maxIterations !== undefined
      ? String(initial.loop.maxIterations)
      : '',
  );
  const [loopUntil, setLoopUntil] = useState(initial?.loop?.until ?? '');
  const [convoRounds, setConvoRounds] = useState(
    initial?.conversation?.rounds !== undefined
      ? String(initial.conversation.rounds)
      : '',
  );
  const [convoParticipantsCsv, setConvoParticipantsCsv] = useState(
    initial?.conversation?.participants
      ? initial.conversation.participants.join(', ')
      : '',
  );
  // Optional single agent for the body of map (per item) / loop (per
  // iteration) — the common case. A richer body (a composite) is built in
  // Tree view and preserved on submit.
  const [mapBodyAgent, setMapBodyAgent] = useState(
    initial?.map?.body?.agent ?? '',
  );
  const [loopBodyAgent, setLoopBodyAgent] = useState(
    initial?.loop?.body?.agent ?? '',
  );
  // Inline case/branch editing for switch + route: rows of value/key -> the
  // agent to run. A case whose branch is a richer composite (built in Tree
  // view) is preserved on submit; here we edit the common "value -> agent".
  const branchRowsFrom = (
    branches: Record<string, Node> | undefined,
  ): Array<{ key: string; agent: string }> =>
    branches
      ? Object.entries(branches).map(([k, n]) => ({ key: k, agent: n.agent ?? '' }))
      : [];
  const [switchOn, setSwitchOn] = useState(initial?.switch?.on ?? '');
  const [switchCases, setSwitchCases] = useState<
    Array<{ key: string; agent: string }>
  >(() => branchRowsFrom(initial?.switch?.cases));
  const [switchDefaultAgent, setSwitchDefaultAgent] = useState(
    initial?.switch?.default?.agent ?? '',
  );
  const [routerPath, setRouterPath] = useState(initial?.route?.router ?? '');
  const [routeBranches, setRouteBranches] = useState<
    Array<{ key: string; agent: string }>
  >(() => branchRowsFrom(initial?.route?.branches));
  const [routeDefaultAgent, setRouteDefaultAgent] = useState(
    initial?.route?.default?.agent ?? '',
  );
  // Build a {key -> Node} map + optional default Node from the inline rows,
  // preserving any prior branch that's a richer composite (non-agent) the
  // user built in Tree view.
  function buildBranches(
    rows: Array<{ key: string; agent: string }>,
    prior: Record<string, Node> | undefined,
    defaultAgent: string,
  ): { map: Record<string, Node>; default?: Node } {
    const map: Record<string, Node> = {};
    for (const { key, agent } of rows) {
      const k = key.trim();
      if (!k) continue;
      const priorNode = prior?.[k];
      map[k] =
        priorNode && !priorNode.agent
          ? priorNode // keep a composite branch built in Tree view
          : { name: k, agent: agent.trim() };
    }
    const def = defaultAgent.trim()
      ? ({ name: 'default', agent: defaultAgent.trim() } as Node)
      : undefined;
    return def ? { map, default: def } : { map };
  }

  // ─── Advanced (collapsed by default) ───
  // The form previously exposed name + agent + description + lock and
  // nothing else. For non-trivial phases (retry, timeout,
  // continueOnError, model override, etc.) users had to drop to the
  // JSON view. The fields below mirror the decorators in types.ts so
  // the form is at parity with the on-disk shape for the common
  // configs. Composites still drop to JSON for their kind-specific
  // bodies; that's a separate larger PR.
  //
  // Auto-expand the section when the incoming phase already has
  // advanced fields set — otherwise editing wouldn't reveal what was
  // there.
  const hasAdvancedInitially = !!(
    initial?.retry ||
    initial?.timeout !== undefined ||
    initial?.continueOnError !== undefined ||
    initial?.halt ||
    initial?.when ||
    initial?.model ||
    initial?.provider ||
    initial?.credential ||
    initial?.maxTurns !== undefined ||
    (initial?.tools && initial.tools.length > 0)
  );
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedInitially);
  const [retryTimes, setRetryTimes] = useState(
    initial?.retry?.times !== undefined ? String(initial.retry.times) : '',
  );
  const [timeoutSec, setTimeoutSec] = useState(
    initial?.timeout !== undefined ? String(initial.timeout) : '',
  );
  const [continueOnError, setContinueOnError] = useState(
    !!initial?.continueOnError,
  );
  const [halt, setHalt] = useState(!!initial?.halt);
  const [whenExpr, setWhenExpr] = useState(initial?.when ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [provider, setProvider] = useState<string>(initial?.provider ?? '');
  const [credential, setCredential] = useState(initial?.credential ?? '');
  const [maxTurns, setMaxTurns] = useState(
    initial?.maxTurns !== undefined ? String(initial.maxTurns) : '',
  );
  const [toolsCsv, setToolsCsv] = useState(
    initial?.tools ? initial.tools.join(', ') : '',
  );

  // PhaseForm is rendered only for non-composite phases (see EditPhaseModal
  // — composite phases get the "Remove from pipeline" view instead). So
  // the form is implicitly the "agent kind" form: an agent path is the
  // body. Treating it as optional and then failing validation later is
  // the worst combination. Require it up front and label it honestly.
  // Per-kind minimum: every kind needs a name; leaf kinds need their
  // primary identifier; composite-with-children kinds delegate to
  // Tree view for the body but still need a name. Map needs an
  // `over` expression to be runnable.
  function canSubmitForKind(): boolean {
    if (name.trim().length === 0) return false;
    switch (bodyKind) {
      case 'agent':
        return agent.trim().length > 0;
      case 'code':
        return codeSource.trim().length > 0;
      case 'subflow':
        return subflow.trim().length > 0;
      case 'agents':
        return agentsCsv.trim().length > 0;
      case 'map':
        return mapOver.trim().length > 0;
      case 'conversation':
        return convoParticipantsCsv.trim().length > 0;
      case 'phases':
      case 'parallel':
      case 'converge':
      case 'loop':
      case 'route':
      case 'switch':
        // These delegate to Tree view for the body — name is enough
        // to save the wrapper + decorators. A composite with zero
        // children still saves; ValidationBanner will surface that
        // it's empty if it matters at run time.
        return true;
    }
  }
  const canSubmit = canSubmitForKind();

  // Expose submit() to the enclosing modal via the optional submitRef,
  // so Cmd/Ctrl+Enter routes here. Clear on unmount so the modal's
  // shortcut handler doesn't hold a stale callback.
  useEffect(() => {
    if (!submitRef) return;
    submitRef.current = () => submit();
    return () => {
      if (submitRef) submitRef.current = null;
    };
    // submit is closed over name/agent/etc; including them all keeps
    // the ref live as the form values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  function submit() {
    if (!canSubmit) return;
    const next: Node = { name: name.trim() };
    if (description.trim()) next.description = description.trim();
    if (lock) next.lock = true;

    // Body — write only the field that matches the chosen kind.
    // Children-bearing kinds preserve their original array/object if
    // the user is editing the same kind; switching to a new kind
    // starts an empty body that Tree view can populate.
    switch (bodyKind) {
      case 'agent':
        next.agent = agent.trim();
        break;
      case 'code':
        // Inline-JS script leaf (no LLM). Preserve a `run`-based code body if
        // the node already had one and the user didn't switch to a source.
        next.code =
          originalKind === 'code' && initial?.code?.run && !codeSource.trim()
            ? initial.code
            : { source: codeSource.trim() };
        break;
      case 'subflow':
        next.subflow = subflow.trim();
        break;
      case 'agents': {
        const arr = agentsCsv
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        next.agents = arr;
        break;
      }
      case 'phases':
        next.phases = originalKind === 'phases' && initial?.phases
          ? initial.phases
          : [];
        break;
      case 'parallel':
        next.parallel = originalKind === 'parallel' && initial?.parallel
          ? initial.parallel
          : [];
        break;
      case 'converge':
        next.converge = originalKind === 'converge' && initial?.converge
          ? initial.converge
          : [];
        if (initial?.merger) next.merger = initial.merger;
        break;
      case 'loop': {
        const maxN = loopMaxIter.trim() ? parseInt(loopMaxIter, 10) : NaN;
        // Preserve a composite body built in Tree view; otherwise use the
        // inline single agent (if given) or a bare placeholder.
        const priorBody =
          originalKind === 'loop' && initial?.loop?.body
            ? initial.loop.body
            : null;
        const body: Node =
          priorBody && !priorBody.agent
            ? priorBody
            : { name: priorBody?.name ?? 'iteration', ...(loopBodyAgent.trim() ? { agent: loopBodyAgent.trim() } : {}) };
        next.loop = {
          // maxIterations is required by LoopBody — default to 5 when the
          // field is blank/invalid so the loop always has a bound.
          body,
          maxIterations: Number.isFinite(maxN) && maxN > 0 ? maxN : 5,
          ...(loopUntil.trim() ? { until: loopUntil.trim() } : {}),
          ...(originalKind === 'loop' && initial?.loop?.judge
            ? { judge: initial.loop.judge }
            : {}),
        };
        break;
      }
      case 'conversation': {
        const participants = convoParticipantsCsv
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        // ConversationBody uses `rounds` (what the executor reads); `rounds`
        // is required, so default to 4 when blank.
        const roundsN = convoRounds.trim() ? parseInt(convoRounds, 10) : NaN;
        next.conversation = {
          participants,
          rounds: Number.isFinite(roundsN) && roundsN > 0 ? roundsN : 4,
        };
        break;
      }
      case 'route': {
        const built = buildBranches(
          routeBranches,
          originalKind === 'route' ? initial?.route?.branches : undefined,
          routeDefaultAgent,
        );
        next.route = {
          ...(routerPath.trim() ? { router: routerPath.trim() } : {}),
          branches: built.map,
          ...(built.default ? { default: built.default } : {}),
        };
        break;
      }
      case 'switch': {
        const built = buildBranches(
          switchCases,
          originalKind === 'switch' ? initial?.switch?.cases : undefined,
          switchDefaultAgent,
        );
        next.switch = {
          ...(switchOn.trim() ? { on: switchOn.trim() } : {}),
          cases: built.map,
          ...(built.default ? { default: built.default } : {}),
        };
        break;
      }
      case 'map': {
        // Preserve a composite item-body built in Tree view; else use the
        // inline single agent (if given) or a bare placeholder.
        const priorBody =
          originalKind === 'map' && initial?.map?.body
            ? initial.map.body
            : null;
        const body: Node =
          priorBody && !priorBody.agent
            ? priorBody
            : { name: priorBody?.name ?? 'item', ...(mapBodyAgent.trim() ? { agent: mapBodyAgent.trim() } : {}) };
        next.map =
          originalKind === 'map' && initial?.map
            ? { ...initial.map, over: mapOver.trim(), body }
            : { over: mapOver.trim(), body };
        break;
      }
    }
    // Advanced fields — write each only when filled. Numeric fields
    // get a parseFloat / parseInt that silently ignores garbage; if
    // the user typed nonsense, the field is dropped rather than
    // saved as NaN.
    const retryN = retryTimes.trim() ? parseInt(retryTimes, 10) : NaN;
    if (Number.isFinite(retryN) && retryN > 0) {
      next.retry = { times: retryN };
    }
    const timeoutN = timeoutSec.trim() ? parseFloat(timeoutSec) : NaN;
    if (Number.isFinite(timeoutN) && timeoutN > 0) next.timeout = timeoutN;
    if (continueOnError) next.continueOnError = true;
    if (halt) next.halt = true;
    if (whenExpr.trim()) next.when = whenExpr.trim();
    if (model.trim()) next.model = model.trim();
    if (
      provider === 'anthropic' ||
      provider === 'openai' ||
      provider === 'gemini' ||
      provider === 'claude-code'
    ) {
      next.provider = provider;
    }
    if (credential.trim()) next.credential = credential.trim();
    const maxTurnsN = maxTurns.trim() ? parseInt(maxTurns, 10) : NaN;
    if (Number.isFinite(maxTurnsN) && maxTurnsN > 0) next.maxTurns = maxTurnsN;
    const tools = toolsCsv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (tools.length > 0) next.tools = tools;
    onSubmit(next);
  }

  return (
    <View style={styles.form}>
      <Field label="Name">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="spec, plan, qa, ..."
          style={styles.input}
          autoCapitalize="none"
        />
      </Field>

      {/* Body kind picker (B.1). Lets the user switch between agent /
       *  subflow / agents / phases / parallel / converge / loop /
       *  conversation / route / map without leaving the form.
       *  Composite kinds with structured children delegate to Tree
       *  view for child edits; this form still owns the wrapper
       *  decorators (name, description, lock, advanced). */}
      <Field label="Body">
        <View style={styles.bodyKindPicker}>
          {(
            [
              'agent',
              'code',
              'subflow',
              'agents',
              'phases',
              'parallel',
              'converge',
              'loop',
              'conversation',
              'route',
              'switch',
              'map',
            ] as BodyKind[]
          ).map(k => (
            <Pressable
              key={k}
              onPress={() => setBodyKind(k)}
              style={[
                styles.bodyKindOption,
                bodyKind === k && styles.bodyKindOptionActive,
              ]}>
              <Text
                style={[
                  styles.bodyKindOptionText,
                  bodyKind === k && styles.bodyKindOptionTextActive,
                ]}>
                {k}
              </Text>
            </Pressable>
          ))}
        </View>
        {bodyKind !== originalKind && (
          <Text style={styles.bodyKindWarning}>
            Switching kind from <Text style={styles.code}>{originalKind}</Text>{' '}
            → <Text style={styles.code}>{bodyKind}</Text>. Existing body fields
            from the old kind will be dropped when you Save.
          </Text>
        )}
      </Field>

      {bodyKind === 'agent' && (
        <Field label="Agent path *">
          <TextInput
            value={agent}
            onChangeText={setAgent}
            placeholder="agents/pm.md"
            style={styles.input}
            autoCapitalize="none"
          />
        </Field>
      )}
      {bodyKind === 'code' && (
        <Field label="Script — inline JavaScript (no LLM call) *">
          <TextInput
            value={codeSource}
            onChangeText={setCodeSource}
            placeholder={
              "// runs in a sandbox; in scope: input, state, item, index, vars\n" +
              "return JSON.parse(input).filter(x => x.score > 0.5);"
            }
            style={[styles.input, styles.inputMultiline, styles.codeInput]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.bodyChildrenHint}>
            Deterministic transform between phases. The return value becomes the
            next phase's input (objects are JSON-stringified). No network / fs —
            only input, state, item, index, vars and JS built-ins.
          </Text>
        </Field>
      )}
      {bodyKind === 'subflow' && (
        <Field label="Subflow name *">
          <TextInput
            value={subflow}
            onChangeText={setSubflow}
            placeholder="name of another orchestration in this workspace"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      )}
      {bodyKind === 'agents' && (
        <Field label="Sequential agent paths * (comma-separated)">
          <TextInput
            value={agentsCsv}
            onChangeText={setAgentsCsv}
            placeholder="agents/pm.md, agents/dev.md, agents/qa.md"
            style={[styles.input, styles.inputMultiline]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      )}
      {bodyKind === 'map' && (
        <>
          <Field label="Map over (expression) *">
            <TextInput
              value={mapOver}
              onChangeText={setMapOver}
              placeholder="${state.items}"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Run for each item — agent (optional)">
            <TextInput
              value={mapBodyAgent}
              onChangeText={setMapBodyAgent}
              placeholder="agents/x.md — ${item} / ${index} in scope; richer body in Tree view"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </>
      )}
      {bodyKind === 'loop' && (
        <>
          <Field label="Max iterations (optional)">
            <TextInput
              value={loopMaxIter}
              onChangeText={setLoopMaxIter}
              placeholder="e.g. 5"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numeric"
            />
          </Field>
          <Field label="until (stop predicate, optional)">
            <TextInput
              value={loopUntil}
              onChangeText={setLoopUntil}
              placeholder="${last.body.output} == 'STOP'"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Run each iteration — agent (optional)">
            <TextInput
              value={loopBodyAgent}
              onChangeText={setLoopBodyAgent}
              placeholder="agents/refine.md — richer body in Tree view"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </>
      )}
      {bodyKind === 'conversation' && (
        <>
          <Field label="Participants * (comma-separated agent paths)">
            <TextInput
              value={convoParticipantsCsv}
              onChangeText={setConvoParticipantsCsv}
              placeholder="agents/pm.md, agents/critic.md"
              style={[styles.input, styles.inputMultiline]}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Rounds (optional, default 4)">
            <TextInput
              value={convoRounds}
              onChangeText={setConvoRounds}
              placeholder="e.g. 6"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numeric"
            />
          </Field>
        </>
      )}
      {bodyKind === 'switch' && (
        <>
          <Field label="Switch on (expression, optional)">
            <TextInput
              value={switchOn}
              onChangeText={setSwitchOn}
              placeholder="${verdict} — blank uses the previous phase's output"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Cases — value → agent to run">
            <CaseRowsEditor
              itemLabel="case"
              keyPlaceholder="true"
              rows={switchCases}
              onChange={setSwitchCases}
            />
            <Text style={styles.bodyChildrenHint}>
              Each value is plain text, matched EXACTLY against the switch value
              (e.g. true / false, or x / y / z, or a status word). For a richer
              branch than one agent, leave the agent blank and build it in Tree
              view.
            </Text>
          </Field>
          <Field label="Default — agent if nothing matches (optional)">
            <TextInput
              value={switchDefaultAgent}
              onChangeText={setSwitchDefaultAgent}
              placeholder="agents/fallback.md"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </>
      )}
      {bodyKind === 'route' && (
        <>
          <Field label="Router agent (optional)">
            <TextInput
              value={routerPath}
              onChangeText={setRouterPath}
              placeholder="agents/router.md — blank matches the input against the keys"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Branches — key → agent to run">
            <CaseRowsEditor
              itemLabel="branch"
              keyPlaceholder="bug"
              rows={routeBranches}
              onChange={setRouteBranches}
            />
            <Text style={styles.bodyChildrenHint}>
              The router (or a case-insensitive match of the input) picks a key.
              For a richer branch than one agent, leave the agent blank and build
              it in Tree view.
            </Text>
          </Field>
          <Field label="Default — agent if nothing matches (optional)">
            <TextInput
              value={routeDefaultAgent}
              onChangeText={setRouteDefaultAgent}
              placeholder="agents/escalate.md"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </>
      )}
      {(bodyKind === 'phases' ||
        bodyKind === 'parallel' ||
        bodyKind === 'converge' ||
        bodyKind === 'loop' ||
        bodyKind === 'map') && (
        <Text style={styles.bodyChildrenHint}>
          {bodyKind === 'loop' &&
            '↪ For a multi-step iteration body, leave the agent blank and build it in Tree view.'}
          {bodyKind === 'map' &&
            '↪ For a multi-step per-item body, leave the agent blank and build it in Tree view.'}
          {(bodyKind === 'phases' ||
            bodyKind === 'parallel' ||
            bodyKind === 'converge') &&
            `↪ ${
              originalKind === bodyKind
                ? `${(initial?.[bodyKind] as Node[] | undefined)?.length ?? 0} child phase(s)`
                : 'No children yet'
            } — add / edit children in Tree view.`}
        </Text>
      )}

      <Field label="Description (optional)">
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What does this phase do?"
          style={[styles.input, styles.inputMultiline]}
          multiline
        />
      </Field>

      <View style={styles.row}>
        <Text style={styles.label}>Lock (require human approval)</Text>
        <Switch value={lock} onValueChange={setLock} />
      </View>

      {/* Advanced decorators — collapsed by default; expands inline
       *  when the disclosure is tapped. Auto-expands when editing a
       *  phase that already has any advanced field set so the user
       *  doesn't lose data by accident. Mirrors the Connections page
       *  "▸ Edit raw JSON" disclosure pattern. */}
      <Pressable
        onPress={() => setAdvancedOpen(v => !v)}
        style={styles.advancedToggle}>
        <Text style={styles.advancedToggleText}>
          {advancedOpen ? '▾' : '▸'} Advanced (retry, timeout, model, provider, …)
        </Text>
      </Pressable>
      {advancedOpen && (
        <View style={styles.advancedSection}>
          <Field label="Retry times">
            <TextInput
              value={retryTimes}
              onChangeText={setRetryTimes}
              placeholder="e.g. 3 — empty = no retries"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numeric"
            />
          </Field>
          <Field label="Timeout (seconds)">
            <TextInput
              value={timeoutSec}
              onChangeText={setTimeoutSec}
              placeholder="e.g. 300"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numeric"
            />
          </Field>
          <View style={styles.row}>
            <Text style={styles.label}>continueOnError</Text>
            <Switch
              value={continueOnError}
              onValueChange={setContinueOnError}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>halt (end the run after this phase)</Text>
            <Switch value={halt} onValueChange={setHalt} />
          </View>
          <Field label="when (predicate, e.g. ${input.kind} == 'A')">
            <TextInput
              value={whenExpr}
              onChangeText={setWhenExpr}
              placeholder="leave blank to always run"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Model override (e.g. claude-opus-4-7)">
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="leave blank to use run-wide default"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Provider (anthropic / openai / gemini / claude-code)">
            <TextInput
              value={provider}
              onChangeText={setProvider}
              placeholder="leave blank to use the default routing"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="Credential name (entry in credentials.json)">
            <TextInput
              value={credential}
              onChangeText={setCredential}
              placeholder="e.g. anthropic-prod"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Field label="maxTurns">
            <TextInput
              value={maxTurns}
              onChangeText={setMaxTurns}
              placeholder="e.g. 50 — empty = use the run-wide default"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="numeric"
            />
          </Field>
          <Field label="Tools (comma-separated, e.g. Read, Bash, WebFetch)">
            <TextInput
              value={toolsCsv}
              onChangeText={setToolsCsv}
              placeholder="leave blank for the agent's defaults"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Text style={styles.advancedHint}>
            Empty fields are not written to the phase — they fall back to
            run-wide defaults. To clear a value that&apos;s already set,
            blank the field and Save.
          </Text>
        </View>
      )}

      {/* Primary action row: Save (and Cancel, when caller provides
          one) sit at the top. Delete is moved below a visual divider
          so a mis-target can't hit it on the way to Save — matches
          the Graph view's right-panel pattern, so both editors put
          the destructive action in the same place. */}
      <View style={styles.buttonRow}>
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={[styles.button, styles.primaryButton, !canSubmit && styles.buttonDisabled]}>
          <Text style={styles.primaryButtonText}>{submitLabel}</Text>
        </Pressable>
      </View>
      {onDelete && (
        <>
          <View style={styles.dangerDivider} />
          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => {
                // Destructive action, so it is confirm-guarded. The
                // visual separation from Save (above the divider) is
                // the other half of the safety: even a mis-click on
                // Save's area won't land on Delete.
                const g = globalThis as unknown as {
                  confirm?: (m: string) => boolean;
                };
                const label = name.trim() || 'this phase';
                if (g.confirm && !g.confirm(`Delete phase "${label}"?`)) {
                  return;
                }
                onDelete();
              }}
              style={[styles.button, styles.dangerButton, styles.dangerButtonFull]}>
              <Text style={styles.dangerButtonText}>Delete phase</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  containerRow: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
  },
  pipelineColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  dockedPanel: {
    width: 380,
    borderLeftWidth: 1,
    borderLeftColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  panelHeaderText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  panelClose: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  panelCloseText: {
    fontSize: 22,
    color: '#6b7280',
    fontWeight: '500',
  },
  panelScroll: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  // Structural-action footer in the edit panel (Duplicate / Wrap …).
  panelActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  panelActionBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
  },
  panelActionText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  // Outer vertical scroll — bounded by the column height so tall expanded
  // composites can be scrolled into view.
  pipelineVScroll: { flex: 1 },
  pipelineVContent: { flexGrow: 1 },
  pipeline: {
    flexDirection: 'row',
    // Top-align so a composite column that expands downward doesn't drag
    // the whole lane's vertical centering — the cards stay on one line.
    alignItems: 'flex-start',
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  phaseRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  // Card box base style moved to `cstyles.cardBox` (the bordered/rounded
  // container) + `cstyles.cardSelect` (the body padding) so the collapse/expand
  // footer can live INSIDE the same box. The selected/error/header styles below
  // are still applied to that box.
  // Applied when this phase has at least one hard validation error.
  // Red border + tinted background so the user can spot the bad
  // phase at a glance — banner is the index, card is the locator.
  phaseCardError: {
    borderColor: '#dc2626',
    backgroundColor: '#fef2f2',
  },
  // Applied when this phase is the currently-selected node in the
  // shared selection state (persisted across Pipeline / Graph / Tree
  // view switches). Blue border + faint tint — distinct from the
  // error red and the default gray so all three states are legible
  // at a glance. When both isSelected and hasError apply, error wins
  // (style order in the Pressable's style array enforces that).
  phaseCardSelected: {
    borderColor: '#2563eb',
    borderWidth: 2,
    backgroundColor: '#eff6ff',
  },
  phaseCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  phaseName: {
    fontWeight: '600',
    fontSize: 14,
    color: '#111827',
  },
  lockBadge: {
    fontSize: 12,
  },
  errorBadge: {
    fontSize: 14,
    color: '#dc2626',
    fontWeight: '700',
    marginLeft: 4,
  },
  phaseAgent: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#6b7280',
    marginTop: 4,
  },
  phaseEmpty: {
    fontSize: 11,
    color: '#9ca3af',
    fontStyle: 'italic',
    marginTop: 4,
  },
  compositeTag: {
    fontSize: 11,
    color: '#d97706',
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Non-agent / script leaf display: kind chip ("SCRIPT" for code.run,
  // "CODE" for inline code.source) + a monospace, single-line preview of the
  // body content. Distinguishes script phases from agent phases (which show
  // an agent path) and from the "(no body)" placeholder.
  scriptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 6,
    marginTop: 4,
  },
  scriptChip: {
    fontSize: 9,
    fontWeight: '700',
    color: '#7c3aed',
    backgroundColor: '#f5f3ff',
    borderWidth: 1,
    borderColor: '#ddd6fe',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scriptPreview: {
    flex: 1,
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#4b5563',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f4f6',
    // Align with the card header in the now top-aligned lane.
    marginTop: 3,
  },
  addButtonText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#6b7280',
    lineHeight: 22,
  },
  // Applied when a different phase is hovered — the "+ after hovered
  // phase" stays bright; everyone else fades. Smooth opacity (not
  // hidden) so the user can still spot all + targets if they want.
  addButtonDim: {
    opacity: 0.35,
  },
  arrow: {
    fontSize: 18,
    color: '#9ca3af',
    paddingHorizontal: 6,
    // Nudge down so the connector lines up with the card header now that
    // the lane is top-aligned (cards can be tall when expanded).
    marginTop: 14,
  },
  arrowActive: {
    color: '#2563eb',
    fontWeight: '700',
  },
  arrowDone: {
    color: '#059669',
    fontWeight: '700',
  },
  emptyHint: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'center',
    marginTop: -12,
  },

  // Modal
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.4)',
  },
  modalPanel: {
    width: '90%',
    maxWidth: 480,
    // Never taller than the viewport — the body scrolls instead of the whole
    // panel overflowing off-screen (e.g. when Advanced is expanded).
    maxHeight: '90%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    overflow: 'hidden',
  },
  // Scroll region for the create-new form; header + tabs stay pinned above it.
  createScroll: {
    flexShrink: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  modalClose: {
    fontSize: 24,
    color: '#6b7280',
    paddingHorizontal: 8,
    lineHeight: 24,
  },

  // Tabs
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    marginBottom: 12,
  },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#2563eb',
  },
  tabText: {
    fontSize: 13,
    color: '#6b7280',
  },
  tabTextActive: {
    color: '#2563eb',
    fontWeight: '600',
  },

  // Pick list
  pickSearch: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  pickList: {
    maxHeight: 320,
  },
  pickItem: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    marginBottom: 8,
  },
  pickDesc: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
    marginTop: 4,
  },

  // Form
  form: {
    gap: 12,
  },
  field: {
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  inputMultiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  codeInput: {
    minHeight: 96,
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  caseRows: {
    gap: 6,
  },
  caseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  caseKeyInput: {
    width: 96,
  },
  caseAgentInput: {
    flex: 1,
  },
  caseArrow: {
    fontSize: 14,
    color: '#9ca3af',
  },
  caseRemove: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  caseRemoveText: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '700',
    lineHeight: 16,
  },
  caseAddBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  caseAddText: {
    fontSize: 12,
    color: '#1d4ed8',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // ─── Advanced decorator disclosure ───
  advancedToggle: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginTop: 4,
  },
  advancedToggleText: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: '600',
  },
  advancedSection: {
    gap: 10,
    paddingTop: 4,
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderRadius: 6,
    backgroundColor: '#f9fafb',
  },
  advancedHint: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
    marginTop: -2,
  },
  bodyKindPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  bodyKindOption: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  bodyKindOptionActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  bodyKindOptionText: {
    fontSize: 11,
    color: '#374151',
    fontWeight: '600',
  },
  bodyKindOptionTextActive: {
    color: '#1d4ed8',
  },
  bodyKindWarning: {
    fontSize: 11,
    color: '#b45309',
    marginTop: 6,
    lineHeight: 16,
  },
  bodyChildrenHint: {
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    marginTop: -8,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  button: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 6,
  },
  primaryButton: {
    backgroundColor: '#2563eb',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  dangerButton: {
    backgroundColor: '#fee2e2',
  },
  // Full-width variant for when Delete sits alone on its own row
  // below the divider — emphasizes that this is the destructive
  // bottom action, not a sibling of Save.
  dangerButtonFull: {
    flex: 1,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: '#b91c1c',
    fontWeight: '600',
    fontSize: 14,
  },
  // Horizontal hairline between Save (above) and Delete (below) so
  // a mis-target can't land on Delete on the way to Save. Matches
  // the Graph view right-panel's "Save area / divider / Delete
  // area" structure, so the two panels read the same.
  dangerDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginTop: 16,
    marginBottom: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },

  // Composite hint
  compositeHint: {
    padding: 12,
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fde68a',
    gap: 10,
  },
  compositeHintTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#92400e',
  },
  compositeHintBody: {
    fontSize: 12,
    color: '#92400e',
    lineHeight: 18,
  },
  code: {
    fontFamily: 'Menlo',
    fontSize: 11,
    backgroundColor: '#fef3c7',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
});

// Styles for the nested PhaseColumn tree (relation bars, rails, loop arc,
// status decoration). Kept separate from `styles` to keep the new surface
// legible against the pre-existing editor styles.
const cstyles = StyleSheet.create({
  column: { alignItems: 'flex-start' },
  // Positioning context only — lets the absolute glow ring extend OUTSIDE the
  // card without being clipped by cardBox's `overflow: 'hidden'`.
  cardWrap: { position: 'relative' },
  // The bordered, rounded card box. Owns the border / background / radius +
  // size constraints (formerly on `styles.phaseCard`). `overflow: 'hidden'`
  // clips the footer's top hairline to the rounded bottom corners so the footer
  // reads as an integrated part of the box, not a pill tacked on beneath it.
  cardBox: {
    minWidth: 140,
    maxWidth: 200,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1d5db',
    overflow: 'hidden',
  },
  // The select/edit region: the card's header + body. Holds the padding the old
  // `styles.phaseCard` used to apply; the border/background now live on cardBox.
  cardSelect: {
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  // Collapse/expand FOOTER for every PARENT card (composite or subflow). It
  // lives INSIDE the bordered cardBox as a full-width sibling of the select
  // region — a footer band, not a detached pill. A subtle top hairline divides
  // it from the body; it shares the card background and (via cardBox's
  // `overflow: 'hidden'`) the rounded bottom corners, so it reads as the bottom
  // of the box. No negative margin / own border / own corner radii — those were
  // the external-pill hack. The whole band is the tap target.
  expandFooter: {
    alignSelf: 'stretch',
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9fafb',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  expandBarIcon: {
    fontSize: 14,
    lineHeight: 14,
    color: '#6b7280',
    fontWeight: '700',
  },
  // Pending nodes (a run is live but this one hasn't started) read as faint
  // and dashed.
  cardPending: { opacity: 0.5, borderStyle: 'dashed' },
  // Pulsing ring around the running node.
  glow: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: STATUS_COLOR.running,
    shadowColor: STATUS_COLOR.running,
    shadowOpacity: 0.6,
    shadowRadius: 8,
  },
  body: { marginTop: 6, alignSelf: 'stretch', minWidth: 200 },
  relationBar: {
    flexDirection: 'column',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 6,
    alignSelf: 'flex-start',
    // Cap width so a long map `over [...]` list wraps to a vertical list
    // instead of stretching the whole lane horizontally.
    maxWidth: 420,
  },
  relationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  relationLines: {
    paddingLeft: 18,
    gap: 1,
  },
  relationLineText: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'Menlo',
  },
  relationIcon: { fontSize: 12, fontWeight: '700' },
  relationLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  relationDetail: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  // Faint ✎ on a clickable relation bar — hints it edits the parent.
  relationEditHint: { fontSize: 10, color: '#9ca3af', marginLeft: 'auto' },
  // The vertical rail that connects a parent to its nested children — the
  // "child to child on the left side" the design calls for.
  rail: {
    borderLeftWidth: 2,
    paddingLeft: 12,
    gap: 6,
    marginLeft: 6,
  },
  // Dashed "+ child" affordance at the end of an array composite's children.
  addChildBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    backgroundColor: '#ffffff',
  },
  addChildText: { fontSize: 11, fontWeight: '700' },
  // Full-width "add a phase to this group" row — visually distinct from the
  // small per-leaf "↳ + child" nest chip so the two aren't mistaken for the
  // same action when stacked at the end of a group's children.
  addPhaseRow: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    backgroundColor: '#ffffff',
    marginTop: 2,
  },
  mergerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  mergerLabel: { fontSize: 11, fontWeight: '700' },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignSelf: 'flex-start',
  },
  agentPath: { fontFamily: 'Menlo', fontSize: 11, color: '#6b7280' },
  participantLabel: { fontSize: 11, fontWeight: '600', color: '#374151' },
  serialArrow: { fontSize: 12, color: '#9ca3af', marginLeft: 14, marginTop: -2 },
  branch: { marginTop: 4, gap: 4 },
  branchKey: {
    fontSize: 11,
    fontFamily: 'Menlo',
    color: '#65a30d',
    fontWeight: '600',
  },
  branchKeyActive: { color: '#2563eb', fontWeight: '800' },
  // Loop-back arc — a left bracket spanning the loop body, rounded on the
  // left, with an up-arrow at the top (flow returns to the start).
  loopWrap: { alignSelf: 'flex-start' },
  loopRow: { flexDirection: 'row', alignItems: 'stretch' },
  loopArcCol: {
    width: 16,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
    marginRight: 6,
    alignItems: 'center',
  },
  loopArcArrow: { fontSize: 10, marginTop: -7, fontWeight: '700' },
  loopBody: { flex: 1 },
  loopBackBar: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: 6,
    borderStyle: 'dashed',
  },
  loopBackText: { fontSize: 10, fontWeight: '700' },
  // Subflow expansion states (loading / error / empty / cycle), rendered in the
  // nested rail beneath an expanded subflow's relation bar.
  subflowStatus: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  subflowStatusText: {
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  subflowError: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
    maxWidth: 360,
  },
  subflowErrorText: {
    fontSize: 11,
    color: '#b91c1c',
    fontWeight: '600',
  },
  subflowCycle: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#f59e0b',
    backgroundColor: '#fffbeb',
  },
  subflowCycleText: {
    fontSize: 11,
    color: '#b45309',
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
});
