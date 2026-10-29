/**
 * OpenAPI 3.1 document for the sammy-pack HTTP API.
 *
 * The entire API is mounted by `mountSammyApi` (app/sammy-pack-api.ts) onto a
 * connect-style middleware stack — identically under the Vite dev plugin and
 * the standalone server (app/serve.ts). This module is a hand-written,
 * dependency-free description of that surface, derived from the route
 * handlers themselves. It exports a builder (not a constant) so a serving
 * route can stamp per-request details later without module-level mutation.
 *
 * Scope: the public/operational surface — runs lifecycle, preview, trigger
 * ingress, ops/observability, registry reads, and A2A. Internal editor
 * conveniences (datasets, evals, guide, llm/stream, credentials, workspaces,
 * mcp-servers, hooks, agent import/scan) are intentionally not documented
 * here.
 */

import { WEBHOOK_PROVIDERS } from './provider-signatures';

// ─── tiny local builders (no deps — just object literals) ───────────────────

type JsonObj = Record<string, unknown>;

const ref = (name: string): JsonObj => ({
  $ref: `#/components/schemas/${name}`,
});

const jsonContent = (schema: JsonObj): JsonObj => ({
  'application/json': { schema },
});

const jsonResponse = (description: string, schema: JsonObj): JsonObj => ({
  description,
  content: jsonContent(schema),
});

const errorResponse = (description: string): JsonObj =>
  jsonResponse(description, ref('Error'));

const jsonBody = (schema: JsonObj, required = true): JsonObj => ({
  required,
  content: jsonContent(schema),
});

/** Path parameter `{id}` — a run id (safe-name: letters, digits, `.` `_` `-`). */
const runIdParam: JsonObj = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Run id (a safe name: letters, digits, dot, underscore, dash).',
  schema: { type: 'string' },
};

/**
 * Security for state-changing admin routes: anonymous by default (local
 * single-user dev), optional bearer when SAMMY_API_TOKEN is set, optional
 * signed JWT when a SAMMY_JWKS_URI / SAMMY_JWT_PUBLIC_KEY / SAMMY_JWT_SECRET
 * verifier is configured. The empty object means "no auth also accepted".
 */
const mutatingSecurity: JsonObj[] = [
  {},
  { bearerToken: [] },
  { bearerJwt: [] },
];

/** Security for external trigger ingress: anonymous unless the trigger is
 *  declared `signed`, in which case an HMAC `X-Sammy-Signature` is required.
 *  Trigger ingress is exempt from the admin bearer/JWT gates. */
const ingressSecurity: JsonObj[] = [{}, { triggerSignature: [] }];

// ─── the document ────────────────────────────────────────────────────────────

