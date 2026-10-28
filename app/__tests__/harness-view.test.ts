/** The run page's harness checklist, derived from a run's events. */

import type { RunEvent } from '../src/llm/executor';
import { deriveHarnessView, followSourceLabel, harnessResumeCommand } from '../src/lib/harness-view';

const start = (leg: number, extra: Partial<Extract<RunEvent, { type: 'harness-start' }>> = {}): RunEvent => ({
  type: 'harness-start',
  follow: 'loose',
  followSource: 'run',
  steps: [
    { key: 'plan', name: 'plan', kind: 'task', rank: 0, required: true, finally: false },
    { key: 'ship', name: 'ship', kind: 'engine', engineKind: 'code', rank: 1, gates: ['ship'], required: true, finally: false },
    { key: 'note', name: 'note', kind: 'skill', skill: 'notes', rank: 2, required: false, finally: false },
  ],
  sessionId: 'sess-1',
  cwd: '/work',
  model: 'm',
  leg,
  ts: leg,
  ...extra,
});

describe('deriveHarnessView', () => {
  it('is null for a pipeline run', () => {
    expect(deriveHarnessView([{ type: 'run-start', orchestrationName: 'o', ts: 0 }])).toBeNull();
  });

  it('folds step events into statuses; the first leg holds the strictness and its source', () => {
    const view = deriveHarnessView([
      start(1),
      { type: 'harness-step', key: '__session', phaseName: 'harness', status: 'done', by: 'engine', ts: 1 },
      { type: 'harness-step', key: 'plan', phaseName: 'plan', status: 'started', by: 'harness', ts: 2 },
      { type: 'harness-step', key: 'plan', phaseName: 'plan', status: 'done', by: 'harness', ts: 3 },
      { type: 'harness-notice', message: 'heads up', ts: 4 },
      // A resumed leg reads strictness back from the snapshot, without its source.
      start(2, { followSource: 'orchestration', driver: 'terminal' }),
      { type: 'harness-step', key: 'ship', phaseName: 'ship', status: 'started', by: 'harness', ts: 5 },
      { type: 'harness-step', key: 'note', phaseName: 'note', status: 'skipped', by: 'harness', reason: 'nothing new', ts: 6 },
    ])!;
    expect(view.followSource).toBe('run');
    expect(view.legs).toBe(2);
    expect(view.driver).toBe('terminal');
    expect(view.steps.map(s => [s.key, s.status])).toEqual([
      ['plan', 'done'],
      ['ship', 'active'],
      ['note', 'skipped'],
    ]);
    expect(view.steps[2]).toMatchObject({ reason: 'nothing new', by: 'harness' });
    expect(view.notices).toEqual(['heads up']);
    expect(harnessResumeCommand(view)).toBe(`mkdir -p '/work' && cd '/work' && claude --resume sess-1`);
    expect(followSourceLabel(view.followSource)).toBe('chosen for this run');
  });
});
