/**
 * Tests for FAILURE-PARTIALS on the fan-out composites (parallel / converge /
 * map) + failed-item output marking.
 *
 * The bug: ONE failed branch/item (without `continueOnError`) threw away ALL
 * sibling successes and their state merges — partial failure treated as
 * total, so a wide fan-out that mostly succeeded delivered nothing when one
 * leg died. Only the TIMEOUT path had finalize-with-partials. New contract:
 * when the drain finishes with failures AND at least one success, it emits one
 * `phase-error` per failed child, folds the succeeded children's state, emits
 * `composite-partial` with a `failed` count, hands downstream the succeeded
 * outputs, and CONTINUES. All-fail still throws exactly as before.
 *
 * Plus the map `continueOnError` output marking: a swallowed item failure used
 * to leave the item's INPUT in its output slot (an indistinguishable echo);
 * it is now a legible `[FAILED item N] <message>` marker.
 *
 * Harness: caller-supplied streamFn keyed on the agent's system prompt / user
 * input (no module mocks) — `agentsOverride` keeps it self-contained.
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
  { name: 'c', raw: '---\nname: c\n---\nAgent C.' },
];

async function collect(
  orchestration: Node,
  streamFn: StreamFn,
  opts?: { initialInput?: string },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    initialInput: opts?.initialInput,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

/** Stream that succeeds with `output` derived from the system prompt, or
 *  throws when the system prompt matches `failWhen`. */
function bySystem(rules: {
  failWhen?: (sys: string) => boolean;
  output: (sys: string, user: string) => string;
}): StreamFn {
  return async function* (params) {
    const sys = params.system ?? '';
    const user = params.messages[0]?.content ?? '';
    if (rules.failWhen?.(sys)) throw new Error('branch exploded');
    yield { type: 'text-delta', text: rules.output(sys, user) };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

function partialOf(events: RunEvent[]) {
  return events.find(e => e.type === 'composite-partial');
}

describe('parallel — failure partials', () => {
  const threeBranches = (extra?: Partial<Node>): Node => ({
    name: 'flow',
    state: { list: { reducer: 'append' } },
    phases: [
      {
        name: 'fan',
        parallel: [
          { name: 'b1', agent: 'agents/a.md', as: 'list' },
          { name: 'b2', agent: 'agents/b.md' },
          { name: 'b3', agent: 'agents/c.md', as: 'list' },
        ],
        ...extra,
      },
      {
        // Reads both the piped partial output and the folded reducer state,
        // so one assertion covers the pipe AND the state merge.
        name: 'read',
        code: { source: 'return JSON.stringify({ input, list: state.list })' },
      },
    ],
  });

  test('1 of 3 branches fails → per-branch phase-error + composite-partial{completed:2,failed:1} + siblings flow on', async () => {
    const events = await collect(
      threeBranches(),
      bySystem({
        failWhen: sys => sys.includes('Agent B'),
        output: sys => (sys.includes('Agent A') ? '["from-a"]' : '["from-c"]'),
      }),
    );

    // The failure is attributed to its branch…
    const branchErr = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'b2',
    );
    expect(branchErr).toBeDefined();
    if (branchErr?.type === 'phase-error') {
      expect(branchErr.error).toContain('branch exploded');
    }
    // …the composite finalizes with the partial (failed is COUNTED)…
    const partial = partialOf(events);
    expect(partial).toBeDefined();
    if (partial?.type === 'composite-partial') {
      expect(partial.kind).toBe('parallel');
      expect(partial.completed).toBe(2);
      expect(partial.failed).toBe(1);
      expect(partial.total).toBe(3);
    }
    // …and the run CONTINUES: the read phase received both sibling outputs
    // and the reducer state folded from exactly the two successes.
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    const readEnd = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'read',
    );
    expect(readEnd).toBeDefined();
    if (readEnd?.type === 'phase-end') {
      const parsed = JSON.parse(readEnd.output) as {
        input: string;
        list: string[];
      };
      expect(parsed.input).toContain('from-a');
      expect(parsed.input).toContain('from-c');
      expect(parsed.input).not.toContain('exploded');
      expect(parsed.list).toEqual(['from-a', 'from-c']);
    }
  });

  test('ALL branches fail → aggregate phase-error + run-error, no composite-partial (unchanged)', async () => {
    const events = await collect(
      threeBranches(),
      bySystem({ failWhen: () => true, output: () => 'unreachable' }),
    );
    const agg = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'fan',
    );
    expect(agg).toBeDefined();
    if (agg?.type === 'phase-error') {
      expect(agg.error).toMatch(/3 branch\(es\) failed/);
    }
    expect(partialOf(events)).toBeUndefined();
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });

  test('converge with a merger SKIPS the merger on a failure partial (it would summarize an incomplete set as whole)', async () => {
    const events = await collect(
      {
        name: 'flow',
        phases: [
          {
            name: 'fan',
            converge: [
              { name: 'b1', agent: 'agents/a.md' },
              { name: 'b2', agent: 'agents/b.md' },
            ],
            merger: 'agents/c.md',
          },
        ],
      },
      bySystem({
        failWhen: sys => sys.includes('Agent B'),
        output: () => 'from-a',
      }),
    );
    const partial = partialOf(events);
    expect(partial).toBeDefined();
    if (partial?.type === 'composite-partial') {
      expect(partial.kind).toBe('converge');
      expect(partial.completed).toBe(1);
      expect(partial.failed).toBe(1);
    }
    // No merger dispatch happened.
    expect(
      events.some(e => e.type === 'phase-start' && e.phaseName === 'fan/merger'),
    ).toBe(false);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
  });
});

