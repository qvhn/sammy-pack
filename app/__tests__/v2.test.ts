/**
 * Tests for v2 pure-function modules: interpolate, resolveOver, whenTruthy,
 * validateOrchestration, pricing.
 */

import {
  interpolate,
  resolveOver,
  whenTruthy,
} from '../src/llm/interpolate';
import { costUsd, knownModel } from '../src/llm/pricing';
import {
  collectAgentPaths,
  validateAgentExistence,
  validateOrchestration,
} from '../src/validate';
import type { Node } from '../src/types';

describe('interpolate', () => {
  test('substitutes simple ${name}', () => {
    expect(interpolate('Hello ${who}', { who: 'world' })).toBe('Hello world');
  });

  test('substitutes dotted path ${a.b}', () => {
    expect(interpolate('Got ${user.name}', { user: { name: 'Alex' } })).toBe('Got Alex');
  });

  test('leaves unknown ${refs} literal', () => {
    expect(interpolate('Hi ${missing}', {})).toBe('Hi ${missing}');
  });

  test('stringifies non-string values', () => {
    expect(interpolate('${n}', { n: 42 })).toBe('42');
    expect(interpolate('${obj}', { obj: { a: 1 } })).toBe('{"a":1}');
  });

  test('passthrough for templates without ${ }', () => {
    expect(interpolate('no refs here', { x: 'y' })).toBe('no refs here');
  });

  test('supports multiple refs in one template', () => {
    expect(interpolate('${a}-${b}-${a}', { a: '1', b: '2' })).toBe('1-2-1');
  });

  test('auto-parses a JSON-string `as`-output for a deeper field', () => {
    // An agent's `as`-bound output is stored as a raw string; a dotted ref
    // into it should transparently parse the JSON instead of dead-ending.
    const state = { login: '{"ready":true,"perSim":{"host":"ok"}}' };
    expect(interpolate('${login.ready}', state)).toBe('true');
    expect(interpolate('${login.perSim.host}', state)).toBe('ok');
  });

  test('auto-parses a JSON-array string for an index/length ref', () => {
    const state = { items: '[{"id":1},{"id":2}]' };
    expect(interpolate('${items.0.id}', state)).toBe('1');
    expect(interpolate('${items.length}', state)).toBe('2');
  });

  test('a non-JSON string with a deeper ref stays literal (not a crash)', () => {
    expect(interpolate('${s.field}', { s: 'just text' })).toBe('${s.field}');
  });
});

