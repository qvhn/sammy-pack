import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Hint, Page, SectionTitle } from './Page';
import {
  getAgentQueue,
  reorderAgentQueue,
  type AgentQueue,
  type QueuedAgent,
} from '../api';

/**
 * Queue view — operator visibility + control over the execution queue.
 *
 * sammy-pack caps how many leaf agent dispatches stream at once (the global
 * agent-concurrency pool; see Settings → Concurrency). When a wide
 * `parallel` / `map`, or many concurrent runs, push more dispatches than the
 * cap allows, the excess QUEUES (FIFO) at the leaf-dispatch chokepoint. The
 * Runs page shows what's *running*; this page shows what's *waiting* — across
 * every run — and lets you reprioritize it.
 *
 * What queues: individual agent dispatches (one per in-flight leaf), NOT
 * whole runs. A single run can therefore own several queued items at once
 * (e.g. a 10-wide map with a cap of 4 leaves 6 of its dispatches here).
 *
 * Reorder is safe at any time: slots are granted from the front of the queue,
 * so moving an item only changes which still-blocked dispatch is served next
 * — it never disturbs an in-flight agent.
 */

const POLL_MS = 1500;

function fmtWait(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function shortRunId(id: string | null): string {
  if (!id) return 'in-browser';
  // run-<epoch>-<rand> → show the trailing random suffix, which is the
  // human-distinguishable part.
  const parts = id.split('-');
  return parts.length >= 3 ? `…${parts.slice(2).join('-')}` : id;
}

export function QueuePage() {
  const [data, setData] = useState<AgentQueue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Avoid clobbering an in-flight reorder's optimistic result with a
  // poll that raced it.
  const mutating = useRef(false);

  const refresh = useCallback(async (showSpinner: boolean) => {
    if (mutating.current) return;
    if (showSpinner) setLoading(true);
    try {
      const q = await getAgentQueue();
      if (!mutating.current) setData(q);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh(true);
    const t = setInterval(() => refresh(false), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function move(item: QueuedAgent, dir: 'up' | 'down') {
    mutating.current = true;
    setBusyId(item.id);
    setErr(null);
    try {
      const updated = await reorderAgentQueue({ id: item.id, dir });
      setData(updated);
    } catch (e) {
      setErr((e as Error).message);
      // Re-pull truth — the item may have started (409) or another race.
      mutating.current = false;
      await refresh(false);
    } finally {
      mutating.current = false;
      setBusyId(null);
    }
  }

  const queued = data?.queued ?? [];

  return (
    <Page
      title="Queue"
      subtitle="Agent dispatches waiting on the global concurrency cap, in the order they'll run. Reorder to reprioritize — running agents are never interrupted.">
      <Card
        title="Concurrency pool"
        subtitle="The cap that gates this queue. Adjust it in Settings → Concurrency."
        right={
          <Pressable onPress={() => refresh(true)} style={styles.button}>
            <Text style={styles.buttonText}>
              {loading ? 'Loading…' : 'Refresh'}
            </Text>
          </Pressable>
        }>
        {err ? <Text style={styles.error}>{err}</Text> : null}
        {data && (
          <View style={styles.statsRow}>
            <Stat label="Running" value={`${data.inUse}/${data.limit}`} />
            <Stat label="Queued" value={String(data.waiting)} />
            <Stat
              label="Cap"
              value={String(data.limit)}
              hint="max concurrent"
            />
          </View>
        )}
      </Card>

      <SectionTitle>Waiting ({queued.length})</SectionTitle>
      <Card>
        {queued.length === 0 ? (
          <Hint>
            Nothing queued. Dispatches only wait here when the number of
            in-flight agents reaches the concurrency cap ({data?.limit ?? '—'}).
            A wide `parallel` / `map` or several runs at once will fill it.
          </Hint>
        ) : (
          <View style={styles.table}>
            <View style={[styles.row, styles.headerRow]}>
              <Text style={[styles.cell, styles.h, { width: 40 }]}>#</Text>
              <Text style={[styles.cell, styles.h, { flex: 3 }]}>Phase</Text>
              <Text style={[styles.cell, styles.h, { flex: 3 }]}>
                Run / orchestration
              </Text>
              <Text style={[styles.cell, styles.h, { flex: 2 }]}>Waiting</Text>
              <Text style={[styles.cell, styles.h, { flex: 2 }]}>Gated by</Text>
              <Text style={[styles.cell, styles.h, { width: 84 }]}>Order</Text>
            </View>
            {queued.map((item, idx) => {
              const isBusy = busyId === item.id;
              return (
                <View
                  key={item.id}
                  style={[styles.row, idx === 0 && styles.nextRow]}
                  accessibilityLabel={`queued agent ${item.phaseName ?? item.id}`}>
                  <Text style={[styles.cell, styles.pos, { width: 40 }]}>
                    {item.position + 1}
                  </Text>
                  <Text style={[styles.cell, styles.code, { flex: 3 }]}>
                    {item.phaseName ?? '(unnamed phase)'}
                  </Text>
                  <View style={[styles.cell, { flex: 3, gap: 1 }]}>
                    <Text style={styles.runName}>
                      {item.orchestrationName ?? '(unknown)'}
                    </Text>
                    <Text style={styles.runId}>{shortRunId(item.runId)}</Text>
                  </View>
                  <Text style={[styles.cell, { flex: 2 }]}>
                    {fmtWait(item.waitedMs)}
                  </Text>
                  <Text style={[styles.cell, styles.gated, { flex: 2 }]}>
                    concurrency cap
                  </Text>
                  <View
                    style={[
                      styles.cell,
                      { width: 84, flexDirection: 'row', gap: 4 },
                    ]}>
                    <Pressable
                      onPress={() => move(item, 'up')}
                      disabled={idx === 0 || isBusy}
                      accessibilityRole="button"
                      accessibilityLabel="move up"
                      style={[
                        styles.arrow,
                        (idx === 0 || isBusy) && styles.arrowDisabled,
                      ]}>
                      <Text style={styles.arrowText}>↑</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => move(item, 'down')}
                      disabled={idx === queued.length - 1 || isBusy}
                      accessibilityRole="button"
                      accessibilityLabel="move down"
                      style={[
                        styles.arrow,
                        (idx === queued.length - 1 || isBusy) &&
                          styles.arrowDisabled,
                      ]}>
                      <Text style={styles.arrowText}>↓</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </Card>
      {queued.length > 0 && (
        <Hint>
          Position 1 gets the next free slot. Reordering only affects items
          still waiting — agents already running keep their slots until they
          finish.
        </Hint>
      )}
    </Page>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  statsRow: { flexDirection: 'row', gap: 24, paddingTop: 4 },
  stat: { gap: 1 },
  statValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  statLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  statHint: { fontSize: 10, color: '#9ca3af' },
  table: { gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  headerRow: { backgroundColor: '#f3f4f6' },
  nextRow: { backgroundColor: '#ecfdf5' },
  cell: { flex: 1, fontSize: 13, color: '#374151' },
  h: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  pos: { fontWeight: '700', color: '#111827', fontSize: 13 },
  code: { fontFamily: 'monospace', fontSize: 12, color: '#111827' },
  runName: { fontSize: 12, color: '#374151', fontWeight: '600' },
  runId: { fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' },
  gated: { fontSize: 11, color: '#92400e' },
  arrow: {
    width: 28,
    height: 24,
    borderRadius: 4,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowDisabled: { backgroundColor: '#d1d5db' },
  arrowText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  error: { color: '#dc2626', fontSize: 12 },
});
