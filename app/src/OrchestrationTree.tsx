import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { compositeKey, type CompositeKey, type Node } from './types';
import { duplicateNode, wrapInComposite } from './lib/orchestrationMutate';
import { usePulse } from './lib/usePulse';
import { STATUS_COLOR, type NodeRunStatus } from './lib/runStatus';
// The full-featured phase editor (all body kinds + decorators), shared with
// the Pipeline view. Rendered inline under the selected row so Tree editing
// is no longer JSON-only — including changing a node's body kind.
import { PhaseForm } from './PipelineEditor';
import { formatMapOver } from './lib/mapOver';

/** A small status dot for a tree row — colored by live run status; the
 *  "running" dot pulses while the run is live. */
function StatusDot({ status, live }: { status: NodeRunStatus; live: boolean }) {
  const pulse = usePulse(live && status === 'running');
  return (
    <Animated.View
      style={[
        styles.statusDot,
        { backgroundColor: STATUS_COLOR[status] },
        live && status === 'running' ? { opacity: pulse } : null,
      ]}
    />
  );
}

const COMPOSITE_LABEL: Record<CompositeKey, string> = {
  agents: 'agents (serial)',
  phases: 'phases',
  parallel: 'parallel',
  converge: 'converge',
  loop: 'loop',
  conversation: 'conversation',
  route: 'route',
  switch: 'switch (cases)',
  map: 'map (fan-out)',
};

const COMPOSITE_COLOR: Record<CompositeKey, string> = {
  agents: '#6b7280',
  phases: '#2563eb',
  parallel: '#059669',
  converge: '#d97706',
  loop: '#0891b2',
  conversation: '#e11d48',
  route: '#65a30d',
  switch: '#0d9488',
  map: '#7c3aed',
};

/** Distinct, informative display for a non-agent / script leaf. The schema's
 *  `codeBody` allows EITHER `source` (inline JS, vm-sandboxed) OR `run` (an
 *  external shell command). Rather than flag these valid leaves as "(no body)",
 *  surface a small kind chip + a monospace, single-line preview of the actual
 *  content so a reviewer can tell `npm run env:stg && xcodebuild …` from a JS
 *  transform at a glance. Returns null for leaves with no recognized body. */
function scriptDisplay(
  node: Node,
): { label: string; preview: string } | null {
  if (node.code && typeof node.code === 'object') {
    if (typeof node.code.run === 'string' && node.code.run.length > 0) {
      return { label: 'SCRIPT', preview: previewLine(node.code.run, 120) };
    }
    if (typeof node.code.source === 'string' && node.code.source.length > 0) {
      return { label: 'CODE', preview: previewLine(node.code.source, 120) };
    }
  }
  if (node.http && typeof node.http === 'object' && typeof node.http.url === 'string') {
    return {
      label: 'HTTP',
      preview: previewLine(`${(node.http.method ?? 'GET').toUpperCase()} ${node.http.url}`, 120),
    };
  }
  if (node.wait && typeof node.wait === 'object') {
    const w = node.wait;
    return {
      label: 'WAIT',
      preview: w.signal ? `signal ${w.signal}` : w.until ? `until ${w.until}` : `${w.seconds ?? 0}s`,
    };
  }
  if (
    node.a2a &&
    typeof node.a2a === 'object' &&
    typeof node.a2a.agentCard === 'string'
  ) {
    return { label: 'A2A', preview: previewLine(node.a2a.agentCard, 120) };
  }
  return null;
}

/** Collapse a (possibly multi-line) string to its first non-empty line and
 *  truncate to `max` chars with an ellipsis — keeps the preview a single,
 *  scannable row in both the tree and the editor. */
function previewLine(text: string, max: number): string {
  const firstLine =
    text.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

/** Count every descendant of a node — children plus all nested
 *  children inside `phases` / `parallel` / `converge` arrays, plus
 *  single-Node bodies in `map` / `loop` / route branches, plus the
 *  agent paths in a multi-agent chain. Used by the delete-confirm
 *  prompt so the user sees how many phases would go with the parent
 *  before agreeing — same idea as Connections' "Overwrite N existing
 *  entries?" prompt. */
function countDescendants(node: Node): number {
  let count = 0;
  for (const key of ['phases', 'parallel', 'converge'] as const) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      count += arr.length;
      for (const child of arr) count += countDescendants(child as Node);
    }
  }
  if (Array.isArray(node.agents)) count += node.agents.length;
  if (node.map?.body) count += 1 + countDescendants(node.map.body);
  if (node.loop?.body) count += 1 + countDescendants(node.loop.body);
  if (node.route?.branches) {
    for (const branch of Object.values(node.route.branches)) {
      count += 1 + countDescendants(branch as Node);
    }
  }
  return count;
}

