/**
 * Orchestration-level node defaults.
 *
 * A node's per-node resource limits (`timeout` / `stallTimeout` /
 * `maxAgentTokens`) now resolve `node.X ?? orchestration.defaults.X ??
 * <existing env / built-in default>`, so an orchestration can declare a limit
 * ONCE at its root instead of repeating it on every phase.
 *
 * Two layers of coverage:
 *   1. Pure unit tests of the extracted `resolveNodeLimits(node, defaults)`
 *      helper — the single place the `node ?? defaults` precedence lives. This
 *      is the cleanest way to assert (a) inherit-the-default, (b) node-overrides,
 *      and (c) neither-set-leaves-it-for-the-env/built-in-fallback, since the
 *      executor's resolution sites are buried deep inside an async generator.
 *   2. One integration test through `runOrchestration` proving the value is
 *      actually THREADED onto the executor context and reaches the stall
 *      watchdog: a node that omits `stallTimeout` but whose orchestration sets
 *      `defaults.stallTimeout` stalls at the DEFAULT'S window (observable via
 *      the `node-stalled` event's `stallSeconds`).
 */

import {
  resolveNodeLimits,
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

// ── Mocks: runOrchestration calls these even on the paths this test drives ──
// (the integration test routes its phase to a provider StreamFn, but the
// executor still imports the default anthropic adapter + the agent registry).
const mockState: {
  responder: (sys: string, user: string) => Promise<string> | string;
} = { responder: () => '' };

jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: {
    system?: string;
    messages: { role: string; content: string }[];
  }) {
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
    { name: 'a', raw: '---\nname: a\n---\nYou are agent A.' },
    { name: 'fallback', raw: '---\nname: fallback\n---\nfallback agent' },
  ],
  listOrchestrations: async () => [],
}));

// ── 1. Pure resolver — the precedence in isolation ─────────────────────────
describe('resolveNodeLimits — node ?? orchestration defaults', () => {
  test('(a) a node that omits a limit inherits the orchestration default', () => {
    const node: Node = { name: 'leaf', agent: 'agents/a.md' };
    const out = resolveNodeLimits(node, {
      timeout: 120,
      stallTimeout: 30,
      maxAgentTokens: 5_000_000,
    });
    expect(out.timeout).toBe(120);
    expect(out.stallTimeout).toBe(30);
    expect(out.maxAgentTokens).toBe(5_000_000);
  });

  test('(b) an explicit node value overrides the orchestration default', () => {
    const node: Node = {
      name: 'leaf',
      agent: 'agents/a.md',
      timeout: 7,
      stallTimeout: 8,
      maxAgentTokens: 9,
    };
    const out = resolveNodeLimits(node, {
      timeout: 120,
      stallTimeout: 30,
      maxAgentTokens: 5_000_000,
    });
    expect(out.timeout).toBe(7);
    expect(out.stallTimeout).toBe(8);
    expect(out.maxAgentTokens).toBe(9);
  });

  test('(c) with neither node value nor default set, the limit stays undefined (so the executor applies its env / built-in default)', () => {
    const node: Node = { name: 'leaf', agent: 'agents/a.md' };
    // No defaults at all (the common case — orchestrations without a
    // `defaults` block pass `{}` / undefined from runOrchestration).
    expect(resolveNodeLimits(node, undefined)).toEqual({
      timeout: undefined,
      stallTimeout: undefined,
      maxAgentTokens: undefined,
    });
    expect(resolveNodeLimits(node, {})).toEqual({
      timeout: undefined,
      stallTimeout: undefined,
      maxAgentTokens: undefined,
    });
  });

  test('per-limit independence: a default fills only the limit the node omits', () => {
    const node: Node = { name: 'leaf', agent: 'agents/a.md', stallTimeout: 8 };
    const out = resolveNodeLimits(node, { timeout: 120, stallTimeout: 30 });
    // node wins for stallTimeout, default fills timeout, maxAgentTokens unset.
    expect(out.stallTimeout).toBe(8);
    expect(out.timeout).toBe(120);
    expect(out.maxAgentTokens).toBeUndefined();
  });
});

