import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  getObservability,
  listOrchestrations,
  type ObservabilityDigest,
} from '../api';
import type { Node } from '../types';
import { Card, Hint, Page, SectionTitle } from './Page';

/** A switch/route node found in an orchestration, with the branch keys it
 *  declares (cases/branches + `default` when present). */
type BranchNode = {
  orchestration: string;
  phaseName: string;
  kind: 'switch' | 'route';
  declared: string[];
};

/** Walk a node tree collecting every switch/route node + its declared
 *  branch keys, recursing through all composite children (incl. nested
 *  switch cases / route branches and onError). */
function collectBranchNodes(node: Node, orch: string, out: BranchNode[]): void {
  if (node.switch) {
    out.push({
      orchestration: orch,
      phaseName: node.name,
      kind: 'switch',
      declared: [
        ...Object.keys(node.switch.cases),
        ...(node.switch.default ? ['default'] : []),
      ],
    });
    for (const b of Object.values(node.switch.cases)) collectBranchNodes(b, orch, out);
    if (node.switch.default) collectBranchNodes(node.switch.default, orch, out);
  }
  if (node.route) {
    out.push({
      orchestration: orch,
      phaseName: node.name,
      kind: 'route',
      declared: [
        ...Object.keys(node.route.branches),
        ...(node.route.default ? ['default'] : []),
      ],
    });
    for (const b of Object.values(node.route.branches)) collectBranchNodes(b, orch, out);
    if (node.route.default) collectBranchNodes(node.route.default, orch, out);
  }
  for (const child of node.phases ?? []) collectBranchNodes(child, orch, out);
  for (const child of node.parallel ?? []) collectBranchNodes(child, orch, out);
  for (const child of node.converge ?? []) collectBranchNodes(child, orch, out);
  if (node.loop?.body) collectBranchNodes(node.loop.body, orch, out);
  if (node.map?.body) collectBranchNodes(node.map.body, orch, out);
  if (node.onError) collectBranchNodes(node.onError, orch, out);
}

/** Success rate over FINISHED runs only: done / (done + error). Running and
 *  paused runs haven't succeeded or failed yet, and a cancel is the user's
 *  call rather than a failure — counting either as a miss made a healthy
 *  history read "50%" with zero errors. `rate` is null when nothing has
 *  finished yet; `inFlight` is everything not done/error/cancelled. */
export function finishedSuccessRate(t: {
  runs: number;
  done: number;
  error: number;
  cancelled: number;
}): { rate: number | null; finished: number; inFlight: number } {
  const finished = t.done + t.error;
  return {
    rate: finished > 0 ? t.done / finished : null,
    finished,
    inFlight: Math.max(0, t.runs - t.done - t.error - t.cancelled),
  };
}

/** Observability — aggregate analytics across every persisted run.
 *  Inspired by LangSmith / Honeycomb: focus on numbers that drive
 *  action (success rate, cost, latency trend) rather than per-run
 *  drill-down (that's what the Runs page is for).
 *
 *  Pure View-based bars and tables — no chart library dependency.
 *  When the run store grows past file-IO comfort, swap the server-side
 *  aggregator for a SQL query against the runs table. */
