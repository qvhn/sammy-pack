/**
 * The Runs log shows each step once. A resume replays the steps it already
 * finished: the log keeps the original and drops the replay. A fork has no
 * original, so its replayed steps stay, marked. A step still open when its
 * run ends or restarts stops showing as streaming.
 */

import type { RunEvent } from '../src/llm/executor';
import { groupEvents, type Block } from '../src/pages/RunsPage';

const ts = 1;
const start = (phaseName: string): RunEvent => ({ type: 'phase-start', phaseName, agentPath: 'agents/a.md', ts });
const end = (phaseName: string, extra: Partial<Extract<RunEvent, { type: 'phase-end' }>> = {}): RunEvent => ({
  type: 'phase-end',
  phaseName,
  output: 'out',
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  durationMs: 1,
  model: 'm',
  ts,
  ...extra,
});

const phases = (blocks: Block[]) =>
  blocks.flatMap(b => (b.kind === 'phase' ? [`${b.name}:${b.status}${b.replayed ? ':replayed' : ''}`] : []));

describe('the Runs log', () => {
  it('drops a resume\'s replay of a step it already shows', () => {
    const events: RunEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts },
      start('draft'),
      end('draft'),
      { type: 'run-paused', pausedFor: 'check', ts },
      { type: 'run-start', orchestrationName: 'o', ts },
      start('draft'),
      end('draft', { replayed: true, inputTokens: 0, outputTokens: 0 }),
      start('check'),
      end('check'),
      { type: 'run-end', ts },
    ];
    expect(phases(groupEvents(events))).toEqual(['draft:done', 'check:done']);
  });

  it('keeps a fork\'s replayed steps, marked, including repeats of one step', () => {
    const events: RunEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts },
      start('item'),
      end('item', { replayed: true }),
      start('item'),
      end('item', { replayed: true }),
      start('after'),
      end('after'),
      { type: 'run-end', ts },
    ];
    expect(phases(groupEvents(events))).toEqual(['item:done:replayed', 'item:done:replayed', 'after:done']);
  });

  it('stops showing a step as streaming once its run ends or restarts', () => {
    const events: RunEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts },
      start('cool-down'),
      { type: 'run-start', orchestrationName: 'o', ts },
      start('cool-down'),
      end('cool-down'),
      start('await-go'),
      { type: 'run-cancelled', ts },
    ];
    expect(phases(groupEvents(events))).toEqual(['cool-down:stopped', 'cool-down:done', 'await-go:stopped']);
  });
});
