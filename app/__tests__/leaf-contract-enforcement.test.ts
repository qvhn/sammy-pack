/**
 * Every LEAF kind enforces a declared `input` / `output` contract.
 *
 * `input` and `output` are declared on the flat `Node` type for every kind,
 * `validate.ts` emits no warning when they appear on a code or wait node, and
 * `preview` renders them — so an author could declare a contract on a code or
 * wait node that type-checked, validated and previewed clean and was then
 * silently ignored at runtime: `runAgentPhase` and `runA2aPhase` checked both
 * sides, `runCodePhase` checked only its output, and `runWaitPhase` checked
 * neither. Three surfaces said "enforced"; one runner did not.
 *
 * This is a drift net over the four leaf runners rather than four separate
 * tests: the same contract, the same bad input, the same expected error shape
 * (the throw-not-yield path the agent runner established, surfaced by the
 * enclosing executeNode as `phase-error` + `run-error`), parameterised over
 * the kind. A future leaf kind gets added to the table, not to a comment.
 *
 * No LLM, no network: the agent leaf runs on an injected `streamFn`, the a2a
 * leaf on a mocked `fetch` (the same fixture shape `a2a.test.ts` uses), and
 * the code / wait leaves on nothing at all.
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

/** A contract no prose satisfies and the JSON below does. */
const CONTRACT = { type: 'object', required: ['x'] };
const GOOD = '{"x":1}';
const BAD = 'just prose, not the JSON the contract wants';

/** The agent leaf echoes its input, so an `output` contract on it fails or
 *  passes in lockstep with what the run was fed. */
const echoStreamFn: StreamFn = async function* (params) {
  yield { type: 'text-delta', text: params.messages[0]?.content ?? '' };
  yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
};

const AGENTS = [{ name: 'a', raw: '---\nname: a\n---\nEcho agent.' }];

/** Stand in for a remote A2A agent that answers with `output`. */
function mockRemoteA2a(output: string): jest.Mock {
  const json = (body: unknown) =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
  return jest
    .fn()
    .mockResolvedValueOnce(json({ url: 'http://remote/rpc', name: 'remote' }))
    .mockResolvedValueOnce(
      json({
        jsonrpc: '2.0',
        id: '1',
        result: {
          id: 'task-1',
          contextId: 'task-1',
          kind: 'task',
          status: { state: 'completed' },
          artifacts: [{ artifactId: 'r', parts: [{ kind: 'text', text: output }] }],
        },
      }),
    );
}

async function collect(
  orchestration: Node,
  opts: Partial<Parameters<typeof runOrchestration>[0]> = {},
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn: echoStreamFn,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
    ...opts,
  })) {
    events.push(ev);
  }
  return events;
}

const phaseEnd = (events: RunEvent[]) =>
  events.find(e => e.type === 'phase-end' && e.phaseName === 'leaf');
const runError = (events: RunEvent[]) =>
  events.find(e => e.type === 'run-error') as
    | Extract<RunEvent, { type: 'run-error' }>
    | undefined;

/** One row per leaf kind: how to build the node, and how to make it emit
 *  a given output (so the OUTPUT contract can be driven per kind). */
const LEAF_KINDS: {
  kind: string;
  node: (contract: 'input' | 'output') => Node;
  /** Per-run options that make the leaf PRODUCE `output`. */
  producing: (output: string) => Partial<Parameters<typeof runOrchestration>[0]>;
}[] = [
  {
    kind: 'agent',
    node: side => ({ name: 'leaf', agent: 'agents/a.md', [side]: CONTRACT }),
    // The echo agent emits whatever it was fed.
    producing: output => ({ initialInput: output }),
  },
  {
    kind: 'a2a',
    node: side => ({
      name: 'leaf',
      a2a: { agentCard: 'http://remote/card' },
      [side]: CONTRACT,
    }),
    producing: output => {
      global.fetch = mockRemoteA2a(output) as unknown as typeof fetch;
      return { initialInput: GOOD };
    },
  },
  {
    kind: 'code',
    node: side => ({ name: 'leaf', code: { source: 'return input' }, [side]: CONTRACT }),
    producing: output => ({ initialInput: output }),
  },
  {
    kind: 'wait',
    node: side => ({
      name: 'leaf',
      wait: { signal: 'go' },
      [side]: CONTRACT,
    }),
    // A buffered signal delivery is the wait's output (payload = output).
    producing: output => ({
      initialInput: GOOD,
      deliveredSignals: { go: [output] },
    }),
  },
];

describe.each(LEAF_KINDS)('leaf kind `$kind` enforces its declared contract', ({ node, producing }) => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('a declared `input` contract refuses non-conforming input', async () => {
    // Must fail BEFORE any work: fetch would throw if the a2a leaf reached it.
    global.fetch = jest.fn(async () => {
      throw new Error('leaf dispatched despite a refused input');
    }) as unknown as typeof fetch;
    const events = await collect(
      { name: 'flow', phases: [node('input')] },
      { initialInput: BAD, deliveredSignals: { go: [GOOD] } },
    );
    const err = runError(events);
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/Phase "leaf" received input that/);
    expect(phaseEnd(events)).toBeUndefined();
  });

  test('a declared `input` contract lets conforming input through', async () => {
    const events = await collect(
      { name: 'flow', phases: [node('input')] },
      { ...producing(GOOD), initialInput: GOOD },
    );
    expect(runError(events)).toBeUndefined();
    expect(phaseEnd(events)).toBeDefined();
  });

  test('a declared `output` contract fails the phase on a non-conforming output', async () => {
    const events = await collect(
      { name: 'flow', phases: [node('output')] },
      producing(BAD),
    );
    const err = runError(events);
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/Phase "leaf"/);
    expect(err!.error).toMatch(/contract|JSON/);
    expect(phaseEnd(events)).toBeUndefined();
  });

  test('a declared `output` contract passes a conforming output downstream', async () => {
    const events = await collect(
      {
        name: 'flow',
        phases: [node('output'), { name: 'after', code: { source: 'return input' } }],
      },
      producing(GOOD),
    );
    expect(runError(events)).toBeUndefined();
    const after = events.find(e => e.type === 'phase-end' && e.phaseName === 'after');
    expect(after).toBeDefined();
    if (after?.type !== 'phase-end') throw new Error('expected phase-end');
    expect(after.output).toBe(GOOD);
  });
});

describe('wait — the output contract covers the timer output too', () => {
  test('a timer wait fails an output contract its fixed JSON cannot meet, and is NOT checkpointed', async () => {
    const events: RunEvent[] = [];
    const seen: Record<string, string> = {};
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'flow',
        phases: [{ name: 'leaf', wait: { seconds: 0 }, output: CONTRACT }],
      },
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      streamFn: echoStreamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: AGENTS,
      orchestrationsOverride: [],
    })) {
      events.push(ev);
      if (ev.type === 'phase-end') seen[ev.phaseName] = ev.output;
    }
    expect(runError(events)?.error).toMatch(/Phase "leaf"/);
    // No phase-end means nothing reached the live checkpoint — a violation
    // must not replay as a success on the next leg.
    expect(seen.leaf).toBeUndefined();
  });

  test('a timer wait passes a contract its JSON does satisfy', async () => {
    const events = await collect({
      name: 'flow',
      phases: [
        {
          name: 'leaf',
          wait: { seconds: 0 },
          output: { type: 'object', required: ['waited', 'kind'] },
        },
      ],
    });
    expect(runError(events)).toBeUndefined();
    expect(phaseEnd(events)).toBeDefined();
  });
});
