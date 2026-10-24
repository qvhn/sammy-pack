/**
 * Tests for the additive validation rule: Claude-only features (subagents /
 * mcp / per-node tools) used with a non-Anthropic provider emit a *warning*
 * (advisory — those features silently no-op at runtime on non-Claude paths).
 */

import { validateOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const claudeOnlyWarn = (n: Node) =>
  validateOrchestration(n).find(
    e => e.severity === 'warning' && /Claude-only/.test(e.message),
  );

describe('validate: Claude-only features on non-Anthropic provider', () => {
  test('warns when an openai phase declares tools', () => {
    const w = claudeOnlyWarn({
      name: 'root',
      phases: [{ name: 'p', agent: 'a', provider: 'openai', tools: ['Read'] }],
    });
    expect(w).toBeTruthy();
    expect(w?.nodeName).toBe('p');
    expect(w?.severity).toBe('warning');
  });

  test('warns for gemini + subagents and lists the feature', () => {
    const w = claudeOnlyWarn({
      name: 'root',
      phases: [{ name: 'p', agent: 'a', provider: 'gemini', subagents: ['x'] }],
    });
    expect(w?.message).toMatch(/subagents/);
  });

  test('no warning for anthropic provider with tools', () => {
    expect(
      claudeOnlyWarn({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', provider: 'anthropic', tools: ['Read'] }],
      }),
    ).toBeUndefined();
  });

  test('no warning for claude-code provider with mcp', () => {
    expect(
      claudeOnlyWarn({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', provider: 'claude-code', mcp: ['srv'] }],
      }),
    ).toBeUndefined();
  });

  test('no warning when a non-Anthropic provider declares no Claude-only features', () => {
    expect(
      claudeOnlyWarn({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', provider: 'gemini' }],
      }),
    ).toBeUndefined();
  });
});

describe('validate: trigger kinds (P0–P3)', () => {
  const errs = (n: Node) =>
    validateOrchestration(n).filter(e => e.severity === 'error');
  const trig = (t: unknown): Node => ({
    name: 'root',
    triggers: [t] as Node['triggers'],
    phases: [{ name: 'p', code: { source: 'return input' } }],
  });

  test('accepts all six live trigger kinds', () => {
    expect(errs(trig({ kind: 'webhook', path: 'wh' }))).toHaveLength(0);
    expect(errs(trig({ kind: 'cron', expr: '0 9 * * *' }))).toHaveLength(0);
    expect(errs(trig({ kind: 'events', event: 'a.done' }))).toHaveLength(0);
    expect(errs(trig({ kind: 'deployment', environment: 'staging' }))).toHaveLength(0);
    expect(errs(trig({ kind: 'queue', queue: 'jobs' }))).toHaveLength(0);
    expect(
      errs(trig({ kind: 'polling', source: 'https://x', intervalSeconds: 60 })),
    ).toHaveLength(0);
  });

  test('flags missing required fields per kind', () => {
    expect(errs(trig({ kind: 'events' }))[0].message).toMatch(/event/);
    expect(errs(trig({ kind: 'deployment' }))[0].message).toMatch(/environment/);
    expect(errs(trig({ kind: 'queue' }))[0].message).toMatch(/queue/);
    // A real URL, so the only thing missing is the interval — `source: 'x'`
    // now (correctly) also fails URL validation, and asserting on [0] made
    // this case depend on which issue happened to be reported first.
    expect(
      errs(trig({ kind: 'polling', source: 'https://example.com/feed' })).map(
        e => e.message,
      ),
    ).toEqual([expect.stringMatching(/intervalSeconds/)]);
  });

  test('rejects an unknown trigger kind', () => {
    const e = errs(trig({ kind: 'telepathy' }));
    expect(e[0].message).toMatch(/webhook \/ cron \/ events/);
  });
});

describe('validate: engine-enforced bounds (B3)', () => {
  const warnings = (n: Node) =>
    validateOrchestration(n).filter(e => e.severity === 'warning');

  test('route without a default branch warns (routing not total)', () => {
    const w = warnings({
      name: 'root',
      route: {
        router: 'agents/r.md',
        branches: { a: { name: 'a', agent: 'agents/a.md' } },
      },
    } as unknown as Node).find(e => /no `default`/.test(e.message));
    expect(w).toBeTruthy();
    expect(w?.severity).toBe('warning');
  });

  test('route WITH a default does not warn about totality', () => {
    const w = warnings({
      name: 'root',
      route: {
        branches: { a: { name: 'a', agent: 'agents/a.md' } },
        default: { name: 'd', agent: 'agents/d.md' },
      },
    } as unknown as Node).find(e => /no `default`/.test(e.message));
    expect(w).toBeUndefined();
  });
});

describe('validate: code body accepts source OR run (schema oneOf parity)', () => {
  const errs = (n: Node) =>
    validateOrchestration(n).filter(e => e.severity === 'error');
  const codeNode = (code: unknown): Node =>
    ({ name: 'root', phases: [{ name: 'p', code }] } as unknown as Node);

  test('accepts a code.source inline-JS leaf', () => {
    expect(errs(codeNode({ source: 'return input' }))).toHaveLength(0);
  });

  test('accepts a code.run shell-command leaf (no longer rejected)', () => {
    expect(errs(codeNode({ run: 'npm run env:stg && echo hi' }))).toHaveLength(
      0,
    );
  });

  test('errors when code has neither source nor run', () => {
    const e = errs(codeNode({}));
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/either `source`.*or `run`/);
  });

  test('errors when code provides both source and run (mutually exclusive)', () => {
    const e = errs(codeNode({ source: 'return 1', run: 'echo hi' }));
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/mutually exclusive/);
  });

  test('errors when code is not an object', () => {
    const e = errs(codeNode('return input'));
    expect(e).toHaveLength(1);
    expect(e[0].message).toMatch(/code must be an object/);
  });
});

