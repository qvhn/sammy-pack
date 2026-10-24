/**
 * Tests for iteration-SCOPED gate-message keying.
 *
 * `ctx.gateMessages` was keyed by BARE node name while gate identity is
 * iteration-scoped (the lock gate keys on `replayKeyFor` — `<map>[N]/<phase>`,
 * `<loop>@N/<phase>`). Under a map/loop (or parallel same-named phases) an
 * approve-with-message could therefore be consumed by the WRONG iteration:
 * whichever same-named phase dispatched first ate the entry. The executor now
 * consumes scoped-key-FIRST with the bare name as a compatibility fallback,
 * deleting exactly the entry it matched — and `waitForApproval` receives the
 * gate instance's scoped key as an optional 2nd arg so approval
 * implementations can key decisions per-iteration too.
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { AgentFile } from '../src/api';
import type { Node } from '../src/types';

const AGENTS: AgentFile[] = [
  { name: 'a', raw: '---\nname: a\n---\nAgent A.' },
];

/** Serial map over two items whose body is one GATED phase named `work`. */
const gatedMap: Node = {
  name: 'flow',
  phases: [
    {
      name: 'fan',
      map: {
        over: '["one", "two"]',
        serial: true,
        body: { name: 'work', agent: 'agents/a.md', lock: true },
      },
    },
  ],
};

async function run(
  opts: {
    gateMessages?: Record<string, string>;
    waitForApproval?: (name: string, scopedKey?: string) => Promise<boolean>;
  },
  seenInputs: string[],
): Promise<RunEvent[]> {
  const streamFn: StreamFn = async function* (params) {
    seenInputs.push(params.messages[0]?.content ?? '');
    yield { type: 'text-delta', text: 'done' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration: gatedMap,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    waitForApproval: opts.waitForApproval ?? (async () => true),
    cancelled: { v: false },
    gateMessages: opts.gateMessages,
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

describe('gate messages — iteration-scoped consumption', () => {
  test('scoped keys deliver each message to exactly ITS iteration', async () => {
    const seenInputs: string[] = [];
    await run(
      {
        gateMessages: {
          'fan[0]/work': 'instruction for item zero',
          'fan[1]/work': 'instruction for item one',
        },
      },
      seenInputs,
    );
    expect(seenInputs).toHaveLength(2);
    // Iteration 0 got ONLY its own message…
    expect(seenInputs[0]).toContain('instruction for item zero');
    expect(seenInputs[0]).not.toContain('instruction for item one');
    // …and iteration 1 got only its own (the bare-keyed misdelivery would
    // have dumped the first entry on whichever dispatched first).
    expect(seenInputs[1]).toContain('instruction for item one');
    expect(seenInputs[1]).not.toContain('instruction for item zero');
  });

  test('bare-name fallback still works and is consumed ONCE (first matching dispatch)', async () => {
    const seenInputs: string[] = [];
    await run({ gateMessages: { work: 'bare-keyed instruction' } }, seenInputs);
    expect(seenInputs).toHaveLength(2);
    expect(seenInputs[0]).toContain('bare-keyed instruction');
    // Deleted on consumption — the second iteration must not re-receive it.
    expect(seenInputs[1]).not.toContain('bare-keyed instruction');
  });

  test('a scoped entry wins over a bare one for the same phase, and each is consumed independently', async () => {
    const seenInputs: string[] = [];
    await run(
      {
        gateMessages: {
          'fan[1]/work': 'scoped for item one',
          work: 'bare for whoever asks first',
        },
      },
      seenInputs,
    );
    // Iteration 0: no scoped entry for fan[0]/work → falls back to the bare.
    expect(seenInputs[0]).toContain('bare for whoever asks first');
    expect(seenInputs[0]).not.toContain('scoped for item one');
    // Iteration 1: its scoped entry is matched (bare already consumed).
    expect(seenInputs[1]).toContain('scoped for item one');
    expect(seenInputs[1]).not.toContain('bare for whoever asks first');
  });

  test('waitForApproval receives the gate instance\'s scoped key as the 2nd arg', async () => {
    const seenGates: Array<{ name: string; scoped?: string }> = [];
    const seenInputs: string[] = [];
    await run(
      {
        waitForApproval: async (name, scopedKey) => {
          seenGates.push({ name, scoped: scopedKey });
          return true;
        },
      },
      seenInputs,
    );
    expect(seenGates).toEqual([
      { name: 'work', scoped: 'fan[0]/work' },
      { name: 'work', scoped: 'fan[1]/work' },
    ]);
  });
});