export function ObservabilityPage() {
  const [digest, setDigest] = useState<ObservabilityDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orchestrations, setOrchestrations] = useState<Node[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Orchestration definitions tell us which branches are DECLARED, so we
    // can flag the ones the digest shows were never taken.
    listOrchestrations()
      .then(list => {
        if (!cancelled) setOrchestrations(list);
      })
      .catch(() => {
        /* non-fatal — coverage section just won't render */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // All switch/route nodes across every orchestration, joined to their
  // actually-taken branch counts from the digest. Declared branches with a
  // zero count are dead (never taken).
  const branchCoverage = useMemo(() => {
    if (!digest) return [];
    const nodes: BranchNode[] = [];
    for (const o of orchestrations) collectBranchNodes(o, o.name, nodes);
    const byKey = new Map(
      (digest.branchCoverage ?? []).map(bc => [
        `${bc.orchestration}::${bc.phaseName}`,
        bc.taken,
      ]),
    );
    return nodes.map(n => {
      const taken = byKey.get(`${n.orchestration}::${n.phaseName}`) ?? [];
      const countOf = (b: string) =>
        taken.find(t => t.branch === b)?.count ?? 0;
      const branches = n.declared.map(b => ({ branch: b, count: countOf(b) }));
      const undeclaredTaken = taken.filter(
        t => !n.declared.includes(t.branch),
      );
      const totalTaken = taken.reduce((s, t) => s + t.count, 0);
      return { ...n, branches, undeclaredTaken, totalTaken };
    });
  }, [digest, orchestrations]);

  // Group by orchestration, only those that actually have switch/route nodes.
  const coverageByOrch = useMemo(() => {
    const map = new Map<string, typeof branchCoverage>();
    for (const n of branchCoverage) {
      const arr = map.get(n.orchestration) ?? [];
      arr.push(n);
      map.set(n.orchestration, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [branchCoverage]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await getObservability();
        if (!cancelled) {
          setDigest(d);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh() {
    setLoading(true);
    getObservability()
      .then(d => {
        setDigest(d);
        setError(null);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  const success = useMemo(
    () =>
      digest
        ? finishedSuccessRate(digest.totals)
        : { rate: null, finished: 0, inFlight: 0 },
    [digest],
  );
  const successRate = success.rate;

  // Sliding window for the activity chart — last 30 calendar days.
  const last30Days = useMemo(() => {
    if (!digest) return [];
    const map = new Map(digest.daily.map(d => [d.day, d]));
    const out: ObservabilityDigest['daily'] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push(
        map.get(key) ?? { day: key, runCount: 0, doneCount: 0, errorCount: 0, costUsd: 0 },
      );
    }
    return out;
  }, [digest]);

  const maxDailyRuns = useMemo(
    () => Math.max(1, ...last30Days.map(d => d.runCount)),
    [last30Days],
  );

  return (
    <Page
      title="Observability"
      subtitle="aggregate analytics across every persisted run"
      badge={loading ? 'loading' : undefined}>
      <View style={styles.actionsRow}>
        <Pressable onPress={refresh} style={styles.refreshBtn}>
          <Text style={styles.refreshBtnText}>↻ Refresh</Text>
        </Pressable>
      </View>

      {error ? (
        <Card>
          <Text style={styles.errorText}>Error: {error}</Text>
        </Card>
      ) : null}

      {digest && (
        <>
          <SectionTitle>Totals</SectionTitle>
          <View style={styles.statsRow}>
            <StatTile label="Total runs" value={fmtInt(digest.totals.runs)} />
            <StatTile
              label="Success rate (finished)"
              value={successRate === null ? '—' : `${Math.round(successRate * 100)}%`}
              tone={
                successRate === null
                  ? undefined
                  : successRate >= 0.9
                    ? 'good'
                    : successRate >= 0.7
                      ? 'warn'
                      : 'err'
              }
            />
            <StatTile
              label="In flight / paused"
              value={fmtInt(success.inFlight)}
            />
            <StatTile
              label="Errors"
              value={fmtInt(digest.totals.error)}
              tone={digest.totals.error === 0 ? 'good' : 'err'}
            />
            <StatTile label="Cancelled" value={fmtInt(digest.totals.cancelled)} />
            <StatTile label="Total cost" value={`$${digest.totals.costUsd.toFixed(4)}`} />
            <StatTile
              label="Tokens (in / out)"
              value={`${fmtInt(digest.totals.inputTokens)} / ${fmtInt(digest.totals.outputTokens)}`}
            />
          </View>

          <SectionTitle>Activity (last 30 days)</SectionTitle>
          <Card>
            {digest.totals.runs === 0 ? (
              <Hint>
                No runs yet. Open a pipeline and click ▶ Run — once it completes, it'll
                show up here.
              </Hint>
            ) : (
              <View>
                <View style={styles.chartRow}>
                  {last30Days.map(d => {
                    const total = d.runCount;
                    const done = d.doneCount;
                    const err = d.errorCount;
                    const ratio = total / maxDailyRuns;
                    const okRatio = total > 0 ? done / total : 0;
                    const errRatio = total > 0 ? err / total : 0;
                    return (
                      <View key={d.day} style={styles.chartCol}>
                        <View style={styles.chartBar}>
                          {total > 0 && (
                            <>
                              <View
                                style={[
                                  styles.barOk,
                                  {
                                    height: `${ratio * okRatio * 100}%`,
                                  },
                                ]}
                              />
                              <View
                                style={[
                                  styles.barErr,
                                  {
                                    height: `${ratio * errRatio * 100}%`,
                                  },
                                ]}
                              />
                            </>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
                <View style={styles.chartLegend}>
                  <Text style={styles.chartLegendText}>
                    {last30Days[0].day} →{' '}
                    {last30Days[last30Days.length - 1].day} · max {maxDailyRuns}/day
                  </Text>
                  <View style={styles.legendKeys}>
                    <View style={styles.legendKey}>
                      <View style={[styles.legendDot, { backgroundColor: '#059669' }]} />
                      <Text style={styles.legendText}>success</Text>
                    </View>
                    <View style={styles.legendKey}>
                      <View style={[styles.legendDot, { backgroundColor: '#dc2626' }]} />
                      <Text style={styles.legendText}>error</Text>
                    </View>
                  </View>
                </View>
              </View>
            )}
          </Card>

          <SectionTitle>By orchestration</SectionTitle>
          {digest.perOrchestration.length === 0 ? (
            <Hint>No persisted runs yet.</Hint>
          ) : (
            digest.perOrchestration.map(o => (
              <Card key={o.name}>
                <View style={styles.orchHeader}>
                  <Text style={styles.orchName}>{o.name}</Text>
                  <Text style={styles.orchMeta}>
                    last ran {fmtRel(o.lastRanAt)}
                  </Text>
                </View>
                <View style={styles.orchStatsRow}>
                  <MiniStat label="runs" value={fmtInt(o.runCount)} />
                  <MiniStat
                    label="success"
                    value={(() => {
                      const r = finishedSuccessRate({
                        runs: o.runCount,
                        done: o.doneCount,
                        error: o.errorCount,
                        cancelled: o.cancelledCount,
                      }).rate;
                      return r === null ? '—' : `${Math.round(r * 100)}%`;
                    })()}
                    tone={o.errorCount === 0 ? 'good' : 'warn'}
                  />
                  <MiniStat label="errors" value={fmtInt(o.errorCount)} />
                  <MiniStat label="avg dur" value={`${(o.avgDurationMs / 1000).toFixed(1)}s`} />
                  <MiniStat label="in tok" value={fmtInt(o.inputTokens)} />
                  <MiniStat label="out tok" value={fmtInt(o.outputTokens)} />
                  <MiniStat label="cost" value={`$${o.costUsd.toFixed(4)}`} />
                </View>
              </Card>
            ))
          )}

          <SectionTitle>Hottest phases (by total cost)</SectionTitle>
          {(digest.perPhase ?? []).length === 0 ? (
            <Hint>No phase-end events yet.</Hint>
          ) : (
            <Card>
              <View style={styles.phaseTableHeader}>
                <Text style={[styles.phaseColPhase, styles.phaseHeaderText]}>
                  orchestration · phase
                </Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>runs</Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>err</Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>avg</Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>p95</Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>tok in/out</Text>
                <Text style={[styles.phaseColNum, styles.phaseHeaderText]}>cost</Text>
              </View>
              {(digest.perPhase ?? []).slice(0, 30).map((p, i) => {
                const errRate =
                  p.runs + p.errors > 0
                    ? p.errors / (p.runs + p.errors)
                    : 0;
                return (
                  <View key={`${p.orchestration}::${p.phaseName}::${i}`} style={styles.phaseRow}>
                    <Text style={styles.phaseColPhase} numberOfLines={1}>
                      <Text style={styles.phaseOrchTag}>{p.orchestration}</Text> ·{' '}
                      <Text style={styles.phaseNameTag}>{p.phaseName}</Text>
                    </Text>
                    <Text style={styles.phaseColNum}>{p.runs}</Text>
                    <Text
                      style={[
                        styles.phaseColNum,
                        p.errors > 0 && { color: '#dc2626', fontWeight: '700' },
                      ]}>
                      {p.errors}
                      {errRate > 0 ? ` (${Math.round(errRate * 100)}%)` : ''}
                    </Text>
                    <Text style={styles.phaseColNum}>
                      {(p.avgDurationMs / 1000).toFixed(1)}s
                    </Text>
                    <Text style={styles.phaseColNum}>
                      {(p.p95DurationMs / 1000).toFixed(1)}s
                    </Text>
                    <Text style={styles.phaseColNum}>
                      {fmtInt(p.inputTokens)}/{fmtInt(p.outputTokens)}
                    </Text>
                    <Text style={[styles.phaseColNum, p.costUsd > 0 && { color: '#059669' }]}>
                      ${p.costUsd.toFixed(4)}
                    </Text>
                  </View>
                );
              })}
              {(digest.perPhase ?? []).length > 30 && (
                <Hint>… {(digest.perPhase ?? []).length - 30} more phases</Hint>
              )}
            </Card>
          )}

          <SectionTitle>Recent runs</SectionTitle>
          {digest.recent.length === 0 ? (
            <Hint>No persisted runs yet.</Hint>
          ) : (
            <Card>
              <View style={styles.recentList}>
                {digest.recent.map(r => (
                  <View key={r.id} style={styles.recentRow}>
                    <View style={[styles.recentDot, statusDotStyle(r.status)]} />
                    <Text style={styles.recentName} numberOfLines={1}>
                      {r.orchestrationName}
                    </Text>
                    <Text style={styles.recentMeta}>
                      {fmtRel(r.startedAt)}
                      {r.durationMs != null && ` · ${(r.durationMs / 1000).toFixed(1)}s`}
                    </Text>
                  </View>
                ))}
              </View>
              <Hint>
                Open the Runs tab for full traces (events, tools, agent text, cost
                breakdown).
              </Hint>
            </Card>
          )}

          {coverageByOrch.length > 0 && (
            <>
              <SectionTitle>Branch coverage</SectionTitle>
              <Hint>
                Which switch / route branches each pipeline has actually taken
                across its run history. A branch that's never been taken is
                flagged — it may be dead, unreachable, or simply untested.
              </Hint>
              {coverageByOrch.map(([orch, nodes]) => (
                <Card key={orch} title={orch}>
                  {nodes.map((n, i) => (
                    <View
                      key={`${n.orchestration}::${n.phaseName}::${i}`}
                      style={styles.coverageNode}>
                      <Text style={styles.coverageNodeName}>
                        {n.kind === 'switch' ? '⋔' : '⌥'} {n.phaseName}
                        <Text style={styles.coverageNodeMeta}>
                          {'  '}· {n.totalTaken} decision(s)
                        </Text>
                      </Text>
                      <View style={styles.coverageBranches}>
                        {n.branches.map(b => (
                          <View
                            key={b.branch}
                            style={[
                              styles.coverageChip,
                              b.count === 0 && styles.coverageChipDead,
                            ]}>
                            <Text
                              style={[
                                styles.coverageChipText,
                                b.count === 0 && styles.coverageChipDeadText,
                              ]}>
                              {b.branch} · {b.count}
                              {b.count === 0 ? ' — never taken' : ''}
                            </Text>
                          </View>
                        ))}
                        {n.undeclaredTaken.map(t => (
                          <View
                            key={t.branch}
                            style={[styles.coverageChip, styles.coverageChipOrphan]}>
                            <Text
                              style={[
                                styles.coverageChipText,
                                styles.coverageChipOrphanText,
                              ]}>
                              {t.branch} · {t.count} — not in current definition
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </Page>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'err';
}) {
  return (
    <View
      style={[
        styles.statTile,
        tone === 'good' && styles.statTileGood,
        tone === 'warn' && styles.statTileWarn,
        tone === 'err' && styles.statTileErr,
      ]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        style={[
          styles.statValue,
          tone === 'good' && { color: '#065f46' },
          tone === 'warn' && { color: '#92400e' },
          tone === 'err' && { color: '#b91c1c' },
        ]}>
        {value}
      </Text>
    </View>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'err';
}) {
  return (
    <View style={styles.miniStat}>
      <Text style={styles.miniLabel}>{label}</Text>
      <Text
        style={[
          styles.miniValue,
          tone === 'good' && { color: '#065f46' },
          tone === 'warn' && { color: '#92400e' },
          tone === 'err' && { color: '#b91c1c' },
        ]}>
        {value}
      </Text>
    </View>
  );
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtRel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function statusDotStyle(status: string) {
  if (status === 'done') return { backgroundColor: '#059669' };
  if (status === 'error') return { backgroundColor: '#dc2626' };
  if (status === 'cancelled') return { backgroundColor: '#9ca3af' };
  return { backgroundColor: '#2563eb' };
}

const styles = StyleSheet.create({
  actionsRow: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  refreshBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  refreshBtnText: { fontSize: 11, color: '#1d4ed8', fontWeight: '600' },
  errorText: { color: '#b91c1c', fontSize: 12 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statTile: {
    minWidth: 140,
    flex: 1,
    padding: 12,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 4,
  },
  statTileGood: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  statTileWarn: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  statTileErr: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statValue: { fontSize: 22, color: '#111827', fontWeight: '700' },
  chartRow: { flexDirection: 'row', height: 120, alignItems: 'flex-end', gap: 2 },
  chartCol: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  chartBar: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f3f4f6',
    borderRadius: 2,
    overflow: 'hidden',
    flexDirection: 'column',
    justifyContent: 'flex-end',
  },
  barOk: { width: '100%', backgroundColor: '#059669' },
  barErr: { width: '100%', backgroundColor: '#dc2626' },
  chartLegend: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chartLegendText: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
  legendKeys: { flexDirection: 'row', gap: 12 },
  legendKey: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: '#6b7280' },
  orchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  orchName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  orchMeta: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  orchStatsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  miniStat: { gap: 2 },
  miniLabel: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  miniValue: { fontSize: 14, color: '#111827', fontWeight: '600', fontFamily: 'Menlo' },
  recentList: { gap: 6 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  recentDot: { width: 8, height: 8, borderRadius: 4 },
  recentName: { fontSize: 12, color: '#111827', flex: 1 },
  recentMeta: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  coverageNode: {
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    gap: 6,
  },
  coverageNodeName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  coverageNodeMeta: { fontSize: 11, fontWeight: '400', color: '#9ca3af' },
  coverageBranches: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  coverageChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  coverageChipText: { fontSize: 11, color: '#047857', fontWeight: '600' },
  coverageChipDead: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  coverageChipDeadText: { color: '#b45309' },
  coverageChipOrphan: { backgroundColor: '#f9fafb', borderColor: '#e5e7eb' },
  coverageChipOrphanText: { color: '#6b7280', fontWeight: '500' },
  phaseTableHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 6,
  },
  phaseHeaderText: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  phaseRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'center',
    gap: 6,
  },
  phaseColPhase: { flex: 2.5, fontSize: 11, color: '#111827' },
  phaseColNum: {
    flex: 1,
    fontSize: 11,
    color: '#374151',
    fontFamily: 'Menlo',
    textAlign: 'right',
  },
  phaseOrchTag: { color: '#6b7280', fontFamily: 'Menlo', fontSize: 10 },
  phaseNameTag: { color: '#111827', fontWeight: '600' },
});
