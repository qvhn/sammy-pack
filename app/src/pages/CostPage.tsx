import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getCostDigest, type CostDigest } from '../api';
import { Card, Hint, Page, SectionTitle } from './Page';

/** Selectable spend window for the token totals + per-run table. */
type Window = '7d' | '30d' | 'all';
const WINDOWS: Array<{ id: Window; label: string; days: number | null }> = [
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All time', days: null },
];

/** Sort key for the per-run table. Most-expensive-first is the useful
 *  default — it surfaces runaway spend at the top. */
type SortKey = 'cost' | 'inputTokens' | 'outputTokens';

/**
 * Token & Cost dashboard — where the tokens went, and which agents
 * burned them. Read-only: every number is derived server-side from the
 * same phase-end events + costSummary() the rest of the app uses (see
 * GET /api/cost). The circuit-breaker callout surfaces the runaway-agent
 * trips the sdk-stream emits when it aborts an agent over its token
 * ceiling — exactly the events worth catching.
 */
export function CostPage() {
  const [digest, setDigest] = useState<CostDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [window, setWindow] = useState<Window>('30d');
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  function load() {
    setLoading(true);
    getCostDigest()
      .then(d => {
        setDigest(d);
        setError(null);
      })
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    getCostDigest()
      .then(d => {
        if (!cancelled) setDigest(d);
      })
      .catch(err => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Runs inside the selected window, sorted. The server already sorts by
  // cost; re-sort client-side when the user picks a different key.
  const windowRuns = useMemo(() => {
    if (!digest) return [];
    const days = WINDOWS.find(w => w.id === window)?.days ?? null;
    const cutoff = days == null ? 0 : Date.now() - days * 86_400_000;
    const filtered = digest.perRun.filter(r => r.startedAt >= cutoff);
    const field =
      sortKey === 'cost'
        ? 'costUsd'
        : sortKey === 'inputTokens'
          ? 'inputTokens'
          : 'outputTokens';
    return [...filtered].sort((a, b) => b[field] - a[field]);
  }, [digest, window, sortKey]);

  // Token + cost totals across the windowed runs (the top-line "tokens
  // over a selectable window" requirement). Spend today/month is a
  // separate, store-bucketed number shown above.
  const windowTotals = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let trips = 0;
    for (const r of windowRuns) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      costUsd += r.costUsd;
      trips += r.ceilingTrips;
    }
    return { inputTokens, outputTokens, costUsd, trips, runs: windowRuns.length };
  }, [windowRuns]);

  // Daily spend buckets across the selected window — drives the
  // spend-over-time bar chart. For an explicit N-day window we plot every
  // calendar day (so quiet days read as gaps); for "all time" we plot only
  // the days that actually had runs, oldest → newest, capped so the bar
  // chart stays legible. Cost is bucketed by run start day. We reuse the
  // hand-rolled <View> bar approach from ObservabilityPage — no chart dep.
  const dailySpend = useMemo(() => {
    const days = WINDOWS.find(w => w.id === window)?.days ?? null;
    // Sum cost + tokens + run count per YYYY-MM-DD (local day).
    const byDay = new Map<string, { costUsd: number; tokens: number; runs: number }>();
    for (const r of windowRuns) {
      const key = dayKey(r.startedAt);
      const cur = byDay.get(key) ?? { costUsd: 0, tokens: 0, runs: 0 };
      cur.costUsd += r.costUsd;
      cur.tokens += r.inputTokens + r.outputTokens;
      cur.runs += 1;
      byDay.set(key, cur);
    }
    type Bucket = { day: string; costUsd: number; tokens: number; runs: number };
    let out: Bucket[];
    if (days != null) {
      // Dense: one column per calendar day in the window, oldest → newest.
      out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const key = localDayKey(d);
        const v = byDay.get(key);
        out.push({ day: key, costUsd: v?.costUsd ?? 0, tokens: v?.tokens ?? 0, runs: v?.runs ?? 0 });
      }
    } else {
      // All-time: only days with activity, oldest → newest, last 60 columns.
      out = Array.from(byDay.entries())
        .map(([day, v]) => ({ day, ...v }))
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(-60);
    }
    const maxCost = Math.max(0, ...out.map(b => b.costUsd));
    return { buckets: out, maxCost };
  }, [windowRuns, window]);

  // Top agents by spend across every windowed run. Today an agent's cost is
  // only reachable by expanding each run; this rolls per-phase rows up by
  // agentPath (the durable agent identity), falling back to the phase name
  // when a phase has no agentPath. Most-expensive agent first.
  const topAgents = useMemo(() => {
    if (!digest) return [];
    const byAgent = new Map<
      string,
      { agent: string; costUsd: number; inputTokens: number; outputTokens: number; runs: Set<string>; aborts: number }
    >();
    for (const r of windowRuns) {
      const phases = digest.perPhase[r.id] ?? [];
      for (const p of phases) {
        const agent = p.agentPath?.trim() || p.phaseName || '(unnamed)';
        const cur =
          byAgent.get(agent) ??
          { agent, costUsd: 0, inputTokens: 0, outputTokens: 0, runs: new Set<string>(), aborts: 0 };
        cur.costUsd += p.costUsd;
        cur.inputTokens += p.inputTokens;
        cur.outputTokens += p.outputTokens;
        cur.runs.add(r.id);
        if (p.aborted) cur.aborts += 1;
        byAgent.set(agent, cur);
      }
    }
    return Array.from(byAgent.values())
      .map(a => ({ ...a, runCount: a.runs.size }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }, [digest, windowRuns]);

  // Per-model / per-provider breakdown is intentionally absent: the
  // GET /api/cost digest doesn't carry model or provider on its per-run /
  // per-phase rows (the phase-end events have a `model` field server-side,
  // but it isn't projected into this payload). We surface a note instead of
  // a misleading empty table. `hasModelInfo` stays future-proof: if the
  // digest ever grows a `model` field we light the section up automatically.
  const hasModelInfo = useMemo(() => {
    if (!digest) return false;
    for (const rows of Object.values(digest.perPhase)) {
      for (const p of rows as Array<Record<string, unknown>>) {
        if (typeof p.model === 'string' && p.model) return true;
      }
    }
    return false;
  }, [digest]);

  const spendByModel = useMemo(() => {
    if (!digest || !hasModelInfo) return [];
    const byModel = new Map<
      string,
      { model: string; costUsd: number; inputTokens: number; outputTokens: number; runs: Set<string> }
    >();
    for (const r of windowRuns) {
      const phases = (digest.perPhase[r.id] ?? []) as Array<Record<string, unknown>>;
      for (const p of phases) {
        const provider = typeof p.provider === 'string' ? p.provider : '';
        const rawModel = typeof p.model === 'string' ? p.model : '(unknown)';
        const key = provider ? `${provider} · ${rawModel}` : rawModel;
        const cur =
          byModel.get(key) ??
          { model: key, costUsd: 0, inputTokens: 0, outputTokens: 0, runs: new Set<string>() };
        cur.costUsd += typeof p.costUsd === 'number' ? p.costUsd : 0;
        cur.inputTokens += typeof p.inputTokens === 'number' ? p.inputTokens : 0;
        cur.outputTokens += typeof p.outputTokens === 'number' ? p.outputTokens : 0;
        cur.runs.add(r.id);
        byModel.set(key, cur);
      }
    }
    return Array.from(byModel.values())
      .map(m => ({ ...m, runCount: m.runs.size }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }, [digest, windowRuns, hasModelInfo]);

  return (
    <Page
      title="Token & Cost"
      subtitle="where the tokens go, per run and per agent — and which agents ran away"
      badge={loading ? 'loading' : undefined}>
      <View style={styles.actionsRow}>
        <View style={styles.windowRow}>
          {WINDOWS.map(w => (
            <Pressable
              key={w.id}
              onPress={() => setWindow(w.id)}
              style={[styles.windowChip, window === w.id && styles.windowChipActive]}>
              <Text
                style={[
                  styles.windowChipText,
                  window === w.id && styles.windowChipTextActive,
                ]}>
                {w.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={load} style={styles.refreshBtn}>
          <Text style={styles.refreshBtnText}>↻ Refresh</Text>
        </Pressable>
      </View>

      {error && (
        <Card>
          <Text style={styles.errorText}>Error: {error}</Text>
        </Card>
      )}

      {digest && (
        <>
          <SectionTitle>Spend</SectionTitle>
          <View style={styles.statsRow}>
            <StatTile label="Today" value={`$${digest.spend.todayUsd.toFixed(4)}`} />
            <StatTile label="This month" value={`$${digest.spend.monthUsd.toFixed(4)}`} />
            <StatTile
              label={`Cost (${windowLabel(window)})`}
              value={`$${windowTotals.costUsd.toFixed(4)}`}
            />
            <StatTile
              label={`Tokens in / out (${windowLabel(window)})`}
              value={`${fmtInt(windowTotals.inputTokens)} / ${fmtInt(windowTotals.outputTokens)}`}
            />
            <StatTile label={`Runs (${windowLabel(window)})`} value={fmtInt(windowTotals.runs)} />
            <StatTile
              label="Ceiling trips"
              value={fmtInt(windowTotals.trips)}
              tone={windowTotals.trips === 0 ? 'good' : 'err'}
            />
          </View>

          {/* Spend over time — daily cost across the selected window. */}
          <SectionTitle>Spend over time ({windowLabel(window)})</SectionTitle>
          <Card>
            {windowRuns.length === 0 ? (
              <Hint>No runs in this window — nothing to chart.</Hint>
            ) : dailySpend.maxCost === 0 ? (
              <Hint>
                Runs in this window but $0 recorded cost (a model's price wasn't known), so
                there's nothing to chart.
              </Hint>
            ) : (
              <View>
                <View style={styles.chartRow}>
                  {dailySpend.buckets.map(b => {
                    const ratio = dailySpend.maxCost > 0 ? b.costUsd / dailySpend.maxCost : 0;
                    return (
                      <View key={b.day} style={styles.chartCol}>
                        <View style={styles.chartBar}>
                          {b.costUsd > 0 && (
                            <View style={[styles.barCost, { height: `${ratio * 100}%` }]} />
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
                <View style={styles.chartLegend}>
                  <Text style={styles.chartLegendText}>
                    {dailySpend.buckets[0]?.day} →{' '}
                    {dailySpend.buckets[dailySpend.buckets.length - 1]?.day} · peak $
                    {dailySpend.maxCost.toFixed(4)}/day
                  </Text>
                  <View style={styles.legendKey}>
                    <View style={[styles.legendDot, { backgroundColor: '#2563eb' }]} />
                    <Text style={styles.legendText}>daily cost</Text>
                  </View>
                </View>
              </View>
            )}
          </Card>

          {/* Spend by model / provider — only when the digest carries it
              (GET /api/cost rows don't project a per-phase model yet; the
              section appears automatically once they do). */}
          {hasModelInfo && <SectionTitle>Spend by model</SectionTitle>}
          {!hasModelInfo ? null : spendByModel.length === 0 ? (
            <Hint>No model-tagged phases in this window.</Hint>
          ) : (
            <Card>
              <View style={styles.aggHeader}>
                <Text style={[styles.aggColName, styles.headerText]}>model · provider</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>runs</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>in tok</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>out tok</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>cost</Text>
              </View>
              {spendByModel.map(m => (
                <View key={m.model} style={styles.aggRow}>
                  <Text style={styles.aggColName} numberOfLines={1}>
                    {m.model}
                  </Text>
                  <Text style={styles.aggColNum}>{fmtInt(m.runCount)}</Text>
                  <Text style={styles.aggColNum}>{fmtInt(m.inputTokens)}</Text>
                  <Text style={styles.aggColNum}>{fmtInt(m.outputTokens)}</Text>
                  <Text style={[styles.aggColNum, m.costUsd > 0 && styles.costPos]}>
                    ${m.costUsd.toFixed(4)}
                  </Text>
                </View>
              ))}
            </Card>
          )}

          {/* Top agents by spend — rolled up across every windowed run. */}
          <SectionTitle>Top agents by spend ({windowLabel(window)})</SectionTitle>
          {topAgents.length === 0 ? (
            <Hint>No per-agent phase data in this window.</Hint>
          ) : (
            <Card>
              <View style={styles.aggHeader}>
                <Text style={[styles.aggColName, styles.headerText]}>agent</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>runs</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>in tok</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>out tok</Text>
                <Text style={[styles.aggColNum, styles.headerText]}>cost</Text>
              </View>
              {topAgents.slice(0, 20).map(a => (
                <View key={a.agent} style={styles.aggRow}>
                  <View style={styles.aggColName}>
                    <Text style={styles.aggAgentName} numberOfLines={1}>
                      {a.agent}
                      {a.aborts > 0 && (
                        <Text style={styles.aggAbortTag}> · ⚠ {a.aborts}</Text>
                      )}
                    </Text>
                  </View>
                  <Text style={styles.aggColNum}>{fmtInt(a.runCount)}</Text>
                  <Text style={styles.aggColNum}>{fmtInt(a.inputTokens)}</Text>
                  <Text style={styles.aggColNum}>{fmtInt(a.outputTokens)}</Text>
                  <Text style={[styles.aggColNum, a.costUsd > 0 && styles.costPos]}>
                    ${a.costUsd.toFixed(4)}
                  </Text>
                </View>
              ))}
              {topAgents.length > 20 && (
                <Hint>… {topAgents.length - 20} more agents</Hint>
              )}
            </Card>
          )}

          {/* Circuit-breaker callout — the runaway-agent events. */}
          {digest.ceilingTrips.length > 0 && (
            <>
              <SectionTitle>Circuit-breaker trips</SectionTitle>
              <Card>
                <View style={styles.ceilingBanner}>
                  <Text style={styles.ceilingBannerText}>
                    ⚠ {digest.ceilingTrips.length} agent
                    {digest.ceilingTrips.length === 1 ? '' : 's'} hit the per-agent token
                    ceiling and {digest.ceilingTrips.length === 1 ? 'was' : 'were'} aborted
                    to stop runaway spend.
                  </Text>
                </View>
                {digest.ceilingTrips.map((t, i) => (
                  <Pressable
                    key={`${t.runId}::${t.phaseName}::${i}`}
                    onPress={() => setExpandedRun(t.runId)}
                    style={styles.ceilingRow}>
                    <Text style={styles.ceilingPhase} numberOfLines={1}>
                      <Text style={styles.ceilingOrchTag}>{t.orchestrationName}</Text> ·{' '}
                      <Text style={styles.ceilingPhaseTag}>{t.phaseName}</Text>
                    </Text>
                    <Text style={styles.ceilingApprox}>
                      {t.approxTokens != null ? `~${fmtInt(t.approxTokens)} tok` : 'aborted'}
                    </Text>
                  </Pressable>
                ))}
              </Card>
            </>
          )}

          <SectionTitle>Per run — most expensive first</SectionTitle>
          <View style={styles.sortRow}>
            <Text style={styles.sortLabel}>sort by</Text>
            {(
              [
                ['cost', 'cost'],
                ['inputTokens', 'input tok'],
                ['outputTokens', 'output tok'],
              ] as Array<[SortKey, string]>
            ).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setSortKey(k)}
                style={[styles.sortChip, sortKey === k && styles.sortChipActive]}>
                <Text
                  style={[styles.sortChipText, sortKey === k && styles.sortChipTextActive]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {windowRuns.length === 0 ? (
            <Hint>No runs in this window. Open a pipeline and click ▶ Run.</Hint>
          ) : (
            <Card>
              <View style={styles.tableHeader}>
                <Text style={[styles.colRun, styles.headerText]}>run</Text>
                <Text style={[styles.colNum, styles.headerText]}>in tok</Text>
                <Text style={[styles.colNum, styles.headerText]}>out tok</Text>
                <Text style={[styles.colNum, styles.headerText]}>cost</Text>
                {/* Text ignores the column's alignItems — right-align the
                    label itself so it doesn't butt up against "cost". */}
                <Text style={[styles.colFlagHeader, styles.headerText]}>breaker</Text>
              </View>
              {windowRuns.map(r => {
                const open = expandedRun === r.id;
                const phases = digest.perPhase[r.id] ?? [];
                return (
                  <View key={r.id}>
                    <Pressable
                      onPress={() => setExpandedRun(open ? null : r.id)}
                      style={styles.runRow}>
                      <View style={styles.colRun}>
                        <View style={styles.runNameRow}>
                          <View style={[styles.statusDot, statusDotStyle(r.status)]} />
                          <Text style={styles.runName} numberOfLines={1}>
                            {r.orchestrationName}
                          </Text>
                          <Text style={styles.runCaret}>{open ? '▾' : '▸'}</Text>
                        </View>
                        <Text style={styles.runMeta} numberOfLines={1}>
                          {fmtRel(r.startedAt)} · {r.status}
                        </Text>
                      </View>
                      <Text style={styles.colNum}>{fmtInt(r.inputTokens)}</Text>
                      <Text style={styles.colNum}>{fmtInt(r.outputTokens)}</Text>
                      <Text style={[styles.colNum, r.costUsd > 0 && styles.costPos]}>
                        ${r.costUsd.toFixed(4)}
                      </Text>
                      <View style={styles.colFlag}>
                        {r.ceilingTrips > 0 ? (
                          <View style={styles.breakerChip}>
                            <Text style={styles.breakerChipText}>⚠ {r.ceilingTrips}</Text>
                          </View>
                        ) : (
                          <Text style={styles.breakerNone}>—</Text>
                        )}
                      </View>
                    </Pressable>

                    {open && (
                      <View style={styles.phasePanel}>
                        {phases.length === 0 ? (
                          <Hint>No phase-end events for this run.</Hint>
                        ) : (
                          <ScrollView style={styles.phaseScroll} nestedScrollEnabled>
                            <View style={styles.phaseHeader}>
                              <Text style={[styles.phaseColName, styles.headerText]}>
                                agent · phase
                              </Text>
                              <Text style={[styles.phaseColNum, styles.headerText]}>in</Text>
                              <Text style={[styles.phaseColNum, styles.headerText]}>out</Text>
                              <Text style={[styles.phaseColNum, styles.headerText]}>cost</Text>
                              <Text style={[styles.phaseColNum, styles.headerText]}>dur</Text>
                            </View>
                            {phases.map((p, i) => (
                              <View
                                key={`${p.phaseName}::${i}`}
                                style={[styles.phaseRow, p.aborted && styles.phaseRowAborted]}>
                                <View style={styles.phaseColName}>
                                  <Text style={styles.phaseName} numberOfLines={1}>
                                    {p.aborted && (
                                      <Text style={styles.phaseAbortedTag}>⚠ </Text>
                                    )}
                                    {p.phaseName}
                                  </Text>
                                  {p.agentPath && (
                                    <Text style={styles.phaseAgent} numberOfLines={1}>
                                      {p.agentPath}
                                    </Text>
                                  )}
                                  {p.aborted && (
                                    <Text style={styles.phaseAbortedNote}>
                                      aborted by token ceiling
                                    </Text>
                                  )}
                                </View>
                                <Text style={styles.phaseColNum}>{fmtInt(p.inputTokens)}</Text>
                                <Text style={styles.phaseColNum}>{fmtInt(p.outputTokens)}</Text>
                                <Text
                                  style={[styles.phaseColNum, p.costUsd > 0 && styles.costPos]}>
                                  ${p.costUsd.toFixed(4)}
                                </Text>
                                <Text style={styles.phaseColNum}>
                                  {p.durationMs != null
                                    ? `${(p.durationMs / 1000).toFixed(1)}s`
                                    : '—'}
                                </Text>
                              </View>
                            ))}
                          </ScrollView>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </Card>
          )}

          <Hint>
            Spend today / this-month is bucketed by the run store; window totals, the
            spend-over-time chart, and the top-agents table all aggregate the per-run /
            per-agent rollups within the selected window. Cost is $0 when a model's price
            isn't known. Tap a run to see its per-agent breakdown.
          </Hint>
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

function windowLabel(w: Window): string {
  return w === '7d' ? '7d' : w === '30d' ? '30d' : 'all';
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Local-day key (YYYY-MM-DD) for a Date — used to bucket the spend chart by
 *  calendar day in the viewer's timezone. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local-day key for a unix-ms timestamp. */
function dayKey(ts: number): string {
  return localDayKey(new Date(ts));
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
  if (status === 'running') return { backgroundColor: '#2563eb' };
  return { backgroundColor: '#d1d5db' };
}

const styles = StyleSheet.create({
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  windowRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  windowChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  windowChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  windowChipText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  windowChipTextActive: { color: '#ffffff' },
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

  // Spend-over-time chart (same hand-rolled bar approach as ObservabilityPage).
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
  barCost: { width: '100%', backgroundColor: '#2563eb' },
  chartLegend: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  chartLegendText: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
  legendKey: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: '#6b7280' },

  // Aggregate tables (spend by model, top agents by spend).
  aggHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 6,
    alignItems: 'center',
  },
  aggRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'center',
    gap: 6,
  },
  aggColName: { flex: 2.4 },
  aggColNum: {
    flex: 1,
    fontSize: 11,
    color: '#374151',
    fontFamily: 'Menlo',
    textAlign: 'right',
  },
  aggAgentName: { fontSize: 12, color: '#111827', fontWeight: '600' },
  aggAbortTag: { fontSize: 11, color: '#b91c1c', fontWeight: '700' },

  ceilingBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: 4,
  },
  ceilingBannerText: { fontSize: 12, color: '#991b1b', lineHeight: 17 },
  ceilingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 8,
  },
  ceilingPhase: { flex: 1, fontSize: 11, color: '#111827' },
  ceilingOrchTag: { color: '#6b7280', fontFamily: 'Menlo', fontSize: 10 },
  ceilingPhaseTag: { color: '#111827', fontWeight: '600' },
  ceilingApprox: {
    fontSize: 11,
    color: '#b91c1c',
    fontFamily: 'Menlo',
    fontWeight: '700',
  },

  sortRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  sortLabel: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sortChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  sortChipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  sortChipText: { fontSize: 10, color: '#374151', fontWeight: '600' },
  sortChipTextActive: { color: '#ffffff' },

  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 6,
    alignItems: 'center',
  },
  headerText: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  runRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'center',
    gap: 6,
  },
  colRun: { flex: 2.4 },
  colNum: {
    flex: 1,
    fontSize: 11,
    color: '#374151',
    fontFamily: 'Menlo',
    textAlign: 'right',
  },
  colFlag: { flex: 0.8, alignItems: 'flex-end' },
  colFlagHeader: { flex: 0.8, textAlign: 'right' },
  costPos: { color: '#059669' },
  runNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  runName: { fontSize: 12, color: '#111827', fontWeight: '600', flexShrink: 1 },
  runCaret: { fontSize: 10, color: '#9ca3af' },
  runMeta: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo', marginTop: 2 },
  breakerChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#fef2f2',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  breakerChipText: { fontSize: 10, color: '#b91c1c', fontWeight: '700' },
  breakerNone: { fontSize: 11, color: '#d1d5db' },

  phasePanel: {
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 8,
    marginVertical: 6,
  },
  phaseScroll: { maxHeight: 260 },
  phaseHeader: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 6,
  },
  phaseRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    alignItems: 'center',
    gap: 6,
  },
  phaseRowAborted: { backgroundColor: '#fef2f2', borderRadius: 4 },
  phaseColName: { flex: 2.4 },
  phaseColNum: {
    flex: 1,
    fontSize: 11,
    color: '#374151',
    fontFamily: 'Menlo',
    textAlign: 'right',
  },
  phaseName: { fontSize: 11, color: '#111827', fontWeight: '600' },
  phaseAbortedTag: { color: '#b91c1c', fontWeight: '700' },
  phaseAgent: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo', marginTop: 1 },
  phaseAbortedNote: { fontSize: 10, color: '#b91c1c', marginTop: 1 },
});
