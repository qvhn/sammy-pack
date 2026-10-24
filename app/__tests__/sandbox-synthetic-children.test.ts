/**
 * Tests for sandbox policy reaching SYNTHETIC child nodes + switch subtrees.
 *
 * Two related holes, one theme (a declared policy silently not applying):
 *
 * 1. Synthetic children. Several dispatch paths synthesize child nodes named
 *    `<parent>/<suffix>` — the `agents: [...]` chain, a converge `merger`, a
 *    route `router`, a loop `judge-N`, conversation `turn-N-<speaker>`. The
 *    sandbox registry only holds AUTHORED names, and the lookup was an exact
 *    `get(node.name)` — so `chain/a` never matched and the ancestor policy
 *    (denylist, permission-mode floor, tool caps) silently did not apply.
 *    `effectiveSandboxFor` now strips trailing `/suffix` segments until a
 *    registered ancestor matches.
 *
 * 2. Switch subtrees. The sandbox pre-walk missed `switch.cases`/`default`
 *    entirely (walker drift — see node-walk.ts), so a sandbox declared ABOVE a
 *    switch never reached the case-body leaves. Now walked via childNodesOf.
 *
 * Harness: a caller-supplied streamFn (no module mocks) — runOrchestration
 * takes `agentsOverride`, so these tests drive the real executor end to end
 * and observe exactly what reaches the LLM adapter seam.
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
  { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
];

async function collect(
  orchestration: Node,
  streamFn: StreamFn,
  opts?: { initialInput?: string; allowAgentTools?: boolean },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    initialInput: opts?.initialInput,
    allowAgentTools: opts?.allowAgentTools,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

/** Plain happy-path stream: one text delta + done. */
const okStream: StreamFn = async function* () {
  yield { type: 'text-delta', text: 'ok' };
  yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
};

describe('effectiveSandboxFor — ancestor policy reaches synthetic children', () => {
  test('deniedCommands on an `agents: [...]` node blocks a Bash call in a chain child', async () => {
    // The stream simulates the agent invoking a denied Bash command. The
    // executor's denylist backstop reads the CHAIN CHILD's sandbox — which
    // only exists via the `chain/<agent>` → `chain` fallback.
    const bashStream: StreamFn = async function* () {
      yield {
        type: 'tool-use',
        name: 'Bash',
        toolUseId: 't1',
        input: { command: 'rm -rf /tmp/scratch' },
      };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'chain',
            agents: ['agents/a.md', 'agents/b.md'],
            sandbox: { deniedCommands: ['rm -rf'] },
          },
        ],
      },
      bashStream,
    );
    const err = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'chain/a',
    );
    expect(err).toBeDefined();
    if (err?.type === 'phase-error') {
      expect(err.error).toMatch(/sandbox blocked a Bash command/);
    }
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });

  test('permissionMode floor on a conversation node reaches every turn child', async () => {
    const seenModes: (string | undefined)[] = [];
    const captureStream: StreamFn = async function* (params) {
      seenModes.push(params.permissionMode);
      yield { type: 'text-delta', text: 'turn' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'conv',
            sandbox: { permissionMode: 'plan' },
            conversation: {
              participants: ['agents/a.md', 'agents/b.md'],
              rounds: 2,
            },
          },
        ],
      },
      captureStream,
    );
    // Turn nodes are named `conv/turn-N-<speaker>` — the floor only reaches
    // them via the synthetic-child fallback.
    expect(
      events.some(e => e.type === 'phase-end' && e.phaseName === 'conv/turn-1-a'),
    ).toBe(true);
    expect(seenModes).toEqual(['plan', 'plan']);
  });

  test('exact-name policy still wins over the ancestor fallback', async () => {
    const seenModes: (string | undefined)[] = [];
    const captureStream: StreamFn = async function* (params) {
      seenModes.push(params.permissionMode);
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await collect(
      {
        name: 'flow',
        sandbox: { permissionMode: 'acceptEdits' },
        phases: [
          {
            // An authored (non-synthetic) leaf: its own registered policy is
            // found by the exact-match arm; the fallback never fires.
            name: 'leaf',
            agent: 'agents/a.md',
            sandbox: { permissionMode: 'plan' },
          },
        ],
      },
      captureStream,
    );
    expect(seenModes).toEqual(['plan']);
  });
});

describe('sandbox + tool validation reach switch subtrees (shared walker)', () => {
  test('sandbox declared ABOVE a switch strips network tools in a case-body leaf', async () => {
    const events = await collect(
      {
        name: 'flow',
        sandbox: { networkAccess: false },
        phases: [
          {
            name: 'branch',
            switch: {
              cases: {
                yes: {
                  name: 'fetcher',
                  agent: 'agents/a.md',
                  tools: ['Read', 'WebFetch'],
                },
              },
            },
          },
        ],
      },
      okStream,
      { initialInput: 'yes', allowAgentTools: true },
    );
    const warn = events.find(
      e => e.type === 'tools-warning' && e.phaseName === 'fetcher',
    );
    expect(warn).toBeDefined();
    if (warn?.type === 'tools-warning') {
      expect(warn.missing).toContain('sandbox-blocked:WebFetch');
    }
  });

  test('connector tools declared inside a switch case are validated at run start', async () => {
    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'branch',
            switch: {
              // The default arm is deliberately NOT taken at runtime (input
              // matches 'yes') — the run-start validation must still see it.
              cases: { yes: { name: 'go', agent: 'agents/a.md' } },
              default: {
                name: 'needs-connector',
                agent: 'agents/b.md',
                tools: ['ticketing'],
              },
            },
          },
        ],
      },
      okStream,
      { initialInput: 'yes' },
    );
    const warn = events.find(
      e => e.type === 'tools-warning' && e.phaseName === 'needs-connector',
    );
    expect(warn).toBeDefined();
    if (warn?.type === 'tools-warning') {
      expect(warn.missing).toEqual(['ticketing']);
    }
  });
});
