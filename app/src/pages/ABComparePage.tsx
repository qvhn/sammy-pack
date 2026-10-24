import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { listOrchestrations } from '../api';
import { Card, Hint, Page, SectionTitle } from './Page';
import { SearchablePills } from './SearchablePills';

/**
 * A/B harness — run two orchestration versions against the same
 * initial input and compare cost/latency/output side-by-side. Useful
 * for: regression-checking a refactor, eval-driven prompt iteration,
 * picking between two candidate flows before promoting one to prod.
 *
 * Implemented entirely on top of existing endpoints (POST
 * /api/runs/start + GET /api/runs/:id) so it doesn't need a
 * dedicated server-side comparator.
 */

type OrchestrationOption = { name: string };

type RunSummary = {
  id: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  phaseCount: number;
  errorCount: number;
  lastOutput: string | null;
};

type Side = {
  orchestration: string;
  model: string;
  runId: string | null;
  summary: RunSummary | null;
  err: string | null;
};

const TERMINAL = new Set(['completed', 'error', 'cancelled', 'paused']);

async function startRun(
  orchestrationName: string,
  initialInput: string,
  model: string,
): Promise<string> {
  const res = await fetch('/api/runs/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orchestrationName,
      initialInput,
      model: model.trim() || undefined,
      allowAgentTools: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`start failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function fetchRun(id: string): Promise<RunSummary> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetch run failed: ${res.status}`);
  const run = (await res.json()) as {
    id: string;
    status: string;
    startedAt: number | null;
    endedAt: number | null;
    lastOutput: string | null;
    events: Array<{
      type: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }>;
  };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let phaseCount = 0;
  let errorCount = 0;
  for (const ev of run.events ?? []) {
    if (ev.type === 'phase-end') {
      phaseCount += 1;
      totalInputTokens += ev.inputTokens ?? 0;
      totalOutputTokens += ev.outputTokens ?? 0;
      totalCostUsd += ev.costUsd ?? 0;
    } else if (ev.type === 'phase-error' || ev.type === 'run-error') {
      errorCount += 1;
    }
  }
  const durationMs =
    run.startedAt && run.endedAt ? run.endedAt - run.startedAt : null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    phaseCount,
    errorCount,
    lastOutput: run.lastOutput,
  };
}

export function ABComparePage() {
  const [orchestrations, setOrchestrations] = useState<OrchestrationOption[]>(
    [],
  );
  const [leftOrch, setLeftOrch] = useState('');
  const [rightOrch, setRightOrch] = useState('');
  const [leftModel, setLeftModel] = useState('');
  const [rightModel, setRightModel] = useState('');
  const [initialInput, setInitialInput] = useState('');
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState<Side | null>(null);
  const [right, setRight] = useState<Side | null>(null);
  const [topErr, setTopErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await listOrchestrations();
        setOrchestrations(list.map(o => ({ name: o.name })));
        if (list.length > 0) {
          setLeftOrch(list[0].name);
          setRightOrch(list[list.length > 1 ? 1 : 0].name);
        }
      } catch (e) {
        setTopErr((e as Error).message);
      }
    })();
  }, []);

  const runComparison = useCallback(async () => {
    if (!leftOrch || !rightOrch) {
      setTopErr('Pick two orchestrations first.');
      return;
    }
    setTopErr(null);
    setRunning(true);
    const startedLeft: Side = {
      orchestration: leftOrch,
      model: leftModel,
      runId: null,
      summary: null,
      err: null,
    };
    const startedRight: Side = {
      orchestration: rightOrch,
      model: rightModel,
      runId: null,
      summary: null,
      err: null,
    };
    setLeft(startedLeft);
    setRight(startedRight);

    const [leftStartRes, rightStartRes] = await Promise.allSettled([
      startRun(leftOrch, initialInput, leftModel),
      startRun(rightOrch, initialInput, rightModel),
    ]);

    if (leftStartRes.status === 'rejected') {
      setLeft({ ...startedLeft, err: (leftStartRes.reason as Error).message });
    } else {
      setLeft({ ...startedLeft, runId: leftStartRes.value });
    }
    if (rightStartRes.status === 'rejected') {
      setRight({
        ...startedRight,
        err: (rightStartRes.reason as Error).message,
      });
    } else {
      setRight({ ...startedRight, runId: rightStartRes.value });
    }

    const pollOne = async (side: Side, setter: (s: Side) => void) => {
      if (!side.runId) return;
      // Poll every 1.5s — runs are agent-heavy and minutes-long; a
      // tight poll just burns request bandwidth without making the UI
      // feel snappier.
      while (true) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const summary = await fetchRun(side.runId);
          setter({ ...side, summary });
          if (TERMINAL.has(summary.status)) return;
        } catch (e) {
          setter({ ...side, err: (e as Error).message });
          return;
        }
      }
    };
    const leftId =
      leftStartRes.status === 'fulfilled' ? leftStartRes.value : null;
    const rightId =
      rightStartRes.status === 'fulfilled' ? rightStartRes.value : null;
    await Promise.all([
      leftId
        ? pollOne({ ...startedLeft, runId: leftId }, setLeft)
        : Promise.resolve(),
      rightId
        ? pollOne({ ...startedRight, runId: rightId }, setRight)
        : Promise.resolve(),
    ]);
    setRunning(false);
  }, [leftOrch, rightOrch, leftModel, rightModel, initialInput]);

  return (
    <Page
      title="A/B compare"
      subtitle="Run two orchestrations against the same initial input. Side-by-side cost, latency, output diff.">
      <SectionTitle>Inputs</SectionTitle>
      <Card>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.label}>Left orchestration</Text>
              <OrchestrationPicker
                value={leftOrch}
                onChange={setLeftOrch}
                options={orchestrations}
              />
              <Text style={styles.label}>Left model override (optional)</Text>
              <TextInput
                value={leftModel}
                onChangeText={setLeftModel}
                placeholder="claude-opus-4-7"
                style={styles.input}
              />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.label}>Right orchestration</Text>
              <OrchestrationPicker
                value={rightOrch}
                onChange={setRightOrch}
                options={orchestrations}
              />
              <Text style={styles.label}>Right model override (optional)</Text>
              <TextInput
                value={rightModel}
                onChangeText={setRightModel}
                placeholder="claude-sonnet-4-6"
                style={styles.input}
              />
            </View>
          </View>
          <Text style={styles.label}>Shared initial input</Text>
          <TextInput
            value={initialInput}
            onChangeText={setInitialInput}
            multiline
            numberOfLines={4}
            placeholder="Both sides receive this as the first phase's input."
            style={[styles.input, { fontFamily: 'monospace' }]}
          />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Pressable
              onPress={runComparison}
              disabled={running}
              style={[styles.button, running && styles.buttonDisabled]}>
              <Text style={styles.buttonText}>
                {running ? 'Running…' : 'Run both'}
              </Text>
            </Pressable>
            {topErr && <Text style={styles.errText}>{topErr}</Text>}
          </View>
        </View>
      </Card>

      <SectionTitle>Comparison</SectionTitle>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <SidePanel side={left} label="Left" />
        </View>
        <View style={{ flex: 1 }}>
          <SidePanel side={right} label="Right" />
        </View>
      </View>
      {left?.summary && right?.summary && (
        <Card title="Delta (right − left)">
          <DeltaTable left={left.summary} right={right.summary} />
        </Card>
      )}
      <Hint>
        Use this to gate a prompt or schema refactor: run the old
        orchestration vs. the new against the same dataset entry, eyeball
        the diff, then promote. For automated scoring layer an Evals run
        on top of the two outputs.
      </Hint>
    </Page>
  );
}

function OrchestrationPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: OrchestrationOption[];
}) {
  // RN Web doesn't ship Picker; SearchablePills renders a pill list that
  // gains a filter box + cap once the workspace grows past a dozen orchs,
  // so this scales without a custom dropdown.
  return (
    <SearchablePills
      options={options.map(o => ({ value: o.name, label: o.name }))}
      value={value}
      onChange={onChange}
      placeholder="Search orchestrations"
      emptyText="No orchestrations in the workspace."
    />
  );
}

function SidePanel({ side, label }: { side: Side | null; label: string }) {
  if (!side) {
    return (
      <Card title={`${label} side`}>
        <Text style={styles.dim}>Hit "Run both" to start.</Text>
      </Card>
    );
  }
  const s = side.summary;
  return (
    <Card
      title={`${label}: ${side.orchestration}`}
      subtitle={
        side.runId
          ? `run ${side.runId}${side.model ? ` · model=${side.model}` : ''}`
          : 'starting…'
      }>
      {side.err && <Text style={styles.errText}>{side.err}</Text>}
      {s && (
        <View style={{ gap: 4 }}>
          <Row k="status" v={s.status} />
          <Row
            k="duration"
            v={s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'}
          />
          <Row k="phases" v={String(s.phaseCount)} />
          <Row k="errors" v={String(s.errorCount)} />
          <Row
            k="tokens in / out"
            v={`${s.totalInputTokens} / ${s.totalOutputTokens}`}
          />
          <Row k="cost" v={`$${s.totalCostUsd.toFixed(4)}`} />
          <Text style={[styles.label, { marginTop: 8 }]}>Final output</Text>
          <View style={styles.outputBox}>
            <Text style={styles.mono}>
              {s.lastOutput ?? '(no output)'}
            </Text>
          </View>
        </View>
      )}
      {!s && side.runId && <Text style={styles.dim}>Polling…</Text>}
    </Card>
  );
}

function DeltaTable({
  left,
  right,
}: {
  left: RunSummary;
  right: RunSummary;
}) {
  function deltaStr(l: number, r: number, fmt: (n: number) => string): string {
    const d = r - l;
    const sign = d > 0 ? '+' : '';
    return `${fmt(l)} → ${fmt(r)} (${sign}${fmt(d)})`;
  }
  const n = (n: number): string => String(n);
  const ms = (m: number): string => `${(m / 1000).toFixed(1)}s`;
  const usd = (c: number): string => `$${c.toFixed(4)}`;
  return (
    <View style={{ gap: 4 }}>
      <Row
        k="duration"
        v={deltaStr(left.durationMs ?? 0, right.durationMs ?? 0, ms)}
      />
      <Row
        k="phases"
        v={deltaStr(left.phaseCount, right.phaseCount, n)}
      />
      <Row
        k="errors"
        v={deltaStr(left.errorCount, right.errorCount, n)}
      />
      <Row
        k="input tokens"
        v={deltaStr(left.totalInputTokens, right.totalInputTokens, n)}
      />
      <Row
        k="output tokens"
        v={deltaStr(left.totalOutputTokens, right.totalOutputTokens, n)}
      />
      <Row k="cost" v={deltaStr(left.totalCostUsd, right.totalCostUsd, usd)} />
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { flex: 1 }]}>{k}</Text>
      <Text style={[styles.mono, { flex: 2 }]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 11, fontWeight: '600', color: '#6b7280' },
  dim: { color: '#9ca3af', fontSize: 12 },
  errText: { color: '#dc2626', fontSize: 12 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: '#111827' },
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
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'baseline' },
  outputBox: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    padding: 8,
    maxHeight: 240,
  },
});
