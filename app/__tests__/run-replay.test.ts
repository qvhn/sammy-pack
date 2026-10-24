/**
 * Deterministic replay — turning a finished run into a free regression test.
 *
 * Replay is exact here rather than approximate because the framework owns
 * the node tree AND checkpoints every leaf: the recording is the durable
 * event stream, not an outside observation of it. These tests pin the two
 * halves — deriving a recording from that stream, and the divergence diff
 * that decides whether an edited orchestration still walks the same way —
 * plus one end-to-end replay through the real executor with model dispatch
 * disabled.
 */

import {
  deriveRecording,
  describeDivergence,
  diffWalk,
  type RecordedEvent,
} from '../src/lib/run-replay';
import { runOrchestration, type StreamFn } from '../src/llm/executor';
import type { Node } from '../src/types';

const phaseEnd = (
  replayKey: string,
  output: string,
  phaseName = replayKey,
): RecordedEvent => ({ type: 'phase-end', phaseName, replayKey, output });

describe('deriveRecording', () => {
  test('keys leaves by their iteration-scoped replayKey, in completion order', () => {
    const rec = deriveRecording([
      { type: 'run-start' },
      phaseEnd('fan[0]/qa', 'ios ok', 'qa'),
      phaseEnd('fan[1]/qa', 'android ok', 'qa'),
      { type: 'run-end' },
    ]);
    // Scoped keys, NOT a bare phase name — otherwise both map items would
    // collapse onto one recorded output.
    expect(rec.outputs).toEqual({
      'fan[0]/qa': 'ios ok',
      'fan[1]/qa': 'android ok',
    });
    expect(rec.order).toEqual(['fan[0]/qa', 'fan[1]/qa']);
  });

  test('a re-executed leaf records the output the run carried forward (last write wins)', () => {
    const rec = deriveRecording([
      phaseEnd('flaky', 'first attempt'),
      phaseEnd('flaky', 'after retry'),
    ]);
    expect(rec.outputs.flaky).toBe('after retry');
    // …and it is not double-counted in the walk order.
    expect(rec.order).toEqual(['flaky']);
  });

  test('falls back to the phase name for runs recorded before replayKeys', () => {
    const rec = deriveRecording([
      { type: 'phase-end', phaseName: 'legacy', output: 'x' },
    ]);
    expect(rec.outputs).toEqual({ legacy: 'x' });
  });
});

describe('diffWalk', () => {
  const recording = deriveRecording([
    phaseEnd('a', '1'),
    phaseEnd('b', '2'),
    phaseEnd('c', '3'),
  ]);

  test('an identical walk is faithful', () => {
    expect(diffWalk(recording, ['a', 'b', 'c'])).toEqual({
      missing: [],
      unused: [],
      reordered: false,
    });
  });

  test('a leaf with no recorded output is MISSING (the walk went somewhere new)', () => {
    const d = diffWalk(recording, ['a', 'b', 'c', 'd']);
    expect(d.missing).toEqual(['d']);
    expect(describeDivergence(d)[0]).toMatch(/MISSING {2}d/);
  });

  test('a recorded leaf the walk skipped is UNUSED (a `when` or branch changed)', () => {
    const d = diffWalk(recording, ['a', 'c']);
    expect(d.unused).toEqual(['b']);
    expect(describeDivergence(d)[0]).toMatch(/UNUSED/);
  });

  test('reordering is reported over the SHARED leaves only', () => {
    expect(diffWalk(recording, ['b', 'a', 'c']).reordered).toBe(true);
    // An added/removed phase must not ALSO be reported as a reorder — it is
    // already reported as missing/unused.
    expect(diffWalk(recording, ['a', 'b']).reordered).toBe(false);
    expect(diffWalk(recording, ['a', 'b', 'c', 'd']).reordered).toBe(false);
  });
});

describe('end-to-end replay through the executor (no model calls)', () => {
  const forbidden: StreamFn = () => {
    throw new Error('replay must not dispatch a model');
  };
  const AGENTS = [{ name: 'a', raw: '---\nname: a\n---\nAgent A.' }];

  async function replay(
    orchestration: Node,
    outputs: Record<string, string>,
  ): Promise<string[]> {
    const walked: string[] = [];
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: 'none',
      model: 'replay',
      streamFn: forbidden,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: AGENTS,
      orchestrationsOverride: [],
      replayOutputs: outputs,
    })) {
      if (ev.type === 'phase-end') walked.push(ev.replayKey ?? ev.phaseName);
    }
    return walked;
  }

  test('a recorded run re-walks identically with zero model calls', async () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        { name: 'one', agent: 'agents/a.md' },
        { name: 'two', agent: 'agents/a.md' },
      ],
    };
    expect(await replay(orch, { one: 'o1', two: 'o2' })).toEqual(['one', 'two']);
  });

  test('a `when` edit that skips a phase shows up as an UNUSED divergence', async () => {
    const recording = deriveRecording([phaseEnd('one', 'o1'), phaseEnd('two', 'o2')]);
    // The edit: `two` is now gated on a predicate that is falsy.
    const edited: Node = {
      name: 'flow',
      phases: [
        { name: 'one', agent: 'agents/a.md' },
        { name: 'two', agent: 'agents/a.md', when: '${missingVar}' },
      ],
    };
    const walked = await replay(edited, recording.outputs);
    const d = diffWalk(recording, walked);
    expect(d.unused).toEqual(['two']);
    expect(d.missing).toEqual([]);
  });
});
