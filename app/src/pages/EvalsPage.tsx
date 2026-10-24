import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  deleteEval,
  getDataset,
  listAgents,
  listDatasets,
  listEvals,
  listOrchestrations,
  saveEval,
  type AgentFile,
  type Dataset,
  type Eval,
  type Scorer,
} from '../api';
import { runOrchestration, type RunEvent } from '../llm/executor';
import {
  agentSystemPrompt,
  judgeRequest,
  parseJudgeReply,
  rowPassed,
  scoreDeterministic,
  scorerKey,
} from '../lib/eval-scoring';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import { getApiKey, getAuthMode, getModel, getAllowAgentTools } from '../store/apiKey';
import { useToast } from '../store/toast';
import type { Node } from '../types';
import { Card, Hint, Page } from './Page';
import { SearchablePills } from './SearchablePills';

type RowResult = {
  rowId: string;
  input: string;
  expectedOutput?: string;
  output?: string;
  scores: Record<string, number>;
  pass: boolean;
  error?: string;
  durationMs?: number;
};

type EvalRunState =
  | { status: 'idle' }
  | { status: 'running'; current: number; total: number; results: RowResult[] }
  | { status: 'done'; results: RowResult[]; ranAt: number }
  | { status: 'error'; error: string; results: RowResult[] };

/** Evals page — define an eval (orch + dataset + scorers), run it,
 *  see per-row pass/fail with aggregate score. Mirrors the LangSmith
 *  pattern at a much smaller surface area: scorers are local +
 *  composable, results are in-memory + drillable. */
