/**
 * Structural tests for the hand-written OpenAPI 3.1 document
 * (src/server/openapi.ts). No OpenAPI-validator dependency — these pin the
 * invariants that matter for serving the doc: it is a self-contained JSON
 * object, every path/operation is well-formed, every $ref resolves inside
 * the document, and the load-bearing routes describe what the handlers in
 * sammy-pack-api.ts actually do.
 */

import { buildOpenApiDoc } from '../src/server/openapi';

type AnyObj = Record<string, any>;

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const doc = buildOpenApiDoc() as AnyObj;

/** Every (path, method, operation) triple in the doc. */
function allOperations(): Array<{ path: string; method: string; op: AnyObj }> {
  const out: Array<{ path: string; method: string; op: AnyObj }> = [];
  for (const [path, item] of Object.entries(doc.paths as AnyObj)) {
    for (const method of HTTP_METHODS) {
      const op = (item as AnyObj)[method];
      if (op) out.push({ path, method, op });
    }
  }
  return out;
}

/** Collect every `$ref` string anywhere in the document. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as AnyObj)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

/** Resolve a local JSON pointer (`#/a/b/c`) against the doc. */
function resolvePointer(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as AnyObj)[seg];
  }
  return cur;
}

describe('OpenAPI document — basic shape', () => {
  it('builds a plain object and round-trips through JSON', () => {
    expect(doc).toBeTruthy();
    expect(typeof doc).toBe('object');
    expect(Array.isArray(doc)).toBe(false);
    // Must be pure data — serializable with no loss (no functions/undefined
    // holes that would break serving it as JSON).
    const roundTripped = JSON.parse(JSON.stringify(doc));
    expect(roundTripped).toEqual(doc);
  });

  it('declares OpenAPI 3.1 and the expected info block', () => {
    expect(typeof doc.openapi).toBe('string');
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(doc.info.version).toBe('0.1.0');
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.info.description).toBe('string');
    // The auth model + SSE caveat live in the description.
    expect(doc.info.description).toMatch(/SAMMY_API_TOKEN/);
    expect(doc.info.description).toMatch(/X-Sammy-Signature/);
    expect(doc.info.description).toMatch(/text\/event-stream/);
  });

  it('has a non-empty paths object', () => {
    expect(doc.paths && typeof doc.paths).toBe('object');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });
});

describe('OpenAPI document — path + operation invariants', () => {
  it('every path starts with /api/ or /.well-known/', () => {
    for (const path of Object.keys(doc.paths as AnyObj)) {
      expect(path).toMatch(/^\/(api\/|\.well-known\/)/);
    }
  });

  it('every path item carries at least one HTTP operation', () => {
    for (const [path, item] of Object.entries(doc.paths as AnyObj)) {
      const methods = HTTP_METHODS.filter(m => (item as AnyObj)[m]);
      expect({ path, count: methods.length }).toEqual({
        path,
        count: methods.length,
      });
      expect(methods.length).toBeGreaterThan(0);
    }
  });

  it('every operation has a summary and at least one response', () => {
    const ops = allOperations();
    expect(ops.length).toBeGreaterThan(0);
    for (const { path, method, op } of ops) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(typeof op.summary === 'string' && op.summary.length > 0).toBe(
        true,
      );
      const responses = op.responses ?? {};
      const codes = Object.keys(responses);
      if (codes.length === 0) {
        throw new Error(`${where} has no responses`);
      }
      for (const code of codes) {
        // Status codes are 3-digit strings (no 'default' used in this doc).
        expect(code).toMatch(/^[1-5]\d\d$/);
        const resp = resolveIfRef(responses[code]);
        expect(typeof (resp as AnyObj).description).toBe('string');
      }
    }
  });

  it('all $refs resolve within the document', () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // Self-contained doc: every ref is local.
      expect(ref.startsWith('#/')).toBe(true);
      const target = resolvePointer(ref);
      if (target === undefined) {
        throw new Error(`Unresolvable $ref: ${ref}`);
      }
    }
  });

  it('security schemes cover bearer, JWT, and trigger HMAC', () => {
    const schemes = doc.components.securitySchemes;
    expect(schemes.bearerToken.type).toBe('http');
    expect(schemes.bearerToken.scheme).toBe('bearer');
    expect(schemes.bearerJwt.bearerFormat).toBe('JWT');
    expect(schemes.triggerSignature.type).toBe('apiKey');
    expect(schemes.triggerSignature.in).toBe('header');
    expect(schemes.triggerSignature.name).toBe('X-Sammy-Signature');
  });
});