/** Read-mostly tree view of an orchestration. When `onChange` is
 *  provided, composite nodes get inline buttons for the structural
 *  operations the Pipeline / Graph views already expose (add child,
 *  remove child). For deeper edits — renaming a phase, swapping an
 *  agent path, toggling tools — the side-by-side JSON panel is the
 *  shared escape hatch; Tree's job is to keep the shape legible. */
export function OrchestrationTree({
  node,
  depth = 0,
  onChange,
  onDelete,
  onInsertBefore,
  onInsertAfter,
  onDuplicate,
  onWrap,
  errorNodeNames,
  errorMessageByNode,
  selectedNodeName,
  onSelectionChange,
  statusByNode,
  isLive,
}: {
  node: Node;
  depth?: number;
  onChange?: (next: Node) => void;
  /** Optional: if provided AND not the root, a delete button on this
   *  node calls this to remove itself from the parent. */
  onDelete?: () => void;
  /** Insert a new sibling immediately BEFORE this node. Passed by
   *  the parent (which knows this node's index in its children
   *  array). Renders as a "+ before" button on the row. */
  onInsertBefore?: () => void;
  /** Insert a new sibling immediately AFTER this node. Same pattern
   *  as onInsertBefore — renders as "+ after". Together these close
   *  the gap that previously only let the user "+ child" inside
   *  composite containers; siblings at the leaf level had no
   *  insertion path from Tree view at all (you had to switch to
   *  Pipeline or Graph). */
  onInsertAfter?: () => void;
  /** Duplicate this node (deep copy inserted after it). Parent-provided,
   *  like onDelete — renders a "⎘ dup" button. */
  onDuplicate?: () => void;
  /** Wrap this node in a loop / group composite. Parent-provided —
   *  renders "↻ loop" / "▢ group" buttons. */
  onWrap?: (kind: 'loop' | 'phases') => void;
  /** Names with hard validation errors. Rendered as red ⚠ badge on
   *  the row header. Same shape PipelineEditor accepts. */
  errorNodeNames?: Set<string>;
  errorMessageByNode?: Map<string, string>;
  /** Page-level selected node name. The matching row gets a subtle
   *  blue accent so selection persists across view switches. */
  selectedNodeName?: string | null;
  /** Click → set this node as the selected one in shared state. */
  onSelectionChange?: (name: string | null) => void;
  /** Live run status per node name (pending/running/done/error/skipped).
   *  When present, the row's left rail is colored by status and a status
   *  dot appears in the header — so a run can be followed in Tree view. */
  statusByNode?: Map<string, NodeRunStatus>;
  /** True while the run is actively running — gates the running-dot pulse. */
  isLive?: boolean;
}) {
  const runStatus = node.name ? statusByNode?.get(node.name) : undefined;
  const hasError = !!(node.name && errorNodeNames?.has(node.name));
  const errorMessage = node.name ? errorMessageByNode?.get(node.name) : undefined;
  const isSelected = !!(node.name && node.name === selectedNodeName);
  const composite = compositeKey(node);
  const isLeaf = !composite && !node.subflow;
  const editable = !!onChange;
  // Collapse a composite's children subtree (▾/▸). Tree used to render
  // everything expanded with no way to minimize a deep branch. Local
  // state — resets on remount (switching orchestrations), which is fine.
  const [collapsed, setCollapsed] = useState(false);

  // Only `agents`, `phases`, `parallel`, `converge` store children as
  // plain arrays of the right shape. `loop`, `route`, `map`, and
  // `conversation` have structured bodies (LoopBody, RouteBody, etc.)
  // that need bespoke rendering — treating them as arrays crashes the
  // render (`.map` on a non-array) and blanks the page.
  const isArrayComposite =
    composite === 'agents' ||
    composite === 'phases' ||
    composite === 'parallel' ||
    composite === 'converge';

  function addChildPhase() {
    if (!onChange || !composite || !isArrayComposite || composite === 'agents') return;
    insertArrayChildAt((node[composite] as Node[])?.length ?? 0);
  }
  /** Insert a new placeholder phase at `idx` inside this node's array
   *  composite. Used by addChildPhase (idx = end) and by the
   *  `+ before` / `+ after` callbacks the parent passes down to each
   *  child (idx = sibling's index / sibling's index + 1). All three
   *  insertion patterns now route through one writer so the new-phase
   *  shape and name-uniqueness logic stays in one place.
   *
   *  The new phase ships with an empty `phases: []` body so the
   *  orchestration validator accepts it immediately. The user edits
   *  via the form (Pipeline / Graph view) or the JSON panel. */
  function insertArrayChildAt(idx: number) {
    if (!onChange || !composite || !isArrayComposite || composite === 'agents') return;
    const list = (node[composite] as Node[]) ?? [];
    const newPhase: Node = {
      name: `new-phase-${list.length + 1}`,
      phases: [],
    };
    const next = [...list.slice(0, idx), newPhase, ...list.slice(idx)];
    onChange({ ...node, [composite]: next } as Node);
  }
  function removeArrayChildAt(idx: number) {
    if (!onChange || !composite || !isArrayComposite) return;
    if (composite === 'agents') {
      const list = (node.agents ?? []) as string[];
      onChange({ ...node, agents: list.filter((_, i) => i !== idx) });
    } else {
      const list = (node[composite] as Node[]) ?? [];
      onChange({ ...node, [composite]: list.filter((_, i) => i !== idx) } as Node);
    }
  }
  function updateArrayChildAt(idx: number, next: Node) {
    if (!onChange || !composite || !isArrayComposite || composite === 'agents') return;
    const list = (node[composite] as Node[]) ?? [];
    onChange({ ...node, [composite]: list.map((c, i) => (i === idx ? next : c)) } as Node);
  }
  // Duplicate / wrap an array child via the SHARED ops applied to this local
  // subtree — so Tree reaches edit parity with Pipeline/Graph instead of
  // re-implementing the logic. (Name dedup is scoped to this subtree, same as
  // insertArrayChildAt — the validator catches any cross-subtree collision.)
  function duplicateArrayChildAt(idx: number) {
    if (!onChange || !composite || !isArrayComposite || composite === 'agents') return;
    const child = (node[composite] as Node[])?.[idx];
    if (child?.name) onChange(duplicateNode(node, child.name));
  }
  function wrapArrayChildAt(idx: number, kind: 'loop' | 'phases') {
    if (!onChange || !composite || !isArrayComposite || composite === 'agents') return;
    const child = (node[composite] as Node[])?.[idx];
    if (child?.name) onChange(wrapInComposite(node, child.name, kind));
  }

  return (
    <View
      style={[
        styles.node,
        { marginLeft: depth === 0 ? 0 : 16 },
        // Selection accent first so error styling overrides when both
        // apply. Error red is more important than selection blue.
        isSelected && styles.nodeSelected,
        hasError && styles.nodeError,
        // Live run status colors the left rail last so it wins over
        // selection/validation when a run is being followed.
        runStatus ? { borderLeftColor: STATUS_COLOR[runStatus] } : null,
        // ...and a FULL border so completed (green) / in-progress (blue)
        // phases + agents stand out at a glance while following a run.
        runStatus === 'done' || runStatus === 'running'
          ? { borderColor: STATUS_COLOR[runStatus], borderWidth: 2, borderRadius: 4 }
          : null,
      ]}>
      {/* The header is a plain row of SIBLING pressables — the collapse
       *  toggle, the select target (name + tags), and the action buttons.
       *  Nesting them inside one row-wide Pressable rendered
       *  <button> inside <button> on web (invalid DOM; React warns). */}
      <View style={styles.nodeHeader}>
        {composite ? (
          <Pressable
            onPress={() => setCollapsed(c => !c)}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Expand children' : 'Collapse children'}
            hitSlop={6}
            style={styles.collapseToggle}>
            <Text style={styles.collapseToggleText}>{collapsed ? '▸' : '▾'}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => {
            // Toggle: clicking the already-selected row deselects it, which
            // closes its inline editor — so an "expanded" row can be
            // minimized by clicking it again.
            if (node.name && onSelectionChange) {
              onSelectionChange(isSelected ? null : node.name);
            }
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: isSelected }}
          accessibilityLabel={node.name || 'phase'}
          style={styles.nodeSelect}>
          <Text style={styles.nodeName}>{node.name}</Text>
          {runStatus && <StatusDot status={runStatus} live={!!isLive} />}
          {hasError && (
            <Text
              style={styles.errorBadge}
              {...({ title: errorMessage } as unknown as object)}>
              ⚠
            </Text>
          )}
          {node.lock && <Text style={styles.lock}>locked</Text>}
          {composite && (
            <Text style={[styles.compositeTag, { color: COMPOSITE_COLOR[composite] }]}>
              {COMPOSITE_LABEL[composite]}
            </Text>
          )}
          {node.agent ? <Text style={styles.agentPath}>{node.agent}</Text> : null}
          {node.subflow ? (
            <Text style={styles.agentPath}>subflow: {node.subflow}</Text>
          ) : null}
        </Pressable>
        {editable && onDelete && (
          <Pressable
            onPress={() => {
              // Guard the destructive action with a confirm — matches
              // the pattern used in DatasetsPage / AgentsPage /
              // WorkspacesPage / EvalsPage and the Pipeline-view phase
              // delete. The Tree view puts a `× delete` on every row, so
              // it is the densest — and highest-risk — delete surface in
              // the editor.
              //
              // Composite cascade: when the user deletes a parallel /
              // converge / phases container, every child goes with it.
              // Surface that cost in the prompt so the user sees the
              // blast radius before agreeing — same idea as the
              // Connections-page "Overwrite N existing entries?" prompt.
              const g = globalThis as unknown as {
                confirm?: (m: string) => boolean;
              };
              const cascade = countDescendants(node);
              const label = node.name || 'this node';
              const msg = cascade > 0
                ? `Delete "${label}" and its ${cascade} descendant${cascade === 1 ? '' : 's'}?`
                : `Delete "${label}"?`;
              if (g.confirm && !g.confirm(msg)) return;
              onDelete();
            }}
            style={styles.iconBtnDanger}>
            <Text style={styles.iconBtnDangerText}>× delete</Text>
          </Pressable>
        )}
        {editable && isArrayComposite && composite !== 'agents' && (
          <Pressable onPress={addChildPhase} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>+ child</Text>
          </Pressable>
        )}
        {/* Sibling insert affordances — only rendered when the parent
         *  provided onInsertBefore / onInsertAfter callbacks (i.e.
         *  this node is a child of an array composite). Closes the
         *  Tree-view sibling-insert gap that previously forced users
         *  to switch to Pipeline or Graph view just to put a phase
         *  between two existing ones. */}
        {editable && onInsertBefore && (
          <Pressable onPress={onInsertBefore} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>+ before</Text>
          </Pressable>
        )}
        {editable && onInsertAfter && (
          <Pressable onPress={onInsertAfter} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>+ after</Text>
          </Pressable>
        )}
        {editable && onDuplicate && (
          <Pressable onPress={onDuplicate} style={styles.iconBtn}>
            <Text style={styles.iconBtnText}>⎘ dup</Text>
          </Pressable>
        )}
        {editable && onWrap && (
          <>
            <Pressable onPress={() => onWrap('loop')} style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>↻ loop</Text>
            </Pressable>
            <Pressable onPress={() => onWrap('phases')} style={styles.iconBtn}>
              <Text style={styles.iconBtnText}>▢ group</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Inline editor — when this (non-root) row is selected, show the
       *  shared PhaseForm bound to this node. Save routes through Tree's
       *  scoped onChange (replaces this node in its parent), so every
       *  field — and the body kind itself — is editable without leaving
       *  the Tree view or dropping into raw JSON. */}
      {depth > 0 && isSelected && editable && onChange ? (
        <View style={styles.inlineEditor}>
          <PhaseForm
            initial={node}
            submitLabel="Save"
            onSubmit={next => onChange(next)}
            onDelete={onDelete}
          />
        </View>
      ) : null}

      {node.description ? (
        <Text style={styles.description}>{node.description}</Text>
      ) : null}

      {!collapsed &&
        composite === 'agents' &&
        ((node.agents ?? []) as string[]).map((path, i) => (
          <View key={i} style={[styles.node, styles.agentChildRow]}>
            <Text style={styles.agentPath}>{path}</Text>
            {editable && (
              <Pressable
                onPress={() => {
                  // Confirm before pulling an agent path out of the
                  // multi-agent chain — same pattern as the
                  // phase-level delete above.
                  const g = globalThis as unknown as {
                    confirm?: (m: string) => boolean;
                  };
                  if (g.confirm && !g.confirm(`Remove agent "${path}" from the chain?`)) return;
                  removeArrayChildAt(i);
                }}
                style={styles.iconBtnDanger}>
                <Text style={styles.iconBtnDangerText}>×</Text>
              </Pressable>
            )}
          </View>
        ))}

      {!collapsed &&
        (composite === 'phases' ||
          composite === 'parallel' ||
          composite === 'converge') &&
        ((node[composite] as Node[]) ?? []).map((child, i) => (
          <OrchestrationTree
            key={`${child?.name ?? 'child'}-${i}`}
            node={child}
            depth={depth + 1}
            onChange={editable ? next => updateArrayChildAt(i, next) : undefined}
            onDelete={editable ? () => removeArrayChildAt(i) : undefined}
            // Parent knows the index — child renders the `+ before`
            // and `+ after` buttons and dispatches to the right slot.
            onInsertBefore={editable ? () => insertArrayChildAt(i) : undefined}
            onInsertAfter={editable ? () => insertArrayChildAt(i + 1) : undefined}
            onDuplicate={editable ? () => duplicateArrayChildAt(i) : undefined}
            onWrap={editable ? kind => wrapArrayChildAt(i, kind) : undefined}
            errorNodeNames={errorNodeNames}
            errorMessageByNode={errorMessageByNode}
            selectedNodeName={selectedNodeName}
            onSelectionChange={onSelectionChange}
            statusByNode={statusByNode}
            isLive={isLive}
          />
        ))}

      {!collapsed && composite === 'converge' && node.merger ? (
        <View style={[styles.node, { marginLeft: 16 }]}>
          <Text style={styles.mergerLabel}>merger:</Text>
          <Text style={styles.agentPath}>{node.merger}</Text>
        </View>
      ) : null}

      {/* Loop — body is a single child Node, plus optional metadata. */}
      {!collapsed && composite === 'loop' && node.loop && (
        <>
          <View style={styles.metaRow}>
            {node.loop.maxIterations != null && (
              <Text style={styles.metaLine}>
                max: {node.loop.maxIterations} iter
              </Text>
            )}
            {node.loop.until ? (
              <Text style={styles.metaLine}>until: "{node.loop.until}"</Text>
            ) : null}
            {node.loop.whileOutput ? (
              <Text style={styles.metaLine}>
                while: "{node.loop.whileOutput}"
              </Text>
            ) : null}
            {node.loop.retryOnFailure && (
              <Text style={styles.metaLine}>retry-on-failure</Text>
            )}
          </View>
          {node.loop.judge ? (
            <View style={[styles.node, styles.agentChildRow]}>
              <Text style={styles.metaLabel}>judge:</Text>
              <Text style={styles.agentPath}>{node.loop.judge}</Text>
            </View>
          ) : null}
          {node.loop.body ? (
            <OrchestrationTree
              node={node.loop.body}
              depth={depth + 1}
              onChange={
                editable
                  ? next =>
                      onChange?.({ ...node, loop: { ...node.loop!, body: next } })
                  : undefined
              }
              errorNodeNames={errorNodeNames}
              errorMessageByNode={errorMessageByNode}
              selectedNodeName={selectedNodeName}
              onSelectionChange={onSelectionChange}
              statusByNode={statusByNode}
              isLive={isLive}
            />
          ) : (
            <Text style={styles.warn}>(loop missing body)</Text>
          )}
        </>
      )}

      {/* Map — fan-out body is a single child, plus the `over` expression. */}
      {!collapsed && composite === 'map' && node.map && (
        <>
          <View style={styles.metaRow}>
            <Text style={styles.metaLine}>
              over: <Text style={styles.code}>{formatMapOver(node.map.over)}</Text>
              {node.map.serial ? ' (serial)' : ''}
            </Text>
          </View>
          {node.map.body ? (
            <OrchestrationTree
              node={node.map.body}
              depth={depth + 1}
              onChange={
                editable
                  ? next =>
                      onChange?.({ ...node, map: { ...node.map!, body: next } })
                  : undefined
              }
              errorNodeNames={errorNodeNames}
              errorMessageByNode={errorMessageByNode}
              selectedNodeName={selectedNodeName}
              onSelectionChange={onSelectionChange}
              statusByNode={statusByNode}
              isLive={isLive}
            />
          ) : (
            <Text style={styles.warn}>(map missing body)</Text>
          )}
        </>
      )}

      {/* Conversation — list of participant agent paths + round count. */}
      {!collapsed && composite === 'conversation' && node.conversation && (
        <>
          <View style={styles.metaRow}>
            {node.conversation.rounds != null && (
              <Text style={styles.metaLine}>rounds: {node.conversation.rounds}</Text>
            )}
            {editable && (
              <Pressable
                onPress={() => {
                  const g = globalThis as unknown as {
                    prompt?: (m: string, d?: string) => string | null;
                  };
                  const next = g.prompt?.(
                    'Agent path for new participant:',
                    'agents/',
                  );
                  if (!next) return;
                  onChange?.({
                    ...node,
                    conversation: {
                      ...node.conversation!,
                      participants: [
                        ...(node.conversation?.participants ?? []),
                        next,
                      ],
                    },
                  });
                }}
                style={styles.iconBtn}>
                <Text style={styles.iconBtnText}>+ participant</Text>
              </Pressable>
            )}
          </View>
          {(node.conversation.participants ?? []).map((path, i) => (
            <View key={i} style={[styles.node, styles.agentChildRow]}>
              <Text style={styles.metaLabel}>participant:</Text>
              <Text style={styles.agentPath}>{path}</Text>
              {editable && (
                <Pressable
                  onPress={() =>
                    onChange?.({
                      ...node,
                      conversation: {
                        ...node.conversation!,
                        participants: (node.conversation?.participants ?? []).filter(
                          (_, idx) => idx !== i,
                        ),
                      },
                    })
                  }
                  style={styles.iconBtnDanger}>
                  <Text style={styles.iconBtnDangerText}>×</Text>
                </Pressable>
              )}
            </View>
          ))}
        </>
      )}

      {/* Route — branches keyed by name, plus optional router + default. */}
      {!collapsed && composite === 'route' && node.route && (
        <>
          <View style={styles.metaRow}>
            {node.route.router ? (
              <Text style={styles.metaLine}>
                router: <Text style={styles.code}>{node.route.router}</Text>
              </Text>
            ) : null}
            {editable && (
              <>
                <Pressable
                  onPress={() => {
                    const g = globalThis as unknown as {
                      prompt?: (m: string, d?: string) => string | null;
                    };
                    const key = g.prompt?.('Branch key (case to match):');
                    if (!key) return;
                    if (node.route?.branches?.[key]) return;
                    onChange?.({
                      ...node,
                      route: {
                        ...node.route!,
                        branches: {
                          ...(node.route?.branches ?? {}),
                          [key]: { name: `branch-${key}`, phases: [] },
                        },
                      },
                    });
                  }}
                  style={styles.iconBtn}>
                  <Text style={styles.iconBtnText}>+ branch</Text>
                </Pressable>
                {!node.route.default && (
                  <Pressable
                    onPress={() =>
                      onChange?.({
                        ...node,
                        route: {
                          ...node.route!,
                          default: { name: 'default-branch', phases: [] },
                        },
                      })
                    }
                    style={styles.iconBtn}>
                    <Text style={styles.iconBtnText}>+ default</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
          {Object.entries(node.route.branches ?? {}).map(([key, branch]) => (
            <View key={key} style={styles.routeBranch}>
              <View style={styles.routeBranchHeader}>
                <Text style={styles.routeKey}>case "{key}":</Text>
                {editable && (
                  <Pressable
                    onPress={() => {
                      const next = { ...(node.route?.branches ?? {}) };
                      delete next[key];
                      onChange?.({
                        ...node,
                        route: { ...node.route!, branches: next },
                      });
                    }}
                    style={styles.iconBtnDanger}>
                    <Text style={styles.iconBtnDangerText}>×</Text>
                  </Pressable>
                )}
              </View>
              {branch ? (
                <OrchestrationTree
                  node={branch}
                  depth={depth + 1}
                  onChange={
                    editable
                      ? next =>
                          onChange?.({
                            ...node,
                            route: {
                              ...node.route!,
                              branches: {
                                ...(node.route?.branches ?? {}),
                                [key]: next,
                              },
                            },
                          })
                      : undefined
                  }
                  errorNodeNames={errorNodeNames}
                  errorMessageByNode={errorMessageByNode}
                  selectedNodeName={selectedNodeName}
                  onSelectionChange={onSelectionChange}
                  statusByNode={statusByNode}
                  isLive={isLive}
                />
              ) : (
                <Text style={styles.warn}>(empty branch)</Text>
              )}
            </View>
          ))}
          {node.route.default && (
            <View style={styles.routeBranch}>
              <View style={styles.routeBranchHeader}>
                <Text style={styles.routeKey}>default:</Text>
                {editable && (
                  <Pressable
                    onPress={() =>
                      onChange?.({
                        ...node,
                        route: { ...node.route!, default: undefined },
                      })
                    }
                    style={styles.iconBtnDanger}>
                    <Text style={styles.iconBtnDangerText}>×</Text>
                  </Pressable>
                )}
              </View>
              <OrchestrationTree
                node={node.route.default}
                depth={depth + 1}
                onChange={
                  editable
                    ? next =>
                        onChange?.({
                          ...node,
                          route: { ...node.route!, default: next },
                        })
                    : undefined
                }
                errorNodeNames={errorNodeNames}
                errorMessageByNode={errorMessageByNode}
                selectedNodeName={selectedNodeName}
                onSelectionChange={onSelectionChange}
                statusByNode={statusByNode}
                isLive={isLive}
              />
            </View>
          )}
        </>
      )}

      {isLeaf &&
        !node.agent &&
        !node.subflow &&
        (() => {
          // A `code` (or `a2a`) leaf is a VALID body — render a distinct
          // script display (kind chip + monospace preview) instead of the
          // red "(no body)" warning, which is reserved for leaves that
          // truly have no recognized body.
          const script = scriptDisplay(node);
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
          return <Text style={styles.warn}>(no body)</Text>;
        })()}
    </View>
  );
}

const styles = StyleSheet.create({
  node: {
    marginVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#e5e7eb',
    paddingLeft: 8,
  },
  // Validation-error decoration: red left rail + tinted background
  // when this row's node name has at least one hard error. The
  // tint sits behind the row text so the ⚠ badge stands out.
  nodeError: {
    borderLeftColor: '#dc2626',
    backgroundColor: '#fef2f2',
  },
  // Selection accent: blue rail + faint tint when this row is the
  // page-level selected node. View switches preserve the highlight.
  // When both selected and error apply, error styling wins via array
  // order in the View's style prop.
  nodeSelected: {
    borderLeftColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  // Inline phase editor shown under the selected row.
  inlineEditor: {
    marginTop: 6,
    marginLeft: 16,
    paddingLeft: 12,
    paddingTop: 4,
    paddingBottom: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#bfdbfe',
  },
  errorBadge: {
    fontSize: 13,
    color: '#dc2626',
    fontWeight: '700',
  },
  nodeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 4,
  },
  // The select target inside the header: same inline, wrapping layout the
  // header had when it was itself the Pressable.
  nodeSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    flexShrink: 1,
    columnGap: 8,
    rowGap: 4,
  },
  nodeName: {
    fontWeight: '600',
    fontSize: 14,
    color: '#111827',
  },
  collapseToggle: {
    width: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapseToggleText: { fontSize: 11, color: '#6b7280', fontWeight: '700' },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  compositeTag: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  agentPath: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#6b7280',
  },
  // Non-agent / script leaf display: a small kind chip ("SCRIPT" / "CODE" /
  // "A2A") followed by a monospace, single-line preview of the body content.
  // Distinguishes script phases from agent phases (which show an agent path)
  // and from the red "(no body)" warning reserved for truly empty leaves.
  scriptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 6,
    marginTop: 2,
  },
  scriptChip: {
    fontSize: 10,
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
  mergerLabel: {
    fontSize: 11,
    color: '#d97706',
    fontWeight: '600',
  },
  lock: {
    fontSize: 11,
    color: '#dc2626',
    fontWeight: '600',
  },
  description: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
    fontStyle: 'italic',
  },
  warn: {
    fontSize: 11,
    color: '#dc2626',
  },
  agentChildRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#ecfdf5',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  iconBtnText: { fontSize: 10, color: '#065f46', fontWeight: '600' },
  iconBtnDanger: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#fee2e2',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  iconBtnDangerText: { fontSize: 10, color: '#b91c1c', fontWeight: '600' },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 2,
    marginTop: 2,
  },
  metaLine: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  metaLabel: { fontSize: 11, color: '#374151', fontWeight: '600' },
  code: { fontFamily: 'Menlo', color: '#0891b2' },
  routeBranch: { marginLeft: 8, marginTop: 4, gap: 2 },
  routeBranchHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  routeKey: { fontSize: 11, color: '#65a30d', fontFamily: 'Menlo', fontWeight: '600' },
});
