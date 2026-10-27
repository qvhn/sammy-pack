import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Markdown } from '../Markdown';
import type { CompositeKind, RunEvent } from '../llm/executor';
import { isProgramPhase, phaseAgentPath } from './phaseKind';
import { totalUsage, useRuns, type Run } from '../store/runs';
import { takeRequestedRun } from '../store/runSelection';
import { useToast } from '../store/toast';
import { type Node } from '../types';
import { RunInputsModal } from '../RunInputsModal';
import { getAuthMode } from '../store/apiKey';
import { ArtifactViewer } from './ArtifactViewer';
import { Card, Hint, Page } from './Page';

/** Synthetic id used for the active (in-flight) run in the sidebar. */
const ACTIVE_ID = '__active__';

export function RunsPage() {
  const {
    active,
    history,
    hydrateRun,
    cancelRun,
    paused,
    pauseRun,
    resumeRun,
    sendChat,
    pendingApproval,
    approve,
    reject,
    startRun,
    startServerRun,
    resumeServerRun,
    gateServerRun,
    forkServerRun,
    deleteHistoryRuns,
    cancelRunById,
    isCancelling,
  } = useRuns();
  // Replay always re-opens the pre-run modal so the user can add / adjust
  // the instructions and any declared inputs before re-running. The prior
  // run's initial input pre-fills the instructions box; declared inputs
  // re-collect (they resolve server-side, not from the stored initialInput).
  const [replayPending, setReplayPending] = useState<Node | null>(null);
  const [replayDefaultInstructions, setReplayDefaultInstructions] =
    useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set());
  // Seeded from a "View this run" hand-off (e.g. the Notifications feed), so
  // the page opens on that exact run instead of whatever sorts first.
  const [selectedId, setSelectedId] = useState<string | null>(takeRequestedRun);
  const [search, setSearch] = useState('');
  type StatusFilter =
    | 'all'
    | 'running'
    | 'paused'
    | 'interrupted'
    | 'done'
    | 'error'
    | 'cancelled';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Compare mode: when set, the detail pane splits into two columns —
  // the selected run on the left and `compareId`'s run on the right.
  const [compareId, setCompareId] = useState<string | null>(null);
  const toast = useToast();

  // Decide the lock gate of a server-owned run that is NOT this tab's live
  // stream (reloaded tab, or started by the API / a trigger / another tab).
  // Same endpoint the Approvals page uses; the history poll then picks up
  // the resumed (or re-paused / cancelled) run. Throws so the panel can
  // show the failure and re-enable its buttons.
  const gateRunById = useCallback(
    async (
      id: string,
      name: string,
      decision: GateDecision,
      message?: string,
    ) => {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/gate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, message }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${body}`.trim());
      }
      toast.show(
        decision === 'approve'
          ? `Approved "${name}" — resuming`
          : decision === 'reject'
            ? `Rejected "${name}" — run cancelled`
            : `Requested changes on "${name}" — revising…`,
        decision === 'approve' ? 'success' : 'info',
      );
    },
    [toast],
  );

  // Whenever a history run is selected (or auto-selected by default),
  // ask the store to fetch its full event stream from disk. No-op for
  // already-hydrated runs and for the active run.
  useEffect(() => {
    if (!selectedId || selectedId === ACTIVE_ID) return;
    hydrateRun(selectedId);
  }, [selectedId, hydrateRun]);
  // Same for the compare target.
  useEffect(() => {
    if (!compareId || compareId === ACTIVE_ID) return;
    hydrateRun(compareId);
  }, [compareId, hydrateRun]);

  const compareRun =
    compareId === ACTIVE_ID
      ? active
      : history.find(h => h.id === compareId) ?? null;

  // Default-select: the live run if there is one, else the most recent
  // history entry. Re-evaluated on every render so the UI Just Picks
  // Something Reasonable.
  const resolvedSelectedId = useMemo(() => {
    if (selectedId === ACTIVE_ID && active) return ACTIVE_ID;
    // A run requested by id that is (now) the live one — e.g. resumed from
    // Notifications — lives in the active slot, not in history.
    if (selectedId && active && selectedId === active.id) return ACTIVE_ID;
    if (selectedId && history.some(h => h.id === selectedId)) return selectedId;
    if (active) return ACTIVE_ID;
    return history[0]?.id ?? null;
  }, [selectedId, active, history]);

  // Build the sidebar list — active pinned at top, history below.
  // Search + status filter both narrow the list; the active run is
  // always included (you don't want a live run hidden by a filter
  // mid-stream).
  const sidebarItems = useMemo(() => {
    const items: Array<{ id: string; run: Run; isActive: boolean }> = [];
    if (active) items.push({ id: ACTIVE_ID, run: active, isActive: true });
    const q = search.trim().toLowerCase();
    for (const h of history) {
      // The pinned active row already shows this run — a history copy of the
      // same id (a poll landing mid-transition) would list it twice.
      if (active && h.id === active.id) continue;
      if (q) {
        // Match either orchestration name OR the recent-output preview. The
        // list now ships a short server-side `preview` snippet (no events[]),
        // so search the name + preview here; full-text search across the
        // hydrated event log lives in the detail view. Fall back to any
        // in-memory events (a hydrated / live run carries them).
        const nameHit = h.orchestrationName.toLowerCase().includes(q);
        const previewHit =
          !nameHit && (h.preview ?? '').toLowerCase().includes(q);
        const outHit =
          !nameHit &&
          !previewHit &&
          h.events.some(
            e =>
              e.type === 'phase-end' &&
              typeof (e as { output?: string }).output === 'string' &&
              (e as { output: string }).output.toLowerCase().includes(q),
          );
        if (!nameHit && !previewHit && !outHit) continue;
      }
      if (statusFilter !== 'all' && h.status !== statusFilter) continue;
      items.push({ id: h.id, run: h, isActive: false });
    }
    return items;
  }, [active, history, search, statusFilter]);

  const detailRun =
    resolvedSelectedId === ACTIVE_ID
      ? active
      : history.find(h => h.id === resolvedSelectedId) ?? null;

  // Of the runs ticked for bulk action, which are still stoppable
  // (running / paused / interrupted). Drives the bulk "Stop" button.
  const cancellableSelected = useMemo(() => {
    const ids: string[] = [];
    for (const id of selectedForDelete) {
      const r = history.find(h => h.id === id);
      if (
        r &&
        (r.status === 'running' ||
          r.status === 'paused' ||
          r.status === 'interrupted')
      ) {
        ids.push(id);
      }
    }
    return ids;
  }, [selectedForDelete, history]);

  return (
    <View style={styles.root}>
      <Page title="Runs" subtitle="execution history, live traces, thinking, and outputs">
        <View style={styles.layout}>
          {/* Left: run-list sidebar (iOS Messages style) */}
          <View style={styles.sidebar}>
            <View style={styles.searchWrap}>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="search name or output…"
                style={styles.searchInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.filterRow}>
                {(
                  [
                    'all',
                    'running',
                    'paused',
                    'interrupted',
                    'done',
                    'error',
                    'cancelled',
                  ] as StatusFilter[]
                ).map(
                  f => (
                    <Pressable
                      key={f}
                      onPress={() => setStatusFilter(f)}
                      style={[
                        styles.filterChip,
                        statusFilter === f && styles.filterChipActive,
                      ]}>
                      <Text
                        style={[
                          styles.filterChipText,
                          statusFilter === f && styles.filterChipTextActive,
                        ]}>
                        {f}
                      </Text>
                    </Pressable>
                  ),
                )}
              </View>
              <View style={styles.selectRow}>
                <Pressable
                  onPress={() => {
                    setSelectMode(s => !s);
                    setSelectedForDelete(new Set());
                  }}
                  style={styles.selectToggle}>
                  <Text style={styles.selectToggleText}>
                    {selectMode ? '× Done' : '☐ Select'}
                  </Text>
                </Pressable>
                {selectMode && cancellableSelected.length > 0 && (
                  <Pressable
                    onPress={async () => {
                      const g = globalThis as unknown as {
                        confirm?: (m: string) => boolean;
                      };
                      if (
                        g.confirm &&
                        !g.confirm(
                          `Stop ${cancellableSelected.length} running/interrupted run(s)?`,
                        )
                      ) {
                        return;
                      }
                      const ids = cancellableSelected;
                      await Promise.all(ids.map(id => cancelRunById(id)));
                    }}
                    style={styles.selectStopBtn}>
                    <Text style={styles.selectStopBtnText}>
                      Stop {cancellableSelected.length}
                    </Text>
                  </Pressable>
                )}
                {selectMode && selectedForDelete.size > 0 && (
                  <Pressable
                    onPress={async () => {
                      const g = globalThis as unknown as {
                        confirm?: (m: string) => boolean;
                      };
                      if (
                        g.confirm &&
                        !g.confirm(`Delete ${selectedForDelete.size} run(s)?`)
                      ) {
                        return;
                      }
                      const ids = Array.from(selectedForDelete);
                      setSelectedForDelete(new Set());
                      await deleteHistoryRuns(ids);
                    }}
                    style={styles.selectDeleteBtn}>
                    <Text style={styles.selectDeleteBtnText}>
                      Delete {selectedForDelete.size}
                    </Text>
                  </Pressable>
                )}
                {selectMode && (
                  <Pressable
                    onPress={() => {
                      // Select all visible history items (skip the active one).
                      const next = new Set<string>();
                      for (const item of sidebarItems) {
                        if (!item.isActive) next.add(item.run.id);
                      }
                      setSelectedForDelete(next);
                    }}
                    style={styles.selectAllBtn}>
                    <Text style={styles.selectAllBtnText}>all</Text>
                  </Pressable>
                )}
              </View>
            </View>
            {sidebarItems.length === 0 && (
              <View style={styles.sidebarEmpty}>
                <Hint>
                  {history.length === 0 && !active
                    ? 'No runs yet. Open a pipeline and tap ▶ Run.'
                    : 'No matches for current filters.'}
                </Hint>
              </View>
            )}
            <ScrollView style={styles.sidebarScroll}>
              {sidebarItems.map(item => {
                const selected = resolvedSelectedId === item.id;
                const checked = selectedForDelete.has(item.run.id);
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      if (selectMode && !item.isActive) {
                        setSelectedForDelete(prev => {
                          const next = new Set(prev);
                          if (next.has(item.run.id)) next.delete(item.run.id);
                          else next.add(item.run.id);
                          return next;
                        });
                        return;
                      }
                      setSelectedId(item.id);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Run ${item.run.orchestrationName ?? item.id}`}
                    style={[styles.sidebarRow, selected && styles.sidebarRowSelected]}>
                    <View style={styles.sidebarRowHeader}>
                      {selectMode && !item.isActive && (
                        <View
                          style={[
                            styles.checkbox,
                            checked && styles.checkboxChecked,
                          ]}>
                          {checked && <Text style={styles.checkboxMark}>✓</Text>}
                        </View>
                      )}
                      <Text
                        style={[styles.sidebarName, selected && styles.sidebarTextSelected]}
                        numberOfLines={1}>
                        {item.run.orchestrationName}
                      </Text>
                      <StatusDot status={item.run.status} />
                    </View>
                    <Text
                      style={[styles.sidebarMeta, selected && styles.sidebarMetaSelected]}
                      numberOfLines={1}>
                      {/* The run's REAL status (a live run can be paused at a
                          gate), matching the detail header. */}
                      {item.isActive
                        ? `${isCancelling(item.run.id) ? 'cancelling' : item.run.status} · ${formatTime(item.run.startedAt)}`
                        : formatDateTime(item.run.startedAt)}
                      {!item.isActive && item.run.endedAt &&
                        ` · ${Math.round((item.run.endedAt - item.run.startedAt) / 100) / 10}s`}
                    </Text>
                    <Text
                      style={[styles.sidebarPreview, selected && styles.sidebarMetaSelected]}
                      numberOfLines={1}>
                      {runPreview(item.run)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {/* Right: detail of the selected run */}
          <View style={styles.detail}>
            {!detailRun && (
              <Card>
                <Hint>
                  {sidebarItems.length === 0
                    ? 'Open a pipeline and tap ▶ Run to start.'
                    : 'Select a run on the left.'}
                </Hint>
              </Card>
            )}
            {detailRun && !compareRun && (
              <RunDetailCard
                key={detailRun.id}
                run={detailRun}
                isActive={resolvedSelectedId === ACTIVE_ID}
                onCancel={cancelRun}
                onStop={() => cancelRunById(detailRun.id)}
                isCancelling={isCancelling(detailRun.id)}
                paused={paused}
                onPause={pauseRun}
                onResume={resumeRun}
                onResumeServerRun={resumeServerRun}
                onGate={
                  resolvedSelectedId === ACTIVE_ID
                    ? gateServerRun
                    : (decision, message) =>
                        gateRunById(
                          detailRun.id,
                          detailRun.orchestrationName,
                          decision,
                          message,
                        )
                }
                onChat={sendChat}
                pendingApproval={pendingApproval}
                approve={approve}
                reject={reject}
                onReplay={
                  detailRun.orchestrationSnapshot
                    ? () => {
                        const snapshot = detailRun.orchestrationSnapshot as Node;
                        // ALWAYS open the pre-run modal so a replay can add /
                        // adjust the instructions and any declared inputs. The
                        // prior run's initial input pre-fills the instructions
                        // box; declared-input values re-collect there (they
                        // resolve server-side). Launch happens in onRun below.
                        setReplayPending(snapshot);
                        setReplayDefaultInstructions(detailRun.initialInput ?? '');
                      }
                    : undefined
                }
                onFork={(atPhase: string) => {
                  if (forkServerRun(detailRun.id, atPhase)) {
                    setSelectedId(ACTIVE_ID);
                  }
                }}
                onCompareTo={chosenId => setCompareId(chosenId)}
                comparablePeers={history.filter(
                  h =>
                    h.id !== detailRun.id &&
                    h.orchestrationName === detailRun.orchestrationName,
                )}
              />
            )}
            {detailRun && compareRun && (
              <CompareView
                left={detailRun}
                right={compareRun}
                onExit={() => setCompareId(null)}
              />
            )}
          </View>
        </View>
      </Page>
      {/* Hosted in a native Modal (a fixed, viewport-sized portal on web) so
          the Replay dialog's backdrop covers the whole window — mounted
          inside the Page's scroll body it only covered the scrolled content,
          leaving an uncovered band below. */}
      <Modal
        transparent
        animationType="none"
        visible={replayPending != null}
        onRequestClose={() => setReplayPending(null)}>
        <RunInputsModal
          orchestration={replayPending}
          defaultInstructions={replayDefaultInstructions}
          onClose={() => setReplayPending(null)}
          onRun={(values, instructions) => {
            const orch = replayPending;
            setReplayPending(null);
            if (!orch) return;
            // The instructions box → the run's initial input.
            const initialInput = instructions || undefined;
            // Declared inputs resolve server-side, so they force the
            // server-owned path. With no declared inputs we honor the auth
            // mode just like a plain replay did (proxy → server, else browser).
            const hasDeclaredInputs = Object.keys(values).length > 0;
            const useServer =
              hasDeclaredInputs || getAuthMode() === 'claude-code-proxy';
            const ok = useServer
              ? startServerRun(orch, initialInput, values)
              : startRun(orch, initialInput);
            if (ok) setSelectedId(ACTIVE_ID);
          }}
        />
      </Modal>
    </View>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running'
      ? '#2563eb'
      : status === 'done'
        ? '#059669'
        : status === 'error'
          ? '#dc2626'
          : status === 'cancelled'
            ? '#9ca3af'
            : status === 'paused'
              ? '#d97706'
              : status === 'interrupted'
                ? '#ea580c'
                : '#d1d5db';
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

/** One-line summary of what's in a run — for the sidebar row. Always human
 *  text: never a raw event-type name (`run-paused`, `phase-delta`, …). */
function runPreview(run: Run): string {
  // A run parked at a lock gate reads as such whatever its last event is.
  if (run.status === 'paused') {
    const gate = gatedPhaseOf(run);
    if (gate) return `⏸ Waiting for approval at ${gate}`;
    const r = run as { pendingWait?: unknown; stateJson?: { pendingWait?: unknown } | null; pausedFor?: string };
    if (r.pendingWait || r.stateJson?.pendingWait) {
      return `⏳ Waiting for a timer or signal${r.pausedFor ? ` at ${r.pausedFor}` : ''}`;
    }
    return '⏸ Paused';
  }
  const last = run.events[run.events.length - 1];
  // List rows carry no events[] (summaries) — use the server-computed
  // recent-output snippet. Derive a status-flavored line from the run's
  // status so the row still reads well even with an empty preview.
  if (!last) {
    const snippet = (run.preview ?? '').replace(/\s+/g, ' ').trim();
    if (snippet) {
      if (run.status === 'error') return `✗ ${snippet}`;
      if (run.status === 'cancelled') return `⊘ ${snippet}`;
      if (run.status === 'done') return `✓ ${snippet}`;
      return snippet;
    }
    return statusPreview(run.status);
  }
  if (last.type === 'run-error' || last.type === 'phase-error') {
    return `✗ ${(last as { error?: string }).error?.slice(0, 60) ?? 'error'}`;
  }
  // Terminal runs: the outcome, with the last output when there is one.
  if (run.status !== 'running') {
    const out = lastOutputSnippet(run.events);
    if (run.status === 'done') return out ? `✓ ${out}` : '✓ complete';
    if (run.status === 'error') return out ? `✗ ${out}` : '✗ error';
    if (run.status === 'cancelled') return '⊘ cancelled';
    return statusPreview(run.status);
  }
  if (last.type === 'run-end') return '✓ complete';
  if (last.type === 'run-cancelled') return '⊘ cancelled';
  if (last.type === 'phase-end') return `✓ ${last.phaseName}`;
  if (last.type === 'phase-tool-use') return `🔧 ${last.phaseName} → ${last.toolName}`;
  // Anything else mid-run (deltas, tool results, warnings, …) — say which
  // phase is working rather than naming the event.
  const phase = findActivePhase(run.events) ?? (last as { phaseName?: string }).phaseName;
  return phase ? `▸ Running ${phase}…` : 'running…';
}

function statusPreview(status: Run['status']): string {
  if (status === 'done') return '✓ complete';
  if (status === 'error') return '✗ error';
  if (status === 'cancelled') return '⊘ cancelled';
  if (status === 'interrupted') return '⚠ interrupted — resumable';
  if (status === 'paused') return '⏸ Paused';
  return 'starting…';
}

/** First line of the most recent non-empty phase output, for the row. */
function lastOutputSnippet(events: RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'phase-end' && typeof e.output === 'string' && e.output.trim()) {
      return e.output.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return null;
}

/** The phase a paused run is gated at: the latest run-paused sentinel's
 *  `pausedFor`, else the latest lock-gate event, else the run-level
 *  `pausedFor` the list summary carries (an un-hydrated row has no events). */
function gatedPhaseOf(run: Run): string | null {
  // Parked on a durable `wait` (timer / signal) — not a human gate, even
  // though it pauses with a `pausedFor`. The list summary carries the wait as
  // `pendingWait`; a full run carries it in `stateJson.pendingWait`.
  const r = run as { pendingWait?: unknown; stateJson?: { pendingWait?: unknown } | null };
  if (r.pendingWait || r.stateJson?.pendingWait) return null;
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i] as { type: string; pausedFor?: string; phaseName?: string };
    // Whichever came last decides what the run is parked on.
    if (e.type === 'wait-started') return null;
    if (e.type === 'lock-gate' && e.phaseName) return e.phaseName;
  }
  // No events loaded yet (a list summary): trust the summary's own fields.
  return run.events.length === 0 ? ((run as { pausedFor?: string }).pausedFor ?? null) : null;
}

