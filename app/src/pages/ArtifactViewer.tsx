import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * In-app viewer for a run artifact (a `code.run` step's `artifact` log).
 * Fetches the artifact's text from GET /api/runs/:id/artifacts?name= and
 * shows it in a scrollable monospace panel over a full-window backdrop —
 * instead of dumping the user on the raw API URL in a new tab. "Open raw"
 * and "Download" stay available as secondary actions. JSON artifacts are
 * pretty-printed. Renders nothing while `name` is null.
 */
export function ArtifactViewer({
  name,
  url,
  onClose,
}: {
  name: string | null;
  url: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; text: string; mediaType: string }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch(url)
      .then(async res => {
        const text = await res.text();
        if (cancelled) return;
        if (!res.ok) {
          setState({ kind: 'error', message: `${res.status} ${text}`.trim() });
          return;
        }
        const mediaType = (res.headers.get('content-type') ?? 'text/plain')
          .split(';')[0]
          .trim();
        setState({ kind: 'ok', text, mediaType });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const body = useMemo(() => {
    if (state.kind !== 'ok') return '';
    if (state.mediaType.includes('json')) {
      try {
        return JSON.stringify(JSON.parse(state.text), null, 2);
      } catch {
        /* not valid JSON after all — show as-is */
      }
    }
    return state.text;
  }, [state]);

  const openRaw = () => {
    if (url) (globalThis as { open?: (u: string, t: string) => void }).open?.(url, '_blank');
  };
  const download = () => {
    const g = globalThis as unknown as {
      document?: {
        createElement(tag: string): { href: string; download: string; click(): void };
      };
    };
    if (!url || !name || !g.document) return;
    const a = g.document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  };

  return (
    <Modal transparent animationType="none" visible={name != null} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close artifact" />
        <View style={styles.panel}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.title} numberOfLines={1}>
                {name}
              </Text>
              {state.kind === 'ok' && (
                <Text style={styles.meta}>
                  {state.mediaType} · {state.text.length.toLocaleString()} chars
                </Text>
              )}
            </View>
            <Pressable onPress={openRaw} accessibilityRole="link" style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Open raw ↗</Text>
            </Pressable>
            <Pressable onPress={download} accessibilityRole="button" style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>↓ Download</Text>
            </Pressable>
            <Pressable onPress={onClose} accessibilityRole="button" style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>× Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {state.kind === 'loading' && <Text style={styles.hint}>Loading…</Text>}
            {state.kind === 'error' && (
              <Text style={styles.error}>Couldn't load the artifact: {state.message}</Text>
            )}
            {state.kind === 'ok' && (
              <Text style={styles.code} selectable>
                {body || '(empty)'}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
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
    justifyContent: 'center',
    padding: 24,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.5)',
  },
  panel: {
    width: '100%',
    maxWidth: 960,
    maxHeight: '90%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerLeft: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '700', color: '#111827', fontFamily: 'Menlo' },
  meta: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  secondaryBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  secondaryBtnText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  closeBtnText: { fontSize: 11, color: '#1d4ed8', fontWeight: '600' },
  scroll: {
    flexShrink: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    backgroundColor: '#f9fafb',
  },
  scrollContent: { padding: 10 },
  code: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 17, color: '#111827' },
  hint: { fontSize: 12, color: '#6b7280' },
  error: { fontSize: 12, color: '#b91c1c' },
});