export function EvalsPage() {
  const [evals, setEvals] = useState<Eval[]>([]);
  const [orchestrations, setOrchestrations] = useState<Node[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [draft, setDraft] = useState<Eval | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [runState, setRunState] = useState<EvalRunState>({ status: 'idle' });
  const toast = useToast();
  const [suggestingScorers, setSuggestingScorers] = useState(false);

  async function suggestScorers() {
    if (!draft) return;
    setError(null);
    const dataset = datasets.find(d => d.name === draft.datasetName);
    if (!dataset) {
      setError(`Dataset "${draft.datasetName}" not found.`);
      return;
    }
    const orch = orchestrations.find(o => o.name === draft.orchestrationName);
    if (!orch) {
      setError(`Orchestration "${draft.orchestrationName}" not found.`);
      return;
    }
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured.');
      return;
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const designer = agents.find(a => a.name === 'scorer-suggester');
    if (!designer) {
      setError('Missing agents/scorer-suggester.md');
      return;
    }
    const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : designer.raw).trim();
    // Sample up to 4 rows to keep the prompt bounded.
    const sample = dataset.rows.slice(0, 4).map(r => ({
      input: r.input.slice(0, 400),
      expectedOutput: r.expectedOutput?.slice(0, 400),
    }));
    setSuggestingScorers(true);
    try {
      let accum = '';
      for await (const ev of streamFn({
        apiKey,
        model,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `# ORCHESTRATION\n\n"${orch.name}" — ${orch.description ?? '(no description)'}\n\n# DATASET sample (${sample.length}/${dataset.rows.length} rows)\n\n\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\`\n\nSuggest scorers now.`,
          },
        ],
      })) {
        if (ev.type === 'text-delta') accum += ev.text;
      }
      const cleaned = accum
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      const parsed = JSON.parse(cleaned) as Scorer[];
      if (!Array.isArray(parsed)) throw new Error('not an array');
      setDraft(d => (d ? { ...d, scorers: [...d.scorers, ...parsed] } : d));
      setDirty(true);
      toast.show(`Suggested ${parsed.length} scorer${parsed.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      setError(`Suggest failed: ${(err as Error).message}`);
      toast.show(`Suggest failed: ${(err as Error).message}`, 'error');
    } finally {
      setSuggestingScorers(false);
    }
  }

  // New-eval form.
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    Promise.all([
      listEvals().catch(() => [] as Eval[]),
      listOrchestrations().catch(() => [] as Node[]),
      listDatasets().catch(() => [] as Dataset[]),
      listAgents().catch(() => [] as AgentFile[]),
    ])
      .then(([e, o, d, a]) => {
        setEvals(e);
        setOrchestrations(o);
        setDatasets(d);
        setAgents(a);
        setStatus('idle');
        if (e.length > 0 && !selectedName) setSelectedName(e[0].name);
      })
      .catch(err => {
        setError((err as Error).message);
        setStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedName) {
      setDraft(null);
      setDirty(false);
      return;
    }
    const e = evals.find(x => x.name === selectedName);
    if (e) {
      setDraft(JSON.parse(JSON.stringify(e)) as Eval);
      setDirty(false);
      setRunState({ status: 'idle' });
    }
  }, [selectedName, evals]);

  async function createEval() {
    setError(null);
    const name = newName.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setError('Name must be alphanumeric + dashes/underscores');
      return;
    }
    if (evals.find(e => e.name === name)) {
      setError(`Eval "${name}" already exists`);
      return;
    }
    if (orchestrations.length === 0 || datasets.length === 0) {
      setError('Need at least one orchestration and one dataset to create an eval');
      return;
    }
    const now = Date.now();
    const next: Eval = {
      name,
      orchestrationName: orchestrations[0].name,
      datasetName: datasets[0].name,
      scorers: [{ type: 'exact' }],
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await saveEval(next);
      setEvals(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(saved.name);
      setShowNew(false);
      setNewName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function save() {
    if (!draft) return;
    setStatus('saving');
    setError(null);
    try {
      const next: Eval = { ...draft, updatedAt: Date.now() };
      const saved = await saveEval(next);
      setEvals(prev => prev.map(e => (e.name === saved.name ? saved : e)));
      setDirty(false);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function duplicateEval() {
    if (!draft) return;
    const g = globalThis as unknown as {
      prompt?: (m: string, d?: string) => string | null;
    };
    const next = g.prompt?.('Name for the duplicate:', `${draft.name}-copy`);
    if (!next) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      setError('Name must be alphanumeric + dashes/underscores');
      return;
    }
    if (evals.find(e => e.name === next)) {
      setError(`Eval "${next}" already exists`);
      return;
    }
    const now = Date.now();
    const copy: Eval = {
      ...JSON.parse(JSON.stringify(draft)),
      name: next,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await saveEval(copy);
      setEvals(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(saved.name);
      toast.show(`Duplicated as "${saved.name}"`, 'success');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Duplicate failed: ${(err as Error).message}`, 'error');
    }
  }

  async function removeEval() {
    if (!draft) return;
    const g = globalThis as unknown as { confirm?: (m: string) => boolean };
    if (g.confirm && !g.confirm(`Delete eval "${draft.name}"?`)) return;
    try {
      await deleteEval(draft.name);
      setEvals(prev => prev.filter(e => e.name !== draft.name));
      setSelectedName(prev =>
        prev === draft.name ? evals.find(e => e.name !== draft.name)?.name ?? null : prev,
      );
      toast.show(`Deleted "${draft.name}"`, 'info');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Delete failed: ${(err as Error).message}`, 'error');
    }
  }

  async function runEval() {
    if (!draft) return;
    setError(null);
    const orch = orchestrations.find(o => o.name === draft.orchestrationName);
    if (!orch) {
      setError(`Orchestration "${draft.orchestrationName}" not found`);
      return;
    }
    let dataset: Dataset;
    try {
      dataset = await getDataset(draft.datasetName);
    } catch (err) {
      setError(`Failed to load dataset: ${(err as Error).message}`);
      return;
    }
    const rows = draft.sampleSize ? dataset.rows.slice(0, draft.sampleSize) : dataset.rows;
    if (rows.length === 0) {
      setError('Dataset has no rows');
      return;
    }

    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured (Settings → LLM Provider)');
      return;
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const allowAgentTools =
      authMode === 'claude-code-proxy' && getAllowAgentTools();

    const results: RowResult[] = [];
    setRunState({ status: 'running', current: 0, total: rows.length, results });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setRunState({ status: 'running', current: i + 1, total: rows.length, results: [...results] });
      const startMs = Date.now();
      const cancelled = { v: false };
      let lastOutput = '';
      let runError: string | undefined;
      try {
        for await (const event of runOrchestration({
          orchestration: orch,
          apiKey,
          model,
          streamFn,
          initialInput: row.input,
          waitForApproval: async () => true, // auto-approve in eval mode
          cancelled,
          allowAgentTools,
        })) {
          if (event.type === 'phase-end') lastOutput = event.output;
          if (event.type === 'run-error' || event.type === 'phase-error') {
            runError = (event as Extract<RunEvent, { type: 'run-error' | 'phase-error' }>).error;
          }
        }
      } catch (err) {
        runError = (err as Error).message;
      }
      const scores = scoreDeterministic(lastOutput, row.expectedOutput, draft.scorers);
      // LLM-judge scorers need an extra round-trip — run them all in
      // parallel after the main orchestration completes. Failures
      // count as 0.0 (block-on-error rather than skip).
      const judgeScores = await runJudges({
        scorers: draft.scorers,
        output: lastOutput,
        expected: row.expectedOutput,
        agents,
        apiKey,
        model,
        streamFn,
      });
      Object.assign(scores, judgeScores);
      const pass = rowPassed(scores);
      results.push({
        rowId: row.id,
        input: row.input,
        expectedOutput: row.expectedOutput,
        output: lastOutput,
        scores,
        pass,
        error: runError,
        durationMs: Date.now() - startMs,
      });
    }
    setRunState({ status: 'done', results, ranAt: Date.now() });
    const passed = results.filter(r => r.pass).length;
    toast.show(
      `Eval done · ${passed}/${results.length} passed`,
      passed === results.length ? 'success' : 'info',
    );
  }

  const aggregate = useMemo(() => {
    if (runState.status !== 'done' && runState.status !== 'running') return null;
    const r = runState.results;
    if (r.length === 0) return null;
    const passed = r.filter(x => x.pass).length;
    const errors = r.filter(x => !!x.error).length;
    const avgDur = r.reduce((a, b) => a + (b.durationMs ?? 0), 0) / r.length;
    return {
      passed,
      total: r.length,
      errors,
      passRate: passed / r.length,
      avgDur,
    };
  }, [runState]);

  return (
    <Page title="Evals" subtitle="score orchestrations against datasets">
      <View style={styles.layout}>
        {/* Left rail */}
        <View style={styles.sidebar}>
          <Pressable onPress={() => setShowNew(s => !s)} style={styles.newBtn}>
            <Text style={styles.newBtnText}>{showNew ? '× Cancel' : '+ New eval'}</Text>
          </Pressable>
          {showNew && (
            <View style={styles.newForm}>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="name (a-z, 0-9, -)"
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable onPress={createEval} style={styles.saveBtn}>
                <Text style={styles.saveBtnText}>Create</Text>
              </Pressable>
            </View>
          )}
          <ScrollView style={styles.sidebarScroll}>
            {evals.length === 0 && (
              <View style={styles.sidebarEmpty}>
                <Hint>No evals yet. Create one above to score an orchestration.</Hint>
              </View>
            )}
            {evals.map(e => {
              const selected = selectedName === e.name;
              return (
                <Pressable
                  key={e.name}
                  onPress={() => setSelectedName(e.name)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Eval ${e.name}`}
                  style={[styles.sidebarRow, selected && styles.sidebarRowSelected]}>
                  <Text
                    style={[styles.sidebarName, selected && styles.sidebarTextSelected]}
                    numberOfLines={1}>
                    {e.name}
                  </Text>
                  <Text
                    style={[styles.sidebarMeta, selected && styles.sidebarMetaSelected]}>
                    {e.orchestrationName} · {e.datasetName}
                  </Text>
                  <Text
                    style={[styles.sidebarMeta, selected && styles.sidebarMetaSelected]}>
                    {e.scorers.length} scorer{e.scorers.length === 1 ? '' : 's'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Right pane */}
        <View style={styles.detail}>
          {error && (
            <Card>
              <Text style={styles.errorText}>{error}</Text>
            </Card>
          )}
          {!draft && status !== 'loading' && (
            <Card>
              <Hint>
                Select an eval on the left or create a new one. An eval needs at
                least one orchestration (Pipelines page) and one dataset (Datasets
                page) to exist first.
              </Hint>
            </Card>
          )}
          {draft && (
            <Card
              title={draft.name}
              subtitle={`runs "${draft.orchestrationName}" against "${draft.datasetName}"`}
              right={
                <View style={styles.actionRow}>
                  <Pressable
                    onPress={runEval}
                    disabled={runState.status === 'running'}
                    style={[
                      styles.runBtn,
                      runState.status === 'running' && styles.btnDisabled,
                    ]}>
                    <Text style={styles.runBtnText}>
                      {runState.status === 'running'
                        ? `Running ${runState.current}/${runState.total}…`
                        : '▶ Run'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={save}
                    disabled={!dirty}
                    style={[styles.saveBtn, !dirty && styles.btnDisabled]}>
                    <Text style={styles.saveBtnText}>
                      {status === 'saving' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                    </Text>
                  </Pressable>
                  <Pressable onPress={duplicateEval} style={styles.dupBtn}>
                    <Text style={styles.dupBtnText}>↗ Duplicate</Text>
                  </Pressable>
                  <Pressable onPress={removeEval} style={styles.deleteBtn}>
                    <Text style={styles.deleteBtnText}>Delete</Text>
                  </Pressable>
                </View>
              }>
              <EvalConfig
                draft={draft}
                orchestrations={orchestrations}
                datasets={datasets}
                agents={agents}
                onChange={(patch) => {
                  setDraft(d => (d ? { ...d, ...patch } : d));
                  setDirty(true);
                }}
                onSuggestScorers={suggestScorers}
                suggestingScorers={suggestingScorers}
              />

              {aggregate && (
                <View style={styles.aggregate}>
                  <Text style={styles.aggregateLabel}>Results</Text>
                  <Text style={styles.aggregateText}>
                    {aggregate.passed} / {aggregate.total} passed (
                    {(aggregate.passRate * 100).toFixed(0)}%)
                    {aggregate.errors > 0 && ` · ${aggregate.errors} error${aggregate.errors === 1 ? '' : 's'}`}
                    {' · avg '}{(aggregate.avgDur / 1000).toFixed(1)}s/row
                  </Text>
                </View>
              )}

              {(runState.status === 'done' || runState.status === 'running') &&
                runState.results.length > 0 && (
                  <ScrollView style={styles.resultsScroll} nestedScrollEnabled>
                    {runState.results.map((r, i) => (
                      <RowResultCard key={r.rowId} index={i + 1} result={r} />
                    ))}
                  </ScrollView>
                )}
            </Card>
          )}
        </View>
      </View>
    </Page>
  );
}

function EvalConfig({
  draft,
  orchestrations,
  datasets,
  agents,
  onChange,
  onSuggestScorers,
  suggestingScorers,
}: {
  draft: Eval;
  orchestrations: Node[];
  datasets: Dataset[];
  agents: AgentFile[];
  onChange: (patch: Partial<Eval>) => void;
  onSuggestScorers?: () => void;
  suggestingScorers?: boolean;
}) {
  function addScorer(type: Scorer['type']) {
    const newScorer: Scorer =
      type === 'exact'
        ? { type: 'exact' }
        : type === 'contains'
          ? { type: 'contains', substring: '' }
          : type === 'regex'
            ? { type: 'regex', pattern: '' }
            : { type: 'llm-judge', judgeAgent: agents[0]?.name ? `agents/${agents[0].name}.md` : '', criteria: '' };
    onChange({ scorers: [...draft.scorers, newScorer] });
  }
  function updateScorer(idx: number, patch: Partial<Scorer>) {
    onChange({
      scorers: draft.scorers.map((s, i) => (i === idx ? { ...s, ...patch } as Scorer : s)),
    });
  }
  function removeScorer(idx: number) {
    onChange({ scorers: draft.scorers.filter((_, i) => i !== idx) });
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.configRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.fieldLabel}>Orchestration</Text>
          <SearchablePills
            options={orchestrations.map(o => ({ value: o.name, label: o.name }))}
            value={draft.orchestrationName}
            onChange={name => onChange({ orchestrationName: name })}
            placeholder="Search orchestrations"
            emptyText="No orchestrations in the workspace."
          />
        </View>
      </View>

      <View style={styles.configRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.fieldLabel}>Dataset</Text>
          <SearchablePills
            options={datasets.map(d => ({
              value: d.name,
              label: `${d.name} (${d.rows.length})`,
            }))}
            value={draft.datasetName}
            onChange={name => onChange({ datasetName: name })}
            placeholder="Search datasets"
            emptyText="No datasets in the workspace."
          />
        </View>
      </View>

      <View style={styles.configRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.fieldLabel}>Sample size (optional — full set if blank)</Text>
          <TextInput
            value={draft.sampleSize?.toString() ?? ''}
            onChangeText={t => {
              const n = parseInt(t, 10);
              onChange({ sampleSize: Number.isNaN(n) ? undefined : n });
            }}
            placeholder="full dataset"
            style={[styles.input, { width: 120 }]}
            keyboardType="numeric"
          />
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <View style={styles.scorersHeader}>
          <Text style={styles.fieldLabel}>Scorers</Text>
          <View style={styles.addScorerRow}>
            {(['exact', 'contains', 'regex', 'llm-judge'] as const).map(type => (
              <Pressable
                key={type}
                onPress={() => addScorer(type)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${type} scorer`}
                style={styles.addScorerBtn}>
                <Text style={styles.addScorerText}>+ {type}</Text>
              </Pressable>
            ))}
            {onSuggestScorers && (
              <Pressable
                onPress={onSuggestScorers}
                disabled={suggestingScorers}
                accessibilityRole="button"
                accessibilityLabel="Suggest scorers from dataset"
                style={[styles.suggestBtn, suggestingScorers && { opacity: 0.5 }]}>
                <Text style={styles.suggestBtnText}>
                  {suggestingScorers ? '⟳ Suggesting…' : '✨ Suggest from dataset'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
        {draft.scorers.length === 0 && (
          <Hint>No scorers — every output will pass by default. Add at least one.</Hint>
        )}
        {draft.scorers.map((s, i) => (
          <ScorerEditor
            key={i}
            scorer={s}
            agents={agents}
            onChange={p => updateScorer(i, p)}
            onDelete={() => removeScorer(i)}
          />
        ))}
      </View>
    </View>
  );
}

function ScorerEditor({
  scorer,
  agents,
  onChange,
  onDelete,
}: {
  scorer: Scorer;
  agents: AgentFile[];
  onChange: (patch: Partial<Scorer>) => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.scorerCard}>
      <View style={styles.scorerHeader}>
        <Text style={styles.scorerType}>{scorer.type}</Text>
        <Pressable onPress={onDelete} style={styles.scorerDelete}>
          <Text style={styles.scorerDeleteText}>×</Text>
        </Pressable>
      </View>
      {scorer.type === 'exact' && (
        <Hint>Pass when trimmed output === trimmed expected output.</Hint>
      )}
      {scorer.type === 'contains' && (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Substring (uses row.expectedOutput when blank)</Text>
          <TextInput
            value={(scorer as { substring?: string }).substring ?? ''}
            onChangeText={t => onChange({ substring: t } as Partial<Scorer>)}
            placeholder="success"
            style={styles.input}
          />
        </View>
      )}
      {scorer.type === 'regex' && (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Regex pattern</Text>
          <TextInput
            value={(scorer as { pattern: string }).pattern}
            onChangeText={t => onChange({ pattern: t } as Partial<Scorer>)}
            placeholder="^success.*"
            style={styles.input}
            autoCapitalize="none"
          />
          <TextInput
            value={(scorer as { flags?: string }).flags ?? ''}
            onChangeText={t => onChange({ flags: t } as Partial<Scorer>)}
            placeholder="flags (e.g. i, m, s)"
            style={[styles.input, { width: 160 }]}
            autoCapitalize="none"
          />
        </View>
      )}
      {scorer.type === 'llm-judge' && (
        <View style={{ gap: 4 }}>
          <Text style={styles.fieldLabel}>Judge agent</Text>
          <SearchablePills
            options={agents.map(a => ({
              value: `agents/${a.name}.md`,
              label: a.name,
            }))}
            value={(scorer as { judgeAgent: string }).judgeAgent}
            onChange={p => onChange({ judgeAgent: p } as Partial<Scorer>)}
            placeholder="Search agents"
            emptyText="No agents in the workspace."
          />
          <Text style={styles.fieldLabel}>Criteria (prompt sent to judge)</Text>
          <TextInput
            value={(scorer as { criteria: string }).criteria}
            onChangeText={t => onChange({ criteria: t } as Partial<Scorer>)}
            placeholder="Does the output correctly summarize the input? Reply PASS or FAIL."
            style={[styles.input, { minHeight: 50, textAlignVertical: 'top' }]}
            multiline
          />
        </View>
      )}
    </View>
  );
}

function RowResultCard({ index, result }: { index: number; result: RowResult }) {
  return (
    <View
      style={[
        styles.resultCard,
        result.error ? styles.resultCardError : result.pass ? styles.resultCardPass : styles.resultCardFail,
      ]}>
      <View style={styles.resultHeader}>
        <Text style={styles.resultIndex}>#{index}</Text>
        <Text style={styles.resultBadge}>
          {result.error ? '✗ error' : result.pass ? '✓ pass' : '✗ fail'}
        </Text>
        {result.durationMs != null && (
          <Text style={styles.resultDur}>{(result.durationMs / 1000).toFixed(1)}s</Text>
        )}
        <Text style={styles.resultScores}>
          {Object.entries(result.scores)
            .map(([k, v]) => `${k}:${v.toFixed(2)}`)
            .join(' · ')}
        </Text>
      </View>
      <Text style={styles.resultLabel}>input</Text>
      <Text style={styles.resultBody}>{truncate(result.input, 300)}</Text>
      {result.expectedOutput && (
        <>
          <Text style={styles.resultLabel}>expected</Text>
          <Text style={styles.resultBody}>{truncate(result.expectedOutput, 300)}</Text>
        </>
      )}
      <Text style={styles.resultLabel}>output</Text>
      <Text style={styles.resultBody}>{truncate(result.output ?? '(empty)', 500)}</Text>
      {result.error && (
        <>
          <Text style={styles.resultLabel}>error</Text>
          <Text style={[styles.resultBody, { color: '#b91c1c' }]}>{result.error}</Text>
        </>
      )}
    </View>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '…';
}

/** Run every llm-judge scorer in parallel by calling its judge agent
 *  with a structured prompt that includes the orchestration output +
 *  expected output + criteria. Parses the judge's reply for PASS /
 *  FAIL (case-insensitive) or a 0..1 numeric score. Failures and
 *  ambiguous replies score 0.0 — better to flag than silently pass. */
async function runJudges({
  scorers,
  output,
  expected,
  agents,
  apiKey,
  model,
  streamFn,
}: {
  scorers: Scorer[];
  output: string;
  expected: string | undefined;
  agents: AgentFile[];
  apiKey: string;
  model: string;
  streamFn: typeof streamAnthropic;
}): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < scorers.length; i++) {
    const s = scorers[i];
    if (s.type !== 'llm-judge') continue;
    const key = scorerKey(s, i);
    const agentPath = s.judgeAgent;
    const agentName = agentPath.replace(/^agents\//, '').replace(/\.md$/, '');
    const agent = agents.find(a => a.name === agentName);
    if (!agent) {
      result[key] = 0;
      continue;
    }
    const { system: systemPrompt, user: userMessage } = judgeRequest(
      s,
      agentSystemPrompt(agent.raw),
      output,
      expected,
    );

    tasks.push(
      (async () => {
        let text = '';
        try {
          for await (const ev of streamFn({
            apiKey,
            model,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          })) {
            if (ev.type === 'text-delta') text += ev.text;
          }
        } catch {
          result[key] = 0;
          return;
        }
        result[key] = parseJudgeReply(text);
      })(),
    );
  }
  await Promise.all(tasks);
  return result;
}



const styles = StyleSheet.create({
  layout: { flexDirection: 'row', flex: 1, minHeight: 500, gap: 12 },
  sidebar: {
    width: 260,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  sidebarScroll: { flex: 1 },
  sidebarEmpty: { padding: 14 },
  sidebarRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 2,
  },
  sidebarRowSelected: { backgroundColor: '#2563eb' },
  sidebarTextSelected: { color: '#ffffff' },
  sidebarMetaSelected: { color: '#bfdbfe' },
  sidebarName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  sidebarMeta: { fontSize: 11, color: '#6b7280' },
  detail: { flex: 1 },
  newBtn: {
    padding: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    alignItems: 'center',
  },
  newBtnText: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  newForm: {
    padding: 10,
    gap: 6,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  fieldLabel: { fontSize: 11, color: '#374151', fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 6 },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  saveBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  runBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#059669',
    borderRadius: 6,
  },
  runBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  btnDisabled: { opacity: 0.5 },
  deleteBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteBtnText: { color: '#b91c1c', fontWeight: '600', fontSize: 12 },
  dupBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  dupBtnText: { color: '#1d4ed8', fontWeight: '600', fontSize: 12 },
  configRow: { flexDirection: 'row', gap: 12 },
  scorersHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  addScorerRow: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  addScorerBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#ecfdf5',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  addScorerText: { fontSize: 10, color: '#065f46', fontWeight: '600' },
  suggestBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#7c3aed',
    borderRadius: 6,
  },
  suggestBtnText: { fontSize: 10, color: '#ffffff', fontWeight: '600' },
  scorerCard: {
    padding: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 6,
  },
  scorerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scorerType: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Menlo',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scorerDelete: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scorerDeleteText: { color: '#b91c1c', fontSize: 14, fontWeight: '700' },
  aggregate: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  aggregateLabel: {
    fontSize: 11,
    color: '#1e40af',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  aggregateText: { fontSize: 13, color: '#1e3a8a', marginTop: 4, fontWeight: '600' },
  resultsScroll: { maxHeight: 400, marginTop: 6 },
  resultCard: {
    padding: 10,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderLeftWidth: 4,
    gap: 4,
  },
  resultCardPass: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0', borderLeftColor: '#059669' },
  resultCardFail: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderLeftColor: '#dc2626' },
  resultCardError: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderLeftColor: '#d97706' },
  resultHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  resultIndex: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo', fontWeight: '700' },
  resultBadge: { fontSize: 11, fontWeight: '700', color: '#111827' },
  resultDur: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  resultScores: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
  resultLabel: {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  resultBody: { fontSize: 11, color: '#111827', fontFamily: 'Menlo' },
  errorText: { color: '#b91c1c', fontSize: 12 },
});