type GateDecision = 'approve' | 'reject' | 'request-changes';

function RunDetailCard({
  run,
  isActive,
  onCancel,
  onStop,
  isCancelling,
  paused,
  onPause,
  onResume,
  onResumeServerRun,
  onGate,
  onChat,
  pendingApproval,
  approve,
  reject,
  onReplay,
  onFork,
  comparablePeers,
  onCompareTo,
}: {
  run: Run;
  isActive: boolean;
  onCancel: () => void;
  /** Stop a SELECTED (non-active) run by id — running, paused, or
   *  interrupted. The live active run uses onCancel instead. */
  onStop?: () => void;
  /** A cancel/stop is in flight for this run — relabel + disable the
   *  Cancel/Stop button so the click gives instant feedback while the
   *  server reaps the run. */
  isCancelling?: boolean;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  /** Resume a server-owned run that was snapshot+paused by a lock.
   *  Distinct from onResume (mid-stream pause — client-side flag).
   *  Used when run.status === 'paused'. */
  onResumeServerRun: () => void;
  /** Act on a server-owned run paused at a lock gate: approve (with an
   *  optional free-text correction for the gated phase's agent), request
   *  changes (feedback required — the gated work re-runs and re-pauses), or
   *  reject (cancel). Drives the inline gate-interaction panel. Works for
   *  the live run AND any other run paused at a gate; may return a promise
   *  that rejects on failure (the panel shows the error). */
  onGate: (decision: GateDecision, message?: string) => void | Promise<void>;
  onChat: (phaseName: string, text: string) => void;
  pendingApproval: { phaseName: string } | null;
  approve: () => void;
  reject: () => void;
  /** Undefined when no replay is possible (e.g. older persisted run
   *  without an orchestrationSnapshot). UI hides the button. */
  onReplay?: () => void;
  /** Fork this run at a chosen completed leaf phase — replays
   *  everything before it, re-executes from there. */
  onFork?: (atPhase: string) => void;
  /** Peers eligible to be compared against this run (same
   *  orchestration name, different id). Shown in a dropdown. */
  comparablePeers?: Run[];
  /** Called with the chosen peer's run id when user picks one. */
  onCompareTo?: (peerId: string) => void;
}) {
  const usage = totalUsage(run);
  const dur = run.endedAt ? Math.round((run.endedAt - run.startedAt) / 100) / 10 : null;
  // While a cancel is in flight the run still reports 'running' from the
  // stream until the server reaps it — surface 'cancelling' in the label so
  // the status matches the button.
  const statusLabel = isCancelling ? 'cancelling' : run.status;
  const subtitle = isActive
    ? `started ${formatTime(run.startedAt)} · ${statusLabel}${paused ? ' (paused)' : ''}`
    : `${formatTime(run.startedAt)} · ${statusLabel} · ${dur !== null ? `${dur}s` : '—'} · in ${usage.input}t / out ${usage.output}t${usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(4)}` : ''}`;
  // Find the currently-active phase: the most recent phase-start that
  // hasn't been followed by a phase-end / phase-error / phase-skipped
  // for the same phase. That's where chat goes. Memo depends on
  // eventVersion (not events identity) since the events array is
  // mutated in place — see runs.tsx.
  const activePhase = useMemo(
    () => findActivePhase(run.events),
    // `run.events` too: hydration replaces the array without changing the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run.eventVersion, run.events],
  );
  // What the human is being asked to approve proceeding FROM — the most recent
  // phase output before the lock gate. Surfaced in the banner so the approval
  // prompt shows a summary of the work-so-far, not just the gated phase name.
  const approvalSummary = useMemo(() => {
    if (!pendingApproval) return null;
    for (let i = run.events.length - 1; i >= 0; i--) {
      const e = run.events[i] as { type: string; output?: unknown };
      if (e.type === 'phase-end' && e.output != null && String(e.output).trim())
        return String(e.output);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.eventVersion, run.events, pendingApproval]);
  // Server-owned run snapshot+paused at a lock gate — the live run OR any
  // other paused run (a reloaded tab, or one started by the API / a trigger
  // / another tab). The gated phase is the most recent run-paused
  // sentinel's pausedFor (the executor emits it on the way out), falling
  // back to the last lock-gate event, then the summary's run-level
  // pausedFor. This is the SERVER-side analogue of the browser-side
  // pendingApproval — both feed the same GatePanel.
  const serverGate = useMemo(() => {
    if (run.status !== 'paused') return null;
    // gatedPhaseOf is null for a durable wait or a hand pause.
    const phaseName = gatedPhaseOf(run);
    if (!phaseName) return null;
    let summary: string | null = null;
    for (let i = run.events.length - 1; i >= 0; i--) {
      const e = run.events[i] as { type: string; output?: unknown };
      if (e.type === 'phase-end' && e.output != null && String(e.output).trim()) {
        summary = String(e.output);
        break;
      }
    }
    return { phaseName, summary };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.eventVersion, run.events, run.status]);
  const [showCompareList, setShowCompareList] = useState(false);
  const [showForkList, setShowForkList] = useState(false);
  // Completed leaf phases — the valid fork points. A leaf is a phase
  // whose phase-start carried an agentPath and that reached phase-end.
  const forkPoints = useMemo(() => {
    const leafNames = new Set<string>();
    const done: string[] = [];
    for (const e of run.events) {
      if (e.type === 'phase-start' && typeof e.agentPath === 'string') {
        leafNames.add(e.phaseName);
      } else if (e.type === 'phase-end' && leafNames.has(e.phaseName)) {
        if (!done.includes(e.phaseName)) done.push(e.phaseName);
      }
    }
    return done;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.eventVersion, run.events]);
  return (
    <Card
      title={run.orchestrationName}
      subtitle={subtitle}
      right={
        <View style={styles.actionRow}>
          <Pressable onPress={() => exportRunAsJson(run)} style={styles.exportBtn}>
            <Text style={styles.exportBtnText}>↓ JSON</Text>
          </Pressable>
          {!isActive && (
            <Pressable
              onPress={() => void exportRunAsOtlp(run)}
              style={styles.exportBtn}>
              <Text style={styles.exportBtnText}>↓ OTLP</Text>
            </Pressable>
          )}
          {!isActive && onReplay && (
            <Pressable onPress={onReplay} style={styles.replayBtn}>
              <Text style={styles.replayBtnText}>↻ Replay</Text>
            </Pressable>
          )}
          {!isActive && onFork && forkPoints.length > 0 && (
            <View style={showForkList && styles.popoverAnchorOpen}>
              <Pressable
                onPress={() => setShowForkList(s => !s)}
                style={styles.replayBtn}>
                <Text style={styles.replayBtnText}>⑂ Fork</Text>
              </Pressable>
              {showForkList && (
                <View style={styles.comparePopover}>
                  <Text style={styles.comparePopoverHint}>
                    re-run from a phase — earlier phases replay from
                    this run's saved outputs
                  </Text>
                  {forkPoints.map(name => (
                    <Pressable
                      key={name}
                      onPress={() => {
                        onFork(name);
                        setShowForkList(false);
                      }}
                      style={styles.comparePeerRow}>
                      <Text style={styles.comparePeerText} numberOfLines={1}>
                        ⑂ from "{name}"
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
          {!isActive && comparablePeers && comparablePeers.length > 0 && onCompareTo && (
            <View style={showCompareList && styles.popoverAnchorOpen}>
              <Pressable
                onPress={() => setShowCompareList(s => !s)}
                style={styles.compareBtn}>
                <Text style={styles.compareBtnText}>↔ Compare</Text>
              </Pressable>
              {showCompareList && (
                <View style={styles.comparePopover}>
                  <Text style={styles.comparePopoverHint}>
                    pick a peer run of "{run.orchestrationName}"
                  </Text>
                  {comparablePeers.slice(0, 12).map(p => (
                    <Pressable
                      key={p.id}
                      onPress={() => {
                        onCompareTo(p.id);
                        setShowCompareList(false);
                      }}
                      style={styles.comparePeerRow}>
                      <Text style={styles.comparePeerText} numberOfLines={1}>
                        {formatTime(p.startedAt)} · {p.status}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}
          {isActive ? (
            run.status === 'paused' ? (
              // Server-owned run snapshot+paused at a lock-gated phase.
              // Resume kicks off a fresh executor on the server with
              // skip-replay covering already-completed leaves; the
              // paused-for phase auto-approves so the lock doesn't
              // re-fire. When the gate panel is showing, its Approve IS
              // that action — a second "Resume" would only compete with it.
              <>
                {!serverGate && (
                  <Pressable onPress={onResumeServerRun} style={styles.resumeButton}>
                    <Text style={styles.resumeButtonText}>▶ Resume run</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={onCancel}
                  disabled={isCancelling}
                  style={[styles.cancelButton, isCancelling && styles.buttonDisabled]}
                  accessibilityState={{ disabled: !!isCancelling }}>
                  <Text style={styles.cancelButtonText}>
                    {isCancelling ? 'Cancelling…' : 'Cancel'}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                {paused ? (
                  <Pressable onPress={onResume} style={styles.resumeButton}>
                    <Text style={styles.resumeButtonText}>▶ Resume</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={onPause} style={styles.pauseButton}>
                    <Text style={styles.pauseButtonText}>⏸ Pause</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={onCancel}
                  disabled={isCancelling}
                  style={[styles.cancelButton, isCancelling && styles.buttonDisabled]}
                  accessibilityState={{ disabled: !!isCancelling }}>
                  <Text style={styles.cancelButtonText}>
                    {isCancelling ? 'Cancelling…' : 'Cancel'}
                  </Text>
                </Pressable>
              </>
            )
          ) : onStop &&
            (run.status === 'running' ||
              run.status === 'paused' ||
              run.status === 'interrupted') ? (
            // Selected run that isn't the live stream but is still
            // stoppable (e.g. left 'interrupted' by a crash, or a
            // server-owned run executing without a client attached).
            <Pressable
              onPress={onStop}
              disabled={isCancelling}
              style={[styles.cancelButton, isCancelling && styles.buttonDisabled]}
              accessibilityState={{ disabled: !!isCancelling }}>
              <Text style={styles.cancelButtonText}>
                {isCancelling
                  ? 'Stopping…'
                  : run.status === 'interrupted'
                    ? 'Stop / clear'
                    : 'Stop'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      }>
      {/* Browser-owned run: lock gate resolved in-memory via the
          pendingApproval promise. No free-text channel (the in-memory
          executor has no resume-with-message path), so allowMessage is
          off — approve/reject only. */}
      {isActive && pendingApproval && (
        <GatePanel
          phaseName={pendingApproval.phaseName}
          summary={approvalSummary}
          allowMessage={false}
          onApprove={approve}
          onReject={reject}
        />
      )}
      {/* Server-owned run: snapshot+paused at a lock gate — whether or not
          this tab started it. Full interaction — approve (optionally with a
          correction for the gated phase's agent), request changes, or
          reject. */}
      {!(isActive && pendingApproval) && serverGate && (
        <GatePanel
          phaseName={serverGate.phaseName}
          summary={serverGate.summary}
          allowMessage
          onApprove={msg => onGate('approve', msg)}
          onRequestChanges={msg => onGate('request-changes', msg)}
          onReject={() => onGate('reject')}
        />
      )}
      <ArtifactList run={run} />
      <BlockList events={run.events} version={run.eventVersion} />
      {isActive && activePhase && !isProgramPhase(phaseAgentPath(run.events, activePhase)) && (
        <ChatInput phaseName={activePhase} paused={paused} onSend={onChat} />
      )}
    </Card>
  );
}

/** Trigger a browser download of the full Run as a pretty-printed
 *  JSON file. Uses a one-off blob URL — no clipboard dependency,
 *  works in any browser. globalThis casts keep the non-DOM tsconfig
 *  happy without polluting the global declarations. */
function exportRunAsJson(run: Run): void {
  const g = globalThis as unknown as {
    URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
    Blob?: new (parts: string[], opts?: { type: string }) => unknown;
    document?: {
      createElement(tag: string): {
        href: string;
        download: string;
        click(): void;
      };
    };
  };
  if (!g.URL || !g.Blob || !g.document) return;
  const blob = new g.Blob([JSON.stringify(run, null, 2)], {
    type: 'application/json',
  });
  const url = g.URL.createObjectURL(blob);
  const a = g.document.createElement('a');
  a.href = url;
  a.download = `${run.orchestrationName}-${run.id}.json`;
  a.click();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
}

/** Fetch the run's OpenTelemetry trace from the server and download it
 *  as OTLP/JSON — the shape an OTLP/HTTP collector accepts at
 *  POST /v1/traces. */
async function exportRunAsOtlp(run: Run): Promise<void> {
  const g = globalThis as unknown as {
    URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
    Blob?: new (parts: string[], opts?: { type: string }) => unknown;
    document?: {
      createElement(tag: string): { href: string; download: string; click(): void };
    };
  };
  if (!g.URL || !g.Blob || !g.document) return;
  const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/trace`);
  if (!res.ok) return;
  const trace = await res.text();
  const blob = new g.Blob([trace], { type: 'application/json' });
  const url = g.URL.createObjectURL(blob);
  const a = g.document.createElement('a');
  a.href = url;
  a.download = `${run.orchestrationName}-${run.id}.otlp.json`;
  a.click();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
}

