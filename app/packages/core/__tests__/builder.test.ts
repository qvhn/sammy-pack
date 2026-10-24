/**
 * TypeScript authoring DSL (builder.ts) tests.
 *
 * Three concerns:
 *  (a) a representative orchestration built with the DSL is valid — both
 *      against the repo validator (validateOrchestration) AND structurally
 *      against the real schema/orchestration.schema.json (a mini
 *      $ref-resolving conformance checker below enforces
 *      `additionalProperties: false`, the oneOf body-kind rule, enums,
 *      bounds — so no builder-invented key can leak into the JSON);
 *  (b) property round-trip — every node decorator and every root-only
 *      property appears in the emitted JSON exactly as authored;
 *  (c) misuse fails loudly — unknown/misplaced options throw at the factory
 *      call, and a two-body-kind node (hand-written raw JSON mixed into the
 *      tree) fails at compile().
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  orchestration,
  agentPhase,
  agents,
  phases,
  parallelNodes,
  converge,
  subflow,
  loop,
  conversation,
  route,
  switchOn,
  mapOver,
  a2a,
  codePhase,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
  deploymentTrigger,
  pollingTrigger,
  queueTrigger,
  BuilderError,
  CompileError,
  validateOrchestration,
  type AgentOpts,
  type Node,
} from '../src/index';

// ── Mini JSON-Schema conformance checker ─────────────────────────────────
// The repo's hand-rolled validators deliberately skip unknown-key checks
// (validate.ts) and $ref (lib/json-schema-check.ts). This test needs BOTH —
// the whole point of the DSL contract is "no extra keys leak into output"
// — so we walk the published schema directly, resolving $refs against
// $defs. Covers exactly the keywords orchestration.schema.json uses:
// $ref · type · enum · const · properties/required/additionalProperties ·
// items/minItems/maxItems · minProperties · minLength · pattern ·
// minimum/maximum/exclusiveMinimum · oneOf · anyOf · allOf(if/then).

type Json = Record<string, unknown>;

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../schema/orchestration.schema.json',
);
const SCHEMA: Json = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

function resolveRef(ref: string, root: Json): Json {
  let cur: unknown = root;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    cur = (cur as Json)[part];
    if (cur === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return cur as Json;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(actual: string, expected: string): boolean {
  return (
    actual === expected || (expected === 'number' && actual === 'integer')
  );
}

function conforms(value: unknown, schema: Json): boolean {
  return schemaViolations(value, schema, '').length === 0;
}

function schemaViolations(
  value: unknown,
  schema: Json,
  at: string,
): string[] {
  const out: string[] = [];
  walk(value, schema, at, out);
  return out;
}

function walk(value: unknown, schema: Json, at: string, out: string[]): void {
  if (typeof schema.$ref === 'string') {
    walk(value, resolveRef(schema.$ref, SCHEMA), at, out);
    return;
  }

  const actual = jsonType(value);
  if (typeof schema.type === 'string' && !typeMatches(actual, schema.type)) {
    out.push(`${at || '/'}: expected ${schema.type}, got ${actual}`);
    return; // deeper keyword checks would be noise
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    out.push(`${at || '/'}: must equal const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
      out.push(`${at || '/'}: not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${at || '/'}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      out.push(`${at || '/'}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${at || '/'}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${at || '/'}: above maximum ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      out.push(`${at || '/'}: not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${at || '/'}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push(`${at || '/'}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) =>
        walk(item, schema.items as Json, `${at}/${i}`, out),
      );
    }
  }

  if (actual === 'object' && value !== null) {
    const obj = value as Json;
    const props = (schema.properties ?? {}) as Record<string, Json>;
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(String(req) in obj)) out.push(`${at || '/'}: missing required "${req}"`);
      }
    }
    if (
      typeof schema.minProperties === 'number' &&
      Object.keys(obj).length < schema.minProperties
    ) {
      out.push(`${at || '/'}: fewer than minProperties ${schema.minProperties}`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) {
        walk(v, props[key], `${at}/${key}`, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${at || '/'}: unknown key "${key}" (additionalProperties: false)`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        walk(v, schema.additionalProperties as Json, `${at}/${key}`, out);
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(s => conforms(value, s as Json));
    if (matched.length !== 1) {
      out.push(`${at || '/'}: matched ${matched.length} of oneOf (need exactly 1)`);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(s => conforms(value, s as Json))) {
      out.push(`${at || '/'}: matched none of anyOf`);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf as Json[]) {
      if (entry.if && entry.then) {
        if (conforms(value, entry.if as Json)) {
          walk(value, entry.then as Json, at, out);
        }
      } else {
        walk(value, entry, at, out);
      }
    }
  }
}

/** Sanity-check the checker itself so a hollow conformance pass can't
 *  silently bless everything. */
