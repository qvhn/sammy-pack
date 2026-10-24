import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  deleteDataset,
  listAgents,
  listDatasets,
  saveDataset,
  type Dataset,
  type DatasetRow,
} from '../api';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import { getApiKey, getAuthMode, getModel } from '../store/apiKey';
import { useToast } from '../store/toast';
import { Card, Hint, Page } from './Page';

/** Datasets are file-backed collections of input rows (with optional
 *  expected outputs) that the Evals page replays against orchestrations.
 *  Storage: datasets/<name>.json — git-versionable.
 *
 *  UI is a two-pane editor (iOS-Messages-style): left rail lists datasets,
 *  right pane shows rows. Add / edit / delete inline; explicit Save
 *  pushes the whole dataset to disk. */
// Description box height bounds (px): room for ~3 lines, grows to ~12.
const DESC_MIN_H = 72;
const DESC_MAX_H = 240;

export function DatasetsPage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Measured content height of the description box, tagged with the dataset
  // it was measured for so switching datasets starts again from the minimum.
  const [descMeasure, setDescMeasure] = useState<{ name: string | null; h: number }>({
    name: null,
    h: DESC_MIN_H,
  });
  const descHeight = descMeasure.name === selectedName ? descMeasure.h : DESC_MIN_H;
  const [draft, setDraft] = useState<Dataset | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const toast = useToast();

  // New-dataset form state.
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  useEffect(() => {
    listDatasets()
      .then(list => {
        setDatasets(list);
        setStatus('idle');
        if (list.length > 0 && !selectedName) setSelectedName(list[0].name);
      })
      .catch(err => {
        setError((err as Error).message);
        setStatus('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the selected name changes, snapshot it into draft for editing.
  useEffect(() => {
    if (!selectedName) {
      setDraft(null);
      setDirty(false);
      return;
    }
    const ds = datasets.find(d => d.name === selectedName);
    if (ds) {
      setDraft(JSON.parse(JSON.stringify(ds)) as Dataset);
      setDirty(false);
    }
  }, [selectedName, datasets]);

  const stats = useMemo(() => {
    if (!draft) return null;
    const tagCounts = new Map<string, number>();
    for (const r of draft.rows) {
      for (const t of r.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const expectedCount = draft.rows.filter(r => !!r.expectedOutput?.trim()).length;
    return { rowCount: draft.rows.length, tagCounts, expectedCount };
  }, [draft]);

  async function createDataset() {
    setError(null);
    const name = newName.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setError('Name must be alphanumeric + dashes/underscores');
      return;
    }
    if (datasets.find(d => d.name === name)) {
      setError(`Dataset "${name}" already exists`);
      return;
    }
    const now = Date.now();
    const ds: Dataset = {
      name,
      description: newDescription.trim() || undefined,
      rows: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await saveDataset(ds);
      setDatasets(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedName(saved.name);
      setShowNew(false);
      setNewName('');
      setNewDescription('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function save() {
    if (!draft) return;
    setStatus('saving');
    setError(null);
    try {
      const next: Dataset = { ...draft, updatedAt: Date.now() };
      const saved = await saveDataset(next);
      setDatasets(prev => prev.map(d => (d.name === saved.name ? saved : d)));
      setDirty(false);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
      toast.show(`Saved · ${next.name}`, 'success');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      toast.show(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  async function duplicateDataset() {
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
    if (datasets.find(d => d.name === next)) {
      setError(`Dataset "${next}" already exists`);
      return;
    }
    const now = Date.now();
    const copy: Dataset = {
      ...JSON.parse(JSON.stringify(draft)),
      name: next,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await saveDataset(copy);
      setDatasets(prev =>
        [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setSelectedName(saved.name);
      toast.show(`Duplicated as "${saved.name}"`, 'success');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Duplicate failed: ${(err as Error).message}`, 'error');
    }
  }

  async function removeDataset() {
    if (!draft) return;
    // Confirm via window.confirm — keeps deletion intentional without
    // pulling in a modal dependency. globalThis cast keeps the non-DOM
    // tsconfig happy.
    const g = globalThis as unknown as { confirm?: (m: string) => boolean };
    if (g.confirm && !g.confirm(`Delete dataset "${draft.name}"?`)) return;
    try {
      await deleteDataset(draft.name);
      setDatasets(prev => prev.filter(d => d.name !== draft.name));
      setSelectedName(prev =>
        prev === draft.name ? datasets.find(d => d.name !== draft.name)?.name ?? null : prev,
      );
      toast.show(`Deleted "${draft.name}"`, 'info');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Delete failed: ${(err as Error).message}`, 'error');
    }
  }

  function updateRow(rowId: string, patch: Partial<DatasetRow>) {
    setDraft(d => {
      if (!d) return d;
      return {
        ...d,
        rows: d.rows.map(r => (r.id === rowId ? { ...r, ...patch } : r)),
      };
    });
    setDirty(true);
  }

  function addRow() {
    setDraft(d => {
      if (!d) return d;
      const id = `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return { ...d, rows: [...d.rows, { id, input: '' }] };
    });
    setDirty(true);
  }

  function removeRow(rowId: string) {
    setDraft(d => (d ? { ...d, rows: d.rows.filter(r => r.id !== rowId) } : d));
    setDirty(true);
  }

  function updateDescription(text: string) {
    setDraft(d => (d ? { ...d, description: text } : d));
    setDirty(true);
  }

  async function generateRows(domain: string, count: number) {
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      throw new Error('No API key configured. Set one in Settings.');
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const agents = await listAgents();
    const designer = agents.find(a => a.name === 'dataset-row-designer');
    if (!designer) {
      throw new Error('Missing agents/dataset-row-designer.md');
    }
    const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : designer.raw).trim();
    let accum = '';
    for await (const ev of streamFn({
      apiKey,
      model,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `# DOMAIN\n\n${domain}\n\n# ROW COUNT\n\n${count}\n\nGenerate the rows now.`,
        },
      ],
    })) {
      if (ev.type === 'text-delta') accum += ev.text;
    }
    const cleaned = accum
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');
    const parsed = JSON.parse(cleaned) as Array<{
      input: string;
      expectedOutput?: string;
      tags?: string[];
    }>;
    if (!Array.isArray(parsed)) throw new Error('Output was not a JSON array');
    return parsed.map(r => ({
      id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      input: r.input ?? '',
      expectedOutput: r.expectedOutput,
      tags: r.tags,
    }));
  }

  return (
    <Page
      title="Datasets"
      subtitle="canonical inputs that pipelines + evals replay against">
      <View style={styles.layout}>
        {/* Left rail */}
        <View style={styles.sidebar}>
          <Pressable
            onPress={() => setShowNew(s => !s)}
            accessibilityRole="button"
            accessibilityLabel={showNew ? 'Cancel new dataset' : 'New dataset'}
            style={styles.newBtn}>
            <Text style={styles.newBtnText}>{showNew ? '× Cancel' : '+ New dataset'}</Text>
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
              <TextInput
                value={newDescription}
                onChangeText={setNewDescription}
                placeholder="description (optional)"
                style={styles.input}
              />
              <Pressable onPress={createDataset} style={styles.saveBtn}>
                <Text style={styles.saveBtnText}>Create</Text>
              </Pressable>
            </View>
          )}
          <ScrollView style={styles.sidebarScroll}>
            {datasets.length === 0 && (
              <View style={styles.sidebarEmpty}>
                <Hint>No datasets. Create one above.</Hint>
              </View>
            )}
            {datasets.map(ds => {
              const selected = selectedName === ds.name;
              return (
                <Pressable
                  key={ds.name}
                  onPress={() => setSelectedName(ds.name)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Dataset ${ds.name}`}
                  style={[styles.sidebarRow, selected && styles.sidebarRowSelected]}>
                  <Text
                    style={[styles.sidebarName, selected && styles.sidebarTextSelected]}
                    numberOfLines={1}>
                    {ds.name}
                  </Text>
                  <Text
                    style={[styles.sidebarMeta, selected && styles.sidebarMetaSelected]}>
                    {ds.rows.length} row{ds.rows.length === 1 ? '' : 's'}
                  </Text>
                  {ds.description ? (
                    <Text
                      style={[styles.sidebarPreview, selected && styles.sidebarMetaSelected]}
                      numberOfLines={1}>
                      {ds.description}
                    </Text>
                  ) : null}
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
          {status === 'loading' && <Hint>Loading…</Hint>}
          {!draft && status !== 'loading' && (
            <Card>
              <Hint>Select a dataset on the left, or create a new one to get started.</Hint>
            </Card>
          )}
          {draft && (
            <Card
              title={draft.name}
              subtitle={`${stats?.rowCount ?? 0} rows · ${stats?.expectedCount ?? 0} with expected output${stats && stats.tagCounts.size > 0 ? ` · ${Array.from(stats.tagCounts.entries()).map(([t, n]) => `${t}:${n}`).join(', ')}` : ''}`}
              right={
                <View style={styles.actionRow}>
                  <Pressable
                    onPress={save}
                    disabled={!dirty || status === 'saving'}
                    style={[
                      styles.saveBtn,
                      (!dirty || status === 'saving') && styles.btnDisabled,
                    ]}>
                    <Text style={styles.saveBtnText}>
                      {status === 'saving' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                    </Text>
                  </Pressable>
                  <Pressable onPress={duplicateDataset} style={styles.dupBtn}>
                    <Text style={styles.dupBtnText}>↗ Duplicate</Text>
                  </Pressable>
                  <Pressable onPress={removeDataset} style={styles.deleteBtn}>
                    <Text style={styles.deleteBtnText}>Delete</Text>
                  </Pressable>
                </View>
              }>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>Description</Text>
                {/* Grows with its content (capped, then scrolls) — a fixed
                    36px box clipped the description mid-line. */}
                <TextInput
                  key={selectedName ?? ''}
                  value={draft.description ?? ''}
                  onChangeText={updateDescription}
                  placeholder="What is this dataset for? Who maintains it?"
                  style={[
                    styles.input,
                    styles.descriptionInput,
                    { height: Math.min(DESC_MAX_H, Math.max(DESC_MIN_H, descHeight)) },
                  ]}
                  onContentSizeChange={e =>
                    setDescMeasure({
                      name: selectedName,
                      // +2: scrollHeight excludes the 1px top/bottom border.
                      h: e.nativeEvent.contentSize.height + 2,
                    })
                  }
                  numberOfLines={3}
                  multiline
                />
              </View>

              <View style={styles.rowsHeader}>
                <Text style={styles.fieldLabel}>Rows</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Pressable onPress={addRow} style={styles.addRowBtn}>
                    <Text style={styles.addRowBtnText}>+ Add row</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setGenerateOpen(true)}
                    style={styles.generateRowsBtn}>
                    <Text style={styles.generateRowsBtnText}>✨ Generate rows</Text>
                  </Pressable>
                </View>
              </View>

              {draft.rows.length === 0 ? (
                <Hint>No rows yet. Click "+ Add row" to capture your first input.</Hint>
              ) : (
                <ScrollView style={styles.rowsScroll} nestedScrollEnabled>
                  {draft.rows.map((r, idx) => (
                    <RowEditor
                      key={r.id}
                      index={idx}
                      row={r}
                      onChange={patch => updateRow(r.id, patch)}
                      onDelete={() => removeRow(r.id)}
                    />
                  ))}
                </ScrollView>
              )}
            </Card>
          )}
        </View>
      </View>
      {generateOpen && (
        <GenerateRowsModal
          onClose={() => setGenerateOpen(false)}
          onGenerate={async (domain, count) => {
            try {
              const rows = await generateRows(domain, count);
              setDraft(d => (d ? { ...d, rows: [...d.rows, ...rows] } : d));
              setDirty(true);
              setGenerateOpen(false);
              toast.show(`Generated ${rows.length} row${rows.length === 1 ? '' : 's'}`, 'success');
            } catch (err) {
              toast.show(`Generate failed: ${(err as Error).message}`, 'error');
              throw err;
            }
          }}
        />
      )}
    </Page>
  );
}

function GenerateRowsModal({
  onClose,
  onGenerate,
}: {
  onClose: () => void;
  onGenerate: (domain: string, count: number) => Promise<void>;
}) {
  const [domain, setDomain] = useState('');
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    if (!domain.trim()) {
      setError('Describe the domain first.');
      return;
    }
    setBusy(true);
    try {
      await onGenerate(domain.trim(), count);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalPanel}>
        <Text style={styles.modalTitle}>✨ Generate dataset rows</Text>
        <Text style={styles.modalHint}>
          Describe the domain or kind of inputs you want. The designer agent
          generates realistic input / expected-output pairs across happy-path,
          edge-case, and regression scenarios.
        </Text>
        <TextInput
          value={domain}
          onChangeText={setDomain}
          placeholder='Example: "summarize incident postmortems into one paragraph"'
          style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]}
          multiline
        />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text style={styles.fieldLabel}>How many rows?</Text>
          <TextInput
            value={String(count)}
            onChangeText={t => {
              const n = parseInt(t, 10);
              if (Number.isFinite(n) && n > 0 && n <= 50) setCount(n);
            }}
            style={[styles.input, { width: 60 }]}
            keyboardType="numeric"
          />
        </View>
        {error && <Text style={styles.errorText}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={go}
            disabled={busy}
            style={[styles.generateRowsBtn, busy && { opacity: 0.5 }]}>
            <Text style={styles.generateRowsBtnText}>
              {busy ? '⟳ Generating…' : '✨ Generate'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function RowEditor({
  index,
  row,
  onChange,
  onDelete,
}: {
  index: number;
  row: DatasetRow;
  onChange: (patch: Partial<DatasetRow>) => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.rowCard}>
      <View style={styles.rowCardHeader}>
        <Text style={styles.rowIndex}>#{index + 1}</Text>
        <View style={styles.rowTagInputWrap}>
          <Text style={styles.fieldLabel}>Tags</Text>
          <TextInput
            value={(row.tags ?? []).join(', ')}
            onChangeText={text =>
              onChange({
                tags: text
                  .split(',')
                  .map(t => t.trim())
                  .filter(Boolean),
              })
            }
            placeholder="train, regression"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <Pressable onPress={onDelete} style={styles.rowDelete}>
          <Text style={styles.rowDeleteText}>×</Text>
        </Pressable>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.fieldLabel}>Input</Text>
        <TextInput
          value={row.input}
          onChangeText={text => onChange({ input: text })}
          placeholder="The input to feed into the orchestration…"
          style={[styles.input, styles.textarea]}
          multiline
        />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.fieldLabel}>Expected output (optional — used by evals)</Text>
        <TextInput
          value={row.expectedOutput ?? ''}
          onChangeText={text => onChange({ expectedOutput: text })}
          placeholder="What should the orchestration produce?"
          style={[styles.input, styles.textarea]}
          multiline
        />
      </View>
    </View>
  );
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
  sidebarPreview: { fontSize: 11, color: '#374151', marginTop: 2 },
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
  textarea: { minHeight: 60, textAlignVertical: 'top', fontFamily: 'Menlo' },
  descriptionInput: { textAlignVertical: 'top', lineHeight: 18 },
  fieldLabel: { fontSize: 11, color: '#374151', fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 6 },
  saveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  saveBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
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
  generateRowsBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#7c3aed',
    borderRadius: 6,
  },
  generateRowsBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 11 },
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingTop: 80,
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
    width: 520,
    maxWidth: '90%',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
  },
  modalTitle: { fontSize: 14, fontWeight: '700', color: '#111827' },
  modalHint: { fontSize: 11, color: '#6b7280' },
  rowsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  addRowBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#ecfdf5',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  addRowBtnText: { fontSize: 11, color: '#065f46', fontWeight: '600' },
  rowsScroll: { maxHeight: 520 },
  rowCard: {
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 6,
  },
  rowCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  rowIndex: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo', paddingBottom: 8 },
  rowTagInputWrap: { flex: 1, gap: 4 },
  rowDelete: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowDeleteText: { color: '#b91c1c', fontSize: 18, fontWeight: '700', lineHeight: 18 },
  errorText: { color: '#b91c1c', fontSize: 12 },
});
