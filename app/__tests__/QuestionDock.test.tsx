/**
 * The question dock: a question a run's agent is waiting on shows as a small
 * pill in the corner, opens into one question at a time ("1 of 3", Next once
 * this one is answered, Back to change one), and sends every answer keyed by
 * question. A running Result card offers an Answer chip that opens it.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { WaitingQuestion } from '../src/api';
import type { RunEvent } from '../src/llm/executor';
import { QuestionDockView } from '../src/QuestionDock';
import { RunResultCard } from '../src/pages/RunResultCard';
import type { Run } from '../src/store/runs';

const opt = (label: string) => ({ label, description: `${label} described` });
const QUESTIONS = [
  { question: 'Which database?', header: 'Database', options: [opt('Postgres'), opt('SQLite')], multiSelect: false },
  { question: 'Which checks?', header: 'Checks', options: [opt('Lint'), opt('Tests'), opt('Types')], multiSelect: true },
  { question: 'Ship today?', header: 'Timing', options: [opt('Yes'), opt('No')], multiSelect: false },
];
const waiting = (over: Partial<WaitingQuestion> = {}): WaitingQuestion => ({
  runId: 'run-9',
  orchestrationName: 'flow',
  phaseName: 'plan',
  questionId: 'q1',
  questions: QUESTIONS,
  ts: 0,
  ...over,
});

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const t of mounted.splice(0)) ReactTestRenderer.act(() => t.unmount());
});

function harness(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(el);
  });
  mounted.push(tree);
  const text = () =>
    tree.root
      .findAll(n => typeof n.type === 'string')
      .flatMap(n => n.children.filter((c): c is string => typeof c === 'string'))
      .join('|');
  const find = (label: string) =>
    tree.root.find(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  const press = (label: string) => ReactTestRenderer.act(() => find(label).props.onPress());
  const typeOwn = (t: string) => {
    const input = tree.root.find(n => n.props.accessibilityLabel === 'Your own answer' && n.props.onChangeText);
    ReactTestRenderer.act(() => input.props.onChangeText(t));
  };
  return { tree, text, find, press, typeOwn };
}

function dock(items: WaitingQuestion[], expanded: boolean, extra: Partial<React.ComponentProps<typeof QuestionDockView>> = {}) {
  return harness(
    <QuestionDockView
      items={items}
      expanded={expanded}
      currentId={null}
      onSelect={() => undefined}
      onToggle={() => undefined}
      onSent={() => undefined}
      onOpenRun={() => undefined}
      now={65_000}
      {...extra}
    />,
  );
}

describe('question dock', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ok":true}' });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  test('nothing waiting — nothing drawn', () => {
    expect(dock([], false).tree.toJSON()).toBeNull();
  });

  test('folded: a pill with the count and where it comes from, nothing more', () => {
    const toggle = jest.fn();
    const d = dock([waiting()], false, { onToggle: toggle });
    expect(d.text()).toContain('3 questions for you');
    expect(d.text()).toContain('flow › plan');
    // The panel stays mounted (so started answers survive) but is not shown.
    const panel = d.tree.root.find(n => n.props.testID === 'question-panel' && typeof n.type !== 'string');
    expect(StyleSheet.flatten(panel.props.style).display).toBe('none');
    d.press('Open questions');
    expect(toggle).toHaveBeenCalled();
  });

  test('open: one question at a time; Next waits for an answer; Back keeps picks; Send posts every answer', async () => {
    const sent = jest.fn();
    const d = dock([waiting()], true, { onSent: sent });
    expect(d.text()).toContain('1 of 3');
    expect(d.text()).toContain('waiting 1m');
    expect(d.text()).toContain('Which database?');
    expect(d.find('Next →').props.disabled).toBe(true);
    d.press('Postgres');
    d.press('Next →');
    expect(d.text()).toContain('2 of 3');
    expect(d.text()).toContain('Pick any that apply');
    d.press('Lint');
    d.press('Types');
    d.press('← Back');
    expect(d.text()).toContain('Which database?');
    d.press('Next →');
    d.press('Next →');
    expect(d.text()).toContain('3 of 3');
    expect(d.find('Send answers').props.disabled).toBe(true);
    d.typeOwn('Tomorrow morning');
    await ReactTestRenderer.act(async () => {
      d.find('Send answers').props.onPress();
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/runs/run-9/questions/q1');
    expect(JSON.parse(init.body)).toEqual({
      answers: { 'Which database?': 'Postgres', 'Which checks?': 'Lint, Types', 'Ship today?': 'Tomorrow morning' },
    });
    expect(sent).toHaveBeenCalled();
  });

  test('a refused answer shows why and keeps the question', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"No agent in this run is waiting on that question."}',
    });
    const d = dock([waiting({ questions: [QUESTIONS[0]] })], true);
    expect(d.text()).not.toContain('1 of');
    d.press('SQLite');
    await ReactTestRenderer.act(async () => {
      d.find('Send answer').props.onPress();
    });
    expect(d.text()).toContain('No agent in this run is waiting on that question.');
    expect(d.text()).toContain('Which database?');
  });

  test('several steps waiting: a list of them, and the one you pick is answered', () => {
    const select = jest.fn();
    const d = dock(
      [waiting(), waiting({ questionId: 'q2', phaseName: 'review', orchestrationName: 'notes', runId: 'run-10', ts: 30_000 })],
      true,
      { onSelect: select },
    );
    expect(d.text()).toContain('2 steps are waiting on you');
    expect(d.text()).toContain('3 questions · 1m');
    expect(d.text()).toContain('3 questions · 35s');
    d.press('Answer notes › review');
    expect(select).toHaveBeenCalledWith('q2');
  });

  test('what you picked on one step is kept while you look at another, and while folded', () => {
    const OTHER = [{ question: 'Which audience?', header: 'Audience', options: [opt('Customers'), opt('Developers')], multiSelect: false }];
    function Stateful() {
      const [at, setAt] = React.useState<string | null>(null);
      const [open, setOpen] = React.useState(true);
      return (
        <QuestionDockView
          items={[waiting(), waiting({ questionId: 'q2', phaseName: 'outline', orchestrationName: 'notes', questions: OTHER })]}
          expanded={open}
          currentId={at}
          onSelect={setAt}
          onToggle={() => setOpen(o => !o)}
          onSent={() => undefined}
          onOpenRun={() => undefined}
          now={65_000}
        />
      );
    }
    const d = harness(<Stateful />);
    const checked = (label: string) => d.find(label).props.accessibilityState.checked;
    d.press('Postgres');
    d.press('Answer notes › outline');
    d.press('Developers');
    d.press('Answer flow › plan');
    expect(checked('Postgres')).toBe(true);
    d.press('Minimize');
    expect(d.text()).toContain('4 questions for you');
    d.press('Open questions');
    expect(checked('Postgres')).toBe(true);
    expect(checked('Developers')).toBe(true);
  });
});

describe('the running Result card', () => {
  const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
  const run = (extra: RunEvent[] = []): Run => {
    const events = [
      ev({ type: 'run-start', orchestrationName: 'flow' }),
      ev({ type: 'phase-start', phaseName: 'plan', agentPath: 'agents/p.md' }),
      ev({ type: 'question', phaseName: 'plan', questionId: 'q1', questions: QUESTIONS }),
      ...extra,
    ];
    return { id: 'run-9', orchestrationName: 'flow', startedAt: 0, status: 'running', events, eventVersion: events.length };
  };

  test('offers an Answer chip — the questions themselves stay in the dock', () => {
    const c = harness(<RunResultCard run={run()} terminal={false} />);
    expect(c.text()).toContain('3 questions for you · Answer');
    expect(c.text()).not.toContain('Which database?');
  });

  test('no chip once the question is closed', () => {
    const c = harness(
      <RunResultCard
        run={run([ev({ type: 'question-closed', phaseName: 'plan', questionId: 'q1', outcome: 'answered' })])}
        terminal={false}
      />,
    );
    expect(c.text()).not.toContain('Answer');
  });
});
