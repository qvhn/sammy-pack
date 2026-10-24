/**
 * Export a sammy-pack run as an OpenTelemetry trace (OTLP/JSON).
 *
 * Exporting to an existing observability stack is what makes runs
 * legible to a team that already has one. A run is already a tree of
 * timed phases — a near-perfect fit for a trace:
 *
 *   - the run itself becomes the root span
 *   - each leaf phase becomes a child span (phase-start → phase-end)
 *   - token / cost / model land as span attributes
 *   - a phase-error sets the span status to ERROR
 *
 * The output is OTLP/JSON — the shape an OTLP/HTTP collector accepts at
 * `POST /v1/traces`. The caller can pipe it straight to Jaeger, Tempo,
 * Honeycomb, or any OTLP-compatible backend.
 *
 * Span + trace IDs are derived deterministically (sha1 of run id +
 * phase name) so re-exporting the same run yields a stable trace.
 *
 * GEN_AI SEMANTIC CONVENTIONS: alongside the stable `sammy.*` attributes
 * (kept for existing consumers), spans carry the OpenTelemetry GenAI
 * `gen_ai.*` attributes — the interop namespace LangSmith / Langfuse /
 * Braintrust / Arize-class platforms ingest. Mapping: the run root and
 * each LLM leaf are `gen_ai.operation.name = "invoke_agent"` with
 * `gen_ai.agent.name` (orchestration name / agent file basename),
 * `gen_ai.request.model` + `gen_ai.response.model`, and
 * `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`.
 * `gen_ai.provider.name` is derived best-effort from the model id.
 * Non-LLM leaves (`code`, `wait`) stay plain internal spans — they are
 * orchestration steps, not GenAI calls. The gen_ai.* namespace is still
 * marked Development upstream, so attribute names may move with the spec;
 * the sammy.* twins are the stability guarantee.
 *
 * LIVE PUSH: `SAMMY_OTLP_ENDPOINT` (an OTLP/HTTP collector base URL or a
 * full …/v1/traces URL; optional `SAMMY_OTLP_HEADERS` as JSON) makes the
 * server POST each run's trace at terminal — fire-and-forget, never blocks
 * or fails the run. Same document as GET /api/runs/:id/trace.
 */

import crypto from 'node:crypto';

type RunEvent = Record<string, unknown> & { type: string; ts?: number };

type RunForTrace = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  events: RunEvent[];
};

/** sha1(seed) → hex, trimmed to `bytes` bytes (2 hex chars each). */
function idFrom(seed: string, bytes: number): string {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, bytes * 2);
}

/** ms → unix-nanoseconds string (OTLP wants nanos, as a string so
 *  precision survives JSON). */
function nanos(ms: number): string {
  return String(Math.round(ms) * 1_000_000);
}

type OtlpAttr = {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
};

function attr(key: string, v: string | number | boolean): OtlpAttr {
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { key, value: { intValue: String(v) } }
      : { key, value: { doubleValue: v } };
  }
  return { key, value: { stringValue: v } };
}

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  status: { code: number; message?: string };
};

// OTLP status codes: 0 UNSET, 1 OK, 2 ERROR.
const STATUS_OK = 1;
const STATUS_ERROR = 2;
// OTLP span kind: 1 = INTERNAL.
const KIND_INTERNAL = 1;

/** Best-effort `gen_ai.provider.name` from a model id. Unknown → null
 *  (attribute omitted rather than guessed). */
function providerFromModel(model: string): string | null {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'gcp.gemini';
  if (m.includes('bedrock')) return 'aws.bedrock';
  return null;
}

/** Phase-end models that are NOT LLM calls (orchestration-step leaves). */
const NON_LLM_MODELS = new Set(['code', 'wait', 'http']);

