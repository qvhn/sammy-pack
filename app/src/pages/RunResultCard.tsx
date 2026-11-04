/** The Result card: what a run produced, on the page where you look for it.
 *
 *  It answers three questions in order — did it work, what did it make, what
 *  next — for each way a run can stand:
 *
 *  - finished (or finished with issues): the best link the steps wrote (a
 *    pull request first) with Open ↗, the branch and step count, and the last
 *    step's answer, folded, with Copy;
 *  - waiting at a gate: the step held, the last answer so far, and the gate's
 *    decisions (approve, request changes, reject) with an optional note;
 *  - failed: the step and the error, what finished, and a retry from the last
 *    finished step;
 *  - running: a thin strip with the step running now;
 *  - cancelled: a grey line.
 *
 *  Everything shown comes from lib/run-result (derived from the run's events),
 *  so the card works for runs recorded before it existed. The page decides
 *  which actions exist by passing their handlers. */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRuns, type Run } from '../store/runs';
import { requestRun } from '../store/runSelection';
import { decideGate } from '../api';
import {
  deriveRunResult,
  formatCost,
  formatDuration,
  displayText,
  linkKindLabel,
  type ResultLink,
  type RunResult,
} from '../lib/run-result';
import { canContinueInTerminal, ContinueInTerminalButton } from './ContinueInTerminal';
import { useToast } from '../store/toast';

export type GateDecision = 'approve' | 'reject' | 'request-changes';

/** The answer folds to this many lines until "Show all". */
const FOLDED_LINES = 6;

export function RunResultCard({
  run,
  onDismiss,
  onViewRun,
  onRunAgain,
  onRetryFrom,
  onGate,
  terminal = true,
}: {
  run: Run;
  /** Offer Continue in terminal (off where the page already does). */
  terminal?: boolean;
  /** Finished, failed and cancelled cards can be put away. */
  onDismiss?: () => void;
  onViewRun?: () => void;
  onRunAgain?: () => void;
  /** Fork at a finished step: replays what came before it and runs it and
   *  everything after again. Offered on a failed run. */
  onRetryFrom?: (phase: string) => void;
  /** Decide the gate a waiting run is held at. Rejects to show the error. */
  onGate?: (decision: GateDecision, message?: string) => void | Promise<void>;
}) {
  const now = useTicker(run.status === 'running' || run.status === 'paused');
  const result = useMemo(
    () => deriveRunResult(run, now),
    // `run.events` is mutated in place; eventVersion says when it grew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, run.eventVersion, run.events, run.status, now],
  );

  switch (result.state) {
    case 'running':
      return <RunningStrip result={result} onViewRun={onViewRun} />;
    case 'waiting':
      return <WaitingCard run={run} result={result} onViewRun={onViewRun} onGate={onGate} />;
    case 'cancelled':
      return (
        <View style={[styles.card, styles.cardCancelled]}>
          <Header
            label="⊘ Cancelled"
            color={colors.grey}
            meta={meta(result)}
            onDismiss={onDismiss}
          />
          {result.hero && <Hero link={result.hero} neutral />}
          {(onViewRun || onRunAgain) && (
            <Actions>
              {onViewRun && <Button label="View run" onPress={onViewRun} />}
              {onRunAgain && <Button label="↻ Run again" onPress={onRunAgain} />}
            </Actions>
          )}
        </View>
      );
    case 'failed':
      return (
        <FailedCard
          run={run}
          result={result}
          terminal={terminal}
          onDismiss={onDismiss}
          onViewRun={onViewRun}
          onRetryFrom={onRetryFrom}
        />
      );
    default:
      return (
        <FinishedCard
          run={run}
          result={result}
          terminal={terminal}
          onDismiss={onDismiss}
          onViewRun={onViewRun}
          onRunAgain={onRunAgain}
        />
      );
  }
}

// ─── The Pipelines page's card ───────────────────────────────────────────

const DISMISSED_KEY = 'sammy.dismissedRunResults';
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const storage = (): Store | undefined =>
  (globalThis as { localStorage?: Store }).localStorage;

function readDismissed(): string[] {
  try {
    const v = storage()?.getItem(DISMISSED_KEY);
    const parsed = v ? (JSON.parse(v) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    storage()?.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-200)));
  } catch {
    /* storage unavailable (private mode, native) — the card just comes back
       on reload. */
  }
}

/** The latest run of `orchestrationName` as a Result card — the one this tab
 *  is driving, else the newest in history. Hidden once dismissed; a newer
 *  run shows again. */
