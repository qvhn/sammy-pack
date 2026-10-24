/**
 * Tests for the fail-loud `when` guard.
 *
 * The bug: interpolation leaves an unbound `${ref}` in place as the literal
 * string, which is non-empty and therefore TRUTHY — so a
 * `when: "${flagNobodySets}"` phase silently ALWAYS ran, with zero signal
 * (the top silent intent/reality divergence). New semantics: a `when`
 * predicate containing any `${ref}` that does NOT resolve makes the node SKIP,
 * loudly — an `interpolation-unresolved` event names the refs and the
 * `phase-skipped` reason marks the skip as the fail-safe interpretation.
 * A predicate that RESOLVES keeps the exact prior behavior (truthy → run,
 * falsy → quiet skip), including `${item}` / `${index}` inside a map body.
 *
 * Harness: mocked LLM at the module level — same shape as executor.test.ts.
 */

import { runOrchestration, type RunEvent } from '../src/llm/executor';
import { evalWhen, buildLookup } from '../src/llm/resolution';
import { whenTruthy } from '../src/llm/interpolate';
import type { Node } from '../src/types';

const mockState: {
  responder: (sys: string, user: string) => Promise<string> | string;
  callCount: number;
} = { responder: () => '', callCount: 0 };

jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: {
    system?: string;
    messages: { role: string; content: string }[];
  }) {
    mockState.callCount += 1;
    const sys = params.system ?? '';
    const user = params.messages[0]?.content ?? '';
    const result = Promise.resolve(mockState.responder(sys, user));
    let stage = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (stage === 0) {
              stage = 1;
              return { value: { type: 'text-delta', text: await result }, done: false };
            }
            if (stage === 1) {
              stage = 2;
              return {
                value: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
}));

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'a', raw: '---\nname: a\n---\nAgent A.' },
    { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
  ],
  listOrchestrations: async () => [],
}));

function setResponder(
  fn: (sys: string, user: string) => Promise<string> | string,
): void {
  mockState.responder = fn;
  mockState.callCount = 0;
}

async function runToCompletion(
  orchestration: Node,
  opts?: { initialInput?: string },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    initialInput: opts?.initialInput,
    waitForApproval: async () => true,
    cancelled: { v: false },
  })) {
    events.push(ev);
  }
  return events;
}

describe('evalWhen / whenTruthy — onUnresolved hook (shared helper)', () => {
  test('whenTruthy reports each unresolved ref and still returns the literal truthiness', () => {
    const refs: string[] = [];
    // Unresolved → literal `${nope}` → non-empty → raw result is true; the
    // CALLER (executor) turns that into the fail-safe skip.
    expect(whenTruthy('${nope}', {}, r => refs.push(r))).toBe(true);
    expect(refs).toEqual(['nope']);
  });

  test('evalWhen threads onUnresolved; a resolved predicate fires nothing', () => {
    const refs: string[] = [];
    const lookup = buildLookup({ flag: 'false' }, {}, '');
    expect(evalWhen('${flag}', lookup, r => refs.push(r))).toBe(false);
    expect(refs).toEqual([]);
    expect(evalWhen('${missing}', lookup, r => refs.push(r))).toBe(true);
    expect(refs).toEqual(['missing']);
  });
});

describe('executor — unresolved `when` is a loud fail-safe skip', () => {
  test('when: "${flagNobodySets}" → node SKIPPED + interpolation-unresolved + fail-safe reason', async () => {
    setResponder(() => 'ran');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'first', agent: 'agents/a.md' },
        { name: 'guarded', agent: 'agents/b.md', when: '${flagNobodySets}' },
      ],
    });
    // The guarded node never dispatched…
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'guarded'),
    ).toBe(false);
    // …it was skipped with the fail-safe reason…
    const skipped = events.find(
      e => e.type === 'phase-skipped' && e.phaseName === 'guarded',
    );
    expect(skipped).toBeDefined();
    if (skipped?.type === 'phase-skipped') {
      expect(skipped.reason).toContain('unresolved');
      expect(skipped.reason).toContain('flagNobodySets');
      expect(skipped.reason).toContain('fail-safe skip');
    }
    // …and the unresolved refs were surfaced loudly.
    const warn = events.find(
      e => e.type === 'interpolation-unresolved' && e.phaseName === 'guarded',
    );
    expect(warn).toBeDefined();
    if (warn?.type === 'interpolation-unresolved') {
      expect(warn.refs).toEqual(['flagNobodySets']);
    }
    // The run itself still completes.
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('a resolved FALSY predicate skips quietly (no unresolved warning, classic reason)', async () => {
    setResponder(() => 'false'); // first phase output 'false' → ${verdict}
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'decide', agent: 'agents/a.md', as: 'verdict' },
        { name: 'guarded', agent: 'agents/b.md', when: '${verdict}' },
      ],
    });
    const skipped = events.find(
      e => e.type === 'phase-skipped' && e.phaseName === 'guarded',
    );
    expect(skipped).toBeDefined();
    if (skipped?.type === 'phase-skipped') {
      expect(skipped.reason).toContain('is falsy');
      expect(skipped.reason).not.toContain('unresolved');
    }
    expect(
      events.some(
        e => e.type === 'interpolation-unresolved' && e.phaseName === 'guarded',
      ),
    ).toBe(false);
  });

  test('a resolved TRUTHY predicate runs the node (no regression)', async () => {
    setResponder(() => 'yes');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        { name: 'decide', agent: 'agents/a.md', as: 'verdict' },
        { name: 'guarded', agent: 'agents/b.md', when: '${verdict}' },
      ],
    });
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'guarded'),
    ).toBe(true);
    expect(
      events.some(e => e.type === 'phase-skipped' && e.phaseName === 'guarded'),
    ).toBe(false);
  });

  test('${item} in a map-body `when` still resolves per iteration (scope vars are not "unresolved")', async () => {
    setResponder(() => 'processed');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'fan',
          map: {
            over: '["true", "false"]',
            serial: true,
            body: { name: 'work', agent: 'agents/a.md', when: '${item}' },
          },
        },
      ],
    });
    // Item "true" ran; item "false" skipped QUIETLY (resolved falsy) — and
    // neither produced an unresolved-ref warning.
    const ends = events.filter(
      e => e.type === 'phase-end' && e.phaseName === 'work',
    );
    expect(ends).toHaveLength(1);
    const skips = events.filter(
      e => e.type === 'phase-skipped' && e.phaseName === 'work',
    );
    expect(skips).toHaveLength(1);
    if (skips[0]?.type === 'phase-skipped') {
      expect(skips[0].reason).toContain('is falsy');
    }
    expect(events.some(e => e.type === 'interpolation-unresolved')).toBe(false);
  });

  test('${index} in a map-body `when` resolves (index 1 truthy → runs; no unresolved warning)', async () => {
    setResponder(() => 'processed');
    const events = await runToCompletion({
      name: 'flow',
      phases: [
        {
          name: 'fan',
          map: {
            over: '["a", "b"]',
            serial: true,
            // index 0 → "0" (falsy by whenTruthy's rules) → quiet skip;
            // index 1 → "1" → runs. Both RESOLVE — no fail-safe skip.
            body: { name: 'work', agent: 'agents/a.md', when: '${index}' },
          },
        },
      ],
    });
    expect(
      events.filter(e => e.type === 'phase-end' && e.phaseName === 'work'),
    ).toHaveLength(1);
    expect(events.some(e => e.type === 'interpolation-unresolved')).toBe(false);
  });
});
