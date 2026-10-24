import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  listAgents,
  listDatasets,
  listEvals,
  listOrchestrations,
} from './api';
import type { PageId } from './Sidebar';

/** Cmd/Ctrl+K palette. Quick switcher for every kind of named
 *  resource in the workspace — pipelines, agents, datasets, evals
 *  — plus the named pages themselves. Filter via type-ahead. Enter
 *  on the top result navigates; arrow keys move selection.
 *
 *  Lazy loads when first opened so we don't pay for the lists when
 *  the user never invokes the palette. */
type Entry = {
  kind: 'pipeline' | 'agent' | 'dataset' | 'eval' | 'page';
  name: string;
  hint?: string;
  pageId: PageId;
};

const PAGE_ENTRIES: Entry[] = [
  { kind: 'page', name: 'Pipelines', pageId: 'pipelines', hint: 'orchestration editor' },
  { kind: 'page', name: 'Agents', pageId: 'agents', hint: 'agent definitions' },
  { kind: 'page', name: 'Playground', pageId: 'playground', hint: 'try an agent solo' },
  { kind: 'page', name: 'Datasets', pageId: 'datasets', hint: 'I/O fixtures' },
  { kind: 'page', name: 'Evals', pageId: 'evals', hint: 'score orchestrations' },
  { kind: 'page', name: 'Schemas', pageId: 'schemas', hint: 'JSON schema viewer' },
  { kind: 'page', name: 'Runs', pageId: 'runs', hint: 'history + traces' },
  { kind: 'page', name: 'Queue', pageId: 'queue', hint: 'waiting on the concurrency cap' },
  { kind: 'page', name: 'Notifications', pageId: 'notifications', hint: 'run outcomes + recovery' },
  { kind: 'page', name: 'Observability', pageId: 'observability', hint: 'analytics' },
  { kind: 'page', name: 'Token & Cost', pageId: 'cost', hint: 'spend per run + per agent' },
  { kind: 'page', name: 'Connections', pageId: 'connections', hint: 'OAuth tokens' },
  { kind: 'page', name: 'Workspaces', pageId: 'workspaces', hint: 'data sources' },
  { kind: 'page', name: 'Settings', pageId: 'settings', hint: 'API + model' },
];