export function PipelineRunResult({
  orchestrationName,
  onViewRun,
  onRunAgain,
  onRetried,
}: {
  orchestrationName: string;
  /** Open the Runs page (the run is already requested). */
  onViewRun: () => void;
  onRunAgain?: () => void;
  /** A retry started — where to go next. */
  onRetried?: () => void;
}) {
  const { active, history, hydrateRun, gateServerRun, forkServerRun } = useRuns();
  const toast = useToast();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const run =
    active && active.orchestrationName === orchestrationName
      ? active
      : (history.find(r => r.orchestrationName === orchestrationName) ?? null);

  // A history row arrives as a summary (no events); fetch them once it is
  // settled. A live run's events stream in already.
  const runId = run?.id ?? null;
  const needsEvents = !!run && run.events.length === 0 && run.status !== 'running';
  useEffect(() => {
    if (runId && needsEvents) hydrateRun(runId);
  }, [runId, needsEvents, hydrateRun]);

  const dismiss = useCallback(() => {
    if (!runId) return;
    setDismissed(prev => {
      const next = prev.includes(runId) ? prev : [...prev, runId];
      writeDismissed(next);
      return next;
    });
  }, [runId]);

  if (!run || dismissed.includes(run.id)) return null;

  const view = () => {
    requestRun(run.id);
    onViewRun();
  };
  const gate = async (decision: GateDecision, message?: string) => {
    // This tab's own run: decide through the store so the live stream
    // re-attaches. Any other run: the gate endpoint, like the Runs page.
    if (active && active.id === run.id) gateServerRun(decision, message);
    else await decideGate(run.id, decision, message);
    toast.show(
      decision === 'approve'
        ? `Approved "${orchestrationName}" — resuming`
        : decision === 'reject'
          ? `Rejected "${orchestrationName}" — run cancelled`
          : `Requested changes on "${orchestrationName}" — revising…`,
      decision === 'approve' ? 'success' : 'info',
    );
  };
  const retry = (phase: string) => {
    if (forkServerRun(run.id, phase)) onRetried?.();
    else toast.show('The retry did not start.', 'error');
  };

  return (
    <RunResultCard
      run={run}
      onDismiss={dismiss}
      onViewRun={view}
      // A run already going in this tab blocks starting another.
      onRunAgain={active ? undefined : onRunAgain}
      onRetryFrom={active ? undefined : retry}
      onGate={gate}
    />
  );
}

/** Re-render once a second while a run is live, so its clock moves. */
function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [live]);
  return now;
}

function meta(result: RunResult, suffix = ''): string {
  return `${formatDuration(result.durationMs)} · ${formatCost(result.costUsd)}${suffix}`;
}

function FinishedCard({
  run,
  result,
  terminal,
  onDismiss,
  onViewRun,
  onRunAgain,
}: {
  run: Run;
  result: RunResult;
  terminal: boolean;
  onDismiss?: () => void;
  onViewRun?: () => void;
  onRunAgain?: () => void;
}) {
  const degraded = result.state === 'degraded';
  const steps =
    result.stepsDone > 0
      ? `${result.stepsDone} step${result.stepsDone === 1 ? '' : 's'}${
          result.approvals > 0
            ? ` · ${result.approvals} approval${result.approvals === 1 ? '' : 's'}`
            : ''
        }`
      : null;
  return (
    <View style={[styles.card, degraded ? styles.cardAmber : styles.cardGreen]}>
      <Header
        label={degraded ? '⚠ Finished with issues' : '✓ Finished'}
        color={degraded ? colors.amber : colors.green}
        meta={meta(result)}
        onDismiss={onDismiss}
      />
      {degraded && (
        <View style={[styles.note, styles.noteAmber]}>
          {result.degradationReasons.map((r, i) => (
            <Text key={i} style={styles.noteAmberText}>
              <Text style={styles.bold}>{r.phase}</Text> — {r.reason}
            </Text>
          ))}
        </View>
      )}
      {result.hero && <Hero link={result.hero} neutral={degraded} />}
      <Chips>
        {result.branches.map(b => (
          <Chip key={b} label="Branch" value={b} />
        ))}
        {steps && <Chip value={steps} />}
        {result.artifacts > 0 && (
          <Chip value={`${result.artifacts} artifact${result.artifacts === 1 ? '' : 's'}`} />
        )}
        {result.links.slice(0, 3).map(l => (
          <LinkChip key={l.url} link={l} />
        ))}
      </Chips>
      {result.output && (
        <OutputBox title={`Final output · ${result.output.phaseName}`} text={result.output.text} />
      )}
      <Actions>
        {onViewRun && <Button label="View run" onPress={onViewRun} />}
        {onRunAgain && <Button label="↻ Run again" onPress={onRunAgain} />}
        {terminal && canContinueInTerminal(run) && <ContinueInTerminalButton run={run} />}
      </Actions>
    </View>
  );
}

