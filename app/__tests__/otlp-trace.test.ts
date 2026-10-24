import { buildOtlpTrace } from '../src/server/otlp-trace';

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
};

function spansOf(trace: { resourceSpans: unknown[] }): Span[] {
  const rs = trace.resourceSpans[0] as {
    scopeSpans: Array<{ spans: Span[] }>;
  };
  return rs.scopeSpans[0].spans;
}

const baseRun = {
  id: 'run-abc',
  orchestrationName: 'ticket-to-pr',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  status: 'done',
  events: [
    { type: 'run-start', ts: 1_700_000_000_000 },
    { type: 'phase-start', phaseName: 'spec', agentPath: 'agents/pm.md', ts: 1_700_000_000_500 },
    {
      type: 'phase-end',
      phaseName: 'spec',
      ts: 1_700_000_011_000,
      inputTokens: 120,
      outputTokens: 340,
      costUsd: 0.0042,
      model: 'claude-sonnet-4-6',
    },
    { type: 'phase-start', phaseName: 'plan', agentPath: 'agents/dev-lead.md', ts: 1_700_000_011_500 },
    {
      type: 'phase-end',
      phaseName: 'plan',
      ts: 1_700_000_059_000,
      inputTokens: 200,
      outputTokens: 600,
      costUsd: 0.01,
      model: 'claude-sonnet-4-6',
    },
    { type: 'run-end', status: 'done', ts: 1_700_000_060_000 },
  ],
};

describe('buildOtlpTrace', () => {
  it('produces a root span + one span per phase', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    // root + spec + plan
    expect(spans).toHaveLength(3);
    const root = spans[0];
    expect(root.name).toBe('run ticket-to-pr');
    expect(root.parentSpanId).toBeUndefined();
    const phaseSpans = spans.slice(1);
    expect(phaseSpans.map(s => s.name).sort()).toEqual([
      'phase plan',
      'phase spec',
    ]);
    // phase spans parent to the root
    for (const s of phaseSpans) {
      expect(s.parentSpanId).toBe(root.spanId);
      expect(s.traceId).toBe(root.traceId);
    }
  });

  it('uses 32-hex traceId + 16-hex spanIds', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const s of spans) {
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('converts ms timestamps to unix-nanosecond strings', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    expect(spans[0].startTimeUnixNano).toBe('1700000000000000000');
    expect(spans[0].endTimeUnixNano).toBe('1700000060000000000');
  });

  it('carries token / cost / model as phase-span attributes', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    const spec = spans.find(s => s.name === 'phase spec')!;
    const byKey = Object.fromEntries(
      spec.attributes.map(a => [a.key, a.value]),
    );
    expect(byKey['sammy.phase.agent']).toEqual({ stringValue: 'agents/pm.md' });
    expect(byKey['sammy.phase.input_tokens']).toEqual({ intValue: '120' });
    expect(byKey['sammy.phase.cost_usd']).toEqual({ doubleValue: 0.0042 });
    expect(byKey['sammy.phase.model']).toEqual({
      stringValue: 'claude-sonnet-4-6',
    });
  });

  it('is deterministic — same run exports an identical trace', () => {
    expect(JSON.stringify(buildOtlpTrace(baseRun))).toBe(
      JSON.stringify(buildOtlpTrace(baseRun)),
    );
  });

  it('marks an errored phase span with ERROR status + message', () => {
    const errRun = {
      ...baseRun,
      status: 'error',
      endedAt: 1_700_000_005_000,
      events: [
        { type: 'run-start', ts: 1_700_000_000_000 },
        { type: 'phase-start', phaseName: 'spec', agentPath: 'agents/pm.md', ts: 1_700_000_000_500 },
        { type: 'phase-error', phaseName: 'spec', error: 'boom', ts: 1_700_000_004_000 },
        { type: 'run-error', error: 'boom', ts: 1_700_000_005_000 },
      ],
    };
    const spans = spansOf(buildOtlpTrace(errRun));
    const root = spans[0];
    expect(root.status.code).toBe(2); // ERROR
    const phase = spans.find(s => s.name === 'phase spec')!;
    expect(phase.status.code).toBe(2);
    expect(phase.status.message).toBe('boom');
  });

  it('gives loop / map repeats of the same phase distinct span ids', () => {
    const loopRun = {
      ...baseRun,
      events: [
        { type: 'run-start', ts: 1 },
        { type: 'phase-start', phaseName: 'iterate', agentPath: 'agents/dev.md', ts: 2 },
        { type: 'phase-end', phaseName: 'iterate', ts: 3 },
        { type: 'phase-start', phaseName: 'iterate', agentPath: 'agents/dev.md', ts: 4 },
        { type: 'phase-end', phaseName: 'iterate', ts: 5 },
        { type: 'run-end', status: 'done', ts: 6 },
      ],
    };
    const spans = spansOf(buildOtlpTrace(loopRun));
    const iter = spans.filter(s => s.name === 'phase iterate');
    expect(iter).toHaveLength(2);
    expect(iter[0].spanId).not.toBe(iter[1].spanId);
  });
});