export function CommandPalette({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entry[]>(PAGE_ENTRIES);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<TextInput | null>(null);

  // Global Cmd/Ctrl+K toggle + Esc close.
  useEffect(() => {
    function onKey(e: {
      metaKey?: boolean;
      ctrlKey?: boolean;
      key?: string;
      preventDefault(): void;
    }) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(o => !o);
        setQuery('');
        setSelectedIdx(0);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    // RN-Web tsconfig doesn't include DOM types; the runtime ships
    // them. Cast for compile-time, no runtime change.
    const g = globalThis as unknown as {
      addEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
      removeEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
    };
    g.addEventListener('keydown', onKey as (e: KeyboardEvent) => void);
    return () => g.removeEventListener('keydown', onKey as (e: KeyboardEvent) => void);
  }, [open]);

  // Lazy-load the lists the first time the palette opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      listOrchestrations().catch(() => []),
      listAgents().catch(() => []),
      listDatasets().catch(() => []),
      listEvals().catch(() => []),
    ]).then(([orchs, agents, datasets, evals]) => {
      if (cancelled) return;
      const all: Entry[] = [
        ...PAGE_ENTRIES,
        ...orchs.map(o => ({
          kind: 'pipeline' as const,
          name: o.name,
          hint: o.description ?? '',
          pageId: 'pipelines' as PageId,
        })),
        ...agents.map(a => ({
          kind: 'agent' as const,
          name: a.name,
          hint: 'agents/' + a.name + '.md',
          pageId: 'agents' as PageId,
        })),
        ...datasets.map(d => ({
          kind: 'dataset' as const,
          name: d.name,
          hint: `${d.rows.length} row${d.rows.length === 1 ? '' : 's'}`,
          pageId: 'datasets' as PageId,
        })),
        ...evals.map(e => ({
          kind: 'eval' as const,
          name: e.name,
          hint: `${e.orchestrationName} × ${e.datasetName}`,
          pageId: 'evals' as PageId,
        })),
      ];
      setEntries(all);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      e =>
        e.name.toLowerCase().includes(q) ||
        e.hint?.toLowerCase().includes(q) ||
        e.kind.includes(q),
    );
  }, [entries, query]);

  // Reset selection when filtered list shrinks below current index.
  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(0);
  }, [filtered.length, selectedIdx]);

  // Arrow-key navigation within the palette.
  useEffect(() => {
    if (!open) return;
    function onKey(e: {
      metaKey?: boolean;
      ctrlKey?: boolean;
      key?: string;
      preventDefault(): void;
    }) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(i => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = filtered[selectedIdx];
        if (pick) {
          onNavigate(pick.pageId);
          setOpen(false);
        }
      }
    }
    // RN-Web tsconfig doesn't include DOM types; the runtime ships
    // them. Cast for compile-time, no runtime change.
    const g = globalThis as unknown as {
      addEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
      removeEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
    };
    g.addEventListener('keydown', onKey as (e: KeyboardEvent) => void);
    return () => g.removeEventListener('keydown', onKey as (e: KeyboardEvent) => void);
  }, [open, filtered, selectedIdx, onNavigate]);

  // Auto-focus the input on open.
  useEffect(() => {
    if (open) {
      const g = globalThis as unknown as {
        setTimeout?: (fn: () => void, ms: number) => void;
      };
      g.setTimeout?.(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;
  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.kbd}>⌘K</Text>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Jump to anything — pages, pipelines, agents, datasets, evals…"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <ScrollView style={styles.list} nestedScrollEnabled>
          {filtered.length === 0 && (
            <Text style={styles.dim}>No matches for "{query}"</Text>
          )}
          {filtered.slice(0, 60).map((e, i) => {
            const sel = i === selectedIdx;
            return (
              <Pressable
                key={`${e.kind}:${e.name}`}
                onPress={() => {
                  onNavigate(e.pageId);
                  setOpen(false);
                }}
                onHoverIn={() => setSelectedIdx(i)}
                style={[styles.row, sel && styles.rowSelected]}>
                <Text style={[styles.kindTag, styles[`kindTag_${e.kind}`]]}>
                  {e.kind}
                </Text>
                <Text style={[styles.name, sel && styles.nameSelected]}>
                  {e.name}
                </Text>
                {e.hint && (
                  <Text
                    style={[styles.hint, sel && styles.hintSelected]}
                    numberOfLines={1}>
                    {e.hint}
                  </Text>
                )}
              </Pressable>
            );
          })}
          {filtered.length > 60 && (
            <Text style={styles.dim}>
              … {filtered.length - 60} more — type to narrow
            </Text>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <Text style={styles.footerHint}>↑ ↓ navigate · ⏎ open · esc close</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingTop: 80,
    zIndex: 1000,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
  },
  panel: {
    width: 600,
    maxWidth: '90%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  kbd: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'Menlo',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  input: { flex: 1, fontSize: 14, color: '#111827', outlineStyle: 'none' as unknown as undefined },
  list: { maxHeight: 420 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
  },
  rowSelected: { backgroundColor: '#eff6ff' },
  kindTag: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    minWidth: 56,
    textAlign: 'center',
  },
  kindTag_page: { backgroundColor: '#f3f4f6', color: '#6b7280' },
  kindTag_pipeline: { backgroundColor: '#dbeafe', color: '#1d4ed8' },
  kindTag_agent: { backgroundColor: '#fef3c7', color: '#b45309' },
  kindTag_dataset: { backgroundColor: '#dcfce7', color: '#15803d' },
  kindTag_eval: { backgroundColor: '#fce7f3', color: '#be185d' },
  name: { fontSize: 13, color: '#111827', fontWeight: '500' },
  nameSelected: { fontWeight: '700' },
  hint: { fontSize: 11, color: '#6b7280', flex: 1, fontFamily: 'Menlo' },
  hintSelected: { color: '#475569' },
  dim: { fontSize: 12, color: '#9ca3af', padding: 14 },
  footer: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#f9fafb',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  footerHint: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
});