function FailedCard({
  run,
  result,
  terminal,
  onDismiss,
  onViewRun,
  onRetryFrom,
}: {
  run: Run;
  result: RunResult;
  terminal: boolean;
  onDismiss?: () => void;
  onViewRun?: () => void;
  onRetryFrom?: (phase: string) => void;
}) {
  const label = result.interrupted
    ? `⚠ Interrupted${result.failedPhase ? ` at ${result.failedPhase}` : ''}`
    : `✕ Failed${result.failedPhase ? ` at ${result.failedPhase}` : ''}`;
  const retryFrom = result.forkPoints[result.forkPoints.length - 1];
  const partial = result.output && result.output.phaseName === result.failedPhase;
  return (
    <View style={[styles.card, styles.cardRed]}>
      <Header label={label} color={colors.red} meta={meta(result)} onDismiss={onDismiss} />
      {result.error ? (
        <View style={[styles.note, styles.noteRed]}>
          <Text style={styles.noteRedText} numberOfLines={4}>
            {result.error}
          </Text>
        </View>
      ) : null}
      {/* A step may have opened the PR before a later one failed. */}
      {result.hero && <Hero link={result.hero} neutral />}
      <Chips>
        {result.doneSteps.length > 0 && (
          <Chip label="Done" value={result.doneSteps.join(', ')} />
        )}
        {result.branches.map(b => (
          <Chip key={b} label="Branch" value={b} />
        ))}
      </Chips>
      {result.output && (
        <OutputBox
          title={`${partial ? 'Last output' : 'Last answer'} · ${result.output.phaseName}${
            partial ? ' (partial)' : ''
          }`}
          text={result.output.text}
        />
      )}
      <Actions>
        {onRetryFrom && retryFrom && (
          <Button
            label={`↻ Retry from ${retryFrom}`}
            hint={`Reuses what came before ${retryFrom} and runs it and everything after again`}
            kind="primary"
            onPress={() => onRetryFrom(retryFrom)}
          />
        )}
        {onViewRun && <Button label="View run" onPress={onViewRun} />}
        {terminal && canContinueInTerminal(run) && <ContinueInTerminalButton run={run} />}
      </Actions>
    </View>
  );
}

