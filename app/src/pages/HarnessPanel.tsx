/** The run page's view of a harness run: the steps as a checklist, how
 *  strictly the agent must follow them (and where that came from), what the
 *  engine wants a reader to know, and the terminal handoff — take the run
 *  over in a terminal, open one, hand it back. Renders nothing for a
 *  pipeline run. */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Run } from '../store/runs';
import { followLabel } from '../llm/harness';
import {
  deriveHarnessView,
  followSourceLabel,
  harnessResumeCommand,
  type HarnessStepView,
} from '../lib/harness-view';
import { getRunTerminal, handBackToServer, takeOverInTerminal } from '../store/harness';

const MARK: Record<HarnessStepView['status'], string> = {
  pending: '○',
  active: '▶',
  done: '✓',
  skipped: '–',
  failed: '✕',
};

function describe(s: HarnessStepView): string {
  if (s.kind === 'skill') return `skill ${s.skill}`;
  if (s.kind === 'engine') return `runs as written · ${s.engineKind ?? 'step'}`;
  return 'done by the harness';
}

function copyText(text: string): Promise<void> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator;
  return nav?.clipboard ? nav.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
}

export function HarnessPanel({
  run,
  gatedPhase,
  onApproveGate,
}: {
  run: Run;
  /** The gate the run is paused at, if any. */
  gatedPhase?: string | null;
  /** Approve that gate (the run page's gate action). */
  onApproveGate?: () => void | Promise<void>;
}) {
  const view = useMemo(
    () => deriveHarnessView(run.events),
    // The events array is mutated in place — eventVersion is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run.eventVersion, run.events],
  );
  const [liveCommand, setLiveCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const terminalLive = !!view && view.driver === 'terminal' && run.status === 'running';

  // A terminal leg's command carries a one-time token: ask the server for it
  // (never in the event log). Gone when the leg ends.
  useEffect(() => {
    if (!terminalLive) {
      setLiveCommand(null);
      return;
    }
    let live = true;
    getRunTerminal(run.id)
      .then(t => live && setLiveCommand(t.command))
      .catch(() => live && setLiveCommand(null));
    return () => {
      live = false;
    };
  }, [terminalLive, run.id, view?.legs]);

  if (!view) return null;
  const done = view.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const finished = run.status === 'done' || run.status === 'cancelled';

  const takeOver = async (open: boolean, retries = 0) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await takeOverInTerminal(run.id, open);
      setLiveCommand(r.command);
      if (r.opened && !r.opened.opened) setNote(`Couldn't open a terminal: ${r.opened.reason}. Copy the command instead.`);
      else if (r.opened?.opened) setNote('Opened a terminal on the server\'s machine.');
    } catch (e) {
      // Right after a gate approval the run is still starting its next leg.
      if (retries > 0 && /409/.test((e as Error).message)) {
        await new Promise(r => setTimeout(r, 1000));
        return takeOver(open, retries - 1);
      }
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const handBack = async () => {
    setBusy(true);
    setNote(null);
    try {
      await handBackToServer(run.id);
      setLiveCommand(null);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) =>
    copyText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );

  const command = liveCommand ?? (finished ? harnessResumeCommand(view) : null);
  return (
    <View style={styles.panel} accessibilityLabel="Harness steps">
      <View style={styles.headerRow}>
        <Text style={styles.badge}>HARNESS</Text>
        <Text style={styles.title}>
          {followLabel(view.follow)}
          <Text style={styles.muted}> · {followSourceLabel(view.followSource)}</Text>
        </Text>
        <Text style={styles.muted}>
          {done}/{view.steps.length} steps{view.legs > 1 ? ` · ${view.legs} session legs` : ''}
          {terminalLive ? ' · driven from a terminal' : ''}
        </Text>
      </View>
      {view.followRefused ? (
        <Text style={styles.note}>
          This run asked for {followLabel(view.followRefused)}; the orchestration locks it at {followLabel(view.follow)}.
        </Text>
      ) : null}
      {view.steps.map(s => (
        <View key={s.key} style={styles.stepRow}>
          <Text style={[styles.mark, styles[`mark_${s.status}`]]}>{MARK[s.status]}</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepName}>
              {s.name}
              {s.gates && s.gates.length > 0 ? ' 🔒' : ''}
              {!s.required ? <Text style={styles.muted}> · optional</Text> : null}
              {s.finally ? <Text style={styles.muted}> · finalizer</Text> : null}
            </Text>
            <Text style={styles.muted}>
              {describe(s)}
              {s.group ? ` · with the other "${s.group}" steps, any order` : ''}
              {s.loop ? ` · ${s.loop}, pass ${s.pass ?? 1} of at most ${s.loopMax ?? '?'}` : ''}
            </Text>
            {s.reason ? (
              <Text style={s.status === 'failed' ? styles.failReason : styles.muted}>
                {s.status === 'skipped' ? 'Skipped' : 'Failed'}
                {s.by === 'when' ? ' (its condition was false)' : s.by === 'harness' ? ' by the harness' : ''}: {s.reason}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      {view.notices.map((n, i) => (
        <Text key={i} style={styles.note}>
          {n}
        </Text>
      ))}

      <View style={styles.terminalBox}>
        <Text style={styles.terminalLabel}>
          {terminalLive
            ? 'A terminal is driving this run. Open it with:'
            : finished
              ? 'The run is finished. Open its agent\'s conversation in a terminal, to read it or ask about it (its working copy may already be cleaned up):'
              : gatedPhase
                ? `Continue in a terminal — approve "${gatedPhase}" first, or do both at once:`
                : 'Drive this run from a terminal instead — the server\'s agent stops and the terminal continues the same session:'}
        </Text>
        {command ? (
          <Text style={styles.command} selectable>
            {command}
          </Text>
        ) : null}
        <View style={styles.buttonRow}>
          {command ? (
            <Pressable onPress={() => void copy(command)} style={styles.btn} accessibilityRole="button" accessibilityLabel="Copy the terminal command">
              <Text style={styles.btnText}>{copied ? 'Copied' : 'Copy'}</Text>
            </Pressable>
          ) : null}
          {terminalLive ? (
            <>
              <Pressable onPress={() => void takeOver(true)} disabled={busy} style={styles.btn} accessibilityRole="button" accessibilityLabel="Open in Terminal">
                <Text style={styles.btnText}>Open in Terminal</Text>
              </Pressable>
              <Pressable onPress={() => void handBack()} disabled={busy} style={styles.btn} accessibilityRole="button" accessibilityLabel="Hand back to the server">
                <Text style={styles.btnText}>Hand back to the server</Text>
              </Pressable>
            </>
          ) : finished ? null : gatedPhase ? (
            onApproveGate ? (
              <Pressable
                onPress={() => {
                  setBusy(true);
                  Promise.resolve(onApproveGate())
                    .then(() => takeOver(true, 10))
                    .catch(e => setNote((e as Error).message))
                    .finally(() => setBusy(false));
                }}
                disabled={busy}
                style={styles.btnPrimary}
                accessibilityRole="button"
                accessibilityLabel="Approve and continue in a terminal">
                <Text style={styles.btnPrimaryText}>Approve & continue in a terminal</Text>
              </Pressable>
            ) : null
          ) : (
            <>
              <Pressable onPress={() => void takeOver(true)} disabled={busy} style={styles.btnPrimary} accessibilityRole="button" accessibilityLabel="Take over in a terminal">
                <Text style={styles.btnPrimaryText}>{busy ? 'Handing over…' : 'Take over in a terminal'}</Text>
              </Pressable>
              <Pressable onPress={() => void takeOver(false)} disabled={busy} style={styles.btn} accessibilityRole="button" accessibilityLabel="Take over and copy the command">
                <Text style={styles.btnText}>Just give me the command</Text>
              </Pressable>
            </>
          )}
        </View>
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 6,
    padding: 10,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#eef2ff',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  badge: {
    fontSize: 10,
    fontWeight: '700',
    color: '#3730a3',
    backgroundColor: '#e0e7ff',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    letterSpacing: 0.5,
  },
  title: { fontSize: 13, fontWeight: '600', color: '#111827' },
  muted: { fontSize: 11, color: '#6b7280', fontWeight: '400' },
  note: { fontSize: 11, color: '#92400e' },
  stepRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  mark: { width: 14, fontSize: 13, textAlign: 'center', color: '#9ca3af' },
  mark_pending: { color: '#9ca3af' },
  mark_active: { color: '#2563eb' },
  mark_done: { color: '#059669' },
  mark_skipped: { color: '#d97706' },
  mark_failed: { color: '#dc2626' },
  stepBody: { flex: 1, gap: 1 },
  stepName: { fontSize: 13, color: '#111827' },
  failReason: { fontSize: 11, color: '#dc2626' },
  terminalBox: { gap: 6, marginTop: 4, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#c7d2fe' },
  terminalLabel: { fontSize: 11, fontWeight: '600', color: '#374151' },
  command: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
    borderRadius: 4,
    padding: 6,
  },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  btn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#ffffff',
  },
  btnText: { fontSize: 12, color: '#3730a3', fontWeight: '600' },
  btnPrimary: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 4, backgroundColor: '#4f46e5' },
  btnPrimaryText: { fontSize: 12, color: '#ffffff', fontWeight: '600' },
});