describe('schema conformance checker (self-test)', () => {
  it('accepts a minimal valid node and rejects known-bad shapes', () => {
    expect(schemaViolations({ name: 'x', agent: 'a.md' }, SCHEMA, '')).toEqual([]);
    // unknown key
    expect(
      schemaViolations({ name: 'x', agent: 'a.md', bogus: 1 }, SCHEMA, '').join('\n'),
    ).toMatch(/unknown key "bogus"/);
    // two body kinds → oneOf matches 2
    expect(
      schemaViolations(
        { name: 'x', agent: 'a.md', code: { source: 'return 1;' } },
        SCHEMA,
        '',
      ).join('\n'),
    ).toMatch(/oneOf/);
    // no body kind → oneOf matches 0
    expect(schemaViolations({ name: 'x' }, SCHEMA, '').join('\n')).toMatch(/oneOf/);
  });
});

// ── (a) Representative orchestration validates cleanly ───────────────────

function buildRepresentative() {
  return orchestration('summarize_report', {
    description: 'Split a report, summarize each section, refine, publish.',
    vars: { tone: 'concise' },
    state: { summaries: { reducer: 'append' } },
    inputs: [
      { name: 'report', kind: 'text', required: true, description: 'Raw report JSON' },
    ],
    defaults: { timeout: 900, stallTimeout: 300 },
    autoApproveLocks: true,
    concurrency: { group: 'report_pipeline', policy: 'queue' },
    triggers: [cronTrigger('0 9 * * *'), webhookTrigger('summarize', { signed: true })],
    notify: {
      onTerminal: 'https://example.com/hooks/runs',
      divergence: { repeatThreshold: 4, abort: false },
    },
    lifecycle: { stage: 'dev', tags: ['starter'] },
    sandbox: { deniedCommands: ['rm -rf', 'sudo'], networkAccess: true },
    budget: { maxCostUsd: 10 },
  }).phases(
    codePhase('split_sections', 'return JSON.parse(input).sections;', {
      as: 'sections',
      timeout: 30,
    }),
    mapOver(
      'summarize_each',
      '${sections}',
      agentPhase('summarize_one', 'agents/summarizer.md', {
        prompt: 'Summarize this section in a ${tone} style: ${item}',
        as: 'summaries',
        tools: ['Read'],
        retry: { times: 2, backoff: 'exponential', initialMs: 1000 },
      }),
      { concurrency: 2 },
    ),
    loop(
      'refine_draft',
      agentPhase('draft', 'agents/writer.md', { prompt: 'Draft from: ${summaries}' }),
      {
        maxIterations: 3,
        judge: 'agents/judge.md',
        stopAtScore: 0.9,
        retryOnFailure: true,
        maxFailures: 2,
      },
    ),
    route(
      'triage_length',
      {
        short: agentPhase('tighten', 'agents/editor.md'),
        long: phases('condense', [
          codePhase('truncate', 'return input.slice(0, 4000);'),
          agentPhase('recap', 'agents/editor.md'),
        ]),
      },
      {
        router: 'agents/length-router.md',
        default: agentPhase('pass_through', 'agents/editor.md'),
      },
    ),
    switchOn(
      'quality_gate',
      {
        pass: converge(
          'cross_check',
          [
            agentPhase('fact_check', 'agents/checker.md'),
            a2a('style_check', 'https://example.com/.well-known/agent-card.json', {
              skill: 'style-review',
              idempotencyKey: 'style-${index}',
            }),
          ],
          { merger: 'agents/merger.md' },
        ),
        fail: parallelNodes('rework', [
          agents('polish', ['agents/editor.md', 'agents/proofreader.md']),
          conversation('debate_fixes', ['agents/critic.md', 'agents/defender.md'], 2),
        ]),
      },
      { on: '${verdict}', default: agentPhase('manual_review', 'agents/editor.md', { lock: true }) },
    ),
    subflow('publish', 'publish_summary', { when: '${summaries}', finally: true }),
  );
}