describe('gen_ai semantic conventions', () => {
  const attrMap = (span: Span): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const a of span.attributes) out[a.key] = Object.values(a.value)[0];
    return out;
  };

  test('root span is an invoke_agent operation named for the orchestration', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    const root = spans[0];
    const attrs = attrMap(root);
    expect(attrs['gen_ai.operation.name']).toBe('invoke_agent');
    expect(attrs['gen_ai.agent.name']).toBe('ticket-to-pr');
    expect(attrs['gen_ai.agent.id']).toBe('run-abc');
  });

  test('LLM phase spans carry gen_ai model / usage / agent / provider attributes', () => {
    const spans = spansOf(buildOtlpTrace(baseRun));
    const spec = spans.find(s => s.name === 'phase spec')!;
    const attrs = attrMap(spec);
    expect(attrs['gen_ai.operation.name']).toBe('invoke_agent');
    expect(attrs['gen_ai.request.model']).toBe('claude-sonnet-4-6');
    expect(attrs['gen_ai.usage.input_tokens']).toBe('120'); // OTLP intValue is a string
    expect(attrs['gen_ai.usage.output_tokens']).toBe('340');
    expect(attrs['gen_ai.agent.name']).toBe('pm');
    expect(attrs['gen_ai.provider.name']).toBe('anthropic');
    // The stable sammy.* twins are still there for existing consumers.
    expect(attrs['sammy.phase.model']).toBe('claude-sonnet-4-6');
  });

  test('non-LLM leaves (code / wait) get NO gen_ai attributes', () => {
    const run = {
      ...baseRun,
      events: [
        { type: 'phase-start', phaseName: 'reshape', agentPath: 'code', ts: 1_700_000_000_500 },
        { type: 'phase-end', phaseName: 'reshape', ts: 1_700_000_001_000, inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'code' },
        { type: 'phase-start', phaseName: 'cool-down', agentPath: 'wait', ts: 1_700_000_001_100 },
        { type: 'phase-end', phaseName: 'cool-down', ts: 1_700_000_002_000, inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'wait' },
      ],
    };
    const spans = spansOf(buildOtlpTrace(run));
    for (const name of ['phase reshape', 'phase cool-down']) {
      const attrs = attrMap(spans.find(s => s.name === name)!);
      expect(Object.keys(attrs).some(k => k.startsWith('gen_ai.'))).toBe(false);
    }
  });
});

describe('otlp push config', () => {
  const { otlpTracesUrl, otlpHeaders } = require('../src/server/otlp-trace');

  test('endpoint resolution appends /v1/traces to a base URL, accepts a full path, off when unset', () => {
    expect(otlpTracesUrl({})).toBeNull();
    expect(otlpTracesUrl({ SAMMY_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      'http://collector:4318/v1/traces',
    );
    expect(
      otlpTracesUrl({ SAMMY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' }),
    ).toBe('http://collector:4318/v1/traces');
  });

  test('headers parse from JSON; malformed JSON degrades to {}', () => {
    expect(otlpHeaders({ SAMMY_OTLP_HEADERS: '{"x-team":"abc"}' })).toEqual({
      'x-team': 'abc',
    });
    expect(otlpHeaders({ SAMMY_OTLP_HEADERS: 'not-json' })).toEqual({});
    expect(otlpHeaders({})).toEqual({});
  });
});
