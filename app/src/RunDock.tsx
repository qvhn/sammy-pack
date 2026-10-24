import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRuns } from './store/runs';

/**
 * A bottom dock for the Pipelines page that surfaces the OPEN orchestration's
 * active run inline — so you can approve a lock gate (with a summary of the work
 * so far) and talk to the running agent without switching to the Runs page.
 *
 * Handles both HITL paths: a browser-executed run raises `pendingApproval`
 * (approve / reject); a server-owned run flips to status `paused` (resume /
 * cancel). The chat box steers the currently-running phase via `sendChat`.
 * Renders nothing unless the active run belongs to the open orchestration.
 */
export function RunDock({
  orchestrationName,
}: {
  orchestrationName: string | null;
}) {
  const {
    active,
    pendingApproval,
    approve,
    reject,
    resumeServerRun,
    cancelRun,
    isCancelling,
    sendChat,
  } = useRuns();
  const [draft, setDraft] = useState('');

  const isThis =
    !!active && !!orchestrationName && active.orchestrationName === orchestrationName;

  // The leaf phase currently executing (last phase-start with no matching
  // terminal) — where chat is delivered.
  const activePhase = useMemo(() => {
    if (!isThis || !active) return null;
    const open = new Set<string>();
    let last: string | null = null;
    for (const e of active.events as Array<{ type: string; phaseName?: string }>) {
      if (e.type === 'phase-start' && e.phaseName) {
        open.add(e.phaseName);
        last = e.phaseName;
      } else if (
        (e.type === 'phase-end' ||
          e.type === 'phase-error' ||
          e.type === 'phase-skipped') &&
        e.phaseName
      ) {
        open.delete(e.phaseName);
        if (last === e.phaseName) last = null;
      }
    }
    return last && open.has(last) ? last : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThis, active?.eventVersion]);

  // What the human is approving proceeding from — the most recent phase output.
  const summary = useMemo(() => {
    if (!isThis || !active) return null;
    for (let i = active.events.length - 1; i >= 0; i--) {
      const e = active.events[i] as { type: string; output?: unknown };
      if (e.type === 'phase-end' && e.output != null && String(e.output).trim())
        return String(e.output);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThis, active?.eventVersion]);

  if (!isThis || !active) return null;

  const isServerPaused = active.status === 'paused';
  const gated = !!pendingApproval || isServerPaused;
  const gatePhase = pendingApproval?.phaseName ?? activePhase ?? '';
  // Cancel is in flight for this run — the server is still reaping it, so
  // relabel + disable the Cancel button to prove the click registered.
  const cancelling = isCancelling(active.id);

  const send = () => {
    const t = draft.trim();
    if (t && activePhase) {
      sendChat(activePhase, t);
      setDraft('');
    }
  };

  return (
    <View style={[styles.dock, gated && styles.dockGated]}>
      <Text style={styles.title}>
        {gated
          ? '🔒 Awaiting your approval'
          : `▶ Running${activePhase ? ` · ${activePhase}` : ''}`}
      </Text>

      {gated && (
        <View style={styles.gate}>
          {gatePhase ? (
            <Text style={styles.gateText}>
              before <Text style={styles.gateName}>{gatePhase}</Text>
            </Text>
          ) : null}
          {summary && (
            <Text style={styles.summary} numberOfLines={6}>
              {summary.length > 500 ? `${summary.slice(0, 500)}…` : summary}
            </Text>
          )}
          <View style={styles.btns}>
            <Pressable
              onPress={pendingApproval ? reject : cancelRun}
              disabled={cancelling}
              style={[
                styles.btn,
                styles.btnSecondary,
                cancelling && styles.btnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled: cancelling }}
              accessibilityLabel={cancelling ? 'Cancelling run' : 'Cancel run'}>
              <Text style={styles.btnSecondaryText}>
                {cancelling ? 'Cancelling…' : 'Cancel run'}
              </Text>
            </Pressable>
            <Pressable
              onPress={pendingApproval ? approve : resumeServerRun}
              style={[styles.btn, styles.btnPrimary]}
              accessibilityRole="button"
              accessibilityLabel="Approve and continue">
              <Text style={styles.btnPrimaryText}>Continue ▸</Text>
            </Pressable>
          </View>
        </View>
      )}

      {activePhase && (
        <View style={styles.chatRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message "${activePhase}"…  (steers the agent on its next turn)`}
            placeholderTextColor="#9ca3af"
            style={styles.chatInput}
            autoCapitalize="none"
            onSubmitEditing={send}
          />
          <Pressable
            onPress={send}
            style={styles.sendBtn}
            accessibilityRole="button"
            accessibilityLabel="Send message to the running agent">
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  dockGated: { backgroundColor: '#fffbeb', borderTopColor: '#f59e0b' },
  title: { fontSize: 12, fontWeight: '700', color: '#374151' },
  gate: { gap: 6 },
  gateText: { fontSize: 12, color: '#92400e' },
  gateName: { fontFamily: 'Menlo', fontWeight: '700' },
  summary: {
    fontSize: 12,
    color: '#78350f',
    fontFamily: 'Menlo',
    lineHeight: 17,
    backgroundColor: '#fffaf0',
    borderRadius: 6,
    padding: 8,
  },
  btns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  btn: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 6 },
  btnSecondary: { borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#ffffff' },
  btnSecondaryText: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnPrimaryText: { fontSize: 12, color: '#ffffff', fontWeight: '700' },
  chatRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  chatInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  sendBtn: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#2563eb',
  },
  sendText: { fontSize: 13, color: '#ffffff', fontWeight: '700' },
});
