import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { listAgents, saveAgent, type AgentFile } from '../api';
import { Markdown } from '../Markdown';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import {
  getAllowAgentTools,
  getApiKey,
  getAuthMode,
  getModel,
} from '../store/apiKey';
import { useToast } from '../store/toast';
import { Card, Hint, Page, SectionTitle } from './Page';

/** Test a single agent in isolation. Pick from the registered agent
 *  library, type a prompt, hit run — see streamed output + final
 *  token counts. The fastest path to "does this agent do what I
 *  think it does?" without wiring up a full orchestration.
 *
 *  Reuses the existing streamFn dispatch (direct-API or Claude
 *  Code proxy) + auth toggles, so behavior matches what the agent
 *  will see when invoked from a real run. */
export function PlaygroundPage() {
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  // Filter the agent picker — the library can hold hundreds, so a flat wall
  // of chips is unusable without search.
  const [agentQuery, setAgentQuery] = useState('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  } | null>(null);
  const toast = useToast();
  const [refineOpen, setRefineOpen] = useState(false);

  useEffect(() => {
    listAgents()
      .then(list => {
        setAgents(list);
        if (list.length > 0 && !agentName) setAgentName(list[0].name);
      })
      .catch(err => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agent = useMemo(
    () => agents.find(a => a.name === agentName) ?? null,
    [agents, agentName],
  );

  const systemPrompt = useMemo(() => {
    if (!agent) return '';
    const m = agent.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    return (m ? m[1] : agent.raw).trim();
  }, [agent]);

  async function run() {
    if (!agent) return;
    setError(null);
    setOutput('');
    setUsage(null);
    setStatus('running');
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured. Set one in Settings, or switch to Claude Code login mode.');
      setStatus('error');
      return;
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const allowAgentTools = authMode === 'claude-code-proxy' && getAllowAgentTools();
    const startMs = Date.now();
    let accum = '';
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const ev of streamFn({
        apiKey,
        model,
        system: systemPrompt,
        messages: [
          { role: 'user', content: prompt.trim() || `Run as the "${agent.name}" agent.` },
        ],
        // Reuse the agent-tools opt-in from Settings so playground
        // calls behave the same as production runs.
        tools: allowAgentTools ? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] : undefined,
      })) {
        if (ev.type === 'text-delta') {
          accum += ev.text;
          setOutput(accum);
        } else if (ev.type === 'done') {
          inputTokens = ev.usage.inputTokens;
          outputTokens = ev.usage.outputTokens;
        }
      }
      setUsage({ inputTokens, outputTokens, durationMs: Date.now() - startMs });
      setStatus('done');
      toast.show(`Done · ${inputTokens}t in / ${outputTokens}t out`, 'success');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      toast.show('Run failed — see error below', 'error');
    }
  }

  function clear() {
    setOutput('');
    setUsage(null);
    setStatus('idle');
    setError(null);
  }

  return (
    <Page
      title="Playground"
      subtitle="test a single agent with an arbitrary prompt — no orchestration needed">
      <Hint>
        Pick an agent + write a prompt. The system prompt is loaded from the
        agent's markdown body; you provide just the user turn. Useful for
        debugging an agent's system prompt before wiring it into a pipeline.
      </Hint>

      <SectionTitle>Agent</SectionTitle>
      <Card>
        {agents.length === 0 ? (
          <Hint>No agents available. Import or create some on the Agents page.</Hint>
        ) : (
          (() => {
            const q = agentQuery.trim().toLowerCase();
            const matches = q
              ? agents.filter(a => a.name.toLowerCase().includes(q))
              : agents;
            const CAP = 60;
            const shown = matches.slice(0, CAP);
            return (
              <>
                {agents.length > 12 && (
                  <TextInput
                    value={agentQuery}
                    onChangeText={setAgentQuery}
                    placeholder={`Search ${agents.length} agents…`}
                    placeholderTextColor="#9ca3af"
                    style={styles.agentSearch}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                )}
                <View style={styles.chipRow}>
                  {shown.map(a => (
                    <Pressable
                      key={a.name}
                      onPress={() => setAgentName(a.name)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: agentName === a.name }}
                      accessibilityLabel={`Agent ${a.name}`}
                      style={[
                        styles.chip,
                        agentName === a.name && styles.chipActive,
                      ]}>
                      <Text
                        style={[
                          styles.chipText,
                          agentName === a.name && styles.chipTextActive,
                        ]}>
                        {a.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {matches.length > CAP && (
                  <Hint>
                    Showing {CAP} of {matches.length} — refine the search to narrow.
                  </Hint>
                )}
                {q && matches.length === 0 && (
                  <Hint>No agents match "{agentQuery.trim()}".</Hint>
                )}
              </>
            );
          })()
        )}
        {agent && (
          <View style={styles.systemPromptBox}>
            <Text style={styles.systemLabel}>system prompt</Text>
            <ScrollView style={styles.systemScroll} nestedScrollEnabled>
              <Text style={styles.systemText} selectable>
                {systemPrompt.slice(0, 1200)}
                {systemPrompt.length > 1200 && '\n…'}
              </Text>
            </ScrollView>
          </View>
        )}
      </Card>

      <SectionTitle>Prompt</SectionTitle>
      <Card>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What's the user turn? e.g., 'Summarize the following: ...'"
          style={styles.promptInput}
          multiline
          autoCorrect={false}
        />
        <View style={styles.actionRow}>
          <Pressable
            onPress={run}
            disabled={status === 'running' || !agent}
            style={[
              styles.runBtn,
              (status === 'running' || !agent) && { opacity: 0.5 },
            ]}>
            <Text style={styles.runBtnText}>
              {status === 'running' ? '⟳ Running…' : '▶ Run'}
            </Text>
          </Pressable>
          <Pressable onPress={clear} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
          {usage && (
            <Text style={styles.usage}>
              {usage.inputTokens}t in / {usage.outputTokens}t out ·{' '}
              {(usage.durationMs / 1000).toFixed(1)}s
            </Text>
          )}
          {status === 'done' && agent && (
            <Pressable
              onPress={() => setRefineOpen(true)}
              style={styles.refineBtn}>
              <Text style={styles.refineBtnText}>✨ Refine prompt</Text>
            </Pressable>
          )}
        </View>
      </Card>

      {error && (
        <Card>
          <Text style={styles.error}>Error: {error}</Text>
        </Card>
      )}

      {(output || status === 'running') && (
        <>
          <SectionTitle>Output</SectionTitle>
          <Card>
            <ScrollView style={styles.outputScroll} nestedScrollEnabled>
              {output ? (
                <Markdown source={output} />
              ) : (
                <Hint>(waiting for first token…)</Hint>
              )}
            </ScrollView>
          </Card>
        </>
      )}

      {refineOpen && agent && (
        <RefinePromptModal
          agent={agent}
          disappointingOutput={output}
          onClose={() => setRefineOpen(false)}
          onSaved={updated => {
            setAgents(prev => prev.map(a => (a.name === updated.name ? updated : a)));
            toast.show(`Saved refined "${updated.name}"`, 'success');
            setRefineOpen(false);
          }}
        />
      )}
    </Page>
  );
}

/** Take the current agent + the user's critique of a disappointing
 *  output, run the prompt-refiner agent, save the revised system
 *  prompt back to the agent's .md file. Bookends the "test → iterate
 *  → save" loop without leaving Playground. */
function RefinePromptModal({
  agent,
  disappointingOutput,
  onClose,
  onSaved,
}: {
  agent: AgentFile;
  disappointingOutput: string;
  onClose: () => void;
  onSaved: (updated: AgentFile) => void;
}) {
  const [critique, setCritique] = useState('');
  const [revised, setRevised] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setRevised('');
    if (!critique.trim()) {
      setError('Describe what was wrong with the output.');
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
    const agents = await listAgents();
    const refiner = agents.find(a => a.name === 'prompt-refiner');
    if (!refiner) {
      setError('Missing agents/prompt-refiner.md');
      return;
    }
    const m = refiner.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : refiner.raw).trim();
    setStatus('generating');
    let accum = '';
    try {
      for await (const ev of streamFn({
        apiKey,
        model,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `# CURRENT AGENT\n\n${agent.raw}\n\n# CRITIQUE\n\n${critique.trim()}\n\n# DISAPPOINTING OUTPUT\n\n${disappointingOutput.trim() || '(no output captured)'}\n\nRevise the agent now.`,
          },
        ],
      })) {
        if (ev.type === 'text-delta') {
          accum += ev.text;
          setRevised(accum);
        }
      }
      const cleaned = accum
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      setRevised(cleaned);
      setStatus('done');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function save() {
    if (!revised) return;
    try {
      const saved = await saveAgent(agent.name, revised);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { width: 720, maxHeight: 760 }]}>
        <Text style={styles.modalTitle}>✨ Refine "{agent.name}" prompt</Text>
        <Text style={styles.modalHint}>
          The refiner reads the current agent + your critique of the most-recent
          output + (optionally) the output itself, then emits a tightened
          system prompt that targets the failure mode without breaking what
          worked.
        </Text>
        <Text style={styles.modalLabel}>What was wrong with the output?</Text>
        <TextInput
          value={critique}
          onChangeText={setCritique}
          placeholder={`Example: "Too verbose — wandered into background that wasn't asked for. Should answer in 2 sentences max."`}
          style={[styles.modalInput, { minHeight: 100 }]}
          multiline
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <Pressable
            onPress={generate}
            disabled={status === 'generating'}
            style={[styles.refineBtn, status === 'generating' && { opacity: 0.5 }]}>
            <Text style={styles.refineBtnText}>
              {status === 'generating' ? '⟳ Refining…' : '✨ Generate revision'}
            </Text>
          </Pressable>
          {status === 'done' && (
            <Pressable
              onPress={save}
              style={[styles.refineBtn, { backgroundColor: '#059669' }]}>
              <Text style={styles.refineBtnText}>+ Save to {agent.name}.md</Text>
            </Pressable>
          )}
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
        {(revised || status === 'generating') && (
          <ScrollView nestedScrollEnabled style={styles.outputBox}>
            <Text style={styles.outputText} selectable>
              {revised || '(waiting for first token…)'}
            </Text>
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  agentSearch: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#f9fafb',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  chipActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  chipText: { fontSize: 12, color: '#374151' },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  systemPromptBox: {
    marginTop: 10,
    backgroundColor: '#0f172a',
    borderRadius: 6,
    padding: 8,
    gap: 4,
  },
  systemLabel: {
    fontSize: 9,
    color: '#94a3b8',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  systemScroll: { maxHeight: 200 },
  systemText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#e2e8f0',
    lineHeight: 14,
  },
  promptInput: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 10,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
    textAlignVertical: 'top',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  runBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#059669',
    borderRadius: 6,
  },
  runBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
  },
  clearBtnText: { color: '#374151', fontWeight: '600', fontSize: 12 },
  usage: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  error: { color: '#b91c1c', fontSize: 12 },
  outputScroll: { maxHeight: 480 },
  refineBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#7c3aed',
    borderRadius: 6,
  },
  refineBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingTop: 60,
    zIndex: 100,
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
  },
  modalPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
  },
  modalTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  modalHint: { fontSize: 11, color: '#6b7280' },
  modalLabel: { fontSize: 11, color: '#374151', fontWeight: '600', marginTop: 4 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
    textAlignVertical: 'top',
  },
  outputBox: {
    marginTop: 8,
    maxHeight: 320,
    backgroundColor: '#020617',
    borderRadius: 6,
    padding: 8,
  },
  outputText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#e2e8f0',
    lineHeight: 14,
  },
});
