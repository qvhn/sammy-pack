import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  deleteAgent,
  listAgents,
  saveAgent,
  type AgentFile,
} from '../api';
import { VersionHistoryPanel } from '../VersionHistoryPanel';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import { getApiKey, getAuthMode, getModel } from '../store/apiKey';
import { useToast } from '../store/toast';
import { Card, Hint, Page, SectionTitle } from './Page';

// Multi-word component prefixes that shouldn't be split on the first '-'.
const TWO_WORD_COMPONENTS = ['user-profile', 'order-history'];

/** Component bucket for an agent, derived from its `component-role` name. */
function agentGroup(name: string): string {
  for (const p of TWO_WORD_COMPONENTS) {
    if (name === p || name.startsWith(p + '-')) return p;
  }
  return name.split('-')[0] || name;
}

/** Group agents by component; collapse singletons into a "general" bucket so
 *  the one-off template/util agents (pm, dev, adapters, judges…) don't each
 *  become a noisy single-item group. */
function groupAgents(
  agents: AgentFile[],
): Array<{ key: string; agents: AgentFile[] }> {
  const map = new Map<string, AgentFile[]>();
  for (const a of agents) {
    const g = agentGroup(a.name);
    const list = map.get(g);
    if (list) list.push(a);
    else map.set(g, [a]);
  }
  const general: AgentFile[] = [];
  const groups: Array<{ key: string; agents: AgentFile[] }> = [];
  for (const [key, list] of map) {
    if (list.length === 1) general.push(list[0]);
    else groups.push({ key, agents: list });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));
  if (general.length) {
    general.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ key: 'general', agents: general });
  }
  return groups;
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Which agent's version history panel is open. Null = none.
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  // Edit drafts keyed by agent name. Presence means the card is in
  // edit mode; absence means read-only display.
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  // Search + per-group collapse — the library can hold hundreds of agents,
  // so a flat list is unusable. Default: all groups collapsed; a search
  // expands everything and filters by name.
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toast = useToast();

  useEffect(() => {
    listAgents()
      .then(setAgents)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function save(name: string) {
    const draft = editing[name];
    if (draft == null) return;
    setSaving(name);
    setError(null);
    try {
      const saved = await saveAgent(name, draft);
      setAgents(prev => prev.map(a => (a.name === name ? saved : a)));
      setEditing(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      toast.show(`Saved agent "${name}"`, 'success');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Save failed: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(null);
    }
  }

  async function remove(name: string) {
    const g = globalThis as unknown as { confirm?: (m: string) => boolean };
    if (g.confirm && !g.confirm(`Delete agent "${name}"?`)) return;
    try {
      await deleteAgent(name);
      setAgents(prev => prev.filter(a => a.name !== name));
      toast.show(`Deleted "${name}"`, 'info');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Delete failed: ${(err as Error).message}`, 'error');
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(a => a.name.toLowerCase().includes(q))
    : agents;
  const groups = groupAgents(filtered);

  const renderAgent = (a: AgentFile) => {
    const firstLine =
      a.raw
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('---') && !l.startsWith('#')) ??
      '';
    const open = historyOpen === a.name;
    const draft = editing[a.name];
    const isEditing = draft != null;
    return (
      <Card
        key={a.name}
        title={a.name}
        subtitle={firstLine.slice(0, 140)}
        right={
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {!isEditing && (
              <Pressable
                onPress={() => setEditing(prev => ({ ...prev, [a.name]: a.raw }))}
                style={styles.editBtn}>
                <Text style={styles.editBtnText}>✎ Edit</Text>
              </Pressable>
            )}
            {isEditing && (
              <Pressable
                onPress={() => save(a.name)}
                disabled={saving === a.name}
                style={[styles.saveBtn, saving === a.name && { opacity: 0.5 }]}>
                <Text style={styles.saveBtnText}>
                  {saving === a.name ? 'Saving…' : 'Save'}
                </Text>
              </Pressable>
            )}
            {isEditing && (
              <Pressable
                onPress={() =>
                  setEditing(prev => {
                    const next = { ...prev };
                    delete next[a.name];
                    return next;
                  })
                }
                style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setHistoryOpen(open ? null : a.name)}
              style={styles.historyBtn}>
              <Text style={styles.historyBtnText}>
                {open ? '× close' : '↻ history'}
              </Text>
            </Pressable>
            <Pressable onPress={() => remove(a.name)} style={styles.deleteBtn}>
              <Text style={styles.deleteBtnText}>Delete</Text>
            </Pressable>
          </View>
        }>
        <Text style={styles.path}>agents/{a.name}.md</Text>
        {isEditing && (
          <TextInput
            value={draft}
            onChangeText={t => setEditing(prev => ({ ...prev, [a.name]: t }))}
            multiline
            style={styles.editor}
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {open && (
          <VersionHistoryPanel
            scope="agents"
            name={a.name}
            currentContent={a.raw}
          />
        )}
      </Card>
    );
  };

  return (
    <Page
      title="Agents"
      subtitle="reusable agent definitions referenced by orchestrations">
      <Hint>
        Each agent is a markdown file in <Text style={styles.code}>agents/</Text> with a
        frontmatter block declaring its role, expected I/O, and tool allowlist.
        Pipelines reference them by path (e.g.{' '}
        <Text style={styles.code}>agents/pm.md</Text>). Click ✎ Edit to modify any
        agent — writes through to disk; imported (symlinked) agents update their
        origin file in the source repo.
      </Hint>

      <SectionTitle>Library</SectionTitle>
      <View style={{ flexDirection: 'row' }}>
        <Pressable
          onPress={() => setGenerateOpen(true)}
          style={styles.generateBtn}>
          <Text style={styles.generateBtnText}>✨ Generate agent from role</Text>
        </Pressable>
      </View>
      {generateOpen && (
        <GenerateAgentModal
          existingNames={new Set(agents.map(a => a.name))}
          onClose={() => setGenerateOpen(false)}
          onCreate={async (name, raw) => {
            try {
              const saved = await saveAgent(name, raw);
              setAgents(prev =>
                [...prev.filter(a => a.name !== saved.name), saved].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              toast.show(`Generated agent "${saved.name}"`, 'success');
              setGenerateOpen(false);
            } catch (err) {
              toast.show(`Save failed: ${(err as Error).message}`, 'error');
            }
          }}
        />
      )}

      {loading && <Hint>Loading…</Hint>}
      {error && <Hint>Error: {error}</Hint>}

      {!loading && agents.length === 0 && (
        <Card>
          <Text style={styles.empty}>No agents yet.</Text>
          <Hint>
            Add a markdown file to <Text style={styles.code}>agents/</Text> in this
            repo to register one.
          </Hint>
        </Card>
      )}

      {!loading && agents.length > 0 && (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${agents.length} agents…`}
          placeholderTextColor="#9ca3af"
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {groups.map(group => {
        // A search auto-expands every matching group; otherwise honor the
        // per-group collapse state (collapsed by default).
        const isOpen = !!q || openGroups.has(group.key);
        return (
          <View key={group.key} style={styles.group}>
            <Pressable
              onPress={() =>
                setOpenGroups(prev => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })
              }
              accessibilityRole="button"
              accessibilityState={{ expanded: isOpen }}
              accessibilityLabel={`${group.key} agents (${group.agents.length})`}
              style={styles.groupHeader}>
              <Text style={styles.groupChevron}>{isOpen ? '▾' : '▸'}</Text>
              <Text style={styles.groupName}>{group.key}</Text>
              <Text style={styles.groupCount}>{group.agents.length}</Text>
            </Pressable>
            {isOpen && group.agents.map(renderAgent)}
          </View>
        );
      })}
      {q !== '' && groups.length === 0 && (
        <Hint>No agents match "{query.trim()}".</Hint>
      )}
    </Page>
  );
}

function GenerateAgentModal({
  existingNames,
  onClose,
  onCreate,
}: {
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (name: string, raw: string) => Promise<void>;
}) {
  const [role, setRole] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [parsedName, setParsedName] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setOutput('');
    setParsedName(null);
    if (!role.trim()) {
      setError('Describe the role first.');
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
    let designer: AgentFile | undefined;
    try {
      const all = await listAgents();
      designer = all.find(a => a.name === 'agent-designer');
    } catch (err) {
      setError(`Failed to load designer: ${(err as Error).message}`);
      return;
    }
    if (!designer) {
      setError('Missing agents/agent-designer.md — re-pull the workspace.');
      return;
    }
    const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : designer.raw).trim();
    setStatus('generating');
    let accum = '';
    try {
      for await (const ev of streamFn({
        apiKey,
        model,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `# ROLE\n\n${role.trim()}\n\nWrite the agent markdown now.` },
        ],
      })) {
        if (ev.type === 'text-delta') {
          accum += ev.text;
          setOutput(accum);
        }
      }
      // Pull the agent name out of the frontmatter.
      const cleaned = accum
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      const nameMatch = cleaned.match(/^---\r?\n[\s\S]*?\bname:\s*(\S+)/);
      let name = nameMatch?.[1]?.trim() ?? '';
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        setError('Output frontmatter did not include a safe-name "name" field.');
        setStatus('error');
        return;
      }
      while (existingNames.has(name)) {
        name = `${name}-${Math.random().toString(36).slice(2, 5)}`;
      }
      setParsedName(name);
      setOutput(cleaned);
      setStatus('done');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { maxHeight: 720, width: 700 }]}>
        <Text style={styles.modalTitle}>✨ Generate agent from role</Text>
        <Text style={styles.modalHint}>
          Describe the role. The designer emits a markdown file with the
          frontmatter + system prompt that fits sammy-pack conventions.
        </Text>
        <TextInput
          value={role}
          onChangeText={setRole}
          placeholder={
            'Example: "QA engineer who runs the Maestro suite, writes structured bug reports tagged by severity, and refuses to write code fixes."'
          }
          style={styles.modalInput}
          multiline
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <Pressable
            onPress={generate}
            disabled={status === 'generating'}
            style={[styles.generateBtn, status === 'generating' && { opacity: 0.5 }]}>
            <Text style={styles.generateBtnText}>
              {status === 'generating' ? '⟳ Generating…' : '✨ Generate'}
            </Text>
          </Pressable>
          {status === 'done' && parsedName && (
            <Pressable
              onPress={() => onCreate(parsedName, output)}
              style={[styles.generateBtn, { backgroundColor: '#059669' }]}>
              <Text style={styles.generateBtnText}>+ Save as "{parsedName}"</Text>
            </Pressable>
          )}
        </View>
        {error && <Text style={styles.modalError}>{error}</Text>}
        {(output || status === 'generating') && (
          <ScrollView nestedScrollEnabled style={styles.outputBox}>
            <Text style={styles.outputText} selectable>
              {output || '(waiting for first token…)'}
            </Text>
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  code: {
    fontFamily: 'Menlo',
    fontSize: 11,
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  path: { fontFamily: 'Menlo', fontSize: 11, color: '#9ca3af' },
  empty: { fontSize: 13, color: '#374151', fontWeight: '500' },
  search: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  group: { marginBottom: 4 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
  },
  groupChevron: { fontSize: 11, color: '#6b7280', width: 12 },
  groupName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    fontFamily: 'Menlo',
  },
  groupCount: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    backgroundColor: '#e5e7eb',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  historyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  historyBtnText: { fontSize: 11, color: '#1d4ed8', fontWeight: '600' },
  editBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  editBtnText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  saveBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  saveBtnText: { fontSize: 11, color: '#ffffff', fontWeight: '600' },
  cancelBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#ffffff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  cancelBtnText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  deleteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteBtnText: { fontSize: 11, color: '#b91c1c', fontWeight: '600' },
  editor: {
    minHeight: 280,
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#111827',
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 10,
    textAlignVertical: 'top',
    marginTop: 4,
  },
  generateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#7c3aed',
    borderRadius: 6,
  },
  generateBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
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
  modalInput: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
    textAlignVertical: 'top',
  },
  modalError: { color: '#b91c1c', fontSize: 11 },
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