// ── 2. Integration — the default actually reaches the stall watchdog ────────
describe('orchestration defaults — threaded onto the run', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // A provider StreamFn we can drive on a clock: stays silent for
  // `firstDelayMs`, then yields one text-delta + a done. Routing a phase to it
  // (provider:'openai' + providerStreamFns) lets us control exactly when the
  // first progress event flows, isolating the stall watchdog.
  function clockedStreamFn(firstDelayMs: number): StreamFn {
    return async function* () {
      if (firstDelayMs > 0) await sleep(firstDelayMs);
      yield { type: 'text-delta', text: 'chunk' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
  }

  async function runToCompletion(
    orchestration: Node,
    providerStreamFns: Record<string, StreamFn>,
  ): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      waitForApproval: async () => true,
      cancelled: { v: false },
      allowAgentTools: true,
      providerStreamFns,
    })) {
      events.push(ev);
    }
    return events;
  }

  // Save/restore the env so a stray SAMMY_DEFAULT_STALL_TIMEOUT_SEC can't make
  // this flaky, and to prove the orchestration default — not the env — is what
  // sets the window.
  let savedStall: string | undefined;
  beforeEach(() => {
    savedStall = process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC;
    // A long env default ensures only the orchestration `defaults` value can be
    // what trips the watchdog at the short window below.
    process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = '5';
  });
  afterEach(() => {
    if (savedStall === undefined) delete process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC;
    else process.env.SAMMY_DEFAULT_STALL_TIMEOUT_SEC = savedStall;
  });

  test('a node with no own stallTimeout stalls at the orchestration default window', async () => {
    mockState.responder = sys => (sys.includes('fallback agent') ? 'rescued' : 'unused');
    // 300ms of silence; the orchestration default stall window is 50ms → stalls
    // at 0.05 (NOT the 5s env default, NOT the ~420s built-in).
    const stuck = clockedStreamFn(300);
    const events = await runToCompletion(
      {
        name: 'flow',
        defaults: { stallTimeout: 0.05 },
        phases: [
          {
            name: 'wedged',
            agent: 'agents/a.md',
            provider: 'openai',
            // NB: no own stallTimeout — must inherit defaults.stallTimeout.
            retry: { times: 1, initialMs: 1 },
            onError: { name: 'rescue', agent: 'agents/fallback.md' },
          },
        ],
      },
      { openai: stuck },
    );
    const stalled = events.find(e => e.type === 'node-stalled');
    expect(stalled).toBeDefined();
    if (stalled?.type === 'node-stalled') {
      expect(stalled.phaseName).toBe('wedged');
      // The DEFAULT'S window drove the watchdog — proves the value was threaded.
      expect(stalled.stallSeconds).toBe(0.05);
    }
    // Flowed through the normal recovery path → run finishes clean.
    expect(events.find(e => e.type === 'node-recovered')).toBeDefined();
    expect(events.find(e => e.type === 'run-error')).toBeUndefined();
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  }, 10000);

  test("a node's own stallTimeout overrides the orchestration default (node wins)", async () => {
    mockState.responder = sys => (sys.includes('fallback agent') ? 'rescued' : 'unused');
    const stuck = clockedStreamFn(300);
    const events = await runToCompletion(
      {
        name: 'flow',
        // Default is generously long; the node sets a SHORT own window → the
        // node's value must win, so it still stalls quickly at 0.05.
        defaults: { stallTimeout: 4 },
        phases: [
          {
            name: 'wedged',
            agent: 'agents/a.md',
            provider: 'openai',
            stallTimeout: 0.05,
            retry: { times: 1, initialMs: 1 },
            onError: { name: 'rescue', agent: 'agents/fallback.md' },
          },
        ],
      },
      { openai: stuck },
    );
    const stalled = events.find(e => e.type === 'node-stalled');
    expect(stalled).toBeDefined();
    if (stalled?.type === 'node-stalled') {
      // The node's own 0.05 — not the orchestration's 4 — drove the watchdog.
      expect(stalled.stallSeconds).toBe(0.05);
    }
    expect(events.find(e => e.type === 'run-end')).toBeDefined();
  }, 10000);
});