function WaitingCard({
  run,
  result,
  onViewRun,
  onGate,
}: {
  run: Run;
  result: RunResult;
  onViewRun?: () => void;
  onGate?: (decision: GateDecision, message?: string) => void | Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<GateDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pausedAt = useMemo(() => {
    for (let i = run.events.length - 1; i >= 0; i--) {
      const e = run.events[i] as { type: string; ts?: number };
      if (e.type === 'run-paused' && typeof e.ts === 'number') return e.ts;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.eventVersion, run.events]);
  const gated = result.gatedPhase;

  const decide = async (decision: GateDecision) => {
    if (!onGate) return;
    setBusy(decision);
    setError(null);
    try {
      await onGate(decision, note.trim() || undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const since = pausedAt ? ` · paused ${formatDuration(Date.now() - pausedAt)} ago` : '';
  return (
    <View style={[styles.card, styles.cardBlue]}>
      <Header
        label={gated ? '⏸ Waiting for you' : '⏸ Paused'}
        subtitle={gated ? `${gated} needs your approval` : 'waiting on a timer or a signal'}
        color={colors.blue}
        meta={`${formatCost(result.costUsd)} so far${since}`}
      />
      {result.output && (
        <OutputBox
          title={`Last answer · ${result.output.phaseName}`}
          text={result.output.text}
          folded={4}
        />
      )}
      {gated && onGate && (
        <>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={`Optional note for ${gated} (required to request changes)`}
            placeholderTextColor="#9ca3af"
            multiline
            style={styles.noteInput}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      )}
      <Actions>
        {gated && onGate && (
          <>
            <Button
              label={busy === 'approve' ? 'Approving…' : '✓ Approve'}
              kind="primary"
              disabled={!!busy}
              onPress={() => { decide('approve').catch(() => undefined); }}
            />
            <Button
              label={busy === 'request-changes' ? 'Sending…' : 'Request changes'}
              disabled={!!busy || !note.trim()}
              onPress={() => { decide('request-changes').catch(() => undefined); }}
            />
            <Button
              label={busy === 'reject' ? 'Rejecting…' : 'Reject'}
              kind="danger"
              disabled={!!busy}
              onPress={() => { decide('reject').catch(() => undefined); }}
            />
          </>
        )}
        <View style={styles.spacer} />
        {onViewRun && <Button label="View run" onPress={onViewRun} />}
      </Actions>
    </View>
  );
}

function RunningStrip({ result, onViewRun }: { result: RunResult; onViewRun?: () => void }) {
  const total = result.stepsTotal;
  const n = Math.min(result.stepsDone + 1, total ?? Infinity);
  const where = [
    total ? `step ${n} of ${total}` : null,
    result.currentPhase,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.strip}>
      <View style={styles.liveDot} />
      <Text style={styles.stripStrong}>Running</Text>
      {where ? <Text style={styles.stripText}>{where}</Text> : null}
      {total ? (
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.round((result.stepsDone / total) * 100)}%` }]} />
        </View>
      ) : null}
      <Text style={styles.stripMeta}>{meta(result)}</Text>
      <View style={styles.spacer} />
      {onViewRun && <Button label="View live" onPress={onViewRun} small />}
    </View>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────

function Header({
  label,
  subtitle,
  color,
  meta: metaText,
  onDismiss,
}: {
  label: string;
  subtitle?: string;
  color: string;
  meta: string;
  onDismiss?: () => void;
}) {
  return (
    <View style={styles.header}>
      <Text style={[styles.status, { color }]}>{label}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <View style={styles.spacer} />
      <Text style={styles.meta}>{metaText}</Text>
      {onDismiss && (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss result"
          hitSlop={8}>
          <Text style={styles.dismiss}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

function openLink(url: string) {
  Linking.openURL(url).catch(() => undefined);
}

/** The run's main result. Green when the run finished cleanly; neutral when
 *  it didn't — the link is still real, the run around it wasn't a success. */
function Hero({ link, neutral = false }: { link: ResultLink; neutral?: boolean }) {
  const icon = link.kind === 'pull-request' || link.kind === 'merge-request' ? '⇡' : link.kind === 'issue' ? '◎' : '↗';
  return (
    <View testID="result-hero" style={[styles.hero, neutral && styles.heroNeutral]}>
      <View style={[styles.heroIcon, neutral && styles.heroIconNeutral]}>
        <Text style={styles.heroIconText}>{icon}</Text>
      </View>
      <View style={styles.heroBody}>
        <Text style={[styles.heroKind, neutral && styles.heroKindNeutral]}>
          {linkKindLabel(link.kind).toUpperCase()}
        </Text>
        <Text style={styles.heroTitle} numberOfLines={1}>
          {link.title ?? link.ref}
          {link.title ? <Text style={styles.heroRef}>{`  ${link.ref}`}</Text> : null}
        </Text>
      </View>
      <Button label="Open ↗" kind={neutral ? 'plain' : 'green'} onPress={() => openLink(link.url)} />
    </View>
  );
}

function Chips({ children }: { children: ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

function Chip({ label, value }: { label?: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {label ? `${label} ` : ''}
        <Text style={styles.bold}>{value}</Text>
      </Text>
    </View>
  );
}

function LinkChip({ link }: { link: ResultLink }) {
  return (
    <Pressable
      onPress={() => openLink(link.url)}
      accessibilityRole="link"
      accessibilityLabel={`Open ${link.ref}`}
      style={[styles.chip, styles.chipLink]}>
      <Text style={styles.chipLinkText} numberOfLines={1}>
        {link.ref} ↗
      </Text>
    </Pressable>
  );
}

function OutputBox({
  title,
  text,
  folded = FOLDED_LINES,
}: {
  title: string;
  text: string;
  folded?: number;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // Shown without markdown's markers (the box folds by lines, so it stays
  // plain text); Copy still hands over the original.
  const shown = useMemo(() => displayText(text), [text]);
  const long = shown.split('\n').length > folded || shown.length > folded * 90;
  const copy = () => {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } })
      .navigator;
    if (!nav?.clipboard) return toast.show('Copy is not available here.', 'info');
    nav.clipboard.writeText(text).then(
      () => toast.show('Copied.', 'success'),
      () => toast.show('Copy failed.', 'error'),
    );
  };
  return (
    <View style={styles.output}>
      <View style={styles.outputHead}>
        <Text style={styles.outputTitle}>{title}</Text>
        <View style={styles.spacer} />
        <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel="Copy output">
          <Text style={styles.linkText}>Copy</Text>
        </Pressable>
      </View>
      <View style={styles.outputBody}>
        <Text style={styles.outputText} numberOfLines={open ? undefined : folded} selectable>
          {shown}
        </Text>
      </View>
      {long && (
        <Pressable onPress={() => setOpen(o => !o)} accessibilityRole="button">
          <Text style={[styles.linkText, styles.more]}>{open ? 'Show less ▴' : 'Show all ▾'}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

function Button({
  label,
  onPress,
  kind = 'plain',
  disabled,
  small,
  hint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'plain' | 'primary' | 'green' | 'danger';
  disabled?: boolean;
  small?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={[
        styles.button,
        small && styles.buttonSmall,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'green' && styles.buttonGreen,
        disabled && styles.buttonDisabled,
      ]}>
      <Text
        style={[
          styles.buttonText,
          (kind === 'primary' || kind === 'green') && styles.buttonTextOnColor,
          kind === 'danger' && styles.buttonTextDanger,
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const colors = {
  green: '#15803d',
  amber: '#b45309',
  red: '#b91c1c',
  blue: '#1d4ed8',
  grey: '#4b5563',
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderLeftWidth: 4,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 10,
  },
  cardGreen: { borderLeftColor: '#16a34a' },
  cardAmber: { borderLeftColor: '#d97706' },
  cardRed: { borderLeftColor: '#dc2626' },
  cardBlue: { borderLeftColor: '#2563eb' },
  cardCancelled: { borderLeftColor: '#9ca3af' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  status: { fontSize: 15, fontWeight: '700' },
  subtitle: { fontSize: 14, fontWeight: '600', color: '#374151' },
  meta: { fontSize: 12, color: '#6b7280' },
  dismiss: { fontSize: 16, color: '#9ca3af', paddingHorizontal: 4 },
  spacer: { flex: 1 },
  bold: { fontWeight: '700' },
  note: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9, gap: 4 },
  noteAmber: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  noteAmberText: { fontSize: 13, color: '#78350f', lineHeight: 19 },
  noteRed: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  noteRedText: { fontSize: 13, color: '#7f1d1d', lineHeight: 19 },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1fae5',
    backgroundColor: '#f0fdf4',
  },
  heroIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#16a34a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroIconText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  heroBody: { flex: 1, minWidth: 0 },
  heroKind: { fontSize: 11, fontWeight: '700', color: '#15803d', letterSpacing: 0.6 },
  heroNeutral: { borderColor: '#e5e7eb', backgroundColor: '#f9fafb' },
  heroIconNeutral: { backgroundColor: '#6b7280' },
  heroKindNeutral: { color: '#4b5563' },
  heroTitle: { fontSize: 15, fontWeight: '600', color: '#111827' },
  heroRef: { fontSize: 13, fontWeight: '500', color: '#6b7280' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
    maxWidth: 360,
  },
  chipText: { fontSize: 12, color: '#374151' },
  chipLink: { backgroundColor: '#eff6ff' },
  chipLinkText: { fontSize: 12, color: '#1d4ed8', fontWeight: '600' },
  output: { borderTopWidth: 1, borderTopColor: '#f3f4f6', paddingTop: 10, gap: 6 },
  outputHead: { flexDirection: 'row', alignItems: 'center' },
  outputTitle: { fontSize: 12, fontWeight: '600', color: '#6b7280' },
  outputBody: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#f3f4f6',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  outputText: { fontSize: 13, lineHeight: 20, color: '#1f2937' },
  linkText: { fontSize: 12, fontWeight: '600', color: '#2563eb' },
  more: { marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  buttonSmall: { paddingHorizontal: 10, paddingVertical: 4 },
  buttonPrimary: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  buttonGreen: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  buttonTextOnColor: { color: '#ffffff' },
  buttonTextDanger: { color: '#b91c1c' },
  noteInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    minHeight: 54,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  errorText: { fontSize: 12, color: '#b91c1c' },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    backgroundColor: '#eff6ff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#2563eb' },
  stripStrong: { fontSize: 13, fontWeight: '700', color: '#1e3a8a' },
  stripText: { fontSize: 13, color: '#1e3a8a' },
  stripMeta: { fontSize: 13, color: '#475569' },
  bar: { width: 160, height: 6, borderRadius: 3, backgroundColor: '#dbeafe', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#2563eb' },
});
