import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Card, Hint, Page, SectionTitle } from './Page';

/**
 * Triggers introspection: list every trigger the server has registered,
 * across ALL kinds (webhook / cron / polling / events / deployment /
 * queue), grouped by kind, plus a tester for the HTTP-fired kinds. The
 * registration map mutates as orchestrations are saved — refresh to see
 * the latest.
 */

/** A registered trigger across any kind, as returned by GET /api/triggers. */
type TriggerEntry = {
  /** Discriminator: webhook / cron / polling / events / deployment / queue. */
  kind: string;
  /** The kind's identity — path (webhook) / expr (cron) / source (polling) /
   *  event|environment|queue name (the named HTTP-fired kinds). Also the
   *  segment to POST at /api/triggers/<name> for the HTTP-fired kinds. */
  name: string;
  orchestration: string;
  /** 'http' = fired by POST /api/triggers/<name> (testable here);
   *  'schedule' = fired by a server-side timer (read-only). */
  firing: 'http' | 'schedule';
  /** Human one-liner from the kind registry. */
  summary: string;
  /** Kind-specific detail (cron: expr/schedule; polling: source +
   *  intervalSeconds; http-fired: path|name + method [+ signed]). */
  config: Record<string, unknown>;
};

/** Section metadata, in the order sections are rendered. */
const KIND_SECTIONS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: 'webhook', label: 'Webhooks' },
  { kind: 'cron', label: 'Cron' },
  { kind: 'polling', label: 'Polling' },
  { kind: 'events', label: 'Events' },
  { kind: 'deployment', label: 'Deployment' },
  { kind: 'queue', label: 'Queue' },
];

async function listTriggers(): Promise<TriggerEntry[]> {
  const res = await fetch('/api/triggers');
  if (!res.ok) throw new Error(`GET /api/triggers failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as TriggerEntry[]) : [];
}

async function fireTrigger(
  name: string,
  body: string,
  idempotencyKey?: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`/api/triggers/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

/** GET /api/orchestrations/:name/intake — the intake switch, root `limits`
 *  and today's usage against them. */
type IntakeState = {
  orchestration: string;
  paused: { pausedAt: number; by?: string; reason?: string } | null;
  limits: { maxRunsPerDay?: number; maxCostUsdPerDay?: number; maxCostUsdPerMonth?: number } | null;
  usage: { runsToday: number; todayUsd: number; monthUsd: number } | null;
  limitReached: string | null;
};

async function getIntake(orch: string): Promise<IntakeState | null> {
  const res = await fetch(`/api/orchestrations/${encodeURIComponent(orch)}/intake`);
  if (!res.ok) return null;
  return (await res.json()) as IntakeState;
}

async function setIntakePaused(orch: string, pause: boolean, reason?: string): Promise<string | null> {
  const res = await fetch(
    `/api/orchestrations/${encodeURIComponent(orch)}/${pause ? 'pause' : 'resume'}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pause ? JSON.stringify(reason ? { reason } : {}) : undefined,
    },
  );
  return res.ok ? null : `${res.status}: ${await res.text()}`;
}

/** The orchestration names the server knows (`GET /api/orchestrations`),
 *  used to show a trigger's orchestration under its real `name`. Best
 *  effort — an empty list just leaves the names as reported. */
async function listOrchestrationNames(): Promise<string[]> {
  const res = await fetch('/api/orchestrations');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data)
    ? (data as Array<{ name?: unknown }>)
        .map(o => o?.name)
        .filter((n): n is string => typeof n === 'string')
    : [];
}

/** Display name for a trigger's orchestration. The trigger registry can
 *  report the orchestration's FILE key (e.g. `TEMPLATE` for TEMPLATE.json)
 *  where Pipelines shows its declared `name` (`template`) — prefer the
 *  declared name when the two differ only by case; otherwise show the
 *  reported value as-is. */
export function displayOrchName(reported: string, known: readonly string[]): string {
  if (known.includes(reported)) return reported;
  const lower = reported.toLowerCase();
  const matches = known.filter(n => n.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : reported;
}

/** Keep the test target only while it still exists — never auto-pick one.
 *  The first HTTP row can be an expensive pipeline one click from Send. */
export function keepSelection(prev: string, keys: readonly string[]): string {
  return keys.includes(prev) ? prev : '';
}

/** Stable per-row key (a name can be shared across orchestrations). */
const rowKey = (e: TriggerEntry) => `${e.kind}:${e.name}:${e.orchestration}`;

/** The config a row shows, as label/value pairs, per kind. */
/** The ingress options in force on an HTTP-fired trigger (server-reported). */
function intakeRows(c: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (typeof c.idempotencyTtlSeconds === 'number') {
    const s = c.idempotencyTtlSeconds;
    rows.push(['Idempotency window', s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`]);
  }
  const sc = c.scrub as Record<string, unknown> | undefined;
  if (sc) {
    const parts = [
      `detectors: ${String(sc.builtins ?? 'all')}`,
      sc.allowFields !== undefined ? `keep ${sc.allowFields} field(s)` : '',
      sc.dropFields !== undefined ? `drop ${sc.dropFields}` : '',
      sc.hashFields !== undefined ? `hash ${sc.hashFields}` : '',
      sc.patterns !== undefined ? `${sc.patterns} pattern(s)` : '',
    ].filter(Boolean);
    rows.push(['Scrub', parts.join(' · ')]);
  }
  return rows;
}