/** Build the OTLP/JSON trace document for a run. */
export function buildOtlpTrace(run: RunForTrace): {
  resourceSpans: unknown[];
} {
  const traceId = idFrom(`trace:${run.id}`, 16);
  const rootSpanId = idFrom(`span:${run.id}:__root__`, 8);
  const runEnd = run.endedAt ?? lastEventTs(run.events) ?? run.startedAt;

  const spans: OtlpSpan[] = [];

  // Root span — the whole run.
  spans.push({
    traceId,
    spanId: rootSpanId,
    name: `run ${run.orchestrationName}`,
    kind: KIND_INTERNAL,
    startTimeUnixNano: nanos(run.startedAt),
    endTimeUnixNano: nanos(runEnd),
    attributes: [
      attr('sammy.run.id', run.id),
      attr('sammy.run.orchestration', run.orchestrationName),
      attr('sammy.run.status', run.status),
      // GenAI conventions: the run is an agent invocation (the
      // orchestration IS the agent from the caller's point of view).
      attr('gen_ai.operation.name', 'invoke_agent'),
      attr('gen_ai.agent.name', run.orchestrationName),
      attr('gen_ai.agent.id', run.id),
    ],
    status: {
      code: run.status === 'error' ? STATUS_ERROR : STATUS_OK,
    },
  });

  // One child span per phase. We pair phase-start with the matching
  // phase-end / phase-error / phase-skipped. Multiple runs of the same
  // phase name (loop iterations, map items) each get their own span,
  // disambiguated by occurrence index.
  const openByName = new Map<string, { start: number; agentPath?: string; occ: number }>();
  const occCount = new Map<string, number>();

  for (const ev of run.events) {
    const ts = typeof ev.ts === 'number' ? ev.ts : run.startedAt;
    if (ev.type === 'phase-start') {
      const name = String(ev.phaseName ?? 'phase');
      const occ = (occCount.get(name) ?? 0) + 1;
      occCount.set(name, occ);
      openByName.set(name, {
        start: ts,
        agentPath:
          typeof ev.agentPath === 'string' ? ev.agentPath : undefined,
        occ,
      });
    } else if (
      ev.type === 'phase-end' ||
      ev.type === 'phase-error' ||
      ev.type === 'phase-skipped'
    ) {
      const name = String(ev.phaseName ?? 'phase');
      const open = openByName.get(name);
      if (!open) continue;
      openByName.delete(name);
      const attrs: OtlpAttr[] = [attr('sammy.phase.name', name)];
      if (open.agentPath) attrs.push(attr('sammy.phase.agent', open.agentPath));
      if (ev.type === 'phase-end') {
        if (typeof ev.inputTokens === 'number')
          attrs.push(attr('sammy.phase.input_tokens', ev.inputTokens));
        if (typeof ev.outputTokens === 'number')
          attrs.push(attr('sammy.phase.output_tokens', ev.outputTokens));
        if (typeof ev.costUsd === 'number')
          attrs.push(attr('sammy.phase.cost_usd', ev.costUsd));
        if (typeof ev.model === 'string')
          attrs.push(attr('sammy.phase.model', ev.model));
        // GenAI conventions — only on real LLM leaves (`code` / `wait`
        // are orchestration steps, not model calls).
        if (typeof ev.model === 'string' && !NON_LLM_MODELS.has(ev.model)) {
          attrs.push(attr('gen_ai.operation.name', 'invoke_agent'));
          attrs.push(attr('gen_ai.request.model', ev.model));
          attrs.push(attr('gen_ai.response.model', ev.model));
          if (open.agentPath) {
            const agentName =
              open.agentPath.split('/').pop()?.replace(/\.md$/, '') ??
              open.agentPath;
            attrs.push(attr('gen_ai.agent.name', agentName));
          }
          if (typeof ev.inputTokens === 'number')
            attrs.push(attr('gen_ai.usage.input_tokens', ev.inputTokens));
          if (typeof ev.outputTokens === 'number')
            attrs.push(attr('gen_ai.usage.output_tokens', ev.outputTokens));
          const provider = providerFromModel(ev.model);
          if (provider) attrs.push(attr('gen_ai.provider.name', provider));
        }
      }
      const errored = ev.type === 'phase-error';
      spans.push({
        traceId,
        spanId: idFrom(`span:${run.id}:${name}:${open.occ}`, 8),
        parentSpanId: rootSpanId,
        name:
          ev.type === 'phase-skipped'
            ? `phase ${name} (skipped)`
            : `phase ${name}`,
        kind: KIND_INTERNAL,
        startTimeUnixNano: nanos(open.start),
        endTimeUnixNano: nanos(ts),
        attributes: attrs,
        status: errored
          ? {
              code: STATUS_ERROR,
              message:
                typeof ev.error === 'string' ? ev.error : 'phase error',
            }
          : { code: STATUS_OK },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', 'sammy-pack'),
            attr('service.namespace', 'orchestration'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'sammy-pack/executor', version: '1' },
            spans,
          },
        ],
      },
    ],
  };
}

function lastEventTs(events: RunEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ts = events[i].ts;
    if (typeof ts === 'number') return ts;
  }
  return null;
}

// ─── Live push (opt-in via SAMMY_OTLP_ENDPOINT) ────────────────────────────

/** Resolve the collector traces URL from SAMMY_OTLP_ENDPOINT: accepts a
 *  base URL (…:4318 → append /v1/traces, the OTLP/HTTP convention) or a
 *  full path. Null when the feature is off. */
export function otlpTracesUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.SAMMY_OTLP_ENDPOINT?.trim();
  if (!raw) return null;
  return raw.endsWith('/v1/traces')
    ? raw
    : raw.replace(/\/+$/, '') + '/v1/traces';
}

/** Extra collector headers from SAMMY_OTLP_HEADERS (a JSON object, e.g.
 *  `{"x-honeycomb-team":"…"}`). Malformed JSON → {} with one warn. */
export function otlpHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const raw = env.SAMMY_OTLP_HEADERS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    console.warn(
      '[otlp-trace] SAMMY_OTLP_HEADERS is not valid JSON — ignoring it',
    );
    return {};
  }
}

/** Fire-and-forget: POST the run's trace to the configured collector at
 *  terminal. Never throws, never blocks the caller (returns after the
 *  fetch is DISPATCHED); a dead collector costs one swallowed rejection.
 *  No-op when SAMMY_OTLP_ENDPOINT is unset. */
export function pushOtlpTrace(run: RunForTrace): void {
  const url = otlpTracesUrl();
  if (!url) return;
  try {
    const doc = buildOtlpTrace(run);
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...otlpHeaders() },
      body: JSON.stringify(doc),
    }).catch(err => {
      console.warn(
        `[otlp-trace] push for run ${run.id} to ${url} failed (ignored):`,
        (err as Error)?.message ?? err,
      );
    });
  } catch (err) {
    console.warn(
      `[otlp-trace] building/pushing trace for run ${run.id} failed (ignored):`,
      err,
    );
  }
}