/** Side-by-side run comparison. Pairs phases by name across the two
 *  runs and renders each pair's final output. Phases unique to one
 *  side appear with an empty cell on the other.
 *
 *  Diff is intentionally simple — equal/unequal banner per row, no
 *  word-level highlighting. Word-diff is a polish iteration; for now
 *  the side-by-side comparison is what removes the workflow pain of
 *  flipping between two browser tabs. */
function CompareView({
  left,
  right,
  onExit,
}: {
  left: Run;
  right: Run;
  onExit: () => void;
}) {
  const rows = useMemo(() => {
    type Outputs = { left?: string; right?: string };
    const map = new Map<string, Outputs>();
    const order: string[] = [];
    for (const e of left.events) {
      if (e.type === 'phase-end') {
        if (!map.has(e.phaseName)) {
          order.push(e.phaseName);
          map.set(e.phaseName, {});
        }
        map.get(e.phaseName)!.left = e.output;
      }
    }
    for (const e of right.events) {
      if (e.type === 'phase-end') {
        if (!map.has(e.phaseName)) {
          order.push(e.phaseName);
          map.set(e.phaseName, {});
        }
        map.get(e.phaseName)!.right = e.output;
      }
    }
    return order.map(name => ({ name, ...map.get(name)! }));
  }, [left, right]);

  return (
    <Card
      title={`Compare: ${left.orchestrationName}`}
      subtitle={`${formatTime(left.startedAt)} · ${left.status}    vs    ${formatTime(right.startedAt)} · ${right.status}`}
      right={
        <Pressable onPress={onExit} style={styles.cancelButton}>
          <Text style={styles.cancelButtonText}>× exit compare</Text>
        </Pressable>
      }>
      {rows.length === 0 ? (
        <Hint>Neither run has any phase-end events yet.</Hint>
      ) : (
        <ScrollView style={styles.compareScroll} nestedScrollEnabled>
          {rows.map(r => {
            const both = r.left !== undefined && r.right !== undefined;
            const equal = both && r.left === r.right;
            return (
              <View key={r.name} style={styles.compareRow}>
                <View style={styles.compareRowHeader}>
                  <Text style={styles.comparePhaseName}>{r.name}</Text>
                  <Text
                    style={[
                      styles.compareDiffTag,
                      equal
                        ? styles.compareDiffEqual
                        : both
                          ? styles.compareDiffUnequal
                          : styles.compareDiffMissing,
                    ]}>
                    {equal ? '= identical' : both ? '≠ differs' : '⊘ missing on one side'}
                  </Text>
                </View>
                <View style={styles.compareCols}>
                  <View style={styles.compareCol}>
                    <Text style={styles.compareColLabel}>left</Text>
                    <Text style={styles.compareColBody} selectable>
                      <DiffText
                        side="left"
                        left={r.left ?? ''}
                        right={r.right ?? ''}
                      />
                    </Text>
                  </View>
                  <View style={styles.compareCol}>
                    <Text style={styles.compareColLabel}>right</Text>
                    <Text style={styles.compareColBody} selectable>
                      <DiffText
                        side="right"
                        left={r.left ?? ''}
                        right={r.right ?? ''}
                      />
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </Card>
  );
}

/** Word-level diff between two strings — used by CompareView so users
 *  see exactly what changed, not just "these are different".
 *
 *  Algorithm: classic LCS table over tokens (split on whitespace
 *  keeping the whitespace as its own token so spacing reconstructs).
 *  O(n*m) memory + time — fine for phase outputs in the kilobyte
 *  range. If we ever need to compare 100KB+ outputs we'd switch to
 *  Myers diff or sentence-level segmentation. */
function DiffText({
  side,
  left,
  right,
}: {
  side: 'left' | 'right';
  left: string;
  right: string;
}) {
  // Both sides identical: skip the work, render plain.
  if (left === right) {
    return <Text>{side === 'left' ? left : right}</Text>;
  }
  // Guard against pathological inputs (single mega-paragraphs of 50KB).
  // Word-diff time = O(n*m) — cap at 4000 tokens per side to keep the
  // render snappy. Past that, fall back to the un-highlighted view.
  const leftTokens = tokenizeForDiff(left);
  const rightTokens = tokenizeForDiff(right);
  if (leftTokens.length > 4000 || rightTokens.length > 4000) {
    return <Text>{side === 'left' ? left : right}</Text>;
  }
  const ops = diffTokens(leftTokens, rightTokens);
  const spans: Array<{ text: string; kind: 'same' | 'add' | 'del' }> = [];
  for (const op of ops) {
    if (side === 'left') {
      if (op.kind === 'same' || op.kind === 'del') {
        spans.push({ text: op.text, kind: op.kind === 'del' ? 'del' : 'same' });
      }
    } else {
      if (op.kind === 'same' || op.kind === 'add') {
        spans.push({ text: op.text, kind: op.kind === 'add' ? 'add' : 'same' });
      }
    }
  }
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={
            s.kind === 'add'
              ? styles.diffAdd
              : s.kind === 'del'
                ? styles.diffDel
                : undefined
          }>
          {s.text}
        </Text>
      ))}
    </>
  );
}

function tokenizeForDiff(text: string): string[] {
  // Split on whitespace boundaries but KEEP the whitespace as its own
  // token so the reconstructed output preserves spacing/newlines.
  return text.split(/(\s+)/).filter(t => t !== '');
}

function diffTokens(
  a: string[],
  b: string[],
): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  // Build LCS table.
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk back to emit ops.
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: 'del', text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ kind: 'add', text: b[j] });
    j++;
  }
  return out;
}