describe('map — failure partials', () => {
  const mapFlow = (body?: Partial<Node>): Node => ({
    name: 'flow',
    phases: [
      {
        name: 'fan',
        map: {
          over: '["one", "two", "three"]',
          body: { name: 'work', agent: 'agents/a.md', ...body },
        },
        as: 'results',
      },
      {
        name: 'read',
        code: {
          source: 'return JSON.stringify({ input, results: state.results })',
        },
      },
    ],
  });

  /** Body input is the item itself — fail exactly the "two" item. */
  const failTwo: StreamFn = async function* (params) {
    const user = params.messages[0]?.content ?? '';
    if (user.includes('two')) throw new Error('item two exploded');
    yield { type: 'text-delta', text: `did:${user}` };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };

  test('1 of 3 items fails → per-item phase-error + composite-partial{completed:2,failed:1} + siblings flow on', async () => {
    const events = await collect(mapFlow(), failTwo);
    const itemErr = events.find(
      e =>
        e.type === 'phase-error' &&
        e.phaseName === 'work' &&
        e.error.startsWith('map item 1 failed:'),
    );
    expect(itemErr).toBeDefined();
    const partial = partialOf(events);
    expect(partial).toBeDefined();
    if (partial?.type === 'composite-partial') {
      expect(partial.kind).toBe('map');
      expect(partial.completed).toBe(2);
      expect(partial.failed).toBe(1);
      expect(partial.total).toBe(3);
    }
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    const readEnd = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'read',
    );
    if (readEnd?.type === 'phase-end') {
      const parsed = JSON.parse(readEnd.output) as {
        input: string;
        results: string[];
      };
      expect(parsed.input).toContain('did:one');
      expect(parsed.input).toContain('did:three');
      expect(parsed.input).not.toContain('exploded');
      // `as` stores the completed items (in index order) as a true array.
      expect(parsed.results).toEqual(['did:one', 'did:three']);
    }
  });

  test('ALL items fail → aggregate phase-error + run-error, no composite-partial (unchanged)', async () => {
    const events = await collect(mapFlow(), async function* () {
      throw new Error('every item exploded');
      // eslint-disable-next-line no-unreachable
      yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const agg = events.find(
      e => e.type === 'phase-error' && e.phaseName === 'fan',
    );
    expect(agg).toBeDefined();
    if (agg?.type === 'phase-error') {
      expect(agg.error).toMatch(/3 map iteration\(s\) failed/);
    }
    expect(partialOf(events)).toBeUndefined();
    expect(events.some(e => e.type === 'run-error')).toBe(true);
  });
});

describe('map — continueOnError failed-item output marking', () => {
  test('a swallowed item failure marks its slot [FAILED item N] instead of echoing the input', async () => {
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: {
        name: 'flow',
        phases: [
          {
            name: 'fan',
            map: {
              over: '["one", "two", "three"]',
              serial: true,
              body: {
                name: 'work',
                agent: 'agents/a.md',
                continueOnError: true,
              },
            },
            as: 'results',
          },
          {
            name: 'read',
            code: {
              source:
                'return JSON.stringify({ input, second: state.results[1] })',
            },
          },
        ],
      },
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      streamFn: async function* (params) {
        const user = params.messages[0]?.content ?? '';
        if (user.includes('two')) throw new Error('item two exploded');
        yield { type: 'text-delta', text: `did:${user}` };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: AGENTS,
      orchestrationsOverride: [],
    })) {
      events.push(ev);
    }

    // Swallowed (continueOnError) — the map is NOT a failure partial: every
    // item "completed", one of them with a marker. No composite-partial, no
    // run error; the swallowed failure still surfaced as runItem's phase-error.
    expect(partialOf(events)).toBeUndefined();
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(
      events.some(
        e =>
          e.type === 'phase-error' &&
          e.phaseName === 'work' &&
          e.error.includes('item two exploded'),
      ),
    ).toBe(true);

    const readEnd = events.find(
      e => e.type === 'phase-end' && e.phaseName === 'read',
    );
    expect(readEnd).toBeDefined();
    if (readEnd?.type === 'phase-end') {
      const parsed = JSON.parse(readEnd.output) as {
        input: string;
        second: string;
      };
      // The joined pipe carries the marker — a downstream consumer can no
      // longer mistake the failed item's echoed input for a real result…
      expect(parsed.input).toContain('[FAILED item 1] item two exploded');
      // …the structured `as` array element is the same marker string…
      expect(parsed.second).toBe('[FAILED item 1] item two exploded');
      // …and successful items are untouched.
      expect(parsed.input).toContain('did:one');
      expect(parsed.input).toContain('did:three');
    }
  });
});