describe('validate: numeric caps enforced (match the schema maximums)', () => {
  const capErr = (n: Node, re: RegExp) =>
    validateOrchestration(n).find(e => e.severity === 'error' && re.test(e.message));

  test('loop.maxIterations: accepts the cap (100), rejects over (101) and under (0)', () => {
    const loop = (maxIterations: number): Node => ({
      name: 'root',
      phases: [{ name: 'l', loop: { body: { name: 'b', agent: 'a' }, maxIterations } }],
    });
    expect(capErr(loop(100), /maxIterations/)).toBeUndefined();
    expect(capErr(loop(101), /maxIterations/)).toBeTruthy();
    expect(capErr(loop(0), /maxIterations/)).toBeTruthy();
  });

  test('conversation.rounds: rejects over the cap (51)', () => {
    const conv = (rounds: number): Node => ({
      name: 'root',
      phases: [{ name: 'c', conversation: { participants: ['a', 'b'], rounds } }],
    });
    expect(capErr(conv(50), /rounds/)).toBeUndefined();
    expect(capErr(conv(51), /rounds/)).toBeTruthy();
  });

  test('retry.times: rejects over the cap (21)', () => {
    const ret = (times: number): Node => ({
      name: 'root',
      phases: [{ name: 'p', agent: 'a', retry: { times } }],
    });
    expect(capErr(ret(20), /retry\.times/)).toBeUndefined();
    expect(capErr(ret(21), /retry\.times/)).toBeTruthy();
  });

  test('retry.initialMs: rejects over the cap (60001), allows omitted', () => {
    const ret = (initialMs?: number): Node => ({
      name: 'root',
      phases: [{ name: 'p', agent: 'a', retry: { times: 1, ...(initialMs != null ? { initialMs } : {}) } }],
    });
    expect(capErr(ret(), /initialMs/)).toBeUndefined();
    expect(capErr(ret(60000), /initialMs/)).toBeUndefined();
    expect(capErr(ret(60001), /initialMs/)).toBeTruthy();
  });
});