/** Find the currently-active phase name in an event list — the most
 *  recent phase-start that hasn't yet been closed by an end/error/skip.
 *  Returns null when no phase is in flight (run hasn't started or all
 *  phases are settled). */
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

/** Prominent inline human-in-the-loop gate panel. Renders at the live
 *  edge of the run log when a run is paused at a `lock: true` gate.
 *  Shows the gated phase, the work-so-far the human is approving (in full,
 *  scrollable), and Approve / Reject actions. When `allowMessage` is set
 *  (server-owned runs), it also offers a free-text note: sent with Approve
 *  as a correction for the gated phase's agent, or — via Request changes —
 *  as feedback the gated work is revised against before it re-pauses.
 *  Handlers may return a promise; a rejection is shown inline and the
 *  buttons re-enable. */
function GatePanel({
  phaseName,
  summary,
  allowMessage,
  onApprove,
  onRequestChanges,
  onReject,
}: {
  phaseName: string;
  summary: string | null;
  allowMessage: boolean;
  onApprove: (message?: string) => void | Promise<void>;
  onRequestChanges?: (message: string) => void | Promise<void>;
  onReject: () => void | Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<GateDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = message.trim();
  const decide = (decision: GateDecision, act: () => void | Promise<void>) => {
    setBusy(decision);
    setError(null);
    Promise.resolve()
      .then(act)
      .then(
        () => {
          setBusy(null);
          // Sent — a re-paused gate (request changes) starts a fresh note.
          setMessage('');
        },
        (err: unknown) => {
          setBusy(null);
          setError(`Gate failed: ${(err as Error).message}`);
        },
      );
  };
  return (
    <View style={styles.gatePanel}>
      <View style={styles.gatePanelHeaderRow}>
        <Text style={styles.gatePanelBadge}>HUMAN GATE</Text>
        <Text style={styles.gatePanelTitle}>
          🔒 Paused before{' '}
          <Text style={styles.lockBannerName}>{phaseName}</Text>
        </Text>
      </View>
      <Text style={styles.gatePanelHint}>
        Review the work so far, then approve to continue
        {allowMessage ? ' (optionally with a correction)' : ''}
        {onRequestChanges ? ', request changes to have it revised' : ''}, or
        reject to cancel the run.
      </Text>
      {summary && (
        <View>
          <Text style={styles.gatePanelSummaryLabel}>
            Latest phase output
          </Text>
          <OutputBlock
            text={summary}
            tall
            boxStyle={styles.gateSummaryBox}
            textStyle={styles.lockBannerSummary}
          />
        </View>
      )}
      {allowMessage && (
        <View>
          <Text style={styles.gatePanelMsgLabel}>
            Note for the agent — a correction sent with Approve, or the
            feedback for Request changes
          </Text>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="e.g. Focus on the auth flow only; skip the billing checks…"
            style={styles.gatePanelInput}
            multiline
          />
        </View>
      )}
      {error && <Text style={styles.gateError}>{error}</Text>}
      <View style={styles.lockBannerButtons}>
        <Pressable
          onPress={() => decide('reject', onReject)}
          disabled={busy != null}
          accessibilityRole="button"
          style={[styles.lockBtn, styles.gateRejectBtn, busy != null && styles.buttonDisabled]}>
          <Text style={styles.gateRejectBtnText}>
            {busy === 'reject' ? 'Rejecting…' : '✕ Reject (cancel run)'}
          </Text>
        </Pressable>
        {onRequestChanges && (
          <Pressable
            onPress={() => decide('request-changes', () => onRequestChanges(trimmed))}
            disabled={busy != null || !trimmed}
            accessibilityRole="button"
            accessibilityHint="Write a note first — it is the feedback to revise against"
            style={[
              styles.lockBtn,
              styles.lockBtnSecondary,
              (busy != null || !trimmed) && styles.buttonDisabled,
            ]}>
            <Text style={styles.lockBtnSecondaryText}>
              {busy === 'request-changes' ? 'Sending…' : '↺ Request changes'}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() =>
            decide('approve', () =>
              onApprove(allowMessage && trimmed ? trimmed : undefined),
            )
          }
          disabled={busy != null}
          accessibilityRole="button"
          style={[styles.lockBtn, styles.lockBtnPrimary, busy != null && styles.buttonDisabled]}>
          <Text style={styles.lockBtnPrimaryText}>
            {busy === 'approve'
              ? 'Approving…'
              : allowMessage && trimmed
                ? '✓ Approve + send'
                : '✓ Approve'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Pretty-print an output that is a JSON object/array (2-space indent) so
 *  it reads as structure, not one long line; anything else comes back
 *  unchanged — its real newlines render as-is. */
function prettyOutput(text: string): { text: string; isJson: boolean } {
  const t = text.trim();
  if (
    (t.startsWith('{') && t.endsWith('}')) ||
    (t.startsWith('[') && t.endsWith(']'))
  ) {
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === 'object') {
        return { text: JSON.stringify(v, null, 2), isJson: true };
      }
    } catch {
      /* not JSON — show as text */
    }
  }
  return { text, isJson: false };
}

/** Outputs longer than this get an Expand / Collapse toggle. */
const LONG_OUTPUT_CHARS = 600;
const LONG_OUTPUT_LINES = 12;

/** A phase / tool / gate output shown IN FULL: a bounded scroll region
 *  (nothing is cut off — scroll to read the rest) plus an Expand toggle
 *  that drops the height cap for long outputs. JSON objects/arrays are
 *  pretty-printed in monospace; other text renders as Markdown when
 *  `markdown` is set, else as plain selectable text. */
function OutputBlock({
  text,
  markdown,
  tall,
  boxStyle,
  textStyle,
}: {
  text: string;
  markdown?: boolean;
  /** A taller collapsed cap — for the gate panel, where the output IS the
   *  thing being reviewed. */
  tall?: boolean;
  boxStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const [expanded, setExpanded] = useState(false);
  const pretty = useMemo(() => prettyOutput(text), [text]);
  const long =
    pretty.text.length > LONG_OUTPUT_CHARS ||
    pretty.text.split('\n').length > LONG_OUTPUT_LINES;
  return (
    <View>
      <ScrollView
        style={[
          styles.output,
          boxStyle,
          !expanded && (tall ? styles.outputCappedTall : styles.outputCapped),
        ]}
        nestedScrollEnabled>
        {pretty.isJson || !markdown ? (
          <Text
            style={[styles.outputText, textStyle, pretty.isJson && styles.outputJson]}
            selectable>
            {pretty.text}
          </Text>
        ) : (
          <Markdown source={pretty.text} />
        )}
      </ScrollView>
      {long && (
        <Pressable
          onPress={() => setExpanded(e => !e)}
          accessibilityRole="button"
          style={styles.expandToggle}>
          <Text style={styles.expandToggleText}>
            {expanded ? '▴ Collapse' : '▾ Expand to full height'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function ChatInput({
  phaseName,
  paused,
  onSend,
}: {
  phaseName: string;
  paused: boolean;
  onSend: (phaseName: string, text: string) => void;
}) {
  const [text, setText] = useState('');
  function send() {
    if (!text.trim()) return;
    onSend(phaseName, text);
    setText('');
  }
  return (
    <View style={styles.chatBox}>
      <Text style={styles.chatLabel}>
        Chat with <Text style={styles.chatPhaseName}>{phaseName}</Text>
        {paused ? ' (paused — sending will resume)' : ' — sent on its next exchange'}
      </Text>
      <View style={styles.chatRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Tell the agent something…"
          style={styles.chatInput}
          multiline
        />
        <Pressable
          onPress={send}
          disabled={!text.trim()}
          style={[styles.chatSendButton, !text.trim() && styles.chatSendButtonDisabled]}>
          <Text style={styles.chatSendButtonText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

// -------- Block grouping --------

type Block = { ts?: number } & (
  | {
      kind: 'meta';
      tone: BlockTone;
      text: string;
      /** The full, untruncated content behind a shortened `text` (a tool
       *  result, a subagent prompt / reply) — revealed on demand. */
      detail?: string;
    }
  | { kind: 'lock'; name: string }
  | {
      kind: 'composite-open' | 'composite-close';
      name: string;
      compositeKind: CompositeKind;
    }
  | {
      kind: 'phase';
      name: string;
      agentPath?: string;
      status: 'running' | 'done' | 'skipped' | 'error';
      text: string;
      reason?: string;
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      durationMs?: number;
    }
);

type BlockTone = 'dim' | 'info' | 'ok' | 'warn' | 'err';

function groupEvents(events: RunEvent[]): Block[] {
  const blocks: Block[] = [];

  function findOpenPhase(name: string): Block | undefined {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'phase' && b.name === name && b.status === 'running') return b;
    }
    return undefined;
  }

  for (const e of events) {
    const before = blocks.length;
    const ets = (e as { ts?: number }).ts;
    switch (e.type) {
      case 'run-start':
        blocks.push({ kind: 'meta', tone: 'dim', text: '▶ run started' });
        break;
      case 'run-end':
        blocks.push({ kind: 'meta', tone: 'ok', text: '■ run complete' });
        break;
      case 'run-error':
        blocks.push({ kind: 'meta', tone: 'err', text: `✗ run error: ${e.error}` });
        break;
      case 'run-cancelled':
        blocks.push({ kind: 'meta', tone: 'warn', text: '⊘ run cancelled' });
        break;
      case 'composite-start':
        blocks.push({ kind: 'composite-open', name: e.phaseName, compositeKind: e.kind });
        break;
      case 'composite-end':
        blocks.push({ kind: 'composite-close', name: e.phaseName, compositeKind: e.kind });
        break;
      case 'lock-gate':
        blocks.push({ kind: 'lock', name: e.phaseName });
        break;
      case 'phase-start':
        blocks.push({
          kind: 'phase',
          name: e.phaseName,
          agentPath: e.agentPath,
          status: 'running',
          text: '',
        });
        break;
      case 'phase-delta': {
        const open = findOpenPhase(e.phaseName);
        if (open && open.kind === 'phase') open.text += e.text;
        break;
      }
      case 'phase-end': {
        const open = findOpenPhase(e.phaseName);
        if (open && open.kind === 'phase') {
          open.status = 'done';
          open.text = e.output;
          open.inputTokens = e.inputTokens;
          open.outputTokens = e.outputTokens;
          open.costUsd = e.costUsd;
          open.durationMs = e.durationMs;
        }
        break;
      }
      case 'phase-skipped':
        blocks.push({
          kind: 'phase',
          name: e.phaseName,
          status: 'skipped',
          text: '',
          reason: e.reason,
        });
        break;
      case 'phase-error': {
        const open = findOpenPhase(e.phaseName);
        if (open && open.kind === 'phase') {
          open.status = 'error';
          open.error = e.error;
        } else {
          blocks.push({
            kind: 'phase',
            name: e.phaseName,
            status: 'error',
            text: '',
            error: e.error,
          });
        }
        break;
      }
      case 'loop-iteration':
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text: `↻ ${e.phaseName} — iteration ${e.iteration}`,
        });
        break;
      case 'loop-stopped':
        blocks.push({
          kind: 'meta',
          tone: 'ok',
          text: `■ ${e.phaseName} — stopped at iter ${e.iteration} (${e.reason})`,
        });
        break;
      case 'route-decision': {
        const missing = (e as { unresolved?: string[] }).unresolved;
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text:
            `⋔ ${e.phaseName} — chose branch "${e.branch}"` +
            (missing && missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''),
        });
        break;
      }
      case 'worktrees-ready':
        for (const w of e.worktrees) {
          blocks.push({
            kind: 'meta',
            tone: 'dim',
            text: `⎇ worktree ${w.name} on ${w.branch}${w.reused ? ' (resumed)' : ''} — ${w.path}`,
          });
        }
        break;
      case 'artifact':
        blocks.push({
          kind: 'meta',
          tone: e.dropped ? 'warn' : 'info',
          text:
            `📎 ${e.phaseName} kept artifact "${e.name}" (${formatBytes(e.bytes)}` +
            `${e.truncated ? ', truncated' : ''}${e.dropped ? ', dropped — artifact budget spent' : ''})`,
        });
        break;
      case 'map-iteration':
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text: `▸ ${e.phaseName} — item ${e.iteration}/${e.total}`,
        });
        break;
      case 'node-retried':
        blocks.push({
          kind: 'meta',
          tone: 'warn',
          text: `↻ ${e.phaseName} — retry ${e.attempt}/${e.maxAttempts} after ${e.delayMs}ms (${e.error})`,
        });
        break;
      case 'node-recovered':
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text: `↩ ${e.phaseName} — recovered via onError (${e.error})`,
        });
        break;
      case 'node-stalled':
        blocks.push({
          kind: 'meta',
          tone: 'err',
          text: `⏱ ${e.phaseName} — no progress for ${e.stallSeconds}s, aborted by stall watchdog`,
        });
        break;
      case 'budget-exceeded':
        blocks.push({
          kind: 'meta',
          tone: 'err',
          text: `$✗ ${e.phaseName} — budget exceeded: ${e.kind} ${formatNum(e.actual)} > ${formatNum(e.limit)}`,
        });
        break;
      case 'tools-warning':
        blocks.push({
          kind: 'meta',
          tone: 'warn',
          text: `⚠ ${e.phaseName} — missing tools: ${e.missing.join(', ')}`,
        });
        break;
      case 'state-set':
        blocks.push({
          kind: 'meta',
          tone: 'dim',
          text: `≡ \${${e.key}} set`,
        });
        break;
      case 'state-conflict':
        blocks.push({
          kind: 'meta',
          tone: 'warn',
          text: `⚠ ${e.phaseName} — \${${e.key}} written by multiple branches; kept the last by branch order`,
        });
        break;
      case 'phase-tool-use': {
        // Task tool calls = subagent dispatch — call them out distinctly
        // so users can spot them in a tool-call storm and see which
        // subagent is being asked what.
        if (e.toolName === 'Task') {
          const input = (e.input ?? {}) as {
            subagent_type?: string;
            description?: string;
            prompt?: string;
          };
          const desc = input.description ? ` — ${input.description.slice(0, 80)}` : '';
          blocks.push({
            kind: 'meta',
            tone: 'info',
            text: `🤖 ${e.phaseName} → subagent "${input.subagent_type ?? '(unknown)'}"${desc}`,
          });
          if (input.prompt) {
            blocks.push({
              kind: 'meta',
              tone: 'dim',
              text: `  ↳ prompt: ${input.prompt.slice(0, 200).replace(/\s+/g, ' ')}${input.prompt.length > 200 ? '…' : ''}`,
              detail: input.prompt.length > 200 ? input.prompt : undefined,
            });
          }
          break;
        }
        // Regular tool call: render as a meta line so it threads inline
        // with the agent's text. Args truncated to keep the run viewer
        // readable; full input still in the raw event log.
        const argPreview = previewInput(e.input);
        const fullInput =
          e.input == null
            ? ''
            : typeof e.input === 'string'
              ? e.input
              : JSON.stringify(e.input);
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text: `🔧 ${e.phaseName} → ${e.toolName}(${argPreview})`,
          // Only when the preview actually dropped something (a cut value
          // or extra keys) — otherwise it already shows the whole call.
          detail: /…|, \+\d+$/.test(argPreview) ? fullInput : undefined,
        });
        break;
      }
      case 'phase-tool-result': {
        const trimmed = (e.output ?? '').trim();
        // Match Task tool result to its dispatching use by tool-use-id —
        // if found, render the subagent's final reply at higher fidelity
        // (longer cap, distinct framing) than ordinary tool results.
        const matchingUse = events.find(
          x =>
            x.type === 'phase-tool-use' &&
            (x as Extract<RunEvent, { type: 'phase-tool-use' }>).toolUseId ===
              e.toolUseId,
        ) as Extract<RunEvent, { type: 'phase-tool-use' }> | undefined;
        if (matchingUse && matchingUse.toolName === 'Task') {
          const long =
            trimmed.length > 600
              ? trimmed.slice(0, 600).replace(/\s+/g, ' ') + ' …'
              : trimmed;
          blocks.push({
            kind: 'meta',
            tone: e.isError ? 'err' : 'ok',
            text: `${e.isError ? '✗' : '↩'} subagent returned: ${long || '(empty)'}`,
            detail: trimmed.length > 600 ? trimmed : undefined,
          });
          break;
        }
        const summary =
          trimmed.length === 0
            ? '(empty)'
            : trimmed.length > 120
              ? trimmed.slice(0, 120).replace(/\s+/g, ' ') + '…'
              : trimmed.replace(/\s+/g, ' ');
        blocks.push({
          kind: 'meta',
          tone: e.isError ? 'err' : 'dim',
          text: `${e.isError ? '✗' : '←'} tool returned: ${summary}`,
          // Any result that was shortened or had its newlines flattened.
          detail: summary !== trimmed && trimmed.length > 0 ? trimmed : undefined,
        });
        break;
      }
      case 'phase-paused':
        blocks.push({
          kind: 'meta',
          tone: 'warn',
          text:
            e.reason === 'max-turns'
              ? `⏸ ${e.phaseName} — paused (hit max turns, click Resume to continue)`
              : `⏸ ${e.phaseName} — paused by user`,
        });
        break;
      case 'phase-resumed':
        blocks.push({
          kind: 'meta',
          tone: 'dim',
          text: `▶ ${e.phaseName} — resumed`,
        });
        break;
      case 'phase-user-message':
        blocks.push({
          kind: 'meta',
          tone: 'info',
          text: `💬 you → ${e.phaseName}: ${e.text}`,
        });
        break;
      case 'budget-halted':
        blocks.push({
          kind: 'meta',
          tone: 'err',
          text: `$✗ run halted — ${e.reason}`,
        });
        break;
      case 'gate-decision': {
        const verb =
          e.decision === 'approve'
            ? '✓ approved'
            : e.decision === 'reject'
              ? '✕ rejected'
              : '↺ requested changes on';
        const msg = e.message?.trim();
        blocks.push({
          kind: 'meta',
          tone: e.decision === 'reject' ? 'warn' : 'info',
          text: `🔒 ${verb} gate "${e.phaseName}"${e.decidedBy ? ` (${e.decidedBy})` : ''}${msg ? ` — ${msg.replace(/\s+/g, ' ').slice(0, 120)}${msg.length > 120 ? '…' : ''}` : ''}`,
          detail: msg && msg.length > 120 ? msg : undefined,
        });
        break;
      }
      case 'lifecycle-warning':
        blocks.push({
          kind: 'meta',
          tone: 'warn',
          text: `⚠ ${e.deprecated ? 'deprecated' : 'lifecycle'}${e.stage ? ` (${e.stage})` : ''}${e.reason ? ` — ${e.reason}` : ''}`,
        });
        break;
    }
    // Stamp any block(s) this event created with the event's timestamp, so the
    // run viewer can show a "time sent" on the left of each message.
    for (let j = before; j < blocks.length; j++) {
      if (blocks[j].ts == null && ets != null) blocks[j].ts = ets;
    }
  }
  return blocks;
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    return input.length > 80 ? input.slice(0, 80) + '…' : input;
  }
  if (typeof input === 'object') {
    // Tool inputs are usually small objects — show the first key/value.
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '';
    const k = keys[0];
    const v = obj[k];
    const vStr =
      typeof v === 'string'
        ? `"${v.length > 60 ? v.slice(0, 60) + '…' : v}"`
        : JSON.stringify(v).slice(0, 60);
    return keys.length === 1 ? `${k}: ${vStr}` : `${k}: ${vStr}, +${keys.length - 1}`;
  }
  return String(input);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A run's artifacts (`code.artifact` logs), each viewable in an in-app
 *  viewer that reads GET /api/runs/:id/artifacts?name= (the raw URL stays
 *  one click away inside it). Hidden when the run kept none. */
function ArtifactList({ run }: { run: Run }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const items = useMemo(() => {
    const byName = new Map<string, { name: string; phaseName: string; bytes: number; dropped: boolean }>();
    for (const ev of run.events) {
      const e = ev as { type: string; name?: string; phaseName?: string; bytes?: number; dropped?: boolean };
      if (e.type === 'artifact' && e.name) {
        byName.set(e.name, {
          name: e.name,
          phaseName: e.phaseName ?? '',
          bytes: e.bytes ?? 0,
          dropped: e.dropped === true,
        });
      }
    }
    return [...byName.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.eventVersion, run.events]);
  if (items.length === 0) return null;
  return (
    <View style={styles.artifacts}>
      <Text style={styles.artifactsTitle}>Artifacts</Text>
      {items.map(a => (
        <View key={a.name} style={styles.artifactRow}>
          <Text style={styles.artifactName}>{a.name}</Text>
          <Text style={styles.artifactMeta}>
            {a.phaseName} · {formatBytes(a.bytes)}
            {a.dropped ? ' · dropped' : ''}
          </Text>
          {!a.dropped && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View artifact ${a.name}`}
              onPress={() => setViewing(a.name)}>
              <Text style={styles.artifactLink}>View</Text>
            </Pressable>
          )}
        </View>
      ))}
      <ArtifactViewer
        name={viewing}
        url={
          viewing
            ? `/api/runs/${encodeURIComponent(run.id)}/artifacts?name=${encodeURIComponent(viewing)}`
            : null
        }
        onClose={() => setViewing(null)}
      />
    </View>
  );
}

function formatNum(n: number): string {
  if (n < 1) return n.toFixed(4);
  if (n < 100) return n.toFixed(2);
  return Math.round(n).toLocaleString();
}

function BlockList({ events, version }: { events: RunEvent[]; version: number }) {
  // events is mutated in place by the runs store — see runs.tsx. memoize
  // on `version` so groupEvents re-runs when new events arrive but skips
  // when only sibling props change.
  // `events` identity is in the deps too: a run selected from history
  // arrives as a summary (empty events, eventVersion = the server's count)
  // and is then HYDRATED with the full array — same count, new array. Keyed
  // on `version` alone, the memo kept the empty grouping and the detail
  // showed "(starting…)" forever. `events.length` covers in-place growth.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const blocks = useMemo(() => groupEvents(events), [version, events, events.length]);
  const scrollRef = useRef<ScrollView>(null);
  // Auto-pin to the bottom as new events stream in. Without this, the
  // viewer keeps the old scroll position and the user has to manually
  // chase the bottom every time a tool fires.
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [blocks.length]);
  if (blocks.length === 0) return <Hint>(starting…)</Hint>;
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.blockListScroll}
      contentContainerStyle={styles.blockList}
      nestedScrollEnabled>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </ScrollView>
  );
}

function BlockView({ block }: { block: Block }) {
  return (
    <View style={styles.msgRow}>
      <Text style={styles.timeTag} selectable>
        {block.ts != null ? formatTime(block.ts) : ''}
      </Text>
      <View style={styles.msgBody}>{renderBlockInner(block)}</View>
    </View>
  );
}

function renderBlockInner(block: Block) {
  switch (block.kind) {
    case 'meta':
      return <MetaRow tone={block.tone} text={block.text} detail={block.detail} />;
    case 'lock':
      return (
        <MetaRow tone="warn" text={`🔒 lock gate at "${block.name}" — awaiting approval`} />
      );
    case 'composite-open':
      return (
        <MetaRow
          tone="info"
          text={`╔ composite ${block.compositeKind} "${block.name}"`}
        />
      );
    case 'composite-close':
      return (
        <MetaRow tone="dim" text={`╚ end ${block.compositeKind} "${block.name}"`} />
      );
    case 'phase':
      return <PhaseBlock block={block} />;
  }
}

function PhaseBlock({
  block,
}: {
  block: Extract<Block, { kind: 'phase' }>;
}) {
  const tone =
    block.status === 'error'
      ? 'err'
      : block.status === 'skipped'
        ? 'warn'
        : block.status === 'done'
          ? 'ok'
          : 'info';
  const statusIcon =
    block.status === 'running'
      ? '▸'
      : block.status === 'done'
        ? '✓'
        : block.status === 'skipped'
          ? '⊘'
          : '✗';
  return (
    <View style={[styles.row, styles[`row_${tone}`]]}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowText}>
          {statusIcon} {block.name}
          {block.agentPath && <Text style={styles.rowMeta}> · {block.agentPath}</Text>}
          {block.status === 'done' && (
            <Text style={styles.rowMeta}>
              {!isProgramPhase(block.agentPath) &&
                ` · ${block.inputTokens ?? 0}t in / ${block.outputTokens ?? 0}t out`}
              {block.durationMs != null && ` · ${(block.durationMs / 1000).toFixed(1)}s`}
              {block.costUsd != null && block.costUsd > 0 && ` · $${block.costUsd.toFixed(4)}`}
            </Text>
          )}
        </Text>
        {block.status === 'running' && (
          <Text style={styles.streamingDot}>● streaming</Text>
        )}
      </View>
      {block.reason ? <Text style={styles.subtle}>{block.reason}</Text> : null}
      {block.error ? <Text style={styles.errorText}>{block.error}</Text> : null}
      {block.text ? (
        <OutputBlock text={block.text} markdown={!isProgramPhase(block.agentPath)} />
      ) : null}
    </View>
  );
}

function MetaRow({
  tone,
  text,
  detail,
}: {
  tone: BlockTone;
  text: string;
  /** Full content behind a shortened line — "show full" reveals it. */
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.row, styles[`row_${tone}`]]}>
      <Text style={styles.rowText}>{text}</Text>
      {detail ? (
        <>
          <Pressable
            onPress={() => setOpen(o => !o)}
            accessibilityRole="button"
            style={styles.expandToggle}>
            <Text style={styles.expandToggleText}>
              {open ? '▴ hide full' : '▾ show full'}
            </Text>
          </Pressable>
          {open && <OutputBlock text={detail} />}
        </>
      ) : null}
    </View>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Compact date + time for the runs list — so a run's day is visible at a
 *  glance, not just its clock time (which is ambiguous across days). */
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} · ${formatTime(ts)}`;
}

const styles = StyleSheet.create({
  artifacts: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    padding: 8,
    gap: 4,
    backgroundColor: '#f9fafb',
  },
  artifactsTitle: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  artifactRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  artifactName: { fontFamily: 'monospace', fontSize: 12, color: '#111827' },
  artifactMeta: { fontSize: 12, color: '#6b7280', flex: 1 },
  artifactLink: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  layout: {
    flexDirection: 'row',
    flex: 1,
    minHeight: 500,
    gap: 12,
  },
  sidebar: {
    width: 260,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  sidebarEmpty: { padding: 14 },
  sidebarScroll: { flex: 1 },
  sidebarRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 2,
  },
  sidebarRowSelected: {
    backgroundColor: '#2563eb',
  },
  sidebarTextSelected: { color: '#ffffff' },
  sidebarMetaSelected: { color: '#bfdbfe' },
  sidebarRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  sidebarName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  sidebarMeta: {
    fontSize: 11,
    color: '#6b7280',
  },
  sidebarPreview: {
    fontSize: 11,
    color: '#374151',
    marginTop: 2,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  detail: { flex: 1 },

  root: { flex: 1 },
  // react-native-web gives every View its own stacking context (z-index 0),
  // so an open popover's wrapper must out-rank its later sibling buttons —
  // and the card header (see Page.tsx Card) out-ranks the card body.
  actionRow: { flexDirection: 'row', gap: 6, zIndex: 30 },
  popoverAnchorOpen: { zIndex: 40 },
  cancelButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  cancelButtonText: { fontSize: 11, color: '#b91c1c', fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  pauseButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#fffbeb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  pauseButtonText: { fontSize: 11, color: '#92400e', fontWeight: '600' },
  resumeButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#ecfdf5',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  resumeButtonText: { fontSize: 11, color: '#065f46', fontWeight: '600' },
  chatBox: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 6,
  },
  chatLabel: { fontSize: 11, color: '#6b7280' },
  chatPhaseName: { fontFamily: 'Menlo', color: '#111827', fontWeight: '600' },
  chatRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  chatInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
    minHeight: 38,
    maxHeight: 120,
    textAlignVertical: 'top',
  },
  chatSendButton: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  chatSendButtonDisabled: { opacity: 0.5 },
  chatSendButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },

  lockBanner: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  lockBannerText: { fontSize: 13, color: '#92400e' },
  lockBannerName: { fontFamily: 'Menlo', fontWeight: '700' },
  // The work-so-far the human is approving — shown above the buttons.
  lockBannerSummary: {
    fontSize: 12,
    color: '#78350f',
    fontFamily: 'Menlo',
    lineHeight: 17,
    backgroundColor: '#fffbeb',
    borderRadius: 6,
    padding: 8,
  },
  lockBannerButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  lockBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6 },
  lockBtnPrimary: { backgroundColor: '#059669' },
  lockBtnPrimaryText: { color: '#ffffff', fontWeight: '700', fontSize: 12 },
  lockBtnSecondary: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  lockBtnSecondaryText: { color: '#374151', fontWeight: '600', fontSize: 12 },

  // ── Human-in-the-loop gate panel (prominent, at the live edge) ──
  gatePanel: {
    backgroundColor: '#fffbeb',
    borderWidth: 2,
    borderColor: '#f59e0b',
    borderRadius: 10,
    padding: 14,
    gap: 10,
    marginBottom: 10,
    // Subtle lift so the panel reads as the thing demanding attention.
    shadowColor: '#92400e',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  gatePanelHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gatePanelBadge: {
    backgroundColor: '#f59e0b',
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
  },
  gatePanelTitle: { fontSize: 14, color: '#92400e', fontWeight: '600', flexShrink: 1 },
  gatePanelHint: { fontSize: 12, color: '#78350f', lineHeight: 17 },
  gatePanelSummaryLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400e',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  gatePanelMsgLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400e',
    marginBottom: 5,
  },
  gatePanelInput: {
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#ffffff',
    borderRadius: 6,
    padding: 9,
    fontSize: 13,
    minHeight: 56,
    color: '#1f2937',
  },
  gateRejectBtn: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dc2626',
  },
  gateRejectBtnText: { color: '#dc2626', fontWeight: '700', fontSize: 12 },
  // The gated output: a bounded, scrollable region showing the FULL text.
  gateSummaryBox: {
    marginTop: 0,
    padding: 0,
    backgroundColor: '#fffbeb',
    borderColor: '#fde68a',
    borderRadius: 6,
  },
  gateError: { fontSize: 12, color: '#b91c1c' },

  searchWrap: {
    padding: 10,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  searchInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 11,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  filterRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  filterChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  filterChipText: { fontSize: 10, color: '#374151' },
  filterChipTextActive: { color: '#ffffff', fontWeight: '600' },
  selectRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  selectToggle: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  selectToggleText: { fontSize: 10, color: '#374151', fontWeight: '600' },
  selectAllBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#eff6ff',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  selectAllBtnText: { fontSize: 10, color: '#1d4ed8', fontWeight: '600' },
  selectDeleteBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#dc2626',
    borderRadius: 4,
    flex: 1,
    alignItems: 'center',
  },
  selectDeleteBtnText: { fontSize: 10, color: '#ffffff', fontWeight: '700' },
  selectStopBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#ea580c',
    borderRadius: 4,
    flex: 1,
    alignItems: 'center',
  },
  selectStopBtnText: { fontSize: 10, color: '#ffffff', fontWeight: '700' },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#9ca3af',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  checkboxMark: { fontSize: 10, color: '#ffffff', fontWeight: '700', lineHeight: 12 },
  exportBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  exportBtnText: { fontSize: 11, color: '#1d4ed8', fontWeight: '600' },
  replayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#ecfdf5',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  replayBtnText: { fontSize: 11, color: '#065f46', fontWeight: '600' },
  compareBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#faf5ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e9d5ff',
  },
  compareBtnText: { fontSize: 11, color: '#6b21a8', fontWeight: '600' },
  comparePopover: {
    position: 'absolute',
    top: 30,
    right: 0,
    minWidth: 220,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 6,
    gap: 4,
    zIndex: 50,
    shadowColor: '#111827',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  comparePopoverHint: { fontSize: 10, color: '#6b7280', padding: 6 },
  comparePeerRow: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
  },
  comparePeerText: { fontSize: 11, color: '#111827', fontFamily: 'Menlo' },
  compareScroll: { maxHeight: 560 },
  compareRow: {
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  compareRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  comparePhaseName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  compareDiffTag: {
    fontSize: 10,
    fontFamily: 'Menlo',
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  compareDiffEqual: { color: '#065f46', backgroundColor: '#ecfdf5' },
  compareDiffUnequal: { color: '#92400e', backgroundColor: '#fffbeb' },
  compareDiffMissing: { color: '#6b7280', backgroundColor: '#f3f4f6' },
  compareCols: { flexDirection: 'row', gap: 8 },
  compareCol: {
    flex: 1,
    minWidth: 0,
    padding: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  compareColLabel: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  compareColBody: { fontSize: 11, color: '#111827', fontFamily: 'Menlo' },
  diffAdd: { backgroundColor: '#bbf7d0', color: '#065f46' },
  diffDel: {
    backgroundColor: '#fecaca',
    color: '#991b1b',
    textDecorationLine: 'line-through',
  },
  blockList: { gap: 4 },
  // "Time sent" gutter on the left of each run-log message.
  msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  timeTag: {
    fontSize: 10,
    color: '#9ca3af',
    fontFamily: 'Menlo',
    paddingTop: 6,
    minWidth: 58,
    textAlign: 'right',
  },
  msgBody: { flex: 1, minWidth: 0 },
  blockListScroll: {
    // Cap the run-viewer at a reasonable size so a long live run
    // doesn't blow the page to thousands of pixels. Internal scroll
    // takes over past this — outer page chrome stays put.
    maxHeight: 560,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingTop: 6,
  },
  row: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#d1d5db',
  },
  row_dim: { borderLeftColor: '#9ca3af', backgroundColor: '#f9fafb' },
  row_info: { borderLeftColor: '#2563eb', backgroundColor: '#eff6ff' },
  row_ok: { borderLeftColor: '#059669', backgroundColor: '#ecfdf5' },
  row_warn: { borderLeftColor: '#d97706', backgroundColor: '#fffbeb' },
  row_err: { borderLeftColor: '#dc2626', backgroundColor: '#fef2f2' },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowText: { fontSize: 12, color: '#111827', fontFamily: 'Menlo' },
  rowMeta: { color: '#6b7280', fontSize: 10 },
  subtle: { fontSize: 11, color: '#6b7280', marginTop: 2, fontStyle: 'italic' },
  errorText: { fontSize: 11, color: '#b91c1c', marginTop: 2 },
  streamingDot: { fontSize: 10, color: '#2563eb', fontWeight: '600' },
  output: {
    marginTop: 6,
    padding: 8,
    backgroundColor: '#ffffff',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  outputText: { fontFamily: 'Menlo', fontSize: 11, color: '#111827', lineHeight: 16 },
  // Collapsed outputs scroll inside a capped box; expanded drops the cap
  // so the whole output shows inline (the page scrolls).
  outputCapped: { maxHeight: 240 },
  outputCappedTall: { maxHeight: 320 },
  outputJson: { fontFamily: 'Menlo' },
  expandToggle: { alignSelf: 'flex-start', paddingVertical: 3 },
  expandToggleText: { fontSize: 11, color: '#2563eb', fontWeight: '600' },
  code: {
    fontFamily: 'Menlo',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
});
