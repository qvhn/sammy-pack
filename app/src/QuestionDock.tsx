/** The question dock: questions a run's agents are waiting on, wherever you
 *  are in the app.
 *
 *  It stays out of the way — a small pill in the corner ("1 question ·
 *  ticket-to-pr › plan") that opens into a panel over the page, never pushing
 *  the page down, and folds back to the pill with —. With several steps
 *  waiting, the panel lists them (pipeline › step, how many questions, how
 *  long) and answers the one you pick; what you start on one is kept while
 *  you look at another. The panel walks one question at a time ("1 of 3", Next / Back), offers the
 *  agent's options (one, or several when it asks for that) and a box for your
 *  own words, and sends every answer at once. Only the asking step waits;
 *  the rest of its run carries on, so nothing here is urgent.
 *
 *  Questions come from GET /api/questions (polled while the tab is visible),
 *  so a question from any run finds you — not just the run this tab started. */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { answerRunQuestion, listWaitingQuestions, type WaitingQuestion } from './api';
import { answerText } from './lib/run-questions';
import { formatDuration } from './lib/run-result';

const POLL_MS = 3000;

// ─── Opening the dock from elsewhere (the Result card's "Answer" chip) ────

const openers = new Set<(runId?: string) => void>();

/** Open the dock, at `runId`'s question when given. */
export function openQuestionDock(runId?: string): void {
  for (const open of openers) open(runId);
}

// ─── The dock ─────────────────────────────────────────────────────────────

