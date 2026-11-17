/**
 * A step's agent asking the person running it a question, through the
 * executor: only that step waits — a parallel sibling finishes meanwhile,
 * what needs the step's output waits for it — and the step's `timeout`,
 * `stallTimeout` and its parents' deadlines don't count the waiting.
 */

import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { Node } from '../src/types';

jest.mock('../src/api', () => ({
  listAgents: async () => [],
  listOrchestrations: async () => [],
}));

const agents = [
  { name: 'asker', path: 'agents/asker.md', raw: '---\nname: asker\n---\nASKER' },
  { name: 'worker', path: 'agents/worker.md', raw: '---\nname: worker\n---\nWORKER' },
  { name: 'after', path: 'agents/after.md', raw: '---\nname: after\n---\nAFTER ${input}' },
];

const questions = [
  {
    question: 'Which color?',
    header: 'Color',
    options: [
      { label: 'Red', description: '' },
      { label: 'Blue', description: '' },
    ],
    multiSelect: false,
  },
];

/** The asker raises a question and holds until `release` is called — the
 *  way sdk-stream holds while its permission hook waits on a person. */
function setup() {
  let release!: () => void;
  const answered = new Promise<void>(r => (release = r));
  const streamFn: StreamFn = async function* (params) {
    const sys = params.system ?? '';
    if (sys.includes('ASKER')) {
      yield { type: 'question', id: 'q1', questions };
      await answered;
      yield { type: 'question-closed', id: 'q1', outcome: 'answered', answers: { 'Which color?': 'Blue' } };
      yield { type: 'text-delta', text: 'picked Blue' };
    } else if (sys.includes('WORKER')) {
      yield { type: 'text-delta', text: 'work done' };
    } else {
      yield { type: 'text-delta', text: `after got: ${String(params.messages[0]?.content ?? '')}` };
    }
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { streamFn, release };
}

async function run(orchestration: Node, streamFn: StreamFn, onEvent: (e: RunEvent) => void) {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'k',
    model: 'claude-opus-4-7',
    streamFn,
    agentsOverride: agents as never,
    waitForApproval: async () => true,
    cancelled: { v: false },
  })) {
    events.push(ev);
    onEvent(ev);
  }
  return events;
}

const at = (events: RunEvent[], pred: (e: RunEvent) => boolean) => events.findIndex(pred);

test('only the asking branch waits; its sibling finishes meanwhile; the next step gets the answer-informed output', async () => {
  const { streamFn, release } = setup();
  const events = await run(
    {
      name: 'flow',
      phases: [
        {
          name: 'both',
          parallel: [
            { name: 'ask', agent: 'agents/asker.md' },
            { name: 'work', agent: 'agents/worker.md' },
          ],
        },
        { name: 'next', agent: 'agents/after.md' },
      ],
    },
    streamFn,
    e => {
      // Answer only once the sibling has finished — proof it wasn't held.
      if (e.type === 'phase-end' && e.phaseName === 'work') release();
    },
  );
  const asked = at(events, e => e.type === 'question');
  const workEnd = at(events, e => e.type === 'phase-end' && e.phaseName === 'work');
  const closed = at(events, e => e.type === 'question-closed');
  const nextStart = at(events, e => e.type === 'phase-start' && e.phaseName === 'next');
  expect(asked).toBeGreaterThan(-1);
  expect(events[asked]).toMatchObject({ type: 'question', phaseName: 'ask', questionId: 'q1', questions });
  expect(workEnd).toBeGreaterThan(asked);
  expect(closed).toBeGreaterThan(workEnd);
  expect(events[closed]).toMatchObject({ phaseName: 'ask', outcome: 'answered', answers: { 'Which color?': 'Blue' } });
  expect(nextStart).toBeGreaterThan(closed);
  expect(events[events.length - 1].type).toBe('run-end');
});

test('waiting on a person counts toward neither the step’s timeout and stallTimeout nor its parent’s deadline', async () => {
  const { streamFn, release } = setup();
  const events = await run(
    {
      name: 'flow',
      phases: [
        {
          name: 'outer',
          timeout: 0.4,
          phases: [{ name: 'ask', agent: 'agents/asker.md', timeout: 0.3, stallTimeout: 0.3 }],
        },
      ],
    },
    streamFn,
    e => {
      if (e.type === 'question') setTimeout(release, 900);
    },
  );
  const types = events.map(e => e.type);
  expect(types).not.toContain('node-stalled');
  expect(events.some(e => e.type === 'phase-error')).toBe(false);
  expect(events.find(e => e.type === 'phase-end' && e.phaseName === 'ask')).toMatchObject({ output: 'picked Blue' });
  expect(types[types.length - 1]).toBe('run-end');
});

test.each([
  ['timeout', { timeout: 0.3 }, /timed out/],
  ['stallTimeout', { stallTimeout: 0.3 }, /stall|no progress/i],
])('the same quiet wait without a question still trips %s', async (_label, limits, message) => {
  // Control for the test above: the timers are live, the question is what
  // stops them.
  const streamFn: StreamFn = async function* () {
    await new Promise(r => setTimeout(r, 900));
    yield { type: 'text-delta', text: 'late' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const events = await run(
    { name: 'flow', phases: [{ name: 'ask', agent: 'agents/asker.md', ...limits }] },
    streamFn,
    () => undefined,
  );
  expect(events[events.length - 1]).toMatchObject({ type: 'run-error', error: expect.stringMatching(message) });
});

test('a stall window alone is held open by a question too', async () => {
  const { streamFn, release } = setup();
  const events = await run(
    { name: 'flow', phases: [{ name: 'ask', agent: 'agents/asker.md', stallTimeout: 0.3 }] },
    streamFn,
    e => {
      if (e.type === 'question') setTimeout(release, 900);
    },
  );
  expect(events[events.length - 1].type).toBe('run-end');
});
