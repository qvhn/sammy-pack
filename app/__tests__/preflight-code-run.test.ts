/**
 * Preflight fast-fail for code.run.
 *
 * An orchestration that uses the `code.run` escape hatch while
 * SAMMY_ALLOW_CODE_RUN is unset is doomed: the runtime guard in runCodePhase
 * rejects the first code node it reaches, ~30s deep, on every scheduled fire.
 * runOrchestration now refuses such a run at START — one clear run-error that
 * names the flag, before any phase begins. These tests pin that behavior (and
 * its inverse: the flag set, or no code.run, must NOT trip the preflight).
 */

import { runOrchestration, type RunEvent } from '../src/llm/executor';
import type { Node } from '../src/types';

// runOrchestration self-fetches agents/orchestrations unless overridden; mock
// the api so it never hits the network. The preflight halt happens before any
// agent dispatch, so the agent contents are irrelevant here.
jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'a', raw: '---\nname: a\n---\nYou are agent A.' },
  ],
  listOrchestrations: async () => [],
}));

async function runToCompletion(orchestration: Node): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    waitForApproval: async () => true,
    cancelled: { v: false },
  })) {
    events.push(ev);
  }
  return events;
}

describe('preflight — code.run requires SAMMY_ALLOW_CODE_RUN', () => {
  const ORIGINAL = process.env.SAMMY_ALLOW_CODE_RUN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = ORIGINAL;
  });

  test('flag unset → run-error at preflight, no phase-start for the code node', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    const flow: Node = {
      name: 'flow',
      phases: [{ name: 'shell', code: { run: 'echo hi' } }],
    };
    const events = await runToCompletion(flow);

    const runError = events.find(e => e.type === 'run-error');
    expect(runError).toBeDefined();
    const msg = (runError as { error: string }).error;
    expect(msg).toContain('SAMMY_ALLOW_CODE_RUN');
    expect(msg.toLowerCase()).toContain('preflight');

    // It fired at PREFLIGHT: the code node never entered (no phase-start),
    // and the run did not reach a normal run-end.
    expect(events.some(e => e.type === 'phase-start')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(false);
  });

  test('code.run nested in a composite body (loop) is still caught', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    const flow: Node = {
      name: 'flow',
      phases: [
        {
          name: 'refine',
          loop: {
            body: { name: 'shell', code: { run: 'echo deep' } },
            maxIterations: 1,
          },
        },
      ],
    };
    const events = await runToCompletion(flow);
    const runError = events.find(e => e.type === 'run-error');
    expect(runError).toBeDefined();
    expect((runError as { error: string }).error).toContain('SAMMY_ALLOW_CODE_RUN');
    expect(events.some(e => e.type === 'phase-start')).toBe(false);
  });

  test('flag SET → preflight does NOT fire (run proceeds past run-start)', async () => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    const flow: Node = {
      name: 'flow',
      phases: [{ name: 'shell', code: { run: 'echo hi' } }],
    };
    const events = await runToCompletion(flow);
    // No preflight refusal. (The code node may or may not succeed depending on
    // host shell; we only assert the run was NOT halted at preflight.)
    const runError = events.find(e => e.type === 'run-error');
    expect(
      runError && (runError as { error: string }).error.toLowerCase().includes('preflight'),
    ).toBeFalsy();
    // The run got past run-start into the phase.
    expect(events[0]?.type).toBe('run-start');
    expect(events.some(e => e.type === 'phase-start')).toBe(true);
  });

  test('no code.run node → preflight does NOT fire even with flag unset', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    const flow: Node = {
      name: 'flow',
      // A pure code.source transform (not the shell escape hatch) is fine.
      phases: [{ name: 'transform', code: { source: 'return input.toUpperCase();' } }],
    };
    const events = await runToCompletion(flow);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });
});
