/**
 * The question card: a step's agent waiting on you shows above the running
 * strip — its questions one at a time ("1 of 3"), Next once this one is
 * answered, Back to change one, and Send with every answer keyed by question.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { RunEvent } from '../src/llm/executor';
import { RunResultCard } from '../src/pages/RunResultCard';
import type { Run } from '../src/store/runs';

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
const opt = (label: string) => ({ label, description: `${label} described` });
const QUESTIONS = [
  { question: 'Which database?', header: 'Database', options: [opt('Postgres'), opt('SQLite')], multiSelect: false },
  { question: 'Which checks?', header: 'Checks', options: [opt('Lint'), opt('Tests'), opt('Types')], multiSelect: true },
  { question: 'Ship today?', header: 'Timing', options: [opt('Yes'), opt('No')], multiSelect: false },
];

function running(extra: RunEvent[] = [], questions = QUESTIONS): Run {
  const events = [
    ev({ type: 'run-start', orchestrationName: 'flow' }),
    ev({ type: 'phase-start', phaseName: 'plan', agentPath: 'agents/p.md' }),
    ev({ type: 'question', phaseName: 'plan', questionId: 'q1', questions }),
    ...extra,
  ];
  return { id: 'run-9', orchestrationName: 'flow', startedAt: 0, status: 'running', events, eventVersion: events.length };
}

// A running card ticks every second; unmount so the clock stops with the test.
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const t of mounted.splice(0)) ReactTestRenderer.act(() => t.unmount());
});

function render(run: Run) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<RunResultCard run={run} terminal={false} />);
  });
  mounted.push(tree);
  const text = () =>
    tree.root
      .findAll(n => typeof n.type === 'string')
      .flatMap(n => n.children.filter((c): c is string => typeof c === 'string'))
      .join('|');
  const press = (label: string) => {
    const node = tree.root.find(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
    ReactTestRenderer.act(() => node.props.onPress());
  };
  const disabled = (label: string) =>
    tree.root.find(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function').props.disabled;
  const typeOwn = (t: string) => {
    const input = tree.root.find(n => n.props.accessibilityLabel === 'Your own answer' && n.props.onChangeText);
    ReactTestRenderer.act(() => input.props.onChangeText(t));
  };
  return { tree, text, press, disabled, typeOwn };
}

describe('question card', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '{"ok":true}' });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  test('shows the first of three, with who asks and that the rest carries on', () => {
    const { text } = render(running());
    expect(text()).toContain('Question for you');
    expect(text()).toContain('plan asks');
    expect(text()).toContain('1 of 3');
    expect(text()).toContain('Which database?');
    expect(text()).toContain('Postgres described');
    expect(text()).not.toContain('Which checks?');
    expect(text()).toContain('Running');
  });

  test('Next waits for an answer; Back keeps what was picked; Send posts every answer by question', async () => {
    const card = render(running());
    expect(card.disabled('Next →')).toBe(true);
    card.press('Postgres');
    card.press('Next →');
    expect(card.text()).toContain('2 of 3');
    expect(card.text()).toContain('Pick any that apply');
    card.press('Lint');
    card.press('Types');
    card.press('← Back');
    expect(card.text()).toContain('Which database?');
    card.press('Next →');
    card.press('Next →');
    expect(card.text()).toContain('3 of 3');
    expect(card.disabled('Send answers')).toBe(true);
    card.typeOwn('Tomorrow morning');
    expect(card.disabled('Send answers')).toBe(false);
    await ReactTestRenderer.act(async () => {
      card.tree.root
        .find(n => n.props.accessibilityLabel === 'Send answers' && typeof n.props.onPress === 'function')
        .props.onPress();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/runs/run-9/questions/q1');
    expect(JSON.parse(init.body)).toEqual({
      answers: { 'Which database?': 'Postgres', 'Which checks?': 'Lint, Types', 'Ship today?': 'Tomorrow morning' },
    });
    expect(card.text()).toContain('Answer sent');
  });

  test('a refused answer shows why and keeps the card', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '{"error":"No agent in this run is waiting on that question."}' });
    const card = render(running([], [QUESTIONS[0]]));
    // One question: no "1 of 1", and a plain Send answer.
    expect(card.text()).not.toContain('1 of');
    card.press('SQLite');
    await ReactTestRenderer.act(async () => {
      card.tree.root
        .find(n => n.props.accessibilityLabel === 'Send answer' && typeof n.props.onPress === 'function')
        .props.onPress();
    });
    expect(card.text()).toContain('No agent in this run is waiting on that question.');
    expect(card.text()).toContain('Which database?');
  });

  test('a closed question leaves no card', () => {
    const { text } = render(
      running([ev({ type: 'question-closed', phaseName: 'plan', questionId: 'q1', outcome: 'answered', answers: {} })]),
    );
    expect(text()).not.toContain('Question for you');
    expect(text()).toContain('Running');
  });
});
