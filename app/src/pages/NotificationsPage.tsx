import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRuns, type Run } from '../store/runs';
import type { RunStatus } from '../store/runs';
import { requestRun } from '../store/runSelection';
import type { PageId } from '../Sidebar';
import { Card, Hint, Page } from './Page';

/** The four terminal outcomes the feed surfaces, in display order. Each
 *  maps a summary card to the RunStatus it filters by. */
const FILTERABLE: RunStatus[] = ['done', 'error', 'interrupted', 'cancelled'];

/** Per-run-status visual treatment for the notifications feed. Distinct
 *  from lib/runStatus' node palette — these are whole-run outcomes
 *  (interrupted / cancelled don't exist at the node level). */
const STATUS_META: Record<
  RunStatus,
  { glyph: string; label: string; color: string; bg: string; border: string }
> = {
  running: { glyph: '◉', label: 'running', color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
  paused: { glyph: '⏸', label: 'paused', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  done: { glyph: '✓', label: 'finished', color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
  error: { glyph: '✕', label: 'failed', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  interrupted: { glyph: '⚠', label: 'interrupted', color: '#b45309', bg: '#fff7ed', border: '#fed7aa' },
  cancelled: { glyph: '⊘', label: 'cancelled', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
};

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Recoverable from a stored checkpoint via the server resume endpoint. */
function isResumable(status: RunStatus): boolean {
  return status === 'interrupted' || status === 'paused';
}

/** Outcomes that warrant follow-up — these drive the attention badge and
 *  are the ones offered a per-row dismiss. */
function needsAttention(status: RunStatus): boolean {
  return status === 'error' || status === 'interrupted';
}

export function NotificationsPage({
  onNavigate,
}: {
  onNavigate?: (page: PageId) => void;
}) {
  const {
    notifications,
    notifSeenAt,
    markNotificationsSeen,
    ackedIds,
    acknowledgeNotifications,
    resumeServerRunById,
    cancelRunById,
    isCancelling,
    startServerRun,
  } = useRuns();

  // Toggle a single status filter from the summary cards, plus a free-text
  // search over orchestration names — together these keep a 100+ flat feed
  // navigable.
  const [statusFilter, setStatusFilter] = useState<RunStatus | null>(null);
  const [query, setQuery] = useState('');

  // Opening the page clears the sidebar badge (the seen-watermark). Snapshot
  // the previous boundary first so we can still highlight what's new on THIS
  // visit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seenBefore = useMemo(() => notifSeenAt, []);
  useEffect(() => {
    markNotificationsSeen();
  }, [markNotificationsSeen]);

  const acked = useMemo(() => new Set(ackedIds), [ackedIds]);

  const counts = useMemo(() => {
    const c = { done: 0, error: 0, interrupted: 0, cancelled: 0 };
    for (const n of notifications) {
      if (n.status === 'done') c.done++;
      else if (n.status === 'error') c.error++;
      else if (n.status === 'interrupted') c.interrupted++;
      else if (n.status === 'cancelled') c.cancelled++;
    }
    return c;
  }, [notifications]);

  // Unacknowledged error/interrupted outcomes — what the page badge counts
  // and what "Mark all seen" clears. (Timestamp-based attention is useless
  // on this page because mounting clears the watermark immediately.)
  const attentionIds = useMemo(
    () =>
      notifications
        .filter(n => needsAttention(n.status) && !acked.has(n.id))
        .map(n => n.id),
    [notifications, acked],
  );

  // Apply the active status filter + name search to the feed.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notifications.filter(n => {
      if (statusFilter && n.status !== statusFilter) return false;
      if (q && !(n.orchestrationName ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [notifications, statusFilter, query]);

  const isFiltering = statusFilter !== null || query.trim().length > 0;

  return (
    <Page
      title="Notifications"
      subtitle="run outcomes — succeeded, failed, interrupted — and recovery actions"
      badge={
        attentionIds.length > 0
          ? `${attentionIds.length} need attention`
          : undefined
      }>
      <View style={styles.summaryRow}>
        {FILTERABLE.map(status => (
          <SummaryStat
            key={status}
            label={STATUS_META[status].label}
            value={counts[status as 'done' | 'error' | 'interrupted' | 'cancelled']}
            color={STATUS_META[status].color}
            active={statusFilter === status}
            onPress={() =>
              setStatusFilter(curr => (curr === status ? null : status))
            }
          />
        ))}
      </View>

      <View style={styles.controls}>
        <View style={styles.searchWrap}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.search}
            placeholder="Search by orchestration name…"
            placeholderTextColor="#9ca3af"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} style={styles.clearSearch}>
              <Text style={styles.clearSearchText}>✕</Text>
            </Pressable>
          )}
        </View>
        {attentionIds.length > 0 && (
          <Pressable
            onPress={() => acknowledgeNotifications(attentionIds)}
            style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>
              ✓ Mark all seen ({attentionIds.length})
            </Text>
          </Pressable>
        )}
      </View>

      {isFiltering && (
        <View style={styles.filterBar}>
          <Text style={styles.filterText}>
            Showing {filtered.length} of {notifications.length}
            {statusFilter ? ` · ${STATUS_META[statusFilter].label}` : ''}
            {query.trim() ? ` · matching “${query.trim()}”` : ''}
          </Text>
          <Pressable
            onPress={() => {
              setStatusFilter(null);
              setQuery('');
            }}>
            <Text style={styles.filterClear}>Clear filters</Text>
          </Pressable>
        </View>
      )}

      {notifications.length === 0 && (
        <Card>
          <Hint>
            No run activity yet. Outcomes appear here the moment a run
            finishes, fails, or is interrupted — including runs that
            completed while this tab was closed.
          </Hint>
        </Card>
      )}

      {notifications.length > 0 && filtered.length === 0 && (
        <Card>
          <Hint>
            No outcomes match the current filter. Adjust your search or
            tap the active status card again to clear it.
          </Hint>
        </Card>
      )}

      {filtered.map(n => (
        <NotificationRow
          key={n.id}
          run={n}
          isNew={(n.endedAt ?? n.startedAt) > seenBefore && !acked.has(n.id)}
          dismissable={needsAttention(n.status) && !acked.has(n.id)}
          onDismiss={() => acknowledgeNotifications([n.id])}
          onResume={() => void resumeServerRunById(n.id)}
          onStop={() => void cancelRunById(n.id)}
          isCancelling={isCancelling(n.id)}
          onRerun={
            n.orchestrationSnapshot
              ? () => startServerRun(n.orchestrationSnapshot!, n.initialInput)
              : undefined
          }
          onView={
            onNavigate
              ? () => {
                  // Open Runs on THIS run, not whichever sorts first.
                  requestRun(n.id);
                  onNavigate('runs');
                }
              : undefined
          }
        />
      ))}
    </Page>
  );
}

function SummaryStat({
  label,
  value,
  color,
  active,
  onPress,
}: {
  label: string;
  value: number;
  color: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[
        styles.stat,
        active && styles.statActive,
        active && { borderColor: color },
      ]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, active && { color }]}>{label}</Text>
      {active && <View style={[styles.statUnderline, { backgroundColor: color }]} />}
    </Pressable>
  );
}

