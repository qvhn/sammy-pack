/** "Continue in terminal" on the Runs page: one press opens a terminal (cmux
 *  when installed, else Terminal — Settings chooses) with the run's Claude
 *  Code session resumed, instead of finding the session id for
 *  `claude --resume` by hand.
 *
 *  - A harness run is taken over: the terminal drives it, and the harness
 *    panel's "Hand back" returns it to the server.
 *  - A pipeline run continues one agent step's conversation — `phase`, or
 *    else the latest step that has one — forked, so the run is unaffected.
 *    A step row's button (`phase`) does that in a harness run too.
 *
 *  When no window can be opened (the server is on another machine, or no
 *  terminal app answered), the command is copied to paste instead. */

import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { Run } from '../store/runs';
import { continueStepInTerminal, takeOverInTerminal, type TerminalOpened } from '../store/harness';
import { stepSessions } from '../lib/step-session';
import { useToast } from '../store/toast';

/** Run statuses a harness takeover can start from (the route's rule). */
const HARNESS_TAKEOVER = new Set(['running', 'paused', 'interrupted', 'error']);

function isHarnessRun(run: Run): boolean {
  return run.events.some(e => e.type === 'harness-start');
}

/** Whether the run has anything to continue in a terminal. */
export function canContinueInTerminal(run: Run): boolean {
  return isHarnessRun(run) ? HARNESS_TAKEOVER.has(run.status) : stepSessions(run.events).length > 0;
}

function copyText(text: string): Promise<void> {
  const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator;
  return nav?.clipboard ? nav.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
}

export function ContinueInTerminalButton({
  run,
  phase,
  compact,
}: {
  run: Run;
  /** Pipeline runs: the step to continue (default: the latest). */
  phase?: string;
  /** A small link for a step row instead of a header button. */
  compact?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const onPress = async () => {
    setBusy(true);
    try {
      let command: string;
      let opened: TerminalOpened | undefined;
      let what: string;
      if (!phase && isHarnessRun(run)) {
        const r = await takeOverInTerminal(run.id, true);
        ({ command, opened } = r);
        what = 'the run';
      } else {
        const r = await continueStepInTerminal(run.id, phase, true);
        ({ command, opened } = r);
        what = `"${r.phase}"`;
      }
      if (opened?.opened) {
        toast.show(`Opened ${what} in ${opened.app ?? 'a terminal'}.`, 'success');
      } else {
        const why = opened?.reason ? ` (${opened.reason})` : '';
        await copyText(command).then(
          () => toast.show(`Couldn't open a terminal${why}. Command copied — paste it in a terminal.`, 'info', { durationMs: 6000 }),
          () => toast.show(`Couldn't open a terminal${why}. Run: ${command}`, 'info', { durationMs: 12000 }),
        );
      }
    } catch (e) {
      toast.show((e as Error).message, 'error', { durationMs: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={phase ? `Continue ${phase} in a terminal` : 'Continue in a terminal'}
      style={[compact ? styles.link : styles.button, busy && styles.busy]}>
      <Text style={compact ? styles.linkText : styles.buttonText}>
        {busy ? 'Opening…' : compact ? 'Continue in terminal' : '⌨ Continue in terminal'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  buttonText: { fontSize: 11, color: '#1e40af', fontWeight: '600' },
  link: { alignSelf: 'flex-start', paddingVertical: 3 },
  linkText: { fontSize: 11, color: '#2563eb', fontWeight: '600' },
  busy: { opacity: 0.6 },
});
