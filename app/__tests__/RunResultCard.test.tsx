/**
 * The Result card as rendered: the run's main link shows in every settled
 * state that found one — green when the run finished cleanly, neutral when
 * it failed, was interrupted, cancelled or degraded — and the answer box
 * shows the agent's markdown as plain text while Copy hands over the
 * original.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { RunEvent } from '../src/llm/executor';
import { RunResultCard } from '../src/pages/RunResultCard';
import type { Run } from '../src/store/runs';

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
const ANSWER = 'The verdict is **ship it**.\n- **PR opened:** [acme/web#1](https://github.com/acme/web/pull/1)';

function runWith(status: Run['status'], extra: RunEvent[] = [], more: Partial<Run> = {}): Run {
  const events = [
    ev({ type: 'phase-start', phaseName: 'open-pr', agentPath: 'agents/gh.md' }),
    ev({ type: 'phase-end', phaseName: 'open-pr', output: ANSWER, inputTokens: 1, outputTokens: 1, costUsd: 0.1, durationMs: 1, model: 'm' }),
    ...extra,
  ];
  return {
    id: 'run-1',
    orchestrationName: 'flow',
    startedAt: 0,
    endedAt: 60_000,
    status,
    events,
    eventVersion: events.length,
    ...more,
  };
}

function render(run: Run) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<RunResultCard run={run} terminal={false} />);
  });
  const hero = () => tree.root.findAll(n => n.props.testID === 'result-hero' && typeof n.type !== 'string')[0];
  const heroBackground = () => StyleSheet.flatten(hero()?.props.style)?.backgroundColor;
  const text = () =>
    tree.root
      .findAll(n => typeof n.type === 'string')
      .flatMap(n => n.children.filter((c): c is string => typeof c === 'string'))
      .join('');
  return { tree, hero, heroBackground, text };
}

const GREEN = '#f0fdf4';

describe('RunResultCard', () => {
  it('a finished run shows its PR in green', () => {
    const { hero, heroBackground } = render(runWith('done'));
    expect(hero()).toBeDefined();
    expect(heroBackground()).toBe(GREEN);
  });

  it('a failed, interrupted or cancelled run still shows the PR its steps opened, neutral', () => {
    const failed = runWith('error', [
      ev({ type: 'phase-start', phaseName: 'notify', agentPath: 'agents/n.md' }),
      ev({ type: 'phase-error', phaseName: 'notify', error: 'refused' }),
      ev({ type: 'run-error', error: 'notify: refused' }),
    ]);
    const interrupted = runWith('interrupted', [ev({ type: 'run-interrupted', reason: 'server restarted' })]);
    const cancelled = runWith('cancelled', [ev({ type: 'run-cancelled' })]);
    for (const run of [failed, interrupted, cancelled]) {
      const { hero, heroBackground } = render(run);
      expect(hero()).toBeDefined();
      expect(heroBackground()).not.toBe(GREEN);
    }
  });

  it('a degraded run shows its PR, neutral', () => {
    const run = runWith('done', [], {
      degradationReasons: [{ phase: 'qa', reason: 'continued past an error' }],
    } as Partial<Run>);
    const { heroBackground, text } = render(run);
    expect(text()).toContain('Finished with issues');
    expect(heroBackground()).not.toBe(GREEN);
  });

  it('the failed card puts the PR under the error', () => {
    const run = runWith('error', [ev({ type: 'run-error', error: 'boom' })]);
    const { text } = render(run);
    expect(text().indexOf('boom')).toBeLessThan(text().indexOf('PULL REQUEST'));
  });

  it('shows the answer without markdown markers; Copy copies the original', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    const g = globalThis as { navigator?: unknown };
    const saved = g.navigator;
    g.navigator = { clipboard: { writeText } };
    try {
      const { tree, text } = render(runWith('done'));
      expect(text()).toContain('The verdict is ship it.');
      expect(text()).toContain('PR opened: acme/web#1');
      expect(text()).not.toContain('**');
      expect(text()).not.toContain('](');
      const copy = tree.root.find(n => n.props.accessibilityLabel === 'Copy output' && typeof n.props.onPress === 'function');
      await ReactTestRenderer.act(async () => {
        copy.props.onPress();
      });
      expect(writeText).toHaveBeenCalledWith(ANSWER);
    } finally {
      g.navigator = saved;
    }
  });

  it('collapses to one line from its status, keeping the PR, and stays collapsed for the next card', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    try {
      const toggle = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
        ReactTestRenderer.act(() => {
          tree.root.find(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function').props.onPress();
        });
      const first = render(runWith('done'));
      expect(first.text()).toContain('Final output');
      toggle(first.tree, 'Collapse result');
      expect(first.text()).not.toContain('Final output');
      expect(first.text()).toContain('acme/web #1');
      expect(first.text()).toContain('Open ↗');

      const next = render(runWith('error', [ev({ type: 'run-error', error: 'boom' })]));
      expect(next.text()).not.toContain('boom');
      toggle(next.tree, 'Expand result');
      expect(next.text()).toContain('boom');
      expect(store.get('sammy.resultCardCollapsed')).toBe('0');
    } finally {
      g.localStorage = saved;
    }
  });
});