function NotificationRow({
  run,
  isNew,
  dismissable,
  onDismiss,
  onResume,
  onStop,
  isCancelling,
  onRerun,
  onView,
}: {
  run: Run;
  isNew: boolean;
  dismissable: boolean;
  onDismiss: () => void;
  onResume: () => void;
  onStop: () => void;
  /** A stop is in flight for this run — relabel + disable the Stop button. */
  isCancelling?: boolean;
  onRerun?: () => void;
  onView?: () => void;
}) {
  const meta = STATUS_META[run.status] ?? STATUS_META.done;
  const when = run.endedAt ?? run.startedAt;
  const dur =
    run.endedAt && run.startedAt
      ? `${Math.round((run.endedAt - run.startedAt) / 100) / 10}s`
      : null;
  const resumable = isResumable(run.status);
  return (
    <View
      style={[
        styles.row,
        { borderLeftColor: meta.border },
        isNew && styles.rowNew,
      ]}>
      <View style={styles.rowMain}>
        <View style={styles.rowHeader}>
          <View style={[styles.pill, { backgroundColor: meta.bg, borderColor: meta.border }]}>
            <Text style={[styles.pillText, { color: meta.color }]}>
              {meta.glyph} {meta.label}
            </Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {run.orchestrationName}
          </Text>
          {isNew && <View style={styles.newDot} />}
        </View>
        <Text style={styles.meta}>
          {timeAgo(when)}
          {dur ? ` · ${dur}` : ''}
          {run.status === 'interrupted'
            ? ' · checkpoint preserved — Resume picks up where it stopped'
            : ''}
        </Text>
      </View>
      <View style={styles.actions}>
        {resumable && (
          <Pressable onPress={onResume} style={[styles.btn, styles.btnPrimary]}>
            <Text style={styles.btnPrimaryText}>▶ Resume</Text>
          </Pressable>
        )}
        {resumable && (
          <Pressable
            onPress={onStop}
            disabled={isCancelling}
            style={[styles.btn, styles.btnGhost, isCancelling && styles.btnDisabled]}
            accessibilityState={{ disabled: !!isCancelling }}>
            <Text style={styles.btnGhostText}>
              {isCancelling ? 'Stopping…' : 'Stop'}
            </Text>
          </Pressable>
        )}
        {!resumable && onRerun && (
          <Pressable onPress={onRerun} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>↻ Re-run</Text>
          </Pressable>
        )}
        {onView && (
          <Pressable onPress={onView} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>View</Text>
          </Pressable>
        )}
        {dismissable && (
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notification"
            style={[styles.btn, styles.btnDismiss]}>
            <Text style={styles.btnDismissText}>✕</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingVertical: 12,
    alignItems: 'center',
    overflow: 'hidden',
  },
  statActive: {
    backgroundColor: '#f9fafb',
    borderWidth: 2,
  },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 2,
  },
  statUnderline: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 10,
  },
  searchIcon: { fontSize: 14, color: '#9ca3af', marginRight: 6 },
  search: {
    flex: 1,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
  },
  clearSearch: { padding: 4 },
  clearSearchText: { fontSize: 11, color: '#9ca3af', fontWeight: '700' },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  filterText: { fontSize: 11, color: '#6b7280' },
  filterClear: { fontSize: 11, color: '#2563eb', fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderLeftWidth: 4,
    padding: 12,
  },
  rowNew: { backgroundColor: '#fffdf7' },
  rowMain: { flex: 1, gap: 4 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 10, fontWeight: '700' },
  name: { flex: 1, fontSize: 13, fontWeight: '600', color: '#111827' },
  newDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f59e0b',
  },
  meta: { fontSize: 11, color: '#6b7280' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnPrimaryText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  btnGhost: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  btnGhostText: { color: '#374151', fontSize: 11, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  btnDismiss: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 8,
  },
  btnDismissText: { color: '#9ca3af', fontSize: 11, fontWeight: '700' },
});