function resolveIfRef(node: unknown): unknown {
  const ref = (node as AnyObj)?.$ref;
  return typeof ref === 'string' ? resolvePointer(ref) : node;
}

describe('OpenAPI document — load-bearing route spot checks', () => {
  it('POST /api/runs/start requires orchestrationName in its body', () => {
    const op = doc.paths['/api/runs/start'].post;
    expect(op).toBeTruthy();
    expect(op.requestBody.required).toBe(true);
    const schema = resolveIfRef(
      op.requestBody.content['application/json'].schema,
    ) as AnyObj;
    expect(schema.required).toContain('orchestrationName');
    // Optional knobs the handler reads.
    for (const key of ['initialInput', 'model', 'allowAgentTools', 'inputs']) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
    // The concurrency start-gate outcome (200 with id:null) is documented.
    const resp = resolveIfRef(
      resolveIfRef(op.responses['200'])!,
    ) as AnyObj;
    const respSchema = resolveIfRef(
      resp.content['application/json'].schema,
    ) as AnyObj;
    expect(respSchema.properties.concurrency.enum).toEqual([
      'skipped',
      'queued',
    ]);
    // Budget gate → 402 is part of the contract.
    expect(Object.keys(op.responses)).toContain('402');
  });

  it('POST /api/runs/{id}/gate enumerates all three decisions', () => {
    const op = doc.paths['/api/runs/{id}/gate'].post;
    const schema = resolveIfRef(
      op.requestBody.content['application/json'].schema,
    ) as AnyObj;
    expect(schema.properties.decision.enum).toEqual([
      'approve',
      'reject',
      'request-changes',
    ]);
    expect(schema.required).toEqual(['decision']);
    // The revise loop's refusal states surface as 409.
    expect(Object.keys(op.responses)).toContain('409');
  });

  it('POST /api/runs/{id}/signal exists and requires a signal name', () => {
    const op = doc.paths['/api/runs/{id}/signal']?.post;
    expect(op).toBeTruthy();
    const schema = resolveIfRef(
      op.requestBody.content['application/json'].schema,
    ) as AnyObj;
    expect(schema.required).toEqual(['signal']);
    expect(Object.keys(schema.properties)).toContain('payload');
    const okResp = resolveIfRef(op.responses['200']) as AnyObj;
    const okSchema = resolveIfRef(
      okResp.content['application/json'].schema,
    ) as AnyObj;
    // Durable-first delivery reports both axes: delivered + resumed.
    expect(okSchema.required).toEqual(
      expect.arrayContaining(['delivered', 'resumed']),
    );
  });

  it('GET /api/runs/{id}/events is documented as an SSE stream', () => {
    const op = doc.paths['/api/runs/{id}/events'].get;
    const resp = resolveIfRef(op.responses['200']) as AnyObj;
    expect(Object.keys(resp.content)).toEqual(['text/event-stream']);
    expect(op.description).toMatch(/\[DONE\]/);
  });

  it('run summary and its /status alias share the RunSummary schema', () => {
    const summary = doc.paths['/api/runs/{id}/summary'].get;
    const status = doc.paths['/api/runs/{id}/status'].get;
    const refOf = (op: AnyObj) =>
      (resolveIfRef(op.responses['200']) as AnyObj).content[
        'application/json'
      ].schema.$ref;
    expect(refOf(summary)).toBe('#/components/schemas/RunSummary');
    expect(refOf(status)).toBe('#/components/schemas/RunSummary');
    const runSummary = doc.components.schemas.RunSummary;
    for (const field of ['phasesStarted', 'phasesEnded', 'toolUses', 'costUsd']) {
      expect(Object.keys(runSummary.properties)).toContain(field);
    }
  });

  it('trigger ingress returns 202-accepted envelopes, not run ids', () => {
    const op = doc.paths['/api/triggers/{path}'].post;
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['202', '200', '401', '404', '429']),
    );
    const accepted = doc.components.schemas.TriggerAccepted;
    expect(accepted.required).toEqual(
      expect.arrayContaining(['trigger', 'name', 'duplicate', 'deliveries']),
    );
    // The A2A JSON-RPC surface lists every supported method.
    const rpc = doc.components.schemas.JsonRpcRequest;
    expect(rpc.properties.method.enum).toEqual(
      expect.arrayContaining([
        'message/send',
        'message/stream',
        'tasks/get',
        'tasks/cancel',
        'tasks/resubscribe',
      ]),
    );
  });
});

