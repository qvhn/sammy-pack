import { runOrchestration, type RunEvent } from '../src/llm/executor';
import type { Node } from '../src/types';

jest.setTimeout(30_000);
jest.mock('../src/api', () => ({
  listAgents: async () => [],
  listOrchestrations: async () => [],
}));

async function run(orchestration: Node): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  try {
    for await (const ev of runOrchestration({ orchestration, apiKey: 'k', model: 'claude-opus-4-7', waitForApproval: async () => true, cancelled: { v: false } } as never)) events.push(ev);
  } catch (e) {
    events.push({ type: 'thrown', error: (e as Error).message } as never);
  }
  return events;
}

describe('code.run kills its own child — consistently with the watchdogs', () => {
  const prev = process.env.SAMMY_ALLOW_CODE_RUN;
  beforeAll(() => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = prev;
  });

  it('a stalled code.run with onStall still gets its recovery', async () => {
    const events = await run({
      name: 'stall-recover',
      phases: [
        {
          name: 'wedged',
          stallTimeout: 1,
          timeout: 10,
          code: { run: "sh -c 'sleep 4'" },
          onStall: { recover: { name: 'fix', code: { run: 'echo fixed' } }, maxRetries: 1 },
        },
      ],
    } as Node);
    expect(events.some(e => e.type === 'stall-recovery')).toBe(true);
  });

  it('a silent child is killed at its stall window, as a stall', async () => {
    const t0 = Date.now();
    const events = await run({
      name: 'silent',
      phases: [{ name: 'quiet', stallTimeout: 1, timeout: 10, code: { run: "sh -c 'sleep 8'" } }],
    } as Node);
    expect(Date.now() - t0).toBeLessThan(6_500); // the command would sleep 8s
    expect(JSON.stringify(events)).toMatch(/made no progress|stall/);
    // Reported exactly like the watchdog's own stall.
    expect(events.some(e => e.type === 'node-stalled')).toBe(true);
  });

  it('stderr chatter is progress: the child runs to its timeout, and is then killed promptly', async () => {
    // jest / mvn report progress on stderr. The stall watchdog must agree
    // with the kill about that — before, the watchdog tripped at the stall
    // window, then hung until the timeout kill because the kill counted
    // stderr as activity.
    const t0 = Date.now();
    const events = await run({
      name: 'stderr-chatty',
      phases: [
        {
          name: 'noisy',
          stallTimeout: 1,
          timeout: 3,
          code: { run: "sh -c 'while true; do echo tick >&2; sleep 0.01; done'" },
        },
      ],
    } as Node);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThan(2_500);
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.stringify(events)).toMatch(/timed out after 3s/);
    // Throttled: a few per stall window, not one per stderr chunk (~300 here).
    const beats = events.filter(e => e.type === 'phase-heartbeat').length;
    expect(beats).toBeGreaterThan(0);
    expect(beats).toBeLessThan(30);
  });
});
