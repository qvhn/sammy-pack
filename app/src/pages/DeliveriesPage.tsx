import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, Hint, Page, SectionTitle } from './Page';

/**
 * Deliveries — the durable trigger-ingress queue + dead-letter view (P5).
 * Every trigger fire (webhook / cron / events / deployment / polling /
 * queue) lands here as a delivery: pending → claimed → fired, or
 * rejected / failed (dead-letter). Failed + rejected deliveries can be
 * replayed. Reads GET /api/deliveries[/stats]; replays via
 * POST /api/deliveries/:id/replay.
 */

type Delivery = {
  id: string;
  kind: string;
  name: string;
  orchestrationName: string;
  status: string;
  runId: string | null;
  detail: string | null;
  lastError: string | null;
  ownerId: string;
  receivedAt: number;
  attempts: number;
  chainDepth: number;
};

type Stats = {
  total: number;
  byStatus: Record<string, number>;
  queueDepth: number; // pending backlog (what the 429 cap sheds on)
  inFlight: number; // claimed, being processed now
  deadLetter: number;
  firesLastMin: number;
  firesLastHour: number;
};

const STATUS_FILTERS = [
  'all',
  'pending',
  'claimed',
  'fired',
  'failed',
  'rejected',
  'deferred',
  'duplicate',
] as const;

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  pending: { bg: '#fef9c3', fg: '#854d0e' },
  claimed: { bg: '#e0f2fe', fg: '#075985' },
  fired: { bg: '#dcfce7', fg: '#166534' },
  // Parked behind a busy group and WILL run — informational, not a failure,
  // so it must not share the dead-letter palette.
  deferred: { bg: '#ede9fe', fg: '#5b21b6' },
  failed: { bg: '#fee2e2', fg: '#991b1b' },
  rejected: { bg: '#fae8ff', fg: '#86198f' },
  duplicate: { bg: '#f3f4f6', fg: '#4b5563' },
  accepted: { bg: '#f3f4f6', fg: '#4b5563' },
};

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The line shown under a delivery row: WHY it ended where it did. The
 *  failure (`lastError`, e.g. "concurrency: group busy, fire skipped by
 *  policy") leads; the intake `detail` (scrub / pause notes) follows. */
export function deliveryReason(d: {
  lastError: string | null;
  detail: string | null;
}): { error: string | null; detail: string | null } {
  return { error: d.lastError || null, detail: d.detail || null };
}

/** Empty-state copy: an empty FILTER is not an empty queue. */
export function deliveriesEmptyText(filter: string, total: number | undefined): string {
  if (filter !== 'all' && (total ?? 0) > 0) return 'No deliveries match this filter.';
  return 'No deliveries yet. Fire a trigger (webhook / events / cron / …) and it lands here.';
}

export function DeliveriesPage({
  onOpenRun,
}: {
  /** Open a run on the Runs page. When absent, run ids show as plain text. */
  onOpenRun?: (runId: string) => void;
} = {}) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const q = filter === 'all' ? '' : `?status=${filter}`;
      const [listRes, statsRes] = await Promise.all([
        fetch(`/api/deliveries${q}`),
        fetch('/api/deliveries/stats'),
      ]);
      if (!listRes.ok) throw new Error(`GET /api/deliveries → ${listRes.status}`);
      setRows((await listRes.json()) as Delivery[]);
      if (statsRes.ok) setStats((await statsRes.json()) as Stats);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
    // Light auto-refresh so the queue draining is visible live.
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function replay(id: string) {
    setReplaying(id);
    try {
      const res = await fetch(`/api/deliveries/${encodeURIComponent(id)}/replay`, {
        method: 'POST',
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`replay → ${res.status}: ${t}`);
      }
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReplaying(null);
    }
  }

  return (
    <Page
      title="Deliveries"
      subtitle="The durable trigger-ingress queue. Every fire is recorded before its run is created, deduplicated by idempotency key, retried with backoff, and dead-lettered on exhaustion — replayable here.">
      <View style={styles.tiles}>
        <Tile label="Total" value={stats?.total ?? '—'} />
        <Tile label="Queue depth" value={stats?.queueDepth ?? '—'} tone="amber" />
        <Tile label="Dead-letter" value={stats?.deadLetter ?? '—'} tone="red" />
        <Tile label="Fired / min" value={stats?.firesLastMin ?? '—'} tone="green" />
      </View>

      <SectionTitle>Recent deliveries</SectionTitle>
      <Card
        right={
          <Pressable onPress={refresh} style={styles.button}>
            <Text style={styles.buttonText}>{loading ? 'Loading…' : 'Refresh'}</Text>
          </Pressable>
        }>
        <View style={styles.filters}>
          {STATUS_FILTERS.map(f => {
            const active = f === filter;
            const n = f === 'all' ? stats?.total : stats?.byStatus?.[f];
            return (
              <Pressable
                key={f}
                onPress={() => setFilter(f)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.filterChip, active && styles.filterChipActive]}>
                <Text
                  style={[styles.filterText, active && styles.filterTextActive]}>
                  {f}
                  {n != null ? ` ${n}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {err && <Text style={styles.error}>{err}</Text>}
        {rows.length === 0 && !err && (
          <Hint>{deliveriesEmptyText(filter, stats?.total)}</Hint>
        )}
        {rows.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
              <View style={[styles.row, styles.headerRow]}>
                <Text style={[styles.cell, styles.h, styles.cStatus]}>Status</Text>
                <Text style={[styles.cell, styles.h, styles.cKind]}>Kind</Text>
                <Text style={[styles.cell, styles.h, styles.cName]}>Name</Text>
                <Text style={[styles.cell, styles.h, styles.cOrch]}>Orchestration</Text>
                <Text style={[styles.cell, styles.h, styles.cNum]}>Tries</Text>
                <Text style={[styles.cell, styles.h, styles.cWhen]}>When</Text>
                <Text style={[styles.cell, styles.h, styles.cRun]}>Run</Text>
                <Text style={[styles.cell, styles.h, styles.cAct]}> </Text>
              </View>
              {rows.map(d => {
                const c = STATUS_COLOR[d.status] ?? STATUS_COLOR.duplicate;
                const replayable = d.status === 'failed' || d.status === 'rejected';
                const reason = deliveryReason(d);
                const runId = d.runId;
                return (
                  <View key={d.id} style={styles.rowWrap}>
                    <View style={styles.row}>
                      <View style={[styles.cell, styles.cStatus]}>
                        <Text style={[styles.badge, { backgroundColor: c.bg, color: c.fg }]}>
                          {d.status}
                        </Text>
                      </View>
                      <Text style={[styles.cell, styles.mono, styles.cKind]}>{d.kind}</Text>
                      <Text style={[styles.cell, styles.code, styles.cName]} numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text style={[styles.cell, styles.cOrch]} numberOfLines={1}>
                        {d.orchestrationName}
                      </Text>
                      <Text style={[styles.cell, styles.mono, styles.cNum]}>{d.attempts}</Text>
                      <Text style={[styles.cell, styles.cWhen]}>{ago(d.receivedAt)}</Text>
                      <View style={[styles.cell, styles.cRun]}>
                        {runId && onOpenRun ? (
                          <Pressable
                            onPress={() => onOpenRun(runId)}
                            accessibilityRole="link"
                            accessibilityLabel={`Open run ${runId}`}>
                            <Text style={styles.runLink} numberOfLines={1}>
                              View run →
                            </Text>
                          </Pressable>
                        ) : runId ? (
                          <Text style={styles.mono} numberOfLines={1}>
                            {runId}
                          </Text>
                        ) : (
                          <Text style={styles.noRun}>—</Text>
                        )}
                      </View>
                      <View style={[styles.cell, styles.cAct]}>
                        {replayable && (
                          <Pressable
                            onPress={() => replay(d.id)}
                            disabled={replaying === d.id}
                            accessibilityRole="button"
                            accessibilityLabel={`Replay delivery ${d.id}`}
                            style={styles.replayBtn}>
                            <Text style={styles.replayText}>
                              {replaying === d.id ? '…' : 'Replay'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                    {(reason.error || reason.detail) && (
                      <View style={styles.reason}>
                        {reason.error && (
                          <Text style={styles.reasonError} selectable>
                            {reason.error}
                          </Text>
                        )}
                        {reason.detail && (
                          <Text style={styles.reasonDetail} selectable>
                            {reason.detail}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </Card>
      <Hint>
        Failed deliveries are the dead-letter queue — they exhausted their
        retries. Replay resets attempts and re-enqueues. A delivery&apos;s error
        (and any intake note) shows under its row.
      </Hint>
    </Page>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'amber' | 'red' | 'green';
}) {
  const toneStyle =
    tone === 'amber'
      ? styles.tileAmber
      : tone === 'red'
        ? styles.tileRed
        : tone === 'green'
          ? styles.tileGreen
          : undefined;
  return (
    <View style={[styles.tile, toneStyle]}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  tile: {
    minWidth: 120,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  tileAmber: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  tileRed: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  tileGreen: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  tileValue: { fontSize: 22, fontWeight: '700', color: '#111827' },
  tileLabel: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  filters: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  filterChip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  filterChipActive: { borderColor: '#111827', backgroundColor: '#111827' },
  filterText: { fontSize: 12, color: '#374151', fontWeight: '600' },
  filterTextActive: { color: '#ffffff' },
  table: { gap: 2, minWidth: 820 },
  rowWrap: { borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 4 },
  reason: { paddingHorizontal: 8, paddingBottom: 6, paddingLeft: 98, gap: 2 },
  reasonError: { fontSize: 12, color: '#b91c1c', fontFamily: 'monospace' },
  reasonDetail: { fontSize: 11, color: '#6b7280' },
  cRun: { width: 100 },
  runLink: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  noRun: { fontSize: 12, color: '#d1d5db' },
  headerRow: { backgroundColor: '#f3f4f6' },
  cell: { fontSize: 13, color: '#374151', paddingRight: 8 },
  h: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  cStatus: { width: 90 },
  cKind: { width: 90 },
  cName: { width: 200 },
  cOrch: { width: 160 },
  cNum: { width: 50 },
  cWhen: { width: 80 },
  cAct: { width: 80 },
  badge: {
    fontSize: 11,
    fontWeight: '700',
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    overflow: 'hidden',
  },
  code: { fontFamily: 'monospace', fontSize: 12, color: '#111827' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  replayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fca5a5',
    backgroundColor: '#fee2e2',
  },
  replayText: { color: '#b91c1c', fontWeight: '700', fontSize: 12 },
  error: { color: '#dc2626', fontSize: 12, marginBottom: 8 },
});