export function buildOpenApiDoc(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'sammy-pack API',
      version: '0.1.0',
      description: [
        'HTTP API of the sammy-pack agent-orchestration framework — a',
        'self-hosted, single-tenant server. The same surface is mounted by',
        'the Vite dev plugin and by the standalone server (`serve.ts`).',
        '',
        '## Authentication',
        'By default (local single-user dev) the API is unauthenticated.',
        'Three optional layers can be enabled via environment variables:',
        '',
        '- **Bearer token** (`SAMMY_API_TOKEN`): when set, every',
        '  state-changing `/api/*` request (POST/PUT/DELETE/PATCH) must send',
        '  `Authorization: Bearer <token>`. GET/HEAD/OPTIONS stay open unless',
        '  `SAMMY_REQUIRE_AUTH_READS=1`, which gates reads the same way; only',
        '  the `/api/livez`, `/api/readyz` and `/api/health` probes are exempt',
        '  then, and they drop any `X-Sammy-User` they are sent.',
        '  Trigger ingress (`/api/triggers`, `/api/events`, `/api/deploy`,',
        '  `/api/queue`) is exempt — it authenticates per-trigger via HMAC.',
        '- **Verified JWT identity** (`SAMMY_JWKS_URI` |',
        '  `SAMMY_JWT_PUBLIC_KEY` | `SAMMY_JWT_SECRET`, with optional',
        '  `SAMMY_JWT_AUDIENCE`/`SAMMY_JWT_ISSUER` claim checks): when a',
        '  verifier is configured, state-changing requests require a valid',
        '  Bearer JWT; the owner claim (default `sub`, override',
        '  `SAMMY_JWT_OWNER_CLAIM`) becomes the verified `X-Sammy-User`',
        '  identity. Reads accept-if-present (anonymous GET still works)',
        '  unless `SAMMY_REQUIRE_AUTH_READS=1`, which denies an unverified',
        '  read like a mutation. Trigger ingress is exempt here too.',
        '- **HMAC-signed trigger ingress** (`SAMMY_WEBHOOK_SECRET`): a',
        '  trigger declared `signed` requires an `X-Sammy-Signature` header.',
        '  Preferred v2 format: `t=<unix-seconds>,n=<nonce>,v1=<hex>` where',
        '  hex = HMAC-SHA256(`t.nonce.rawBody`, secret) — replay-protected',
        '  by a ±300s timestamp window and nonce reuse rejection. Legacy',
        '  `sha256=<hex>` (HMAC-SHA256 of the raw body) is still accepted.',
        '',
        '## SSE',
        '`GET /api/runs/{id}/events` (and A2A `message/stream` /',
        '`tasks/resubscribe`) respond as `text/event-stream`. An EventSource',
        'cannot send headers, so the run stream — and only it — also accepts',
        'its credentials in the query string: `?token=` is lifted into',
        '`Authorization: Bearer` and `?owner=` into `X-Sammy-User` before any',
        'gate runs, so a query token is verified by the same code as a header',
        'token, and a header, when present, wins. The stream is gated exactly',
        'like every other read. Events are emitted as `data: <json>` lines; a',
        'finished run closes the stream after a terminal `data: [DONE]`',
        'sentinel.',
        '',
        '## Roles and operator policy',
        'Environment-driven behaviours that change a response:',
        '- `SAMMY_READONLY_USERS` (comma-separated identities), or a verified',
        '  JWT role claim named by `SAMMY_JWT_ROLE_CLAIM`, gives an identity',
        '  the `read` role: every state-changing method, and every trigger',
        '  FIRE that carries that identity, is refused with 403.',
        '- `SAMMY_REQUIRE_SIGNED_TRIGGERS=1`: firing a trigger not declared',
        '  `signed` is refused with 403.',
        '- `SAMMY_METRICS_PUBLIC=1`: `/metrics` and `/api/metrics` answer',
        '  without a token even while reads are gated.',
        '- `SAMMY_NOTIFY_ALLOWED_HOSTS` (comma/space-separated hostnames;',
        '  empty = refuse all): A2A `tasks/pushNotificationConfig/set` answers',
        '  a JSON-RPC `invalidParams` (-32602) error for a webhook URL whose',
        '  host is not listed, or when the list is empty.',
        '- `SAMMY_LLM_STREAM_PERMISSION_MODE` (default `default`) is the',
        '  ceiling a `POST /api/llm/stream` caller may request: a wider',
        '  `permissionMode`, top-level or on a subagent, is refused with 403.',
        '  `SAMMY_LLM_STREAM_TOOLS=off` refuses tool-bearing stream calls with',
        '  403; `SAMMY_LLM_STREAM_TOOL_ALLOWLIST` intersects requested tools',
        '  with the list. (The route is an editor convenience and is not',
        '  described below.)',
        '- Budget: `POST /api/runs/start` (402) and the run-starting A2A',
        '  methods (JSON-RPC internal error) are refused while',
        '  `GET /api/budget/status` reports `blocked` — against the global',
        '  caps and the caller’s own per-owner caps.',
      ].join('\n'),
    },
    servers: [
      {
        url: '/',
        description:
          'The mounting server (Vite dev server or standalone serve.ts).',
      },
    ],
    tags: [
      { name: 'runs', description: 'Run lifecycle: start, inspect, control.' },
      { name: 'preview', description: 'Symbolic dry-run of an orchestration.' },
      {
        name: 'triggers',
        description:
          'External trigger ingress (webhook / events / deployment / queue) ' +
          'and the durable-delivery audit trail.',
      },
      { name: 'ops', description: 'Health, observability, cost, concurrency.' },
      {
        name: 'registry',
        description: 'Workspace registries: orchestrations, agents, schemas, versions.',
      },
      { name: 'a2a', description: 'Agent-to-Agent protocol (agent cards + JSON-RPC).' },
    ],
    paths: {
      // ── Runs ──────────────────────────────────────────────────────────
      '/api/runs': {
        get: {
          tags: ['runs'],
          summary: 'List runs (lightweight headers — never the event arrays)',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description:
                'Cap the number of rows (newest first). Ignored when absent ' +
                'or malformed; the store then applies its own default cap.',
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: {
            '200': jsonResponse('Run list rows, newest first.', {
              type: 'array',
              items: ref('RunListItem'),
            }),
            '500': errorResponse('Store failure.'),
          },
        },
        post: {
          tags: ['runs'],
          summary: 'Upsert a client-owned run record (legacy client-push seam)',
          description:
            'The SERVER owns `orchestrationSnapshot`: a client-supplied one ' +
            'is dropped (stored as null) and absent from the echo, because ' +
            'resume pins to the snapshot and a pushed `paused` record with a ' +
            'snapshot would be an execution bundle `/resume` runs with this ' +
            'server’s credentials. A mirrored run resumes against the ' +
            'workspace file by name. The record is owned by the caller’s ' +
            'identity (`X-Sammy-User`, else `system`).',
          security: mutatingSecurity,
          requestBody: jsonBody(ref('RunUpsert')),
          responses: {
            '200': jsonResponse(
              'The body as persisted (echoed back, minus any ' +
                '`orchestrationSnapshot` that was sent).',
              { type: 'object', additionalProperties: true },
            ),
            '400': errorResponse('Missing/unsafe `id` or invalid `status`.'),
            '500': errorResponse('Store failure.'),
          },
        },
      },
      '/api/runs/start': {
        post: {
          tags: ['runs'],
          summary: 'Start a server-owned run of an orchestration',
          description:
            'The executor lives on the server; the run survives the client ' +
            'disconnecting. Subscribe to progress via ' +
            '`GET /api/runs/{id}/events`. Declared orchestration `inputs` ' +
            'are resolved before start (missing required input → 400). When ' +
            'the orchestration declares a `concurrency.group` held by an ' +
            'active run, the response is 200 with `id: null` and a ' +
            '`concurrency` outcome instead of a new run id.',
          security: mutatingSecurity,
          requestBody: jsonBody(ref('RunStartRequest')),
          responses: {
            '200': jsonResponse(
              'Run started (`{id}`), or skipped/queued by the concurrency ' +
                'start-gate (`{id: null, concurrency}`).',
              ref('RunStartResponse'),
            ),
            '400': errorResponse(
              'Invalid JSON, unsafe orchestrationName, or input resolution failure.',
            ),
            '402': errorResponse('Budget cap reached (daily/monthly spend gate).'),
            '404': errorResponse('Orchestration not found.'),
          },
        },
      },
      '/api/runs/{id}': {
        get: {
          tags: ['runs'],
          summary: 'Run detail — full event stream plus derived health verdicts',
          parameters: [
            runIdParam,
            {
              name: 'since',
              in: 'query',
              required: false,
              description:
                'Incremental poll cursor: return only events at index >= n. ' +
                '`eventVersion` remains the FULL count so the caller can ' +
                'advance its cursor. Derived fields (costUsd, divergence, ' +
                'notes, degraded) are always computed over the whole stream.',
              schema: { type: 'integer', minimum: 0 },
            },
          ],
          responses: {
            '200': jsonResponse('The run.', ref('RunDetail')),
            '400': errorResponse('Invalid id.'),
            '404': errorResponse('Run not found.'),
          },
        },
        delete: {
          tags: ['runs'],
          summary: 'Delete a stored run',
          security: mutatingSecurity,
          parameters: [runIdParam],
          responses: {
            '204': { description: 'Deleted (idempotent).' },
            '400': errorResponse('Invalid id.'),
          },
        },
      },
      '/api/runs/{id}/summary': {
        get: {
          tags: ['runs'],
          summary: 'Lightweight status snapshot (no events array)',
          description:
            'Header + event-derived counts + current phase + live cost. ' +
            'What a monitor/poller wants — cheap to fetch and serialize. ' +
            'Alias: `GET /api/runs/{id}/status`.',
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('The summary.', ref('RunSummary')),
            '404': errorResponse('Run not found.'),
          },
        },
      },
      '/api/runs/{id}/status': {
        get: {
          tags: ['runs'],
          summary: 'Alias of GET /api/runs/{id}/summary',
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('The summary.', ref('RunSummary')),
            '404': errorResponse('Run not found.'),
          },
        },
      },
      '/api/runs/{id}/events': {
        get: {
          tags: ['runs'],
          summary: 'Live run event stream (Server-Sent Events)',
          description:
            'Responds as `text/event-stream`. Each event is a `data: <json>` ' +
            'line (a RunEvent object). Already-stored events replay first, ' +
            'then live events as they happen. A finished run emits a final ' +
            '`data: [DONE]` sentinel and closes. Client disconnect only ' +
            'unsubscribes — the run keeps executing server-side. An ' +
            'EventSource cannot set headers, so this route alone accepts ' +
            'its credentials as `?token=` / `?owner=` (see the SSE section); ' +
            'the run must be visible to that identity or the response is 404.',
          parameters: [
            runIdParam,
            {
              name: 'token',
              in: 'query',
              required: false,
              description:
                'Bearer token or JWT, lifted into `Authorization: Bearer` ' +
                'before any gate runs and verified by the same code as the ' +
                'header. Ignored when an Authorization header is present.',
              schema: { type: 'string' },
            },
            {
              name: 'owner',
              in: 'query',
              required: false,
              description:
                'Identity, lifted into `X-Sammy-User`. Trusted exactly as ' +
                'far as the header would be in the active posture (a JWT ' +
                'verifier replaces it with the verified claim). Ignored when ' +
                'the header is present.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'SSE stream of run events.',
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description:
                      'Lines of `data: <RunEvent json>`, terminated by `data: [DONE]`.',
                  },
                },
              },
            },
          },
        },
      },
      '/api/runs/{id}/cancel': {
        post: {
          tags: ['runs'],
          summary: 'Cancel a run',
          description:
            'A live in-process executor is aborted (`{ok, aborted}`); a run ' +
            'with no live controller (interrupted/paused or orphaned) is ' +
            'marked cancelled directly via the serialized cancel seam, ' +
            'releasing/draining its concurrency group (`{ok, cancelled}`). ' +
            'A run already terminal responds `{ok: false, status}`.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('Cancel outcome.', ref('CancelResponse')),
            '404': errorResponse('Run not found.'),
          },
        },
      },
      '/api/runs/{id}/stop': {
        post: {
          tags: ['runs'],
          summary: 'Stop a run (alias of cancel)',
          description:
            'Exact alias of `POST /api/runs/{id}/cancel` — the first verb ' +
            'an operator reaches for against a wedged run should work.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('Cancel outcome.', ref('CancelResponse')),
            '404': errorResponse('Run not found.'),
          },
        },
      },
      '/api/runs/{id}/resume': {
        post: {
          tags: ['runs'],
          summary: 'Resume a paused or interrupted run from its checkpoint',
          description:
            'Covers `paused` (snapshot at a lock gate — resume approves ' +
            'through it) and `interrupted` (crash/restart left it in-flight). ' +
            'Completed leaves replay from cached outputs; execution picks up ' +
            'where it left off. Uses the run’s STORED orchestration name ' +
            '(never client-supplied). No request body.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('Resumed.', {
              type: 'object',
              properties: { ok: { type: 'boolean', const: true } },
              required: ['ok'],
            }),
            '404': errorResponse('Run or its orchestration not found.'),
            '409': errorResponse(
              'Run is not paused/interrupted, or the resume seam refused.',
            ),
          },
        },
      },
      '/api/runs/{id}/gate': {
        post: {
          tags: ['runs'],
          summary: 'Decide a human-in-the-loop gate (approve / reject / request-changes)',
          description:
            'For a run paused at a `lock: true` phase. `approve` resumes ' +
            'through the gate (an optional `message` is delivered to the ' +
            'gated phase as a fenced human instruction). `reject` cancels ' +
            'the run. `request-changes` (requires `message`) invalidates the ' +
            'reviewed leaf — or the whole enclosing loop body — re-runs it ' +
            'with the feedback, and re-arms the lock so the run pauses at ' +
            'the same gate for re-review. Every decision appends a durable ' +
            '`gate-decision` event. A phase that reported a TERMINAL ' +
            '(do-not-retry) failure refuses request-changes with 409.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          requestBody: jsonBody(ref('GateRequest')),
          responses: {
            '200': jsonResponse('Decision applied.', ref('GateResponse')),
            '400': errorResponse(
              'Invalid JSON, unknown decision, or request-changes without a message.',
            ),
            '404': errorResponse('Run or its orchestration not found.'),
            '409': errorResponse(
              'Not paused at a gate, nothing to revise, terminal-failure ' +
                'refusal, or a racing state change.',
            ),
          },
        },
      },
      '/api/runs/{id}/signal': {
        post: {
          tags: ['runs'],
          summary: 'Deliver an external signal to a run (wait.signal leaves)',
          description:
            'Durable-first: the delivery is appended to the run’s event ' +
            'log (`signal-received`) BEFORE any resume, so a crash between ' +
            'append and resume loses nothing. When the run is currently ' +
            'paused on this exact signal it resumes immediately ' +
            '(`resumed: true`); otherwise the signal buffers durably and is ' +
            'consumed when the matching `wait` leaf crosses (or by the ' +
            'sweeper). Non-string payloads are JSON-stringified; the payload ' +
            'string becomes the wait phase’s output.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          requestBody: jsonBody(ref('SignalRequest')),
          responses: {
            '200': jsonResponse('Delivered.', ref('SignalResponse')),
            '400': errorResponse('Invalid JSON or missing/empty `signal`.'),
            '404': errorResponse('Run not found.'),
            '409': errorResponse(
              'Run is terminal (done/error/cancelled) — signals only reach ' +
                'running or paused runs.',
            ),
          },
        },
      },
      '/api/runs/{id}/terminal': {
        get: {
          tags: ['runs'],
          summary: 'Whether a terminal is driving this harness run',
          description:
            'Only whether — the command that opens the terminal holds the leg’s ' +
            'token, so it is returned by the POST (`peek: true` reads it without ' +
            'taking over), to callers allowed to write.',
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('Terminal state.', {
              type: 'object',
              properties: { live: { type: 'boolean' } },
              required: ['live'],
            }),
            '404': errorResponse('Run not found.'),
            '409': errorResponse('Not a harness run.'),
          },
        },
        post: {
          tags: ['runs'],
          summary: 'Take a harness run over in a terminal',
          description:
            'One driver at a time. A running harness run ends its server agent’s ' +
            'session leg (after any engine step in progress) and the next leg is ' +
            'the terminal’s; a run paused off a gate, interrupted or errored ' +
            'resumes with the terminal driving. A gate must be decided first. ' +
            '`open: true` also opens a terminal window on the server’s machine ' +
            '(local requests only). The terminal leg ends when the run finishes, ' +
            'stops at a gate, is handed back, or no step tool is called for ' +
            'SAMMY_HARNESS_TERMINAL_IDLE_SEC (default 30 min — the run then pauses).',
          security: mutatingSecurity,
          parameters: [runIdParam],
          requestBody: jsonBody({
            type: 'object',
            properties: {
              open: { type: 'boolean' },
              peek: { type: 'boolean', description: 'Only read the live leg’s command; never take over.' },
            },
          }),
          responses: {
            '200': jsonResponse('The terminal leg is live.', {
              type: 'object',
              properties: {
                live: { type: 'boolean' },
                command: { type: 'string' },
                opened: {
                  type: 'object',
                  properties: { opened: { type: 'boolean' }, reason: { type: 'string' } },
                },
              },
              required: ['live', 'command'],
            }),
            '404': errorResponse('Run not found.'),
            '409': errorResponse(
              'Not a harness run, waiting at a gate, finished, or not executing in this process.',
            ),
            '504': errorResponse('The run did not hand over within a minute.'),
          },
        },
      },
      '/api/runs/{id}/handback': {
        post: {
          tags: ['runs'],
          summary: 'Hand a terminal-driven harness run back to the server’s agent',
          description: 'Ends the terminal’s leg; the server’s agent continues the same session.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('Handed back.', { type: 'object', properties: { ok: { type: 'boolean' } } }),
            '404': errorResponse('Run not found.'),
            '409': errorResponse('No terminal is driving this run.'),
          },
        },
      },
      '/api/harness/settings': {
        get: {
          tags: ['ops'],
          summary: 'Workspace defaults for harness runs',
          description:
            '`follow` is the default strictness when neither the run nor the ' +
            'orchestration says (null = the built-in `strict`). Stored in ' +
            '`harness.json` at the workspace root, so triggers and API starts ' +
            'follow it too.',
          responses: {
            '200': jsonResponse('The defaults.', ref('HarnessSettings')),
          },
        },
        put: {
          tags: ['ops'],
          summary: 'Set the workspace defaults for harness runs',
          security: mutatingSecurity,
          requestBody: jsonBody(ref('HarnessSettings')),
          responses: {
            '200': jsonResponse('The defaults as stored.', ref('HarnessSettings')),
            '400': errorResponse('Invalid JSON, or `follow` is not strict | loose | advisory | null.'),
          },
        },
      },
      '/api/runs/{id}/fork': {
        post: {
          tags: ['runs'],
          summary: 'Fork a run at a completed phase (tracepoint branching)',
          description:
            'Starts a NEW run that replays every leaf completed strictly ' +
            'before `atPhase` from the source run’s captured outputs, ' +
            'then re-executes `atPhase` and everything after it fresh. Same ' +
            'budget gate as /api/runs/start.',
          security: mutatingSecurity,
          parameters: [runIdParam],
          requestBody: jsonBody(ref('ForkRequest')),
          responses: {
            '200': jsonResponse('The forked run.', ref('ForkResponse')),
            '400': errorResponse(
              'Invalid JSON, missing `atPhase`, or `atPhase` is not a ' +
                'completed leaf of the source run.',
            ),
            '402': errorResponse('Budget cap reached.'),
            '404': errorResponse('Run or its orchestration not found.'),
          },
        },
      },
      '/api/runs/{id}/trace': {
        get: {
          tags: ['runs'],
          summary: 'Export the run as an OpenTelemetry trace (OTLP/JSON)',
          description:
            'The shape an OTLP/HTTP collector accepts at POST /v1/traces: ' +
            'the run is the root span, each phase a child span.',
          parameters: [runIdParam],
          responses: {
            '200': jsonResponse('OTLP/JSON export.', ref('OtlpTrace')),
            '404': errorResponse('Run not found.'),
          },
        },
      },

      '/api/runs/{id}/artifacts': {
        get: {
          tags: ['runs'],
          summary: "List a run's artifacts, or fetch one by name",
          description:
            'Artifacts are named outputs a phase keeps beyond its result — ' +
            "today a code.run step's command log (`code.artifact`). Without " +
            '`name`, lists them; with `name`, returns that artifact\'s ' +
            'content (the latest, when a retried step wrote it twice). ' +
            'Owner-scoped like the run itself.',
          parameters: [
            runIdParam,
            {
              name: 'name',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Artifact name; omit to list.',
            },
          ],
          responses: {
            '200': {
              description:
                'Without `name`: a JSON list of { name, phaseName, mediaType, bytes, truncated, ts }. ' +
                "With `name`: the artifact's content, served with its media type.",
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        phaseName: { type: 'string' },
                        mediaType: { type: 'string' },
                        bytes: { type: 'integer' },
                        truncated: { type: 'boolean' },
                        ts: { type: 'integer' },
                      },
                    },
                  },
                },
                'text/plain': { schema: { type: 'string' } },
              },
            },
            '404': errorResponse('Run, or the named artifact, not found.'),
          },
        },
      },

      // ── Preview ───────────────────────────────────────────────────────
      '/api/preview': {
        post: {
          tags: ['preview'],
          summary: 'Symbolic dry-run (preview) of an orchestration',
          description:
            'Pure analysis — no agent dispatched, no code run, no run row ' +
            'created. Uses the same walker/renderer as the CLI `preview` and ' +
            'the same workspace resolution as the run-start path (subflows ' +
            'expand with imported-shadows-shipped precedence). Ships as a ' +
            'POST (JSON body), so under bearer/JWT auth it is gated like ' +
            'other POSTs — deliberate, since the response contains ' +
            'fully-resolved prompts and commands.',
          security: mutatingSecurity,
          requestBody: jsonBody(ref('PreviewRequest')),
          responses: {
            '200': jsonResponse('The preview plan.', ref('PreviewResponse')),
            '400': errorResponse('Invalid JSON or malformed vars/input/depth/lint.'),
            '404': errorResponse('Orchestration not found.'),
            '500': errorResponse('Preview walker failure.'),
          },
        },
      },

      // ── Trigger ingress ───────────────────────────────────────────────
      '/api/triggers': {
        get: {
          tags: ['triggers'],
          summary: 'List every registered trigger across all six kinds',
          description:
            'One row per (trigger, orchestration) with kind-specific config, ' +
            'the firing axis (http vs schedule), and — when the ' +
            'orchestration’s concurrency group is held by an active ' +
            'run — a `blockedBy` decoration answering "why didn’t my ' +
            'cron run".',
          responses: {
            '200': jsonResponse('Registered triggers.', {
              type: 'array',
              items: ref('TriggerListItem'),
            }),
            '500': errorResponse('Listing failure.'),
          },
        },
      },
      '/api/triggers/{path}': {
        post: {
          tags: ['triggers'],
          summary: 'Fire an HTTP-fired trigger by name (webhook, or any named kind)',
          description:
            'Webhooks match by declared path; when the name is not a ' +
            'webhook, the named HTTP-fired kinds (events / deployment / ' +
            'queue) are tried, so one endpoint can fire every http-fired ' +
            'kind. The delivery is durably queued (202 Accepted) and a ' +
            'worker creates the run — there is no runId in the response; ' +
            'poll GET /api/deliveries with the returned `deliveryId`. An ' +
            '`Idempotency-Key` header dedupes: a replay returns 200 with ' +
            '`duplicate: true`. Signed triggers require `X-Sammy-Signature`.',
          security: ingressSecurity,
          parameters: [
            {
              name: 'path',
              in: 'path',
              required: true,
              description: 'The webhook path or events/deployment/queue name.',
              schema: { type: 'string' },
            },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: jsonBody(
            {
              description:
                'Raw trigger payload — passed through to the orchestration.',
              type: 'object',
              additionalProperties: true,
            },
            false,
          ),
          responses: {
            '202': jsonResponse('Delivery queued.', ref('TriggerAccepted')),
            '200': jsonResponse(
              'Idempotent replay of a prior delivery (`duplicate: true`).',
              ref('TriggerAccepted'),
            ),
            '401': errorResponse('Invalid or missing X-Sammy-Signature.'),
            '404': errorResponse('No trigger registered for this name.'),
            '405': errorResponse('Method does not match the webhook declaration.'),
            '429': errorResponse('Ingress queue full — retry later.'),
          },
        },
        get: {
          tags: ['triggers'],
          summary: 'Fire a webhook trigger declared with method GET',
          description:
            'A webhook whose declaration is `method: GET` fires on GET ' +
            '(everything else responds 405 telling you the expected verb).',
          security: ingressSecurity,
          parameters: [
            {
              name: 'path',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '202': jsonResponse('Delivery queued.', ref('TriggerAccepted')),
            '200': jsonResponse('Idempotent replay.', ref('TriggerAccepted')),
            '404': errorResponse('No trigger registered for this name.'),
            '405': errorResponse('This trigger fires on a different method.'),
            '429': errorResponse('Ingress queue full — retry later.'),
          },
        },
      },
      '/api/events/{name}': {
        post: {
          tags: ['triggers'],
          summary: 'Emit a named event — fires every subscribed orchestration',
          security: ingressSecurity,
          parameters: [
            {
              name: 'name',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: jsonBody(
            { type: 'object', additionalProperties: true },
            false,
          ),
          responses: {
            '202': jsonResponse(
              'One delivery per subscribed orchestration queued.',
              ref('TriggerAccepted'),
            ),
            '200': jsonResponse('Idempotent replay.', ref('TriggerAccepted')),
            '401': errorResponse('Invalid or missing X-Sammy-Signature.'),
            '404': errorResponse('No events trigger registered for this name.'),
            '429': errorResponse('Ingress queue full — retry later.'),
          },
        },
      },
      '/api/deploy/{env}': {
        post: {
          tags: ['triggers'],
          summary: 'Signal a deployment to an environment — fires subscribers',
          security: ingressSecurity,
          parameters: [
            {
              name: 'env',
              in: 'path',
              required: true,
              description: 'The deployment environment name.',
              schema: { type: 'string' },
            },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: jsonBody(
            { type: 'object', additionalProperties: true },
            false,
          ),
          responses: {
            '202': jsonResponse('Deliveries queued.', ref('TriggerAccepted')),
            '200': jsonResponse('Idempotent replay.', ref('TriggerAccepted')),
            '401': errorResponse('Invalid or missing X-Sammy-Signature.'),
            '404': errorResponse('No deployment trigger for this environment.'),
            '429': errorResponse('Ingress queue full — retry later.'),
          },
        },
      },
      '/api/queue/{name}': {
        post: {
          tags: ['triggers'],
          summary: 'Push a message to a named queue trigger — fires subscribers',
          security: ingressSecurity,
          parameters: [
            {
              name: 'name',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            { $ref: '#/components/parameters/IdempotencyKey' },
          ],
          requestBody: jsonBody(
            { type: 'object', additionalProperties: true },
            false,
          ),
          responses: {
            '202': jsonResponse('Deliveries queued.', ref('TriggerAccepted')),
            '200': jsonResponse('Idempotent replay.', ref('TriggerAccepted')),
            '401': errorResponse('Invalid or missing X-Sammy-Signature.'),
            '404': errorResponse('No queue trigger registered for this name.'),
            '429': errorResponse('Ingress queue full — retry later.'),
          },
        },
      },
      '/api/trigger-catalog': {
        get: {
          tags: ['triggers'],
          summary: 'Complete reactive-surface view — every declared trigger',
          description:
            'Every registered trigger across all six kinds (webhook, cron, ' +
            'polling, events, deployment, queue), one row per declaration.',
          responses: {
            '200': jsonResponse('Catalog entries.', {
              type: 'array',
              items: ref('CatalogEntry'),
            }),
          },
        },
      },
      '/api/deliveries': {
        get: {
          tags: ['triggers'],
          summary: 'Durable-ingress audit trail (owner-scoped)',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Max rows (1–1000, default 200).',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 1000,
                default: 200,
              },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: ref('DeliveryStatus'),
            },
          ],
          responses: {
            '200': jsonResponse('Delivery records, newest first.', {
              type: 'array',
              items: ref('Delivery'),
            }),
            '500': errorResponse('Store failure.'),
          },
        },
      },
      '/api/deliveries/stats': {
        get: {
          tags: ['triggers'],
          summary: 'Ingress queue health (counts by status, fire rates) — owner-scoped',
          description:
            'Counts only the caller’s own deliveries (`X-Sammy-User`, else ' +
            '`system`), like the list: a tenant sees the health of THEIR ' +
            'queue, not a global figure that says how busy others are. The ' +
            'backpressure cap behind the 429 stays global — the queue itself ' +
            'is shared.',
          responses: {
            '200': jsonResponse('Queue stats.', ref('DeliveryStats')),
          },
        },
      },
      '/api/deliveries/{id}/replay': {
        post: {
          tags: ['triggers'],
          summary: 'Re-drive a failed or rejected delivery',
          security: mutatingSecurity,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '202': jsonResponse('Requeued as pending.', {
              type: 'object',
              properties: {
                replayed: { type: 'string' },
                status: { type: 'string', const: 'pending' },
              },
              required: ['replayed', 'status'],
            }),
            '409': errorResponse(
              'Delivery not found or not in a replayable (failed/rejected) state.',
            ),
          },
        },
      },

      // ── Ops ───────────────────────────────────────────────────────────
      '/api/health': {
        get: {
          tags: ['ops'],
          summary: 'Health + real capability signals',
          description:
            'Reachable without a token (GET is never auth-gated). ' +
            '`?probe=1` opt-in runs ONE trivial agent tool-call under a hard ' +
            'timeout and caches the result; the default response reads the ' +
            'cache (`agentTools: "unknown"` when never probed) and never ' +
            'spawns anything. Never 500s — a store failure reports ' +
            '`status: "degraded"` with an `error` field, still 200.',
          parameters: [
            {
              name: 'probe',
              in: 'query',
              required: false,
              description: 'Set to `1` or `true` to run the agent-tools probe.',
              schema: { type: 'string', enum: ['1', 'true'] },
            },
          ],
          responses: {
            '200': jsonResponse('Health snapshot.', ref('Health')),
          },
        },
      },
      '/api/observability': {
        get: {
          tags: ['ops'],
          summary: 'Run/phase/branch analytics digest (owner-scoped)',
          description:
            'Server-side aggregation over recent runs (bounded, hydrated ' +
            'sequentially): totals, per-orchestration and per-phase rollups ' +
            '(cost-sorted), daily buckets, recent runs, and branch coverage ' +
            'from route/switch decisions.',
          responses: {
            '200': jsonResponse('The digest.', ref('ObservabilityDigest')),
            '500': errorResponse('Aggregation failure.'),
          },
        },
      },
      '/api/budget': {
        get: {
          tags: ['ops'],
          summary: 'The spend caps (global and per-owner)',
          description:
            'Caps live in `budget.json` at the workspace root; the durable ' +
            'run store is the source of spend truth. Every field is present, ' +
            'null meaning "no cap".',
          responses: {
            '200': jsonResponse('The caps.', ref('BudgetConfig')),
            '500': errorResponse('Read failure.'),
          },
        },
        put: {
          tags: ['ops'],
          summary: 'Write the global caps',
          description:
            'Replaces `dailyUsd` / `monthlyUsd`; a value that is not a ' +
            'number clears that cap. The per-owner caps are file-configured ' +
            'and are NOT touched by this route — a PUT keeps whatever ' +
            '`budget.json` holds for them.',
          security: mutatingSecurity,
          requestBody: jsonBody(ref('BudgetUpdate')),
          responses: {
            '200': jsonResponse('The caps as persisted.', ref('BudgetConfig')),
            '400': errorResponse('Invalid JSON, or the body is not an object.'),
            '500': errorResponse('Write failure.'),
          },
        },
      },
      '/api/budget/status': {
        get: {
          tags: ['ops'],
          summary: 'Spend against the caps (owner-scoped)',
          description:
            'The global ceilings against workspace-wide spend, AND the ' +
            'per-owner caps against the CALLER’s own spend (`X-Sammy-User`, ' +
            'else `system`) — the same evaluation `POST /api/runs/start` ' +
            'refuses on, so this figure never disagrees with what blocks the ' +
            'caller’s next run. `blocked` is at/over 100% of ANY limit; ' +
            '`warning` is at/over 80% of any.',
          responses: {
            '200': jsonResponse('Spend status.', ref('BudgetStatus')),
            '500': errorResponse('Aggregation failure.'),
          },
        },
      },
      '/api/cost': {
        get: {
          tags: ['ops'],
          summary: 'Token & cost dashboard digest (owner-scoped)',
          description:
            'Today/month spend, run totals, per-run and per-phase token/cost ' +
            'breakdowns, and token-ceiling circuit-breaker trips.',
          responses: {
            '200': jsonResponse('The cost digest.', ref('CostDigest')),
            '500': errorResponse('Aggregation failure.'),
          },
        },
      },
      '/api/concurrency': {
        get: {
          tags: ['ops'],
          summary: 'Concurrency-group queue visibility (owner-scoped details)',
          description:
            'One row per known group (declared by a workspace orchestration, ' +
            'stamped on an active run, or holding parked fires). `held` says ' +
            'whether ANY active run holds the group; `holder` names it only ' +
            'when the caller owns that run, and `queued` lists only the ' +
            'caller’s own parked fires, in FIFO drain order. `policy` is the ' +
            'holder’s declaration, else any workspace declaration, else null.',
          responses: {
            '200': jsonResponse('Group rows.', {
              type: 'array',
              items: ref('ConcurrencyGroup'),
            }),
            '500': errorResponse('Store failure.'),
          },
        },
      },
      '/api/concurrency/{group}/queued': {
        delete: {
          tags: ['ops'],
          summary: 'Withdraw EVERY parked fire behind a group (without starting them)',
          security: mutatingSecurity,
          parameters: [
            {
              name: 'group',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': jsonResponse('Count of fires withdrawn.', {
              type: 'object',
              properties: { withdrawn: { type: 'integer' } },
              required: ['withdrawn'],
            }),
            '500': errorResponse('Withdrawal failure.'),
          },
        },
      },
      '/api/concurrency/{group}/queued/{fireId}': {
        delete: {
          tags: ['ops'],
          summary: 'Withdraw one parked fire by id',
          security: mutatingSecurity,
          parameters: [
            {
              name: 'group',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'fireId',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': jsonResponse('The withdrawn fire.', {
              type: 'object',
              properties: {
                withdrawn: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    orchestration: { type: 'string' },
                    group: { type: 'string' },
                    queuedSinceMs: { type: 'integer' },
                  },
                },
              },
              required: ['withdrawn'],
            }),
            '400': errorResponse('fireId must be a number.'),
            '404': errorResponse(
              'No such parked fire for this group (already started, ' +
                'already withdrawn, or wrong group).',
            ),
          },
        },
      },
      '/api/agent-slots': {
        get: {
          tags: ['ops'],
          summary: 'Global agent-concurrency pool state',
          responses: {
            '200': jsonResponse('Pool state.', ref('AgentSlots')),
          },
        },
        put: {
          tags: ['ops'],
          summary: 'Resize the global agent-concurrency cap at runtime',
          security: mutatingSecurity,
          requestBody: jsonBody({
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                minimum: 1,
                description: 'New concurrent-agent cap (≥ 1).',
              },
            },
            required: ['limit'],
          }),
          responses: {
            '200': jsonResponse('Pool state after resize.', ref('AgentSlots')),
            '400': errorResponse('limit must be a number ≥ 1.'),
          },
        },
      },
      '/api/agent-queue': {
        get: {
          tags: ['ops'],
          summary: 'Agent-dispatch waitlist (blocked on the concurrency cap)',
          responses: {
            '200': jsonResponse('Queue state.', ref('AgentQueue')),
          },
        },
      },
      '/api/agent-queue/reorder': {
        post: {
          tags: ['ops'],
          summary: 'Reprioritize one waiting agent dispatch',
          description:
            'Move a queued dispatch up/down one slot, or to an absolute ' +
            '0-based index. Slots are granted from the front, so reordering ' +
            'never disturbs in-flight agents.',
          security: mutatingSecurity,
          requestBody: jsonBody({
            type: 'object',
            properties: {
              id: { type: 'string' },
              dir: { type: 'string', enum: ['up', 'down'] },
              toIndex: { type: 'integer', minimum: 0 },
            },
            required: ['id'],
            description: 'Provide `dir` OR `toIndex` alongside `id`.',
          }),
          responses: {
            '200': jsonResponse('Queue state after the move.', ref('AgentQueue')),
            '400': errorResponse('Missing id, or neither dir nor toIndex.'),
            '409': errorResponse(
              'The item is no longer waiting (it may have started).',
            ),
          },
        },
      },

      // ── Registry ──────────────────────────────────────────────────────
      '/api/orchestrations': {
        get: {
          tags: ['registry'],
          summary: 'List workspace orchestrations (full nodes, provenance-tagged)',
          description:
            'Each entry is the orchestration JSON with a runtime-only ' +
            '`__origin` tag: `imported` (symlinked domain file) or `shipped` ' +
            '(in-repo example).',
          responses: {
            '200': jsonResponse('Orchestration nodes.', {
              type: 'array',
              items: ref('OrchestrationNode'),
            }),
            '500': errorResponse('Read failure.'),
          },
        },
      },
      '/api/orchestrations/{name}/pause': {
        post: {
          tags: ['orchestrations'],
          summary: "Pause an orchestration's trigger intake",
          description:
            'HTTP-fired deliveries for it are HELD (re-checked every minute, ' +
            'no retry attempt spent, never dead-lettered) and scheduled ' +
            'ticks are skipped until resumed. Runs already in flight and ' +
            'manual starts are unaffected. Persisted in the workspace root ' +
            '(intake-pauses.json), so a restart and the standalone worker ' +
            'honor it.',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } },
              },
            },
          },
          responses: {
            '200': jsonResponse('Paused.', { type: 'object' }),
            '400': errorResponse('Invalid JSON body.'),
            '404': errorResponse('Orchestration not found.'),
          },
        },
      },
      '/api/orchestrations/{name}/resume': {
        post: {
          tags: ['orchestrations'],
          summary: "Resume an orchestration's trigger intake",
          description: 'Releases held deliveries immediately (`released` counts them).',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse('Resumed.', {
              type: 'object',
              properties: {
                orchestration: { type: 'string' },
                paused: { type: 'boolean' },
                wasPaused: { type: 'boolean' },
                released: { type: 'integer' },
              },
            }),
            '404': errorResponse('Orchestration not found.'),
          },
        },
      },
      '/api/orchestrations/{name}/intake': {
        get: {
          tags: ['orchestrations'],
          summary: 'Intake state: pause switch, root limits, and usage against them',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse('Intake state.', {
              type: 'object',
              properties: {
                orchestration: { type: 'string' },
                paused: { type: ['object', 'null'] },
                limits: { type: ['object', 'null'] },
                usage: {
                  type: 'object',
                  properties: {
                    runsToday: { type: 'integer' },
                    todayUsd: { type: 'number' },
                    monthUsd: { type: 'number' },
                  },
                },
                limitReached: { type: ['string', 'null'] },
              },
            }),
            '404': errorResponse('Orchestration not found.'),
          },
        },
      },
      '/api/orchestrations/{name}': {
        get: {
          tags: ['registry'],
          summary: 'Fetch one orchestration',
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '200': jsonResponse('The orchestration.', ref('OrchestrationNode')),
            '400': errorResponse('Invalid name.'),
            '404': errorResponse('Not found.'),
          },
        },
        put: {
          tags: ['registry'],
          summary: 'Create/overwrite an orchestration (validated; lint rides back)',
          description:
            'Hard schema errors reject the save (400). Lint findings are ' +
            'advisory — never block, but return on the response as ' +
            '`warnings`. Declared triggers hot-reload on save.',
          security: mutatingSecurity,
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          requestBody: jsonBody(ref('OrchestrationNode')),
          responses: {
            '200': jsonResponse(
              'The persisted node plus advisory `warnings`.',
              ref('OrchestrationNode'),
            ),
            '400': errorResponse('Invalid JSON or schema validation errors.'),
          },
        },
        delete: {
          tags: ['registry'],
          summary: 'Delete an orchestration (and drop its triggers)',
          security: mutatingSecurity,
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '204': { description: 'Deleted (idempotent).' },
            '400': errorResponse('Invalid name.'),
          },
        },
      },
      '/api/agents': {
        get: {
          tags: ['registry'],
          summary: 'List workspace agents (raw markdown)',
          responses: {
            '200': jsonResponse('Agents.', {
              type: 'array',
              items: ref('AgentFile'),
            }),
            '500': errorResponse('Read failure.'),
          },
        },
      },
      '/api/agents/{name}': {
        get: {
          tags: ['registry'],
          summary: 'Fetch one agent',
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '200': jsonResponse('The agent.', ref('AgentFile')),
            '400': errorResponse('Invalid name.'),
            '404': errorResponse('Not found.'),
          },
        },
        put: {
          tags: ['registry'],
          summary: 'Overwrite an agent’s raw markdown',
          description:
            'Writes follow symlinks — editing an imported (symlinked) agent ' +
            'updates the source file in its origin workspace.',
          security: mutatingSecurity,
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          requestBody: jsonBody({
            type: 'object',
            properties: { raw: { type: 'string' } },
            required: ['raw'],
          }),
          responses: {
            '200': jsonResponse('The persisted agent.', ref('AgentFile')),
            '400': errorResponse('Invalid JSON or missing string `raw`.'),
          },
        },
        delete: {
          tags: ['registry'],
          summary: 'Delete an agent',
          security: mutatingSecurity,
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '204': { description: 'Deleted (idempotent).' },
            '400': errorResponse('Invalid name.'),
          },
        },
      },
      '/api/schemas': {
        get: {
          tags: ['registry'],
          summary: 'List framework JSON schemas (read-only)',
          responses: {
            '200': jsonResponse('Schemas.', {
              type: 'array',
              items: ref('SchemaFile'),
            }),
          },
        },
      },
      '/api/schemas/{name}': {
        get: {
          tags: ['registry'],
          summary: 'Fetch one schema',
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '200': jsonResponse('The schema.', ref('SchemaFile')),
            '400': errorResponse('Invalid name.'),
            '404': errorResponse('Not found.'),
          },
        },
      },
      '/api/versions/{scope}/{name}': {
        get: {
          tags: ['registry'],
          summary: 'Git history of an agent or orchestration file',
          parameters: [
            { $ref: '#/components/parameters/VersionScope' },
            { $ref: '#/components/parameters/SafeName' },
          ],
          responses: {
            '200': jsonResponse('Commits touching the file (max 50).', {
              type: 'array',
              items: ref('VersionCommit'),
            }),
            '400': errorResponse('Invalid scope (agents | examples) or name.'),
            '500': errorResponse('git log failed.'),
          },
        },
      },
      '/api/versions/{scope}/{name}/{sha}': {
        get: {
          tags: ['registry'],
          summary: 'File content at a specific commit',
          parameters: [
            { $ref: '#/components/parameters/VersionScope' },
            { $ref: '#/components/parameters/SafeName' },
            {
              name: 'sha',
              in: 'path',
              required: true,
              description: 'Lowercase hex, 7–40 chars.',
              schema: { type: 'string', pattern: '^[0-9a-f]{7,40}$' },
            },
          ],
          responses: {
            '200': jsonResponse('Historical content.', {
              type: 'object',
              properties: {
                sha: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['sha', 'content'],
            }),
            '400': errorResponse('Invalid scope, name, or sha.'),
            '404': errorResponse('Commit/path not found at sha.'),
          },
        },
      },

      // ── A2A ───────────────────────────────────────────────────────────
      '/.well-known/agent-card.json': {
        get: {
          tags: ['a2a'],
          summary: 'Root A2A agent card (discovery)',
          description:
            'Advertises the server and its non-deprecated orchestrations as ' +
            'skills. Optionally JWS-signed when card signing is configured.',
          responses: {
            '200': jsonResponse('The agent card.', ref('AgentCard')),
            '500': errorResponse('Card build failure.'),
          },
        },
      },
      '/api/a2a/{name}/agent-card.json': {
        get: {
          tags: ['a2a'],
          summary: 'Per-orchestration A2A agent card',
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          responses: {
            '200': jsonResponse('The orchestration card.', ref('AgentCard')),
            '400': errorResponse('Invalid orchestration name.'),
            '404': errorResponse('Orchestration not found.'),
          },
        },
      },
      '/api/a2a/{name}': {
        post: {
          tags: ['a2a'],
          summary: 'A2A JSON-RPC 2.0 endpoint for one orchestration',
          description:
            'JSON-RPC 2.0 over HTTP. Protocol errors are HTTP 200 with a ' +
            'JSON-RPC error body (per the spec). Supported methods:\n\n' +
            '- `message/send` — start a run from the message text (or, with ' +
            '`message.taskId`, resume a paused task with follow-up input); ' +
            'returns the Task. `metadata.idempotencyKey` dedupes to the ' +
            'existing task.\n' +
            '- `message/stream` — same, but responds as an SSE stream of ' +
            'JSON-RPC results (status/artifact updates).\n' +
            '- `tasks/get` — fetch a Task by id.\n' +
            '- `tasks/cancel` — cancel a Task; returns its post-cancel state.\n' +
            '- `tasks/resubscribe` — re-attach an SSE stream to a task.\n' +
            '- `tasks/pushNotificationConfig/set` — register a webhook URL ' +
            'on a live run (in-memory; lost on restart). The URL must be ' +
            'absolute http(s) with a host in `SAMMY_NOTIFY_ALLOWED_HOSTS`; ' +
            'otherwise — and whenever that list is empty, the default — the ' +
            'reply is a JSON-RPC `invalidParams` (-32602) error that says so. ' +
            'A task the caller does not own, or one no longer active, is ' +
            '`taskNotFound` (-32001).\n' +
            '- `tasks/pushNotificationConfig/get` — read it back.\n\n' +
            'Budget pre-flight applies to run-starting methods (a blocked ' +
            'budget surfaces as a JSON-RPC internal error).',
          security: mutatingSecurity,
          parameters: [{ $ref: '#/components/parameters/SafeName' }],
          requestBody: jsonBody(ref('JsonRpcRequest')),
          responses: {
            '200': {
              description:
                'JSON-RPC response (result or error), or an SSE stream for ' +
                'message/stream and tasks/resubscribe.',
              content: {
                'application/json': { schema: ref('JsonRpcResponse') },
                'text/event-stream': {
                  schema: {
                    type: 'string',
                    description:
                      'data: <JSON-RPC result> lines carrying Task status/artifact updates.',
                  },
                },
              },
            },
            '400': errorResponse('Invalid orchestration name.'),
            '404': errorResponse('Unrecognized A2A sub-path.'),
          },
        },
      },
    },

    components: {
      securitySchemes: {
        bearerToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Static admin token (SAMMY_API_TOKEN). Only enforced when the ' +
            'env var is set: on state-changing methods ' +
            '(POST/PUT/DELETE/PATCH) always, on GET/HEAD/OPTIONS only under ' +
            'SAMMY_REQUIRE_AUTH_READS=1 (probes excepted). ' +
            'Trigger ingress is exempt (uses HMAC instead).',
        },
        bearerJwt: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Verified JWT identity. Enabled by SAMMY_JWKS_URI (RS256/JWKS), ' +
            'SAMMY_JWT_PUBLIC_KEY (RS256/PEM), or SAMMY_JWT_SECRET (HS256) — ' +
            'exactly one algorithm family is accepted. The owner claim ' +
            '(default `sub`) becomes the verified X-Sammy-User identity. ' +
            'Required on state-changing requests; accept-if-present on reads ' +
            'unless SAMMY_REQUIRE_AUTH_READS=1, which requires it there too.',
        },
        triggerSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Sammy-Signature',
          description:
            'HMAC ingress auth for triggers declared `signed` (secret: ' +
            'SAMMY_WEBHOOK_SECRET). Preferred v2: ' +
            '`t=<unix-seconds>,n=<nonce>,v1=<hex>` with ' +
            'hex = HMAC-SHA256("t.nonce.rawBody", secret) — ±300s timestamp ' +
            'window, nonce replay rejection. Legacy `sha256=<hex>` ' +
            '(HMAC-SHA256 of the raw body) still accepted.',
        },
      },
      parameters: {
        SafeName: {
          name: 'name',
          in: 'path',
          required: true,
          description:
            'A safe name: letters, digits, dot, underscore, dash only.',
          schema: { type: 'string' },
        },
        VersionScope: {
          name: 'scope',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ['agents', 'examples'] },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'Client-chosen dedupe key. A replayed delivery returns 200 with ' +
            '`duplicate: true` instead of firing again.',
          schema: { type: 'string' },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          description: 'Uniform error envelope.',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        RunStatus: {
          type: 'string',
          enum: [
            'running',
            'done',
            'error',
            'cancelled',
            'paused',
            'interrupted',
          ],
        },
        RunEvent: {
          type: 'object',
          description:
            'One event in a run’s durable log. Open-shaped: every event ' +
            'has a `type` (e.g. run-start, phase-start, phase-delta, ' +
            'phase-end, phase-error, tool-use, route-decision, ' +
            'gate-decision, signal-received, run-paused, run-end) and ' +
            'usually a `ts` (epoch ms); the rest is type-specific.',
          properties: {
            type: { type: 'string' },
            ts: { type: 'integer', description: 'Epoch millis.' },
          },
          required: ['type'],
          additionalProperties: true,
        },
        DegradationReason: {
          type: 'object',
          description: 'Why a `done` run is flagged done-but-degraded.',
          additionalProperties: true,
        },
        RunListItem: {
          type: 'object',
          description:
            'Lightweight run row for the list endpoint — never carries the ' +
            'events array; `preview` is a short last-output snippet.',
          properties: {
            id: { type: 'string' },
            orchestrationName: { type: 'string' },
            startedAt: { type: 'integer', description: 'Epoch millis.' },
            endedAt: { type: 'integer', description: 'Epoch millis; absent while active.' },
            status: ref('RunStatus'),
            pausedFor: {
              type: 'string',
              description: 'The gated phase name, when paused at a lock.',
            },
            eventVersion: {
              type: 'integer',
              description: 'Total event count (poll-merge cursor).',
            },
            preview: {
              type: 'string',
              description: 'Last phase output, truncated to ~200 chars.',
            },
            orchestrationSnapshot: {
              description:
                'The orchestration tree the SERVER captured at start (the ' +
                'resume / replay pin). Absent for a client-pushed record — ' +
                'POST /api/runs never stores one.',
            },
            initialInput: { type: 'string' },
            stale: {
              type: 'boolean',
              description:
                'Present (true) when paused past the SAMMY_GATE_TTL_HOURS TTL.',
            },
            pausedSinceMs: { type: 'integer', description: 'Epoch millis.' },
          },
          required: ['id', 'orchestrationName', 'startedAt', 'status', 'eventVersion'],
        },
        RunDetail: {
          type: 'object',
          description:
            'Full run record: header + events + derived health verdicts. ' +
            'endedAt / pausedFor / concurrencyGroup are explicit nulls (not ' +
            'omitted) so absence is distinguishable from an older server.',
          properties: {
            id: { type: 'string' },
            orchestrationName: { type: 'string' },
            startedAt: { type: 'integer' },
            endedAt: { type: ['integer', 'null'] },
            status: ref('RunStatus'),
            events: { type: 'array', items: ref('RunEvent') },
            eventVersion: {
              type: 'integer',
              description:
                'ALWAYS the full event count, even under `?since` (the ' +
                'incremental cursor).',
            },
            costUsd: {
              type: 'number',
              description: 'Spend-to-date summed from phase-end events.',
            },
            orchestrationSnapshot: {
              description:
                'Server-captured at start; null for a client-pushed record.',
            },
            initialInput: { type: 'string' },
            completedLeaves: { type: 'array', items: { type: 'string' } },
            stateJson: { description: 'Executor checkpoint state.' },
            pausedFor: { type: ['string', 'null'] },
            lastOutput: { type: 'string' },
            concurrencyGroup: { type: ['string', 'null'] },
            degraded: { type: 'boolean' },
            degradationReasons: {
              type: 'array',
              items: ref('DegradationReason'),
            },
            divergence: {
              type: 'object',
              description:
                'Run-level thrash (retry-storm) verdict; `diverged: false` ' +
                'for a healthy run.',
              additionalProperties: true,
            },
            notes: {
              type: 'object',
              description:
                'Structured run-end summary (per-item verdicts + totals + ' +
                'health flags) derived from the event stream.',
              additionalProperties: true,
            },
            pausedSinceMs: {
              type: 'integer',
              description: 'Present only while paused.',
            },
            stale: { type: 'boolean', description: 'Present only while paused.' },
          },
          required: [
            'id',
            'orchestrationName',
            'startedAt',
            'endedAt',
            'status',
            'events',
            'eventVersion',
            'costUsd',
            'pausedFor',
            'concurrencyGroup',
            'degraded',
            'degradationReasons',
            'divergence',
            'notes',
          ],
        },
        RunSummary: {
          type: 'object',
          description:
            'Lightweight status snapshot (mirrors the store’s RunSummary).',
          properties: {
            id: { type: 'string' },
            orchestrationName: { type: 'string' },
            status: ref('RunStatus'),
            startedAt: { type: 'integer' },
            endedAt: { type: ['integer', 'null'] },
            phasesStarted: { type: 'integer' },
            phasesEnded: { type: 'integer' },
            toolUses: { type: 'integer' },
            lastEventType: { type: ['string', 'null'] },
            lastEventTs: { type: ['integer', 'null'] },
            lastProgressAt: {
              type: ['integer', 'null'],
              description:
                'Liveness clock, epoch ms — the newest event of any type ' +
                'including throttled phase-heartbeat beats, so it tracks ' +
                'the stall watchdog’s progress clock to within ~30s. A ' +
                'running run whose lastProgressAt is minutes old is ' +
                'genuinely wedged, not quietly working.',
            },
            currentPhase: { type: ['string', 'null'] },
            costUsd: { type: 'number' },
            degraded: { type: 'boolean' },
            degradationReasons: {
              type: 'array',
              items: ref('DegradationReason'),
            },
          },
          required: [
            'id',
            'orchestrationName',
            'status',
            'startedAt',
            'endedAt',
            'phasesStarted',
            'phasesEnded',
            'toolUses',
            'lastEventType',
            'lastEventTs',
            'lastProgressAt',
            'currentPhase',
            'costUsd',
            'degraded',
            'degradationReasons',
          ],
        },
        RunUpsert: {
          type: 'object',
          description:
            'Client-pushed run record (POST /api/runs). `orchestrationSnapshot` ' +
            'is NOT an input: the server owns it and drops one if sent.',
          properties: {
            id: { type: 'string', description: 'Safe name — required.' },
            orchestrationName: { type: 'string' },
            startedAt: { type: 'integer' },
            endedAt: { type: 'integer' },
            status: {
              type: 'string',
              enum: ['running', 'done', 'error', 'cancelled', 'paused'],
              description:
                'Note: `interrupted` is server-assigned and not accepted here.',
            },
            events: { type: 'array', items: ref('RunEvent') },
            initialInput: { type: 'string' },
          },
          required: ['id', 'status'],
        },
        RunStartRequest: {
          type: 'object',
          properties: {
            orchestrationName: {
              type: 'string',
              description: 'Safe name of a workspace orchestration.',
            },
            initialInput: { type: 'string' },
            model: { type: 'string' },
            allowAgentTools: { type: 'boolean' },
            execution: {
              enum: ['pipeline', 'harness'],
              description:
                'Run as a pipeline (each agent step its own agent) or a harness ' +
                '(one agent follows the steps and does each itself), overriding ' +
                'the orchestration’s own `execution`.',
            },
            follow: {
              enum: ['strict', 'loose', 'advisory'],
              description:
                'Harness strictness for this run, overriding the orchestration’s ' +
                '`harness.follow` and the workspace default — unless the ' +
                'orchestration sets `harness.lockFollow`, which only lets a run ' +
                'make it stricter. Recorded on the run with where it came from.',
            },
            inputs: {
              type: 'object',
              description:
                'Values for the orchestration’s declared `inputs`, ' +
                'keyed by input name. For kind:file, `file.data` is base64.',
              additionalProperties: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                  file: {
                    type: 'object',
                    properties: {
                      filename: { type: 'string' },
                      mediaType: { type: 'string' },
                      data: {
                        type: 'string',
                        contentEncoding: 'base64',
                      },
                    },
                  },
                },
              },
            },
          },
          required: ['orchestrationName'],
        },
        HarnessSettings: {
          type: 'object',
          properties: {
            follow: { type: ['string', 'null'], enum: ['strict', 'loose', 'advisory', null] },
          },
          required: ['follow'],
        },
        RunStartResponse: {
          type: 'object',
          properties: {
            id: {
              type: ['string', 'null'],
              description:
                'The new run id, or null when the concurrency start-gate ' +
                'skipped/queued the fire.',
            },
            concurrency: {
              type: 'string',
              enum: ['skipped', 'queued'],
              description: 'Present only when no run was created.',
            },
          },
          required: ['id'],
        },
        CancelResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            aborted: {
              type: 'boolean',
              description: 'True when a live in-process executor was aborted.',
            },
            cancelled: {
              type: 'boolean',
              description: 'True when a stored run was marked cancelled.',
            },
            status: {
              type: 'string',
              description:
                'With ok:false — the terminal status the run already had.',
            },
          },
          required: ['ok'],
        },
        GateRequest: {
          type: 'object',
          properties: {
            decision: {
              type: 'string',
              enum: ['approve', 'reject', 'request-changes'],
            },
            message: {
              type: 'string',
              description:
                'Optional with approve (delivered to the gated phase as a ' +
                'fenced human instruction); REQUIRED with request-changes ' +
                '(the feedback to revise against).',
            },
          },
          required: ['decision'],
        },
        GateResponse: {
          type: 'object',
          description:
            'reject → `{ok, cancelled}`; approve / request-changes → ' +
            '`{ok, resumed, decision, messageDelivered}`.',
          properties: {
            ok: { type: 'boolean' },
            cancelled: { type: 'boolean' },
            resumed: { type: 'boolean' },
            decision: {
              type: 'string',
              enum: ['approve', 'request-changes'],
            },
            messageDelivered: { type: 'boolean' },
          },
          required: ['ok'],
        },
        SignalRequest: {
          type: 'object',
          properties: {
            signal: {
              type: 'string',
              minLength: 1,
              description: 'The signal name a `wait.signal` leaf is waiting on.',
            },
            payload: {
              description:
                'Any JSON value. Non-strings are JSON-stringified; the ' +
                'string becomes the wait phase’s output.',
            },
          },
          required: ['signal'],
        },
        SignalResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            delivered: {
              type: 'boolean',
              description: 'The signal was durably appended to the event log.',
            },
            resumed: {
              type: 'boolean',
              description:
                'True when the run was paused on exactly this signal and ' +
                'resumed immediately; false when the signal buffered.',
            },
          },
          required: ['ok', 'delivered', 'resumed'],
        },
        ForkRequest: {
          type: 'object',
          properties: {
            atPhase: {
              type: 'string',
              description:
                'A completed leaf name of the source run — the first phase ' +
                're-executed fresh in the fork.',
            },
          },
          required: ['atPhase'],
        },
        ForkResponse: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The new (forked) run id.' },
            forkedFrom: { type: 'string' },
            atPhase: { type: 'string' },
            replayedLeaves: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Leaves replayed from the source run’s captured outputs.',
            },
          },
          required: ['id', 'forkedFrom', 'atPhase', 'replayedLeaves'],
        },
        OtlpTrace: {
          type: 'object',
          description:
            'OTLP/JSON export — the payload an OTLP/HTTP collector accepts ' +
            'at POST /v1/traces (resourceSpans → scopeSpans → spans).',
          properties: {
            resourceSpans: { type: 'array', items: { type: 'object' } },
          },
          additionalProperties: true,
        },
        PreviewRequest: {
          type: 'object',
          properties: {
            orchestrationName: { type: 'string' },
            vars: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Interpolation values for `${var}` references.',
            },
            input: {
              type: 'string',
              description: 'Simulated initial input.',
            },
            depth: {
              type: 'number',
              minimum: 0,
              description: 'Max subflow expansion depth.',
            },
            lint: {
              type: 'boolean',
              description: 'false disables lint findings.',
            },
          },
          required: ['orchestrationName'],
        },
        PreviewResponse: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              description:
                'All findings flattened (root first, then per-node in tree ' +
                'order); `phase` names the owning node.',
              items: {
                type: 'object',
                properties: {
                  phase: { type: 'string' },
                },
                additionalProperties: true,
              },
            },
            tree: {
              type: 'array',
              description: 'The PreviewNode[] phase tree (render-agnostic JSON).',
              items: { type: 'object', additionalProperties: true },
            },
            rendered: {
              type: 'string',
              description: 'The terminal text renderer’s output.',
            },
          },
          required: ['findings', 'tree', 'rendered'],
        },
        TriggerAccepted: {
          type: 'object',
          description:
            'Accept-not-execute envelope: the delivery is durably queued ' +
            '(202) and a worker creates the run — there is no runId here. ' +
            'Poll GET /api/deliveries with `deliveryId`. 200 marks an ' +
            'idempotent replay.',
          properties: {
            trigger: {
              type: 'string',
              description: 'The trigger kind (webhook / events / deployment / queue).',
            },
            name: { type: 'string' },
            duplicate: { type: 'boolean' },
            deliveryId: {
              type: ['string', 'null'],
              description:
                'Present on the /api/triggers/{path} envelope (first delivery).',
            },
            deliveries: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: 'One entry per subscribed orchestration.',
            },
          },
          required: ['trigger', 'name', 'duplicate', 'deliveries'],
        },
        TriggerListItem: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['webhook', 'cron', 'polling', 'events', 'deployment', 'queue'],
            },
            name: { type: 'string' },
            orchestration: { type: 'string' },
            firing: { type: 'string', enum: ['http', 'schedule'] },
            summary: { type: 'string' },
            config: {
              type: 'object',
              additionalProperties: true,
              description:
                'Kind-specific: webhook {path, method, signed?}, named ' +
                '{name, method, signed?}, cron {expr, schedule}, polling ' +
                '{source, intervalSeconds}.',
            },
            blockedBy: {
              type: 'object',
              description:
                'Present when the orchestration’s concurrency group is ' +
                'held by an active run — a fire now would queue/skip/cancel ' +
                'per policy.',
              properties: {
                runId: { type: 'string' },
                group: { type: 'string' },
                heldSinceMs: { type: 'integer' },
              },
              required: ['runId', 'group', 'heldSinceMs'],
            },
          },
          required: ['kind', 'name', 'orchestration', 'firing', 'summary', 'config'],
        },
        CatalogEntry: {
          type: 'object',
          properties: {
            orchestration: { type: 'string' },
            kind: { type: 'string' },
            summary: { type: 'string' },
            // Present only when the trigger's ingress enforces a signature;
            // the value names WHICH scheme ('sammy' for the native one).
            signed: { type: 'string', enum: [...WEBHOOK_PROVIDERS] },
          },
          required: ['orchestration', 'kind', 'summary'],
        },
        DeliveryStatus: {
          type: 'string',
          enum: [
            'accepted',
            'pending',
            'claimed',
            'fired',
            'duplicate',
            'rejected',
            'deferred',
            'failed',
          ],
        },
        Delivery: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            name: { type: 'string' },
            orchestrationName: { type: 'string' },
            idempotencyKey: { type: 'string' },
            keySource: { type: 'string', enum: ['header', 'auto', 'window'] },
            status: ref('DeliveryStatus'),
            runId: { type: ['string', 'null'] },
            body: { type: ['string', 'null'] },
            detail: { type: ['string', 'null'] },
            ownerId: { type: 'string' },
            receivedAt: { type: 'integer' },
            firedAt: { type: ['integer', 'null'] },
            attempts: { type: 'integer' },
            availableAt: { type: 'integer' },
            claimedAt: { type: ['integer', 'null'] },
            lastError: { type: ['string', 'null'] },
            chainDepth: { type: 'integer' },
          },
          required: ['id', 'kind', 'name', 'orchestrationName', 'status'],
        },
        DeliveryStats: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            byStatus: {
              type: 'object',
              additionalProperties: { type: 'integer' },
            },
            queueDepth: {
              type: 'integer',
              description: 'Pending backlog (what the 429 cap sheds on).',
            },
            inFlight: { type: 'integer', description: 'Claimed by the worker.' },
            deadLetter: { type: 'integer', description: 'Failed deliveries.' },
            duplicatesSuppressed: {
              type: 'integer',
              description:
                'Idempotency-key replays absorbed by a winning delivery ' +
                '(the per-status `duplicate` bucket is structurally 0).',
            },
            firesLastMin: { type: 'integer' },
            firesLastHour: { type: 'integer' },
          },
          required: [
            'total',
            'byStatus',
            'queueDepth',
            'inFlight',
            'deadLetter',
            'duplicatesSuppressed',
            'firesLastMin',
            'firesLastHour',
          ],
        },
        Health: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            backend: {
              type: 'string',
              description: 'Run-store backend (e.g. sqlite, postgres).',
            },
            capabilities: {
              type: 'object',
              properties: {
                codeRun: {
                  type: 'boolean',
                  description: 'SAMMY_ALLOW_CODE_RUN gate state.',
                },
                store: { type: 'string', enum: ['ok', 'unreachable'] },
                agentTools: {
                  type: 'string',
                  enum: ['ok', 'failed', 'unknown'],
                },
              },
              required: ['codeRun', 'store', 'agentTools'],
            },
            ts: { type: 'integer', description: 'Epoch millis.' },
            error: {
              type: 'string',
              description: 'Present on the degraded fallback path.',
            },
          },
          required: ['status', 'backend', 'capabilities', 'ts'],
        },
        ObservabilityDigest: {
          type: 'object',
          properties: {
            totals: {
              type: 'object',
              properties: {
                runs: { type: 'integer' },
                done: { type: 'integer' },
                error: { type: 'integer' },
                cancelled: { type: 'integer' },
                inputTokens: { type: 'integer' },
                outputTokens: { type: 'integer' },
                costUsd: { type: 'number' },
              },
            },
            perOrchestration: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            perPhase: {
              type: 'array',
              description: 'Cost-descending phase rollups.',
              items: { type: 'object', additionalProperties: true },
            },
            daily: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            recent: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            branchCoverage: {
              type: 'array',
              description:
                'Per route/switch phase: how often each branch was taken.',
              items: { type: 'object', additionalProperties: true },
            },
          },
          required: [
            'totals',
            'perOrchestration',
            'perPhase',
            'daily',
            'recent',
            'branchCoverage',
          ],
        },
        CostDigest: {
          type: 'object',
          properties: {
            spend: {
              type: 'object',
              properties: {
                todayUsd: { type: 'number' },
                monthUsd: { type: 'number' },
              },
            },
            totals: {
              type: 'object',
              properties: {
                runs: { type: 'integer' },
                inputTokens: { type: 'integer' },
                outputTokens: { type: 'integer' },
                costUsd: { type: 'number' },
              },
            },
            perRun: {
              type: 'array',
              description: 'Most-expensive first.',
              items: { type: 'object', additionalProperties: true },
            },
            perPhase: {
              type: 'object',
              description: 'Keyed by runId → phase rows (cost-sorted).',
              additionalProperties: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
              },
            },
            ceilingTrips: {
              type: 'array',
              description:
                'Token-ceiling circuit-breaker trips (runaway agents aborted).',
              items: { type: 'object', additionalProperties: true },
            },
          },
          required: ['spend', 'totals', 'perRun', 'perPhase', 'ceilingTrips'],
        },
        ConcurrencyGroup: {
          type: 'object',
          properties: {
            group: { type: 'string' },
            held: {
              type: 'boolean',
              description:
                'Whether any active (running/paused — paused still holds) ' +
                'run holds the group, whoever owns it. A UI can say "busy" ' +
                'from this without learning whose.',
            },
            holder: {
              type: ['object', 'null'],
              description:
                'The oldest active run holding the group — present only ' +
                'when the caller owns that run; null otherwise, including ' +
                'while `held` is true.',
              properties: {
                runId: { type: 'string' },
                orchestration: { type: 'string' },
                status: ref('RunStatus'),
                heldSinceMs: { type: 'integer' },
              },
            },
            queued: {
              type: 'array',
              description: 'The caller’s own parked fires in FIFO drain order.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  orchestration: { type: 'string' },
                  ownerId: { type: 'string' },
                  queuedSinceMs: { type: 'integer' },
                },
              },
            },
            policy: {
              type: ['string', 'null'],
              enum: ['skip', 'queue', 'cancel-existing', null],
            },
          },
          required: ['group', 'held', 'holder', 'queued', 'policy'],
        },
        BudgetConfig: {
          type: 'object',
          description:
            'The caps. Global = workspace-wide spend; per-owner = any ONE ' +
            'owner’s spend. The two are independent: a per-owner cap never ' +
            'raises the global ceiling, and the ceiling never excuses an ' +
            'owner over their own cap.',
          properties: {
            dailyUsd: { type: ['number', 'null'] },
            monthlyUsd: { type: ['number', 'null'] },
            perOwnerDailyUsd: { type: ['number', 'null'] },
            perOwnerMonthlyUsd: { type: ['number', 'null'] },
          },
          required: ['dailyUsd', 'monthlyUsd', 'perOwnerDailyUsd', 'perOwnerMonthlyUsd'],
        },
        BudgetUpdate: {
          type: 'object',
          description: 'PUT /api/budget body — the global caps only.',
          properties: {
            dailyUsd: { type: ['number', 'null'] },
            monthlyUsd: { type: ['number', 'null'] },
          },
        },
        BudgetStatus: {
          type: 'object',
          properties: {
            dailyLimit: { type: ['number', 'null'] },
            monthlyLimit: { type: ['number', 'null'] },
            dailyUsed: { type: 'number', description: 'Workspace-wide, today.' },
            monthlyUsed: { type: 'number', description: 'Workspace-wide, this month.' },
            perOwnerDailyLimit: { type: ['number', 'null'] },
            perOwnerMonthlyLimit: { type: ['number', 'null'] },
            ownerDailyUsed: {
              type: 'number',
              description: 'The caller’s own spend today.',
            },
            ownerMonthlyUsed: {
              type: 'number',
              description: 'The caller’s own spend this month.',
            },
            blocked: {
              type: 'boolean',
              description: 'At or over 100% of any limit — new runs are refused.',
            },
            warning: {
              type: 'boolean',
              description: 'At or over 80% of any limit.',
            },
          },
          required: [
            'dailyLimit',
            'monthlyLimit',
            'dailyUsed',
            'monthlyUsed',
            'perOwnerDailyLimit',
            'perOwnerMonthlyLimit',
            'ownerDailyUsed',
            'ownerMonthlyUsed',
            'blocked',
            'warning',
          ],
        },
        AgentSlots: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
            inUse: { type: 'integer' },
            waiting: { type: 'integer' },
          },
          required: ['limit', 'inUse', 'waiting'],
        },
        AgentQueue: {
          type: 'object',
          properties: {
            limit: { type: 'integer' },
            inUse: { type: 'integer' },
            waiting: { type: 'integer' },
            queued: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', const: 'agent' },
                  runId: { type: ['string', 'null'] },
                  orchestrationName: { type: ['string', 'null'] },
                  phaseName: { type: ['string', 'null'] },
                  position: { type: 'integer' },
                  enqueuedAt: { type: 'integer' },
                  waitedMs: { type: 'integer' },
                  blockedBy: {
                    type: 'string',
                    const: 'agent-concurrency-cap',
                  },
                },
                required: ['id', 'position', 'enqueuedAt', 'waitedMs'],
              },
            },
          },
          required: ['limit', 'inUse', 'waiting', 'queued'],
        },
        OrchestrationNode: {
          type: 'object',
          description:
            'An orchestration node (see /api/schemas for the authoritative ' +
            'JSON schema). Reads carry a runtime-only `__origin` provenance ' +
            'tag (`imported` | `shipped`); PUT responses add advisory ' +
            '`warnings` (lint findings).',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            __origin: { type: 'string', enum: ['imported', 'shipped'] },
            warnings: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
          additionalProperties: true,
        },
        AgentFile: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            raw: { type: 'string', description: 'The agent’s markdown.' },
          },
          required: ['name', 'raw'],
        },
        SchemaFile: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { description: 'The JSON schema document.' },
          },
          required: ['name', 'content'],
        },
        VersionCommit: {
          type: 'object',
          properties: {
            sha: { type: 'string' },
            date: { type: 'string' },
            author: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['sha', 'date', 'author', 'message'],
        },
        AgentCard: {
          type: 'object',
          description:
            'An A2A agent card. Deprecated orchestrations are hidden from ' +
            'the root card’s skills. May carry a JWS `signatures` block ' +
            'when card signing is configured.',
          properties: {
            protocolVersion: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            url: { type: 'string' },
            skills: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
          additionalProperties: true,
        },
        JsonRpcRequest: {
          type: 'object',
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { type: ['string', 'number', 'null'] },
            method: {
              type: 'string',
              enum: [
                'message/send',
                'message/stream',
                'tasks/get',
                'tasks/cancel',
                'tasks/resubscribe',
                'tasks/pushNotificationConfig/set',
                'tasks/pushNotificationConfig/get',
              ],
            },
            params: {
              type: 'object',
              description:
                'Method-specific. message/*: {message: {parts, taskId?}, ' +
                'metadata?: {idempotencyKey?}}. tasks/*: {id}. ' +
                'pushNotificationConfig/set: {id, pushNotificationConfig: {url}}.',
              additionalProperties: true,
            },
          },
          required: ['jsonrpc', 'method'],
        },
        JsonRpcResponse: {
          type: 'object',
          description:
            'JSON-RPC 2.0 response. Exactly one of `result` (a Task object ' +
            'or method-specific payload) or `error` ({code, message}) is ' +
            'present. Protocol errors ride HTTP 200, per the spec.',
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { type: ['string', 'number', 'null'] },
            result: {},
            error: {
              type: 'object',
              properties: {
                code: { type: 'integer' },
                message: { type: 'string' },
              },
              required: ['code', 'message'],
            },
          },
          required: ['jsonrpc'],
        },
      },
    },
  };
}