describe('(a) representative orchestration', () => {
  it('has zero error-severity findings from the repo validator', () => {
    const json = buildRepresentative().build();
    const errors = validateOrchestration(json).filter(f => f.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('conforms structurally to schema/orchestration.schema.json', () => {
    const json = buildRepresentative().build();
    expect(schemaViolations(json, SCHEMA, '')).toEqual([]);
  });

  it('compile() returns the same JSON build() emits', () => {
    const flow = buildRepresentative();
    expect(flow.compile()).toEqual(flow.build());
  });

  it('build() emits independent clones (mutation-safe)', () => {
    const flow = buildRepresentative();
    const first = flow.build();
    (first.phases as Node[]).pop();
    delete (first as Record<string, unknown>).vars;
    const second = flow.build();
    expect((second.phases as Node[]).length).toBe(6);
    expect(second.vars).toEqual({ tone: 'concise' });
  });
});

// ── (b) Property round-trip ──────────────────────────────────────────────

describe('(b) property round-trip', () => {
  it('every node decorator lands in the emitted JSON exactly as authored', () => {
    const node = agentPhase('worker', 'agents/worker.md', {
      description: 'does the work',
      lock: true,
      input: 'schemas/work-in.json',
      output: { type: 'object', required: ['result'] },
      as: 'result',
      when: '${ready}',
      halt: true,
      idempotencyKey: 'work-${vars.env}',
      onError: codePhase('recover', 'return "recovered";'),
      timeout: 120,
      stallTimeout: 60,
      retry: { times: 3, backoff: 'exponential', initialMs: 500 },
      onStall: { recover: codePhase('kick', 'return "kicked";'), maxRetries: 2 },
      budget: { maxTokens: 50000, maxCostUsd: 2.5 },
      tools: ['Read', 'Bash'],
      mcp: ['browser'],
      autoApproveTools: ['mcp__browser__navigate'],
      prompt: 'Do the work on ${input}',
      maxTurns: 40,
      maxAgentTokens: 1000000,
      continueOnError: true,
      finally: true,
      provider: 'anthropic',
      model: 'some-model-id',
      effort: 'medium',
      credential: 'llm_key',
      credentials: ['tracker', 'repo_host'],
      sandbox: {
        allowedTools: ['Read', 'Bash'],
        deniedCommands: ['rm -rf'],
        networkAccess: false,
        permissionMode: 'plan',
        maxRunSeconds: 10,
        maxOutputBytes: 1024,
        maxFanout: 5,
      },
      _layout: { worker: [10, 20] },
    });

    expect(node).toEqual({
      name: 'worker',
      agent: 'agents/worker.md',
      description: 'does the work',
      lock: true,
      input: 'schemas/work-in.json',
      output: { type: 'object', required: ['result'] },
      as: 'result',
      when: '${ready}',
      halt: true,
      idempotencyKey: 'work-${vars.env}',
      onError: { name: 'recover', code: { source: 'return "recovered";' } },
      timeout: 120,
      stallTimeout: 60,
      retry: { times: 3, backoff: 'exponential', initialMs: 500 },
      onStall: {
        recover: { name: 'kick', code: { source: 'return "kicked";' } },
        maxRetries: 2,
      },
      budget: { maxTokens: 50000, maxCostUsd: 2.5 },
      tools: ['Read', 'Bash'],
      mcp: ['browser'],
      autoApproveTools: ['mcp__browser__navigate'],
      prompt: 'Do the work on ${input}',
      maxTurns: 40,
      maxAgentTokens: 1000000,
      continueOnError: true,
      finally: true,
      provider: 'anthropic',
      model: 'some-model-id',
      effort: 'medium',
      credential: 'llm_key',
      credentials: ['tracker', 'repo_host'],
      sandbox: {
        allowedTools: ['Read', 'Bash'],
        deniedCommands: ['rm -rf'],
        networkAccess: false,
        permissionMode: 'plan',
        maxRunSeconds: 10,
        maxOutputBytes: 1024,
        maxFanout: 5,
      },
      _layout: { worker: [10, 20] },
    });
    // And the decorated leaf is schema-clean.
    expect(schemaViolations(node, SCHEMA, '')).toEqual([]);
  });

  it('every root-only property lands in the emitted JSON exactly as authored', () => {
    const flow = orchestration('root_props', {
      vars: { env: 'staging', tone: 'terse' },
      inputs: [{ name: 'doc', kind: 'url', required: false, description: 'source doc' }],
      state: {
        findings: { reducer: 'append', initial: [] },
        totals: { reducer: 'increment', initial: 0 },
      },
      defaults: { timeout: 600, stallTimeout: 120, maxAgentTokens: 2000000 },
      autoApproveLocks: true,
      concurrency: { group: 'shared_env', policy: 'cancel-existing' },
      triggers: [
        cronTrigger('*/5 * * * *'),
        webhookTrigger('kick', { method: 'POST', signed: true }),
        eventTrigger('doc.updated', { signed: true }),
        deploymentTrigger('staging'),
        pollingTrigger('https://example.com/feed', 60),
        queueTrigger('ingest', { signed: false }),
      ],
      notify: {
        onTerminal: 'https://example.com/notify',
        divergence: { repeatThreshold: 6, abort: true },
      },
      lifecycle: {
        stage: 'staging',
        tags: ['qa'],
        deprecated: false,
        errorOrchestration: 'triage_failures',
      },
    }).phases(agentPhase('only_step', 'agents/worker.md'));

    expect(flow.build()).toEqual({
      name: 'root_props',
      phases: [{ name: 'only_step', agent: 'agents/worker.md' }],
      vars: { env: 'staging', tone: 'terse' },
      inputs: [{ name: 'doc', kind: 'url', required: false, description: 'source doc' }],
      state: {
        findings: { reducer: 'append', initial: [] },
        totals: { reducer: 'increment', initial: 0 },
      },
      defaults: { timeout: 600, stallTimeout: 120, maxAgentTokens: 2000000 },
      autoApproveLocks: true,
      concurrency: { group: 'shared_env', policy: 'cancel-existing' },
      triggers: [
        { kind: 'cron', expr: '*/5 * * * *' },
        { kind: 'webhook', path: 'kick', method: 'POST', signed: true },
        { kind: 'events', event: 'doc.updated', signed: true },
        { kind: 'deployment', environment: 'staging' },
        { kind: 'polling', source: 'https://example.com/feed', intervalSeconds: 60 },
        { kind: 'queue', queue: 'ingest', signed: false },
      ],
      notify: {
        onTerminal: 'https://example.com/notify',
        divergence: { repeatThreshold: 6, abort: true },
      },
      lifecycle: {
        stage: 'staging',
        tags: ['qa'],
        deprecated: false,
        errorOrchestration: 'triage_failures',
      },
    });
    expect(schemaViolations(flow.build(), SCHEMA, '')).toEqual([]);
    expect(
      validateOrchestration(flow.build()).filter(f => f.severity === 'error'),
    ).toEqual([]);
  });

  it('merger emits on converge; body-kind config emits inside its body', () => {
    const c = converge(
      'both_views',
      [agentPhase('a', 'agents/a.md'), agentPhase('b', 'agents/b.md')],
      { merger: 'agents/merger.md', as: 'merged' },
    );
    expect(c.merger).toBe('agents/merger.md');
    expect(c.as).toBe('merged');

    const m = mapOver('each', '${items}', agentPhase('w', 'agents/w.md'), {
      serial: true,
      concurrency: 3,
      as: 'outs',
    });
    expect(m.map).toEqual({
      over: '${items}',
      body: { name: 'w', agent: 'agents/w.md' },
      serial: true,
      concurrency: 3,
    });
    expect(m.as).toBe('outs');
    expect((m as Record<string, unknown>).serial).toBeUndefined();
    expect((m as Record<string, unknown>).concurrency).toBeUndefined();

    const l = loop('refine', agentPhase('w', 'agents/w.md'), {
      maxIterations: 4,
      until: 'DONE',
      whileOutput: 'CONTINUE',
      carryContext: false,
      warmSession: true,
      timeout: 300,
    });
    expect(l.loop).toEqual({
      body: { name: 'w', agent: 'agents/w.md' },
      maxIterations: 4,
      until: 'DONE',
      whileOutput: 'CONTINUE',
      carryContext: false,
      warmSession: true,
    });
    expect(l.timeout).toBe(300);

    const s = switchOn(
      'gate',
      { yes: agentPhase('y', 'agents/y.md') },
      { on: '${flag}', default: agentPhase('n', 'agents/n.md') },
    );
    expect(s.switch).toEqual({
      on: '${flag}',
      cases: { yes: { name: 'y', agent: 'agents/y.md' } },
      default: { name: 'n', agent: 'agents/n.md' },
    });

    const code = codePhase('sh', { run: 'echo ok' });
    expect(code.code).toEqual({ run: 'echo ok' });
  });

  it('undefined option values are dropped, not emitted as keys', () => {
    const node = agentPhase('w', 'agents/w.md', {
      timeout: undefined,
      retry: undefined,
      as: 'out',
    });
    expect(node).toEqual({ name: 'w', agent: 'agents/w.md', as: 'out' });
    expect('timeout' in node).toBe(false);
  });
});

// ── (c) Misuse fails loudly ──────────────────────────────────────────────

describe('(c) misuse', () => {
  it('a hand-written raw child with two body kinds fails at compile()', () => {
    const twoBodies = {
      name: 'bad_child',
      agent: 'agents/a.md',
      code: { source: 'return 1;' },
    } as Node;
    const flow = orchestration('has_bad_child').phases(
      agentPhase('ok', 'agents/a.md'),
      twoBodies,
    );
    expect(() => flow.compile()).toThrow(CompileError);
    expect(() => flow.compile()).toThrow(/multiple bodies/);
    // build() still emits (compile is the gate), and the schema checker
    // agrees the raw child is invalid.
    expect(schemaViolations(flow.build(), SCHEMA, '').join('\n')).toMatch(/oneOf/);
  });

  it('passing a body kind as an option throws immediately at the factory', () => {
    expect(() =>
      agentPhase('x', 'agents/a.md', {
        code: { source: 'return 1;' },
      } as unknown as AgentOpts),
    ).toThrow(BuilderError);
    expect(() =>
      agentPhase('x', 'agents/a.md', {
        code: { source: 'return 1;' },
      } as unknown as AgentOpts),
    ).toThrow(/body kind/);
  });

  it('unknown option keys throw (nothing can leak past additionalProperties:false)', () => {
    expect(() =>
      agentPhase('x', 'agents/a.md', { bogus: 1 } as unknown as AgentOpts),
    ).toThrow(/unknown option "bogus"/);
    // root-only property on a child factory
    expect(() =>
      phases('x', [agentPhase('a', 'agents/a.md')], {
        vars: { k: 'v' },
      } as unknown as AgentOpts),
    ).toThrow(/unknown option "vars"/);
    // tools is agent-only
    expect(() =>
      codePhase('x', 'return 1;', { tools: ['Read'] } as unknown as AgentOpts),
    ).toThrow(/unknown option "tools"/);
    // merger is converge-only
    expect(() =>
      parallelNodes(
        'x',
        [agentPhase('a', 'agents/a.md'), agentPhase('b', 'agents/b.md')],
        { merger: 'agents/m.md' } as unknown as AgentOpts,
      ),
    ).toThrow(/unknown option "merger"/);
    // runtime-only __origin is not authorable
    expect(() =>
      agentPhase('x', 'agents/a.md', { __origin: 'shipped' } as unknown as AgentOpts),
    ).toThrow(/unknown option "__origin"/);
    // and root opts are validated eagerly at orchestration() itself
    expect(() =>
      orchestration('x', { bogus: true } as unknown as Record<string, never>),
    ).toThrow(/unknown option "bogus"/);
  });

  it('structural schema violations fail at compile()', () => {
    // parallel needs >= 2 branches
    const flow = orchestration('lonely_parallel').parallel(
      agentPhase('only', 'agents/a.md'),
    );
    expect(() => flow.compile()).toThrow(CompileError);
    expect(() => flow.compile()).toThrow(/at least 2/);
    // loop bounds
    expect(() =>
      orchestration('too_many')
        .loop(agentPhase('w', 'agents/w.md'), { maxIterations: 1000 })
        .compile(),
    ).toThrow(/maxIterations/);
  });

  it('an empty name throws at the factory', () => {
    expect(() => agentPhase('', 'agents/a.md')).toThrow(BuilderError);
    expect(() => orchestration('')).toThrow(BuilderError);
  });

  it('warnings do not fail compile() but are visible via validate()', () => {
    // A route without a `default` is a warning (advisory), not an error.
    const flow = orchestration('route_no_default').route({
      bug: agentPhase('fix', 'agents/fixer.md'),
    });
    expect(() => flow.compile()).not.toThrow();
    const findings = flow.validate();
    expect(findings.some(f => f.severity === 'warning' && /default/.test(f.message))).toBe(true);
    expect(findings.some(f => f.severity === 'error')).toBe(false);
  });
});

describe('waitPhase (durable timer / signal park)', () => {
  const { waitPhase } = require('../src/builder');

  test('emits exactly the wait body + decorators', () => {
    expect(waitPhase('cool-down', { seconds: 300 }, { as: 'timer' })).toEqual({
      name: 'cool-down',
      wait: { seconds: 300 },
      as: 'timer',
    });
    expect(
      waitPhase('gate', { signal: 'go', timeoutSeconds: 3600 }),
    ).toEqual({ name: 'gate', wait: { signal: 'go', timeoutSeconds: 3600 } });
  });

  test('misuse throws at the factory', () => {
    expect(() => waitPhase('w', {})).toThrow(/exactly one of/);
    expect(() => waitPhase('w', { seconds: 1, signal: 'go' })).toThrow(
      /exactly one of/,
    );
    expect(() => waitPhase('w', { seconds: 1, timeoutSeconds: 5 })).toThrow(
      /only valid with a signal/,
    );
    expect(() => waitPhase('w', { seconds: 1, nope: true })).toThrow(
      /unknown wait key/,
    );
  });

  test('validates through compile() inside a flow', () => {
    const { orchestration, codePhase } = require('../src/builder');
    const flow = orchestration('waity')
      .phases(
        codePhase('a', "return 'x'"),
        waitPhase('cool-down', { seconds: 5 }),
      )
      .compile();
    expect(flow.phases[1].wait).toEqual({ seconds: 5 });
  });
});
