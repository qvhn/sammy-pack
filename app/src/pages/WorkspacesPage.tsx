import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { deleteWorkspace, listWorkspaces, saveWorkspace } from '../api';
import { hasConnection, type ConnectionType } from '../store/connections';
import { useToast } from '../store/toast';
import { getActiveWorkspace, setActiveWorkspace } from '../store/workspace';
import type { Workspace } from '../types';
import { Card, Hint, Page, SectionTitle } from './Page';
import { SearchablePills } from './SearchablePills';

const CONNECTION_TYPES = [
  'local',
  'github',
  'bitbucket',
  'gitlab',
  'jira',
  'linear',
  'figma',
  'notion',
  'slack',
];

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Workspace | null>(getActiveWorkspace());
  // Map of workspace name → in-progress draft. Presence means "editing".
  const [editing, setEditing] = useState<Record<string, Workspace>>({});
  const [creating, setCreating] = useState<Workspace | null>(null);
  const toast = useToast();

  useEffect(() => {
    refresh();
  }, []);

  function refresh() {
    setLoading(true);
    listWorkspaces()
      .then(setWorkspaces)
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  function activate(ws: Workspace | null) {
    setActiveWorkspace(ws);
    setActive(ws);
    // Reload so all data-loading components re-fetch from the new source.
    const g = globalThis as unknown as {
      setTimeout?: (fn: () => void, ms: number) => void;
      location?: { reload(): void };
    };
    g.setTimeout?.(() => g.location?.reload(), 150);
  }

  async function saveDraft(draft: Workspace, isNew: boolean) {
    setError(null);
    if (!/^[a-zA-Z0-9_-]+$/.test(draft.name)) {
      setError('Name must be alphanumeric + dashes/underscores');
      return;
    }
    if (
      isNew &&
      workspaces.some(w => w.name === draft.name)
    ) {
      setError(`Workspace "${draft.name}" already exists`);
      return;
    }
    try {
      const saved = await saveWorkspace(draft);
      setWorkspaces(prev => {
        const without = prev.filter(w => w.name !== saved.name);
        return [...without, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
      setEditing(prev => {
        const next = { ...prev };
        delete next[draft.name];
        return next;
      });
      setCreating(null);
      toast.show(`Saved workspace "${saved.name}"`, 'success');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  async function removeWorkspace(name: string) {
    const g = globalThis as unknown as { confirm?: (m: string) => boolean };
    if (g.confirm && !g.confirm(`Delete workspace "${name}"?`)) return;
    try {
      await deleteWorkspace(name);
      setWorkspaces(prev => prev.filter(w => w.name !== name));
      if (active?.name === name) activate(null);
      toast.show(`Deleted workspace "${name}"`, 'info');
    } catch (err) {
      setError((err as Error).message);
      toast.show(`Delete failed: ${(err as Error).message}`, 'error');
    }
  }

  return (
    <Page
      title="Workspaces"
      subtitle="pointers to where your data lives (which repo, branch, paths)">
      <Hint>
        Workspaces are JSON files in <Text style={styles.code}>context/</Text>. Each
        one describes a data source agents may read from. Activate a workspace to
        load orchestrations and agents from it instead of the local dev workspace.
        Combined with a Connection (which holds the auth), they give an agent the
        location AND access it needs.
      </Hint>
      {error && (
        <Card>
          <Text style={styles.errorText}>{error}</Text>
        </Card>
      )}

      <SectionTitle>Active workspace</SectionTitle>
      <Card
        title={active ? active.name : 'local (dev workspace)'}
        subtitle={
          active
            ? `${active.connection} · ${active.repo}@${active.ref ?? 'default'}`
            : 'Reading directly from this repo via the Vite dev middleware.'
        }
        right={
          active && (
            <Pressable onPress={() => activate(null)} style={styles.deactivateButton}>
              <Text style={styles.deactivateButtonText}>Switch to local</Text>
            </Pressable>
          )
        }
      />

      <SectionTitle>Defined workspaces</SectionTitle>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {!creating && (
          <Pressable
            onPress={() =>
              setCreating({
                name: '',
                description: '',
                connection: 'github',
                repo: '',
                ref: '',
                paths: {},
              })
            }
            style={styles.newButton}>
            <Text style={styles.newButtonText}>+ New workspace</Text>
          </Pressable>
        )}
      </View>

      {creating && (
        <Card title="New workspace">
          <WorkspaceForm
            draft={creating}
            onChange={setCreating}
            onSave={() => saveDraft(creating, true)}
            onCancel={() => setCreating(null)}
          />
        </Card>
      )}

      {loading && <Hint>Loading…</Hint>}

      {!loading && workspaces.length === 0 && (
        <Card>
          <Text style={styles.empty}>No workspaces defined yet.</Text>
          <Hint>Click "+ New workspace" above to register one.</Hint>
        </Card>
      )}

      {workspaces.map(w => {
        const isActive = active?.name === w.name;
        const needsAuth =
          w.connection !== 'local' &&
          !hasConnection(w.connection as ConnectionType);
        const editDraft = editing[w.name];
        return (
          <Card
            key={w.name}
            title={w.name}
            subtitle={w.description}
            right={
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {!editDraft &&
                  (isActive ? (
                    <Text style={styles.activeBadge}>active</Text>
                  ) : (
                    <Pressable
                      onPress={() => activate(w)}
                      disabled={needsAuth}
                      accessibilityRole="button"
                      accessibilityLabel={`Activate workspace ${w.name}`}
                      style={[
                        styles.activateButton,
                        needsAuth && styles.activateDisabled,
                      ]}>
                      <Text style={styles.activateButtonText}>
                        {needsAuth ? 'needs token' : 'Activate'}
                      </Text>
                    </Pressable>
                  ))}
                {!editDraft && (
                  <Pressable
                    onPress={() =>
                      setEditing(prev => ({ ...prev, [w.name]: { ...w } }))
                    }
                    style={styles.editButton}>
                    <Text style={styles.editButtonText}>Edit</Text>
                  </Pressable>
                )}
                {!editDraft && (
                  <Pressable
                    onPress={() => removeWorkspace(w.name)}
                    style={styles.deleteButton}>
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </Pressable>
                )}
              </View>
            }>
            {editDraft ? (
              <WorkspaceForm
                draft={editDraft}
                onChange={next =>
                  setEditing(prev => ({ ...prev, [w.name]: next }))
                }
                onSave={() => saveDraft(editDraft, false)}
                onCancel={() =>
                  setEditing(prev => {
                    const next = { ...prev };
                    delete next[w.name];
                    return next;
                  })
                }
              />
            ) : (
              <>
                <View style={styles.kvRow}>
                  <Text style={styles.k}>connection</Text>
                  <Text style={styles.v}>{w.connection}</Text>
                </View>
                {w.repo && (
                  <View style={styles.kvRow}>
                    <Text style={styles.k}>repo</Text>
                    <Text style={styles.v}>{w.repo}</Text>
                  </View>
                )}
                {w.ref && (
                  <View style={styles.kvRow}>
                    <Text style={styles.k}>ref</Text>
                    <Text style={styles.v}>{w.ref}</Text>
                  </View>
                )}
                {w.paths &&
                  Object.entries(w.paths).map(([k, v]) => (
                    <View key={k} style={styles.kvRow}>
                      <Text style={styles.k}>{k}</Text>
                      <Text style={styles.v}>{v}</Text>
                    </View>
                  ))}
                {needsAuth && (
                  <Hint>Configure a {w.connection} token in Connections first.</Hint>
                )}
              </>
            )}
          </Card>
        );
      })}
    </Page>
  );
}

function WorkspaceForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Workspace;
  onChange: (next: Workspace) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          value={draft.name}
          onChangeText={t => onChange({ ...draft, name: t })}
          placeholder="my-workspace"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>Description</Text>
        <TextInput
          value={draft.description ?? ''}
          onChangeText={t => onChange({ ...draft, description: t })}
          placeholder="What's this workspace for?"
          style={styles.input}
        />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>Connection</Text>
        <SearchablePills
          options={CONNECTION_TYPES.map(c => ({ value: c, label: c }))}
          value={draft.connection}
          onChange={c => onChange({ ...draft, connection: c as ConnectionType })}
          placeholder="Search connections"
        />
      </View>
      {draft.connection !== 'local' && (
        <>
          <View style={{ gap: 4 }}>
            <Text style={styles.label}>Repo (owner/name or similar)</Text>
            <TextInput
              value={draft.repo ?? ''}
              onChangeText={t => onChange({ ...draft, repo: t })}
              placeholder="my-org/my-repo"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={{ gap: 4 }}>
            <Text style={styles.label}>Ref (branch or tag, optional)</Text>
            <TextInput
              value={draft.ref ?? ''}
              onChangeText={t => onChange({ ...draft, ref: t })}
              placeholder="main"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </>
      )}
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>Path mappings (JSON object, optional)</Text>
        <TextInput
          value={JSON.stringify(draft.paths ?? {}, null, 2)}
          onChangeText={t => {
            try {
              const parsed = JSON.parse(t || '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                onChange({ ...draft, paths: parsed });
              }
            } catch {
              // Ignore mid-typing parse errors; commit only valid JSON.
            }
          }}
          placeholder={'{\n  "agents": "agents",\n  "orchestrations": "examples"\n}'}
          style={[styles.input, { fontFamily: 'Menlo', fontSize: 11, minHeight: 80, textAlignVertical: 'top' }]}
          multiline
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={onSave} style={styles.saveButton}>
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.deactivateButton}>
          <Text style={styles.deactivateButtonText}>Cancel</Text>
        </Pressable>
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
  empty: { fontSize: 13, color: '#374151', fontWeight: '500' },
  errorText: { color: '#b91c1c', fontSize: 12 },
  kvRow: { flexDirection: 'row', gap: 8 },
  k: { fontSize: 11, color: '#6b7280', width: 80, fontWeight: '600' },
  v: { fontFamily: 'Menlo', fontSize: 11, color: '#111827', flex: 1 },
  activateButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  activateButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 11 },
  activateDisabled: { backgroundColor: '#9ca3af' },
  editButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  editButtonText: { color: '#1d4ed8', fontWeight: '600', fontSize: 11 },
  deleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fee2e2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteButtonText: { color: '#b91c1c', fontWeight: '600', fontSize: 11 },
  deactivateButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
  },
  deactivateButtonText: { color: '#374151', fontWeight: '600', fontSize: 11 },
  activeBadge: {
    fontSize: 10,
    color: '#059669',
    backgroundColor: '#d1fae5',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  newButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  newButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  label: { fontSize: 11, color: '#374151', fontWeight: '600' },
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
  saveButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  saveButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
});