export function QuestionDock({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [items, setItems] = useState<WaitingQuestion[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  // Answered here, not yet gone from the server's list.
  const [sent, setSent] = useState<string[]>([]);

  const refresh = useCallback(() => {
    listWaitingQuestions().then(
      list => setItems(list),
      () => undefined, // server away (or an older one) — keep what we had
    );
  }, []);

  useEffect(() => {
    refresh();
    const tick = setInterval(() => {
      const doc = (globalThis as { document?: { visibilityState?: string } }).document;
      if (doc?.visibilityState !== 'hidden') refresh();
    }, POLL_MS);
    return () => clearInterval(tick);
  }, [refresh]);

  // The run an "Answer" chip asked for. The chip reads the run's own live
  // events, so its question can be newer than our last poll: fetch now, and
  // land on it once it's listed rather than on another run's question.
  const [wantRun, setWantRun] = useState<string | null>(null);
  useEffect(() => {
    const open = (runId?: string) => {
      setExpanded(true);
      if (runId) {
        setWantRun(runId);
        refresh();
      }
    };
    openers.add(open);
    return () => {
      openers.delete(open);
    };
  }, [refresh]);
  useEffect(() => {
    if (!wantRun) return;
    const hit = items.find(q => q.runId === wantRun);
    if (hit) {
      setAt(hit.questionId);
      setWantRun(null);
    }
  }, [items, wantRun]);

  const waiting = items.filter(q => !sent.includes(q.questionId));
  return (
    <QuestionDockView
      items={waiting}
      expanded={expanded}
      currentId={at}
      onSelect={setAt}
      onToggle={() => setExpanded(e => !e)}
      onSent={id => {
        setSent(prev => [...prev, id]);
        setAt(null);
        refresh();
      }}
      onOpenRun={onOpenRun}
    />
  );
}

/** The dock as drawn, from what it is given (tested on its own). */
export function QuestionDockView({
  items,
  expanded,
  currentId,
  onSelect,
  onToggle,
  onSent,
  onOpenRun,
  now = Date.now(),
}: {
  items: WaitingQuestion[];
  expanded: boolean;
  currentId: string | null;
  onSelect: (questionId: string) => void;
  onToggle: () => void;
  onSent: (questionId: string) => void;
  onOpenRun: (runId: string) => void;
  now?: number;
}) {
  if (items.length === 0) return null;
  const index = Math.max(0, items.findIndex(q => q.questionId === currentId));
  const item = items[index];
  const where = `${item.orchestrationName} › ${item.phaseName}`;
  const count = items.reduce((n, q) => n + q.questions.length, 0);

  // The panel stays mounted while folded, so answers you have started — on
  // any waiting step — are still there when you open it again.
  return (
    <View style={styles.anchor} pointerEvents="box-none">
      {!expanded ? (
        <Pressable
          testID="question-pill"
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel="Open questions"
          style={state => [styles.pill, (state as { hovered?: boolean }).hovered && styles.pillHover]}>
          <View style={styles.pillDot} />
          <Text style={styles.pillStrong}>
            {count === 1 ? '1 question for you' : `${count} questions for you`}
          </Text>
          <Text style={styles.pillWhere} numberOfLines={1}>
            {items.length === 1 ? where : `${items.length} steps waiting`}
          </Text>
          <Text style={styles.pillChevron}>▴</Text>
        </Pressable>
      ) : null}
      <View testID="question-panel" style={[styles.panel, !expanded && styles.hidden]}>
        <View style={styles.head}>
          <Text style={styles.title}>
            {items.length > 1 ? `? ${items.length} steps are waiting on you` : '? Question for you'}
          </Text>
          <View style={styles.spacer} />
          <SmallButton label="—" hint="Minimize" onPress={onToggle} />
        </View>
        {items.length > 1 ? (
          <View style={styles.list}>
            {items.map(it => {
              const here = it.questionId === item.questionId;
              const n = it.questions.length;
              return (
                <Pressable
                  key={it.questionId}
                  onPress={() => onSelect(it.questionId)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: here }}
                  accessibilityLabel={`Answer ${it.orchestrationName} › ${it.phaseName}`}
                  style={state => [
                    styles.row,
                    (state as { hovered?: boolean }).hovered && styles.rowHover,
                    here && styles.rowHere,
                  ]}>
                  <View style={[styles.rowMark, here && styles.rowMarkHere]} />
                  <Text style={[styles.rowWhere, here && styles.rowWhereHere]} numberOfLines={1}>
                    {it.orchestrationName}
                    <Text style={styles.rowStep}>{` › ${it.phaseName}`}</Text>
                  </Text>
                  <View style={styles.spacer} />
                  <Text style={styles.rowMeta}>
                    {`${n === 1 ? '1 question' : `${n} questions`} · ${formatDuration(Math.max(0, now - it.ts))}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.whereRow}>
            <Text style={styles.where} numberOfLines={1}>
              {where}
            </Text>
            <Text style={styles.waited}>
              {`waiting ${formatDuration(Math.max(0, now - item.ts))} · the rest of the run carries on`}
            </Text>
          </View>
        )}
        {/* Every waiting step's questions stay mounted — only the chosen one
            shows — so switching steps keeps what you picked on the others. */}
        {items.map(it => (
          <View key={it.questionId} style={it.questionId === item.questionId ? null : styles.hidden}>
            <QuestionStepper item={it} onSent={() => onSent(it.questionId)} />
          </View>
        ))}
        <Pressable onPress={() => onOpenRun(item.runId)} accessibilityRole="link">
          <Text style={styles.link}>View run</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** One step's questions, one at a time. */
function QuestionStepper({ item, onSent }: { item: WaitingQuestion; onSent: () => void }) {
  const qs = item.questions;
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []));
  const [own, setOwn] = useState<string[]>(() => qs.map(() => ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = qs[index];
  const answers = qs.map((x, i) => answerText(x, picked[i] ?? [], own[i] ?? ''));
  const last = index === qs.length - 1;
  const chosen = picked[index] ?? [];

  const pick = (label: string) => {
    setPicked(prev =>
      prev.map((p, i) => {
        if (i !== index) return p;
        if (!q.multiSelect) return [label];
        return p.includes(label) ? p.filter(l => l !== label) : [...p, label];
      }),
    );
    // One choice: picking an option replaces words typed in its place.
    if (!q.multiSelect) setOwn(prev => prev.map((o, i) => (i === index ? '' : o)));
  };
  const type = (text: string) => {
    setOwn(prev => prev.map((o, i) => (i === index ? text : o)));
    if (!q.multiSelect && text.trim()) setPicked(prev => prev.map((p, i) => (i === index ? [] : p)));
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await answerRunQuestion(
        item.runId,
        item.questionId,
        Object.fromEntries(qs.map((x, i) => [x.question, answers[i]])),
      );
      onSent();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const preview = q.options.find(o => chosen.includes(o.label) && o.preview)?.preview;
  return (
    <View style={styles.stepper}>
      <View style={styles.qTop}>
        {qs.length > 1 ? <Text style={styles.qCount}>{`${index + 1} of ${qs.length}`}</Text> : null}
        {q.header ? (
          <View style={styles.qTag}>
            <Text style={styles.qTagText}>{q.header}</Text>
          </View>
        ) : null}
        {q.multiSelect ? <Text style={styles.qHint}>Pick any that apply</Text> : null}
        <View style={styles.spacer} />
        {qs.length > 1 ? (
          <View style={styles.qDots}>
            {qs.map((_, i) => (
              <View key={i} style={[styles.qDot, answers[i] !== '' && styles.qDotDone, i === index && styles.qDotHere]} />
            ))}
          </View>
        ) : null}
      </View>
      <Text style={styles.qText}>{q.question}</Text>
      <View style={styles.qOptions}>
        {q.options.map(o => {
          const on = chosen.includes(o.label);
          return (
            <Pressable
              key={o.label}
              onPress={() => pick(o.label)}
              accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on }}
              accessibilityLabel={o.label}
              style={state => [
                styles.qOption,
                (state as { hovered?: boolean }).hovered && styles.qOptionHover,
                on && styles.qOptionOn,
              ]}>
              <View style={[q.multiSelect ? styles.qBox : styles.qRadio, on && styles.qMarkOn]}>
                {on ? <Text style={styles.qMarkText}>{q.multiSelect ? '✓' : '●'}</Text> : null}
              </View>
              <View style={styles.qOptionBody}>
                <Text style={styles.qLabel}>{o.label}</Text>
                {o.description ? <Text style={styles.qDesc}>{o.description}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        <TextInput
          value={own[index] ?? ''}
          onChangeText={type}
          placeholder={q.multiSelect ? 'Add your own (optional)' : 'Or answer in your own words'}
          placeholderTextColor="#9ca3af"
          accessibilityLabel="Your own answer"
          style={styles.input}
          multiline
        />
      </View>
      {preview ? (
        <View style={styles.previewBox}>
          <Text style={styles.preview}>{preview}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {qs.length > 1 ? (
          <ActionButton label="← Back" disabled={index === 0 || busy} onPress={() => setIndex(i => Math.max(0, i - 1))} />
        ) : null}
        <View style={styles.spacer} />
        {last ? (
          <ActionButton
            label={busy ? 'Sending…' : qs.length > 1 ? 'Send answers' : 'Send answer'}
            primary
            disabled={busy || answers.some(a => a === '')}
            onPress={() => {
              send().catch(() => undefined);
            }}
          />
        ) : (
          <ActionButton label="Next →" primary disabled={answers[index] === ''} onPress={() => setIndex(i => i + 1)} />
        )}
      </View>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.button, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}>
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({
  label,
  hint,
  onPress,
  disabled,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint}
      hitSlop={6}
      style={state => [
        styles.small,
        (state as { hovered?: boolean }).hovered && styles.smallHover,
        disabled && styles.buttonDisabled,
      ]}>
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

const violet = '#6d28d9';

const styles = StyleSheet.create({
  // Fixed to the window's corner (react-native-web), above the page.
  anchor: {
    position: 'fixed' as 'absolute',
    right: 20,
    bottom: 20,
    zIndex: 50,
    alignItems: 'flex-end',
    maxWidth: '92%' as unknown as number,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: violet,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    maxWidth: 420,
  },
  pillHover: { backgroundColor: '#5b21b6' },
  pillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ddd6fe' },
  pillStrong: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
  pillWhere: { color: '#ede9fe', fontSize: 12, flexShrink: 1 },
  pillChevron: { color: '#ede9fe', fontSize: 11 },
  panel: {
    width: 440,
    maxWidth: '100%' as unknown as number,
    maxHeight: '80vh' as unknown as number,
    overflow: 'scroll' as 'hidden',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderTopWidth: 4,
    borderTopColor: '#7c3aed',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  hidden: { display: 'none' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 14, fontWeight: '700', color: violet },
  list: { gap: 4, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', paddingBottom: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  rowHover: { backgroundColor: '#f9fafb' },
  rowHere: { backgroundColor: '#f5f3ff' },
  rowMark: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#d1d5db' },
  rowMarkHere: { backgroundColor: '#7c3aed' },
  rowWhere: { fontSize: 13, fontWeight: '600', color: '#374151', flexShrink: 1 },
  rowWhereHere: { color: '#111827' },
  rowStep: { fontWeight: '400', color: '#6b7280' },
  rowMeta: { fontSize: 12, color: '#6b7280' },
  whereRow: { gap: 2 },
  where: { fontSize: 13, fontWeight: '600', color: '#111827' },
  waited: { fontSize: 11, color: '#6b7280' },
  spacer: { flex: 1 },
  link: { fontSize: 12, fontWeight: '600', color: '#2563eb' },
  stepper: { gap: 10 },
  qTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  qCount: { fontSize: 12, fontWeight: '700', color: violet },
  qTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: '#f5f3ff' },
  qTagText: { fontSize: 11, fontWeight: '700', color: violet, letterSpacing: 0.3 },
  qHint: { fontSize: 12, color: '#6b7280' },
  qDots: { flexDirection: 'row', gap: 5 },
  qDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#e5e7eb' },
  qDotDone: { backgroundColor: '#c4b5fd' },
  qDotHere: { backgroundColor: '#7c3aed' },
  qText: { fontSize: 15, fontWeight: '600', color: '#111827', lineHeight: 22 },
  qOptions: { gap: 6 },
  qOption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
  },
  qOptionHover: { backgroundColor: '#f9fafb' },
  qOptionOn: { borderColor: '#7c3aed', backgroundColor: '#f5f3ff' },
  qRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  qBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  qMarkOn: { borderColor: '#7c3aed', backgroundColor: '#7c3aed' },
  qMarkText: { color: '#ffffff', fontSize: 10, fontWeight: '700', lineHeight: 12 },
  qOptionBody: { flex: 1, gap: 2 },
  qLabel: { fontSize: 14, fontWeight: '600', color: '#111827' },
  qDesc: { fontSize: 12, color: '#4b5563', lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    minHeight: 38,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  previewBox: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#f3f4f6',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  preview: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 18, color: '#1f2937' },
  error: { fontSize: 12, color: '#b91c1c' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  buttonPrimary: { backgroundColor: '#7c3aed', borderColor: '#7c3aed' },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontSize: 13, fontWeight: '600', color: '#111827' },
  buttonTextPrimary: { color: '#ffffff' },
  small: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  smallHover: { backgroundColor: '#f3f4f6' },
  smallText: { fontSize: 14, fontWeight: '700', color: '#374151' },
});
