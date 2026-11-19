/**
 * A machine that sleeps mid-run: the run waits with it and carries on when it
 * wakes, like Claude Code in a terminal. Step timeouts, stall windows and
 * group deadlines count awake time only, so the sleep itself never times a
 * step out — while the time the machine was awake still counts. Each active
 * run gets a `machine-slept` note saying why its log has a gap.
 *
 * A sleep is simulated the way macOS and Linux show it: the wall clock jumps
 * ahead while the monotonic clock doesn't.
 */

import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { Node } from '../src/types';
import { awakeNow, onWake, setClocksForTests, tickForTests } from '../src/llm/awake-clock';
import { withWakeNotes } from '../src/server/run-controller';
import type { StoredEvent } from '../src/server/run-store';

jest.mock('../src/api', () => ({
  listAgents: async () => [],
  listOrchestrations: async () => [],
}));

const HOUR = 3_600_000;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('the awake clock', () => {
  let wall = 0;
  let mono = 0;
  const use = (platform: string) => setClocksForTests({ wall: () => wall, mono: () => mono, platform });
  afterEach(() => setClocksForTests(null));

  test('a wall-clock jump the monotonic clock did not make is sleep, and is left out', () => {
    use('darwin');
    const heard: number[] = [];
    const off = onWake(ms => heard.push(ms));
    const before = awakeNow();
    wall += HOUR + 10;
    mono += 10;
    expect(awakeNow() - before).toBe(10);
    expect(heard).toEqual([HOUR]);
    off();
  });

  test('clock jitter and a wall clock set backwards are not sleep', () => {
    use('darwin');
    const heard: number[] = [];
    const off = onWake(ms => heard.push(ms));
    wall += 2_000;
    tickForTests();
    wall -= 60_000;
    tickForTests();
    expect(heard).toEqual([]);
    off();
  });

  test('on Windows, where the monotonic clock may count through sleep, a long gap between ticks is sleep', () => {
    use('win32');
    const heard: number[] = [];
    const off = onWake(ms => heard.push(ms));
    const before = awakeNow();
    wall += HOUR;
    mono += HOUR;
    const after = awakeNow();
    expect(heard).toEqual([HOUR - 1_000]);
    expect(after - before).toBe(1_000);
    off();
  });

  test('elsewhere the same gap is a blocked event loop: real time, still counted', () => {
    use('linux');
    const before = awakeNow();
    wall += 60_000;
    mono += 60_000;
    expect(awakeNow() - before).toBe(60_000);
  });
});

describe('a run across a sleep', () => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  /** Sleep "now": the wall clock jumps an hour, the monotonic clock doesn't. */
  const sleepAnHour = () => {
    offset += HOUR;
  };
  beforeEach(() => {
    offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    setClocksForTests(null);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    setClocksForTests(null);
  });

  const agents = [{ name: 'worker', path: 'agents/worker.md', raw: '---\nname: worker\n---\nWORKER' }];

  /** The agent streams, the machine sleeps an hour, the agent wakes after
   *  `awakeMs` more of real time and finishes. */
  const sleepyAgent =
    (beforeMs: number, awakeMs: number): StreamFn =>
    async function* () {
      await pause(beforeMs);
      yield { type: 'text-delta', text: 'started ' };
      sleepAnHour();
      await pause(awakeMs);
      yield { type: 'text-delta', text: 'and finished' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };

  async function run(orchestration: Node, streamFn: StreamFn) {
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
    }
    return events;
  }

  test.each<[string, Node]>([
    ['the step’s own timeout and stall window', { name: 'flow', phases: [{ name: 'work', agent: 'agents/worker.md', timeout: 0.5, stallTimeout: 0.5 }] }],
    [
      'a parallel group’s deadline',
      { name: 'flow', phases: [{ name: 'group', timeout: 0.5, parallel: [{ name: 'work', agent: 'agents/worker.md' }] }] },
    ],
    [
      'a map group’s deadline',
      { name: 'flow', phases: [{ name: 'group', timeout: 0.5, map: { over: '["one"]', body: { name: 'work', agent: 'agents/worker.md' } } }] },
    ],
  ])('an hour asleep does not use up %s', async (_label, orchestration) => {
    const events = await run(orchestration, sleepyAgent(50, 100));
    expect(events.filter(e => e.type === 'phase-error' || e.type === 'node-stalled')).toEqual([]);
    expect(events.find(e => e.type === 'phase-end' && e.phaseName === 'work')).toMatchObject({
      output: 'started and finished',
    });
    expect(events[events.length - 1].type).toBe('run-end');
  });

  test('the time the machine was awake still counts', async () => {
    // 250ms awake before the sleep and 300ms after: over the 0.4s timeout.
    const events = await run(
      { name: 'flow', phases: [{ name: 'work', agent: 'agents/worker.md', timeout: 0.4 }] },
      sleepyAgent(250, 300),
    );
    expect(events[events.length - 1]).toMatchObject({ type: 'run-error', error: expect.stringMatching(/timed out/) });
  });
});

describe('the run log', () => {
  let wall = 0;
  let mono = 0;
  beforeEach(() => setClocksForTests({ wall: () => wall, mono: () => mono, platform: 'darwin' }));
  afterEach(() => setClocksForTests(null));

  test('notes the sleep in order, while the step it interrupted carries on', async () => {
    let finish!: () => void;
    const finished = new Promise<void>(r => (finish = r));
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'phase-start', phaseName: 'work', ts: 1 };
      await finished;
      yield { type: 'phase-end', phaseName: 'work', ts: 2 };
    }
    const seen: string[] = [];
    const done = (async () => {
      for await (const ev of withWakeNotes(source())) {
        seen.push(ev.type === 'machine-slept' ? `slept ${String(ev.sleptMs)}` : String(ev.type));
      }
    })();
    await pause(10);
    wall += 2 * HOUR;
    tickForTests();
    await pause(10);
    finish();
    await done;
    expect(seen).toEqual(['phase-start', `slept ${2 * HOUR}`, 'phase-end']);
  });

});