function configRows(e: TriggerEntry): Array<[string, string]> {
  const c = e.config ?? {};
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  switch (e.kind) {
    case 'cron': {
      const rows: Array<[string, string]> = [
        ['Schedule', str(c.schedule ?? c.expr)],
      ];
      if (c.nextFiring) rows.push(['Next firing', str(c.nextFiring)]);
      return rows;
    }
    case 'polling':
      return [
        ['Source', str(c.source)],
        ['Interval', `${str(c.intervalSeconds)}s`],
      ];
    case 'webhook':
      return [
        ['Path', `/api/triggers/${str(c.path ?? e.name)}`],
        ['Method', str(c.method ?? 'POST')],
        ...(c.signed ? ([['Signed', 'yes']] as Array<[string, string]>) : []),
        ...intakeRows(c),
      ];
    default:
      // events / deployment / queue — named HTTP-fired kinds.
      return [
        ['Endpoint', `/api/triggers/${str(c.name ?? e.name)}`],
        ['Method', str(c.method ?? 'POST')],
        ...(c.signed ? ([['Signed', 'yes']] as Array<[string, string]>) : []),
        ...intakeRows(c),
      ];
  }
}

export function TriggersPage() {
  const [entries, setEntries] = useState<TriggerEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [testBody, setTestBody] = useState('{}');
  const [testResult, setTestResult] = useState<{
    status: number;
    body: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testKey, setTestKey] = useState('');
  const [intake, setIntake] = useState<Record<string, IntakeState>>({});
  const [pauseReason, setPauseReason] = useState<Record<string, string>>({});
  const [intakeErr, setIntakeErr] = useState<string | null>(null);
  const [knownOrchs, setKnownOrchs] = useState<string[]>([]);
  const orchLabel = (n: string) => displayOrchName(n, knownOrchs);

  const orchNames = useMemo(
    () => [...new Set(entries.map(e => e.orchestration))].sort(),
    [entries],
  );
  const refreshIntake = useCallback(async (names: string[]) => {
    const pairs = await Promise.all(names.map(async n => [n, await getIntake(n)] as const));
    setIntake(Object.fromEntries(pairs.filter(([, v]) => v !== null)) as Record<string, IntakeState>);
  }, []);
  useEffect(() => {
    refreshIntake(orchNames).catch(() => {});
  }, [orchNames, refreshIntake]);

  async function toggleIntake(orch: string, pause: boolean) {
    setIntakeErr(null);
    const failure = await setIntakePaused(orch, pause, pauseReason[orch]?.trim() || undefined);
    if (failure) setIntakeErr(failure);
    await refreshIntake(orchNames);
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await listTriggers();
      setEntries(list);
      listOrchestrationNames()
        .then(setKnownOrchs)
        .catch(() => {});
      // Keep the user's pick among the http-fired (testable) rows; no
      // default — firing must be a deliberate choice.
      const testable = list.filter(e => e.firing === 'http').map(rowKey);
      setSelectedKey(prev => keepSelection(prev, testable));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Group entries by kind, preserving the section order.
  const grouped = useMemo(() => {
    const by = new Map<string, TriggerEntry[]>();
    for (const e of entries) {
      const arr = by.get(e.kind) ?? [];
      arr.push(e);
      by.set(e.kind, arr);
    }
    return by;
  }, [entries]);

  const selectedEntry = entries.find(e => rowKey(e) === selectedKey);

  async function runTest() {
    if (!selectedEntry || selectedEntry.firing !== 'http') return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fireTrigger(selectedEntry.name, testBody, testKey.trim() || undefined);
      setTestResult(r);
      // A successful fire durably queues a delivery; the worker creates the
      // run. The Runs / Deliveries tabs surface what happened next.
    } catch (e) {
      setTestResult({ status: 0, body: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Page
      title="Triggers"
      subtitle="All trigger kinds the server has registered — webhook, cron, polling, events, deployment, queue. Saving an orchestration with a `triggers` block re-registers immediately — no restart.">
      {/* Toolbar (not a card): what's registered + Refresh. */}
      <View style={styles.toolbar}>
        <Text style={styles.toolbarText}>
          {entries.length > 0
            ? `${entries.length} trigger${entries.length === 1 ? '' : 's'} registered`
            : loading
              ? 'Loading…'
              : ''}
        </Text>
        <Pressable onPress={refresh} style={styles.button} accessibilityRole="button">
          <Text style={styles.buttonText}>
            {loading ? 'Loading…' : 'Refresh'}
          </Text>
        </Pressable>
      </View>
      {err && <Text style={styles.error}>{err}</Text>}
      {entries.length === 0 && !err && !loading && (
        <Card>
          <Hint>
            {
              'No triggers registered. Add a root-level `triggers: [{ kind: "webhook", path: "…" }]` (or cron / polling / events / deployment / queue) to any orchestration to expose one here.'
            }
          </Hint>
        </Card>
      )}

      {orchNames.length > 0 && (
        <View style={styles.section}>
          <SectionTitle>Intake</SectionTitle>
          <Card
            subtitle="Pause stops an orchestration's triggers from starting runs — HTTP-fired fires are held (nothing is dropped) and released on resume; scheduled ticks are skipped. Runs already going and manual starts are unaffected. Limits cap trigger-fired runs per day.">
            {intakeErr && <Text style={styles.error}>{intakeErr}</Text>}
            <View style={styles.table}>
              {orchNames.map(n => {
                const st = intake[n];
                const paused = !!st?.paused;
                const l = st?.limits;
                const u = st?.usage;
                const limitText = l
                  ? [
                      l.maxRunsPerDay !== undefined ? `${u?.runsToday ?? 0}/${l.maxRunsPerDay} runs today` : '',
                      l.maxCostUsdPerDay !== undefined ? `$${(u?.todayUsd ?? 0).toFixed(2)}/$${l.maxCostUsdPerDay} today` : '',
                      l.maxCostUsdPerMonth !== undefined ? `$${(u?.monthUsd ?? 0).toFixed(2)}/$${l.maxCostUsdPerMonth} this month` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'no limits';
                return (
                  <View key={n} style={[styles.row, paused && styles.rowPaused]}>
                    <Text style={[styles.cell, styles.code, styles.flex2]}>{orchLabel(n)}</Text>
                    <View style={[styles.cell, styles.intakeState]}>
                      <Text style={[styles.detail, paused && styles.pausedText]}>
                        {paused
                          ? `⏸ paused${st?.paused?.by ? ` by ${st.paused.by}` : ''}${st?.paused?.reason ? ` — ${st.paused.reason}` : ''}`
                          : '▶ accepting'}
                      </Text>
                      <Text style={styles.detail}>
                        <Text style={styles.detailLabel}>Limits: </Text>
                        <Text style={styles.mono}>{limitText}</Text>
                      </Text>
                      {st?.limitReached && <Text style={styles.warn}>{st.limitReached} — new fires are held</Text>}
                    </View>
                    <View style={styles.intakeActions}>
                      {!paused && (
                        <TextInput
                          value={pauseReason[n] ?? ''}
                          onChangeText={t => setPauseReason(r => ({ ...r, [n]: t }))}
                          placeholder="reason (optional)"
                          style={[styles.input, styles.reasonInput]}
                        />
                      )}
                      <Pressable
                        onPress={() => toggleIntake(n, !paused)}
                        accessibilityLabel={`${paused ? 'Resume' : 'Pause'} intake for ${n}`}
                        style={[styles.button, paused ? styles.resumeButton : styles.pauseButton]}>
                        <Text style={paused ? styles.buttonText : styles.pauseButtonText}>
                          {paused ? 'Resume' : 'Pause'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          </Card>
        </View>
      )}

      {KIND_SECTIONS.map(({ kind, label }) => {
        const rows = grouped.get(kind);
        if (!rows || rows.length === 0) return null;
        const scheduled = rows[0].firing === 'schedule';
        return (
          <View key={kind} style={{ gap: 6 }}>
            <SectionTitle>{label}</SectionTitle>
            <Card>
              <View style={styles.table}>
                <View style={[styles.row, styles.headerRow]}>
                  <Text style={[styles.cell, styles.h, { flex: 2 }]}>
                    {kind === 'cron'
                      ? 'Expression'
                      : kind === 'polling'
                        ? 'Source'
                        : kind === 'webhook'
                          ? 'Path'
                          : 'Name'}
                  </Text>
                  <Text style={[styles.cell, styles.h, { flex: 3 }]}>
                    {scheduled ? 'Schedule' : 'Endpoint'}
                  </Text>
                  <Text style={[styles.cell, styles.h, { flex: 2 }]}>
                    Orchestration
                  </Text>
                </View>
                {rows.map(e => {
                  const k = rowKey(e);
                  const selectable = e.firing === 'http';
                  const selected = selectable && k === selectedKey;
                  const detail = configRows(e);
                  return (
                    <Pressable
                      key={k}
                      onPress={
                        selectable ? () => setSelectedKey(k) : undefined
                      }
                      disabled={!selectable}
                      accessibilityRole={selectable ? 'button' : undefined}
                      accessibilityState={
                        selectable ? { selected } : undefined
                      }
                      accessibilityLabel={`${e.kind} trigger ${e.name}`}
                      style={[styles.row, selected && styles.rowSelected]}>
                      <Text style={[styles.cell, styles.code, { flex: 2 }]}>
                        {/* Radio mark: makes it visible that a click picks
                            this row as the Test-trigger target. */}
                        {selectable ? (
                          <Text style={selected ? styles.radioOn : styles.radioOff}>
                            {selected ? '● ' : '○ '}
                          </Text>
                        ) : null}
                        {e.name}
                      </Text>
                      <View style={[styles.cell, { flex: 3, gap: 2 }]}>
                        {detail.map(([dl, dv]) => (
                          <Text key={dl} style={styles.detail}>
                            <Text style={styles.detailLabel}>{dl}: </Text>
                            <Text style={styles.mono}>{dv}</Text>
                          </Text>
                        ))}
                      </View>
                      <Text style={[styles.cell, { flex: 2 }]}>
                        {orchLabel(e.orchestration)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {scheduled ? (
                <Hint>
                  {label} triggers fire on a server-side schedule — read-only
                  here (no manual fire).
                </Hint>
              ) : (
                <Hint>Click a row to make it the Test trigger target below.</Hint>
              )}
            </Card>
          </View>
        );
      })}

      <SectionTitle>Test trigger</SectionTitle>
      <Card
        title={
          selectedEntry
            ? `POST /api/triggers/${selectedEntry.name}`
            : 'Select an HTTP-fired trigger above'
        }
        subtitle={
          selectedEntry
            ? `Fires "${orchLabel(selectedEntry.orchestration)}" (${selectedEntry.kind}). The body below becomes the run's initial input.`
            : 'Nothing is selected. Click a webhook / events / deployment / queue row above to choose what to fire. Cron and polling are schedule-fired and can’t be triggered manually.'
        }>
        {selectedEntry && (
          <View style={{ gap: 8 }}>
            <Text style={styles.label}>Body</Text>
            <TextInput
              value={testBody}
              onChangeText={setTestBody}
              multiline
              numberOfLines={5}
              style={[styles.input, { fontFamily: 'monospace' }]}
              placeholder='{"input":"sample"}'
            />
            <Text style={styles.label}>Idempotency-Key (optional)</Text>
            <TextInput
              value={testKey}
              onChangeText={setTestKey}
              style={[styles.input, { fontFamily: 'monospace' }]}
              placeholder="send the same key twice to see the repeat suppressed"
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                onPress={runTest}
                disabled={testing}
                style={styles.button}>
                <Text style={styles.buttonText}>
                  {testing ? 'Firing…' : 'Send'}
                </Text>
              </Pressable>
            </View>
            {testResult && (
              <View style={styles.result}>
                <Text style={styles.resultLabel}>HTTP {testResult.status}</Text>
                <Text style={[styles.mono, { fontSize: 12 }]}>
                  {testResult.body}
                </Text>
              </View>
            )}
          </View>
        )}
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  table: { gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  headerRow: { backgroundColor: '#f3f4f6' },
  rowSelected: { backgroundColor: '#eef2ff' },
  radioOn: { color: '#4f46e5' },
  radioOff: { color: '#9ca3af' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  toolbarText: { fontSize: 12, color: '#6b7280' },
  rowPaused: { backgroundColor: '#fffbeb' },
  section: { gap: 6 },
  flex2: { flex: 2 },
  intakeState: { flex: 4, gap: 2 },
  intakeActions: { flex: 3, flexDirection: 'row', gap: 6, alignItems: 'center' },
  reasonInput: { flex: 1, paddingVertical: 4 },
  pausedText: { color: '#b45309', fontWeight: '600' },
  warn: { fontSize: 12, color: '#b45309' },
  pauseButton: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#d1d5db' },
  pauseButtonText: { color: '#374151', fontWeight: '600', fontSize: 13 },
  resumeButton: { backgroundColor: '#047857' },
  cell: { flex: 1, fontSize: 13, color: '#374151' },
  h: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  code: { fontFamily: 'monospace', fontSize: 12, color: '#111827' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  detail: { fontSize: 12, color: '#374151' },
  detailLabel: { color: '#6b7280' },
  label: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 8,
    fontSize: 12,
    backgroundColor: '#ffffff',
    textAlignVertical: 'top',
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  error: { color: '#dc2626', fontSize: 12 },
  result: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    padding: 8,
    gap: 4,
  },
  resultLabel: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
});