// ─── Served endpoint (real mount) ───────────────────────────────────────────

import { checkSchema, type JsonSchema } from '../src/lib/json-schema-check';
import {
  pinTestEnv,
  makeWorkspace,
  mountServer,
  writeOrchestration,
  getJson,
  postJson,
  putJson,
  waitFor,
  type Mount,
} from './lifecycle-harness.helpers';

describe('GET /api/openapi.json', () => {
  jest.setTimeout(20_000);

  test('serves the exact document, GET-only', async () => {
    const restore = pinTestEnv();
    const m = await mountServer(await makeWorkspace('openapi'));
    try {
      const res = await fetch(`${m.baseUrl}/api/openapi.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const doc = (await res.json()) as { openapi?: string; paths?: object };
      expect(doc.openapi).toMatch(/^3\.1/);
      expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(20);

      const post = await fetch(`${m.baseUrl}/api/openapi.json`, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      await m.kill();
      restore();
    }
  });
});

// ─── Conformance: live responses against their documented schemas ──────────
//
// The structural checks above pin the document's shape; these pin that the
// document tells the truth about the routes that changed under it. Each case
// fetches a real response from a real mount and validates it with the repo's
// own json-schema-check (the executor's contract checker). The checker has no
// `$ref` support by design, so documented schemas are inlined first.

/** Inline every local `$ref` (recursion guarded) so `checkSchema` can walk it. */
function deref(node: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(node)) return node.map(n => deref(n, seen));
  if (node && typeof node === 'object') {
    const ref = (node as AnyObj).$ref;
    if (typeof ref === 'string') {
      if (seen.has(ref)) return {};
      return deref(resolvePointer(ref), new Set([...seen, ref]));
    }
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(node as AnyObj)) out[k] = deref(v, seen);
    return out;
  }
  return node;
}

/** The documented JSON schema of one response, inlined. */
function documentedResponse(path: string, method: string, code: string): JsonSchema {
  const resp = resolveIfRef(doc.paths[path][method].responses[code]) as AnyObj;
  return deref(resp.content['application/json'].schema) as JsonSchema;
}

function expectConforms(value: unknown, schema: JsonSchema, where: string): void {
  const violations = checkSchema(value, schema);
  if (violations.length > 0) {
    throw new Error(
      `${where} does not match its documented schema:\n` +
        violations.map(v => `  ${v.path}: ${v.message}`).join('\n'),
    );
  }
}

describe('OpenAPI document — documented routes conform to the live server', () => {
  jest.setTimeout(30_000);
  let restore: () => void;
  let m: Mount;
  const as = (owner: string) => ({ 'x-sammy-user': owner });

  beforeAll(async () => {
    restore = pinTestEnv();
    const root = await makeWorkspace('openapi-conformance');
    await writeOrchestration(root, {
      name: 'echo',
      phases: [{ name: 'echo', code: { source: "return 'fired:' + (input || '');" } }],
    });
    await writeOrchestration(root, {
      name: 'holder',
      concurrency: { group: 'shared-resource', policy: 'queue' },
      phases: [{ name: 'hold', lock: true, code: { source: "return 'held';" } }],
    });
    m = await mountServer(root);
  });

  afterAll(async () => {
    await m.kill();
    restore();
  });

  test('GET /api/budget, PUT /api/budget and GET /api/budget/status carry the per-owner fields', async () => {
    const cfg = await getJson<AnyObj>(`${m.baseUrl}/api/budget`);
    expectConforms(cfg, documentedResponse('/api/budget', 'get', '200'), 'GET /api/budget');
    expect(Object.keys(cfg)).toEqual(
      expect.arrayContaining(['perOwnerDailyUsd', 'perOwnerMonthlyUsd']),
    );

    const put = await putJson<AnyObj>(`${m.baseUrl}/api/budget`, { dailyUsd: 12.5 });
    expect(put.status).toBe(200);
    expectConforms(put.body, documentedResponse('/api/budget', 'put', '200'), 'PUT /api/budget');
    expect(put.body.dailyUsd).toBe(12.5);
    // The per-owner caps are not this route's to change.
    expect(put.body.perOwnerDailyUsd).toBeNull();

    const status = await getJson<AnyObj>(`${m.baseUrl}/api/budget/status`);
    expectConforms(
      status,
      documentedResponse('/api/budget/status', 'get', '200'),
      'GET /api/budget/status',
    );
    for (const k of ['perOwnerDailyLimit', 'perOwnerMonthlyLimit', 'ownerDailyUsed', 'ownerMonthlyUsed']) {
      expect(Object.keys(status)).toContain(k);
    }
  });

  test('GET /api/deliveries/stats conforms (and is documented as owner-scoped)', async () => {
    const stats = await getJson<AnyObj>(`${m.baseUrl}/api/deliveries/stats`);
    expectConforms(
      stats,
      documentedResponse('/api/deliveries/stats', 'get', '200'),
      'GET /api/deliveries/stats',
    );
    expect(doc.paths['/api/deliveries/stats'].get.description).toMatch(/caller.s own/i);
  });

  test('GET /api/concurrency: `held` is reported to everyone, `holder` only to the owner', async () => {
    const start = await postJson<{ id: string | null }>(`${m.baseUrl}/api/runs/start`, {
      orchestrationName: 'holder',
    });
    expect(start.status).toBe(200);
    const id = String(start.body.id);
    await waitFor(
      async () => (await getJson<AnyObj>(`${m.baseUrl}/api/runs/${id}`)).status === 'paused',
      'holder parked at its lock',
    );
    const schema = deref(doc.components.schemas.ConcurrencyGroup) as JsonSchema;

    const mine = (await getJson<AnyObj[]>(`${m.baseUrl}/api/concurrency`)).find(
      r => r.group === 'shared-resource',
    );
    expect(mine).toBeDefined();
    expectConforms(mine, schema, 'GET /api/concurrency (owner)');
    expect(mine!.held).toBe(true);
    expect(mine!.holder?.runId).toBe(id);

    const theirs = (
      (await (await fetch(`${m.baseUrl}/api/concurrency`, { headers: as('bob') })).json()) as AnyObj[]
    ).find(r => r.group === 'shared-resource');
    expectConforms(theirs, schema, 'GET /api/concurrency (other owner)');
    expect(theirs!.held).toBe(true);
    expect(theirs!.holder).toBeNull();

    await postJson(`${m.baseUrl}/api/runs/${id}/cancel`);
  });

  test('POST /api/runs ignores a client-supplied orchestrationSnapshot, as documented', async () => {
    const upsert = doc.components.schemas.RunUpsert;
    expect(Object.keys(upsert.properties)).not.toContain('orchestrationSnapshot');

    const pushed = await postJson<AnyObj>(`${m.baseUrl}/api/runs`, {
      id: 'pushed-record',
      orchestrationName: 'echo',
      status: 'done',
      events: [{ type: 'run-start', orchestrationName: 'echo', ts: 1 }],
      orchestrationSnapshot: { name: 'not-the-servers' },
    });
    expect(pushed.status).toBe(200);
    expect(Object.keys(pushed.body)).not.toContain('orchestrationSnapshot');
    expectConforms(pushed.body, documentedResponse('/api/runs', 'post', '200'), 'POST /api/runs');

    // The server owns that field: what is stored is ITS copy of the named
    // orchestration (so Replay / Rerun keep working for a mirrored run),
    // never the tree the client sent — a client cannot plant something for
    // /resume to execute.
    const stored = await getJson<AnyObj>(`${m.baseUrl}/api/runs/pushed-record`);
    expectConforms(stored, documentedResponse('/api/runs/{id}', 'get', '200'), 'GET /api/runs/{id}');
    const snap = (stored.orchestrationSnapshot ?? null) as AnyObj | null;
    expect(snap).not.toBeNull();
    expect(snap?.name).toBe('echo');
    expect(JSON.stringify(snap)).not.toContain('not-the-servers');
  });

  test('GET /api/runs/{id}/events documents ?token= / ?owner=, and ?owner= is the identity', async () => {
    const params = doc.paths['/api/runs/{id}/events'].get.parameters as AnyObj[];
    expect(params.filter(p => p.in === 'query').map(p => p.name).sort()).toEqual(['owner', 'token']);

    const start = await postJson<{ id: string | null }>(
      `${m.baseUrl}/api/runs/start`,
      { orchestrationName: 'echo', initialInput: 'x' },
      as('alice'),
    );
    expect(start.status).toBe(200);
    const id = String(start.body.id);
    await waitFor(async () => {
      const r = await fetch(`${m.baseUrl}/api/runs/${id}`, { headers: as('alice') });
      return r.ok && ((await r.json()) as AnyObj).status === 'done';
    }, 'alice’s echo run done');

    const owner = await fetch(`${m.baseUrl}/api/runs/${id}/events?owner=alice`);
    expect(owner.status).toBe(200);
    expect(owner.headers.get('content-type')).toContain('text/event-stream');
    expect(await owner.text()).toContain('"type":"run-end"');
    // The query identity is scoped exactly like the header would be.
    expect((await fetch(`${m.baseUrl}/api/runs/${id}/events?owner=bob`)).status).toBe(404);
  });

  test('the info block names the env-driven refusals an operator can switch on', () => {
    for (const knob of [
      'SAMMY_REQUIRE_AUTH_READS',
      'SAMMY_READONLY_USERS',
      'SAMMY_JWT_ROLE_CLAIM',
      'SAMMY_REQUIRE_SIGNED_TRIGGERS',
      'SAMMY_METRICS_PUBLIC',
      'SAMMY_NOTIFY_ALLOWED_HOSTS',
      'SAMMY_LLM_STREAM_PERMISSION_MODE',
      'SAMMY_LLM_STREAM_TOOLS',
    ]) {
      expect(doc.info.description).toContain(knob);
    }
    // The stale claim this replaced: reads were described as never gated.
    expect(doc.info.description).not.toMatch(/GET routes are never gated/);
    expect(doc.components.securitySchemes.bearerToken.description).not.toMatch(/never gated/);
    expect(doc.paths['/api/a2a/{name}'].post.description).toMatch(/SAMMY_NOTIFY_ALLOWED_HOSTS/);
  });
});