describe('resolveOver', () => {
  test('parses inline JSON array literal', () => {
    expect(resolveOver('[1, 2, 3]', {})).toEqual([1, 2, 3]);
  });

  test('resolves ${state} array', () => {
    expect(resolveOver('${items}', { items: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  test('resolves ${state} JSON-encoded array string', () => {
    expect(resolveOver('${items}', { items: '[10, 20]' })).toEqual([10, 20]);
  });

  test('throws on non-array state ref', () => {
    expect(() => resolveOver('${items}', { items: 42 })).toThrow(/non-array/);
  });

  test('throws on missing state ref', () => {
    expect(() => resolveOver('${missing}', {})).toThrow(/undefined/);
  });
});

describe('whenTruthy', () => {
  test.each([
    ['true', true],
    ['yes', true],
    ['1', true],
    ['anything', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['null', false],
    ['undefined', false],
    ['no', false],
    ['', false],
    ['  ', false],
  ])('"%s" → %s', (input, expected) => {
    expect(whenTruthy(input, {})).toBe(expected);
  });

  test('resolves ${var} before testing truthiness', () => {
    expect(whenTruthy('${flag}', { flag: 'true' })).toBe(true);
    expect(whenTruthy('${flag}', { flag: 'false' })).toBe(false);
    expect(whenTruthy('${flag}', {})).toBe(true); // literal ${flag}
  });
});

describe('pricing', () => {
  test('knownModel recognises Opus 4.7', () => {
    expect(knownModel('claude-opus-4-7')).toBe(true);
  });

  test('costUsd for opus per-M tokens', () => {
    // 1M input tokens = $15
    expect(costUsd('claude-opus-4-7', 1_000_000, 0)).toBeCloseTo(15);
    expect(costUsd('claude-opus-4-7', 0, 1_000_000)).toBeCloseTo(75);
  });

  test('costUsd returns 0 for unknown model', () => {
    expect(costUsd('unknown-model', 1000, 1000)).toBe(0);
  });

  test('strips date suffix before lookup', () => {
    expect(costUsd('claude-3-haiku-20240307', 1_000_000, 0)).toBeCloseTo(0.25);
  });
});

describe('validateOrchestration', () => {
  function ok(node: Node) {
    // "valid" = no ERRORS. Advisory warnings (e.g. a route without a default)
    // don't make an orchestration invalid.
    const errors = validateOrchestration(node).filter(
      e => e.severity === 'error',
    );
    expect(errors).toEqual([]);
  }
  function errs(node: Node) {
    return validateOrchestration(node);
  }

  test('valid agent leaf', () => {
    ok({ name: 'a', agent: 'agents/x.md' });
  });

  test('valid phases', () => {
    ok({
      name: 'flow',
      phases: [
        { name: 'one', agent: 'agents/a.md' },
        { name: 'two', agent: 'agents/b.md' },
      ],
    });
  });

  test('rejects node with no body', () => {
    const e = errs({ name: 'broken' } as Node);
    expect(e.some(x => /no body/.test(x.message))).toBe(true);
  });

  test('rejects node with two bodies', () => {
    const e = errs({
      name: 'mixed',
      agent: 'agents/a.md',
      phases: [{ name: 'p', agent: 'agents/b.md' }],
    });
    expect(e.some(x => /multiple bodies/.test(x.message))).toBe(true);
  });

  test('rejects parallel with 1 branch', () => {
    const e = errs({
      name: 'p',
      parallel: [{ name: 'only', agent: 'agents/a.md' }],
    });
    expect(e.some(x => /at least 2/.test(x.message))).toBe(true);
  });

  test('rejects loop without maxIterations', () => {
    const e = errs({
      name: 'l',
      loop: { body: { name: 'b', agent: 'agents/a.md' } } as Node['loop'],
    });
    expect(e.some(x => /maxIterations/.test(x.message))).toBe(true);
  });

  test('rejects merger without converge', () => {
    const e = errs({
      name: 'p',
      parallel: [
        { name: 'a', agent: 'agents/a.md' },
        { name: 'b', agent: 'agents/b.md' },
      ],
      merger: 'agents/m.md',
    });
    expect(e.some(x => /merger is only valid on converge/.test(x.message))).toBe(true);
  });

  test('rejects tools on non-agent node', () => {
    const e = errs({
      name: 'p',
      phases: [{ name: 'x', agent: 'agents/a.md' }],
      tools: ['github'],
    });
    expect(e.some(x => /tools is only valid on agent/.test(x.message))).toBe(true);
  });

  test('rejects bad as: name', () => {
    const e = errs({ name: 'p', agent: 'agents/a.md', as: 'bad-name' });
    expect(e.some(x => /as:/.test(x.message))).toBe(true);
  });

  test('rejects empty budget', () => {
    const e = errs({ name: 'p', agent: 'agents/a.md', budget: {} });
    expect(e.some(x => /maxTokens or maxCostUsd/.test(x.message))).toBe(true);
  });

  test('rejects map without over', () => {
    const e = errs({
      name: 'm',
      map: { body: { name: 'b', agent: 'agents/a.md' } } as Node['map'],
    });
    expect(e.some(x => /over is required/.test(x.message))).toBe(true);
  });

  test('valid map with budget + retry on body', () => {
    ok({
      name: 'm',
      map: {
        over: '${docs}',
        body: {
          name: 'b',
          agent: 'agents/a.md',
          retry: { times: 2, backoff: 'exponential' },
        },
      },
      budget: { maxCostUsd: 5 },
    });
  });

  test('valid full v2 example (route + onError + tools + retry)', () => {
    ok({
      name: 'incident',
      phases: [
        {
          name: 'dispatch',
          route: {
            router: 'agents/r.md',
            branches: {
              p0: {
                name: 'page',
                agent: 'agents/page.md',
                retry: { times: 3 },
                tools: ['pagerduty'],
                onError: { name: 'fb', agent: 'agents/fb.md' },
              },
            },
          },
        },
      ],
    });
  });
});

describe('collectAgentPaths', () => {
  test('leaf agent', () => {
    expect(collectAgentPaths({ name: 'p', agent: 'agents/a.md' })).toEqual([
      'agents/a.md',
    ]);
  });

  test('all the corners (agents, merger, judge, router, participants, onError, map, route default)', () => {
    const node: Node = {
      name: 'root',
      phases: [
        { name: 'serial', agents: ['agents/a.md', 'agents/b.md'] },
        {
          name: 'p',
          parallel: [
            { name: 'p1', agent: 'agents/c.md' },
            { name: 'p2', agent: 'agents/d.md' },
          ],
        },
        {
          name: 'c',
          converge: [
            { name: 'c1', agent: 'agents/e.md' },
            { name: 'c2', agent: 'agents/f.md' },
          ],
          merger: 'agents/m.md',
        },
        {
          name: 'l',
          loop: {
            body: { name: 'b', agent: 'agents/g.md' },
            maxIterations: 3,
            judge: 'agents/j.md',
          },
        },
        {
          name: 'conv',
          conversation: { participants: ['agents/h.md', 'agents/i.md'], rounds: 2 },
        },
        {
          name: 'r',
          route: {
            router: 'agents/rt.md',
            branches: { x: { name: 'x', agent: 'agents/x.md' } },
            default: { name: 'def', agent: 'agents/dflt.md' },
          },
        },
        {
          name: 'mp',
          map: {
            over: '${docs}',
            body: {
              name: 'mb',
              agent: 'agents/n.md',
              onError: { name: 'er', agent: 'agents/oe.md' },
            },
          },
        },
      ],
    };
    expect(collectAgentPaths(node)).toEqual([
      'agents/a.md', 'agents/b.md', 'agents/c.md', 'agents/d.md',
      'agents/dflt.md', 'agents/e.md', 'agents/f.md', 'agents/g.md',
      'agents/h.md', 'agents/i.md', 'agents/j.md', 'agents/m.md',
      'agents/n.md', 'agents/oe.md', 'agents/rt.md', 'agents/x.md',
    ]);
  });

  test('dedupes repeated references', () => {
    const node: Node = {
      name: 'r',
      phases: [
        { name: 'a', agent: 'agents/same.md' },
        { name: 'b', agent: 'agents/same.md' },
      ],
    };
    expect(collectAgentPaths(node)).toEqual(['agents/same.md']);
  });
});

describe('validateAgentExistence', () => {
  test('no warnings when all referenced agents exist', () => {
    const errs = validateAgentExistence(
      { name: 'p', agent: 'agents/a.md' },
      new Set(['agents/a.md', 'agents/extra.md']),
    );
    expect(errs).toEqual([]);
  });

  test('one warning per missing agent', () => {
    const errs = validateAgentExistence(
      {
        name: 'p',
        phases: [
          { name: 'one', agent: 'agents/exists.md' },
          { name: 'two', agent: 'agents/missing.md' },
          { name: 'three', agent: 'agents/also-missing.md' },
        ],
      },
      new Set(['agents/exists.md']),
    );
    expect(errs.length).toBe(2);
    expect(errs.every(e => e.severity === 'warning')).toBe(true);
    expect(errs.map(e => e.path).sort()).toEqual([
      'agents/also-missing.md', 'agents/missing.md',
    ]);
  });

  test('dedupes — same missing agent referenced twice = one warning', () => {
    const errs = validateAgentExistence(
      {
        name: 'p',
        phases: [
          { name: 'one', agent: 'agents/missing.md' },
          { name: 'two', agent: 'agents/missing.md' },
        ],
      },
      new Set(),
    );
    expect(errs.length).toBe(1);
  });
});

describe('deriveAgentName (agent-source scan)', () => {
  // Imported lazily so jest's module load doesn't trip over the rest of
  // sammy-pack-api.ts (which has Vite-plugin types).
  const { deriveAgentName } = require('../sammy-pack-api');

  test('flat file: <file>.md → file', () => {
    expect(deriveAgentName('', 'writer.md')).toBe('writer');
    expect(deriveAgentName('.', 'writer.md')).toBe('writer');
  });

  test('one-level: <dir>/<file>.md → dir-file (component-role pattern)', () => {
    expect(deriveAgentName('billing', 'host-qa.md')).toBe('billing-host-qa');
    expect(deriveAgentName('search', 'guest-qa.md')).toBe('search-guest-qa');
  });

  test('strips the `components` wrapper (common multi-component repo layout)', () => {
    expect(deriveAgentName('components/billing', 'host-qa.md')).toBe(
      'billing-host-qa',
    );
    expect(deriveAgentName('components/flows', 'first-time-onboarding.md')).toBe(
      'flows-first-time-onboarding',
    );
  });

  test('deep nesting: keeps all dir prefixes', () => {
    expect(deriveAgentName('a/b/c', 'leaf.md')).toBe('a-b-c-leaf');
  });

  test('returns null for names with unsafe chars', () => {
    expect(deriveAgentName('weird dir', 'agent.md')).toBeNull();
    expect(deriveAgentName('', 'name with spaces.md')).toBeNull();
  });
});

describe('claude-code adapter (mocked fetch)', () => {
  // The streamClaudeCode adapter posts to /api/llm/stream and parses SSE.
  // Tests stub the global fetch with a ReadableStream of SSE bytes and
  // assert the StreamEvents come out in the right shape — same contract
  // as streamAnthropic so the two adapters are drop-in.
  //
  // Imported lazily so jest.mock-style globals don't conflict with the
  // earlier describes in this file.
  const { streamClaudeCode } = require('../src/llm/claude-code');

  function sseStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const l of lines) controller.enqueue(encoder.encode(l + '\n'));
        controller.close();
      },
    });
  }

  function mockFetchOk(body: ReadableStream<Uint8Array>) {
    (globalThis as { fetch?: unknown }).fetch = async () =>
      new Response(body, { status: 200 });
  }

  function mockFetchError(status: number, text: string) {
    (globalThis as { fetch?: unknown }).fetch = async () =>
      new Response(text, { status });
  }

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  async function collect(iter: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of iter) out.push(ev);
    return out;
  }

  test('yields text-deltas + final done with usage', async () => {
    mockFetchOk(
      sseStream([
        'data: {"type":"text-delta","text":"Hello "}',
        '',
        'data: {"type":"text-delta","text":"world"}',
        '',
        'data: {"type":"done","usage":{"inputTokens":10,"outputTokens":20}}',
        '',
        'data: [DONE]',
        '',
      ]),
    );
    const events = await collect(
      streamClaudeCode({
        apiKey: '',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    // Two text-delta + one done from the server, plus the adapter
    // yields a final synthetic `done` so the executor always gets one.
    const deltas = events.filter(
      (e): e is { type: 'text-delta'; text: string } =>
        typeof e === 'object' && e !== null && (e as { type?: string }).type === 'text-delta',
    );
    expect(deltas.map(d => d.text)).toEqual(['Hello ', 'world']);

    const dones = events.filter(
      (e): e is { type: 'done'; usage: { inputTokens: number; outputTokens: number } } =>
        typeof e === 'object' && e !== null && (e as { type?: string }).type === 'done',
    );
    // The adapter always yields its own final 'done' with whatever usage
    // it accumulated; the server-emitted 'done' updates that usage state
    // mid-stream, so the final yielded done carries 10/20.
    expect(dones.length).toBeGreaterThanOrEqual(1);
    expect(dones[dones.length - 1].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test('throws on server error event', async () => {
    mockFetchOk(
      sseStream([
        'data: {"type":"error","error":"auth failed"}',
        '',
      ]),
    );
    await expect(
      collect(
        streamClaudeCode({
          apiKey: '',
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow(/Claude Code proxy error: auth failed/);
  });

  test('throws on non-2xx HTTP', async () => {
    mockFetchError(500, 'internal err');
    await expect(
      collect(
        streamClaudeCode({
          apiKey: '',
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).rejects.toThrow(/Claude Code proxy 500/);
  });

  test('skips malformed SSE lines without crashing', async () => {
    mockFetchOk(
      sseStream([
        'data: not-json-at-all',
        '',
        'data: {"type":"text-delta","text":"ok"}',
        '',
        'data: [DONE]',
        '',
      ]),
    );
    const events = await collect(
      streamClaudeCode({
        apiKey: '',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const deltas = events.filter(
      (e): e is { type: 'text-delta'; text: string } =>
        typeof e === 'object' && e !== null && (e as { type?: string }).type === 'text-delta',
    );
    expect(deltas.map(d => d.text)).toEqual(['ok']);
  });
});
