/** "Browse…" for the Run dialog's repository field: click through the
 *  folders on the server's machine (GET /api/repos/browse) and pick one,
 *  instead of typing its path.
 *
 *  - Click a folder to select it; click it again (or ›) to open it.
 *  - The path bar takes a typed path; ↑ goes to the folder above.
 *  - Git repositories carry a badge.
 *  - "Select folder" picks the selected folder, or the open one if none.
 *  - Escape closes the picker, not the Run dialog. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { browseDirs, type DirListing } from './api';

/** Two presses on the same folder within this many ms open it. */
const DOUBLE_PRESS_MS = 400;

export function FolderPicker({
  start,
  onPick,
  onClose,
}: {
  /** Folder to open first (the field's current value); the server's default when empty. */
  start?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(start ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastPress = useRef<{ path: string; at: number } | null>(null);

  const open = useCallback(async (dir?: string, fallback = false) => {
    setLoading(true);
    setError(null);
    try {
      const l = await browseDirs(dir);
      setListing(l);
      setTyped(l.path);
      setSelected(null);
    } catch (err) {
      // A start folder that no longer exists (or can't be browsed) falls back
      // to the default rather than leaving the picker empty.
      if (fallback && dir) return open(undefined);
      setError(friendly((err as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A repository URL typed into the field is no folder: start at the default.
    const local = start?.trim() && !/^[a-z][a-z0-9+.-]*:\/\/|^[\w.-]+@[\w.-]+:/i.test(start.trim());
    open(local ? start!.trim() : undefined, true);
  }, [open, start]);

  useEffect(() => {
    const g = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: { key?: string }) => void) => void;
      removeEventListener?: (t: string, fn: (e: { key?: string }) => void) => void;
    };
    if (!g.addEventListener || !g.removeEventListener) return;
    const onKey = (e: { key?: string }) => {
      if (e.key === 'Escape') onClose();
    };
    g.addEventListener('keydown', onKey);
    return () => g.removeEventListener?.('keydown', onKey);
  }, [onClose]);

  const press = (path: string) => {
    const now = Date.now();
    const prev = lastPress.current;
    lastPress.current = { path, at: now };
    if (prev && prev.path === path && now - prev.at < DOUBLE_PRESS_MS) {
      lastPress.current = null;
      open(path);
    } else {
      setSelected(path);
    }
  };

  const choice = selected ?? listing?.path ?? null;

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose a repository folder</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close folder picker">
            <Text style={styles.close}>×</Text>
          </Pressable>
        </View>

        <View style={styles.pathRow}>
          <Pressable
            onPress={() => listing?.parent && open(listing.parent)}
            disabled={!listing?.parent || loading}
            style={[styles.iconButton, (!listing?.parent || loading) && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Up one folder">
            <Text style={styles.iconText}>↑</Text>
          </Pressable>
          <TextInput
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={() => open(typed)}
            placeholder="/path/to/folder"
            style={styles.pathInput}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Folder path"
          />
          <Pressable
            onPress={() => open(typed)}
            disabled={loading}
            style={[styles.goButton, loading && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Go to this path">
            <Text style={styles.goText}>Go</Text>
          </Pressable>
        </View>

        {listing ? (
          <View style={styles.chipRow}>
            {listing.roots.map(r => (
              <Pressable
                key={r.path}
                onPress={() => open(r.path)}
                style={[styles.chip, listing.path === r.path && styles.chipOn]}
                accessibilityRole="button"
                accessibilityLabel={`Go to ${r.label}`}>
                <Text style={[styles.chipText, listing.path === r.path && styles.chipTextOn]}>{r.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <ScrollView style={styles.list}>
          {loading && !listing ? <Text style={styles.empty}>Loading…</Text> : null}
          {listing && listing.entries.length === 0 ? <Text style={styles.empty}>No folders here.</Text> : null}
          {listing?.entries.map(e => {
            const on = selected === e.path;
            return (
              <Pressable
                key={e.path}
                onPress={() => press(e.path)}
                style={[styles.row, on && styles.rowOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${e.name}${e.git ? ', git repository' : ''}`}>
                <Text style={styles.folderIcon}>📁</Text>
                <Text style={[styles.rowName, on && styles.rowNameOn]} numberOfLines={1}>
                  {e.name}
                </Text>
                {e.git ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>git</Text>
                  </View>
                ) : null}
                <Pressable
                  onPress={() => open(e.path)}
                  style={styles.openButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${e.name}`}>
                  <Text style={styles.openText}>›</Text>
                </Pressable>
              </Pressable>
            );
          })}
          {listing?.truncated ? (
            <Text style={styles.empty}>Showing the first {listing.entries.length} folders. Type a path to go further.</Text>
          ) : null}
        </ScrollView>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.footer}>
          <Text style={styles.choice} numberOfLines={1}>
            {choice ?? ''}
          </Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={onClose}
              style={[styles.button, styles.secondaryButton]}
              accessibilityRole="button"
              accessibilityLabel="Cancel">
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => choice && onPick(choice)}
              disabled={!choice}
              style={[styles.button, styles.primaryButton, !choice && styles.disabled]}
              accessibilityRole="button"
              accessibilityLabel="Select folder">
              <Text style={styles.primaryButtonText}>Select folder</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

/** "403 Forbidden: <server message>" → "<server message>". */
function friendly(message: string): string {
  return /^\d{3}[^:]*:\s*(.+)$/s.exec(message)?.[1] ?? message;
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.35)',
  },
  panel: {
    width: '92%',
    maxWidth: 560,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    gap: 10,
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 16, fontWeight: '700', color: '#111827' },
  close: { fontSize: 24, color: '#6b7280', paddingHorizontal: 8, lineHeight: 24 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 16, color: '#374151' },
  pathInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#111827',
    fontFamily: 'monospace',
  },
  goButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: '#eff6ff' },
  goText: { color: '#1d4ed8', fontWeight: '600', fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  chipOn: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  chipText: { fontSize: 12, color: '#374151' },
  chipTextOn: { color: '#1d4ed8', fontWeight: '600' },
  list: {
    height: 300,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
  },
  empty: { fontSize: 13, color: '#6b7280', padding: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  rowOn: { backgroundColor: '#eff6ff' },
  folderIcon: { fontSize: 14 },
  rowName: { flex: 1, fontSize: 14, color: '#111827' },
  rowNameOn: { color: '#1d4ed8', fontWeight: '600' },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: '#fff7ed', borderWidth: 1, borderColor: '#fdba74' },
  badgeText: { fontSize: 11, color: '#c2410c', fontWeight: '600' },
  openButton: { paddingHorizontal: 8, paddingVertical: 2 },
  openText: { fontSize: 18, color: '#6b7280' },
  error: { fontSize: 12, color: '#dc2626' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  choice: { flex: 1, fontSize: 12, color: '#6b7280', fontFamily: 'monospace' },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 6 },
  secondaryButton: { borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#ffffff' },
  secondaryButtonText: { color: '#374151', fontWeight: '600', fontSize: 14 },
  primaryButton: { backgroundColor: '#2563eb' },
  primaryButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.5 },
});
