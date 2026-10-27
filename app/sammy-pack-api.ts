/**
 * Vite dev-server middleware that exposes the sammy-pack workspace
 * (examples/, agents/, context/) as a REST API. Edits in the UI write
 * through to the actual JSON / markdown files, so the CLI sees the
 * same state without any sync step.
 *
 * This is a dev-time bridge. The production app reads/writes through
 * connectors (GitHub, Bitbucket, ...) instead — see docs/architecture.md.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Connect, Plugin } from 'vite';
import * as cron from 'node-cron';
import {
  checkConsecutiveFailures,
  cronFailureThreshold,
  DEFAULT_LEASE_TTL_MS,
  derivePausedSinceMs,
  gateTtlAction,
  gateTtlMs,
  importLegacyRunFiles,
  openRunStore,
  runRetentionDays,
  sumCostUsd,
  sweepStaleGates,
  type RunStore,
} from './src/server/run-store';
import { decorateAuthError, streamSdk } from './src/server/sdk-stream';
import { DeliveryWorker } from './src/server/delivery-worker';
import {
  readMemory,
  writeMemory,
  listMemoryKeys,
  deleteMemory,
  isSafeMemoryKey,
} from './src/server/memory-store';
import { recordCorrection, deriveDecision } from './src/server/corrections-store';
import { verifySignature, NonceCache } from './src/server/webhook-auth';
import {
  describeProviderScheme,
  providerFromSigned,
  providerHeaders,
  verifyProviderSignature,
  type WebhookProvider,
} from './src/server/provider-signatures';
import { A2aIdempotencyCache } from './src/server/a2a-idempotency';
import { signAgentCard } from './src/llm/a2a-card-signing';
import { agentSlots, agentQueueSnapshot } from './src/llm/concurrency';
import {
  createJwksClient,
  verifyJwtHS256,
  verifyJwtRS256,
} from './src/server/jwt-verify';
import { isPlainName, makeLoadRunContext } from './src/server/run-context';
import { cleanupWorktrees, worktreeRoot } from './src/server/worktrees';
import {
  cloneDestination,
  cloneRepo,
  findLocalClone,
  isRepoUrl,
  normalizeRepoUrl,
  repoSearchRoots,
} from './src/server/repo-locate';
import {
  fireGateNotify,
  fireGateStaleNotify,
  fireTerminalNotify,
  isGatePause,
} from './src/server/notify';
import { orchestrationUsesCodeRun } from './src/llm/executor';
import {
  previewOrchestration,
  type PreviewFinding,
  type PreviewNode,
} from './src/llm/preview';
import { renderPlanText } from './src/llm/preview-render';
import { foldSpend, isSpendEvent } from './src/lib/spend';
import { computeDivergence } from './src/server/divergence';
import { computeRunNotes } from './src/server/run-notes';
import {
  concurrencyOf,
  decideConcurrency,
  DurableGroupLock,
  effectiveConcurrency,
  isGroupTemplate,
  GroupLock,
} from './src/server/concurrency-group';
import { cronWallClockBucket } from './src/server/cron-bucket';
import {
  destroyAllPollers,
  destroyPollersFor,
  pollTaskName,
  registerPoller,
} from './src/server/poll-registry';
import {
  computeRequestChangesInvalidation,
  feedbackTargetKey,
  terminalFailureForGate,
} from './src/server/gate-invalidation';
import { artifactLoaderFor, createRunRunner } from './src/server/run-runner';
import {
  pendingWaitOf,
  sweepDueWaits,
} from './src/server/wait-resolution';
import { installProcessGuards } from './src/server/process-guards';
import {
  cancel as cancelServerRun,
  getPushNotification,
  isActive as isActiveServerRun,
  resume as resumeServerRun,
  setPushNotification,
  startRun as startServerRun,
  subscribe as subscribeServerRun,
} from './src/server/run-controller';
import {
  credentialDestinationChange,
  credentialVisibleTo,
  isMaskOf,
  maskCredentialEntry,
  maskSecretsDeep,
  readCredentials,
  readCredentialsByNameRaw,
  reconcileMaskedDeep,
  reconcileMaskedEntry,
  resolveCredentialsFile,
  writeCredentials,
  type Credential,
  type CredentialsConfig,
} from './src/server/credentials-store';
import { resolveInputs, type InputValue } from './src/server/input-resolver';
import { KIND_REGISTRY } from './src/store/kindRegistry';
import {
  describeTrigger as describeTriggerKind,
  getTriggerKind,
} from './src/trigger-kinds';
import {
  WEBHOOK_PROVIDER_NAMES,
  type Node,
  type OrchestrationConcurrency,
  type Trigger,
} from './src/types';
import { validateOrchestration, lintOrchestration } from './src/validate';
import {
  extractFromUpload,
  extractFromFolder,
  type FolderFile,
} from './src/server/file-extractor';
import {
  applyMatchesToOrchestration,
  matchAgents,
} from './src/server/agent-matcher';
import {
  buildOtlpTrace,
  otlpTracesUrl,
  pushOtlpTrace,
} from './src/server/otlp-trace';
import {
  buildMetricsText,
  METRICS_RUN_SCAN_LIMIT,
} from './src/server/metrics';
import { buildOpenApiDoc } from './src/server/openapi';
import {
  loadBudgetState,
  readBudgetConfig,
  writeBudgetConfig,
  type BudgetStatus,
} from './src/server/budget-store';
import {
  buildOrchestrationCard,
  buildRootCard,
  partsToText,
  type A2aMessage,
  type JsonRpcRequest,
} from './src/llm/a2a';
import {
  A2A_ERROR,
  buildTaskFromRun,
  jsonRpcError,
  jsonRpcResult,
  runEventToA2aStreamEvent,
} from './src/server/a2a-inbound';
/** A2A "TaskNotCancelableError" (spec code -32002) — the task is already
 *  terminal. Belongs in the `A2A_ERROR` table beside `taskNotFound`; kept
 *  local until that table gains it. */
const A2A_TASK_NOT_CANCELABLE = -32002;
import {
  buildHealth,
  codeRunAllowlist,
  codeRunEnabled,
  codeRunMode,
  getCachedAgentTools,
  probeAgentTools,
  probeStore,
  setCachedAgentTools,
} from './src/server/health';
import {
  envEnum,
  envFlag,
  envIsSet,
  envIsSetButInvalid,
  envList,
  envPositiveInt,
} from './src/server/env';
import {
  checkImportSource,
  importRoots,
  isInside,
  resolvesToDeniedFile,
} from './src/server/import-roots';
import { scrubDeep, scrubEvent, scrubSecrets } from './src/server/scrub-secrets';
import {
  describeScrub,
  NON_JSON_PLACEHOLDER,
  scrubPayload,
} from './src/server/payload-scrub';
import {
  admitDelivery,
  BUDGET_RECHECK_MS,
  calendarWindow,
  checkLimits,
  IntakePauseStore,
  isScheduleKind,
} from './src/server/admission';
import {
  claimAtPath,
  effectiveRole,
  roleAllowsMethod,
  rolesConfigured,
} from './src/server/roles';

type Json = unknown;

export function repoRoot(viteRoot: string): string {
  // SAMMY_REPO_ROOT names the workspace for every entry point. serve.ts maps
  // it onto a Vite-style root and the worker reads it directly; the Vite dev
  // server passes its real root, so without this check it silently opened the
  // checkout's own run store and triggers instead of the named workspace.
  if (process.env.SAMMY_REPO_ROOT) return path.resolve(process.env.SAMMY_REPO_ROOT);
  // viteRoot is .../sammy-pack/app/web → repo root is two levels up.
  return path.resolve(viteRoot, '..', '..');
}

/** Absolute base URL for the current request — used to build A2A agent
 *  cards with reachable endpoint URLs. */
function baseUrlFromReq(req: Connect.IncomingMessage): string {
  const raw = req.headers.host;
  const host = (Array.isArray(raw) ? raw[0] : raw) ?? 'localhost:5173';
  return `http://${host}`;
}

/** Multi-tenancy seam — pull the owner id from `X-Sammy-User`. When
 *  unset, the request runs under the single-tenant default 'system'.
 *  This is the foundation for per-user scoping; a real auth layer
 *  (JWT / OAuth) would replace the raw header with verified identity. */
function extractOwnerId(req: Connect.IncomingMessage): string {
  const raw = req.headers['x-sammy-user'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof v === 'string' ? v.trim() : '';
  return trimmed || 'system';
}

/** Human-readable refusal message when a run is blocked by a spend cap.
 *  Names the cap that bit, with ITS figures: the global ceiling and the
 *  per-owner cap are measured against different spend and raised by
 *  different settings, and the message used to print the global pair for
 *  both — an owner over their own cap saw workspace numbers nowhere near
 *  the limit and a remedy that did not apply. */
function budgetBlockedMessage(s: BudgetStatus): string {
  const fmt = (used: number, limit: number | null) =>
    limit != null
      ? `$${used.toFixed(2)} / $${limit.toFixed(2)}`
      : `$${used.toFixed(2)} (no cap)`;
  const named: Record<import('./src/server/budget-store').BudgetCap, string> = {
    daily: `the workspace daily cap (today: ${fmt(s.dailyUsed, s.dailyLimit)})`,
    monthly: `the workspace monthly cap (this month: ${fmt(s.monthlyUsed, s.monthlyLimit)})`,
    ownerDaily: `this owner's daily cap (your spend today: ${fmt(s.ownerDailyUsed, s.perOwnerDailyLimit)})`,
    ownerMonthly: `this owner's monthly cap (your spend this month: ${fmt(s.ownerMonthlyUsed, s.perOwnerMonthlyLimit)})`,
  };
  const breached = s.breached.length > 0 ? s.breached : (['daily', 'monthly'] as const);
  const perOwnerOnly = breached.every(c => c === 'ownerDaily' || c === 'ownerMonthly');
  return (
    `Budget cap reached — run refused: ${breached.map(c => named[c]).join('; ')}. ` +
    (perOwnerOnly
      ? 'Raise the per-owner cap in Settings (perOwnerDailyUsd / ' +
        'perOwnerMonthlyUsd), or wait for the period to reset.'
      : 'Raise the cap in Settings, or wait for the period to reset.')
  );
}

async function readJsonFile(file: string): Promise<Json | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Thrown by `readBodyBuffer` when a request body exceeds the cap. Tagged
 *  so the trigger ingress can answer 413 instead of a generic 400. */
class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
  constructor(readonly limit: number) {
    super(`request body exceeds the ${limit}-byte limit`);
  }
}

/** Cap on any request body this server will buffer. The trigger ingress is
 *  reachable UNAUTHENTICATED (a signature can only be checked once the body
 *  has been read), so without a cap a single POST can make the server
 *  buffer unbounded data in memory before anything gets a chance to reject
 *  it. 5 MiB clears real webhook payloads — a GitHub push event with a long
 *  commit list is tens of KB — with room to spare. */

const maxBodyBytes = (): number =>
  envPositiveInt('SAMMY_MAX_BODY_BYTES', 5 * 1024 * 1024);

/** Timeout for a polling trigger's outbound fetch. Separate from
 *  MAX_BODY_BYTES because this bounds TIME, not size: the polling tick
 *  re-arms itself only in its own `finally`, so a fetch that never settles
 *  silently retires that trigger for the life of the process. */
const pollFetchTimeoutMs = (): number =>
  envPositiveInt('SAMMY_POLL_TIMEOUT_MS', 30_000);

/** Cap on a polled response body. A polling `source` is an arbitrary
 *  external URL whose body becomes a run's initial input and is written
 *  whole into the delivery row, so an unbounded `r.text()` is a DoS vector
 *  reachable by whoever controls that URL. */
const pollMaxBodyBytes = (): number =>
  envPositiveInt('SAMMY_POLL_MAX_BODY_BYTES', 1024 * 1024);

/** Read a fetch Response's body as text, stopping at POLL_MAX_BODY_BYTES.
 *  Streams rather than buffering so an endless response cannot exhaust
 *  memory before the limit is noticed. Returns what was read, truncated,
 *  and logs — truncating loudly beats either OOM or silent corruption. */
async function readCappedText(
  res: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  source: string,
  orchName: string,
): Promise<string> {
  if (!res.body) return res.text();
  const limit = pollMaxBodyBytes();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        // Keep the prefix that fits. Dropping the whole chunk instead would
        // return an EMPTY body whenever the very first chunk already exceeds
        // the cap (the usual case for a large response), and an empty body
        // reads as "no change" — so an oversized source would silently never
        // fire rather than firing truncated.
        const keep = limit - (size - value.byteLength);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Release the connection whether we finished or bailed out early.
    await reader.cancel().catch(() => {});
  }
  if (truncated) {
    console.warn(
      `[sammy-pack-api] poll ${orchName}: ${source} response exceeded ` +
        `${limit} bytes — truncated`,
    );
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/** Read a request body as RAW BYTES, bounded by `MAX_BODY_BYTES`.
 *
 *  Signature verification must hash these bytes, not a decoded string:
 *  `buf.toString('utf8')` replaces every byte sequence that isn't valid
 *  UTF-8 with U+FFFD, so re-encoding yields different bytes and a genuinely
 *  signed delivery fails to verify. See `bodyBytes` in webhook-auth.ts. */
async function readBodyBuffer(req: Connect.IncomingMessage): Promise<Buffer> {
  const limit = maxBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // Stop ACCUMULATING but keep draining. Destroying the socket here
        // instead would be the obvious move and is wrong: it tears the
        // connection down before the 413 can be written, so the caller sees
        // a transport error (EPIPE) and never learns why. Memory is what
        // needed bounding, and dropping the chunks bounds it.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLargeError(limit));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString('utf8');
}

/** `gh auth token` — the GitHub CLI's login on this machine, or null — for
 *  a github input when no GitHub connection is configured, the way a person
 *  at this terminal reads a private issue. It is the OPERATOR's identity, so
 *  by default it is used only when the server has no per-user identity
 *  (no JWT verifier, no read-only roles): a single-user install.
 *  SAMMY_GH_CLI_FALLBACK=1 / =0 forces it on / off. Cached for a minute. */
let ghTokenCache: { at: number; token: string | null } | null = null;
function ghFallbackAllowed(): boolean {
  const flag = process.env.SAMMY_GH_CLI_FALLBACK?.trim();
  if (flag) return /^(1|true|yes|on)$/i.test(flag);
  const multiUser =
    !!process.env.SAMMY_JWT_SECRET?.trim() ||
    !!process.env.SAMMY_JWT_PUBLIC_KEY?.trim() ||
    !!process.env.SAMMY_JWKS_URI?.trim() ||
    !!process.env.SAMMY_READONLY_USERS?.trim();
  return !multiUser;
}
async function ghCliToken(): Promise<string | null> {
  if (!ghFallbackAllowed()) return null;
  if (ghTokenCache && Date.now() - ghTokenCache.at < 60_000) return ghTokenCache.token;
  const token = await new Promise<string | null>(resolve => {
    execFile('gh', ['auth', 'token'], { timeout: 3_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim() || null),
    );
  });
  ghTokenCache = { at: Date.now(), token };
  return token;
}

function sendJson(
  res: import('node:http').ServerResponse,
  status: number,
  body: Json,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

function sendError(
  res: import('node:http').ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}

/**
 * Wrap an async mounted handler so a REJECTION cannot leave the request
 * unanswered.
 *
 * connect's `call()` wraps only the synchronous invocation in a try/catch, so
 * a rejected promise never reaches `next(err)`: nothing is written, the socket
 * and its `ServerResponse` stay pinned for the life of the process, and
 * `server.close()` then never completes — SIGKILL becomes the only exit,
 * which is exactly the path that strands `running` rows until their lease
 * expires. `installProcessGuards()` logs `unhandledRejection` and deliberately
 * does not exit, so every status surface stays healthy while the caller hangs.
 *
 * A handler whose own `try` covers its whole body does not need this. It is
 * for the ones where something throws ABOVE that `try` — a `new URL` on an
 * absolute-form request target, or an `await store.*` that rejects under
 * SQLITE_BUSY / a Postgres statement timeout, i.e. exactly when an operator is
 * reaching for the cancel lever.
 *
 * Typed to the 3-arg shape on purpose: connect selects ERROR middleware by
 * `handle.length === 4`, so wrapping one would silently de-register it.
 * Mid-stream (SSE already has its headers) the only honest answer is to end
 * the response — writing a 500 head over a live stream would be a new defect.
 */
function answered(
  handler: (
    req: Connect.IncomingMessage,
    res: import('node:http').ServerResponse,
    next: Connect.NextFunction,
  ) => unknown,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req as Connect.IncomingMessage, res, next))
      .catch((err: unknown) => {
        console.error(
          `[sammy-pack-api] unanswered handler rejection: ${req.method} ${req.url}`,
          err,
        );
        if (res.headersSent) return res.end();
        return sendError(res, 500, (err as Error).message);
      });
  };
}

/**
 * Sanitize a filename segment to prevent path traversal.
 * Accepts alphanumerics, dashes, underscores. Rejects everything else.
 */
function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/** SDK permission modes, least → most permissive. The /api/llm/stream
 *  gate compares a requested mode against the operator's by rank: a caller
 *  may always narrow (ask for `plan`), never widen. */
const STREAM_PERMISSION_RANK = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
} as const;
type StreamPermissionMode = keyof typeof STREAM_PERMISSION_RANK;
/** The same modes by name, for the `envEnum` reader of
 *  `SAMMY_LLM_STREAM_PERMISSION_MODE` (resolved once, at mount). */
const STREAM_PERMISSION_MODES = Object.keys(
  STREAM_PERMISSION_RANK,
) as StreamPermissionMode[];

/** Would `requested` widen permissions beyond `operator`? Unknown strings
 *  count as an escalation — refuse what cannot be ranked. */
function escalatesPermissionMode(
  requested: string | undefined,
  operator: StreamPermissionMode,
): boolean {
  if (requested === undefined) return false;
  if (!Object.prototype.hasOwnProperty.call(STREAM_PERMISSION_RANK, requested)) {
    return true;
  }
  return (
    STREAM_PERMISSION_RANK[requested as StreamPermissionMode] >
    STREAM_PERMISSION_RANK[operator]
  );
}

/** Parse `SAMMY_NOTIFY_ALLOWED_HOSTS` — the hosts an A2A caller may register
 *  as a push-notification webhook. Comma/space separated hostnames
 *  (optionally `host:port`), compared case-insensitively. EMPTY = refuse all:
 *  the webhook receives every event of the run (phase output included), so
 *  "any URL the caller names" is an exfiltration channel by construction, and
 *  the safe default is the one an operator has to turn on. */
function notifyAllowedHosts(): string[] {
  return envList('SAMMY_NOTIFY_ALLOWED_HOSTS').map(h => h.toLowerCase());
}

/** Drop an absolute-form request target's `scheme://authority`
 *  (`GET http://host/api/triggers/x`), detected EXACTLY as connect detects
 *  it — `getProtohost` in connect/index.js: a target that does not start with
 *  `/` and carries a `://` before any `?`, up to the first `/` after it.
 *  connect strips a mount by LENGTH from after that prefix, so it survives
 *  into the mount-relative `req.url` every gate reads; matching its rule
 *  rather than approximating one is what keeps the gates' view and connect's
 *  routing from parting company over an odd scheme. */
function stripProtohost(u: string): string {
  if (u.length === 0 || u[0] === '/') return u;
  const fqdn = u.indexOf('://');
  if (fqdn === -1 || u.lastIndexOf('?', fqdn) !== -1) return u;
  const slash = u.indexOf('/', fqdn + 3);
  return slash === -1 ? '/' : u.slice(slash);
}

/** The mount-stripped `req.url` as the ONE path every gate classifies on.
 *
 *  The gates read `req.url` raw — `startsWith`, a `^`-anchored regex — while
 *  the ingress handlers re-parse it with `new URL(...)`, so two spellings
 *  made gate and handler disagree about what a FIRE is: an absolute-form
 *  target (no classifier matched it, so the gates saw a plain read and the
 *  identity strip never ran) and `/triggers//<x>/<hook>`, whose empty
 *  segment `INGRESS_FIRE` cannot match while the handler's `new URL` reads
 *  `//<x>/<hook>` as protocol-relative and fires the hook. Both are a fire
 *  here.
 *
 *  Deliberately string-only: it never percent-decodes and never resolves a
 *  `.`/`..` segment, both of which SHORTEN a path. connect's mount matching
 *  resolves neither, so classifying the shortened form would hand
 *  `/api/<resource>/../livez` the `/livez` read EXEMPTION while the
 *  resource's own handler answers it. */
function gatePath(u: string | undefined): string {
  const p = stripProtohost(u ?? '/')
    .split('#')[0]
    .split('?')[0]
    .replace(/\/{2,}/g, '/');
  return p || '/';
}

/** Why a mount-stripped `/api` request path is NOT already canonical, or
 *  null when it is — the reason, so the refusal can name what is wrong.
 *
 *  Two parsers read every /api path: the gates classify `gatePath()`'s
 *  string, the handlers re-parse `req.url` with `new URL`, which resolves
 *  the dot segments `gatePath` deliberately does not. Two parsers in one
 *  request path can only be made to agree by admitting ONE spelling.
 *  Classifying each odd spelling is a denylist the next spelling walks
 *  around — case, duplicate slashes, the absolute form, and connect's `.`
 *  mount boundary (which reaches a handler as a REAL fire while no
 *  classifier calls it one) are each their own spelling. Resolving here is
 *  not an option either: it SHORTENS a path, which would hand
 *  `/api/<resource>/../livez` the probe exemption. So a non-canonical path
 *  is REFUSED above every gate instead, and after that there is nothing for
 *  the two parsers to disagree about.
 *
 *  Canonical means: no empty segment (a trailing slash is the one exception),
 *  no `.`/`..` segment in any spelling the WHATWG parser resolves (`%2e` is
 *  one), no segment ending in `.` and no `/api/<ingress-kind>.` — both of
 *  those are connect's `.` mount boundary — no backslash, and no encoded
 *  separator. Nothing a real client sends: the UI and the CLI build their
 *  paths from segments. */
/**
 * True when the RAW request target is one the handlers' own
 * `new URL(req.url, 'http://localhost')` cannot parse.
 *
 * That throw lands inside an async handler, so connect never sees it,
 * nothing is written, and the socket plus its `ServerResponse` leak for the
 * process lifetime — the same unanswered-request class as a decode above a
 * handler's `try`, but reachable unauthenticated on EVERY route. The target
 * that does it is an absolute form with an unbalanced bracket
 * (`GET http://[/api/credentials`): connect's mount match leaves `[` glued
 * to the authority, and no parser can read the result. Refusing it costs
 * nothing — a string none of them can parse cannot address a resource.
 *
 * Takes the raw `req.url`, not the stripped path: stripping the protohost
 * is exactly what hides the broken authority.
 */
function unparseableTarget(raw: string): boolean {
  try {
    new URL(raw, 'http://localhost');
    return false;
  } catch {
    return true;
  }
}

function nonCanonicalPathReason(p: string): string | null {
  if (/%2f/i.test(p)) return 'an encoded "/" (%2F)';
  if (p.includes('\\') || /%5c/i.test(p)) return 'a backslash';
  const segments = p.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    // A trailing slash is the only empty segment a canonical path carries.
    if (segments[i] === '') {
      if (i === segments.length - 1) continue;
      return 'an empty path segment ("//")';
    }
    const decoded = segments[i].replace(/%2e/gi, '.');
    if (decoded === '.' || decoded === '..') return `a "${decoded}" segment`;
    if (decoded.endsWith('.')) return 'a path segment ending in "."';
  }
  // connect borders a mount on `.` as well as `/`, so `/api/triggers.<rest>`
  // is ROUTED to the `/api/triggers` mount with `.<rest>` as its remainder —
  // a second spelling of a fire that no `^/<kind>/` classifier can match.
  // These four are the mounts whose handlers re-parse their own remainder,
  // and no route answers the dotted spelling, so it is refused rather than
  // classified.
  if (/^\/(?:triggers|events|deploy|queue)\./i.test(p)) {
    return 'an ingress mount spelled with connect\'s "." boundary';
  }
  return null;
}

/** The ingress paths that FIRE a trigger — a name segment after the kind —
 *  as opposed to the bare kind lists, which are reads. One regex, shared by
 *  the cross-site guard and the role gate, so the two cannot disagree about
 *  what a fire is. A fire starts a run whatever its HTTP method: the
 *  webhook shape allows `method: 'GET'`.
 *
 *  CASE-INSENSITIVE, as are the two path predicates below. connect matches a
 *  mount prefix case-insensitively and strips it by LENGTH, so
 *  `GET /API/TRIGGERS/<hook>` reaches the `/api/triggers` handler with
 *  `req.url` = `/TRIGGERS/<hook>` — and a case-sensitive classifier here saw
 *  a plain read: the cross-site guard and the role gate both let the fire
 *  through for four upper-cased characters. Every gate classifies on the
 *  folded path; the handlers still look the hook up by its exact name. */
const INGRESS_FIRE = /^\/(?:triggers|events|deploy|queue)\/[^/?]+/i;

/** Any ingress path (fires AND the bare kind lists), on the `gatePath()` of
 *  the mount-stripped `/api` url — as is INGRESS_FIRE above and isProbePath
 *  below.
 *
 *  Used where the whole surface is meant, not the fire: the cross-site
 *  guard's content-type exemption (a sender posts whatever type its provider
 *  chose). The two AUTH gates exempt `INGRESS_FIRE` only — a bare kind list
 *  is a read, and on the prefix the exemption answered the whole trigger
 *  inventory anonymously under gated reads. */
function isIngressPath(p: string): boolean {
  const l = p.toLowerCase();
  return (
    l.startsWith('/triggers') ||
    l.startsWith('/events') ||
    l.startsWith('/deploy') ||
    l.startsWith('/queue')
  );
}

/** The liveness / readiness / health probes, the only reads exempt when
 *  reads are gated. Listed explicitly rather than falling out of a method
 *  check, so the exemption is a visible decision. */
function isProbePath(p: string): boolean {
  const l = p.toLowerCase();
  return l.startsWith('/livez') || l.startsWith('/readyz') || l.startsWith('/health');
}

/** Does the Authorization header carry exactly the static api token?
 *  Compared in constant time: `===` short-circuits on the first differing
 *  byte, and the token is the admin secret — over a network a weak oracle,
 *  but an oracle. Both sides are hashed first so the comparison runs over
 *  equal-length buffers whatever the lengths of the inputs. */
function bearerMatchesToken(
  header: string | undefined,
  token: string,
): boolean {
  if (typeof header !== 'string') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}

/** An orchestration snapshot as the API SHIPS it: the bare tree, without the
 *  `__pinned` closure (every raw agent body + subflow tree the run can
 *  reach — 150x the tree on a real orchestration). The closure exists for
 *  RESUME, which reads the store directly; no API consumer uses it, and two
 *  UI pollers fetch the whole run list every few seconds. The store keeps
 *  the closure untouched. */
function bareSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return snapshot;
  }
  const tree = { ...(snapshot as Record<string, unknown>) };
  delete tree.__pinned;
  return tree;
}

/** Null when `url` is an http(s) URL whose host is allowlisted; otherwise
 *  the reason it is refused, for the JSON-RPC error. */
function pushUrlRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'pushNotificationConfig.url must be an absolute http(s) URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'pushNotificationConfig.url must be an absolute http(s) URL';
  }
  const allowed = notifyAllowedHosts();
  if (allowed.length === 0) {
    return (
      'push notifications are disabled: SAMMY_NOTIFY_ALLOWED_HOSTS is empty. ' +
      'Set it to a comma-separated list of webhook hostnames to permit ' +
      'registration.'
    );
  }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (!allowed.includes(host) && !allowed.includes(hostname)) {
    return (
      `pushNotificationConfig.url host "${parsed.host}" is not in ` +
      'SAMMY_NOTIFY_ALLOWED_HOSTS'
    );
  }
  return null;
}

/**
 * Link an imported file into the local workspace, cross-platform.
 *
 * Symlinks read live (edits to the source propagate), which is the
 * preferred import behavior. But on Windows `fs.symlink` to a file
 * needs Developer Mode or admin and otherwise throws EPERM/EACCES;
 * some filesystems also reject it (EXDEV/ENOSYS/UNKNOWN). In those
 * cases fall back to a real copy so the import still succeeds — the
 * caller surfaces which mode was used so the user knows whether live
 * edits propagate. On macOS/Linux the symlink always succeeds, so the
 * fallback never runs and behavior is unchanged.
 *
 * Returns 'symlink' or 'copy'.
 */
async function linkOrCopy(src: string, target: string): Promise<'symlink' | 'copy'> {
  try {
    await fs.symlink(src, target);
    return 'symlink';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EXDEV' || code === 'ENOSYS' || code === 'UNKNOWN') {
      await fs.copyFile(src, target);
      return 'copy';
    }
    throw err;
  }
}

// Re-export the shared agent-name helpers so the existing test imports
// continue to work without changes.
export {
  deriveAgentName,
  shouldSkipAgentDir,
  shouldSkipAgentFile,
} from './src/lib/agentName';
import {
  deriveAgentName as _deriveAgentName,
  shouldSkipAgentDir as _shouldSkipAgentDir,
  shouldSkipAgentFile as _shouldSkipAgentFile,
} from './src/lib/agentName';

/**
 * Walk a directory for .md agent files. Skips README.md, COMPONENT.md,
 * hidden files, and `_`-prefixed dirs (a common convention for
 * templates / shared utilities that shouldn't be treated as agents).
 */
async function scanAgentDir(
  root: string,
  recursive: boolean,
): Promise<Array<{ suggestedName: string; sourcePath: string; preview: string }>> {
  const out: Array<{ suggestedName: string; sourcePath: string; preview: string }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (_shouldSkipAgentDir(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive || depth === 0) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (_shouldSkipAgentFile(e.name)) continue;

      const relDir = path.relative(root, dir);
      const suggestedName = _deriveAgentName(relDir, e.name);
      if (!suggestedName) continue;

      const raw = await fs.readFile(full, 'utf8').catch(() => '');
      const preview = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
      out.push({ suggestedName, sourcePath: full, preview });
    }
  }
  await walk(root, 0);
  // Stable sort for deterministic UI
  out.sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
  return out;
}

/**
 * Build a synthetic orchestration from extracted file content. Used
 * by /api/orchestrations/from-file's dryRun mode so the rest of the
 * pipeline (agent-matcher → UI preview → save) can be exercised
 * without a real LLM call.
 *
 * The shape mirrors what the orchestration-designer agent would
 * emit in the simplest case: a flat phases array where each
 * extracted node becomes a phase pointing at agents/<node-name>.md.
 * If the file isn't a parseable graph (e.g. an image or plain
 * text), emit a single placeholder phase so the matcher path is
 * still exercised.
 */
function buildStubFromExtracted(
  filename: string,
  blocks: import('./src/server/file-extractor').ContentBlock[],
): import('./src/types').Node {
  const baseName = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '') || 'stub';
  const orchName = `${baseName}-dryrun`;
  // Try to pull phase names out of the parsed-graph text blocks
  // (drawio + excalidraw both emit "Nodes (N):\n  - id: \"label\"").
  const phaseNames: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    const matches = b.text.matchAll(/^\s*-\s+\S+:\s*"([^"]+)"/gm);
    for (const m of matches) {
      const label = (m[1] ?? '').trim();
      if (!label) continue;
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (slug && !phaseNames.includes(slug)) phaseNames.push(slug);
    }
  }
  if (phaseNames.length === 0) {
    return {
      name: orchName,
      phases: [
        {
          name: 'extracted',
          agent: 'agents/dryrun-stub.md',
        },
      ],
    };
  }
  return {
    name: orchName,
    phases: phaseNames.map(n => ({ name: n, agent: `agents/${n}.md` })),
  };
}

/**
 * Shared designer-call path behind BOTH the from-file and from-folder
 * endpoints. Given already-extracted content blocks (text + image) and
 * a short source label, it:
 *
 *   1. loads agents/orchestration-designer.md (system prompt) and
 *      substitutes the {{AVAILABLE_AGENTS}} list,
 *   2. assembles the SDK user-message (instruction + every block),
 *   3. on dryRun, builds a stub orchestration from the blocks (no SDK),
 *   4. otherwise streams the designer, strips fences, parses the JSON,
 *   5. matches every declared agent path against the workspace and
 *      rewrites near-misses to canonical paths.
 *
 * Returns a discriminated result so each endpoint maps it to an HTTP
 * status. Both endpoints stay lean — this is the only copy of the
 * designer wiring.
 */
type DesignerOk = {
  ok: true;
  orchestration: import('./src/types').Node;
  agentMatchReport: ReturnType<typeof matchAgents>;
  summary: string;
  dryRun?: boolean;
};
type DesignerErr = { ok: false; status: number; message: string };

async function runOrchestrationDesigner(
  agentsDir: string,
  extracted: {
    blocks: import('./src/server/file-extractor').ContentBlock[];
    summary: string;
  },
  /** Short human label for the source — "spec.md (text · 2 KB)" or a
   *  folder descriptor — woven into the designer's instruction block. */
  sourceLabel: string,
  opts: {
    dryRun?: boolean;
    /** Used to name the dry-run stub orchestration. */
    stubName: string;
    abortController?: AbortController;
  },
): Promise<DesignerOk | DesignerErr> {
  const designerRaw = await fs
    .readFile(path.join(agentsDir, 'orchestration-designer.md'), 'utf8')
    .catch(() => null);
  if (!designerRaw) {
    return {
      ok: false,
      status: 500,
      message:
        'Missing agents/orchestration-designer.md. Re-pull the workspace or create one manually.',
    };
  }
  const frontmatterStrip = designerRaw.match(
    /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/,
  );
  const designerBody = (
    frontmatterStrip ? frontmatterStrip[1] : designerRaw
  ).trim();

  // Build the AVAILABLE_AGENTS list — same shape GenerateFromSpecModal
  // builds client-side.
  const agentEntries = await fs.readdir(agentsDir).catch(() => [] as string[]);
  const availableAgents: Array<{ name: string; description: string }> = [];
  for (const f of agentEntries) {
    if (!f.endsWith('.md')) continue;
    if (f.toLowerCase() === 'readme.md') continue;
    const raw = await fs
      .readFile(path.join(agentsDir, f), 'utf8')
      .catch(() => null);
    if (raw === null) continue;
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const desc =
      fm?.[1].match(/^description:\s*(.+?)$/m)?.[1]?.trim() ??
      raw
        .split('\n')
        .find(l => l.trim() && !l.startsWith('---'))
        ?.slice(0, 120) ??
      '';
    availableAgents.push({ name: f.replace(/\.md$/, ''), description: desc });
  }
  const agentList = availableAgents
    .filter(a => a.name !== 'orchestration-designer')
    .map(a => `- agents/${a.name}.md — ${a.description}`)
    .join('\n');
  const designerSystemPrompt = designerBody.replace(
    '{{AVAILABLE_AGENTS}}',
    agentList || '(none)',
  );

  // Convert extracted content blocks into SDK prompt blocks.
  const promptBlocks: Array<
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      }
  > = [
    {
      type: 'text',
      text:
        `You're being given a diagram, PRD, or spec describing an agent ` +
        `orchestration. Source: ${sourceLabel}. ` +
        `Extract the structure into a sammy-pack orchestration ` +
        `following the schema you know. Reference existing agents ` +
        `from the list when phase labels match (case-insensitive); ` +
        `for unmatched labels, emit \`agents/<kebab-name>.md\` and ` +
        `we'll surface them as "needs generation" in the UI. ` +
        `Emit ONLY the orchestration JSON — no markdown, no prose.`,
    },
  ];
  for (const b of extracted.blocks) {
    if (b.type === 'text') {
      promptBlocks.push({ type: 'text', text: b.text });
    } else {
      promptBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: b.mediaType, data: b.base64 },
      });
    }
  }

  const availableNames = availableAgents.map(a => a.name);

  // Dry-run: build a stub from the extracted blocks, run it through the
  // same agent-matcher, return. No SDK call.
  if (opts.dryRun) {
    const stub = buildStubFromExtracted(opts.stubName, extracted.blocks);
    const report = matchAgents(stub, availableNames);
    const corrected = applyMatchesToOrchestration(stub, report);
    return {
      ok: true,
      orchestration: corrected,
      agentMatchReport: report,
      summary: extracted.summary,
      dryRun: true,
    };
  }

  // Collect the designer's streaming output.
  const abortController = opts.abortController ?? new AbortController();
  let accum = '';
  try {
    for await (const chunk of streamSdk({
      userMessage: promptBlocks,
      systemPrompt: designerSystemPrompt,
      model: 'claude-sonnet-4-6',
      abortController,
    })) {
      if (chunk.type === 'text-delta') accum += chunk.text;
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return { ok: false, status: 502, message: decorateAuthError(message) };
  }

  // Strip any markdown fences the model may have added, then parse.
  const cleaned = accum
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  let orchestration: import('./src/types').Node;
  try {
    orchestration = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `Designer didn't return valid JSON: ${(err as Error).message}. Output starts with: "${cleaned.slice(0, 200)}…"`,
    };
  }

  const report = matchAgents(orchestration, availableNames);
  const corrected = applyMatchesToOrchestration(orchestration, report);
  return {
    ok: true,
    orchestration: corrected,
    agentMatchReport: report,
    summary: extracted.summary,
  };
}

/**
 * The subset of a Vite dev server the API mounting actually uses: a
 * connect-style middleware stack, the repo root, and the http server (for a
 * shutdown hook). Both Vite's `ViteDevServer` and the standalone production
 * server (`serve.ts`) satisfy this, so the identical API surface — REST,
 * triggers, SSE, A2A — mounts under `vite dev` and under a real server.
 */
export type MountServer = {
  middlewares: Connect.Server;
  config: { root: string };
  httpServer?: { once(event: string, listener: () => void): unknown } | null;
};

/**
 * Mount the full sammy-pack API onto a connect-style middleware stack. This is
 * the entire former Vite-plugin `configureServer` body, lifted verbatim so a
 * standalone server can serve the exact same surface (see `serve.ts`). The Vite
 * plugin below is now a thin wrapper that calls this.
 */
export async function mountSammyApi(
  server: MountServer,
  deps?: {
    /** Pre-opened run store. Defaults to `openRunStore(root)`. Injectable so a
     *  test can pass a directly-constructed store (the boot's `openRunStore`
     *  uses a dynamic import that the jest runtime can't resolve). */
    store?: RunStore;
  },
): Promise<void> {
      // Resilience: swallow client-disconnect socket errors (EPIPE /
      // ECONNRESET) so a client that aborts mid-response (e.g. a UI poll or a
      // timed-out curl against the heavy GET /api/runs) can't crash the whole
      // process and take in-flight runs down with it. Idempotent — safe under
      // the Vite plugin (this mount) and the standalone serve.ts alike.
      installProcessGuards();
      const root = repoRoot(server.config.root);
      const examplesDir = path.join(root, 'examples');
      const agentsDir = path.join(root, 'agents');
      // Workspace context loader — extracted to src/server/run-context.ts so
      // the standalone worker loads the same context (executor-in-worker,
      // step 1). Defined here (before the boot orphan-resume below uses it);
      // the factory keeps the original signature so call sites are unchanged.
      const loadRunContext = makeLoadRunContext({ examplesDir, agentsDir });
      // Run-creation engine — extracted to src/server/run-runner.ts (step 2)
      // so the standalone worker can execute runs in-process. Destructured to
      // identically-named consts, so the call sites below are unchanged.
      // `store` is opened below; the loader only runs once runs exist.
      const runner = createRunRunner({
        root,
        loadArtifact: (runId, name) => artifactLoaderFor(store)(runId, name),
      });
      const {
        buildExecutorSource,
        loadMcpRegistry,
        loadHooksRegistry,
        expandConnectionRefsInMcpConfig,
        buildHookCallback,
      } = runner;
      const contextDir = path.join(root, 'context');
      const mcpRegistryFile = path.join(root, 'mcp', 'servers.json');
      const hooksRegistryFile = path.join(root, 'hooks', 'hooks.json');
      const runsDir = path.join(root, 'runs');
      const budgetFile = path.join(root, 'budget.json');
      // Operator intake pauses (POST /api/orchestrations/<name>/pause), shared
      // with a standalone worker through the workspace root.
      const intakePauses = new IntakePauseStore(root);
      // Connections / credentials file path. Default
       // `<repoRoot>/credentials.json`; overridable via
       // `SAMMY_CONNECTIONS_FILE` env var so a user can point at a
       // shared file outside the repo (e.g. `~/.config/sammy/connections.json`)
       // and have it pick up their per-user secrets across cloned repos.
       const credentialsFile = resolveCredentialsFile(root);
       if (credentialsFile !== path.join(root, 'credentials.json')) {
         console.log(
           `[sammy-pack-api] connections file (override): ${credentialsFile}`,
         );
       }

      // The verified-role header is INTERNAL: the JWT verifier sets it and the
      // role gate reads it. Strip any inbound value first so a client cannot
      // simply send `X-Sammy-Verified-Role: write`. Mounted before every other
      // /api middleware.
      server.middlewares.use('/api', (req, _res, next) => {
        delete req.headers['x-sammy-verified-role'];
        next();
      });

      // ─── Canonical path guard ───
      //
      // ABOVE every gate, because it is what lets the gates and the handlers
      // read one path. The gates classify a string (`gatePath`); the ingress
      // handlers re-parse `req.url` with `new URL`, which resolves dot
      // segments. Where the two disagreed, the handler won — `new URL` read
      // `/api/triggers./../<hook>` as a real fire that `INGRESS_FIRE` could
      // not match, so the cross-site guard took its read-method early return
      // and the role gate its non-ingress branch, and a verified `read`
      // identity (and a cross-site `fetch`) fired a trigger that answers 403
      // one character away.
      //
      // Normalise-or-reject, and REJECT is the only safe half: canonicalising
      // here would have to resolve `.`/`..`, which SHORTENS a path, and a
      // shortened path reaches the probe exemption (`/api/<resource>/../livez`)
      // that its own handler then answers. Rejecting admits one spelling
      // instead, which is the only thing that makes two parsers in one
      // request path agree; per-spelling classifier patches do not, because
      // each one is a denylist.
      //
      // Nothing legitimate is refused: every client here (the UI, the CLI,
      // an external webhook sender) builds its paths from segments.
      server.middlewares.use('/api', (req, res, next) => {
        const raw = req.url ?? '/';
        const reason = unparseableTarget(raw)
          ? 'a target this server cannot parse as a URL'
          : nonCanonicalPathReason(
              stripProtohost(raw).split('#')[0].split('?')[0],
            );
        if (reason === null) return next();
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            error:
              `Bad request — the path contains ${reason}. This API answers ` +
              'only already-canonical paths: the gates classify the path as a ' +
              'string and the handlers re-parse it, so a spelling the two ' +
              'could read differently is refused rather than normalised.',
          }),
        );
      });

      // ─── SSE auth + identity channel (query string → headers) ───
      //
      // An EventSource cannot send headers. That single fact used to buy the
      // event stream an exemption from BOTH auth gates — and the exemption
      // did not strip `X-Sammy-User`, so under a gated-reads posture an
      // anonymous `GET /api/runs/<id>/events` with a chosen header streamed
      // any owner's run. Meanwhile the UI's own headerless EventSource
      // resolved to owner `system` and 404'd on every other run. One design
      // problem, two symptoms.
      //
      // The fix gives the stream the one channel it has — the query string —
      // for exactly the two headers everything else sends:
      //   ?token=<bearer-or-JWT>  ≡  Authorization: Bearer <token>
      //   ?owner=<id>             ≡  X-Sammy-User: <id>
      // Lifted into the headers HERE, before any gate runs, so a query token
      // is verified by the SAME bearer / JWT code as a header token (there
      // is no second verifier to drift) and the stream needs no exemption.
      // `?owner=` is the same spoofable channel the header is: it is trusted
      // exactly as far as the header would be in the active posture (the JWT
      // gate strips it on an anonymous read; the open posture trusts it like
      // the header) and no further. A header, when present, wins — the query
      // is the fallback for a client that cannot send one. Applies to the
      // SSE route ONLY: no other route is read by an EventSource, so no other
      // route accepts credentials in a URL.
      //
      // Classified on `gatePath` like every gate below, so the one route that
      // accepts a credential in a URL is the one the handlers answer there.
      server.middlewares.use('/api', (req, _res, next) => {
        const url = req.url ?? '';
        if (
          (req.method ?? 'GET').toUpperCase() !== 'GET' ||
          !/^\/runs\/[^/]+\/events$/i.test(gatePath(url))
        ) {
          return next();
        }
        const q = new URLSearchParams(url.split('?')[1]?.split('#')[0] ?? '');
        const token = q.get('token')?.trim();
        if (token && req.headers['authorization'] === undefined) {
          req.headers['authorization'] = `Bearer ${token}`;
        }
        const owner = q.get('owner')?.trim();
        if (owner && req.headers['x-sammy-user'] === undefined) {
          req.headers['x-sammy-user'] = owner;
        }
        next();
      });

      // ─── Cross-site write guard ───
      //
      // Every mutating handler did `JSON.parse(await readBody(req))` with no
      // content-type check, so a cross-site "simple request" (no CORS
      // preflight) reached it from any page a developer happened to visit
      // while the server was running. The attacker cannot READ the response,
      // but several routes do not need a readable response to do damage — the
      // credential probe's side effect IS the exfiltration, and an import's
      // side effect IS the file write. `SAMMY_API_TOKEN` is unset by default
      // (compose leaves it empty, the Dockerfile calls it "recommended"), so
      // the bearer gate is frequently not there to stop it either.
      //
      // Two cheap, standard checks, applied only to state-changing methods:
      //
      //   1. `Content-Type: application/json` is REQUIRED. A form/simple
      //      request cannot set it without a preflight, so this alone blocks
      //      the no-preflight shape.
      //   2. `Sec-Fetch-Site` (sent by every current browser, absent on
      //      non-browser clients like curl and the CLI) must not be
      //      cross-site. Belt and braces for a browser that does send a
      //      preflight.
      //
      // Trigger ingress is exempt from the content-type check ONLY: it is
      // called by external senders, which post whatever type their provider
      // chose, and authenticates by per-trigger HMAC. It is NOT exempt from
      // the Sec-Fetch-Site check — a request carrying `cross-site` IS a
      // browser (no webhook sender sets that header), and a trigger fire
      // from a foreign page starts a run as surely as /api/runs/start does.
      // The exemption used to cover both checks, which was the proven hole:
      // `POST /api/triggers/<hook>` with `Sec-Fetch-Site: cross-site` → 202.
      //
      // And an ingress FIRE counts as a mutation whatever its method. The
      // read-method early return used to come first, so a GET-method webhook
      // (the trigger shape allows it) fired from a cross-site `<img src>` or
      // a prefetch — the same hole one method over.
      server.middlewares.use('/api', (req, res, next) => {
        const method = (req.method ?? 'GET').toUpperCase();
        const p = gatePath(req.url);
        if (
          (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') &&
          !INGRESS_FIRE.test(p)
        ) {
          return next();
        }
        const site = req.headers['sec-fetch-site'];
        const siteVal = Array.isArray(site) ? site[0] : site;
        if (siteVal === 'cross-site') {
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          return res.end(
            JSON.stringify({
              error:
                'Cross-site write refused (Sec-Fetch-Site: cross-site). The ' +
                'API is not designed to be called from another origin.',
            }),
          );
        }
        if (isIngressPath(p)) return next();
        // Content-type is required only when the request actually CARRIES a
        // body. Several routes legitimately take a bodyless POST (`/cancel`,
        // `/resume`, `/stop`), and `fetch(url, {method:'POST'})` sends no
        // content-type for them — demanding one there would break real
        // clients while protecting nothing, since a request with no body
        // carries no payload to smuggle. Bodyless cross-site requests are
        // covered by the Sec-Fetch-Site check above.
        const len = req.headers['content-length'];
        const lenVal = Number(Array.isArray(len) ? len[0] : (len ?? '0'));
        const hasBody =
          (Number.isFinite(lenVal) && lenVal > 0) ||
          req.headers['transfer-encoding'] !== undefined;
        if (!hasBody) return next();
        const ct = req.headers['content-type'];
        const ctVal = (Array.isArray(ct) ? ct[0] : ct) ?? '';
        if (!/^application\/json\b/i.test(ctVal)) {
          res.statusCode = 415;
          res.setHeader('content-type', 'application/json');
          return res.end(
            JSON.stringify({
              error:
                'Content-Type: application/json is required for a state-changing ' +
                `request with a body (got "${ctVal || 'none'}"). This also ` +
                'blocks cross-site form posts, which cannot set it without a ' +
                'preflight.',
            }),
          );
        }
        return next();
      });

      // ─── Optional bearer-token auth gate ───
      //
      // When SAMMY_API_TOKEN is set in the environment, every
      // STATE-CHANGING /api/* request (POST / PUT / DELETE / PATCH)
      // must carry `Authorization: Bearer <token>`.
      //
      // READS: gated only when SAMMY_REQUIRE_AUTH_READS=1.
      //
      // The historical default was "reads are open", which is fine for
      // single-user local dev and NOT fine for anything shared: an
      // unauthenticated GET returns run outputs, agent prompts, the full
      // event stream and traces, and `X-Sammy-User` scoping is
      // client-supplied, so an anonymous caller picks whose runs to list.
      // That made the owner-scoping boundary SECURITY.md claims
      // unenforceable by construction.
      //
      // The default stays open so a local workflow doesn't break, but the
      // posture is now reachable in one variable, the boot banner says which
      // mode is active, and the multi-team guidance names it.
      //
      // The probes are the only reads exempt when reads are gated, and they
      // are listed explicitly rather than falling out of a method check, so
      // the exemption is a visible decision. The SSE stream is NOT exempt any
      // more: it authenticates through `?token=` (lifted into the header
      // above), so the reason for its exemption — "an EventSource cannot
      // carry a token" — no longer holds, and the exemption is an identity
      // bypass.
      //
      // The gate is a named middleware (not an inline closure) because the
      // root `/metrics` mount below reuses it: that route sits outside /api
      // and so escaped every gate, including this one.
      //
      // COMPOSES with the JWT gate below. The documented posture is "token +
      // verifier", and it was unsatisfiable: this gate demanded the static
      // token, the next demanded that same value be a signature-valid JWT,
      // and no string is both — every mutation 401'd. Now a bearer that IS
      // the api token authenticates here (identity stays the X-Sammy-User
      // header, as for every token caller) and the JWT gate passes it
      // through; any other bearer is deferred to the JWT gate.
      //
      // The JWT verifier is built FIRST so this gate can tell whether there
      // is anything to defer to.
      const jwksUri = process.env.SAMMY_JWKS_URI?.trim();
      const jwtPublicKey = process.env.SAMMY_JWT_PUBLIC_KEY?.trim();
      const jwtSecret = process.env.SAMMY_JWT_SECRET?.trim();
      const verifyOpts: import('./src/server/jwt-verify').VerifyOpts = {
        audience: process.env.SAMMY_JWT_AUDIENCE?.trim() || undefined,
        issuer: process.env.SAMMY_JWT_ISSUER?.trim() || undefined,
      };
      let verifyToken:
        | ((token: string) => Promise<import('./src/server/jwt-verify').JwtResult>)
        | null = null;
      let identityLabel = '';
      const claimNote =
        verifyOpts.audience || verifyOpts.issuer
          ? ` [aud=${verifyOpts.audience ?? '*'} iss=${verifyOpts.issuer ?? '*'}]`
          : ' [WARNING: no aud/iss validation — set SAMMY_JWT_AUDIENCE/ISSUER]';
      if (jwksUri) {
        const jwks = createJwksClient({ jwksUri });
        verifyToken = token => jwks.verify(token, verifyOpts);
        identityLabel = `verified JWT (RS256 / JWKS @ ${jwksUri})${claimNote}`;
      } else if (jwtPublicKey) {
        verifyToken = token =>
          Promise.resolve(verifyJwtRS256(token, jwtPublicKey, verifyOpts));
        identityLabel = `verified JWT (RS256 / static public key)${claimNote}`;
      } else if (jwtSecret) {
        verifyToken = token =>
          Promise.resolve(verifyJwtHS256(token, jwtSecret, verifyOpts));
        identityLabel = `verified JWT (HS256)${claimNote}`;
      }
      // Requests whose bearer a gate ACCEPTED — the static api token here, a
      // verified JWT below. Keyed by the request object, not a header, so a
      // client cannot forge membership. Read by the next gate so the two
      // compose, and by both ingress exemptions so a fire keeps a
      // client-named owner only when something vouched for the caller.
      const authenticated = new WeakSet<Connect.IncomingMessage>();
      const apiToken = process.env.SAMMY_API_TOKEN?.trim();
      // Fails CLOSED: a present-but-unrecognised value (`yes`, `1 `) means
      // reads ARE gated, because the operator set the variable to gate them.
      const requireAuthReads = envFlag('SAMMY_REQUIRE_AUTH_READS', {
        failClosed: true,
      });
      const bearerGate: Connect.NextHandleFunction | null = apiToken
        ? (req, res, next) => {
            const header = req.headers['authorization'];
            const auth = Array.isArray(header) ? header[0] : header;
            const p = gatePath(req.url);
            const tokenOk = bearerMatchesToken(auth, apiToken);
            if (tokenOk) authenticated.add(req);
            // P4: a trigger FIRE (webhook / events / deploy / queue) is
            // external-facing and authenticates via per-trigger HMAC, not the
            // admin bearer token — exempt it. Admin routes stay locked. (The
            // mount strips '/api', so `gatePath` is '/triggers/...' here.)
            //
            // Scoped to the FIRE, not to the kind prefix. The exemption exists
            // so an external SENDER can POST without the operator's bearer; it
            // was never meant to open the bare kind LISTS, and on the prefix it
            // did: under SAMMY_REQUIRE_AUTH_READS=1 an anonymous GET of
            // /api/{triggers,events,deploy,queue} answered 200 with the whole
            // trigger inventory — fire paths, signature providers, cron exprs,
            // polling sources — while /api/orchestrations answered 401, on a
            // server whose SECURITY.md says only the probes stay open. A bare
            // list is a read like any other read.
            //
            // Exempt from the TOKEN, not from identity. The exemption used to
            // keep a sender's self-named `X-Sammy-User`, so an anonymous,
            // token-less fire ran AS that owner — resolving their
            // credentials and spending their per-owner cap. Strip it unless
            // the sender holds the token; the JWT gate re-sets it from a
            // verified claim. Unauthenticated ingress is attributed to
            // `system`.
            //
            // BEFORE the reads-open early return, whatever the method. The
            // strip used to sit below it, so under the token-only posture
            // with reads open a GET-method webhook fire — a mutation, as the
            // cross-site guard and the role gate already classify it — kept
            // its client-chosen owner: the one cell of the posture matrix
            // where the ingress exemption was still a header-trust bypass.
            // This is the JWT gate's ordering (ingress is classified before
            // any read tolerance), so the two gates agree in every posture.
            if (INGRESS_FIRE.test(p)) {
              if (!tokenOk) delete req.headers['x-sammy-user'];
              return next();
            }
            const method = (req.method ?? 'GET').toUpperCase();
            const isRead =
              method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
            if (isRead && !requireAuthReads) {
              return next();
            }
            if (isRead) {
              // Probes must stay reachable for an orchestrator that cannot
              // attach a bearer token. They carry no identity, so strip any
              // client-supplied one — the same thing the JWT gate does on
              // its exempt path — so an exemption can never double as a
              // header-trust bypass.
              if (isProbePath(p)) {
                delete req.headers['x-sammy-user'];
                return next();
              }
            }
            if (tokenOk) return next();
            // Not the api token, but a bearer nonetheless: with a verifier
            // configured it may be a JWT, and that gate is the one to judge
            // it (and to 401 it if it is not).
            if (verifyToken && /^Bearer .+$/.test(auth ?? '')) return next();
            res.statusCode = 401;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                error:
                  'Unauthorized. This server has SAMMY_API_TOKEN set — ' +
                  'state-changing requests need Authorization: Bearer <token>' +
                  (verifyToken ? ' or a signed Bearer JWT' : '') +
                  '.',
              }),
            );
          }
        : null;
      if (bearerGate) {
        server.middlewares.use('/api', bearerGate);
        console.log(
          '[sammy-pack-api] auth gate ON — mutating /api routes require ' +
            (verifyToken
              ? 'the bearer token OR a verified JWT'
              : 'a bearer token') +
            '; reads are ' +
            (requireAuthReads
              ? 'GATED (SAMMY_REQUIRE_AUTH_READS=1)'
              : 'OPEN (set SAMMY_REQUIRE_AUTH_READS=1 to gate them)'),
        );
      }

      // ─── Verified identity (P-A2) ───
      //
      // When a JWT verifier is configured, the owner identity comes from a
      // SIGNED Bearer JWT, not a trusted X-Sammy-User header. The verified
      // owner claim (default `sub`, override SAMMY_JWT_OWNER_CLAIM) overwrites
      // any client-supplied X-Sammy-User, so downstream extractOwnerId reads a
      // verified value. State-changing requests REQUIRE a valid token (or the
      // static api token, accepted by the gate above); reads accept-if-present
      // while reads are open and are denied unverified under
      // SAMMY_REQUIRE_AUTH_READS=1 — the SSE stream included, which sends its
      // token as `?token=` (lifted into the header above). Trigger ingress is
      // exempt from the REQUIREMENT (it authenticates by per-trigger HMAC) but
      // not from identity: an anonymous fire carries none.
      //
      // The verifier itself is built above the bearer gate (precedence so only
      // ONE algorithm family is ever accepted, no HS/RS "alg confusion"
      // downgrade: SAMMY_JWKS_URI → RS256 via JWKS; SAMMY_JWT_PUBLIC_KEY →
      // RS256 via a static PEM; SAMMY_JWT_SECRET → HS256 via a shared secret).
      //
      // SAMMY_JWT_AUDIENCE / SAMMY_JWT_ISSUER, when set, are REQUIRED claims —
      // the token's `aud` must include the audience and its `iss` must equal
      // the issuer. Without them a valid signature from the configured key is
      // trusted regardless of who the token was minted for, so set them in any
      // real (multi-service / federated) deployment.
      //
      // The role claim is read ONLY when SAMMY_JWT_ROLE_CLAIM is explicitly
      // set. There is deliberately no default name: a stock IdP token carries
      // `role: "admin"` or `roles: [...]` as a matter of course, and with a
      // default of `role` every such token parsed to an unrecognised value,
      // failed closed to `read`, and locked every mutation out — on a server
      // whose banner said "roles: not configured". Unset means roles are not
      // in effect from the token at all (the allowlist still applies).
      let jwtGate: Connect.NextHandleFunction | null = null;
      if (verifyToken) {
        const verify = verifyToken;
        const ownerClaim =
          process.env.SAMMY_JWT_OWNER_CLAIM?.trim() || 'sub';
        const roleClaimName =
          process.env.SAMMY_JWT_ROLE_CLAIM?.trim() || null;
        const deny = (res: import('node:http').ServerResponse, msg: string) => {
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        };
        jwtGate = (req, res, next) => {
          // A bearer the token gate already accepted: identity stays the
          // X-Sammy-User header (the token posture's identity) and the value
          // is not a JWT, so verifying it here would be the 401 that made
          // "token + verifier" an unusable configuration.
          if (authenticated.has(req)) return next();
          const p = gatePath(req.url);
          const ingressFire = INGRESS_FIRE.test(p);
          const method = (req.method ?? 'GET').toUpperCase();
          const isRead =
            method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
          // A read is anonymous-tolerated ONLY while reads are ungated.
          // Under SAMMY_REQUIRE_AUTH_READS=1 an unverified read is denied
          // like any mutation — otherwise this gate and the bearer gate
          // would disagree about whether reads are authenticated, and the
          // weaker one would win. Probes stay exempt; the SSE stream does
          // not — it sends its JWT as `?token=`, lifted into the header
          // above, and is verified right here like any other read.
          //
          // An ingress FIRE is anonymous-tolerated always: it authenticates
          // by per-trigger HMAC, not a user session, and a provider may send
          // an `Authorization` of its own that is no JWT. But anonymous means
          // NO identity — the exemption used to return before this gate ran
          // and so kept a sender's self-named `X-Sammy-User`, which the run
          // then executed as. Only a bearer that verifies here names an
          // owner; everything else fires as `system`.
          //
          // The FIRE, not the kind prefix — same narrowing as the bearer
          // gate, and needed in BOTH: on the prefix, the verifier-only
          // posture answered an anonymous GET /api/triggers with the whole
          // trigger inventory under SAMMY_REQUIRE_AUTH_READS=1. A bare kind
          // list is a read, and reads are this gate's to deny.
          const probeExempt = isProbePath(p);
          const tolerateAnonRead =
            ingressFire || (isRead && (!requireAuthReads || probeExempt));
          const raw = req.headers['authorization'];
          const h = Array.isArray(raw) ? raw[0] : raw;
          const m = /^Bearer (.+)$/.exec(h ?? '');
          if (!m) {
            if (tolerateAnonRead) {
              // Anonymous read: strip any client-supplied identity rather
              // than letting it through. `X-Sammy-User` is the owner scope,
              // so trusting it from an unauthenticated caller is what let
              // anyone list anyone's runs by choosing a header value.
              delete req.headers['x-sammy-user'];
              return next();
            }
            return deny(res, 'Unauthorized — a signed Bearer JWT is required.');
          }
          // Async: JWKS verification may fetch the signing key. Connect
          // ignores the returned promise, so every path calls next()/deny().
          void verify(m[1]).then(
            result => {
              if (!result.ok) {
                if (tolerateAnonRead) {
                  delete req.headers['x-sammy-user'];
                  return next();
                }
                return deny(res, `Unauthorized — ${result.reason}.`);
              }
              const owner = result.claims[ownerClaim];
              if (typeof owner !== 'string' || !owner) {
                if (tolerateAnonRead) {
                  delete req.headers['x-sammy-user'];
                  return next();
                }
                return deny(res, `Token missing a string "${ownerClaim}" claim.`);
              }
              // Verified identity wins over any client-supplied header.
              req.headers['x-sammy-user'] = owner;
              authenticated.add(req);
              // Carry the VERIFIED role claim on an internal header the role
              // gate below reads. Internal because it must not be settable by
              // a client: it is deleted for every request before the verifier
              // runs (see the role gate), so only a verified token can put it
              // back. The claim is passed through RAW — a string or a string
              // array, both of which a header can carry — and anything else
              // present is JSON-encoded, which `parseRole` cannot recognise
              // and so fails closed to `read`. Dropping a non-string claim
              // here is what used to turn `roles: ["read"]` into `write`.
              if (roleClaimName) {
                const roleClaim = claimAtPath(result.claims, roleClaimName);
                if (roleClaim !== undefined && roleClaim !== null) {
                  req.headers['x-sammy-verified-role'] =
                    typeof roleClaim === 'string'
                      ? roleClaim
                      : Array.isArray(roleClaim) &&
                          roleClaim.every(member => typeof member === 'string')
                        ? (roleClaim as string[])
                        : JSON.stringify(roleClaim);
                }
              }
              next();
            },
            err => {
              if (tolerateAnonRead) {
                delete req.headers['x-sammy-user'];
                return next();
              }
              return deny(res, `Unauthorized — ${(err as Error).message}.`);
            },
          );
        };
        server.middlewares.use('/api', jwtGate);
        console.log(
          `[sammy-pack-api] identity: ${identityLabel} — owner from "${ownerClaim}" claim`,
        );
      }

      // ─── Role gate (read / write) ───
      //
      // Identity answered *who*; this answers *what they may do*. Two roles,
      // deliberately: `read` (GET/HEAD/OPTIONS only) and `write`
      // (everything). Source precedence is in `src/server/roles.ts` — a
      // verified JWT claim first, then the `SAMMY_READONLY_USERS` allowlist,
      // then `write` by default so an existing single-user deployment is
      // unchanged.
      //
      // Mounted after both auth gates so a verified role claim is available.
      //
      // Trigger ingress authenticates by per-trigger HMAC and is not a user
      // session, so an ANONYMOUS sender (no identity header) is untouched.
      // But a request that DOES carry an identity resolving to `read` is
      // refused: a read-only teammate could otherwise start runs through
      // `POST /api/triggers/<hook>` that this very gate stops them starting
      // through `/api/runs/start`. Only a FIRE — a path
      // with a name segment — is refused; the bare list GETs are reads. A
      // GET-method webhook fire counts as a fire: it starts a run.
      server.middlewares.use('/api', (req, res, next) => {
        const p0 = gatePath(req.url);
        if (isProbePath(p0)) return next();
        const ingressFire = INGRESS_FIRE.test(p0);
        if (isIngressPath(p0)) {
          const carried = req.headers['x-sammy-user'];
          const hasIdentity = Array.isArray(carried)
            ? carried.some(v => v.trim() !== '')
            : typeof carried === 'string' && carried.trim() !== '';
          if (!ingressFire || !hasIdentity) return next();
        }
        const role = effectiveRole({
          ownerId: extractOwnerId(req),
          claimRole: req.headers['x-sammy-verified-role'],
        });
        if (role === 'write' || (!ingressFire && roleAllowsMethod(role, req.method))) {
          return next();
        }
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            error:
              `Forbidden — this identity has the "read" role, so ` +
              (ingressFire
                ? 'firing a trigger (which starts a run) is not permitted. '
                : `${(req.method ?? 'POST').toUpperCase()} is not permitted. `) +
              'Roles come from a verified JWT claim ' +
              '(SAMMY_JWT_ROLE_CLAIM) or SAMMY_READONLY_USERS.',
          }),
        );
      });

      // Open the run store. SQLite by default (zero infra); Postgres
      // when DATABASE_URL is set. Then import any legacy file-based
      // runs once on first boot — the runs/ folder is left as a backup.
      const store = deps?.store ?? (await openRunStore(root));
      console.log(`[sammy-pack-api] run store: ${store.backend}`);

      // ─── Stale-gate TTL config + snapshot ───
      //
      // A run paused at a human gate can sit `paused` forever, invisibly —
      // while STILL holding its concurrency group, so every cron fire queues
      // silently behind it (a real one held a group for days). The sweeper
      // (registered further down, after the concurrency seam it reuses)
      // refreshes this snapshot: run id → epoch-ms pause time for every
      // paused run past SAMMY_GATE_TTL_HOURS. The runs LIST decorates paused
      // rows from it (no event hydration — the list must stay light); the
      // per-run detail endpoint derives the same fields precisely from the
      // events it loads anyway. Read at boot: TTL semantics are a deployment
      // decision, like the store backend.
      const gateTtl = gateTtlMs();
      const gateAction = gateTtlAction();
      const staleGates = new Map<string, { pausedSinceMs: number }>();

      // ─── GET /api/health — REAL capability signals (not a guess) ───
      //
      // Exists because capability used to be inferred from a misleading
      // `harnessGated` flag (a CLAUDECODE=1 server was *assumed* unable to run
      // agents but ran 400+ tool-uses fine). So expose the queryable truth
      // instead:
      //   { status, backend, capabilities: { codeRun, store, agentTools }, ts }
      //
      // Reachable WITHOUT heavy auth: it is GET-only, and both auth gates above
      // (bearer + JWT) let GET/HEAD through, so a probe never needs a token.
      //
      // The agent-tools probe is OPT-IN + cached (cost/hang safety): the
      // DEFAULT response returns the cached value or 'unknown' and NEVER spawns
      // an agent. `?probe=1` (or the SAMMY_HEALTH_PROBE=1 boot flag below) runs
      // ONE trivial tool-call under a short hard timeout and caches the result.
      const healthProbeOnBoot =
        process.env.SAMMY_HEALTH_PROBE === '1' ||
        process.env.SAMMY_HEALTH_PROBE === 'true';
      if (healthProbeOnBoot) {
        // Warm the cache once at boot so later default /api/health calls report
        // a real agentTools value for free. Fire-and-forget; never blocks boot.
        void probeAgentTools().catch(() => setCachedAgentTools('failed'));
      }
      server.middlewares.use('/api/health', async (req, res) => {
        // The mount strips '/api/health', so req.url is '/' or '/?probe=1'.
        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          return sendError(res, 405, 'Method not allowed');
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const wantsProbe =
            url.searchParams.get('probe') === '1' ||
            url.searchParams.get('probe') === 'true';
          // Opt-in only. Cached after the first run, so repeat probes are free.
          // Never spawns implicitly: the default branch reads the cache.
          const agentTools = wantsProbe
            ? await probeAgentTools()
            : getCachedAgentTools();
          const health = buildHealth({
            backend: store.backend,
            store: await probeStore(store),
            codeRun: codeRunEnabled(),
            probedAgentTools: agentTools,
          });
          // STATUS CODE CARRIES THE VERDICT.
          //
          // This used to answer 200 unconditionally — including the branch
          // that reports `status:'degraded', store:'unreachable'`. The baked
          // HEALTHCHECK tests `r.ok`, so a server that KNEW its store was
          // gone reported healthy to Docker, to a load balancer and to any
          // orchestrator probe, indefinitely. A status surface that reports
          // healthy while the server cannot serve is the exact failure mode a
          // status surface exists to prevent.
          //
          // 503 is the correct code: the process is up (so this is not a
          // liveness failure) but cannot serve (so it must leave the pool).
          // The BODY is unchanged, so any client reading `status` still works.
          return sendJson(res, health.status === 'ok' ? 200 : 503, health);
        } catch (err) {
          // A health check must never 500 on its own bookkeeping — but it must
          // not claim health either. 503, not 200.
          return sendJson(res, 503, {
            status: 'degraded',
            backend: store.backend,
            capabilities: {
              codeRun: codeRunEnabled(),
              store: 'unreachable',
              agentTools: getCachedAgentTools(),
            },
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      // ─── Liveness / readiness split ────────────────────────────────
      //
      // `/api/health` answers "can I serve?" and now 503s when it cannot,
      // which is the right signal for a load balancer or a compose/ECS
      // healthcheck. It is the WRONG signal for a Kubernetes livenessProbe:
      // an unreachable Postgres would fail liveness and get the pod killed
      // and restarted in a loop, which cannot fix a database that is down and
      // throws away every in-flight run on each restart.
      //
      // So the two questions get two endpoints:
      //   GET /api/livez  — is this PROCESS alive? 200 if it can answer at
      //                     all. Point a livenessProbe here. It deliberately
      //                     touches no dependency.
      //   GET /api/readyz — can it SERVE? Store-backed, 503 when not. Point a
      //                     readinessProbe / LB health check here.
      server.middlewares.use('/api/livez', (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          return sendError(res, 405, 'Method not allowed');
        }
        // No store probe, no agent probe, no awaits: reaching this handler IS
        // the answer. Restarting on a failure here is always the right call.
        return sendJson(res, 200, { status: 'alive', ts: Date.now() });
      });

      server.middlewares.use('/api/readyz', async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          return sendError(res, 405, 'Method not allowed');
        }
        try {
          const storeStatus = await probeStore(store);
          const ready = storeStatus === 'ok';
          return sendJson(res, ready ? 200 : 503, {
            status: ready ? 'ready' : 'not-ready',
            backend: store.backend,
            store: storeStatus,
            ts: Date.now(),
          });
        } catch (err) {
          return sendJson(res, 503, {
            status: 'not-ready',
            backend: store.backend,
            store: 'unreachable',
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      // ─── Prometheus metrics (GET /metrics + GET /api/metrics) ──────
      //
      // Hand-rolled text exposition (src/server/metrics.ts) over run
      // HEADERS + in-process gauges — low-cardinality by design, one
      // bounded listRuns per scrape, no client library (same stance as
      // the hand-rolled OTLP export). Served at the conventional /metrics
      // AND under /api/metrics for consistency. Open like the other GET
      // routes while reads are open. When reads are GATED
      // (SAMMY_REQUIRE_AUTH_READS=1) the root mount is gated too: it sits
      // outside /api and so escaped every gate — a read that stayed open
      // under the posture that promises none are (the root A2A card was the
      // other; see its mount). Prometheus can send
      // a bearer (`authorization.credentials` in its scrape config); for a
      // scrape network that genuinely cannot, SAMMY_METRICS_PUBLIC=1 opts
      // the root route back out, visibly, in the banner.
      const metricsPublic = envFlag('SAMMY_METRICS_PUBLIC');
      const mountedAtMs = Date.now();
      const metricsHandler = async (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ): Promise<void> => {
        // An EXACT-path resource, enforced here rather than left to the
        // mount. connect strips a mount by LENGTH and hands the handler
        // whatever follows it, so `/metrics/livez` arrived as `/livez` — and
        // the reused /api gates read that as a probe and exempted it from
        // gated reads, serving the whole scrape anonymously. Anything after
        // the resource is a 404, not an alias of it.
        //
        // Canonicalised by `gatePath`, the helper the gates above classify
        // on, so the resource and its own gate cannot disagree about which
        // request IS the resource: a hand-rolled `split('?')` 404'd `/metrics`
        // itself under an absolute-form target (connect leaves the protohost
        // in `req.url` and does not re-add a leading slash, so the remainder
        // read as non-empty) and under a `#` tail, while the gate had already
        // classified both as the resource. One spelling is admitted with it:
        // an absolute-form `GET http://host/metrics.foo` arrives as
        // `http://host.foo`, whose path part connect has glued onto the
        // authority, and no parser can tell that from the bare resource — so
        // it reads as the resource, gated by the same string the gate read.
        const rest = gatePath(req.url);
        if (rest !== '/') return sendError(res, 404, 'Not found');
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          return sendError(res, 405, 'Method not allowed');
        }
        try {
          const headers = await store.listRuns(METRICS_RUN_SCAN_LIMIT);
          const text = buildMetricsText({
            headers,
            scanTruncated: headers.length >= METRICS_RUN_SCAN_LIMIT,
            bootedAtMs: mountedAtMs,
          });
          res.statusCode = 200;
          res.setHeader(
            'content-type',
            'text/plain; version=0.0.4; charset=utf-8',
          );
          res.end(text);
        } catch (err) {
          return sendError(
            res,
            500,
            err instanceof Error ? err.message : String(err),
          );
        }
      };
      server.middlewares.use('/api/metrics', metricsHandler);
      // The SAME gate functions the /api mount uses, so a root scrape is
      // checked by the same code as an /api read — nothing is re-implemented
      // here to drift. They classify a MOUNT-RELATIVE path, though, so a
      // sub-path would reach their own /api exemptions (`/metrics/livez` is
      // `/livez` in there); the handler's exact-path check above is what
      // makes that a 404 instead of an anonymous scrape.
      if (requireAuthReads && !metricsPublic) {
        if (bearerGate) server.middlewares.use('/metrics', bearerGate);
        if (jwtGate) server.middlewares.use('/metrics', jwtGate);
      }
      server.middlewares.use('/metrics', metricsHandler);

      // ─── OpenAPI document (GET /api/openapi.json) ──────────────────
      // The machine-readable contract for the whole /api surface
      // (src/server/openapi.ts — structurally pinned by openapi.test.ts).
      // Built once per mount: the document is static for a process.
      const openApiDoc = JSON.stringify(buildOpenApiDoc());
      server.middlewares.use('/api/openapi.json', (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          return sendError(res, 405, 'Method not allowed');
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(openApiDoc);
      });

      try {
        const result = await importLegacyRunFiles(store, runsDir);
        if (result.imported > 0) {
          console.log(
            `[sammy-pack-api] imported ${result.imported} legacy run(s) from runs/ ` +
              `(skipped ${result.skipped} already-present, ${result.errors} errors)`,
          );
        }
      } catch (err) {
        console.error('[sammy-pack-api] run migration failed:', err);
      }

      // Reclaim + auto-resume orphaned runs. A run still flagged `running`
      // whose lease has expired was owned by a process that died; its
      // checkpoint (completedLeaves + leafOutputs) is preserved, so the
      // executor re-walks the tree, skip-replays completed leaves, and picks
      // up at the in-flight phase, which is what makes a crash recoverable
      // rather than fatal to the run. The lease gate means a run a live
      // peer/worker is executing is NOT reclaimed.
      // Auto-resume of orphaned runs on boot is OFF by default. A crash that
      // left many runs in-flight would otherwise re-spawn ALL of them at once
      // on the next start and stampede the machine, which is enough to
      // overload a single host. We still mark orphans `interrupted` so the
      // Runs view shows them truthfully and they stay manually resumable /
      // cancellable — we just don't re-execute them automatically. Opt back
      // into resume-on-boot with SAMMY_AUTO_RESUME=1.
      const AUTO_RESUME_ON_BOOT =
        process.env.SAMMY_AUTO_RESUME === '1' ||
        process.env.SAMMY_AUTO_RESUME === 'true';
      // DEFINED here, CALLED further down (after the trigger boot scan): the
      // reclaim below drains a reclaimed run's concurrency group through the
      // same seam every other terminal transition uses, and that seam needs
      // the group lock, the start-gate and the per-orchestration concurrency
      // declarations the boot scan populates. The sweepers for stale gates
      // and due waits are placed after that seam for the same reason.
      const scanAndResumeOrphans = async (why: string) => {
        let orphans: { count: number; ids: string[] } = { count: 0, ids: [] };
        try {
          orphans = await store.markOrphanedRunsAsInterrupted(undefined, {
            isLocallyActive: isActiveServerRun,
          });
          if (orphans.count > 0) {
            console.log(
              `[sammy-pack-api] (${why}) marked ${orphans.count} orphaned run(s) ` +
                `as interrupted: ${orphans.ids.join(', ')}`,
            );
          }
        } catch (err) {
          console.error('[sammy-pack-api] orphan scan failed:', err);
        }
        // running → interrupted is a TERMINAL transition for the group: the
        // reclaimed run no longer counts as active (findActiveRunsInGroup
        // reads running / paused), so its slot is free — but freeing the
        // slot starts nothing. Without a drain, a fire parked behind a dead
        // peer's run waited forever: the slot was open and nobody drained
        // the queue. Every reclaimed id that is NOT resumed goes through the
        // SINGLE seam the other three terminal paths use (below, after the
        // resume pass), so this fourth one cannot strand work either.
        //
        // RESUME FIRST, drain after. The drain used to run before the
        // auto-resume loop: the drained fire took the group, resume() then
        // refused ("group busy"), and nothing retried — crash-resume was
        // lost exactly when the group had queued work. A resumed run
        // re-takes its group by flipping back to `running`; its own terminal
        // drains the queue behind it.
        const notResumed = new Set(orphans.ids);
        if (!AUTO_RESUME_ON_BOOT && orphans.count > 0) {
          console.log(
            `[sammy-pack-api] auto-resume disabled — left ${orphans.count} ` +
              `interrupted run(s) for manual resume/cancel in the Runs view ` +
              `(set SAMMY_AUTO_RESUME=1 to re-enable resume-on-boot)`,
          );
        }
        // A separate try per id so one failed resume doesn't kill the rest.
        for (const orphanId of AUTO_RESUME_ON_BOOT ? orphans.ids : []) {
          try {
            const stored = await store.getRun(orphanId);
            if (!stored) continue;
            const ctx = await loadRunContext(stored.orchestrationName, {
              orchestrationOverride: stored.orchestrationSnapshot as Node | null,
            });
            if (!ctx) {
              console.warn(
                `[sammy-pack-api] cannot auto-resume ${orphanId}: ` +
                  `orchestration "${stored.orchestrationName}" no longer in the workspace`,
              );
              continue;
            }
            const result = await resumeServerRun({
              store,
              id: orphanId,
              // Full terminal parity with a fresh start (event publishing,
              // notify, errorOrchestration, group drain, budget caps,
              // divergence watchdog) — resume used to silently drop all of
              // these for the resumed leg.
              budgetGate: (await loadBudgetState(budgetFile, store, stored.ownerId)).gate,
              onTerminal: buildTerminalHook(
                stored.orchestrationName,
                ctx.orchestration,
                stored.ownerId,
              ),
              divergence: ctx.orchestration.notify?.divergence,
              buildEventSource: (signal, replayOutputs, autoApproveLocks, _gms, runId, waits, inputs) =>
                buildExecutorSource(
                  ctx,
                  {
                    initialInput: stored.initialInput ?? undefined,
                    allowAgentTools: true,
                    replayOutputs,
                    autoApproveLocks,
                    ownerId: stored.ownerId,
                    runId,
                    pendingWaits: waits.pendingWaits,
                    deliveredSignals: waits.deliveredSignals,
                    resolvedInputs: inputs,
                  },
                  signal,
                ),
            });
            if (result.ok) {
              notResumed.delete(orphanId);
              console.log(
                `[sammy-pack-api] auto-resumed ${orphanId} from checkpoint`,
              );
            } else {
              console.warn(
                `[sammy-pack-api] auto-resume ${orphanId} failed: ${result.reason}`,
              );
            }
          } catch (err) {
            console.error(
              `[sammy-pack-api] auto-resume ${orphanId} crashed:`,
              err,
            );
          }
        }
        // Best-effort per id (the seam swallows its own errors). A run that
        // was refused because its group is BUSY — a sibling orphan that did
        // resume, or a live peer — has nothing to drain either: draining
        // into a held group would at best re-park the fire and at worst
        // drop it (`skip`) or cancel the holder (`cancel-existing`). The
        // holder's own terminal drains.
        for (const orphanId of notResumed) {
          try {
            const group = (await store.getRun(orphanId))?.concurrencyGroup;
            if (group && (await store.findActiveRunsInGroup(group)).length > 0) {
              continue;
            }
          } catch {
            /* fall through — the seam re-reads and tolerates its own errors */
          }
          await releaseGroupAndDrainForRun(orphanId, 'interrupted');
        }
      };

      // The server's OWN state files. The import roots ALWAYS include the
      // workspace root and these all live inside it, so "inside an allowed
      // root" is no confinement for them: an import symlinked
      // `credentials.json` into `examples/`, where the orchestration GET
      // returns it verbatim — defeating the quarter-rule mask AND the
      // per-entry `owners` allowlist in one GET — and the PUT writes THROUGH
      // the link, defeating the owner check and the cannot-move-while-masked
      // rule. Passed as `deny` to every seam that resolves a caller-supplied
      // path, and re-checked at the `examples/` loader so a link an earlier
      // build (or a hand-made one in a bind-mounted data dir) already left on
      // disk is dead too. Resolved full paths, not basenames: the MCP and
      // hooks registries are nested, so a basename test would miss them.
      const serverStateFiles = [
        credentialsFile,
        budgetFile,
        mcpRegistryFile,
        hooksRegistryFile,
        ...(store.filePath ? [store.filePath] : []),
      ];

      /** True when `file` resolves to one of `serverStateFiles`. The same
       *  predicate the SOURCE check uses (`resolvesToDeniedFile`), so the two
       *  halves of the fence cannot disagree about what a state file is. */
      const resolvesToServerStateFile = (file: string): Promise<boolean> =>
        resolvesToDeniedFile(file, serverStateFiles);

      /** True when `examples/<name>.json` resolves to a server state file —
       *  the fence stated in the name a LOADER is given rather than in the
       *  path a handler built.
       *
       *  The handler fence below covers `/api/orchestrations` only, and that
       *  is not the only reader: `loadRunContext` takes the same name from
       *  the run mirror, `/api/runs/start`, `/api/preview` and the A2A RPC,
       *  and whatever it returns is persisted as that run's
       *  `orchestrationSnapshot` — which `GET /api/runs` and
       *  `GET /api/runs/:id` republish verbatim. So a planted link was
       *  404-shaped at the orchestration routes and plaintext at the run
       *  surface. Every seam that resolves a name to a tree asks this first;
       *  the answer is "no such orchestration", in that seam's own shape. */
      const namesServerStateFile = async (name: unknown): Promise<boolean> =>
        typeof name === 'string' &&
        name !== '' &&
        (await resolvesToServerStateFile(
          path.join(examplesDir, `${name}.json`),
        ));

      // GET /api/orchestrations           → list (each entry is full Node)
      // GET /api/orchestrations/:name     → one Node
      // PUT /api/orchestrations/:name     → write (body is the Node)
      // DELETE /api/orchestrations/:name  → remove file
      server.middlewares.use('/api/orchestrations', async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';

          // Reserved sub-routes — let dedicated middlewares handle them.
          // Without this pass-through, POST /api/orchestrations/from-file
          // (or /from-folder / /import) would land here and try to write
          // `from-file.json` etc.
          if (
            name === 'from-file' ||
            name === 'from-folder' ||
            name === 'import'
          )
            return next();

          if (!name) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const entries = await fs.readdir(examplesDir).catch(() => [] as string[]);
            const out: Json[] = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const full = path.join(examplesDir, f);
              // An entry that resolves to a server state file is not an
              // orchestration — see `serverStateFiles`. Skipped rather than
              // 500'd: one stale link must not break the whole listing.
              if (await resolvesToServerStateFile(full)) continue;
              const parsed = await readJsonFile(full);
              if (!parsed) continue;
              // Provenance for subflow name-resolution precedence: a domain
              // orchestration is imported as a SYMLINK into examples/; a shipped
              // example is a real in-repo file. Tag so an imported router can
              // deterministically shadow a same-named example (the executor's
              // map-build prefers imported > shipped). Best-effort; a stat
              // failure leaves origin unset (treated as shipped downstream).
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const isLink = await fs
                  .lstat(full)
                  .then(s => s.isSymbolicLink())
                  .catch(() => false);
                (parsed as Record<string, Json>).__origin = isLink
                  ? 'imported'
                  : 'shipped';
              }
              out.push(parsed);
            }
            return sendJson(res, 200, out);
          }

          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(examplesDir, `${name}.json`);

          // The loader half of the state-file fence (see `serverStateFiles`).
          // Write-through to an imported file is a documented FEATURE, so the
          // rule is not "the realpath must stay inside examples/" — it is that
          // a server state file is never an orchestration, however it got
          // linked here. 404-shaped: the same answer as a name that does not
          // exist, so this is not an existence oracle for the state files.
          if (
            (method === 'GET' || method === 'PUT') &&
            (await resolvesToServerStateFile(file))
          ) {
            return sendError(res, 404, 'Not found');
          }

          // ─── Intake controls: /api/orchestrations/:name/{pause,resume,intake}
          //
          // The operator switch for an automation's TRIGGERS. Pausing holds
          // new HTTP-fired deliveries (re-checked every minute, nothing
          // dropped) and skips scheduled ticks; it does not touch runs already
          // in flight, and manual starts still work. `intake` reports the
          // switch alongside the root `limits` and today's usage against them.
          if (
            segs.length === 2 &&
            (segs[1] === 'pause' || segs[1] === 'resume' || segs[1] === 'intake')
          ) {
            if (await resolvesToServerStateFile(file)) return sendError(res, 404, 'Not found');
            const node = (await readJsonFile(file)) as Node | null;
            if (!node) return sendError(res, 404, 'Not found');
            if (segs[1] === 'intake') {
              if (method !== 'GET') return sendError(res, 405, 'Use GET');
              const now = Date.now();
              const w = calendarWindow(now);
              const usage = store.orchestrationUsage
                ? await store.orchestrationUsage(name, {
                    dayStart: w.dayStart,
                    monthStart: w.monthStart,
                  })
                : null;
              const verdict = await checkLimits(store, name, node.limits, now);
              return sendJson(res, 200, {
                orchestration: name,
                paused: await intakePauses.get(name),
                limits: node.limits ?? null,
                usage,
                limitReached: verdict.action === 'hold' ? verdict.reason : null,
              });
            }
            if (method !== 'POST') return sendError(res, 405, 'Use POST');
            if (segs[1] === 'resume') {
              const was = await intakePauses.resume(name);
              // Held fires go now rather than on their next re-check.
              const released =
                was && store.releaseDeliveries ? await store.releaseDeliveries(name, Date.now()) : 0;
              console.log(
                `[sammy-pack-api] intake for "${name}" ${was ? 'RESUMED' : 'was not paused'} ` +
                  `(by ${extractOwnerId(req)}; ${released} held delivery(ies) released)`,
              );
              if (released > 0) deliveryWorker.kick();
              return sendJson(res, 200, {
                orchestration: name,
                paused: false,
                wasPaused: was,
                released,
              });
            }
            let reason: string | undefined;
            const raw = (await readBody(req)).trim();
            if (raw) {
              try {
                const b = JSON.parse(raw) as { reason?: unknown };
                if (b && typeof b.reason === 'string') reason = b.reason.slice(0, 500);
              } catch {
                return sendError(res, 400, 'Invalid JSON body');
              }
            }
            await intakePauses.pause(name, { by: extractOwnerId(req), reason });
            console.warn(
              `[sammy-pack-api] intake for "${name}" PAUSED by ${extractOwnerId(req)}` +
                (reason ? ` — ${reason}` : ''),
            );
            return sendJson(res, 200, {
              orchestration: name,
              paused: await intakePauses.get(name),
            });
          }

          if (method === 'GET') {
            const parsed = await readJsonFile(file);
            if (parsed === null) return sendError(res, 404, 'Not found');
            // Tag provenance (symlink ⇒ imported/domain, real file ⇒ shipped)
            // so a single-orchestration fetch carries the same precedence
            // signal the listing does. Best-effort; failure leaves it unset.
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const isLink = await fs
                .lstat(file)
                .then(s => s.isSymbolicLink())
                .catch(() => false);
              (parsed as Record<string, Json>).__origin = isLink
                ? 'imported'
                : 'shipped';
            }
            return sendJson(res, 200, parsed);
          }

          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: Json;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            // `__origin` is a RUNTIME-ONLY provenance marker (set on read);
            // never persist it, or a round-tripped node would bake a stale
            // origin into the file. Strip before writing. `__pinned` is the
            // loader's closure (agent bodies + subflow trees) attached to a
            // run's snapshot — an editor that round-trips a snapshot into a
            // save would otherwise bake a stale copy of every reachable
            // agent into the orchestration file.
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              delete (parsed as Record<string, Json>).__origin;
              delete (parsed as Record<string, Json>).__pinned;
            }
            // Validate before persisting. Hard schema errors REJECT the save
            // (400) — writing an invalid node would only fail at run time.
            // Lint findings are advisory (unwired `${ref}`, leftover TODO/
            // PLACEHOLDER, code.run heads-up): they NEVER block the save, but
            // ride back on the success response so the editor can surface them.
            const lintWarnings: ReturnType<typeof lintOrchestration> = [];
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const node = parsed as unknown as Node;
              const errors = validateOrchestration(node).filter(
                e => e.severity === 'error',
              );
              if (errors.length > 0) {
                return sendError(
                  res,
                  400,
                  'Invalid orchestration:\n' +
                    errors.map(e => `  - ${e.path}: ${e.message}`).join('\n'),
                );
              }
              lintWarnings.push(...lintOrchestration(node));
            }
            await fs.mkdir(examplesDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
            // Hot-reload any triggers this orch declares. Wrapped in
            // a try so a trigger-registration failure doesn't fail
            // the save itself (the file is already on disk).
            try {
              await refreshTriggers(name);
            } catch (e) {
              console.error(
                `[sammy-pack-api] trigger refresh failed for ${name}:`,
                e,
              );
            }
            // Non-blocking: attach lint warnings to the saved node so a
            // client that ignores them still gets the persisted body back.
            return sendJson(res, 200, { ...(parsed as object), warnings: lintWarnings });
          }

          if (method === 'DELETE') {
            try {
              await fs.unlink(file);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            // Drop any triggers this orch had registered.
            try {
              await refreshTriggers(name);
            } catch (e) {
              console.error(
                `[sammy-pack-api] trigger refresh after delete failed for ${name}:`,
                e,
              );
            }
            res.statusCode = 204;
            return res.end();
          }

          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET    /api/agents              → list of {name, raw}
      // GET    /api/agents/:name        → one agent
      // PUT    /api/agents/:name        → overwrite raw markdown body
      // DELETE /api/agents/:name        → remove
      // (POST /api/agents/scan|import|import-content are handled by their
      // own middlewares registered below — connect's prefix matcher would
      // otherwise swallow them here, so we pass through those subpaths.)
      server.middlewares.use('/api/agents', async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';
          // Let the import / scan / import-content sub-routes handle
          // themselves — they have their own middlewares.
          if (method === 'POST') return next();

          if (!name) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const entries = await fs.readdir(agentsDir).catch(() => [] as string[]);
            const out: Array<{ name: string; raw: string }> = [];
            for (const f of entries) {
              if (!f.endsWith('.md')) continue;
              if (f.toLowerCase() === 'readme.md') continue;
              const full = path.join(agentsDir, f);
              // An entry that resolves to a server state file is not an
              // agent body — see `serverStateFiles`. This listing returns
              // every file's CONTENTS, so a planted link made it a plaintext
              // read of the credential registry on an unauthenticated GET.
              // Skipped rather than 500'd, like the orchestration listing.
              if (await resolvesToServerStateFile(full)) continue;
              const raw = await fs.readFile(full, 'utf8');
              out.push({ name: f.replace(/\.md$/, ''), raw });
            }
            return sendJson(res, 200, out);
          }

          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(agentsDir, `${name}.md`);

          // The loader half of the state-file fence, agent side (see
          // `serverStateFiles`). GET returns the file's contents and PUT
          // writes THROUGH the link — write-through to an imported agent is
          // the documented feature — so a link already on disk was both a
          // credential read and a credential overwrite. 404-shaped: the same
          // answer as a name that does not exist.
          if (
            (method === 'GET' || method === 'PUT') &&
            (await resolvesToServerStateFile(file))
          ) {
            return sendError(res, 404, 'Not found');
          }

          if (method === 'GET') {
            const raw = await fs.readFile(file, 'utf8').catch(() => null);
            if (raw === null) return sendError(res, 404, 'Not found');
            return sendJson(res, 200, { name, raw });
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: { raw?: string };
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            if (typeof parsed.raw !== 'string') {
              return sendError(res, 400, 'Body must include a string `raw` field');
            }
            await fs.mkdir(agentsDir, { recursive: true });
            // fs.writeFile follows symlinks — important: editing an
            // imported (symlinked) agent updates the source file in the
            // origin repo, which is exactly the behavior users expect.
            await fs.writeFile(file, parsed.raw, 'utf8');
            return sendJson(res, 200, { name, raw: parsed.raw });
          }
          if (method === 'DELETE') {
            try {
              await fs.unlink(file);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] agents error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/guide/:name → a docs/ markdown guide as { name, raw }.
      // Read-only. Lets the browser-side "Improve" / "Generate" flows inject
      // the authoring guidelines (docs/AUTHORING_ORCHESTRATIONS.md) into the
      // meta-agent prompts so generated orchestrations follow the framework's
      // conventions. `:name` is restricted to a small allowlist so this can't
      // be used to read arbitrary repo files. The doc is the single source of
      // truth — the client never bundles a stale copy.
      const GUIDE_ALLOWLIST: Record<string, string> = {
        authoring: 'AUTHORING_ORCHESTRATIONS.md',
        patterns: 'patterns.md',
        schema: 'schema.md',
        architecture: 'architecture.md',
        'context-engineering': 'context-engineering.md',
      };
      const docsDir = path.join(root, 'docs');
      server.middlewares.use('/api/guide', async (req, res) => {
        try {
          const method = req.method ?? 'GET';
          if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0] ?? 'authoring';
          const file = GUIDE_ALLOWLIST[name];
          if (!file) return sendError(res, 404, 'Unknown guide');
          const raw = await fs.readFile(path.join(docsDir, file), 'utf8').catch(
            () => null,
          );
          if (raw === null) return sendError(res, 404, 'Not found');
          return sendJson(res, 200, { name, raw });
        } catch (err) {
          console.error('[sammy-pack-api] guide error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/datasets               → list of Dataset
      // GET /api/datasets/:name         → one Dataset
      // PUT /api/datasets/:name         → write
      // DELETE /api/datasets/:name      → remove
      // Same file-backed pattern as /api/orchestrations. Datasets live
      // in `datasets/` at the workspace root and are git-versionable.
      const datasetsDir = path.join(root, 'datasets');
      server.middlewares.use('/api/datasets', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';

          if (!name) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const entries = await fs.readdir(datasetsDir).catch(() => [] as string[]);
            const out: Json[] = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const parsed = await readJsonFile(path.join(datasetsDir, f));
              if (parsed) out.push(parsed);
            }
            return sendJson(res, 200, out);
          }

          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(datasetsDir, `${name}.json`);

          if (method === 'GET') {
            const parsed = await readJsonFile(file);
            if (parsed === null) return sendError(res, 404, 'Not found');
            return sendJson(res, 200, parsed);
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: Json;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            await fs.mkdir(datasetsDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
            return sendJson(res, 200, parsed);
          }
          if (method === 'DELETE') {
            try {
              await fs.unlink(file);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] datasets error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET    /api/memory          → list of memory keys
      // GET    /api/memory/:key     → { key, content, updatedAt } (empty if unset)
      // PUT    /api/memory/:key     → write (body: { content } or a raw string)
      // DELETE /api/memory/:key     → remove
      // Cross-run memory store (src/server/memory-store.ts). A missing key
      // returns empty content (NOT 404) so a first run starts cold cleanly,
      // then the same flow warms up on later runs. Read it at run start (pass
      // as the `memory` input), write the run's updated-memory output back here.
      const memoryDir = path.join(root, 'memory-store');
      server.middlewares.use('/api/memory', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const key = segs[0];
          const method = req.method ?? 'GET';

          if (!key) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            return sendJson(res, 200, await listMemoryKeys(memoryDir));
          }
          if (!isSafeMemoryKey(key)) return sendError(res, 400, 'Invalid memory key');

          if (method === 'GET') {
            return sendJson(res, 200, await readMemory(memoryDir, key));
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let content: string;
            try {
              const parsed = JSON.parse(body);
              content =
                typeof parsed === 'string'
                  ? parsed
                  : String((parsed as { content?: unknown })?.content ?? '');
            } catch {
              return sendError(res, 400, 'Invalid JSON body (expected { content } or a JSON string)');
            }
            return sendJson(res, 200, await writeMemory(memoryDir, key, content, Date.now()));
          }
          if (method === 'DELETE') {
            await deleteMemory(memoryDir, key);
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] memory error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // POST /api/corrections
      // Body: { datasetName, corrected, input?, predicted?, runId?, source? }
      // The calibration flywheel: record a human's override of a judge decision
      // as a labeled row in the named calibration dataset (the corpus GROWS;
      // re-run the eval to re-measure accuracy against real misroutes). Pass a
      // runId and input+predicted are derived from that run, so the caller only
      // has to supply the corrected label.
      server.middlewares.use('/api/corrections', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        try {
          const body = JSON.parse(await readBody(req)) as {
            datasetName?: string;
            corrected?: string;
            input?: string;
            predicted?: string;
            runId?: string;
            source?: string;
          };
          if (!body.datasetName || !body.corrected) {
            return sendError(res, 400, 'datasetName and corrected are required');
          }
          let input = body.input;
          let predicted = body.predicted;
          let source = body.source ?? 'human-override';
          if (body.runId) {
            const run = await store.getRun(body.runId, extractOwnerId(req));
            if (!run) return sendError(res, 404, `run not found: ${body.runId}`);
            const d = deriveDecision(
              run as { initialInput?: string | null; events?: Array<{ type: string; branch?: string }> },
            );
            input = input ?? d.input;
            predicted = predicted ?? d.predicted ?? undefined;
            source = body.source ?? `run:${body.runId}`;
          }
          if (!input) {
            return sendError(res, 400, 'input is required (or pass a runId to derive it)');
          }
          const result = await recordCorrection(
            datasetsDir,
            body.datasetName,
            { input, corrected: body.corrected, predicted, source },
            Date.now(),
          );
          return sendJson(res, 200, result);
        } catch (err) {
          console.error('[sammy-pack-api] corrections error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/evals                  → list of Eval
      // GET /api/evals/:name            → one Eval
      // PUT /api/evals/:name            → write
      // DELETE /api/evals/:name         → remove
      // Same pattern as datasets. evals/ at repo root.
      const evalsDir = path.join(root, 'evals');
      server.middlewares.use('/api/evals', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';

          if (!name) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const entries = await fs.readdir(evalsDir).catch(() => [] as string[]);
            const out: Json[] = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const parsed = await readJsonFile(path.join(evalsDir, f));
              if (parsed) out.push(parsed);
            }
            return sendJson(res, 200, out);
          }

          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(evalsDir, `${name}.json`);

          if (method === 'GET') {
            const parsed = await readJsonFile(file);
            if (parsed === null) return sendError(res, 404, 'Not found');
            return sendJson(res, 200, parsed);
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: Json;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            await fs.mkdir(evalsDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
            return sendJson(res, 200, parsed);
          }
          if (method === 'DELETE') {
            try {
              await fs.unlink(file);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] evals error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/runs              → list run headers (no events) for sidebar
      // GET /api/runs/:id          → one run including full event stream
      // POST /api/runs             → upsert a run (body is the Run JSON, must include id)
      // DELETE /api/runs/:id       → remove a run (cascades to its events)
      //
      // Backed by SQLite (`runs.db`). The legacy file-based store under
      // `runs/*.json` was migrated on boot above and is no longer read.
      server.middlewares.use('/api/runs', async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const id = segs[0];
          const method = req.method ?? 'GET';

          // Reserved sub-routes — let the dedicated middlewares
          // registered below handle them. Without this pass-through,
          // POST /api/runs/start would land here (because Connect
          // prefix-matches /api/runs) and try to treat 'start' as a
          // run id, returning 405. Same for the per-id sub-actions
          // (/cancel, /events, /resume, /fork, /trace, /gate, /replay) —
          // 2-segment paths. `gate` was missing here, so POST
          // /api/runs/:id/gate fell through to the generic `:id` handler
          // below and 405'd (only GET/DELETE) before ever reaching the
          // real gate handler in the second /api/runs middleware. `replay`
          // is reserved for symmetry / forward-compat (no run-level replay
          // handler exists yet — it falls through to next()).
          if (id === 'start') return next();
          if (segs.length === 2 &&
              (segs[1] === 'events' || segs[1] === 'cancel' ||
               segs[1] === 'stop' || segs[1] === 'resume' ||
               segs[1] === 'fork' || segs[1] === 'trace' ||
               segs[1] === 'gate' || segs[1] === 'signal' ||
               segs[1] === 'replay' || segs[1] === 'artifacts')) {
            return next();
          }

          if (!id) {
            if (method === 'GET') {
              // `?limit=N` caps the rows returned — a monitor/poller wants the
              // latest few, not the entire history (which is slow + token-heavy
              // to serialize). Coerce to a positive int; ignore when absent or
              // malformed (the store then applies its own default cap).
              // CLAMPED. `?limit=` was unbounded, so `GET /api/runs?limit=1000000`
              // was a full `SELECT *` of the runs table plus an eventCounts
              // aggregate over every row — an unauthenticated request that
              // saturates the store. The store's own default window is 500;
              // allow a caller to ask for more, up to a ceiling.
              const limitRaw = url.searchParams.get('limit');
              const limitNum = limitRaw != null ? Number(limitRaw) : NaN;
              const limitCap = envPositiveInt('SAMMY_MAX_RUN_LIST_LIMIT', 1000);
              const limit =
                Number.isInteger(limitNum) && limitNum > 0
                  ? Math.min(limitNum, limitCap)
                  : undefined;
              const headers = await store.listRuns(limit, extractOwnerId(req));
              // LIGHTWEIGHT SUMMARIES — never ship events[] here. The list
              // endpoint used to re-fetch every run's full event stream
              // (store.getRun per row) and return events[], which serialized
              // multi-GB across runs with 800–1300 events each and OOM'd the
              // server under the Approvals/Runs pollers. The detail endpoint
              // GET /api/runs/:id still returns full events for the run viewer.
              //
              // `eventVersion` (event count) comes from one bulk GROUP BY, so
              // the client's lazy-hydrate + poll-merge can still detect growth
              // and skip the round-trip for already-hydrated runs. `preview`
              // is a short server-side snippet of the last phase output
              // (run.lastOutput) so the sidebar row + its search-on-output keep
              // working without the events array.
              const counts = await store.eventCounts(headers.map(h => h.id));
              const out = headers.map(h => {
                const last = (h.lastOutput ?? '').trim();
                const preview =
                  last.length > 200 ? last.slice(0, 200) + '…' : last;
                // Stale-gate flag: a paused run past SAMMY_GATE_TTL_HOURS.
                // Read from the sweeper's snapshot (refreshed at boot + every
                // sweep tick) so the LIST never hydrates events; worst-case
                // lag is one sweep interval, which is nothing against a
                // 24h-scale TTL. `pausedSinceMs` is the EPOCH ms the run
                // paused. Guarded on the row still being paused so a run
                // resumed since the last sweep is never mislabeled.
                const staleEntry =
                  h.status === 'paused' ? staleGates.get(h.id) : undefined;
                // Durable-wait park flag. A wait-parked run is 'paused' but
                // is NOT awaiting a human — the Approvals deck must not
                // present it as a reviewable (an eager "approve" would
                // resume it before its deadline/signal). Read straight off
                // the header's stateJson (no event hydration).
                const pendingWait =
                  h.status === 'paused' ? pendingWaitOf(h.stateJson) : null;
                return {
                  id: h.id,
                  orchestrationName: h.orchestrationName,
                  startedAt: h.startedAt,
                  endedAt: h.endedAt ?? undefined,
                  status: h.status,
                  // The Approvals deck keys off this directly — no per-card
                  // getRun just to learn the gated phase.
                  pausedFor: h.pausedFor ?? undefined,
                  eventVersion: counts.get(h.id) ?? 0,
                  // Short recent-output snippet (NOT the events array).
                  preview: preview || undefined,
                  // Bounded (orchestration tree, not events) — replay + the
                  // editor canvas's live-status derivation need it. The BARE
                  // tree: the pinned closure made 50 rows 1.58MB, polled
                  // every 4s by two UI watchers, for a key nothing reads.
                  orchestrationSnapshot:
                    bareSnapshot(h.orchestrationSnapshot) ?? undefined,
                  initialInput: h.initialInput ?? undefined,
                  ...(staleEntry
                    ? { stale: true, pausedSinceMs: staleEntry.pausedSinceMs }
                    : {}),
                  ...(pendingWait ? { pendingWait } : {}),
                };
              });
              return sendJson(res, 200, out);
            }
            if (method === 'POST') {
              const body = await readBody(req);
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return sendError(res, 400, 'Invalid JSON body');
              }
              const run = parsed as {
                id?: string;
                orchestrationName?: string;
                startedAt?: number;
                endedAt?: number;
                status?: string;
                events?: unknown[];
                initialInput?: string;
              };
              if (!run.id || typeof run.id !== 'string' || !isSafeName(run.id)) {
                return sendError(res, 400, 'Run must include a safe `id` string');
              }
              if (
                run.status !== 'running' &&
                run.status !== 'done' &&
                run.status !== 'error' &&
                run.status !== 'cancelled' &&
                run.status !== 'paused'
              ) {
                return sendError(res, 400, `Invalid status: ${run.status}`);
              }
              const orchestrationName = run.orchestrationName ?? 'unknown';
              // Client-reported events are untrusted by construction, and
              // every cost consumer (the SQL sums, `sumCostUsd`, the budget
              // gate) folds `costUsd` with no lower bound — so a mirrored
              // `{type:'phase-end', costUsd:-N}` un-breached the per-owner
              // (and the workspace) cap for the next /runs/start. Validated
              // at this ONE ingestion seam, refused rather than zeroed: a
              // clamp in each sum would re-create the three-way parity
              // burden and silently accept a bad write. The same walk closes
              // the `events:[null]` 500 (the handler read `.type` of null).
              //
              // BOUNDED ABOVE, not just below. Each figure was checked in
              // isolation while every accumulator adds unbounded, so two
              // individually-accepted `1e308` costs summed to Infinity: the
              // workspace total then exceeds every finite cap, so EVERY owner
              // is 402'd (including owners who spent nothing), the 402's own
              // "raise the cap" remedy cannot work, and the figure serialises
              // as JSON `null` so /api/budget/status reports `blocked: true`
              // with no number. A per-event ceiling is what keeps the sums
              // safe without a clamp in each of the three of them: 9e15 per
              // event leaves room for ~1e292 events before a double overflows.
              const events: Array<Record<string, unknown> & { type: string }> = [];
              for (const [i, ev] of (Array.isArray(run.events) ? run.events : []).entries()) {
                if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
                  return sendError(res, 400, `events[${i}] must be an object`);
                }
                const rec = ev as Record<string, unknown>;
                if (typeof rec.type !== 'string' || !rec.type) {
                  return sendError(res, 400, `events[${i}].type must be a non-empty string`);
                }
                for (const field of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
                  const v = rec[field];
                  if (
                    v !== undefined &&
                    v !== null &&
                    !(
                      typeof v === 'number' &&
                      Number.isFinite(v) &&
                      v >= 0 &&
                      v <= Number.MAX_SAFE_INTEGER
                    )
                  ) {
                    return sendError(
                      res,
                      400,
                      `events[${i}].${field} must be a non-negative finite number` +
                        ` (at most ${Number.MAX_SAFE_INTEGER})`,
                    );
                  }
                }
                events.push(rec as Record<string, unknown> & { type: string });
              }
              // The SERVER owns the snapshot; a client-supplied one is
              // dropped. Since resume pins to `orchestrationSnapshot`
              // (and that snapshot carries the subflow trees and agent
              // bodies it executes), a body with status `paused` / `error`
              // plus a snapshot would be a complete execution bundle that
              // /resume runs with this server's credentials and tools — and
              // because a missing file is non-fatal under the pin, the
              // orchestration never has to exist in the workspace.
              //
              // The row still gets a snapshot: the server's OWN copy of the
              // named orchestration, loaded exactly as /runs/start would.
              // Storing null here was the regression — the browser-side
              // executor's completion mirror (`saveRun`) is how Replay /
              // Rerun light up in the default in-browser executor mode, the
              // UI hides both when the snapshot is absent, and the next
              // list poll (4s) replaced the client's copy with the server's
              // null. A name that is not in the workspace stores null, and
              // such a run resumes by name as every run did before the pin.
              //
              // A server state file is never an orchestration (see
              // `namesServerStateFile`): the loader would hand back the
              // credential registry itself and this row would carry it as
              // `orchestrationSnapshot`, which the run list and the run
              // detail republish in plaintext. 404-shaped, as the
              // orchestration routes answer for the same name.
              if (await namesServerStateFile(orchestrationName)) {
                return sendError(res, 404, 'Not found');
              }
              const mirrorCtx = await loadRunContext(orchestrationName);
              await store.upsertRun({
                id: run.id,
                orchestrationName,
                ownerId: extractOwnerId(req),
                startedAt:
                  typeof run.startedAt === 'number'
                    ? run.startedAt
                    : Date.now(),
                endedAt: run.endedAt ?? null,
                status: run.status,
                events,
                orchestrationSnapshot: mirrorCtx?.orchestration ?? null,
                initialInput: run.initialInput ?? null,
              });
              // Echo what was stored, not what was sent.
              const echo = { ...(parsed as Record<string, unknown>) };
              delete echo.orchestrationSnapshot;
              return sendJson(res, 200, echo);
            }
            return sendError(res, 405, 'Method not allowed');
          }

          if (!isSafeName(id)) return sendError(res, 400, 'Invalid id');

          // GET /api/runs/:id/summary  (alias: /status) → a LIGHTWEIGHT status
          // snapshot (header + event-derived counts + current phase + live
          // cost, NO events array). The detail endpoint below ships the full
          // event stream (>1MB on a big run); this one is what a monitor/poller
          // wants — cheap to fetch, cheap to serialize. Mirrors the sibling GET
          // /api/runs/:id (not owner-filtered either) — 404 when missing.
          if (segs.length === 2 && (segs[1] === 'summary' || segs[1] === 'status')) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const summary = await store.getRunSummary(id, extractOwnerId(req));
            if (!summary) return sendError(res, 404, 'Not found');
            return sendJson(res, 200, summary);
          }

          if (method === 'GET') {
            const run = await store.getRun(id, extractOwnerId(req));
            if (!run) return sendError(res, 404, 'Not found');
            // Incremental poll: `?since=<n>` returns only the events at index
            // >= n (n = the count of events the caller has already seen), so a
            // watcher polling a growing run ships only the delta instead of the
            // full array each time (the stream reached ~1800 events on a big
            // run). `eventVersion` stays the FULL count so the caller advances
            // its cursor; costUsd/divergence/notes/degraded are still computed
            // over the WHOLE stream. Absent / malformed `since` → full events,
            // exactly as before (the UI never passes it).
            const sinceRaw = url.searchParams.get('since');
            const sinceNum = sinceRaw != null ? Number(sinceRaw) : NaN;
            const since =
              Number.isInteger(sinceNum) && sinceNum >= 0 ? sinceNum : null;
            // `slice(since)` naturally yields [] for a cursor at/past the end
            // (a stale/over-run cursor re-processes nothing), and the full
            // array when `since` is absent.
            const eventsOut =
              since != null ? run.events.slice(since) : run.events;
            // Run-level thrash verdict + the structured run-end summary, derived
            // on-the-fly from the events we already loaded (cheap O(events) scan,
            // no schema change, can't drift from the stream). Mirrors how the
            // degraded verdict rides the run record. `notes` gives a UI / poller
            // the per-item picture (verdicts + retries-used + health flags)
            // without reconstructing it from the raw event log.
            const divergence = computeDivergence(run.events);
            const notes = computeRunNotes(run.events, {
              runId: run.id,
              status: run.status,
              degradation: {
                degraded: run.degraded,
                reasons: run.degradationReasons,
              },
              divergence,
            });
            // Stale-gate fields for a paused run, derived PRECISELY here (the
            // events are already loaded — unlike the list, which reads the
            // sweeper's snapshot). `pausedSinceMs` = EPOCH ms of the latest
            // run-paused event (fallback: the header's last write); `stale` =
            // that pause has outlived SAMMY_GATE_TTL_HOURS. Omitted entirely
            // for non-paused runs so their envelope is unchanged.
            const pausedSinceMs =
              run.status === 'paused'
                ? derivePausedSinceMs(run.events, run.updatedAt)
                : null;
            const stale =
              pausedSinceMs !== null &&
              gateTtl > 0 &&
              Date.now() - pausedSinceMs >= gateTtl;
            // Shape mirrors the legacy JSON-file response + the
            // checkpoint columns added in Slice 3 (completedLeaves,
            // stateJson, pausedFor, lastOutput). The UI Resume
            // button needs `status` + the SSE stream needs nothing
            // more, but exposing the checkpoint columns lets the
            // run-detail view show "paused at phase X with N
            // already-completed leaves" without a separate fetch.
            return sendJson(res, 200, {
              id: run.id,
              orchestrationName: run.orchestrationName,
              startedAt: run.startedAt,
              // Explicit null (not omitted): `?? undefined` made JSON.stringify
              // DROP the key entirely, so a consumer couldn't distinguish "not
              // ended" from "field doesn't exist on this server version" —
              // the lifecycle harness had to read the store directly. Same for
              // pausedFor + concurrencyGroup below.
              endedAt: run.endedAt ?? null,
              status: run.status,
              // Full stream by default; only the delta when `?since=<n>` was
              // passed (see above). `eventVersion` is always the FULL count so
              // an incremental poller advances its `since` cursor correctly.
              events: eventsOut,
              eventVersion: run.eventVersion,
              // Spend-to-date in USD, summed from every phase-end (0 when model
              // prices are unknown). Always over the WHOLE stream even under
              // `?since`. Replaces the old always-null cost — a budget-bounded
              // run now reports how much it has burned mid-flight.
              costUsd: sumCostUsd(run.events),
              // The bare tree (Replay diffs it against the current file);
              // the pinned closure stays in the store, for resume only.
              orchestrationSnapshot:
                bareSnapshot(run.orchestrationSnapshot) ?? undefined,
              initialInput: run.initialInput ?? undefined,
              completedLeaves: run.completedLeaves ?? undefined,
              stateJson: run.stateJson ?? undefined,
              pausedFor: run.pausedFor ?? null,
              lastOutput: run.lastOutput ?? undefined,
              // The concurrency group this run holds (stamped at start) —
              // pairs with GET /api/concurrency so "which run blocks group X"
              // and "which group does run Y hold" are answerable from either
              // direction. Null for runs started without a group.
              concurrencyGroup: run.concurrencyGroup ?? null,
              // "done-but-degraded" verdict: status `done` can still mask a
              // swallowed error / partial finalize / fallback. Always present
              // (false / [] for a clean or non-terminal run).
              degraded: run.degraded,
              degradationReasons: run.degradationReasons,
              // Run-level thrash (retry-storm) verdict — `diverged: false` for a
              // healthy run. Always present.
              divergence,
              // Structured run-end summary (per-item verdicts + totals + health
              // flags), derived from the event stream. Always present.
              notes,
              // Stale-gate fields — present only while paused.
              ...(pausedSinceMs !== null ? { pausedSinceMs, stale } : {}),
            });
          }
          if (method === 'DELETE') {
            const doomed = await store.getRun(id).catch(() => null);
            const deleted = await store.deleteRun(id, extractOwnerId(req));
            if (!deleted) return sendError(res, 404, 'Not found');
            // A deleted run's worktree is nobody's any more: discard it (a
            // branch with commits survives — committed work is never thrown
            // away). Before, it stayed on disk with no run to find it by.
            const snap = doomed?.orchestrationSnapshot as Node | null | undefined;
            if (doomed && Array.isArray(snap?.worktrees) && snap.worktrees.length > 0 && !isActiveServerRun(id)) {
              await cleanupWorktrees(snap.worktrees, {
                root,
                runId: id,
                orchestration: String(snap.name ?? doomed.orchestrationName),
                status: 'cancelled',
              }).catch(err => console.warn(`[sammy-pack-api] worktree cleanup for deleted ${id} failed:`, err));
            }
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // POST /api/agents/scan
      // Walks a user-supplied folder for .md agent files and returns
      // suggested names + previews. Symlink-friendly: doesn't follow
      // recursively unless explicitly asked.
      //
      // Body: { path: string (absolute), recursive?: boolean }
      // Returns: Array<{ suggestedName, sourcePath, preview }>
      //
      // Name derivation:
      //   - <dir>/<role>.md where dir != 'agents'   → suggest `<dir>-<role>`
      //   - <path>/<file>.md (flat)                 → suggest filename
      //   - Skips README.md, COMPONENT.md, hidden files
      server.middlewares.use('/api/agents/scan', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: { path?: string; recursive?: boolean };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const targetPath = body.path?.trim() ?? '';
        if (!targetPath || !path.isAbsolute(targetPath)) {
          return sendError(res, 400, 'path must be an absolute filesystem path');
        }
        // Resolve symlinks FIRST, then confine. This used `path.resolve`,
        // which only normalises `..` segments and never touches a link, so
        // the comment claiming it "resolved symlinks" was false — and there
        // was no confinement at all: any absolute path the server user could
        // read was walked (recursively, on request), and every .md file under
        // it came back with its full path and a 200-char preview. The same
        // roots that confine `/api/agents/import` apply here: the workspace
        // plus whatever the operator listed in SAMMY_IMPORT_ROOTS. Containment
        // runs on the realpath, so a symlink inside an allowed root that
        // points outside it is refused too.
        const resolved = await fs.realpath(targetPath).catch(() => null);
        const stat = resolved ? await fs.stat(resolved).catch(() => null) : null;
        if (!resolved || !stat || !stat.isDirectory()) {
          return sendError(res, 400, `not a directory: ${targetPath}`);
        }
        const roots = await importRoots(root);
        if (!roots.some(r => isInside(r, resolved))) {
          return sendError(
            res,
            400,
            'path is outside the allowed import roots. Add its directory to ' +
              'SAMMY_IMPORT_ROOTS to permit scanning there.',
          );
        }
        const recursive = body.recursive === true;
        try {
          const results = await scanAgentDir(resolved, recursive);
          return sendJson(res, 200, results);
        } catch (err) {
          console.error('[sammy-pack-api] scan error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // POST /api/agents/import
      // Symlinks one or more agent files into the local agents/ dir so
      // they appear in listAgents() like first-class local agents.
      //
      // Body: { sources: Array<{ from: string (absolute), as: string }> }
      // Returns: { imported: string[], skipped: Array<{from, as, reason}> }
      //
      // `as` must be safe-name format (alphanumeric + _ -). Existing
      // files / symlinks at <agentsDir>/<as>.md are NOT overwritten —
      // they're reported in `skipped`.
      server.middlewares.use('/api/agents/import', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: { sources?: Array<{ from?: string; as?: string }> };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const sources = Array.isArray(body.sources) ? body.sources : [];
        if (sources.length === 0) {
          return sendError(res, 400, 'sources array required');
        }
        const imported: string[] = [];
        const copied: string[] = [];
        const skipped: Array<{ from: string; as: string; reason: string }> = [];
        // Make sure agentsDir exists first.
        await fs.mkdir(agentsDir, { recursive: true });
        // Sources are confined to allowlisted roots (the workspace, plus
        // anything in SAMMY_IMPORT_ROOTS). Unconfined, an import symlinked an
        // arbitrary host file into agents/, where the unauthenticated
        // `GET /api/agents/:name` reads it back and `PUT` writes THROUGH the
        // symlink by design — i.e. arbitrary read and write. Confining the
        // source is what makes that intentional write-through safe.
        const roots = await importRoots(root);
        for (const s of sources) {
          const from = (s.from ?? '').trim();
          const as = (s.as ?? '').trim();
          if (!isSafeName(as)) {
            skipped.push({ from, as, reason: `bad name: must match [a-zA-Z0-9_-]+` });
            continue;
          }
          const target = path.join(agentsDir, `${as}.md`);
          // Check existing — don't clobber.
          const exists = await fs.lstat(target).catch(() => null);
          if (exists) {
            skipped.push({ from, as, reason: `already exists at ${target}` });
            continue;
          }
          // Absolute, resolvable, a regular .md FILE, and inside an allowed
          // root — resolved first, then contained, so a symlink inside an
          // allowed root that points outside it is still refused.
          const check = await checkImportSource(from, {
            roots,
            extension: '.md',
            deny: serverStateFiles,
          });
          if (!check.ok) {
            skipped.push({ from, as, reason: check.reason });
            continue;
          }
          try {
            const mode = await linkOrCopy(check.realPath, target);
            imported.push(as);
            if (mode === 'copy') copied.push(as);
          } catch (err) {
            skipped.push({ from, as, reason: (err as Error).message });
          }
        }
        // `copied` ⊆ `imported`: those landed as real copies (Windows
        // without symlink support) and won't track source edits.
        return sendJson(res, 200, { imported, copied, skipped });
      });

      // POST /api/agents/import-content
      // Companion to /api/agents/import — same intent (drop agents into
      // local agents/ so they appear in listAgents()) but takes the
      // file content inline instead of a path. Used by the browser-side
      // folder picker (webkitdirectory), which can't give the server an
      // absolute path due to the browser sandbox.
      //
      // Writes a real .md file (not a symlink). Source changes will NOT
      // propagate — user must re-pick + re-import. Path-based import
      // (above) is the symlink path; this is the copy path.
      //
      // Body: { sources: Array<{ as: string, content: string }> }
      // Returns: { imported: string[], skipped: Array<{as, reason}> }
      server.middlewares.use('/api/agents/import-content', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: { sources?: Array<{ as?: string; content?: string }> };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const sources = Array.isArray(body.sources) ? body.sources : [];
        if (sources.length === 0) {
          return sendError(res, 400, 'sources array required');
        }
        const imported: string[] = [];
        const skipped: Array<{ as: string; reason: string }> = [];
        await fs.mkdir(agentsDir, { recursive: true });
        for (const s of sources) {
          const as = (s.as ?? '').trim();
          const content = s.content ?? '';
          if (!isSafeName(as)) {
            skipped.push({ as, reason: 'bad name: must match [a-zA-Z0-9_-]+' });
            continue;
          }
          if (typeof content !== 'string') {
            skipped.push({ as, reason: 'content must be a string' });
            continue;
          }
          const target = path.join(agentsDir, `${as}.md`);
          const exists = await fs.lstat(target).catch(() => null);
          if (exists) {
            skipped.push({ as, reason: `already exists at ${target}` });
            continue;
          }
          try {
            await fs.writeFile(target, content, 'utf8');
            imported.push(as);
          } catch (err) {
            skipped.push({ as, reason: (err as Error).message });
          }
        }
        return sendJson(res, 200, { imported, skipped });
      });

      // POST /api/orchestrations/import
      // Symlinks orchestration .json file(s) into the local examples/ dir so
      // they appear in GET /api/orchestrations like first-class local
      // orchestrations — the execution-side parallel to /api/agents/import.
      // `from` is an absolute path to a single .json OR a folder (every .json
      // inside is imported). Imports register in .git/info/exclude so
      // consumer-side orchestrations never show as a change in sammy-pack's
      // git (same as the CLI sync-to-sammy.sh). Existing files are not
      // overwritten — they're reported in `skipped`.
      //
      // Body: { from: string (absolute file or dir), as?: string }
      // Returns: { imported: string[], skipped: Array<{from, as, reason}> }
      server.middlewares.use('/api/orchestrations/import', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: { from?: string; as?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const from = (body.from ?? '').trim();
        if (!from || !path.isAbsolute(from)) {
          return sendError(
            res,
            400,
            'from must be an absolute path (a .json file or a folder)',
          );
        }
        const fromStat = await fs.stat(from).catch(() => null);
        if (!fromStat) return sendError(res, 404, `not found: ${from}`);

        // Same confinement as the agent import: resolve, then require the
        // source to sit inside an allowlisted root. A directory is checked as
        // a directory; each file it yields is re-checked individually below,
        // so a symlinked entry inside an allowed folder cannot escape.
        const orchRoots = await importRoots(root);
        const fromReal = await fs.realpath(from).catch(() => null);
        if (
          !fromReal ||
          !orchRoots.some(r => {
            const rel = path.relative(r, fromReal);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          })
        ) {
          return sendError(
            res,
            400,
            'from is outside the allowed import roots. Add its directory to ' +
              'SAMMY_IMPORT_ROOTS to permit importing from there.',
          );
        }

        // A folder → every *.json inside; a single file → just itself.
        const sources: Array<{ src: string; name: string }> = [];
        if (fromStat.isDirectory()) {
          const entries = await fs.readdir(from).catch(() => [] as string[]);
          for (const f of entries) {
            if (f.endsWith('.json'))
              sources.push({
                src: path.join(from, f),
                name: f.replace(/\.json$/, ''),
              });
          }
        } else {
          const name =
            (body.as ?? '').trim() || path.basename(from).replace(/\.json$/, '');
          sources.push({ src: from, name });
        }

        await fs.mkdir(examplesDir, { recursive: true });

        // Local per-developer ignore so imported symlinks don't dirty git.
        const excludeFile = path.join(root, '.git', 'info', 'exclude');
        const hasGit = !!(await fs
          .stat(path.join(root, '.git'))
          .catch(() => null));
        const excludeLines = hasGit
          ? (await fs.readFile(excludeFile, 'utf8').catch(() => '')).split('\n')
          : [];

        const imported: string[] = [];
        const copied: string[] = [];
        const skipped: Array<{ from: string; as: string; reason: string }> = [];
        for (const { src, name } of sources) {
          if (!isSafeName(name)) {
            skipped.push({
              from: src,
              as: name,
              reason: 'bad name: must match [a-zA-Z0-9_-]+',
            });
            continue;
          }
          const target = path.join(examplesDir, `${name}.json`);
          if (await fs.lstat(target).catch(() => null)) {
            skipped.push({ from: src, as: name, reason: `already exists at ${target}` });
            continue;
          }
          // Re-checked PER FILE, not just for the folder: a symlinked entry
          // inside an allowed directory must not inherit the directory's
          // permission. Resolution happens before containment, so a link
          // pointing outside the roots is refused.
          const srcCheck = await checkImportSource(src, {
            roots: orchRoots,
            extension: '.json',
            deny: serverStateFiles,
          });
          if (!srcCheck.ok) {
            skipped.push({ from: src, as: name, reason: srcCheck.reason });
            continue;
          }
          try {
            const mode = await linkOrCopy(srcCheck.realPath, target);
            imported.push(name);
            if (mode === 'copy') copied.push(name);
            const line = `/examples/${name}.json`;
            if (hasGit && !excludeLines.includes(line)) excludeLines.push(line);
          } catch (err) {
            skipped.push({ from: src, as: name, reason: (err as Error).message });
          }
        }
        if (hasGit && imported.length > 0) {
          await fs
            .writeFile(excludeFile, excludeLines.filter(Boolean).join('\n') + '\n')
            .catch(() => {});
        }
        // Hot-reload triggers for every freshly-imported orchestration —
        // an imported orch that declares a cron/webhook/etc. trigger must
        // register WITHOUT a server restart, exactly like a PUT save does.
        // refreshTriggers is idempotent (it drops this orch's prior
        // entries first), so a re-import never double-registers.
        for (const name of imported) {
          try {
            await refreshTriggers(name);
          } catch (e) {
            console.error(
              `[sammy-pack-api] trigger refresh after import failed for ${name}:`,
              e,
            );
          }
        }
        // `copied` ⊆ `imported`: real copies (Windows w/o symlink), so
        // they won't reflect later edits to the source orchestration.
        return sendJson(res, 200, { imported, copied, skipped });
      });

      // POST /api/llm/stream
      // Server-side LLM proxy that uses the Claude Agent SDK, which reads
      // the user's Claude Code CLI login from ~/.claude/ — so the browser
      // doesn't need an Anthropic API key. SSE streamed back; the wire
      // format matches what app/src/llm/anthropic.ts already parses
      // (text-delta + done with usage).
      //
      // Body: { model, system, messages: [{role, content}], maxTokens? }
      //
      // The user opts into this mode by toggling auth in Settings; the
      // direct-API-key path in anthropic.ts is the default and still works.
      // The operator's permission ceiling for /api/llm/stream, resolved ONCE:
      // it cannot change per request, and the per-request reader warned
      // about an unrecognised value on every call. Default `default` — the
      // SDK's own interactive posture (listed tools are pre-approved via
      // allowedTools; anything else prompts, and a server has no one to
      // answer). An operator opts a shared deployment into anything wider
      // explicitly; an unrecognised value is not silently honoured.
      const streamOperatorMode = envEnum(
        'SAMMY_LLM_STREAM_PERMISSION_MODE',
        STREAM_PERMISSION_MODES,
        'default',
      );
      server.middlewares.use('/api/llm/stream', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: {
          model?: string;
          system?: string;
          messages?: Array<{ role: string; content: string }>;
          maxTokens?: number;
          /** Names of Claude Code built-in tools to expose (Bash, Read,
           *  Write, Edit, Glob, Grep, WebFetch, WebSearch, etc.). When
           *  set, maxTurns is bumped so the agent can loop on tool
           *  results. Empty / undefined → text-only completion. */
          tools?: string[];
          /** Internal agent-loop cap. Defaults to 1 (no tools) or 25
           *  (with tools — matches Claude Code's own default). */
          maxTurns?: number;
          /** SDK permission mode passed straight through to query().
           *  When undefined, falls back to bypassPermissions if tools
           *  are present (today's behavior), otherwise unset. */
          permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
          /** Subagent definitions this call may dispatch via Task. Map
           *  key is the subagent name; value is the full AgentDefinition.
           *  Forwarded as the SDK's `agents` option. */
          subagents?: Record<
            string,
            {
              description: string;
              prompt: string;
              tools?: string[];
              model?: string;
              permissionMode?:
                | 'bypassPermissions'
                | 'acceptEdits'
                | 'plan'
                | 'default';
            }
          >;
          /** Names of MCP servers from the workspace registry. Server
           *  expands them to full configs (with secrets) before handing
           *  to the SDK. Browser never sees server credentials. */
          mcp?: string[];
          /** Reasoning effort level — passed to the SDK as-is. */
          effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
          /** Extended-thinking token cap — passed to the SDK as-is. */
          maxThinkingTokens?: number;
          /** Hook names from the workspace hooks/hooks.json registry.
           *  Server wraps each as a shell-command-bridged HookCallback. */
          hooks?: string[];
        };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const userMessage = body.messages?.[0]?.content ?? '';
        const systemPrompt = body.system ?? '';
        const model = body.model ?? 'claude-sonnet-4-6';
        // ── TOOL GATE for this route ─────────────────────────────────────
        //
        // This endpoint takes `tools`, `permissionMode`, `subagents` (each
        // with its OWN tools and permissionMode), `mcp` and `hooks` straight
        // from the request body and passes them to the SDK. Nothing applied
        // the `sandbox` policy here — no allowlist, no command denylist, no
        // network strip — and `sdk-stream.ts` defaults a call with any tool to
        // `bypassPermissions`. So a single POST was a full agent with shell
        // access, and `SAMMY_ALLOW_CODE_RUN` had no bearing on it: the flag
        // gates the `code.run` NODE, not this route.
        //
        // Two gates, both opt-out-shaped so an existing trusted single-user
        // workflow is unchanged by default:
        //
        //   SAMMY_LLM_STREAM_TOOLS=off   — refuse tool-bearing calls entirely.
        //                                  The right posture for any shared
        //                                  deployment; the orchestration path
        //                                  (which IS sandbox-policed) remains.
        //   SAMMY_LLM_STREAM_TOOL_ALLOWLIST=Read,Grep
        //                                — intersect requested tools with this
        //                                  list, like a sandbox allowlist.
        //
        // And a caller may never choose its own permission mode: escalating to
        // `bypassPermissions` is a server decision, not a request parameter.
        //
        // BOTH GATES ARE TRANSITIVE. A request is tool-bearing through its
        // `subagents` as much as through `tools`: each subagent carries its
        // own `tools` and `permissionMode`, and in the SDK a subagent that
        // OMITS `tools` inherits everything the parent can use. So `tools:
        // []` plus one subagent was a tool-bearing call the off-switch never
        // examined, and the allowlist never reached a subagent's list. The
        // same policing now applies to every subagent: its tools are
        // intersected with the allowlist (an omitted list is pinned to the
        // policed top-level list rather than left to inherit), and a
        // permission mode wider than the operator's is refused by name.
        const streamToolsMode = (
          process.env.SAMMY_LLM_STREAM_TOOLS ?? ''
        ).trim().toLowerCase();
        const requestedTools = Array.isArray(body.tools) ? body.tools : [];
        const requestedSubagents =
          body.subagents &&
          typeof body.subagents === 'object' &&
          !Array.isArray(body.subagents)
            ? body.subagents
            : undefined;
        const toolBearingSubagents = Object.entries(requestedSubagents ?? {})
          .filter(([, s]) => !!s && (!Array.isArray(s.tools) || s.tools.length > 0))
          .map(([n]) => n);
        // Registry MCP servers are tools too: `tools: []` disables only the
        // SDK's built-in preset, while a named server is spawned with its
        // resolved secrets and its tools are listed to the model. The
        // off-switch judged "tool-bearing" by `tools` and `subagents` alone,
        // so `{messages, mcp:[…]}` sailed through the text-only posture.
        const requestedMcp = Array.isArray(body.mcp) ? body.mcp : [];
        if (
          streamToolsMode === 'off' &&
          (requestedTools.length > 0 ||
            toolBearingSubagents.length > 0 ||
            requestedMcp.length > 0)
        ) {
          return sendError(
            res,
            403,
            'Tool-bearing /api/llm/stream calls are disabled ' +
              '(SAMMY_LLM_STREAM_TOOLS=off). Run tool-using work through an ' +
              'orchestration, where the sandbox policy applies.' +
              (toolBearingSubagents.length > 0
                ? ` (tool-bearing subagents: ${toolBearingSubagents.join(', ')})`
                : '') +
              (requestedMcp.length > 0
                ? ` (mcp servers: ${requestedMcp.join(', ')})`
                : ''),
          );
        }
        const streamAllowlist = envList('SAMMY_LLM_STREAM_TOOL_ALLOWLIST');
        /** Intersect a requested tool list with the allowlist (when one is
         *  configured), logging what was dropped. */
        const policeTools = (requested: string[], who: string): string[] => {
          const kept =
            streamAllowlist.length > 0
              ? requested.filter(t => streamAllowlist.includes(t))
              : requested;
          if (kept.length < requested.length) {
            console.warn(
              `[llm/stream] dropped ${who} tools outside ` +
                `SAMMY_LLM_STREAM_TOOL_ALLOWLIST: ${requested
                  .filter(t => !kept.includes(t))
                  .join(', ')}`,
            );
          }
          return kept;
        };
        const tools = policeTools(requestedTools, 'top-level');
        // The policed list is ALSO the SDK's base toolset for this call. The
        // `tools` param only PRE-APPROVES; the SDK still loaded its full
        // default preset, so under `=off` a plain `{messages}` request —
        // which the gate above never examines, having no tools to refuse —
        // ran with every built-in available, and the permission-free ones
        // (Read, Glob, Grep) executed unprompted under mode `default`.
        // Pinning the base set to what the gate allowed (`[]` under =off,
        // where a tool-bearing request never gets this far) makes "no
        // tools" mean no tools.
        const builtinTools = tools;
        // The mode is ALWAYS passed explicitly. `sdk-stream.ts` defaults an
        // undefined mode to `bypassPermissions` whenever tools are present
        // (the orchestration path, which is sandbox-policed, relies on
        // that), so refusing only an EXPLICIT bypass here meant omitting the
        // field produced the very escalation the refusal existed to stop.
        // The operator's SAMMY_LLM_STREAM_PERMISSION_MODE (default
        // `default`) is the ceiling; a caller may narrow it, never widen it.
        // A caller-supplied escalation is refused rather than silently
        // downgraded, so it cannot look like it worked.
        const operatorMode = streamOperatorMode;
        if (escalatesPermissionMode(body.permissionMode, operatorMode)) {
          return sendError(
            res,
            403,
            `permissionMode: "${body.permissionMode}" cannot be requested by a ` +
              `caller (this server allows up to "${operatorMode}" — ` +
              'SAMMY_LLM_STREAM_PERMISSION_MODE). The server decides when a ' +
              'tool call runs unprompted.',
          );
        }
        const permissionMode: StreamPermissionMode =
          (body.permissionMode as StreamPermissionMode | undefined) ?? operatorMode;
        let subagents: typeof body.subagents;
        if (requestedSubagents) {
          subagents = {};
          for (const [subName, spec] of Object.entries(requestedSubagents)) {
            if (!spec || typeof spec !== 'object') continue;
            if (escalatesPermissionMode(spec.permissionMode, operatorMode)) {
              return sendError(
                res,
                403,
                `subagent "${subName}" requests permissionMode: ` +
                  `"${spec.permissionMode}", which cannot be requested by a ` +
                  `caller (this server allows up to "${operatorMode}" — ` +
                  'SAMMY_LLM_STREAM_PERMISSION_MODE).',
              );
            }
            // Omitted = "inherit the parent's tools" in the SDK; pin that to
            // the POLICED top-level list so inheritance cannot out-run the
            // allowlist.
            const subRequested = Array.isArray(spec.tools) ? spec.tools : tools;
            subagents[subName] = {
              ...spec,
              tools: policeTools(subRequested, `subagent "${subName}"`),
              permissionMode: spec.permissionMode ?? permissionMode,
            };
          }
        }

        // Expand MCP server names → full configs from the workspace
        // registry. Names that don't resolve are silently dropped; the
        // SDK would error out at startup if a referenced server were
        // missing, and the agent would proceed without that server's
        // tools available.
        //
        // Secrets resolved into those configs are collected into
        // `injectedSecrets` — the same sink the run-runner threads through
        // `expandConnectionRefsInMcpConfig` — and every chunk relayed below
        // is scrubbed against it. Without the sink a `${connections:…}` ref
        // resolved here joined no redaction set, so an MCP subprocess that
        // echoed its token back (a `-v` curl, a stack trace) streamed it to
        // the browser verbatim. Resolution is owner-scoped like the run
        // path: a credential the caller may not use does not resolve, and
        // so is never collected either.
        const streamOwnerId = extractOwnerId(req);
        const injectedSecrets = new Set<string>();
        let mcpServers: Record<string, unknown> | undefined;
        if (requestedMcp.length > 0) {
          const registry = await loadMcpRegistry();
          const expanded: Record<string, unknown> = {};
          for (const name of requestedMcp) {
            const config = registry[name];
            if (config) {
              // Resolve any `${connections:...}` refs inside the entry
              // so MCP subprocesses spawn with real env values
              // sourced from the connections registry rather than
              // hardcoded secrets in mcp/servers.json.
              expanded[name] = expandConnectionRefsInMcpConfig(config, {
                ownerId: streamOwnerId,
                collectSecretsInto: injectedSecrets,
              });
            }
          }
          if (Object.keys(expanded).length > 0) mcpServers = expanded;
        }
        /** Redact the run-scoped secrets (plus the pattern layer) from the
         *  free text of a chunk before it reaches the wire. */
        const scrubChunk = (
          chunk: import('./src/server/sdk-stream').SdkStreamChunk,
        ): import('./src/server/sdk-stream').SdkStreamChunk => {
          switch (chunk.type) {
            case 'text-delta':
              return { ...chunk, text: scrubSecrets(chunk.text, injectedSecrets) };
            case 'tool-result':
              return { ...chunk, output: scrubSecrets(chunk.output, injectedSecrets) };
            case 'tool-use':
              return { ...chunk, input: scrubDeep(chunk.input, injectedSecrets) };
            default:
              return chunk;
          }
        };

        // Expand hook names → grouped-by-event HookCallbackMatcher map.
        // Same pattern as MCP: browser passes names, server expands +
        // wraps each spec as a callback that bridges to a shell command.
        const requestedHooks = Array.isArray(body.hooks) ? body.hooks : [];
        let hooksOption:
          | Record<string, Array<{ matcher?: string; hooks: Array<(...a: unknown[]) => Promise<unknown>> }>>
          | undefined;
        if (requestedHooks.length > 0) {
          const registry = await loadHooksRegistry();
          const grouped: Record<
            string,
            Array<{ matcher?: string; hooks: Array<(...a: unknown[]) => Promise<unknown>> }>
          > = {};
          for (const name of requestedHooks) {
            const spec = registry[name];
            if (!spec) continue;
            const callback = buildHookCallback(spec);
            (grouped[spec.event] ??= []).push({
              matcher: spec.matcher,
              hooks: [callback as (...a: unknown[]) => Promise<unknown>],
            });
          }
          if (Object.keys(grouped).length > 0) hooksOption = grouped;
        }
        // 100 turns. Heavy agents (multi-agent QA, anything driving
        // a full multi-step UI flow) routinely exceed 25 — they read
        // a context file, take a screenshot, describe the view, tap,
        // re-screenshot, etc., and each is a turn. Real numbers from
        // observed runs: a simulator-driving QA agent can burn ~72 tool
        // calls per phase. 100 was still hitting "Reached maximum
        // number of turns" on long UI-driving flows. 250 gives
        // genuine headroom for tool-heavy flows while still capping
        // runaway loops. Per-phase override via Node.maxTurns lets
        // orchestrations dial it up further (e.g. 500 for multi-stage
        // QA passes) or down for guaranteed-short phases.
        const maxTurns = body.maxTurns ?? 250;

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const emit = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

        // When the browser cancels (closes the SSE fetch), Node fires
        // `close` on the request. Abort the SDK call so the `claude`
        // subprocess gets killed instead of running to completion in
        // the background — that's where the zombie processes were
        // coming from when users cancelled long QA runs.
        const abortController = new AbortController();
        let clientClosed = false;
        req.on('close', () => {
          clientClosed = true;
          abortController.abort();
        });

        try {
          for await (const chunk of streamSdk({
            userMessage,
            systemPrompt,
            model,
            maxTurns,
            abortController,
            tools,
            builtinTools,
            permissionMode,
            subagents,
            mcpServers: mcpServers as
              | Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>
              | undefined,
            effort: body.effort,
            maxThinkingTokens: body.maxThinkingTokens,
            hooks: hooksOption as
              | Partial<
                  Record<
                    import('@anthropic-ai/claude-agent-sdk').HookEvent,
                    import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher[]
                  >
                >
              | undefined,
          })) {
            emit(scrubChunk(chunk));
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (err) {
          // Client-cancelled aborts surface as AbortError / signal-aborted.
          // Don't treat them as failures — silent close is fine.
          const message = (err as Error).message ?? String(err);
          if (clientClosed || /aborted|AbortError/i.test(message)) {
            try {
              res.end();
            } catch {
              /* response already closed */
            }
            return;
          }
          emit({
            type: 'error',
            error: scrubSecrets(decorateAuthError(message), injectedSecrets),
          });
          res.end();
        }
      });

      // ─── Server-owned runs (Tier 1, durable execution) ───
      //
      // The legacy /api/llm/stream above is the browser-driven path: the
      // executor lives in the user's tab and calls the server per leaf
      // phase. The endpoints below own the executor server-side, so a
      // run survives the tab being closed.

      /** Build the StreamFn the server-side executor hands to each leaf
       *  agent dispatch. Closures over the run's AbortController so
       *  cancel() actually kills the in-flight SDK call (otherwise
       *  the SDK keeps running for the full maxTurns even after the
       *  controller is aborted). MCP + hooks names are expanded via
       *  the same workspace registries /api/llm/stream uses. */
      /** Build the `onTerminal` hook for a triggered run. Two jobs:
       *
       *  1. Reactive eventing (P3): publish `<orch>.done` / `<orch>.error`
       *     when the run finishes, fanning out to any orchestration that
       *     subscribes via `triggers: [{ kind: 'events', event: '<orch>.done' }]`.
       *     The event flows through the durable delivery queue, so it's
       *     durable + idempotent + retried like any other trigger. Chain
       *     depth propagates from the producing delivery and is capped
       *     (MAX_EVENT_CHAIN_DEPTH) so reactive chains can't loop forever.
       *  2. `lifecycle.errorOrchestration`: on 'error', start the recovery
       *     orchestration with a JSON envelope of the failure.
       *
       *  Always returns a hook (eventing applies even without a recovery
       *  orchestration). */
      function buildTerminalHook(
        failedOrchName: string,
        failedOrch: import('./src/types').Node,
        ownerId: string,
        // When false, the hook still publishes lifecycle events but does NOT
        // start errorOrchestration recovery — used for recovery runs so an
        // erroring recovery can't cascade/loop (matches the worker path).
        opts?: { cascadeRecovery?: boolean },
      ): (
        info: import('./src/server/run-controller').TerminalInfo,
      ) => Promise<void> {
        const errorOrchName = failedOrch.lifecycle?.errorOrchestration;
        return async ({
          id,
          status,
          error,
          degraded,
          degradationReasons,
          divergence,
          notes,
          terminalWriteError,
        }) => {
          // A TERMINAL THE STORE NEVER RECORDED IS NOT AN OUTCOME YET.
          //
          // When every attempt at the terminal status write fails, the leg
          // still tears itself down and still fires this hook — so nothing
          // downstream is stranded — but the row keeps reading `running`, and
          // is therefore reclaimed as `interrupted` (resumable). With
          // SAMMY_AUTO_RESUME=1 that reclaim RE-EXECUTES the leg, and with the
          // flag off an operator's Resume does the same, so this hook ran a
          // SECOND time for one logical outcome: two `errorOrchestration`
          // recovery runs spending real money, two notify webhooks (which have
          // no idempotency at all), two breaker failure rows counted toward
          // the auto-pause threshold, and a second `<orch>.done`/`.error`
          // publish that the auto-dedupe window cannot collapse because the
          // reclaim cannot happen until the 120s lease lapses and the window
          // is 60s. Repeating once per lease lapse for as long as the write
          // keeps failing.
          //
          // So: no external side effect here, loudly. The authoritative
          // terminal is whichever leg actually records one. The group drain is
          // skipped with the rest — the reclaim drains it when the run is not
          // resumed, and a resumed leg re-takes the group and drains at its
          // own terminal — so a parked fire waits up to the lease TTL instead
          // of being released by a terminal that was never recorded.
          if (terminalWriteError) {
            console.warn(
              `[sammy-pack-api] terminal hook for ${id} SKIPPED — ${status} ` +
                `could not be recorded (${terminalWriteError}). The row still ` +
                'reads `running` and will be reclaimed as `interrupted`; the ' +
                'authoritative terminal is the next leg\'s, so no event, ' +
                'notify, trace, breaker count, drain or recovery run fires here.',
            );
            return;
          }
          // 1) Publish the lifecycle event (done / error only).
          if (status === 'done' || status === 'error') {
            try {
              const parent = await store.findDeliveryByRunId(id);
              const run = await store.getRun(id);
              const body = JSON.stringify({
                runId: id,
                orchestration: failedOrchName,
                status,
                error: error ?? undefined,
                output: run?.lastOutput ?? undefined,
              });
              await publishEvent(
                `${failedOrchName}.${status}`,
                body,
                (parent?.chainDepth ?? 0) + 1,
                ownerId,
              );
            } catch (err) {
              console.error(
                `[sammy-pack-api] event publish for ${id} failed:`,
                err,
              );
            }
          }

          // 1a) Outbound notify-on-terminal webhook. When the orchestration
          //     root declares `notify: { onTerminal: "<url>" }`, POST a small
          //     JSON envelope to it the moment the run hits ANY terminal status
          //     (done / error / cancelled / paused) — an out-of-band signal so
          //     a long unattended run (a nightly sweep) can ping Slack / an
          //     internal collector instead of failing silently. Best-effort and
          //     fire-and-forget (see notify.ts): a slow / dead endpoint never
          //     blocks or fails run finalization; webhook errors are swallowed.
          //     Wrapped so even a store-read hiccup can't break the terminal path.
          if (failedOrch.notify?.onTerminal) {
            try {
              const run = await store.getRun(id);
              fireTerminalNotify({
                notify: failedOrch.notify,
                runId: id,
                orchestration: failedOrchName,
                status,
                lastOutput: run?.lastOutput,
                // Surface the "done-but-degraded" verdict in the notify text so
                // an unattended run can't report a swallowed-error / partial
                // finalize as a clean success.
                degraded,
                degradationReasons,
                // Surface the run-level thrash (retry-storm) verdict + the
                // structured run-end summary so an unattended notify carries the
                // full end-of-run picture (a `RETRY STORM: …` line + per-item
                // verdicts), not just a status.
                divergence,
                notes,
              });
            } catch (err) {
              console.error(
                `[sammy-pack-api] notify.onTerminal for ${id} failed:`,
                err,
              );
            }
          }

          // 1a-quater) Root `worktrees`: apply each entry's cleanup policy at
          //     a TRUE terminal (cleanupWorktrees ignores paused). Never
          //     throws into finalization.
          if (Array.isArray(failedOrch.worktrees) && failedOrch.worktrees.length > 0) {
            try {
              const outcomes = await cleanupWorktrees(failedOrch.worktrees, {
                root,
                runId: id,
                orchestration: failedOrchName,
                status,
              });
              for (const o of outcomes) {
                console.log(
                  `[sammy-pack-api] worktree "${o.name}" for ${id} ${o.action}` +
                    (o.action === 'removed'
                      ? o.branchDeleted
                        ? ` (branch ${o.branch} had no commits — deleted)`
                        : ` (branch ${o.branch} kept)`
                      : ` at ${o.path}${o.reason ? ` — ${o.reason}` : ''}`),
                );
              }
            } catch (err) {
              console.error(`[sammy-pack-api] worktree cleanup for ${id} failed:`, err);
            }
          }

          // 1a-ter) Gate-reached webhook (`notify.onGate`): a run that just
          //     stopped at an approval gate asks for a reviewer right away.
          //     A timed `wait` pause is not a gate and does not fire it.
          if (status === 'paused' && failedOrch.notify?.onGate) {
            try {
              const run = await store.getRun(id);
              if (isGatePause(run)) {
                fireGateNotify({
                  notify: failedOrch.notify,
                  runId: id,
                  orchestration: failedOrchName,
                  gate: run?.pausedFor ?? null,
                  lastOutput: run?.lastOutput,
                  publicUrl: process.env.SAMMY_PUBLIC_URL?.trim() || undefined,
                });
              }
            } catch (err) {
              console.error(`[sammy-pack-api] notify.onGate for ${id} failed:`, err);
            }
          }

          // 1a-bis) OTLP trace push (opt-in via SAMMY_OTLP_ENDPOINT). Ship
          //     the finished run's trace — with its gen_ai.* attributes — to
          //     the configured collector, so runs land in Jaeger / Tempo /
          //     Langfuse-class backends without anything polling
          //     GET /api/runs/:id/trace. TRUE terminals only (a paused run
          //     isn't a finished trace; it pushes when it finally
          //     completes). Fire-and-forget: pushOtlpTrace never throws and
          //     never blocks finalization. Coverage matches this hook (all
          //     start paths); a leg resumed via /resume finalizes without
          //     the hook today, same as notify — known asymmetry.
          if (
            (status === 'done' ||
              status === 'error' ||
              status === 'cancelled') &&
            otlpTracesUrl()
          ) {
            try {
              const run = await store.getRun(id);
              if (run) pushOtlpTrace(run);
            } catch (err) {
              console.error(
                `[sammy-pack-api] otlp push for ${id} failed:`,
                err,
              );
            }
          }

          // 1b) Cron circuit-breaker. A scheduled orchestration that fails on
          //     every fire silently accrues a graveyard of failed runs — so
          //     once a trigger crosses a consecutive-failure threshold, emit a
          //     VISIBLE alert (and, opt-in, auto-pause the cron so it stops
          //     re-firing). Recovery runs (cascadeRecovery === false) are
          //     skipped — they aren't the scheduled trigger. Best-effort:
          //     wrapped so a breaker hiccup can never break run finalization.
          if (opts?.cascadeRecovery !== false) {
            try {
              await maybeTripCronBreaker(id, status);
            } catch (err) {
              console.error(
                `[sammy-pack-api] cron breaker check for ${id} failed:`,
                err,
              );
            }
          }

          // 1c) Concurrency-group drain. When a run that holds a concurrency
          //     group reaches a status that FREES the group (done / error /
          //     cancelled / interrupted — NOT 'paused', which still holds it
          //     and still counts as active), release the next parked fire for
          //     that group (FIFO, one per terminal). This is what lets a
          //     `queue`-policy fire run after the active run finishes. Routed
          //     through the shared seam so the cancel/reject paths (which don't
          //     flow through this hook) drain identically.
          await releaseGroupAndDrainForRun(id, status);

          // 2) lifecycle.errorOrchestration recovery (skipped on recovery
          //    runs — opts.cascadeRecovery === false — to prevent loops).
          if (
            !errorOrchName ||
            status !== 'error' ||
            opts?.cascadeRecovery === false
          ) {
            return;
          }
          const errorCtx = await loadRunContext(errorOrchName);
          if (!errorCtx) {
            console.warn(
              `[sammy-pack-api] lifecycle.errorOrchestration "${errorOrchName}" not in workspace; can't recover ${id}`,
            );
            return;
          }
          const envelope = JSON.stringify({
            failedRunId: id,
            failedOrchestration: failedOrchName,
            error: error ?? 'unknown',
          });
          try {
            // Cap the recovery run's spend too (mid-flight halt). It keeps the
            // no-cascade rule (no onTerminal) so an erroring recovery can't
            // loop; firing the recovery run's own events is a symmetric
            // follow-on (the worker path already does, via a no-cascade hook).
            // Scoped to the SAME owner the recovery run is started under one
            // line below — the cap is per owner, so an unscoped read gated
            // this owner's recovery on the whole workspace's spend.
            const { gate: recoveryGate } = await loadBudgetState(
              budgetFile,
              store,
              ownerId,
            );
            const { id: recoveryId } = await startServerRun({
              store,
              orchestrationName: errorOrchName,
              initialInput: envelope,
              orchestrationSnapshot: errorCtx.orchestration,
              budgetGate: recoveryGate,
              ownerId,
              // The recovery run fires its own lifecycle events but does not
              // cascade recovery (no loops) — full parity with the worker path.
              onTerminal: buildTerminalHook(errorOrchName, errorCtx.orchestration, ownerId, {
                cascadeRecovery: false,
              }),
              buildEventSource: (signal, runId) =>
                buildExecutorSource(
                  errorCtx,
                  { initialInput: envelope, ownerId, runId },
                  signal,
                ),
            });
            console.log(
              `[sammy-pack-api] lifecycle.errorOrchestration "${errorOrchName}" dispatched as ${recoveryId} for failed ${id}`,
            );
          } catch (err) {
            console.error(
              `[sammy-pack-api] errorOrchestration dispatch failed for ${id}:`,
              err,
            );
          }
        };
      }

      // ─── Triggers (webhook + cron) — hot-reloadable ────────────
      //
      // Orchestrations declare their entry points via root-level
      // `triggers: [...]`. Webhook triggers route through ONE
      // umbrella middleware below; cron triggers schedule a callback
      // per task. State is kept in mutable maps so saving an
      // orchestration (PUT /api/orchestrations/:name) can re-register
      // its triggers without a server restart. (`cron` is a top-level import —
      // it loads on every boot anyway, and a static import keeps the boot free
      // of a dynamic import the jest runtime can't resolve.)
      type WebhookEntry = {
        orchName: string;
        method: string;
        /** The signature scheme to enforce, or null for an open endpoint.
         *  `signed: true` → 'sammy'; `signed: "<provider>"` → that provider. */
        signed: WebhookProvider | null;
      };
      const webhookTriggers = new Map<string, WebhookEntry>(); // path → entry
      // Schedule-fired tasks carry the declared trigger alongside `stop` so the
      // introspection endpoint (GET /api/triggers) can surface their config
      // (cron expr / polling source+interval) — the bare task object exposes
      // neither. `trigger` is the concrete declared variant for the kind.
      type ScheduleTask<T extends import('./src/types').Trigger> = {
        stop: () => void;
        trigger: T;
      };
      const cronTasksByOrch = new Map<
        string,
        Array<ScheduleTask<Extract<import('./src/types').Trigger, { kind: 'cron' }>>>
      >();
      // ─── Cron registration must be PROCESS-GLOBALLY idempotent ─────────
      // node-cron keeps a single process-wide task registry, but
      // `cronTasksByOrch` lives in THIS mountSammyApi closure. If the dev
      // server re-mounts (vite restart / HMR) without ending the process, the
      // previous closure's still-running cron tasks become invisible to the
      // new map — `refreshTriggersForOrch` can't stop what it can't see — so a
      // daily cron ends up scheduled dozens of times and fires a stampede of
      // simultaneous runs at the trigger minute (this is what melted the
      // laptop). Keying every task with a deterministic name and destroy()ing
      // any pre-existing task with that name before (re)scheduling makes
      // registration idempotent across the WHOLE process, not just one mount.
      const cronTaskName = (orchName: string, expr: string) =>
        `sammy:cron:${orchName}:${expr}`;
      const destroyLeakedCronTasksFor = (orchName: string) => {
        const prefix = `sammy:cron:${orchName}:`;
        const getTasks = (cron as unknown as {
          getTasks?: () => Map<string, { name?: string; destroy?: () => void }>;
        }).getTasks;
        if (typeof getTasks !== 'function') return;
        for (const task of getTasks().values()) {
          if (typeof task?.name === 'string' && task.name.startsWith(prefix)) {
            try {
              task.destroy?.();
            } catch {
              /* already destroyed */
            }
          }
        }
      };

      // ─── Cron circuit-breaker ──────────────────────────────────────────
      //
      // PROBLEM: a scheduled (cron) orchestration that fails on EVERY fire
      // silently accrues a graveyard of failed runs — 20+ consecutive errors
      // over days go unnoticed because nothing escalates.
      //
      // FIX: when a CRON-triggered run reaches a terminal status, record the
      // outcome keyed by the trigger's STABLE identity (`cron:<orch>:<expr>` —
      // exactly the prefix the cron fire's idempotency key uses, minus the
      // per-fire time bucket) and read the trailing run of consecutive
      // failures. Past the threshold (default 3, override via
      // SAMMY_CRON_FAILURE_THRESHOLD) emit a VISIBLE console.warn alert with
      // the trigger key + count + last run id.
      //
      // AUTO-PAUSE is OPT-IN + SAFE: only when SAMMY_CRON_AUTO_PAUSE=1 do we
      // also STOP that trigger's node-cron task(s) so it stops re-firing — and
      // we log that it was auto-paused (visible, never silently gone). WITHOUT
      // the flag we ALERT ONLY and never disable a live cron by surprise. A
      // restart re-registers the trigger from its declaration (the pause is
      // process-local, not persisted) — intentional: the operator stays in
      // control and the alert keeps firing until they fix or disable it.
      //
      // Only the run's TRIGGER identity is needed; we recover it from the
      // producing delivery (cron deliveries carry kind='cron', name=<expr>).
      // Non-cron and untriggered (manual) runs are no-ops here.
      const cronAutoPause = process.env.SAMMY_CRON_AUTO_PAUSE === '1';
      async function maybeTripCronBreaker(
        runId: string,
        status: import('./src/server/run-store').RunStatus,
      ): Promise<void> {
        const parent = await store.findDeliveryByRunId(runId);
        if (!parent || parent.kind !== 'cron') return; // not a cron fire
        return tripCronBreakerFor(parent.orchestrationName, parent.name, runId, status);
      }

      /** The breaker body, reachable WITHOUT a run.
       *
       *  Split out because a cron tick shed by the queue-depth cap produces
       *  no run at all, so it could not be routed through the lookup above —
       *  and a schedule whose every tick is being dropped deserves the same
       *  alert as one whose every run fails. `outcomeId` is a run id when
       *  there is one, otherwise the delivery id. */
      async function tripCronBreakerFor(
        orchName: string,
        expr: string,
        outcomeId: string,
        status: string,
      ): Promise<void> {
        const runId = outcomeId;
        const triggerKey = `cron:${orchName}:${expr}`;
        const { failures, threshold, tripped } = await checkConsecutiveFailures(
          store,
          triggerKey,
          runId,
          status,
          cronFailureThreshold(),
        );
        if (!tripped) return;
        console.warn(
          `[sammy-pack-api] CRON ALERT: trigger "${triggerKey}" has ${failures} ` +
            `consecutive non-success fire(s) (>= threshold ${threshold}); ` +
            `last run ${runId} ended "${status}".`,
        );
        if (!cronAutoPause) {
          console.warn(
            `[sammy-pack-api] cron "${triggerKey}" left RUNNING (auto-pause off). ` +
              `Set SAMMY_CRON_AUTO_PAUSE=1 to auto-pause a repeatedly-failing cron.`,
          );
          return;
        }
        // Opt-in auto-pause: stop ONLY the failing schedule's cron task(s) so
        // they stop firing — other schedules on the same orch keep running.
        // Stop both the tasks this mount tracks AND any leaked duplicate from a
        // prior mount with this exact name (from node-cron's global registry),
        // so a re-mount leak can't keep firing the paused schedule.
        let stopped = 0;
        for (const task of cronTasksByOrch.get(orchName) ?? []) {
          if (task.trigger.expr !== expr) continue; // only the failing schedule
          try {
            task.stop();
            stopped += 1;
          } catch {
            /* already stopped */
          }
        }
        const exactName = cronTaskName(orchName, expr);
        const getTasks = (cron as unknown as {
          getTasks?: () => Map<string, { name?: string; destroy?: () => void }>;
        }).getTasks;
        if (typeof getTasks === 'function') {
          for (const task of getTasks().values()) {
            if (task?.name === exactName) {
              try {
                task.destroy?.();
              } catch {
                /* already destroyed */
              }
            }
          }
        }
        pausedCronSchedules.add(pausedCronKey(orchName, expr));
        console.warn(
          `[sammy-pack-api] cron "${triggerKey}" AUTO-PAUSED ` +
            `(SAMMY_CRON_AUTO_PAUSE=1) after ${failures} consecutive failures — ` +
            `${stopped} task(s) stopped; it will not re-fire until re-registered ` +
            `(server restart or PUT /api/orchestrations/${orchName}).`,
        );
      }

      // Named HTTP-fired triggers — fire via POST /api/<ns>/<name>. One name
      // can fan out to multiple orchestrations (subscribers). `signedBy`
      // tracks which subscribers demand a signature AND which scheme each
      // asked for — if ANY does, the endpoint requires one (strictest wins,
      // same rule as sandbox merging). Subscribers that demand DIFFERENT
      // providers are a configuration conflict: no single caller could
      // satisfy both, so the fire is refused with a message naming them
      // rather than quietly enforcing whichever registered first.
      type NamedTriggerEntry = {
        orchNames: string[];
        signedBy: Array<{ orch: string; provider: WebhookProvider }>;
      };
      const eventTriggers = new Map<string, NamedTriggerEntry>(); // event       → subscribers
      const deployTriggers = new Map<string, NamedTriggerEntry>(); // environment → subscribers
      const queueTriggers = new Map<string, NamedTriggerEntry>(); // queue       → subscribers
      // Polling tasks (setInterval) per orch, cleared like cron tasks.
      const pollTasksByOrch = new Map<
        string,
        Array<ScheduleTask<Extract<import('./src/types').Trigger, { kind: 'polling' }>>>
      >();
      // Descriptive catalog of every registered trigger, per orch — powers
      // GET /api/trigger-catalog (P5 observability) since cron/polling
      // details aren't otherwise queryable from their task maps.
      type CatalogEntry = {
        orchestration: string;
        kind: string;
        summary: string;
        /** The scheme enforced on this trigger's ingress, when signed. */
        signed?: WebhookProvider;
      };
      const triggerCatalog = new Map<string, CatalogEntry[]>();
      // Root-level declarations read in the SAME pass that registers triggers
      // (the orchestration file is already parsed there), kept fresh by the
      // same hot-reload path — so the queue-visibility endpoint
      // (/api/concurrency), the trigger list's `blockedBy`, and the boot
      // banner's halt-at-preflight warning never re-walk the workspace:
      //   - `concurrencyByOrch` — the normalized `concurrency` block (group +
      //     defaulted policy) per orchestration that declares one.
      //   - `codeRunOrchs` — orchestrations whose tree uses the `code.run`
      //     escape hatch (the executor's own preflight walker, shared — see
      //     orchestrationUsesCodeRun).
      const concurrencyByOrch = new Map<
        string,
        Required<OrchestrationConcurrency>
      >();
      /** Cron schedules the breaker auto-paused, keyed `<orch>\u0000<expr>`.
       *
       *  Needed because the pause stopped the task but left its entry in
       *  `cronTasksByOrch`, so GET /api/triggers and the boot banner kept
       *  reporting the schedule as live — the one surface that answers "is my
       *  cron running?" said yes about a trigger that had been disabled.
       *  Re-registration (restart or PUT) clears it, matching when the task
       *  actually comes back. */
      const pausedCronSchedules = new Set<string>();
      const pausedCronKey = (orchName: string, expr: string) =>
        `${orchName}\u0000${expr}`;
      const codeRunOrchs = new Set<string>();
      const dropOrchFrom = (m: Map<string, NamedTriggerEntry>, orch: string) => {
        for (const [k, e] of m) {
          const orchNames = e.orchNames.filter(o => o !== orch);
          const signedBy = e.signedBy.filter(s => s.orch !== orch);
          if (orchNames.length) m.set(k, { orchNames, signedBy });
          else m.delete(k);
        }
      };
      const addOrchTo = (
        m: Map<string, NamedTriggerEntry>,
        key: string,
        orch: string,
        provider: WebhookProvider | null,
      ) => {
        const e = m.get(key) ?? { orchNames: [], signedBy: [] };
        if (!e.orchNames.includes(orch)) e.orchNames.push(orch);
        if (provider && !e.signedBy.some(s => s.orch === orch)) {
          e.signedBy.push({ orch, provider });
        }
        m.set(key, e);
      };
      /** The one scheme a named trigger's endpoint enforces. null = open.
       *  Two subscribers naming different providers cannot both be satisfied
       *  by one request, so that returns a conflict instead of a winner. */
      const resolveNamedProvider = (
        e: NamedTriggerEntry,
      ): { provider: WebhookProvider | null } | { conflict: string } => {
        if (e.signedBy.length === 0) return { provider: null };
        const distinct = [...new Set(e.signedBy.map(s => s.provider))];
        if (distinct.length === 1) return { provider: distinct[0] };
        return {
          conflict: e.signedBy
            .map(s => `${s.orch} wants "${s.provider}"`)
            .join('; '),
        };
      };
      // One nonce cache for ALL signed ingress (TTL 2× the signature
      // tolerance window). Created once per server process.
      const ingressNonces = new NonceCache();
      // Receiver-side A2A idempotency (metadata.idempotencyKey → run id),
      // also per-process. See src/server/a2a-idempotency.ts.
      const a2aIdempotency = new A2aIdempotencyCache();
      /** Read a trigger fire's body as RAW BYTES, answering 413 if it blows
       *  the cap. Returns null when it has already responded.
       *
       *  Raw bytes, not a string: every signature scheme HMACs the exact
       *  bytes received, and decoding to UTF-8 first mangles any
       *  non-UTF-8 sequence into U+FFFD — which makes a genuinely signed
       *  delivery fail verification with nothing in the logs to explain it. */
      const readFireBody = async (
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse,
        what: string,
      ): Promise<Buffer | null> => {
        try {
          return await readBodyBuffer(req as Connect.IncomingMessage);
        } catch (err) {
          if ((err as { code?: string })?.code === 'BODY_TOO_LARGE') {
            sendError(res, 413, `${what}: ${(err as Error).message}`);
            return null;
          }
          // A transport error mid-upload: treat as an empty body, which for a
          // signed trigger fails the signature and for an unsigned one starts
          // a run with no input — the pre-existing behaviour.
          return Buffer.alloc(0);
        }
      };
      /** Enforce a signed trigger's signature on its firing HTTP request.
       *  Returns true if the request may proceed; otherwise the error
       *  response has already been sent.
       *
       *  `provider` is 'sammy' for `signed: true` — the native
       *  X-Sammy-Signature scheme, replay-protected v2 (`t=…[,n=…],v1=…` over
       *  `t.n.body`) or legacy `sha256=<hex of body>` — and otherwise names a
       *  third-party scheme verified by `provider-signatures.ts` (GitHub's
       *  X-Hub-Signature-256, Stripe-Signature, and so on). `body` must be
       *  the RAW received bytes: every scheme HMACs those, so a parsed and
       *  re-serialized body never verifies.
       *
       *  The nonce cache applies only to the native scheme. Providers retry
       *  deliveries, so rejecting a repeat as a replay would drop real
       *  events — their timestamp window plus the delivery layer's
       *  idempotency key do that job instead. */
      const requireSignature = (
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse,
        body: string | Buffer,
        what: string,
        provider: WebhookProvider = 'sammy',
      ): boolean => {
        const secret = process.env.SAMMY_WEBHOOK_SECRET?.trim();
        if (!secret) {
          sendError(
            res,
            500,
            `${what} requires a signature but SAMMY_WEBHOOK_SECRET is not configured`,
          );
          return false;
        }
        let verdict: { ok: true } | { ok: false; reason: string };
        if (provider === 'sammy') {
          const sig = req.headers['x-sammy-signature'];
          verdict = verifySignature(body, Array.isArray(sig) ? sig[0] : sig, secret, {
            nonces: ingressNonces,
          });
        } else {
          verdict = verifyProviderSignature(provider, {
            body,
            headers: req.headers,
            secret,
          });
        }
        if (!verdict.ok) {
          sendError(
            res,
            401,
            `${what}: invalid or missing ${providerHeaders(provider).join(' + ')} ` +
              `(${verdict.reason}). Send ${describeProviderScheme(provider)}.`,
          );
          return false;
        }
        return true;
      };
      /** SAMMY_REQUIRE_SIGNED_TRIGGERS=1 — refuse any HTTP-fired trigger
       *  that is not marked `signed`, at fire time. Every exemption the auth
       *  gates grant ingress rests on "it authenticates by per-trigger HMAC",
       *  and that is only true of triggers an author remembered to mark
       *  `signed`; an unmarked one is an open endpoint that starts runs. The
       *  default stays permissive (a local workspace's open webhook keeps
       *  working); a shared deployment sets this so forgetting `signed` is a
       *  403 at the first fire rather than an open door, and the boot banner
       *  names every trigger the flag will refuse. */
      // Fails CLOSED: an operator who set this to anything meant to refuse.
      const requireSignedTriggers = envFlag('SAMMY_REQUIRE_SIGNED_TRIGGERS', {
        failClosed: true,
      });
      const refuseUnsignedIngress = (
        res: import('http').ServerResponse,
        what: string,
      ): void =>
        sendError(
          res,
          403,
          `${what} is not marked \`signed\` and this server requires signed ` +
            'trigger ingress (SAMMY_REQUIRE_SIGNED_TRIGGERS=1). Declare ' +
            '`signed: true` (or a provider name) on the trigger.',
        );
      /** Enforce a named trigger's scheme, refusing a subscriber conflict
       *  loudly instead of silently picking one. */
      const requireNamedSignature = (
        req: import('http').IncomingMessage,
        res: import('http').ServerResponse,
        body: string | Buffer,
        what: string,
        entry: NamedTriggerEntry,
      ): boolean => {
        const resolved = resolveNamedProvider(entry);
        if ('conflict' in resolved) {
          sendError(
            res,
            500,
            `${what} has conflicting signature providers across its subscribers ` +
              `(${resolved.conflict}). No single caller can satisfy both — give ` +
              'them the same `signed` value, or split them onto separate names.',
          );
          return false;
        }
        if (!resolved.provider) return true;
        return requireSignature(req, res, body, what, resolved.provider);
      };
      // Delegated to the shared trigger-kind registry (src/trigger-kinds.ts)
      // so a kind's summary lives in one place — see that module + the ADR.
      const describeTrigger = describeTriggerKind;

      // ─── Concurrency groups — mutual exclusion for shared-resource runs ───
      //
      // An orchestration whose root declares `concurrency: { group, policy }`
      // must not run concurrently with another run in the SAME opaque group.
      // `startRunWithConcurrency` is the start-gate: BEFORE creating a run it
      // checks `findActiveRunsInGroup`, and applies the policy
      // (skip / queue / cancel-existing). The whole check-and-create runs under
      // an in-process per-group lock so two near-simultaneous same-process
      // fires can't both pass the "no active" check (cross-process exclusion is
      // a documented follow-up — see concurrency-group.ts). The terminal drain
      // (buildTerminalHook below) releases a queued fire when a run frees its
      // group. DEFENSIVE: any error inside the concurrency logic falls back to
      // simply starting the run — concurrency must never crash the start path.
      // CROSS-PROCESS, not just in-process: an in-memory mutex alone let two
      // servers (or a server plus the standalone worker) sharing one store
      // both pass the "no active run in this group" check at the same instant.
      // The wrapper still takes the local mutex first, so same-process
      // contention never reaches the database.
      const groupLock = new DurableGroupLock(store, {
        holder: `api-${process.pid}-${randomUUID().slice(0, 8)}`,
        log: m => console.warn(`[concurrency] ${m}`),
      });

      type StartOutcome =
        | { outcome: 'started'; id: string }
        | { outcome: 'skipped' }
        | { outcome: 'queued' };

      /** The start-gate. Wraps `startServerRun`: for an orchestration with a
       *  `concurrency.group`, serializes a check-and-create under the per-group
       *  lock and honors the policy; otherwise starts the run directly. The
       *  caller supplies the orchestration node (to read its group) and the
       *  pending-fire payload (used only when the policy parks the fire). */
      async function startRunWithConcurrency(
        orchestration: import('./src/types').Node,
        startOptsIn: Omit<
          Parameters<typeof startServerRun>[0],
          'concurrencyGroup'
        >,
        pending: {
          orchName: string;
          initialInput: string | null;
          ownerId: string;
          resolvedInputs?: Record<string, string> | null;
        },
        /** Which trigger kind is firing. Only used to apply the IMPLICIT
         *  per-orchestration group that keeps a cron from overlapping its own
         *  previous run — see `effectiveConcurrency`. */
        triggerKind = 'manual',
        /** The group this fire was PARKED under, when it is being drained off
         *  a pending-fire queue. The drain fires kind `concurrency-drain`, for
         *  which `effectiveConcurrency` returns null (only `cron` gets the
         *  implicit group) — so the drained run used to be created with NO
         *  group. That is worse than it sounds: its own terminal then read a
         *  null group and drained nothing, so an implicit `sammy:cron:<name>`
         *  backlog advanced by at most one fire per later cron tick and
         *  stopped advancing entirely once ticks ceased (trigger edited away,
         *  orchestration deleted, breaker auto-pause) — with /api/concurrency
         *  reporting `held: false` beside a non-empty `queued` and no warning.
         *  Stamping the group it was drained FROM leaves the gate's decision
         *  untouched (the kind still declines to gate this fire) while making
         *  the drained run a real holder: visible to `findActiveRunsInGroup`,
         *  so the next tick parks instead of overlapping, and able to drain
         *  the fire behind it at its own terminal. */
        knownGroup?: string,
      ): Promise<StartOutcome> {
        // Thread the orchestration root's `notify.divergence` (retry-storm
        // watchdog) config into the run start so the controller can warn on —
        // or, opt-in, abort — a thrashing run. Omitting the block = the default
        // WARN-only behavior, so this is purely additive.
        const startOpts = {
          ...startOptsIn,
          divergence: orchestration.notify?.divergence,
        };
        const conc = effectiveConcurrency(
          orchestration,
          triggerKind,
          pending.initialInput,
          ref =>
            console.warn(
              `[concurrency] ${pending.orchName}: group ref \${${ref}} did not resolve ` +
                'from the input — the fire joins the unresolved literal group (serialized)',
            ),
        );
        if (!conc) {
          const { id } = await startServerRun({
            ...startOpts,
            concurrencyGroup: knownGroup ?? null,
          });
          return { outcome: 'started', id };
        }
        const { group, policy } = conc;
        try {
          // The gate is SHORT critical sections with any cancel BETWEEN
          // them, never one long one that cancels from inside the lock.
          //
          // The cancel-existing branch used to await `cancelStoredRunAndDrain`
          // while holding `groupLock.run(group)`. That cancel releases the
          // victim's group and DRAINS the next parked fire — `fireRun` →
          // `startRunWithConcurrency` → `groupLock.run(SAME group)`. The lock
          // is a non-reentrant promise chain, so the drain waited on the
          // section that was waiting on the drain: the start never responded,
          // and every later fire for that group chained behind it for the
          // life of the process. With an active run AND a parked fire in a
          // cancel-existing group — the policy's ordinary steady state — one
          // POST /api/runs/start bricked the group.
          //
          // Now: under the lock, only DECIDE and record the ids to cancel;
          // release; cancel + drain outside; re-enter the lock to start,
          // re-deciding because state has moved — the drain may have started
          // a parked fire that now holds the group, which this policy cancels
          // in turn (newest fire wins). Bounded: after CANCEL_EXISTING_PASSES
          // the run starts anyway, loudly, per the fail-open rule below.
          const CANCEL_EXISTING_PASSES = 3;
          for (let pass = 0; ; pass += 1) {
            const decided = await groupLock.run(
              group,
              async (): Promise<
                StartOutcome | { outcome: 'cancel-existing'; cancelIds: string[] }
              > => {
                const active = await store.findActiveRunsInGroup(group);
                const decision = decideConcurrency(policy, active);
                if (decision.action === 'skip') {
                  console.log(
                    `[concurrency] skipped ${pending.orchName} (group ${group} busy: ${decision.blockingId})`,
                  );
                  return { outcome: 'skipped' };
                }
                if (decision.action === 'queue') {
                  await store.enqueuePendingFire(group, {
                    orchName: pending.orchName,
                    initialInput: pending.initialInput,
                    ownerId: pending.ownerId,
                    resolvedInputs: pending.resolvedInputs ?? null,
                  });
                  console.log(
                    `[concurrency] queued ${pending.orchName} behind ${decision.blockingId}`,
                  );
                  return { outcome: 'queued' };
                }
                if (decision.action === 'cancel-existing') {
                  if (pass < CANCEL_EXISTING_PASSES) {
                    return { outcome: 'cancel-existing', cancelIds: decision.cancelIds };
                  }
                  console.warn(
                    `[concurrency] cancel-existing for ${pending.orchName} (group ` +
                      `${group}): ${decision.cancelIds.join(', ')} still active after ` +
                      `${pass} cancel passes — starting anyway`,
                  );
                }
                // 'start' or post-'cancel-existing' → create, stamping the group.
                const { id } = await startServerRun({ ...startOpts, concurrencyGroup: group });
                return { outcome: 'started', id };
              },
            );
            if (decided.outcome !== 'cancel-existing') return decided;
            // OUTSIDE the lock. Goes through the STORE-path cancel, awaited.
            //
            // It used to call `cancelServerRun(id)` only, which returns
            // false immediately when the run is not in THIS process's
            // in-memory map — so cancelling a peer's run was a silent no-op
            // and the new run started anyway, leaving BOTH executing against
            // the shared resource. For a policy whose entire purpose is "one
            // thing at a time on the staging environment / the device", that
            // is the exact opposite of its contract.
            //
            // `cancelStoredRunAndDrain` is the shared, per-run-serialized
            // seam: it flips the stored row (a peer's run is then fenced
            // out at its next write / renew tick) AND aborts a controller
            // live in THIS process, waiting for it to unwind — flipping the
            // row alone left a local victim executing against its cancelled
            // row for up to a renew tick, and `cancel()` only calls
            // `abort()` and schedules the child reap 1.5s later, so without
            // the wait the new run started while the old one's agent
            // subprocesses were still alive.
            //
            // CANCEL ONLY, no drain. In a group that mixes policies, each
            // pass's drain started the next parked `queue` fire, which took
            // the group, which the next pass cancelled: queued work was
            // destroyed one fire per pass, and after the bounded passes two
            // holders remained. The run started below drains the queue at
            // its own terminal, as every holder does.
            for (const id of decided.cancelIds) {
              try {
                const out = await cancelStoredRunAndDrain(id, { drain: false });
                console.log(
                  `[concurrency] cancel-existing: ${id} → ${out.outcome} ` +
                    `for ${pending.orchName} (group ${group})`,
                );
              } catch (err) {
                console.error(
                  `[concurrency] cancel of ${id} failed (continuing):`,
                  err,
                );
              }
            }
          }
        } catch (err) {
          // The concurrency layer must NEVER break the start path: on any
          // failure (store hiccup, lock bug) fall back to starting the run,
          // still stamping the group so the terminal drain stays coherent.
          console.error(
            `[concurrency] gate for ${pending.orchName} (group ${group}) failed; starting anyway:`,
            err,
          );
          const { id } = await startServerRun({ ...startOpts, concurrencyGroup: group });
          return { outcome: 'started', id };
        }
      }

      /** Release a run's concurrency group + drain the next parked fire — the
       *  SINGLE seam every terminal transition must route through so a slot
       *  can't leak and a queued fire can't get stranded. A run holds its group
       *  while `running` OR `paused` (both count as active in
       *  findActiveRunsInGroup); ANY other terminal status frees it. Reading the
       *  run's group and draining one parked fire (FIFO) is all "releasing"
       *  takes — the status flip itself frees the slot; the drain is what starts
       *  the next waiter. `paused` is a no-op (the run still holds the group).
       *
       *  Called from THREE terminal paths so cancel/reject can't be missed:
       *    - the in-process executor's onTerminal hook (done/error/cancelled),
       *    - the /cancel no-live-controller path (interrupted/paused run), and
       *    - the gate-reject path (a run paused at a lock is cancelled).
       *  Only the first flows through the executor; the latter two write the
       *  cancelled status directly and so must drain explicitly — the bug this
       *  fixes was a queued fire stranded after a gate-reject cancelled the
       *  holder. Best-effort: wrapped so a drain hiccup can NEVER break run
       *  finalization (callers also tolerate a throw). */
      async function releaseGroupAndDrainForRun(
        id: string,
        status: import('./src/server/run-store').RunStatus,
      ): Promise<void> {
        if (status === 'paused') return; // still holds the group — no release.
        try {
          const run = await store.getRun(id);
          const group = run?.concurrencyGroup ?? null;
          if (group) await drainPendingFire(group);
        } catch (err) {
          console.error(
            `[sammy-pack-api] concurrency drain for ${id} failed:`,
            err,
          );
        }
      }

      /** Drain ONE parked fire for a group when a run in it terminates: dequeue
       *  the oldest pending fire (FIFO) and start it via the same path as any
       *  other trigger fire. Best-effort — a drain failure must NEVER break run
       *  finalization (the caller wraps this in try/catch too). One per
       *  terminal: the next terminating run drains the next parked fire. */
      async function drainPendingFire(group: string): Promise<void> {
        const next = await store.dequeueNextPendingFire(group);
        if (!next) return;
        const res = await fireRun(
          next.orchName,
          next.initialInput ?? '',
          'concurrency-drain',
          next.ownerId,
          // The drained run HOLDS the group it was parked under, so its own
          // terminal drains the next fire — without this the queue advanced
          // only when a later grouped fire terminated, and not at all once
          // those stopped arriving.
          group,
          next.resolvedInputs ?? undefined,
        );
        if (res.ok) {
          console.log(
            `[concurrency] drained queued ${next.orchName} → ${res.id} (group ${group})`,
          );
          return;
        }
        // RE-PARK ON A TRANSIENT REFUSAL — the dequeue already DELETED the row.
        //
        // This used to be a lone console.warn, so the parked fire was simply
        // destroyed. And the refusal it most often hits is the budget cap,
        // whose own reason string reads 'budget cap reached — deferring, not
        // dropping'. It was dropped. Same for a workspace that no longer has
        // the orchestration — a transient condition that an operator fixes.
        //
        // It is the same hazard the delivery queue carries — a transient
        // refusal that gets dead-lettered is permanently lost — except here it
        // lands on the pending-fire queue. `queued` is already safe
        // (startRunWithConcurrency re-parks it); `skipped` is a deliberate
        // policy decision and stays dropped.
        // A TRANSIENT or BUDGET refusal becomes a durable `concurrency-drain`
        // DELIVERY rather than a re-park: the group's holder just ended, so
        // nothing else would drain a re-parked fire until some later fire for
        // the group happened to terminate. As a delivery, the worker retries
        // it (transient) or holds it (budget) on its own, and starts it
        // holding the group it was parked under. ('deferred' means the group
        // is busy again — that new holder will drain it, so re-park.)
        if (res.failure === 'transient' || res.failure === 'budget') {
          try {
            const now = Date.now();
            await store.recordDelivery({
              id: newDeliveryId(),
              kind: 'concurrency-drain',
              name: group,
              orchestrationName: next.orchName,
              idempotencyKey: `drain:${encodeURIComponent(group)}:${now}:${Math.random().toString(36).slice(2, 8)}`,
              keySource: 'auto',
              status: 'pending',
              body: next.initialInput ?? '',
              ownerId: next.ownerId,
              receivedAt: now,
              availableAt: now,
              detail: `drained from group ${group}; first start refused: ${res.reason}`,
            });
            deliveryWorker.kick();
            console.warn(
              `[concurrency] drained ${next.orchName} (group ${group}) but the start was ` +
                `refused (${res.reason}) — queued as a durable delivery`,
            );
            return;
          } catch (e) {
            console.error(
              `[concurrency] could not queue the refused drain of ${next.orchName} ` +
                `(group ${group}) as a delivery — re-parking it instead:`,
              e,
            );
          }
        }
        if (
          res.failure === 'transient' ||
          res.failure === 'deferred' ||
          res.failure === 'budget'
        ) {
          try {
            await store.enqueuePendingFire(group, {
              orchName: next.orchName,
              initialInput: next.initialInput,
              ownerId: next.ownerId,
              resolvedInputs: next.resolvedInputs ?? null,
            });
            console.warn(
              `[concurrency] drained ${next.orchName} (group ${group}) but the ` +
                `fire was refused (${res.reason}) — RE-PARKED for the next drain.`,
            );
          } catch (e) {
            // Re-park failed: now it really is lost, so say so loudly rather
            // than at warn level with a message implying it was kept.
            console.error(
              `[concurrency] LOST a parked fire for ${next.orchName} (group ` +
                `${group}): refused (${res.reason}) and re-park failed:`,
              e,
            );
          }
          return;
        }
        console.warn(
          `[concurrency] dropped queued ${next.orchName} (group ${group}): ${res.reason}`,
        );
      }

      // ─── Store-path cancel — the ONE check-cancel-drain critical section ───
      //
      // Three paths cancel a run that has NO live in-process controller (a
      // paused / interrupted / dead-lease run): POST /api/runs/:id/cancel,
      // the gate 'reject' decision, and the stale-gate auto-cancel. Each is
      // check-then-write: read the status, flip to cancelled, append the
      // sentinel, drain the concurrency queue. UNSERIALIZED, two
      // near-simultaneous cancels of the SAME run (a double-clicked Stop, the
      // Runs view's bulk-stop Promise.all racing a single Stop) could BOTH
      // read a non-terminal status and BOTH drain — one holder terminal
      // releasing TWO parked fires, i.e. bulk-cancelling resurrects queued
      // work the operator was shutting down. Serializing per run id (reusing
      // GroupLock, which exists for exactly this check-and-act shape) makes
      // the second caller re-read `cancelled` inside the lock and no-op — one
      // terminal, one drain, no matter how many cancels race. In-process
      // scope matches the rest of the concurrency layer (see
      // concurrency-group.ts on cross-process exclusion).
      const cancelLock = new GroupLock();

      /** How long to wait for a locally-aborted controller to leave the
       *  active map. Abort is asynchronous (the executor unwinds at its next
       *  await) and a wedged tool can hold it, so the wait is bounded and
       *  the cancel proceeds — loudly — if it lapses. */
      const LOCAL_UNWIND_BOUND_MS = 5_000;

      /** Cancel a stored run + release its concurrency group, atomically per
       *  run id. Returns what actually happened so each caller can keep its
       *  own response shape. `drain: false` releases the group WITHOUT
       *  starting the next parked fire (the cancel-existing gate, whose new
       *  run drains at its own terminal). */
      async function cancelStoredRunAndDrain(
        id: string,
        opts?: { drain?: boolean },
      ): Promise<
        | { outcome: 'cancelled' }
        | { outcome: 'already-terminal'; status: string }
        | { outcome: 'not-found' }
      > {
        const terminal = (status: string) =>
          status === 'done' || status === 'error' || status === 'cancelled';
        const flip = (from: import('./src/server/run-store').RunStatus) =>
          store.updateRunStatus(
            id,
            { status: 'cancelled', endedAt: Date.now() },
            // FENCED on the status just read. `resume()` claims a row with
            // its own CAS; an unfenced flip here could land on top of a
            // resume that won the gap between the read and the write —
            // marking a now-live run cancelled without ever aborting it.
            { onlyIfStatus: [from] },
          );
        return cancelLock.run(id, async () => {
          // Re-read INSIDE the lock — the whole point: a cancel that lost the
          // race sees the winner's terminal status here and stops.
          let stored = await store.getRun(id);
          if (!stored) return { outcome: 'not-found' };
          if (terminal(stored.status)) {
            return { outcome: 'already-terminal', status: stored.status };
          }
          if (!(await flip(stored.status))) {
            // Zero rows: the status moved under us (a resume landed, or a
            // peer finished it). Re-read and act on what is there NOW — a
            // run that is `running` falls through to the live-cancel path
            // below instead of being left executing.
            stored = await store.getRun(id);
            if (!stored) return { outcome: 'not-found' };
            if (terminal(stored.status)) {
              return { outcome: 'already-terminal', status: stored.status };
            }
            if (!(await flip(stored.status))) {
              const now = (await store.getRun(id))?.status ?? stored.status;
              return { outcome: 'already-terminal', status: now };
            }
          }
          // A controller live in THIS process does not notice the flip: its
          // lease is lost only at its next event write or renew tick (up to
          // 40s), during which it keeps executing and spawning against a
          // cancelled row. Abort it directly and wait for the unwind. The
          // row is already `cancelled`, so its own terminal write is fenced
          // out and it yields without a drain or a terminal hook — this
          // path owns both.
          //
          // The unwind yields the executor's OWN `run-cancelled`, which the
          // controller persists (the append fence only guards `running`
          // rows). Appending this path's sentinel unconditionally on top
          // recorded TWO — or one, when the renew tick happened to land
          // first and suppressed the executor's. A victim that unwound gets
          // one sentinel: its own, if it wrote one.
          let sentinelLanded = false;
          if (isActiveServerRun(id)) {
            cancelServerRun(id);
            const deadline = Date.now() + LOCAL_UNWIND_BOUND_MS;
            while (isActiveServerRun(id) && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 25));
            }
            if (isActiveServerRun(id)) {
              console.warn(
                `[sammy-pack-api] cancelled ${id} but its local executor had ` +
                  `not unwound within ${LOCAL_UNWIND_BOUND_MS}ms — proceeding; ` +
                  'its next fenced write will stop it.',
              );
            } else {
              sentinelLanded =
                (await store.getRun(id))?.events.some(
                  e => e.type === 'run-cancelled',
                ) ?? false;
            }
          }
          // The appendEvent fence only blocks writes to `running` runs owned
          // elsewhere; the row is `cancelled` now, so the sentinel lands.
          if (!sentinelLanded) {
            await store.appendEvent(id, {
              type: 'run-cancelled',
              ts: Date.now(),
            });
          }
          // These paths bypass the executor's onTerminal hook, so release the
          // concurrency group + drain the next queued fire here — otherwise
          // cancelling a run that held a group strands its FIFO queue.
          if (opts?.drain !== false) {
            await releaseGroupAndDrainForRun(id, 'cancelled');
          }
          // …and apply the run's root `worktrees` cleanup, which the terminal
          // hook would otherwise have done: a run cancelled while paused at a
          // gate used to leave its worktree (and branch) behind forever.
          // The snapshot is what the run actually declared.
          try {
            const snap = stored.orchestrationSnapshot as Node | null;
            if (snap && Array.isArray(snap.worktrees) && snap.worktrees.length > 0) {
              for (const o of await cleanupWorktrees(snap.worktrees, {
                root,
                runId: id,
                orchestration: stored.orchestrationName,
                status: 'cancelled',
              })) {
                console.log(`[sammy-pack-api] worktree "${o.name}" for cancelled ${id} ${o.action}`);
              }
            }
          } catch (err) {
            console.error(`[sammy-pack-api] worktree cleanup for cancelled ${id} failed:`, err);
          }
          return { outcome: 'cancelled' };
        });
      }

      /** Why a fire did not produce a run. The DELIVERY's fate depends on
       *  which, and collapsing them all to one terminal refusal was wrong in
       *  both directions:
       *
       *    'deferred'  — parked on the pending-fire queue behind a busy
       *                  group; it WILL run. Recording this as `rejected`
       *                  put it in the dead-letter view, so an operator
       *                  would replay it and get two runs.
       *    'skipped'   — the `skip` policy deliberately dropped it. Terminal
       *                  and correct.
       *    'transient' — a condition that passes on its own: a DAILY spend
       *                  cap that will reset, or an orchestration that is
       *                  mid-hot-reload. Dead-lettering these meant a fire
       *                  arriving in an unlucky second was permanently lost
       *                  and (thanks to idempotency) could not be re-fired
       *                  with the same key. Retried with the normal bounded
       *                  backoff, so a genuinely-deleted orchestration still
       *                  dead-letters after maxAttempts.
       *    'refused'   — anything else: terminal. */
      type FireFailure = 'deferred' | 'skipped' | 'transient' | 'refused' | 'budget';
      async function fireRun(
        orchName: string,
        input: string,
        label: string,
        ownerId = 'system',
        /** Set only by `drainPendingFire`: the group this fire was parked
         *  under, so the drained run is created holding it. See
         *  `startRunWithConcurrency`'s `knownGroup`. */
        knownGroup?: string,
        /** A drained manual start's resolved declared inputs. */
        resolvedInputs?: Record<string, string>,
      ): Promise<
        | { ok: true; id: string }
        | { ok: false; failure: FireFailure; reason: string }
      > {
        // A server state file is never an orchestration — see
        // `namesServerStateFile`; the answer is the one a missing file gets.
        const ctx = (await namesServerStateFile(orchName))
          ? null
          : await loadRunContext(orchName);
        if (!ctx) {
          return {
            ok: false,
            failure: 'transient',
            reason: 'orchestration missing (not in the workspace right now)',
          };
        }
        const { status: bs, gate } = await loadBudgetState(
          budgetFile,
          store,
          ownerId,
        );
        if (bs.blocked) {
          return {
            ok: false,
            // Its own failure kind so the delivery worker HOLDS the fire
            // (no attempt spent) instead of retrying it into the dead-letter
            // view within seconds — which is what 'transient' did, despite
            // this message promising the opposite.
            failure: 'budget',
            reason: 'budget cap reached — deferring, not dropping',
          };
        }
        // Start-gate: an orchestration with a `concurrency.group` may be
        // skipped / queued / preceded-by-a-cancel here. A skip/queue is a
        // SUCCESSFUL policy outcome (not a retryable failure) — report it as a
        // non-retryable refusal so the delivery is recorded, not re-driven.
        const res = await startRunWithConcurrency(
          ctx.orchestration,
          {
            store,
            orchestrationName: orchName,
            initialInput: input,
            ...(resolvedInputs ? { resolvedInputs } : {}),
            orchestrationSnapshot: ctx.orchestration,
            budgetGate: gate,
            // P4: the run is owned by whoever triggered it (the delivery's
            // owner), not a blanket 'system' — real provenance + scoping.
            ownerId,
            onTerminal: buildTerminalHook(orchName, ctx.orchestration, ownerId),
            buildEventSource: (signal, runId) =>
              buildExecutorSource(
                ctx,
                { initialInput: input, allowAgentTools: true, ownerId, runId, resolvedInputs },
                signal,
              ),
          },
          { orchName, initialInput: input, ownerId, resolvedInputs },
          label,
          knownGroup,
        );
        if (res.outcome === 'skipped') {
          return {
            ok: false,
            failure: 'skipped',
            reason: 'concurrency: group busy, fire skipped by policy',
          };
        }
        if (res.outcome === 'queued') {
          return {
            ok: false,
            failure: 'deferred',
            reason: 'concurrency: group busy, fire parked on the pending queue',
          };
        }
        console.log(
          `[sammy-pack-api] ${label} → ${orchName} as ${res.id} (owner: ${ownerId})`,
        );
        return { ok: true, id: res.id };
      }

      // ─── Delivery worker (P1) ──────────────────────────────────────
      //
      // Drains the durable trigger-delivery queue: claims `pending`
      // deliveries and turns each into a run via fireRun. A fire is now
      // recorded-then-executed (not inline), so the boundary survives a
      // crash and retries on transient failure. fireRun's policy refusals
      // (budget cap / missing orchestration) are non-retryable → the
      // delivery is `rejected`; an unexpected throw is retryable.
      const deliveryWorker = new DeliveryWorker({
        store,
        log: m => console.log(`[sammy-pack-api] worker: ${m}`),
        // Per-orchestration fairness cap (P2): one orch's burst can't starve
        // the others at dispatch. Unset = no cap.
        maxInFlightPerOrch:
          Number(process.env.SAMMY_MAX_INFLIGHT_PER_ORCH) || undefined,
        runDelivery: async d => {
          // A `limits` cap is only exact if "count today's runs" and "create
          // the run" happen as one step: the worker claims several deliveries
          // at once, and two fires that both read "4 of 5" would both start.
          // Serialize them per orchestration (the store-backed lock) whenever
          // the orchestration declares limits. Only the orchestration's own
          // file is read for this — `loadRunContext` walks the whole
          // workspace, and this runs for every delivery.
          if (d.kind !== 'concurrency-drain') {
            const limits = await readOrchLimits(d.orchestrationName);
            if (limits) {
              return admissionLock.run(d.orchestrationName, () => runDeliveryUnlocked(d, limits));
            }
          }
          return runDeliveryUnlocked(d, undefined);
        },
      });

      /** An orchestration's root `limits`, from its own file only (cheap). */
      async function readOrchLimits(
        name: string,
      ): Promise<import('./src/types').OrchestrationLimits | undefined> {
        // The same names loadRunContext accepts (it allows dots), so a run
        // the delivery WILL start never has its limits skipped.
        if (!isPlainName(name)) return undefined;
        if (await namesServerStateFile(name)) return undefined;
        const node = (await readJsonFile(path.join(examplesDir, `${name}.json`))) as
          | import('./src/types').Node
          | null;
        return node && typeof node === 'object' ? node.limits : undefined;
      }

      async function runDeliveryUnlocked(
        d: import('./src/server/run-store').DeliveryRecord,
        limits: import('./src/types').OrchestrationLimits | undefined,
      ): Promise<import('./src/server/delivery-worker').RunDeliveryResult> {
          try {
            // Per-orchestration admission: intake pause + root `limits`. A
            // drained fire was admitted when it was first delivered, so it is
            // not counted again.
            if (d.kind !== 'concurrency-drain') {
              const verdict = await admitDelivery({
                store,
                pauses: intakePauses,
                orchestrationName: d.orchestrationName,
                limits,
                kind: d.kind,
                now: Date.now(),
              });
              if (verdict.action === 'hold') {
                return { ok: false, hold: true, until: verdict.until, detail: verdict.reason };
              }
              if (verdict.action === 'refuse') {
                return { ok: false, error: verdict.reason, retryable: false };
              }
            }
            // A drain re-queued as a DELIVERY may start long after its group
            // was released (a budget hold re-checks every few minutes), and
            // by then another fire may hold the group — for an implicit
            // `sammy:cron:<orch>` group the start path no longer gates it.
            // So: if the group is busy, park the fire behind the holder again
            // (that holder's terminal drains it); otherwise start it holding
            // the group, like an inline drain.
            if (d.kind === 'concurrency-drain' && d.name) {
              const busy = await store.findActiveRunsInGroup(d.name);
              if (busy.length > 0) {
                await store.enqueuePendingFire(d.name, {
                  orchName: d.orchestrationName,
                  initialInput: d.body ?? '',
                  ownerId: d.ownerId,
                });
                // The holder may have ended (and drained an EMPTY queue)
                // between the check and the park; then nothing would ever
                // drain this fire. Re-check, and drain it ourselves if so.
                if ((await store.findActiveRunsInGroup(d.name)).length === 0) {
                  void drainPendingFire(d.name).catch(err =>
                    console.error(`[concurrency] re-drain of ${d.name} failed:`, err),
                  );
                }
                return {
                  ok: false,
                  deferred: true,
                  detail: `concurrency: re-parked behind ${busy[0].id} in group ${d.name}`,
                };
              }
            }
            const res = await fireRun(
              d.orchestrationName,
              d.body ?? '',
              d.kind,
              d.ownerId,
              d.kind === 'concurrency-drain' ? d.name || undefined : undefined,
            );
            if (res.ok) return { ok: true, runId: res.id };
            if (res.failure === 'deferred') {
              return { ok: false, deferred: true, detail: res.reason };
            }
            if (res.failure === 'budget') {
              if (isScheduleKind(d.kind)) {
                return { ok: false, error: `${res.reason} — scheduled tick skipped`, retryable: false };
              }
              return {
                ok: false,
                hold: true,
                until: Date.now() + BUDGET_RECHECK_MS,
                detail: res.reason,
              };
            }
            return {
              ok: false,
              error: res.reason,
              // A transient condition gets the normal bounded retry; a policy
              // skip or a real refusal is terminal.
              retryable: res.failure === 'transient',
            };
          } catch (e) {
            return { ok: false, error: (e as Error).message, retryable: true };
          }
      }
      // Store-backed, so a server and a standalone worker sharing one store
      // serialize the same orchestration's admission too.
      const admissionLock = {
        run: <T>(orch: string, fn: () => Promise<T>) => groupLock.run(`sammy:admit:${orch}`, fn),
      };

      // ─── Durable, idempotent delivery (P0) ─────────────────────────
      //
      // Every trigger fire — HTTP (webhook/events/deployment/queue) or
      // timer (cron/polling) — routes through deliver(): a
      // `trigger_deliveries` row is persisted BEFORE the run is created,
      // and deduplicated by an idempotency key. This is the boundary that
      // turns fire-and-forget triggers into something durable + replayable
      // + exactly-once-ish, and the seam the worker queue (P1) will drain.
      const AUTO_DEDUPE_WINDOW_MS = 60_000;
      // Backpressure cap (P2): max `pending` deliveries before ingress sheds
      // load with a 429. Override with SAMMY_MAX_QUEUE_DEPTH.
      const MAX_QUEUE_DEPTH = Math.max(
        1,
        Number(process.env.SAMMY_MAX_QUEUE_DEPTH) || 1000,
      );
      // Reactive-eventing loop guard (P3): events published by a run carry
      // their producing delivery's chain depth + 1; beyond this they're
      // dropped so A→B→A… can't cascade forever. Override via
      // SAMMY_MAX_EVENT_CHAIN_DEPTH.
      const MAX_EVENT_CHAIN_DEPTH = Math.max(
        1,
        Number(process.env.SAMMY_MAX_EVENT_CHAIN_DEPTH) || 5,
      );
      // Cap how many runs the aggregation digests (/api/observability,
      // /api/cost) hydrate full event logs for. These endpoints walk every
      // run's events; an unbounded sweep over a workspace with thousands of
      // 800–1300-event runs is the same multi-GB hydration that OOM'd the
      // old /api/runs list. listRuns returns most-recent-first, so the cap
      // keeps the freshest N runs in the digest; older runs roll off rather
      // than risk the process. Override with SAMMY_MAX_DIGEST_RUNS.
      const MAX_DIGEST_RUNS = Math.max(
        1,
        Number(process.env.SAMMY_MAX_DIGEST_RUNS) || 2000,
      );
      let deliverySeq = 0;
      const newDeliveryId = () =>
        `del-${Date.now()}-${(deliverySeq++).toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;

      type DeliveryResult = {
        deliveryId: string;
        orchestration: string;
        runId: string | null;
        status: string;
        detail?: string;
      };

      // Per-subscriber ingress options (idempotency window, payload scrub),
      // keyed `kind \0 name \0 orchestration`. Populated by trigger
      // registration, so every producer that calls deliver() gets them.
      const intakeOptsByKey = new Map<
        string,
        import('./src/types').TriggerIntakeOptions
      >();
      const intakeKey = (kind: string, name: string, orch: string) =>
        `${kind}\u0000${name}\u0000${orch}`;
      const intakeOptsFor = (kind: string, name: string, orch: string) =>
        intakeOptsByKey.get(intakeKey(kind, name, orch));
      /** Record a trigger's ingress options. An INVALID scrub policy is
       *  registered anyway rather than skipped: dropping it would store raw
       *  payloads the author meant to scrub, while a broken policy makes
       *  `deliver` withhold the body (fail closed) and validation names it. */
      const noteIntakeOpts = (
        kind: string,
        name: string,
        orch: string,
        t: import('./src/types').TriggerIntakeOptions,
      ) => {
        const ttl =
          typeof t.idempotencyTtlSeconds === 'number' &&
          Number.isFinite(t.idempotencyTtlSeconds) &&
          t.idempotencyTtlSeconds > 0
            ? t.idempotencyTtlSeconds
            : undefined;
        if (ttl === undefined && t.scrub === undefined) return;
        intakeOptsByKey.set(intakeKey(kind, name, orch), {
          ...(ttl !== undefined ? { idempotencyTtlSeconds: ttl } : {}),
          ...(t.scrub !== undefined ? { scrub: t.scrub } : {}),
        });
      };
      // A WINDOWED header key has no unique index behind it (it must be
      // re-insertable once its window lapses), so its check-then-insert is
      // serialized through the DURABLE group lock instead — the store-backed
      // lock the concurrency gate uses — so two replicas sharing one store
      // cannot both accept the same key. Namespaced under the reserved
      // `sammy:` prefix, which no author or templated group can produce.
      const windowKeyLock = {
        run: <T>(key: string, fn: () => Promise<T>) => groupLock.run(`sammy:win:${key}`, fn),
      };

      type DeliverOpts = Parameters<typeof deliverUnlocked>[0];
      async function deliver(opts: DeliverOpts) {
        const headerKey = opts.idempotencyKey?.trim();
        const windowed =
          !!headerKey &&
          opts.orchNames.some(
            o => (intakeOptsFor(opts.kind, opts.name, o)?.idempotencyTtlSeconds ?? 0) > 0,
          );
        if (!windowed) return deliverUnlocked(opts);
        return windowKeyLock.run(
          [opts.ownerId?.trim() || 'system', opts.kind, opts.name, headerKey]
            .map(encodeURIComponent)
            .join(':'),
          () => deliverUnlocked(opts),
        );
      }

      async function deliverUnlocked(opts: {
        kind: string;
        name: string;
        orchNames: string[];
        body: string;
        idempotencyKey?: string | null;
        ownerId?: string;
        /** Event-chain depth for reactive eventing loop-guarding (P3). */
        chainDepth?: number;
        /** Record a durable `rejected` row when the queue is full, instead of
         *  dropping the fire with only a console.warn.
         *
         *  Set by producers that have NOWHERE ELSE to report: an HTTP caller
         *  receives a 429 and can retry, but a cron tick and an internal
         *  `publishEvent` have no such channel, so a throttled fire used to
         *  vanish — no row, no dead letter, no breaker signal. Under a
         *  sustained backlog that silently lost scheduled work rather than
         *  delaying it. Recording is only safe now that a refused row no
         *  longer consumes its idempotency key, so the fire stays replayable
         *  and a later retry of the same key still runs. */
        recordIfThrottled?: boolean;
      }): Promise<{
        duplicate: boolean;
        throttled?: boolean;
        deliveries: DeliveryResult[];
      }> {
        const owner = opts.ownerId?.trim() || 'system';
        const headerKey = opts.idempotencyKey?.trim();
        const keySource: 'header' | 'auto' = headerKey ? 'header' : 'auto';
        // SCOPE both key forms to the endpoint (kind + name), the owner, and
        // — for auto keys — the subscriber set.
        //
        // A bare `hdr:<key>` was a single global namespace matched for all
        // time, so one `Idempotency-Key` reused across two endpoints
        // collapsed them: POST /api/deploy/staging followed by
        // POST /api/deploy/production with the same key silently suppressed
        // the production fire and answered 200 with the STAGING delivery's
        // ids. The same across owners made one tenant able to suppress
        // another's fires and leaked delivery/run ids between them.
        //
        // A bare `sha256(kind:name:body)` auto key omitted the
        // orchestration, so two orchestrations polling one URL (one
        // `deliver` call each) collapsed into a single delivery and only the
        // first ever ran.
        //
        // Components are percent-encoded before joining, so the join is
        // injective. Plain `a:b:c` concatenation is not: an `events` name of
        // "a:b" with key "c" and a name of "a" with key "b:c" produce the
        // same string, and `name` really can contain colons — event,
        // deployment and queue names are unconstrained, and a polling
        // source is a URL. Encoding keeps the key greppable (unlike a hash)
        // while making a crafted key unable to impersonate another scope.
        const scope = [owner, opts.kind, opts.name].map(encodeURIComponent).join(':');
        // A sender may key by an email or a user id. When any subscriber asks
        // for its payloads to be scrubbed, store a DIGEST of the header key
        // instead — dedupe only needs equality.
        const scrubbing = opts.orchNames.some(
          o => intakeOptsFor(opts.kind, opts.name, o)?.scrub !== undefined,
        );
        const key = headerKey
          ? scrubbing
            ? `hdrh:${scope}:${createHash('sha256').update(headerKey).digest('hex')}`
            : `hdr:${scope}:${encodeURIComponent(headerKey)}`
          : // The body goes through a digest (it can be megabytes), but its
            // pre-image is scoped and encoded the same way. The subscriber
            // set is included so two orchestrations on one source do not
            // collapse into a single delivery.
            `auto:${scope}:${createHash('sha256')
              .update(
                `${[...opts.orchNames].sort().map(encodeURIComponent).join(',')}:${opts.body}`,
              )
              .digest('hex')}`;

        // Dedup: header keys match for all time; auto keys only within a
        // recent window — catches accidental double-delivery (a retried
        // request replaying the same body) without permanently collapsing
        // two legitimately-identical events.
        //
        // Read PER SUBSCRIBER rather than "any prior row short-circuits the
        // whole call". The fan-out below writes one row per subscribed
        // orchestration, as separate statements, so it can fail part-way —
        // and the old all-or-nothing check then made that permanent: a retry
        // with the same key found row 1, declared the call a duplicate, and
        // the orchestrations that never got a row never ran that event. With
        // a per-subscriber view, a retry completes the fan-out.
        const prior = await store.findDeliveriesByKey(key, {
          sinceMs: keySource === 'auto' ? AUTO_DEDUPE_WINDOW_MS : undefined,
          // A REFUSED row must not suppress a retry. A refusal means the work
          // never ran, so treating it as a duplicate silently dropped the
          // event — a provider re-sending a delivery we had refused (budget
          // cap, missing orchestration, queue full) got a 200 and nothing
          // happened. Mirrors the partial unique index's predicate.
          excludeRefused: true,
        });
        // Idempotency WINDOW: a subscriber that declares
        // `idempotencyTtlSeconds` only treats a prior fire of this key as a
        // duplicate while it is younger than the window (sliding — measured
        // from the most recent accepted fire). Its rows are stored with
        // keySource 'window', outside the forever-unique header index, so a
        // lapsed key can be accepted again.
        const ttlMsByOrch = new Map<string, number>();
        if (headerKey) {
          for (const o of opts.orchNames) {
            const ttl = intakeOptsFor(opts.kind, opts.name, o)?.idempotencyTtlSeconds;
            if (ttl && ttl > 0) ttlMsByOrch.set(o, ttl * 1000);
          }
        }
        const nowForWindow = Date.now();
        const livePrior = prior.filter(p => {
          const ttl = ttlMsByOrch.get(p.orchestrationName);
          return ttl === undefined || p.receivedAt >= nowForWindow - ttl;
        });
        const priorByOrch = new Map(livePrior.map(p => [p.orchestrationName, p]));
        const missing = opts.orchNames.filter(o => !priorByOrch.has(o));
        // Ingress scrub, per subscriber (policies can differ): the body that
        // is STORED is the scrubbed one, so nothing raw reaches a run.
        const scrubbedFor = new Map<string, { body: string; detail?: string }>();
        const bodyFor = (orch: string): { body: string; detail?: string } => {
          const cached = scrubbedFor.get(orch);
          if (cached) return cached;
          const policy = intakeOptsFor(opts.kind, opts.name, orch)?.scrub;
          let out: { body: string; detail?: string } = { body: opts.body };
          if (policy) {
            try {
              const r = scrubPayload(opts.body, policy);
              out = { body: r.body, detail: describeScrub(r) };
            } catch (err) {
              // A policy that throws must not let the raw body through.
              out = {
                body: NON_JSON_PLACEHOLDER,
                detail: `scrub failed (${(err as Error).message}) — body withheld`,
              };
            }
          }
          scrubbedFor.set(orch, out);
          return out;
        };
        if (missing.length === 0 && livePrior.length > 0) {
          console.log(
            `[sammy-pack-api] ${opts.kind} "${opts.name}" deduped on ${keySource} key → ${livePrior.length} prior delivery(ies)`,
          );
          // Count the suppression on the surviving rows, so a provider
          // double-sending is visible instead of silently collapsing.
          await Promise.all(
            livePrior.map(p =>
              store.noteDuplicateSuppressed(p.id).catch(() => {}),
            ),
          );
          return {
            duplicate: true,
            deliveries: livePrior.map(p => ({
              deliveryId: p.id,
              orchestration: p.orchestrationName,
              runId: p.runId,
              status: 'duplicate',
            })),
          };
        }
        if (priorByOrch.size > 0) {
          console.warn(
            `[sammy-pack-api] ${opts.kind} "${opts.name}" is a PARTIAL duplicate — ` +
              `${priorByOrch.size} subscriber(s) already have a delivery, ` +
              `completing the fan-out for ${missing.join(', ')}`,
          );
        }

        // Backpressure (P2): shed load when the queue is already deep, so a
        // burst can't spawn unbounded background runs. The delivery is
        // refused at ingress (nothing recorded) — the caller should retry.
        // Backlog = pending rows that are DUE, plus rows backing off between
        // retries (a failing start path is exactly when ingress must push
        // back). NOT held rows (paused intake, a spent limit or budget) —
        // counting those let one paused orchestration 429 every other one's
        // ingress. A hold clears `last_error`, which is how they differ.
        const depth = await store.countDeliveries({
          status: 'pending',
          dueOrRetrying: Date.now(),
        });
        if (depth >= MAX_QUEUE_DEPTH) {
          console.warn(
            `[sammy-pack-api] ${opts.kind} "${opts.name}" throttled — ${depth} pending ≥ cap ${MAX_QUEUE_DEPTH}`,
          );
          const throttled: DeliveryResult[] = [];
          if (opts.recordIfThrottled) {
            // One terminal row per refused fire. It is NOT `pending`, so it
            // does not add to the depth this cap measures, and retention
            // prunes it like any other terminal row.
            const reason =
              `queue full: ${depth} pending ≥ cap ${MAX_QUEUE_DEPTH} — ` +
              'fire refused at ingress, replayable';
            const now = Date.now();
            for (const orchName of missing) {
              const deliveryId = newDeliveryId();
              const inserted = await store
                .recordDelivery({
                  id: deliveryId,
                  kind: opts.kind,
                  name: opts.name,
                  orchestrationName: orchName,
                  idempotencyKey: key,
                  keySource: ttlMsByOrch.has(orchName) ? 'window' : keySource,
                  status: 'rejected',
                  detail: reason,
                  body: bodyFor(orchName).body,
                  ownerId: owner,
                  receivedAt: now,
                  availableAt: now,
                  chainDepth: opts.chainDepth ?? 0,
                })
                .catch(err => {
                  console.error(
                    '[sammy-pack-api] could not record a throttled fire:',
                    err,
                  );
                  return false;
                });
              if (inserted) {
                throttled.push({
                  deliveryId,
                  orchestration: orchName,
                  runId: null,
                  status: 'rejected',
                  detail: reason,
                });
              }
            }
          }
          return { duplicate: false, throttled: true, deliveries: throttled };
        }

        // Record `pending` and return — the worker creates the run. This is
        // the real accept≠execute boundary: durable, recoverable, retried.
        const deliveries: DeliveryResult[] = [];
        const now = Date.now();
        let anyDuplicate = priorByOrch.size > 0;
        for (const orchName of opts.orchNames) {
          const already = priorByOrch.get(orchName);
          if (already) {
            await store.noteDuplicateSuppressed(already.id).catch(() => {});
            deliveries.push({
              deliveryId: already.id,
              orchestration: orchName,
              runId: already.runId,
              status: 'duplicate',
            });
            continue;
          }
          const deliveryId = newDeliveryId();
          const inserted = await store.recordDelivery({
            id: deliveryId,
            kind: opts.kind,
            name: opts.name,
            orchestrationName: orchName,
            idempotencyKey: key,
            keySource: ttlMsByOrch.has(orchName) ? 'window' : keySource,
            status: 'pending',
            body: bodyFor(orchName).body,
            ...(bodyFor(orchName).detail ? { detail: bodyFor(orchName).detail } : {}),
            ownerId: owner,
            receivedAt: now,
            availableAt: now,
            chainDepth: opts.chainDepth ?? 0,
          });
          if (!inserted) {
            // The unique index refused it: a concurrent request with the same
            // header key inserted first. THIS is the real dedupe boundary —
            // the read above is only a fast path, and two simultaneous posts
            // both passed it. Report the winner's row.
            anyDuplicate = true;
            const winner = (
              await store.findDeliveriesByKey(key, {
                sinceMs: keySource === 'auto' ? AUTO_DEDUPE_WINDOW_MS : undefined,
                excludeRefused: true,
              })
            ).find(p => p.orchestrationName === orchName);
            if (winner) await store.noteDuplicateSuppressed(winner.id).catch(() => {});
            console.log(
              `[sammy-pack-api] ${opts.kind} "${opts.name}" lost the insert race ` +
                `for ${orchName} — deduped to ${winner?.id ?? 'the prior row'}`,
            );
            deliveries.push({
              deliveryId: winner?.id ?? deliveryId,
              orchestration: orchName,
              runId: winner?.runId ?? null,
              status: 'duplicate',
            });
            continue;
          }
          deliveries.push({
            deliveryId,
            orchestration: orchName,
            runId: null,
            status: 'pending',
          });
        }
        // Low-latency nudge so the run starts now, not on the next poll.
        deliveryWorker.kick();
        return {
          // `duplicate` stays the ALL-subscribers answer: a partial fan-out
          // completion is a real accept, not a duplicate.
          duplicate: anyDuplicate && deliveries.every(d => d.status === 'duplicate'),
          deliveries,
        };
      }

      // ─── Reactive eventing (P3) ────────────────────────────────────
      //
      // Publish an internal domain event to every orchestration that
      // subscribes to it (`triggers: [{ kind: 'events', event }]`). Events
      // ride the same durable delivery queue as external triggers, so
      // they're durable + idempotent + retried. `chainDepth` carries the
      // producing run's depth + 1 and is capped so reactive chains can't
      // loop forever. No subscribers → no-op.
      async function publishEvent(
        eventName: string,
        body: string,
        chainDepth: number,
        ownerId?: string,
      ): Promise<void> {
        if (chainDepth > MAX_EVENT_CHAIN_DEPTH) {
          console.warn(
            `[sammy-pack-api] event "${eventName}" dropped — chain depth ${chainDepth} > cap ${MAX_EVENT_CHAIN_DEPTH} (loop guard)`,
          );
          return;
        }
        const subs = eventTriggers.get(eventName)?.orchNames;
        if (!subs || subs.length === 0) return;
        const out = await deliver({
          kind: 'events',
          name: eventName,
          orchNames: subs,
          body,
          ownerId: ownerId ?? 'system',
          chainDepth,
          // Internal producer: nothing here can receive a 429, so a
          // throttled fire has to leave a durable, replayable trace.
          recordIfThrottled: true,
        });
        if (!out.throttled) {
          console.log(
            `[sammy-pack-api] event "${eventName}" → ${out.deliveries.length} subscriber delivery(ies) at depth ${chainDepth}`,
          );
        }
      }

      /** Serializes `refreshTriggersForOrch` PER ORCHESTRATION.
       *
       *  The function drops this orch's triggers, then `await`s (reading the
       *  JSON, and per polling trigger a store lookup) before registering the
       *  new ones. With no lock, two concurrent saves interleave as:
       *  A drops → A awaits → B drops (finds nothing) → B awaits →
       *  A registers → B registers → `pollTasksByOrch.set` keeps only B's
       *  array. A's pollers are then live and untracked: still fetching,
       *  still delivering, and unstoppable for the life of the process. It is
       *  called from three unsynchronized HTTP paths (save, delete, import)
       *  plus boot. The same primitive the concurrency start-gate uses. */
      const refreshLock = new GroupLock();

      /** Re-scan an orchestration's triggers and update the maps in
       *  place. Idempotent — old entries for this orch are removed
       *  first, then new ones added. Safe to call from boot, save,
       *  delete. Serialized per orchestration. */
      async function refreshTriggersForOrch(orchName: string): Promise<void> {
        return refreshLock.run(orchName, () => refreshTriggersForOrchUnlocked(orchName));
      }

      async function refreshTriggersForOrchUnlocked(orchName: string): Promise<void> {
        // Drop any webhooks owned by this orch.
        for (const [p, e] of webhookTriggers) {
          if (e.orchName === orchName) webhookTriggers.delete(p);
        }
        // Stop any cron tasks owned by this orch — both the ones THIS mount
        // knows about and any leaked from a prior mount (swept by task name
        // from node-cron's process-global registry). destroy() removes them
        // from that registry so they can't fire again.
        for (const task of cronTasksByOrch.get(orchName) ?? []) {
          try { task.stop(); } catch { /* already stopped */ }
        }
        destroyLeakedCronTasksFor(orchName);
        cronTasksByOrch.delete(orchName);
        // Re-registration revives the schedule, so it is no longer paused.
        for (const k of [...pausedCronSchedules]) {
          if (k.startsWith(`${orchName}\u0000`)) pausedCronSchedules.delete(k);
        }
        // Stop any polling tasks owned by this orch — both this mount's and
        // any left behind by a previous mount of the same process.
        for (const task of pollTasksByOrch.get(orchName) ?? []) {
          try { task.stop(); } catch { /* already stopped */ }
        }
        destroyPollersFor(orchName);
        pollTasksByOrch.delete(orchName);
        // Drop this orch from the named HTTP-fired registries.
        dropOrchFrom(eventTriggers, orchName);
        dropOrchFrom(deployTriggers, orchName);
        dropOrchFrom(queueTriggers, orchName);
        for (const k of [...intakeOptsByKey.keys()]) {
          if (k.endsWith(`\u0000${orchName}`)) intakeOptsByKey.delete(k);
        }
        triggerCatalog.delete(orchName);
        concurrencyByOrch.delete(orchName);
        codeRunOrchs.delete(orchName);

        // Re-read the orch + register what it declares now.
        const orch = (await readJsonFile(
          path.join(examplesDir, `${orchName}.json`),
        )) as import('./src/types').Node | null;
        // Track root declarations for EVERY orchestration — a manual-only
        // orch (no triggers) can still hold a concurrency group, and the
        // visibility endpoint must resolve its policy. Recorded before the
        // triggers early-return below for exactly that reason.
        if (orch) {
          // Record the EFFECTIVE group: for a cron orchestration with no
          // explicit block that is the implicit per-orchestration group, and
          // the visibility endpoint has to show it or a skipped tick looks
          // unexplained.
          const conc = concurrencyOf(orch) ?? effectiveConcurrency(orch, 'cron');
          if (conc) concurrencyByOrch.set(orchName, conc);
          if (orchestrationUsesCodeRun(orch)) codeRunOrchs.add(orchName);
        }
        if (!orch?.triggers || !Array.isArray(orch.triggers)) return;
        const newCronTasks: Array<
          ScheduleTask<Extract<import('./src/types').Trigger, { kind: 'cron' }>>
        > = [];
        const newPollTasks: Array<
          ScheduleTask<Extract<import('./src/types').Trigger, { kind: 'polling' }>>
        > = [];
        for (const t of orch.triggers) {
          // FAIL CLOSED on an unrecognized `signed` value. The ingress
          // enforces nothing when `signed` resolves to no provider, so a
          // typo (`"githbu"`) would otherwise publish an endpoint its author
          // believed was authenticated. Validation already flags it; this
          // guard means a trigger that slipped past validation gets NO
          // endpoint rather than an unprotected one.
          if (
            'signed' in t &&
            t.signed !== undefined &&
            t.signed !== false &&
            !providerFromSigned(t.signed)
          ) {
            console.error(
              `[sammy-pack-api] ${orchName}: trigger ${t.kind} declares ` +
                `signed: ${JSON.stringify(t.signed)}, which is not a known ` +
                `signature scheme — REFUSING to register it (an unsigned ` +
                `endpoint would be worse). Use true or one of ` +
                `${WEBHOOK_PROVIDER_NAMES.join(' / ')}.`,
            );
            continue;
          }
          if (t.kind === 'webhook') {
            if (!t.path || !/^[a-zA-Z0-9_-]+$/.test(t.path)) continue;
            if (webhookTriggers.has(t.path)) {
              const existing = webhookTriggers.get(t.path)!;
              console.warn(
                `[sammy-pack-api] webhook path "${t.path}" already owned by "${existing.orchName}"; "${orchName}" ignored`,
              );
              continue;
            }
            noteIntakeOpts('webhook', t.path, orchName, t);
            webhookTriggers.set(t.path, {
              orchName,
              method: (t.method ?? 'POST').toUpperCase(),
              signed: providerFromSigned(t.signed),
            });
          } else if (t.kind === 'cron') {
            if (!t.expr || !cron.validate(t.expr)) {
              console.warn(
                `[sammy-pack-api] cron expr "${t.expr}" invalid (${orchName})`,
              );
              continue;
            }
            const expr = t.expr;
            const task = cron.schedule(expr, async () => {
              try {
                // Stable idempotency key bucketed to the cron's own schedule
                // granularity. node-cron can fire the same scheduled tick more
                // than once — catch-up after the event loop stalls (e.g. the
                // machine was pegged, which is exactly what spawned duplicate
                // nightly-eval runs), or a duplicate registration after a fast
                // restart around the cron window. A bucketed *header* key
                // collapses those extra fires permanently (header keys dedupe
                // for all time, and across restarts via the persisted delivery
                // store), while distinct scheduled ticks never collide. Without
                // this the `body` timestamp made every fire unique, so only the
                // weak 60s auto-dedup window applied and each stray tick spawned
                // a fresh run.
                //
                // Bucket = the WALL-CLOCK slot (minute, or second for a
                // 6-field expression) in the schedule's own timezone — not
                // `Date.now() / 60_000`. A cron expression matches wall-clock
                // fields, and on a DST fall-back the local hour occurs twice:
                // an epoch bucket put those two passes an hour apart, so one
                // daily job produced TWO runs. See cron-bucket.ts.
                const bucket = cronWallClockBucket(expr, new Date(), t.timezone);
                const out = await deliver({
                  kind: 'cron',
                  name: expr,
                  orchNames: [orchName],
                  body: new Date().toISOString(),
                  idempotencyKey: `cron:${orchName}:${expr}:${bucket}`,
                  recordIfThrottled: true,
                });
                if (out.throttled) {
                  // Also feed the circuit-breaker, so a cron whose every tick
                  // is being shed trips the same alert as one whose every run
                  // fails. Previously a sustained backlog silently retired the
                  // schedule's output with no signal anywhere.
                  await tripCronBreakerFor(
                    orchName,
                    expr,
                    out.deliveries[0]?.deliveryId ?? `throttled-${Date.now()}`,
                    'throttled',
                  ).catch(() => {});
                }
              } catch (e) {
                console.error(`[sammy-pack-api] cron tick ${orchName}:`, e);
              }
            }, {
              // Deterministic name → the global sweep above can find and
              // destroy a leaked duplicate before we reschedule. noOverlap
              // stops a slow tick from stacking onto its own prior run.
              name: cronTaskName(orchName, expr),
              // The scheduler and the dedupe bucket must read the SAME zone,
              // or the key would not describe the slot that actually matched.
              ...(t.timezone ? { timezone: t.timezone } : {}),
              noOverlap: true,
            } as unknown as Parameters<typeof cron.schedule>[2]);
            newCronTasks.push({
              stop: (task as unknown as { stop: () => void }).stop.bind(task),
              trigger: t,
            });
          } else if (t.kind === 'events') {
            // Fired by POST /api/events/<event>. Many orchs may subscribe.
            if (t.event) {
              addOrchTo(eventTriggers, t.event, orchName, providerFromSigned(t.signed));
              noteIntakeOpts('events', t.event, orchName, t);
            }
          } else if (t.kind === 'deployment') {
            // Fired by POST /api/deploy/<environment>.
            if (t.environment) {
              addOrchTo(
                deployTriggers,
                t.environment,
                orchName,
                providerFromSigned(t.signed),
              );
              noteIntakeOpts('deployment', t.environment, orchName, t);
            }
          } else if (t.kind === 'queue') {
            // Fired by POST /api/queue/<queue>.
            if (t.queue) {
              addOrchTo(queueTriggers, t.queue, orchName, providerFromSigned(t.signed));
              noteIntakeOpts('queue', t.queue, orchName, t);
            }
          } else if (t.kind === 'polling') {
            // Poll a URL; fire when the body is non-empty and changed since
            // the previous tick. Hardened (P6): `last` is seeded from the
            // most recent polling delivery so a restart doesn't re-fire an
            // unchanged body; conditional GET (ETag / If-Modified-Since)
            // avoids re-downloading unchanged sources; self-scheduling tick
            // adds ±10% jitter and exponential backoff on consecutive
            // failures (so a flapping source doesn't hammer).
            if (t.source && t.intervalSeconds > 0) {
              const source = t.source;
              const baseMs = Math.max(1, Math.floor(t.intervalSeconds)) * 1000;
              let last: string | null = null;
              try {
                // Seeded PER ORCHESTRATION. Matching on `name` alone let a
                // newly-added orchestration inherit another one's last body
                // for the same URL and never fire for the current content.
                const prev = await store.findLastPollingDelivery(source, orchName);
                if (prev?.body) last = prev.body;
              } catch {
                /* seed best-effort */
              }
              let etag: string | null = null;
              let lastModified: string | null = null;
              let failures = 0;
              let stopped = false;
              let timer: ReturnType<typeof setTimeout> | null = null;
              const schedule = (delay: number) => {
                if (stopped) return;
                // Jitter is ±10%, so pollers sharing an interval de-correlate
                // instead of all drifting later together.
                const jittered = Math.max(
                  1,
                  Math.round(delay * (0.9 + Math.random() * 0.2)),
                );
                timer = setTimeout(tick, jittered);
                (timer as unknown as { unref?: () => void }).unref?.();
              };
              const tick = async () => {
                try {
                  const headers: Record<string, string> = {};
                  if (etag) headers['if-none-match'] = etag;
                  if (lastModified) headers['if-modified-since'] = lastModified;
                  // A TIMEOUT is mandatory here, not a nicety. `schedule()`
                  // is only reached from this function's `finally`, so a
                  // fetch that never settles means the tick never completes
                  // and the trigger is NEVER RE-ARMED: that poller silently
                  // stops polling for the life of the process while
                  // /api/triggers still reports it as registered. A source
                  // that trickles bytes (or streams forever) does exactly
                  // that, and undici's defaults reset per chunk so they do
                  // not save us.
                  const r = await fetch(source, {
                    headers,
                    signal: AbortSignal.timeout(pollFetchTimeoutMs()),
                  });
                  if (r.status === 304) {
                    failures = 0;
                    return;
                  }
                  if (!r.ok) {
                    failures += 1;
                    // Logged: a source that 404s forever (rotated endpoint,
                    // expired auth) used to produce no output whatsoever
                    // while looking healthy.
                    console.warn(
                      `[sammy-pack-api] poll ${orchName}: ${source} → HTTP ${r.status}` +
                        ` (consecutive failures: ${failures})`,
                    );
                    return;
                  }
                  etag = r.headers.get('etag');
                  lastModified = r.headers.get('last-modified');
                  const body = (await readCappedText(r, source, orchName)).trim();
                  failures = 0;
                  if (body && body !== last) {
                    // Deliver FIRST, advance `last` only once the delivery is
                    // durable. Advancing first meant a throttled or failed
                    // deliver still moved the watermark, so the next tick saw
                    // body === last and that change was lost for good.
                    const out = await deliver({
                      kind: 'polling',
                      name: source,
                      orchNames: [orchName],
                      body,
                      // Without an explicit key this fell back to
                      // sha256(kind:name:body), which omits the
                      // orchestration — so two orchestrations polling the
                      // same URL collapsed into one delivery and only the
                      // first ever ran.
                      idempotencyKey: null,
                      // Polling already holds its watermark and retries on the
                      // next tick, so the fire is not lost — but record it
                      // anyway so a sustained backlog is visible rather than
                      // only inferable from a warn.
                      recordIfThrottled: true,
                    });
                    if (out.throttled) {
                      // Queue is full: leave `last` alone so the change is
                      // retried on the next tick rather than dropped.
                      failures += 1;
                      console.warn(
                        `[sammy-pack-api] poll ${orchName}: delivery throttled, ` +
                          'will retry this change on the next tick',
                      );
                    } else {
                      last = body;
                    }
                  }
                } catch (e) {
                  failures += 1;
                  console.error(`[sammy-pack-api] poll ${orchName}:`, e);
                } finally {
                  const delay =
                    failures > 0
                      ? Math.min(baseMs * 2 ** failures, baseMs * 10)
                      : baseMs;
                  schedule(delay);
                }
              };
              schedule(baseMs);
              const stop = () => {
                stopped = true;
                if (timer) clearTimeout(timer);
              };
              // Registered PROCESS-GLOBALLY under a deterministic name, the
              // same way cron tasks are. The mount-scoped map below cannot
              // see a previous mount's pollers, so a re-mount in one process
              // (vite restart / HMR) used to leave the old one running and
              // fetching — one more live poller per reload.
              registerPoller(pollTaskName(orchName, source), stop);
              newPollTasks.push({ stop, trigger: t });
            }
          }
        }
        if (newCronTasks.length > 0) {
          cronTasksByOrch.set(orchName, newCronTasks);
        }
        if (newPollTasks.length > 0) {
          pollTasksByOrch.set(orchName, newPollTasks);
        }
        // Catalog every declared trigger (all kinds) for observability.
        const catalog: CatalogEntry[] = orch.triggers.map(t => ({
          orchestration: orchName,
          kind: t.kind,
          // A polling trigger's `describe` interpolates its `source`, which
          // commonly carries the credential in the URL. This catalog is an
          // unscoped GET like the trigger listing, so the same shared masker
          // applies — see the polling branch of GET /api/triggers.
          summary: describeTrigger(
            t.kind === 'polling'
              ? { ...t, source: maskSecretsDeep(t.source, 'source') as string }
              : t,
          ),
          ...(('signed' in t && providerFromSigned(t.signed)) || null
            ? { signed: providerFromSigned((t as { signed?: unknown }).signed)! }
            : {}),
        }));
        if (catalog.length > 0) triggerCatalog.set(orchName, catalog);
      }
      // Expose to the orchestration-save handler — the variable is
      // captured by reference, so the handler picks up the latest
      // function definition.
      const refreshTriggers = refreshTriggersForOrch;
      // Initial boot scan — register every existing orch's triggers.
      try {
        const orchEntries = await fs
          .readdir(examplesDir)
          .catch(() => [] as string[]);
        const onDisk = new Set<string>();
        for (const f of orchEntries) {
          if (!f.endsWith('.json')) continue;
          const name = f.replace(/\.json$/, '');
          onDisk.add(name);
          await refreshTriggers(name);
        }
        // Sweep cron tasks whose orchestration is GONE.
        //
        // The per-orch sweep only ever visits names still present on disk, so
        // an orchestration deleted or renamed OUTSIDE the API between two
        // mounts of one process kept its task alive in node-cron's global
        // registry — firing forever, each tick producing a `rejected`
        // delivery for a missing orchestration. The "process-globally
        // idempotent" claim held only for names that still existed.
        const getAllTasks = (
          cron as unknown as {
            getTasks?: () => Map<string, { name?: string; destroy?: () => void }>;
          }
        ).getTasks;
        if (typeof getAllTasks === 'function') {
          const orphaned: string[] = [];
          for (const task of getAllTasks().values()) {
            const name = task?.name;
            if (typeof name !== 'string' || !name.startsWith('sammy:cron:')) continue;
            // `sammy:cron:<orch>:<expr>` — the expression can contain colons,
            // so take the orch as the single segment after the prefix.
            const rest = name.slice('sammy:cron:'.length);
            const orch = rest.slice(0, rest.indexOf(':'));
            if (orch && !onDisk.has(orch)) {
              try {
                task.destroy?.();
                orphaned.push(name);
              } catch {
                /* already destroyed */
              }
            }
          }
          if (orphaned.length > 0) {
            console.warn(
              `[sammy-pack-api] destroyed ${orphaned.length} cron task(s) whose ` +
                `orchestration no longer exists: ${orphaned.join(', ')}`,
            );
          }
        }
        const wh = webhookTriggers.size;
        let cc = 0;
        for (const v of cronTasksByOrch.values()) cc += v.length;
        let pc = 0;
        for (const v of pollTasksByOrch.values()) pc += v.length;
        const ev = eventTriggers.size;
        const dp = deployTriggers.size;
        const qz = queueTriggers.size;
        if (wh + cc + pc + ev + dp + qz > 0) {
          console.log(
            `[sammy-pack-api] registered ${wh} webhook + ${cc} cron + ${pc} polling + ${ev} event + ${dp} deployment + ${qz} queue trigger(s) — hot-reload on /api/orchestrations save`,
          );
        }
      } catch (err) {
        console.error('[sammy-pack-api] trigger boot scan failed:', err);
      }

      // ─── Orphan reclamation (boot + re-scan + periodic) ─────────────
      //
      // `scanAndResumeOrphans` is defined near the top of the mount; it is
      // CALLED here because a reclaim now drains the reclaimed run's
      // concurrency group, and that drain starts the next parked fire through
      // the start-gate — which needs the group lock and the concurrency
      // declarations the trigger boot scan above just populated. Nothing can
      // reach the API before the mount returns, so moving the boot scan later
      // within it changes no observable ordering.
      await scanAndResumeOrphans('boot');

      // A run this process itself just crashed out of (fast restart) still
      // has a fresh lease at boot, so the scan above correctly left it alone
      // (it couldn't tell it from a live peer's run). Re-scan once after the
      // lease TTL: by then a genuinely-dead run's lease has lapsed and we
      // reclaim it, while a live peer's keeps moving forward and is untouched.
      // One-shot, unref'd so it never holds the process open.
      const rescanTimer = setTimeout(() => {
        void scanAndResumeOrphans('lease-expiry re-scan');
      }, DEFAULT_LEASE_TTL_MS);
      (rescanTimer as unknown as { unref?: () => void }).unref?.();

      // ─── PERIODIC orphan reclamation ───
      //
      // Boot + one re-scan covers a restart of THIS process. It does not cover
      // the case the lease exists for: a PEER dying while this process stays
      // up, in the N-servers/M-workers topology the deployment docs recommend.
      // Its runs then stay `status='running'` forever — and because
      // `findActiveRunsInGroup` counts `running`, such a run HOLDS ITS
      // CONCURRENCY GROUP forever, so every later fire for that group is
      // skipped or parked permanently. It is not resumable (resume requires
      // paused/interrupted/error), it is invisible to the sweepers (they read
      // only paused runs), and `/metrics` and `/api/runs` both report it
      // healthy and running. The project's own named failure class, with the
      // only recovery being a process restart.
      //
      // The interval-sweeper pattern already exists three times in this file
      // (stale gates, due waits, retention); this is the fourth, for the case
      // that most needed it. Runs at the lease TTL cadence — a lease can only
      // have lapsed after that long — and is unref'd like its siblings so it
      // never holds the process open.
      const orphanSweepMs = envPositiveInt(
        'SAMMY_ORPHAN_SWEEP_MS',
        DEFAULT_LEASE_TTL_MS,
      );
      const orphanSweepTimer = setInterval(() => {
        void scanAndResumeOrphans('periodic sweep');
      }, orphanSweepMs);
      (orphanSweepTimer as unknown as { unref?: () => void }).unref?.();

      // ─── Start the delivery worker (P1) ────────────────────────────
      // Requeue deliveries whose worker died mid-flight (status `claimed`
      // from a previous process), then start draining. This is the
      // delivery-level analogue of the run-level orphan resume above.
      try {
        const reclaimed = await store.reclaimStaleDeliveries(60_000, Date.now());
        if (reclaimed.count > 0) {
          console.log(
            `[sammy-pack-api] reclaimed ${reclaimed.count} stale delivery(ies) on boot: ${reclaimed.ids.join(', ')}`,
          );
        }
      } catch (err) {
        console.error('[sammy-pack-api] delivery reclaim on boot failed:', err);
      }
      // P6: a standalone worker process (npm run worker) can own draining
      // instead — set SAMMY_DISABLE_INPROCESS_WORKER=1 to keep the queue
      // drain loop out of the request path. deliver()'s kick() is a no-op
      // while the in-process worker is stopped, so enqueuing still works.
      const inProcessWorkerOff =
        process.env.SAMMY_DISABLE_INPROCESS_WORKER === '1' ||
        process.env.SAMMY_DISABLE_INPROCESS_WORKER === 'true';
      if (inProcessWorkerOff) {
        console.log(
          '[sammy-pack-api] in-process delivery worker DISABLED — run `npm run worker` to drain the queue',
        );
      } else {
        deliveryWorker.start();
        console.log(
          '[sammy-pack-api] delivery worker started (durable trigger queue)',
        );
        // Best-effort graceful stop when the dev server shuts down.
        server.httpServer?.once('close', () => {
          void deliveryWorker.stop();
        });
      }

      // ─── Stale-gate TTL sweeper ────────────────────────────────────
      //
      // PROBLEM: a run paused at a human gate held its concurrency group for
      // DAYS while every cron fire queued silently behind it — the only
      // signal was one console.log at queue time. The sweep (core logic in
      // run-store.ts: sweepStaleGates) finds paused runs older than
      // SAMMY_GATE_TTL_HOURS, alerts ONCE per pause leg (console.warn + the
      // orchestration's notify webhook, deduped by a durable `gate-stale`
      // marker so restarts don't re-nag), refreshes the list-decoration
      // snapshot, and — opt-in via SAMMY_GATE_TTL_ACTION=cancel — auto-
      // cancels the stale run through the shared cancel seam, which frees
      // its group and drains the next queued fire. Runs once at boot, then
      // every 10 minutes; a sweep hiccup only logs (never crashes the mount).
      const STALE_GATE_SWEEP_MS = 10 * 60_000;
      const runStaleGateSweep = async (): Promise<void> => {
        if (gateTtl <= 0) return; // SAMMY_GATE_TTL_HOURS=0 → feature off.
        try {
          const entries = await sweepStaleGates(store, {
            ttlMs: gateTtl,
            action: gateAction,
            onStale: async (entry, run) => {
              const ageH = (
                (Date.now() - entry.pausedSinceMs) / 3_600_000
              ).toFixed(1);
              console.warn(
                `[sammy-pack-api] STALE GATE: run ${entry.runId} ` +
                  `(${entry.orchestrationName}) has been paused at ` +
                  `"${entry.pausedFor ?? 'unknown'}" for ${ageH}h ` +
                  `(SAMMY_GATE_TTL_HOURS=${(gateTtl / 3_600_000).toFixed(2)}). ` +
                  (gateAction === 'cancel'
                    ? 'Auto-cancelling (SAMMY_GATE_TTL_ACTION=cancel).'
                    : 'It still holds its concurrency group — queued fires stay ' +
                      'parked behind it. Approve/reject it, or set ' +
                      'SAMMY_GATE_TTL_ACTION=cancel.'),
              );
              // Out-of-band webhook via the orchestration's one configured
              // sink (notify.onTerminal, read from the run's snapshot).
              // Best-effort + fire-and-forget, like the terminal notify.
              fireGateStaleNotify({
                notify: (run.orchestrationSnapshot as Node | null)?.notify,
                runId: entry.runId,
                orchestration: entry.orchestrationName,
                pausedFor: entry.pausedFor,
                pausedSinceMs: entry.pausedSinceMs,
                ttlMs: gateTtl,
                action: gateAction,
              });
              if (gateAction === 'cancel') {
                const out = await cancelStoredRunAndDrain(entry.runId);
                console.warn(
                  out.outcome === 'cancelled'
                    ? `[sammy-pack-api] stale run ${entry.runId} auto-cancelled — ` +
                        `its concurrency group is released and the next queued ` +
                        `fire (if any) was drained.`
                    : `[sammy-pack-api] stale run ${entry.runId} auto-cancel ` +
                        `skipped (${out.outcome}).`,
                );
              }
            },
          });
          // Refresh the list-decoration snapshot to exactly the current
          // stale set (an approved/cancelled run drops out on this tick;
          // the list handler additionally guards on status === 'paused').
          staleGates.clear();
          for (const e of entries) {
            staleGates.set(e.runId, { pausedSinceMs: e.pausedSinceMs });
          }
        } catch (err) {
          console.error('[sammy-pack-api] stale-gate sweep failed:', err);
        }
      };
      void runStaleGateSweep(); // once at boot — a restart re-arms visibility
      const staleGateTimer = setInterval(() => {
        void runStaleGateSweep();
      }, STALE_GATE_SWEEP_MS);
      (staleGateTimer as unknown as { unref?: () => void }).unref?.();

      // ─── Durable-wait sweeper ──────────────────────────────────────
      //
      // A `wait` leaf parks its run as status='paused' with
      // stateJson.pendingWait as the cheap header index (run-controller
      // writes it at pause time). Timer waits resume here when due; signal
      // waits when their timeoutSeconds deadline passes (so the timeout
      // error surfaces) or — once per pause leg — when a delivery arrived
      // BEFORE the pause landed (buffered in the event log). A delivery to
      // an already-paused run is resumed immediately by the /signal
      // endpoint, not here. 30s cadence: wait granularity is therefore
      // ~30s, which the durable multi-minute / multi-day waits this feature
      // exists for don't notice. Core logic in src/server/wait-resolution.ts
      // (sweepDueWaits) so tests can drive it directly against a store.
      const resumeStoredRunForWait = async (
        runId: string,
      ): Promise<{ ok: boolean; reason?: string }> => {
        const stored = await store.getRun(runId);
        if (!stored) return { ok: false, reason: 'run not found' };
        if (stored.status !== 'paused')
          return { ok: false, reason: `run is ${stored.status}` };
        const ctx = await loadRunContext(stored.orchestrationName, {
          orchestrationOverride: stored.orchestrationSnapshot as Node | null,
        });
        if (!ctx)
          return {
            ok: false,
            reason: `orchestration not found: ${stored.orchestrationName}`,
          };
        const result = await resumeServerRun({
          store,
          id: runId,
          // A sweeper- or signal-resumed wait leg is usually the run's LAST
          // leg — without the hook its terminal skipped event publishing /
          // notify / group drain entirely (and the leg escaped budget caps).
          budgetGate: (await loadBudgetState(budgetFile, store, stored.ownerId)).gate,
          onTerminal: buildTerminalHook(
            stored.orchestrationName,
            ctx.orchestration,
            stored.ownerId,
          ),
          divergence: ctx.orchestration.notify?.divergence,
          buildEventSource: (signal, replayOutputs, autoApproveLocks, _gms, rid, waits, inputs) =>
            buildExecutorSource(
              ctx,
              {
                initialInput: stored.initialInput ?? undefined,
                allowAgentTools: true,
                replayOutputs,
                autoApproveLocks,
                ownerId: stored.ownerId,
                runId: rid,
                pendingWaits: waits.pendingWaits,
                deliveredSignals: waits.deliveredSignals,
                resolvedInputs: inputs,
              },
              signal,
            ),
        });
        return result.ok ? { ok: true } : { ok: false, reason: result.reason };
      };
      const WAIT_SWEEP_MS = 30_000;
      const checkedSignalScans = new Set<string>();
      const runWaitSweep = async (): Promise<void> => {
        try {
          await sweepDueWaits(store, {
            checkedSignalScans,
            resume: async (runId, reason) => {
              const out = await resumeStoredRunForWait(runId);
              console.log(
                out.ok
                  ? `[sammy-pack-api] wait sweeper resumed run ${runId} (${reason})`
                  : `[sammy-pack-api] wait sweeper could not resume ${runId} ` +
                      `(${reason}): ${out.reason}`,
              );
            },
          });
        } catch (err) {
          console.error('[sammy-pack-api] wait sweep failed:', err);
        }
      };
      // Once at boot — waits that came due while the server was down resume
      // immediately (durable-timer semantics across restarts).
      void runWaitSweep();
      const waitSweepTimer = setInterval(() => {
        void runWaitSweep();
      }, WAIT_SWEEP_MS);
      (waitSweepTimer as unknown as { unref?: () => void }).unref?.();

      // Mount-shutdown lifecycle: when the server closes, end ALL of this
      // mount's background work (same seam the delivery worker uses).
      //
      //  - the three interval sweeps: unref'd, so they never hold the
      //    process open, but they DO keep firing while it lives — against a
      //    closed store that's one error log per tick, and in the in-band
      //    test runner it's dozens of dead mounts sweeping at once.
      //  - cron trigger tasks: NOT unref'd (node-cron arms a plain setTimeout
      //    heartbeat and never unrefs it), so a mount whose server closed
      //    otherwise keeps the PROCESS alive forever. Polling timers ARE
      //    unref'd and so cannot hold the process open — but they must still
      //    be stopped here, because a live poller keeps fetching its source
      //    and delivering against a closed mount.
      //    This was the CI hang: on a 2-core runner Jest runs in-band, the
      //    trigger suites' cron/polling tasks outlived their closed
      //    servers, and the job sat at "Ran all test suites" until the
      //    6-hour GitHub timeout. It is also the correct production
      //    semantic — serve.ts closing its server should stop firing crons.
      server.httpServer?.once('close', () => {
        clearInterval(staleGateTimer);
        clearInterval(retentionTimer);
        clearInterval(waitSweepTimer);
        clearInterval(orphanSweepTimer);
        for (const tasks of cronTasksByOrch.values()) {
          for (const task of tasks) {
            try { task.stop(); } catch { /* already stopped */ }
          }
        }
        cronTasksByOrch.clear();
        for (const tasks of pollTasksByOrch.values()) {
          for (const task of tasks) {
            try { task.stop(); } catch { /* already stopped */ }
          }
        }
        pollTasksByOrch.clear();
        // Also clear the PROCESS-GLOBAL registry: a poller left by an earlier
        // mount of this process is invisible to the map above, and that is
        // the leak this registry exists to close.
        destroyAllPollers();
      });

      // ─── Runs retention (opt-in) ───────────────────────────────────
      //
      // runs.db grows without bound (a real one reached 268 MB — per-chunk
      // phase-delta events dominate). SAMMY_RUN_RETENTION_DAYS=N turns on a
      // prune of TERMINAL runs (done / error / cancelled — never paused /
      // interrupted / running, which are resumable or alive) older than N
      // days, at boot + daily. OFF unless the env var is set: deleting
      // history must be an explicit operator decision. The store does the
      // deletion + (SQLite) VACUUM and reports bytes actually reclaimed.
      const retentionDays = runRetentionDays();
      const runRetentionSweep = async (): Promise<void> => {
        if (retentionDays === null) return;
        try {
          const { count, reclaimedBytes } = await store.pruneTerminalRuns(
            retentionDays * 86_400_000,
            Date.now(),
          );
          if (count > 0) {
            const reclaimed =
              reclaimedBytes !== null
                ? `reclaimed ~${(reclaimedBytes / 1_000_000).toFixed(1)} MB`
                : 'space reclaim deferred to autovacuum (postgres)';
            console.log(
              `[sammy-pack-api] retention: deleted ${count} run(s) older ` +
                `than ${retentionDays} day(s), ${reclaimed}`,
            );
          }
        } catch (err) {
          console.error('[sammy-pack-api] retention sweep failed:', err);
        }
        try {
          // Deliveries are pruned on the SAME opt-in schedule. Retention used
          // to cover runs + events only, so trigger_deliveries grew forever —
          // one row per cron tick — and it is also the table header-key
          // idempotency is checked against, so the dedupe guarantee was
          // resting on something nobody trimmed. Pruning forgets those keys,
          // which is why it stays the operator's explicit choice.
          const { count } = await store.pruneTerminalDeliveries(
            retentionDays * 86_400_000,
            Date.now(),
          );
          if (count > 0) {
            console.log(
              `[sammy-pack-api] retention: deleted ${count} terminal ` +
                `delivery(ies) older than ${retentionDays} day(s) — their ` +
                'idempotency keys are now forgotten',
            );
          }
        } catch (err) {
          console.error('[sammy-pack-api] delivery retention sweep failed:', err);
        }
      };
      void runRetentionSweep(); // once at boot
      const retentionTimer = setInterval(() => {
        void runRetentionSweep();
      }, 24 * 3_600_000);
      (retentionTimer as unknown as { unref?: () => void }).unref?.();

      // ─── Boot config echo ──────────────────────────────────────────
      //
      // A server restart without SAMMY_ALLOW_CODE_RUN once made every
      // scheduled run halt at preflight — env-coupled correctness with
      // NOTHING echoed at boot. Print the effective config ONCE, after
      // trigger registration, so "what is this server actually going to do"
      // is answerable from the first screen of logs; then a WARNING per
      // triggered orchestration that is already doomed by the code.run flag
      // (the exact failure that motivated this). Placed in the shared mount
      // so the vite plugin and serve.ts echo identically.
      try {
        const dbSize = async (): Promise<string> => {
          if (!store.filePath) return '';
          try {
            const st = await fs.stat(store.filePath);
            return ` (${(st.size / 1_000_000).toFixed(1)} MB)`;
          } catch {
            return ' (size unknown)';
          }
        };
        const exists = async (file: string): Promise<string> =>
          (await fs.stat(file).then(() => true, () => false))
            ? 'exists'
            : 'missing';
        const storeLine =
          store.backend === 'sqlite'
            ? `sqlite ${store.filePath ?? path.join(root, 'runs.db')}${await dbSize()}`
            : 'postgres (DATABASE_URL)';
        // Registered-trigger counts by kind (post-registration truth — a
        // declared-but-refused trigger, e.g. a webhook path conflict or an
        // invalid cron expr, is deliberately NOT counted).
        let cronCount = 0;
        for (const tasks of cronTasksByOrch.values()) cronCount += tasks.length;
        let pollCount = 0;
        for (const tasks of pollTasksByOrch.values()) pollCount += tasks.length;
        const triggersLine =
          `${webhookTriggers.size} webhook, ${cronCount} cron, ` +
          `${pollCount} polling, ${eventTriggers.size} event, ` +
          `${deployTriggers.size} deployment, ${queueTriggers.size} queue`;
        // The auth posture is printed UNCONDITIONALLY. It used to be logged
        // only when SAMMY_API_TOKEN was set — so the most dangerous posture,
        // an open server, was the one that printed nothing at all. Each
        // clause names the variable that changes it.
        const bindHost = process.env.SAMMY_BIND_HOST?.trim();
        const authLine =
          (apiToken
            ? 'SAMMY_API_TOKEN set — mutating /api routes require the bearer' +
              (verifyToken ? ' token OR a verified JWT' : '')
            : 'SAMMY_API_TOKEN UNSET — every mutating /api route is ' +
              (verifyToken
                ? 'gated by the JWT verifier only'
                : 'OPEN (set it before exposing this port)')) +
          '; reads ' +
          (requireAuthReads
            ? apiToken || verifyToken
              ? 'GATED (SAMMY_REQUIRE_AUTH_READS=1)'
              : 'GATED IN NAME ONLY — SAMMY_REQUIRE_AUTH_READS=1 but no ' +
                'token or JWT verifier exists to gate them with'
            : 'OPEN (set SAMMY_REQUIRE_AUTH_READS=1 to gate them)') +
          '; root /metrics ' +
          (requireAuthReads && !metricsPublic && (apiToken || verifyToken)
            ? 'gated like /api reads'
            : metricsPublic
              ? 'PUBLIC (SAMMY_METRICS_PUBLIC=1)'
              : 'open') +
          '; root agent card ' +
          (requireAuthReads && (apiToken || verifyToken)
            ? 'gated like /api reads'
            : 'open') +
          '; bind host ' +
          (bindHost ||
            '(SAMMY_BIND_HOST unset — serve.ts binds 127.0.0.1; under Vite, ' +
              'its own host setting)');
        const identityLine = verifyToken
          ? identityLabel
          : 'client-supplied X-Sammy-User header (no JWT verifier — set ' +
            'SAMMY_JWT_SECRET / SAMMY_JWT_PUBLIC_KEY / SAMMY_JWKS_URI)';
        const roots = await importRoots(root);
        const importRootsLine =
          `${roots.join(', ')}` +
          (envIsSet('SAMMY_IMPORT_ROOTS')
            ? ' (SAMMY_IMPORT_ROOTS)'
            : ' (workspace only — SAMMY_IMPORT_ROOTS unset)');
        const streamMode = (process.env.SAMMY_LLM_STREAM_TOOLS ?? '')
          .trim()
          .toLowerCase();
        const streamAllow = (process.env.SAMMY_LLM_STREAM_TOOL_ALLOWLIST ?? '')
          .trim();
        const llmToolsLine =
          streamMode === 'off'
            ? 'OFF — tool-bearing /api/llm/stream calls are refused (SAMMY_LLM_STREAM_TOOLS=off)'
            : streamAllow
              ? `allowlisted: ${streamAllow} (SAMMY_LLM_STREAM_TOOL_ALLOWLIST)`
              : 'UNRESTRICTED — /api/llm/stream accepts any tool set ' +
                '(SAMMY_LLM_STREAM_TOOLS unset; set =off for a shared deployment)';
        const signedTriggersLine = requireSignedTriggers
          ? 'REQUIRED — unsigned HTTP-fired triggers are refused at fire time ' +
            '(SAMMY_REQUIRE_SIGNED_TRIGGERS=1)'
          : 'optional — only triggers marked `signed` verify a signature ' +
            '(set SAMMY_REQUIRE_SIGNED_TRIGGERS=1 to refuse unsigned ingress)';
        console.log(
          '[sammy-pack-api] boot config:\n' +
            [
              `code.run: ${
                codeRunMode() === 'unrestricted'
                  ? 'ENABLED, unrestricted (SAMMY_ALLOW_CODE_RUN)'
                  : codeRunMode() === 'allowlist'
                    ? `ALLOWLISTED, no shell — ${codeRunAllowlist().length} pattern(s) (SAMMY_CODE_RUN_ALLOW)`
                    : 'disabled (SAMMY_ALLOW_CODE_RUN / SAMMY_CODE_RUN_ALLOW)'
              }`,
              `store: ${storeLine}`,
              `connections file: ${credentialsFile} (${await exists(credentialsFile)})`,
              `budget file: ${budgetFile} (${await exists(budgetFile)})`,
              `gate TTL: ${
                gateTtl > 0
                  ? `${(gateTtl / 3_600_000).toFixed(2)}h, action=${gateAction}`
                  : 'disabled (SAMMY_GATE_TTL_HOURS=0)'
              }`,
              // "unset" vs "set and REJECTED" are different operator
              // problems and used to print identically: a value like `14d`
              // parsed to NaN, retention stayed off, and the banner told the
              // operator they had not configured it.
              `retention: ${
                retentionDays !== null
                  ? `${retentionDays} day(s)`
                  : envIsSetButInvalid('SAMMY_RUN_RETENTION_DAYS')
                    ? `OFF — SAMMY_RUN_RETENTION_DAYS="${process.env.SAMMY_RUN_RETENTION_DAYS}" is INVALID (expects a number of days)`
                    : envIsSet('SAMMY_RUN_RETENTION_DAYS')
                      ? 'OFF (SAMMY_RUN_RETENTION_DAYS=0)'
                      : 'OFF (SAMMY_RUN_RETENTION_DAYS unset)'
              }`,
              // No user store and no account creation — roles are pure
              // config, so the banner is the only place an operator can see
              // whether they are doing anything.
              `roles: ${
                rolesConfigured()
                  ? `read/write enforced (${
                      process.env.SAMMY_JWT_ROLE_CLAIM?.trim()
                        ? `JWT claim "${process.env.SAMMY_JWT_ROLE_CLAIM.trim()}"`
                        : 'SAMMY_READONLY_USERS'
                    })${
                      requireAuthReads
                        ? ''
                        : ' — ADVISORY ONLY: reads are open, so identity is ' +
                          'client-supplied (set SAMMY_REQUIRE_AUTH_READS=1)'
                    }`
                  : 'not configured — every identity is write ' +
                    '(SAMMY_READONLY_USERS / SAMMY_JWT_ROLE_CLAIM)'
              }`,
              `auth: ${authLine}`,
              `identity: ${identityLine}`,
              `import roots: ${importRootsLine}`,
              `llm stream tools: ${llmToolsLine}`,
              `agent MCP servers: ${
                /^(1|true|yes|on)$/i.test(process.env.SAMMY_AGENT_AMBIENT_MCP?.trim() ?? '')
                  ? "INHERITED — agents also see this host's own Claude MCP servers and connectors (SAMMY_AGENT_AMBIENT_MCP=1)"
                  : "only those a phase declares in `mcp` (set SAMMY_AGENT_AMBIENT_MCP=1 to also inherit this host's)"
              }`,
              `signed triggers: ${signedTriggersLine}`,
              `triggers: ${triggersLine}`,
            ]
              .map(l => `  ${l}`)
              .join('\n'),
        );
        // Under SAMMY_REQUIRE_SIGNED_TRIGGERS=1, name every registered
        // HTTP-fired trigger the flag will refuse — at boot, per trigger,
        // with the fix — instead of letting each sender discover a 403.
        // Same shape as the code.run doom warning below.
        if (requireSignedTriggers) {
          for (const entries of triggerCatalog.values()) {
            for (const e of entries) {
              if (getTriggerKind(e.kind as Trigger['kind'])?.fired !== 'http') continue;
              if (e.signed) continue;
              console.warn(
                `[sammy-pack-api] WARNING: ${e.kind} trigger "${e.summary}" ` +
                  `(${e.orchestration}) is unsigned and will be REFUSED at ` +
                  `fire time (SAMMY_REQUIRE_SIGNED_TRIGGERS=1) — declare ` +
                  `signed: true (or a provider name) on it.`,
              );
            }
          }
        }
        // The doomed-by-config warning: an orchestration that fires
        // UNATTENDED (cron / webhook) and uses code.run will halt at
        // preflight on EVERY fire while the flag is off. Say so at boot —
        // per orchestration, naming the fix — instead of letting each fire
        // discover it. Uses the executor's own preflight walker
        // (orchestrationUsesCodeRun), so this warning and the runtime halt
        // can never disagree about what "uses code.run" means.
        if (!codeRunEnabled()) {
          for (const [orchName, entries] of triggerCatalog) {
            if (!codeRunOrchs.has(orchName)) continue;
            const scheduled = entries.filter(
              e => e.kind === 'cron' || e.kind === 'webhook',
            );
            if (scheduled.length === 0) continue;
            console.warn(
              `[sammy-pack-api] WARNING: scheduled orchestration ` +
                `"${orchName}" (${scheduled.map(e => e.kind).join(', ')}) ` +
                `will halt at preflight: code.run disabled. Every fire will ` +
                `error immediately — set SAMMY_ALLOW_CODE_RUN=1 or SAMMY_CODE_RUN_ALLOW, or remove ` +
                `the code.run node.`,
            );
          }
        }
      } catch (err) {
        // The banner is observability only — it must never break the mount.
        console.error('[sammy-pack-api] boot config echo failed:', err);
      }

      // Umbrella dispatcher — one middleware, looks up the path in
      // the mutable map. Hot-reload "just works" because the map is
      // mutated by refreshTriggersForOrch.
      server.middlewares.use('/api/triggers', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname
            .replace(/^\//, '')
            .split('/')
            .filter(Boolean);
          const path = segs[0];
          if (!path) {
            // Unified introspection across ALL six kinds. Each row carries the
            // kind-specific `config` the UI renders (cron expr / polling
            // source+interval / http path+method+name) plus the `firing` axis
            // ('http' = fired by an inbound POST /api/triggers/<name>;
            // 'schedule' = fired by a server-side timer). `summary` is the
            // registry's human one-liner. Schedule rows are read-only here.
            const list: Array<{
              kind: Trigger['kind'];
              name: string;
              orchestration: string;
              firing: 'http' | 'schedule';
              summary: string;
              config: Record<string, unknown>;
              /** Present when this trigger's orchestration declares a
               *  concurrency group an ACTIVE run currently holds — i.e. a
               *  fire right now would not start (it would queue / skip /
               *  cancel-existing per policy). `heldSinceMs` is the EPOCH ms
               *  the holder started. Answers "why didn't my cron run" from
               *  the endpoint the operator already checks. */
              blockedBy?: {
                runId: string;
                group: string;
                heldSinceMs: number;
              };
            }> = [];
            // `firing` is single-sourced from the kind registry so it can
            // never drift from validate.ts / the executor's dispatch half.
            const firingOf = (k: Trigger['kind']): 'http' | 'schedule' =>
              getTriggerKind(k)?.fired ?? 'http';
            // Ingress options in force for this subscriber, so the Triggers
            // view shows what an inbound fire will go through.
            const intakeConfig = (kind: string, name: string, orch: string) => {
              const o = intakeOptsFor(kind, name, orch);
              if (!o) return {};
              return {
                ...(o.idempotencyTtlSeconds ? { idempotencyTtlSeconds: o.idempotencyTtlSeconds } : {}),
                ...(o.scrub
                  ? {
                      scrub: {
                        ...(o.scrub.allowFields ? { allowFields: o.scrub.allowFields.length } : {}),
                        ...(o.scrub.dropFields ? { dropFields: o.scrub.dropFields.length } : {}),
                        ...(o.scrub.hashFields ? { hashFields: o.scrub.hashFields.length } : {}),
                        builtins:
                          o.scrub.builtins === false
                            ? 'off'
                            : Array.isArray(o.scrub.builtins)
                              ? o.scrub.builtins.join(', ')
                              : 'all',
                        ...(o.scrub.patterns ? { patterns: o.scrub.patterns.length } : {}),
                      },
                    }
                  : {}),
              };
            };
            // webhook — one path → one orch.
            for (const [p, e] of webhookTriggers) {
              const trigger: Trigger = {
                kind: 'webhook',
                path: p,
                method: e.method as 'GET' | 'POST',
              };
              list.push({
                kind: 'webhook',
                name: p,
                orchestration: e.orchName,
                firing: firingOf('webhook'),
                summary: describeTrigger(trigger),
                config: {
                  path: p,
                  method: e.method,
                  ...intakeConfig('webhook', p, e.orchName),
                  ...(e.signed
                    ? {
                        signed: true,
                        signatureProvider: e.signed,
                        signatureHeaders: providerHeaders(e.signed),
                      }
                    : {}),
                },
              });
            }
            // events / deployment / queue — named, may fan out to many orchs.
            const namedKinds: Array<{
              kind: Extract<Trigger['kind'], 'events' | 'deployment' | 'queue'>;
              map: Map<string, NamedTriggerEntry>;
              toTrigger: (name: string) => Trigger;
            }> = [
              { kind: 'events', map: eventTriggers, toTrigger: n => ({ kind: 'events', event: n }) },
              { kind: 'deployment', map: deployTriggers, toTrigger: n => ({ kind: 'deployment', environment: n }) },
              { kind: 'queue', map: queueTriggers, toTrigger: n => ({ kind: 'queue', queue: n }) },
            ];
            for (const { kind, map, toTrigger } of namedKinds) {
              for (const [n, e] of map) {
                // A subscriber conflict is surfaced here too — otherwise the
                // endpoint looks healthy until the first fire 500s.
                const resolved = resolveNamedProvider(e);
                const signatureProvider =
                  'conflict' in resolved ? null : resolved.provider;
                const summary = describeTrigger(toTrigger(n));
                for (const orchName of e.orchNames) {
                  list.push({
                    kind,
                    name: n,
                    orchestration: orchName,
                    firing: firingOf(kind),
                    summary,
                    // POST verb is uniform for the named HTTP-fired kinds.
                    config: {
                      name: n,
                      method: 'POST',
                      ...intakeConfig(kind, n, orchName),
                      ...(signatureProvider
                        ? {
                            signed: true,
                            signatureProvider,
                            signatureHeaders: providerHeaders(signatureProvider),
                          }
                        : {}),
                      ...('conflict' in resolved
                        ? { signed: true, signatureConflict: resolved.conflict }
                        : {}),
                    },
                  });
                }
              }
            }
            // cron — schedule-fired; surface the expr (and orch).
            for (const [orchName, tasks] of cronTasksByOrch) {
              for (const task of tasks) {
                // `paused` is reported because the breaker's auto-pause stops
                // the task but leaves this entry in place — so this endpoint,
                // the only surface that answers "is my cron running?", used to
                // say yes about a schedule it had itself disabled.
                const paused = pausedCronSchedules.has(
                  pausedCronKey(orchName, task.trigger.expr),
                );
                list.push({
                  kind: 'cron',
                  name: task.trigger.expr,
                  orchestration: orchName,
                  firing: firingOf('cron'),
                  summary: describeTrigger(task.trigger),
                  config: {
                    expr: task.trigger.expr,
                    schedule: task.trigger.expr,
                    // Always reported, declared or not: "0 9 * * *" means a
                    // different moment per zone, so the one place that
                    // answers "when does this fire?" must say which.
                    timezone:
                      task.trigger.timezone ??
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    timezoneSource: task.trigger.timezone ? 'declared' : 'server',
                    ...(paused
                      ? {
                          paused: true,
                          pausedReason:
                            'auto-paused by the cron circuit-breaker after ' +
                            'consecutive failures (SAMMY_CRON_AUTO_PAUSE=1); ' +
                            're-register to resume (server restart or PUT ' +
                            `/api/orchestrations/${orchName})`,
                        }
                      : {}),
                  },
                });
              }
            }
            // polling — schedule-fired; surface source + interval.
            //
            // The source is an arbitrary external URL, and the common shape
            // for a feed poll carries its credential IN that URL
            // (`https://user:token@host/…`, `?token=…`) — the same two shapes
            // `GET /api/mcp-servers` learned to mask, because authors put
            // secrets in config whatever the model says. This listing shipped
            // it verbatim, unscoped and reachable by any read identity. Run
            // through the SHARED by-shape masker, never a second predicate:
            // a plain URL stays readable, a secret-bearing one does not.
            for (const [orchName, tasks] of pollTasksByOrch) {
              for (const task of tasks) {
                const source = maskSecretsDeep(
                  task.trigger.source,
                  'source',
                ) as string;
                list.push({
                  kind: 'polling',
                  name: source,
                  orchestration: orchName,
                  firing: firingOf('polling'),
                  // The kind's own `describe` interpolates the source, so the
                  // summary is a third copy of it — described from the masked
                  // trigger, not the raw one.
                  summary: describeTrigger({ ...task.trigger, source }),
                  config: {
                    source,
                    intervalSeconds: task.trigger.intervalSeconds,
                  },
                });
              }
            }
            list.sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
            );
            // blockedBy: for each row whose orchestration declares a
            // concurrency group, report the run currently HOLDING that group
            // (if any) — the answer to "the cron is registered, why didn't
            // it run". One store query per DISTINCT group (cached across
            // rows), not per row; a lookup failure degrades to no decoration
            // rather than failing the whole listing.
            const heldByGroup = new Map<
              string,
              { runId: string; heldSinceMs: number } | null
            >();
            for (const row of list) {
              const conc = concurrencyByOrch.get(row.orchestration);
              // A templated group has no single holder — it is one group PER
              // input key — so there is nothing truthful to decorate with.
              if (!conc || isGroupTemplate(conc.group)) continue;
              let held = heldByGroup.get(conc.group);
              if (held === undefined) {
                try {
                  const active = await store.findActiveRunsInGroup(conc.group);
                  held = active[0]
                    ? { runId: active[0].id, heldSinceMs: active[0].startedAt }
                    : null;
                } catch {
                  held = null; // store hiccup — leave the row undecorated
                }
                heldByGroup.set(conc.group, held);
              }
              if (held) row.blockedBy = { ...held, group: conc.group };
            }
            return sendJson(res, 200, list);
          }
          // POST /api/triggers/<name> — fire an HTTP-fired trigger by name.
          // Webhooks match by path; if not a webhook, fall back to the named
          // HTTP-fired kinds (events / deployment / queue) so the UI's Test
          // button can fire every http-fired kind through this one endpoint.
          const entry = webhookTriggers.get(path);
          if (!entry) {
            const named: Array<{
              label: 'events' | 'deployment' | 'queue';
              map: Map<string, NamedTriggerEntry>;
            }> = [
              { label: 'events', map: eventTriggers },
              { label: 'deployment', map: deployTriggers },
              { label: 'queue', map: queueTriggers },
            ];
            for (const { label, map } of named) {
              const ne = map.get(path);
              if (ne && ne.orchNames.length > 0) {
                const reqMethod = (req.method ?? 'POST').toUpperCase();
                if (reqMethod !== 'POST') {
                  return sendError(res, 405, 'Use POST');
                }
                if (requireSignedTriggers && ne.signedBy.length === 0) {
                  return refuseUnsignedIngress(res, `${label} trigger "${path}"`);
                }
                const nraw = await readFireBody(req, res, `${label} trigger "${path}"`);
                if (nraw === null) return;
                if (
                  ne.signedBy.length > 0 &&
                  !requireNamedSignature(req, res, nraw, `${label} trigger "${path}"`, ne)
                ) {
                  return;
                }
                const nbody = nraw.toString('utf8');
                const nidem = req.headers['idempotency-key'];
                const nout = await deliver({
                  kind: label,
                  name: path,
                  orchNames: ne.orchNames,
                  body: nbody,
                  idempotencyKey: Array.isArray(nidem) ? nidem[0] : nidem,
                  ownerId: extractOwnerId(req),
                });
                if (nout.throttled) {
                  return sendError(
                    res,
                    429,
                    `Queue full (≥ ${MAX_QUEUE_DEPTH} pending) — retry later`,
                  );
                }
                return sendJson(res, nout.duplicate ? 200 : 202, {
                  trigger: label,
                  name: path,
                  duplicate: nout.duplicate,
                  deliveryId: nout.deliveries[0]?.deliveryId ?? null,
                  deliveries: nout.deliveries,
                });
              }
            }
            return sendError(res, 404, `No trigger registered for "${path}"`);
          }
          const reqMethod = (req.method ?? 'POST').toUpperCase();
          if (reqMethod !== entry.method) {
            return sendError(res, 405, `Use ${entry.method}`);
          }
          if (requireSignedTriggers && !entry.signed) {
            return refuseUnsignedIngress(res, `Webhook "${path}"`);
          }
          const raw = await readFireBody(req, res, `Webhook "${path}"`);
          if (raw === null) return;
          // P4: a signed webhook must carry a valid signature — the native
          // scheme (replay-protected v2 or legacy) for `signed: true`, or the
          // named provider's own scheme. Verified over the RAW bytes. The
          // secret lives in SAMMY_WEBHOOK_SECRET (never in committed JSON).
          if (
            entry.signed &&
            !requireSignature(req, res, raw, `Webhook "${path}"`, entry.signed)
          ) {
            return;
          }
          const body = raw.toString('utf8');
          const idem = req.headers['idempotency-key'];
          const out = await deliver({
            kind: 'webhook',
            name: path,
            orchNames: [entry.orchName],
            body,
            idempotencyKey: Array.isArray(idem) ? idem[0] : idem,
            ownerId: extractOwnerId(req),
          });
          if (out.throttled) {
            return sendError(
              res,
              429,
              `Queue full (≥ ${MAX_QUEUE_DEPTH} pending) — retry later`,
            );
          }
          // 202 Accepted: the delivery is durably queued; the worker creates
          // the run. 200 for an idempotent replay. There is no runId yet
          // (accept≠execute) — return the deliveryId to poll
          // GET /api/deliveries with, not a misleading always-null `id`.
          return sendJson(res, out.duplicate ? 200 : 202, {
            trigger: 'webhook',
            name: path,
            duplicate: out.duplicate,
            deliveryId: out.deliveries[0]?.deliveryId ?? null,
            deliveries: out.deliveries,
          });
        } catch (err) {
          console.error('[sammy-pack-api] /api/triggers error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // Named HTTP-fired trigger dispatcher — one factory for the
      // events / deployment / queue namespaces. GET (no name) lists the
      // registered names; POST /<name> fires every subscribed orch and
      // returns the started run ids. Hot-reloads via the mutable maps.
      const makeNamedTriggerMiddleware = (
        label: string,
        map: Map<string, NamedTriggerEntry>,
      ) => async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const name = url.pathname.replace(/^\//, '').split('/').filter(Boolean)[0];
          if (!name) {
            return sendJson(
              res,
              200,
              Array.from(map.entries()).map(([n, e]) => {
                const resolved = resolveNamedProvider(e);
                return {
                  name: n,
                  orchestrations: e.orchNames,
                  signed: e.signedBy.length > 0,
                  ...('conflict' in resolved
                    ? { signatureConflict: resolved.conflict }
                    : resolved.provider
                      ? { signatureProvider: resolved.provider }
                      : {}),
                };
              }),
            );
          }
          const entry = map.get(name);
          const orchs = entry?.orchNames;
          if (!entry || !orchs || orchs.length === 0) {
            return sendError(res, 404, `No ${label} trigger registered for "${name}"`);
          }
          // A fire is a POST, as the umbrella /api/triggers dispatcher already
          // enforced for these same kinds. This factory had no method check at
          // all, so `GET /api/events/<name>` — a bare link, an image tag, a
          // prefetch — started a run.
          if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
            return sendError(res, 405, 'Use POST');
          }
          if (requireSignedTriggers && entry.signedBy.length === 0) {
            return refuseUnsignedIngress(res, `${label} trigger "${name}"`);
          }
          const raw = await readFireBody(req, res, `${label} trigger "${name}"`);
          if (raw === null) return;
          // Same gate as signed webhooks — if ANY subscriber demands a
          // signature, the endpoint requires one (strictest wins), using that
          // subscriber's declared scheme, over the RAW bytes.
          if (
            entry.signedBy.length > 0 &&
            !requireNamedSignature(req, res, raw, `${label} trigger "${name}"`, entry)
          ) {
            return;
          }
          const body = raw.toString('utf8');
          const idem = req.headers['idempotency-key'];
          const out = await deliver({
            kind: label,
            name,
            orchNames: orchs,
            body,
            idempotencyKey: Array.isArray(idem) ? idem[0] : idem,
            ownerId: extractOwnerId(req),
          });
          if (out.throttled) {
            return sendError(
              res,
              429,
              `Queue full (≥ ${MAX_QUEUE_DEPTH} pending) — retry later`,
            );
          }
          return sendJson(res, out.duplicate ? 200 : 202, {
            trigger: label,
            name,
            duplicate: out.duplicate,
            deliveries: out.deliveries,
          });
        } catch (err) {
          console.error(`[sammy-pack-api] /api/${label} error:`, err);
          return sendError(res, 500, (err as Error).message);
        }
      };
      server.middlewares.use('/api/events', makeNamedTriggerMiddleware('events', eventTriggers));
      server.middlewares.use('/api/deploy', makeNamedTriggerMiddleware('deployment', deployTriggers));
      server.middlewares.use('/api/queue', makeNamedTriggerMiddleware('queue', queueTriggers));

      // /api/deliveries — the durable-ingress audit trail + dead-letter
      // controls (the substrate the "Deliveries" UI reads).
      //   GET  /api/deliveries[?limit=&status=]   list (owner-scoped)
      //   POST /api/deliveries/:id/replay         re-drive a failed/rejected
      server.middlewares.use('/api/deliveries', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const method = (req.method ?? 'GET').toUpperCase();
          // The SAME identity seam every other route uses. This handler used
          // to resolve the header by hand and leave it `undefined` when
          // absent — and `undefined` means UNSCOPED to the store, so a
          // headerless list returned every owner's rows (raw webhook bodies
          // included), the replay check was skipped entirely, and the stats
          // were global. `extractOwnerId` never returns an empty scope:
          // anonymous is `system`, exactly as it is for /api/runs.
          const ownerId = extractOwnerId(req);

          // GET /api/deliveries/stats — queue health for the dashboard.
          if (segs[0] === 'stats') {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const STATUSES = [
              'accepted',
              'pending',
              'claimed',
              'fired',
              'duplicate',
              'rejected',
              'deferred',
              'failed',
            ] as const;
            // Owner-scoped like the list: a caller sees the health of THEIR
            // queue, not a global count that leaks how busy other tenants
            // are. (The backpressure cap in deliver() stays global — the
            // queue itself is shared.)
            const byStatus: Record<string, number> = {};
            for (const st of STATUSES) {
              byStatus[st] = await store.countDeliveries({ status: st, ownerId });
            }
            const total = await store.countDeliveries({ ownerId });
            const recent = await store.listDeliveries(1000, ownerId);
            const now = Date.now();
            const firesLastMin = recent.filter(
              d => now - d.receivedAt < 60_000,
            ).length;
            const firesLastHour = recent.filter(
              d => now - d.receivedAt < 3_600_000,
            ).length;
            return sendJson(res, 200, {
              total,
              byStatus,
              // queueDepth = the backlog the 429 cap actually sheds on
              // (pending only); claimed are in-flight, bounded by worker
              // concurrency, and reported separately.
              queueDepth: byStatus.pending,
              inFlight: byStatus.claimed,
              deadLetter: byStatus.failed,
              // The per-status `duplicate` bucket is structurally 0 — nothing
              // writes that status — so the real number is the suppression
              // count carried on the rows that won each key.
              duplicatesSuppressed: await store.sumDuplicatesSuppressed(ownerId),
              firesLastMin,
              firesLastHour,
            });
          }

          // POST /api/deliveries/:id/replay
          if (segs.length >= 2 && segs[1] === 'replay') {
            if (method !== 'POST') return sendError(res, 405, 'Use POST');
            // OWNER-SCOPED, matching the GET list. Replay re-drives the
            // delivery under its STORED ownerId, so an unscoped replay let a
            // caller in one tenant start runs as another — the list endpoint
            // was scoped while the mutation beside it was not. UNCONDITIONAL:
            // this check used to sit inside `if (ownerId)`, so a caller who
            // simply omitted the header replayed anyone's delivery.
            const own = (await store.listDeliveries(1000, ownerId)).some(
              d => d.id === segs[0],
            );
            if (!own) {
              return sendError(
                res,
                404,
                `Delivery "${segs[0]}" not found for this owner`,
              );
            }
            const ok = await store.replayDelivery(segs[0], Date.now());
            if (!ok) {
              return sendError(
                res,
                409,
                `Delivery "${segs[0]}" not found or not in a replayable (failed/rejected) state`,
              );
            }
            deliveryWorker.kick();
            return sendJson(res, 202, { replayed: segs[0], status: 'pending' });
          }

          if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const limit = Math.min(
            1000,
            Math.max(1, Number(url.searchParams.get('limit') ?? '200') || 200),
          );
          const statusParam = url.searchParams.get('status') ?? undefined;
          const status = statusParam as
            | import('./src/server/run-store').DeliveryStatus
            | undefined;
          const list = await store.listDeliveries(limit, ownerId, status);
          return sendJson(res, 200, list);
        } catch (err) {
          console.error('[sammy-pack-api] /api/deliveries error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/trigger-catalog — every registered trigger across all six
      // kinds (P5). The webhook-only GET /api/triggers stays as-is for the
      // existing tester; this is the complete reactive-surface view.
      server.middlewares.use('/api/trigger-catalog', (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          return sendError(res, 405, 'Method not allowed');
        }
        const all: CatalogEntry[] = [];
        for (const entries of triggerCatalog.values()) all.push(...entries);
        all.sort((a, b) => a.orchestration.localeCompare(b.orchestration));
        return sendJson(res, 200, all);
      });

      // ─── GET /api/concurrency — concurrency-group queue visibility ───
      //
      // WHY: the queue state was INVISIBLE. A paused holder kept its group
      // for days while cron fires parked silently behind it; the only trace
      // was one console.log at queue time. This answers "what holds group X,
      // what's parked behind it, and under which policy" from one endpoint.
      //
      // One row per known group — known = declared by a workspace
      // orchestration (concurrencyByOrch), stamped on an active run, or
      // holding parked fires (so a queue whose declaration was since edited
      // away still shows). Shape:
      //   { group,
      //     held: boolean,
      //     holder: { runId, orchestration, status, heldSinceMs } | null,
      //     queued: [{ id, orchestration, ownerId, queuedSinceMs }, ...],
      //     policy: 'skip' | 'queue' | 'cancel-existing' | null }
      // holder = the OLDEST active (running / paused — paused still holds
      // the group) run, shown only when the CALLER owns it (`held` says
      // whether anyone does); heldSinceMs / queuedSinceMs are EPOCH ms (when
      // the hold / parking began — subtract from now for the age), matching
      // the startedAt/endedAt convention. `queued` is the caller's own parked
      // fires, in true FIFO drain order.
      // `policy` resolves from the holder's orchestration declaration first,
      // else any workspace declaration of the group, else null (unknown —
      // e.g. every declaring orchestration was deleted).
      server.middlewares.use('/api/concurrency', async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        // ── DELETE /api/concurrency/<group>/queued[/<id>] — withdraw parked
        // fire(s) WITHOUT starting them. WHY: a drain is the only other way a
        // fire leaves the queue, and a drain HATCHES it — so "stop everything
        // in this group" previously had to start each queued run just to
        // cancel it (each cancel's own drain releasing the next). With an id:
        // withdraw exactly that fire (404 when it already started or was
        // already withdrawn — the store delete is atomic, so it's one or the
        // other, never both). Without an id: withdraw EVERY fire currently
        // parked behind the group. Serialized under the same per-group lock
        // as the start-gate so a withdraw can't interleave with an
        // enqueue/park decision for the same group.
        // TOLERANT decode. `.map(decodeURIComponent)` sat above both try
        // blocks of an ASYNC handler, so `GET /api/concurrency/%` threw
        // `URIError` as a REJECTED PROMISE — connect's `call()` only wraps the
        // invocation in a sync try/catch, so `next(err)` never ran, no
        // response was ever written, and the socket plus its ServerResponse
        // stayed pinned (`server.close()` then never completes, so the
        // operator's only exit is SIGKILL). An undecodable segment degrades to
        // its raw form instead: `segs[0]` is matched against stored group
        // names and `segs[2]` goes through `Number()`, so a stray `%` simply
        // matches nothing — a 404/empty answer, which is what every other
        // route gives a malformed path.
        const segs = (req.url ?? '/')
          .split('?')[0]
          .split('/')
          .filter(Boolean)
          .map(s => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        //
        // OWNER-SCOPED, both shapes. A parked fire carries the ownerId of
        // whoever fired it, and nothing here compared it to the caller: any
        // identity could withdraw any tenant's parked work by id, or empty a
        // whole group. The by-id path 404s on a mismatch — indistinguishable
        // from "no such fire", so it is not an existence oracle — and the
        // bulk path withdraws only the caller's own fires. The ownership read
        // and the withdraw run under the same per-group lock as the
        // start-gate, so a drain cannot re-own the id in between.
        const callerId = extractOwnerId(req);
        if (method === 'DELETE' && segs.length >= 2 && segs[1] === 'queued') {
          const group = segs[0];
          try {
            return await groupLock.run(group, async () => {
              if (segs.length >= 3) {
                const fireId = Number(segs[2]);
                if (!Number.isFinite(fireId)) {
                  return sendError(res, 400, 'parked-fire id must be a number');
                }
                const mine = (await store.listPendingFires(group)).some(
                  f => f.id === fireId && f.ownerId === callerId,
                );
                const withdrawn = mine
                  ? await store.withdrawPendingFire(fireId, group)
                  : null;
                if (!withdrawn) {
                  return sendError(
                    res,
                    404,
                    'no such parked fire for this group (already started, already withdrawn, or wrong group)',
                  );
                }
                console.log(
                  `[concurrency] withdrew parked fire ${withdrawn.id} (${withdrawn.orchName}) from group ${group}`,
                );
                return sendJson(res, 200, {
                  withdrawn: {
                    id: withdrawn.id,
                    orchestration: withdrawn.orchName,
                    group: withdrawn.group,
                    queuedSinceMs: withdrawn.queuedAt,
                  },
                });
              }
              // Bulk: snapshot the group's queue, withdraw each row the caller
              // owns. A fire a concurrent drain claims mid-loop just doesn't
              // count — the response reports what was actually removed.
              const parked = (await store.listPendingFires(group)).filter(
                f => f.ownerId === callerId,
              );
              let n = 0;
              for (const f of parked) {
                if (await store.withdrawPendingFire(f.id, group)) n++;
              }
              if (n > 0) {
                console.log(
                  `[concurrency] withdrew ${n} parked fire(s) from group ${group}`,
                );
              }
              return sendJson(res, 200, { withdrawn: n });
            });
          } catch (err) {
            console.error('[sammy-pack-api] queue withdraw error:', err);
            return sendError(res, 500, (err as Error).message);
          }
        }
        if (method !== 'GET') {
          return sendError(res, 405, 'Method not allowed');
        }
        try {
          const pending = await store.listPendingFires();
          // Candidate groups from all three sources.
          const groups = new Set<string>();
          // Templated declarations aren't real groups; their resolved groups
          // surface through the active runs and parked fires below.
          for (const conc of concurrencyByOrch.values()) {
            if (!isGroupTemplate(conc.group)) groups.add(conc.group);
          }
          for (const f of pending) groups.add(f.group);
          for (const h of await store.listRuns()) {
            if (
              h.concurrencyGroup &&
              (h.status === 'running' || h.status === 'paused')
            ) {
              groups.add(h.concurrencyGroup);
            }
          }
          // OWNER-SCOPED view. The row set is built from an unscoped scan so
          // every group the caller could be blocked by is listed (group names
          // are workspace declarations, not secrets) — but the DETAILS are
          // the caller's own: the holder's run id / orchestration / status
          // only when the caller owns that run, and only the caller's own
          // parked fires. Before this, one GET enumerated every tenant's
          // active run ids and every queued fire's ownerId. `held` stays
          // true for a holder the caller cannot see, so a UI can still say
          // "busy" without saying whose.
          const rows = [];
          for (const group of [...groups].sort()) {
            // Precise per-group holder lookup (started_at ASC — the oldest
            // active run is the one the start-gate blocked on).
            const active = await store.findActiveRunsInGroup(group);
            const held = active.length > 0;
            const holder =
              active[0] && active[0].ownerId === callerId
                ? {
                    runId: active[0].id,
                    orchestration: active[0].orchestrationName,
                    status: active[0].status,
                    heldSinceMs: active[0].startedAt,
                  }
                : null;
            const queued = pending
              .filter(f => f.group === group && f.ownerId === callerId)
              .map(f => ({
                id: f.id,
                orchestration: f.orchName,
                ownerId: f.ownerId,
                queuedSinceMs: f.queuedAt,
              }));
            // Policy: holder's declaration wins (it's the run the gate is
            // actually honoring); fall back to any declaration of the group.
            // Resolved from the real holder's orchestration whether or not
            // the caller may see it — the policy is a workspace declaration.
            const holderOrch = active[0]?.orchestrationName;
            const holderConc = holderOrch ? concurrencyByOrch.get(holderOrch) : undefined;
            let policy =
              (holderConc &&
                (holderConc.group === group || isGroupTemplate(holderConc.group)) &&
                holderConc.policy) ||
              null;
            if (!policy) {
              for (const conc of concurrencyByOrch.values()) {
                if (conc.group === group) {
                  policy = conc.policy;
                  break;
                }
              }
            }
            rows.push({ group, held, holder, queued, policy });
          }
          return sendJson(res, 200, rows);
        } catch (err) {
          console.error('[sammy-pack-api] /api/concurrency error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET  /api/agent-slots → { limit, inUse, waiting }
      // PUT  /api/agent-slots  body { limit } → resize the global agent
      // concurrency pool at runtime (no restart). This is the cap that stops
      // a wide fan-out / cron burst from spawning unbounded agent subprocesses
      // and overloading the machine. Default comes from
      // SAMMY_MAX_CONCURRENT_AGENTS (else CPU-derived).
      server.middlewares.use('/api/agent-slots', async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          return sendJson(res, 200, {
            limit: agentSlots.limit,
            inUse: agentSlots.inUse,
            waiting: agentSlots.waiting,
          });
        }
        if (method === 'PUT') {
          try {
            const raw = await readBody(req);
            const parsed = raw ? (JSON.parse(raw) as { limit?: unknown }) : {};
            const next = Number(parsed.limit);
            if (!Number.isFinite(next) || next < 1) {
              return sendError(res, 400, 'limit must be a number ≥ 1');
            }
            agentSlots.setLimit(next);
            console.log(
              `[sammy-pack-api] agent concurrency cap set to ${agentSlots.limit} (runtime)`,
            );
            return sendJson(res, 200, {
              limit: agentSlots.limit,
              inUse: agentSlots.inUse,
              waiting: agentSlots.waiting,
            });
          } catch (e) {
            return sendError(res, 400, `Bad request: ${(e as Error).message}`);
          }
        }
        return sendError(res, 405, 'Method not allowed');
      });

      // ─── Agent execution queue (the concurrency-cap waitlist) ────────
      // GET  /api/agent-queue           → { limit, inUse, waiting, queued[] }
      //   The cross-run waitlist: leaf agent dispatches blocked because the
      //   global concurrency cap (/api/agent-slots) is saturated. Each queued
      //   item carries its id, owning run + orchestration, the phase it will
      //   dispatch, its grant position, and how long it's waited.
      // POST /api/agent-queue/reorder   body { id, dir: 'up'|'down' }
      //                              OR  body { id, toIndex: <0-based> }
      //   Reprioritize one waiting dispatch. Safe at any time: slots are
      //   granted from the front of the queue, so reordering only changes
      //   which still-blocked dispatch is served next — it never disturbs
      //   in-flight agents, never double-grants, never drops a waiter.
      server.middlewares.use('/api/agent-queue', answered(async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        // Connect strips the '/api/agent-queue' mount prefix, so the base
        // GET sees req.url '/' and the reorder POST sees '/reorder'.
        const sub = (req.url ?? '/').split('?')[0].replace(/^\/|\/$/g, '');
        const now = Date.now();
        // OWNER-SCOPED, the same shape `/api/concurrency` uses — this view had
        // no scoping at all, so one GET named every tenant's blocked run id
        // and the reorder moved any tenant's dispatch by id. The owner is
        // resolved from the RUN each waiter names, not from the waiter:
        // `WaiterMeta` carries no owner and the executor layer has no owner
        // concept, so threading one down would be a new concept rather than a
        // fix. `getRunSummary(id, ownerId)` is the existing owner-404
        // primitive; distinct run ids in the queue are bounded by fan-out, so
        // this is a handful of point lookups.
        const callerId = extractOwnerId(req);
        const snapshot = agentQueueSnapshot();
        const ownedRunIds = new Set<string>();
        for (const id of new Set(
          snapshot.map(w => w.runId).filter((v): v is string => !!v),
        )) {
          if (await store.getRunSummary(id, callerId)) ownedRunIds.add(id);
        }
        /** A dispatch with no `runId` (a bare `acquire()` from an in-browser /
         *  CLI run) belongs to nobody: opaque to everyone and reorderable by
         *  nobody, rather than reorderable by anyone. */
        const isCallers = (w: { runId?: string }): boolean =>
          !!w.runId && ownedRunIds.has(w.runId);
        /** Positional truth stays public (so the view can still say "2 ahead
         *  of you" and how long the head has waited); the run ATTRIBUTION is
         *  the caller's own, exactly as `/api/concurrency` keeps `held` public
         *  while hiding whose run holds the group. */
        const project = (w: (typeof snapshot)[number], at: number) => ({
          id: w.id,
          kind: 'agent' as const,
          runId: isCallers(w) ? (w.runId ?? null) : null,
          orchestrationName: isCallers(w) ? (w.orchestrationName ?? null) : null,
          phaseName: isCallers(w) ? (w.phaseName ?? null) : null,
          position: w.position,
          enqueuedAt: w.enqueuedAt,
          waitedMs: Math.max(0, at - w.enqueuedAt),
          // Every item here is blocked by the same gate — the global
          // agent-concurrency cap. Surfaced per-row so the view can
          // label why each is waiting without inferring it.
          blockedBy: 'agent-concurrency-cap' as const,
        });
        if (method === 'GET' && sub === '') {
          return sendJson(res, 200, {
            limit: agentSlots.limit,
            inUse: agentSlots.inUse,
            waiting: agentSlots.waiting,
            queued: snapshot.map(w => project(w, now)),
          });
        }
        if (method === 'POST' && sub === 'reorder') {
          try {
            const raw = await readBody(req);
            const body = raw
              ? (JSON.parse(raw) as {
                  id?: unknown;
                  dir?: unknown;
                  toIndex?: unknown;
                })
              : {};
            const id = typeof body.id === 'string' ? body.id : '';
            if (!id) return sendError(res, 400, 'id is required');
            // A waiter the caller does not own is INVISIBLE, not forbidden —
            // 404 with the same wording as a waiter that already drained, so
            // this is not an existence oracle for another tenant's dispatches.
            // Reorder is repeatable, so without this one tenant could hold
            // another's blocked dispatch at the back of the queue.
            if (!snapshot.some(w => w.id === id && isCallers(w))) {
              return sendError(
                res,
                404,
                `queued item "${id}" is no longer waiting (it may have started)`,
              );
            }
            let moved = false;
            if (body.dir === 'up' || body.dir === 'down') {
              moved = agentSlots.bumpWaiter(id, body.dir);
            } else if (Number.isFinite(Number(body.toIndex))) {
              moved = agentSlots.moveWaiter(id, Math.floor(Number(body.toIndex)));
            } else {
              return sendError(
                res,
                400,
                "provide dir: 'up'|'down' or a numeric toIndex",
              );
            }
            if (!moved) {
              // The waiter drained (got a slot) between the view + the
              // click — a benign race. Report it so the UI can refresh.
              return sendError(
                res,
                409,
                `queued item "${id}" is no longer waiting (it may have started)`,
              );
            }
            // Same projection as the GET: the post-reorder body is a second
            // copy of the same view, so it must be scoped the same way.
            const after = Date.now();
            return sendJson(res, 200, {
              limit: agentSlots.limit,
              inUse: agentSlots.inUse,
              waiting: agentSlots.waiting,
              queued: agentQueueSnapshot().map(w => project(w, after)),
            });
          } catch (e) {
            return sendError(res, 400, `Bad request: ${(e as Error).message}`);
          }
        }
        return sendError(res, 405, 'Method not allowed');
      }));

      // POST /api/runs/start
      // Body: { orchestrationName, initialInput?, model?, allowAgentTools? }
      // Returns: { id }
      // Starts a server-owned run. The executor lives on the server and
      // the run survives the browser tab closing. Client subscribes to
      // events via GET /api/runs/:id/events.
      server.middlewares.use('/api/runs/start', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: {
          orchestrationName?: string;
          initialInput?: string;
          model?: string;
          allowAgentTools?: boolean;
          /** Values for the orchestration's declared `inputs`, keyed by
           *  input name. For kind:'file', `data` is base64 of the upload. */
          inputs?: Record<
            string,
            {
              value?: string;
              file?: { filename?: string; mediaType?: string; data?: string };
            }
          >;
        };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const name = body.orchestrationName;
        if (!name || typeof name !== 'string' || !isSafeName(name)) {
          return sendError(res, 400, 'orchestrationName must be a safe string');
        }
        // A server state file is never an orchestration — see
        // `namesServerStateFile`; the answer is the one a missing file gets.
        const ctx = (await namesServerStateFile(name))
          ? null
          : await loadRunContext(name);
        if (!ctx) return sendError(res, 404, `Orchestration not found: ${name}`);

        // Server-side budget gate. Pre-flight: refuse the run outright
        // if a daily / monthly spend cap is already reached. Otherwise
        // hand the controller a gate so it can halt the run if its own
        // cost crosses the cap mid-flight. 402 Payment Required is the
        // honest status for "you're out of budget".
        // Resolved before the budget gate because the cap is now PER OWNER —
        // the gate needs to know whose spend it is checking.
        const ownerId = extractOwnerId(req);

        const { status: budgetStatus, gate: budgetGate } =
          await loadBudgetState(budgetFile, store, ownerId);
        if (budgetStatus.blocked) {
          return sendError(res, 402, budgetBlockedMessage(budgetStatus));
        }

        // Resolve any declared run inputs (Jira / URL / doc → text) BEFORE
        // the run starts, so phases can read them as ${name}. A missing
        // required input or an unresolvable reference refuses the run here
        // with a clear 400 rather than letting it work on nothing.
        let resolvedInputs: Record<string, string> | undefined;
        const inputDecls = ctx.orchestration.inputs;
        if (Array.isArray(inputDecls) && inputDecls.length > 0) {
          const rawValues = body.inputs ?? {};
          const values: Record<string, InputValue> = {};
          for (const [k, v] of Object.entries(rawValues)) {
            if (v && v.file && typeof v.file.data === 'string') {
              values[k] = {
                file: {
                  filename: v.file.filename ?? 'upload',
                  mime: v.file.mediaType ?? '',
                  bytes: Buffer.from(v.file.data, 'base64'),
                },
              };
            } else if (v && typeof v.value === 'string') {
              values[k] = { value: v.value };
            }
          }
          // Resolver creds from the registry (best-effort): an `atlassian`
          // entry powers jira/confluence inputs, a `github` entry powers
          // github inputs. text/url/file need no creds.
          const rawCreds = readCredentialsByNameRaw(credentialsFile, {
            ownerId,
            orchestrationName: name,
          });
          let atlassian:
            | { site: string; email: string; token: string }
            | undefined;
          let github: { token: string } | undefined;
          for (const entry of Object.values(rawCreds)) {
            // Accept both the `atlassian` kind (field `site`) and the legacy
            // `jira` alias (field `siteUrl`) — the credentials UI / import can
            // produce either, and both power jira + confluence inputs. Reading
            // only `atlassian`+`site` was why a `kind:'jira'` cred was silently
            // ignored and jira inputs failed with "no Atlassian credential".
            const site = entry.fields?.site ?? entry.fields?.siteUrl;
            if (
              !atlassian &&
              (entry.kind === 'atlassian' || entry.kind === 'jira') &&
              site &&
              entry.fields?.email
            ) {
              atlassian = {
                site,
                email: entry.fields.email,
                token: entry.value,
              };
            }
            if (!github && entry.kind === 'github') github = { token: entry.value };
          }
          // No GitHub connection: use this machine's `gh` login, the way a
          // person at this terminal would read a private issue.
          if (!github) {
            const token = await ghCliToken();
            if (token) github = { token };
          }
          try {
            resolvedInputs = await resolveInputs(inputDecls, values, {
              atlassian,
              github,
              // Next to the run worktrees: outside the repo, gitignored.
              attachmentsDir: path.join(worktreeRoot(root), '_attachments'),
            });
          } catch (err) {
            return sendError(
              res,
              400,
              `input resolution failed: ${(err as Error).message}`,
            );
          }
        }

        // Start-gate: honor the orchestration's `concurrency.group` (if any)
        // on the manual-start path exactly as on trigger fires. A skip / queue
        // returns 200 with the outcome (no run id) so the UI can surface that
        // the group was busy rather than treat it as an error.
        const startRes = await startRunWithConcurrency(
          ctx.orchestration,
          {
            store,
            orchestrationName: name,
            initialInput: body.initialInput,
            orchestrationSnapshot: ctx.orchestration,
            budgetGate,
            ownerId,
            // Workflow-level recovery — if the orchestration's
            // lifecycle.errorOrchestration is set and this run lands
            // in 'error', kick off that recovery orchestration with a
            // JSON envelope of the failure. The recovery run itself
            // has no onTerminal, so failures don't cascade.
            onTerminal: buildTerminalHook(name, ctx.orchestration, ownerId),
            buildEventSource: (signal, runId) =>
              buildExecutorSource(
                ctx,
                {
                  initialInput: body.initialInput,
                  model: body.model,
                  allowAgentTools: body.allowAgentTools,
                  ownerId,
                  resolvedInputs,
                  runId,
                },
                signal,
              ),
            resolvedInputs,
          },
          {
            orchName: name,
            initialInput: body.initialInput ?? null,
            ownerId,
            resolvedInputs: resolvedInputs ?? null,
          },
        );
        if (startRes.outcome === 'started') {
          return sendJson(res, 200, { id: startRes.id });
        }
        // skipped | queued — no run was created.
        return sendJson(res, 200, {
          id: null,
          concurrency: startRes.outcome,
        });
      });

      // POST /api/preview
      // Body: { orchestrationName, vars?, input?, depth?, lint? }
      // Returns: { findings, tree, rendered }
      //   - findings: the plan's findings flattened into one list (root
      //     findings first, then per-node in tree order; `phase` names the
      //     owning node) so a client can severity-sort without walking.
      //   - tree:     the PreviewNode[] phase tree (render-agnostic JSON).
      //   - rendered: the terminal text renderer's output.
      // The symbolic dry-run of an orchestration — the SAME walker + renderer
      // `app/sammy-cli.ts preview` uses, resolved against the SAME workspace
      // context the run-start path loads (loadRunContext). Pure analysis: no
      // agent is dispatched, no code runs, no run row is created.
      //
      // Auth-gate choice: although preview is read-only, it ships as a POST
      // (it needs a JSON body), so under SAMMY_API_TOKEN / JWT it is bearer-
      // gated like every other POST — the auth middlewares gate by METHOD and
      // exempt only external trigger ingress. That is deliberate, not an
      // oversight: a preview response contains fully-resolved commands and
      // prompts (vars interpolated), which is closer to "what a run would
      // see" than to a public read, so the least-surprising posture is the
      // same gate /api/runs/start sits behind.
      // ── /api/repos — map a repository URL to a clone on this machine.
      //   GET  /api/repos/locate?url=<repo url> → { url, local, cloneTo, roots }
      //   POST /api/repos/clone { url }          → { local } (201, or 200 when
      //        a clone already exists). The Run dialog uses these to turn a
      //        pasted web address into the local path a `worktrees` entry
      //        needs, offering the clone when there is none.
      server.middlewares.use('/api/repos', answered(async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase();
        const [pathPart, query = ''] = (req.url ?? '/').split('?');
        const sub = pathPart.replace(/\/+$/, '');
        const roots = await repoSearchRoots(root);
        if (sub === '/locate') {
          if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const url = new URLSearchParams(query).get('url')?.trim() ?? '';
          if (!isRepoUrl(url) || !normalizeRepoUrl(url)) {
            return sendError(res, 400, 'url must be a repository URL (https://host/owner/repo or git@host:owner/repo)');
          }
          const local = await findLocalClone(url, roots);
          return sendJson(res, 200, {
            url,
            local,
            cloneTo: local ? null : cloneDestination(url, roots),
          });
        }
        if (sub === '/clone') {
          if (method !== 'POST') return sendError(res, 405, 'Method not allowed');
          let body: { url?: unknown };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          const url = typeof body.url === 'string' ? body.url.trim() : '';
          if (!isRepoUrl(url) || !normalizeRepoUrl(url)) {
            return sendError(res, 400, 'url must be a repository URL (https://host/owner/repo or git@host:owner/repo)');
          }
          const existing = await findLocalClone(url, roots);
          if (existing) return sendJson(res, 200, { local: existing });
          const dest = cloneDestination(url, roots);
          if (!dest) {
            return sendError(res, 400, 'no directory to clone into — set SAMMY_REPO_ROOTS');
          }
          try {
            await cloneRepo(url, dest);
          } catch (err) {
            return sendError(res, 502, (err as Error).message);
          }
          console.log(`[sammy-pack-api] cloned ${url.replace(/\/\/[^/@]*@/, '//')} → ${dest}`);
          return sendJson(res, 201, { local: dest });
        }
        return sendError(res, 404, 'Not found');
      }));

      server.middlewares.use('/api/preview', async (req, res) => {
        if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
        let body: {
          orchestrationName?: string;
          vars?: Record<string, string>;
          input?: string;
          depth?: number;
          lint?: boolean;
        };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
        const name = body.orchestrationName;
        if (!name || typeof name !== 'string' || !isSafeName(name)) {
          return sendError(res, 400, 'orchestrationName must be a safe string');
        }
        if (body.vars !== undefined) {
          const varsOk =
            body.vars !== null &&
            typeof body.vars === 'object' &&
            !Array.isArray(body.vars) &&
            Object.values(body.vars).every(v => typeof v === 'string');
          if (!varsOk) {
            return sendError(res, 400, 'vars must be an object of strings');
          }
        }
        if (body.input !== undefined && typeof body.input !== 'string') {
          return sendError(res, 400, 'input must be a string');
        }
        if (
          body.depth !== undefined &&
          (typeof body.depth !== 'number' ||
            !Number.isFinite(body.depth) ||
            body.depth < 0)
        ) {
          return sendError(res, 400, 'depth must be a non-negative number');
        }
        if (body.lint !== undefined && typeof body.lint !== 'boolean') {
          return sendError(res, 400, 'lint must be a boolean');
        }
        // A server state file is never an orchestration — see
        // `namesServerStateFile`; the answer is the one a missing file gets.
        const ctx = (await namesServerStateFile(name))
          ? null
          : await loadRunContext(name);
        if (!ctx) return sendError(res, 404, `Orchestration not found: ${name}`);
        try {
          // Sibling orchestrations for `subflow` expansion, with the SAME
          // name-collision precedence the executor applies (imported/domain
          // shadows shipped example; a same-tier collision keeps last-write —
          // see setOrchestrationWithPrecedence in executor.ts).
          const byName = new Map<string, Node>();
          for (const o of ctx.orchestrations) {
            if (typeof o.name !== 'string') continue;
            const existing = byName.get(o.name);
            if (
              existing &&
              existing.__origin === 'imported' &&
              o.__origin !== 'imported'
            ) {
              continue;
            }
            byName.set(o.name, o);
          }
          const plan = previewOrchestration(ctx.orchestration, {
            vars: body.vars,
            initialInput: body.input,
            maxDepth: body.depth,
            noLint: body.lint === false,
            orchestrationByName: byName,
          });
          const findings: Array<PreviewFinding & { phase?: string }> =
            plan.findings.map(f => ({ ...f }));
          const collect = (nodes: PreviewNode[]): void => {
            for (const n of nodes) {
              for (const f of n.findings) findings.push({ ...f, phase: n.name });
              collect(n.children);
            }
          };
          collect(plan.phases);
          return sendJson(res, 200, {
            findings,
            tree: plan.phases,
            rendered: renderPlanText(plan),
          });
        } catch (err) {
          return sendError(res, 500, (err as Error).message);
        }
      });

      // POST /api/orchestrations/from-file
      // Body: { filename, mediaType, data (base64) }
      // Returns: { orchestration, agentMatchReport, summary }
      //
      // Drop-to-generate flow: client base64-encodes a file (image,
      // .drawio, .excalidraw, .pdf, .md, .txt), POSTs it here, server
      // pre-processes per type → assembles a user-message containing
      // text + vision blocks → calls the orchestration-designer agent
      // via the SDK → parses the JSON output → matches phase agent
      // paths against the workspace agents/ directory → returns the
      // generated orchestration + a per-phase match report.
      server.middlewares.use(
        '/api/orchestrations/from-file',
        async (req, res) => {
          if (req.method !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          let body: {
            filename?: string;
            mediaType?: string;
            data?: string;
            /** When true, skips the SDK call. Returns the extracted
             *  content + a stub orchestration so tests + UI dev can
             *  exercise the full wire-up without burning tokens or
             *  needing Claude CLI auth. The stub mirrors the shape
             *  the real designer would return — one phase per
             *  extracted node label, agent paths inferred from labels
             *  — enough for the agent-matcher + UI preview to be
             *  validated end-to-end. */
            dryRun?: boolean;
          };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          if (!body.filename || !body.data) {
            return sendError(res, 400, 'filename + data (base64) required');
          }
          let bytes: Buffer;
          try {
            bytes = Buffer.from(body.data, 'base64');
          } catch {
            return sendError(res, 400, 'data must be valid base64');
          }
          let extracted;
          try {
            extracted = await extractFromUpload(
              body.filename,
              body.mediaType ?? '',
              bytes,
            );
          } catch (err) {
            return sendError(res, 415, (err as Error).message);
          }

          const abortController = new AbortController();
          req.on('close', () => abortController.abort());

          // Shared designer path (load designer + available agents,
          // assemble prompt, dry-run stub OR stream + parse + match).
          const result = await runOrchestrationDesigner(
            agentsDir,
            extracted,
            `${body.filename} (${extracted.summary})`,
            {
              dryRun: body.dryRun,
              stubName: body.filename,
              abortController,
            },
          );
          if (!result.ok) {
            return sendError(res, result.status, result.message);
          }
          return sendJson(res, 200, {
            orchestration: result.orchestration,
            agentMatchReport: result.agentMatchReport,
            summary: result.summary,
            ...(result.dryRun ? { dryRun: true } : {}),
          });
        },
      );

      // POST /api/orchestrations/from-folder
      // Body: { files: Array<{ relPath, filename, mediaType, data(base64) }>, dryRun? }
      // Returns: { orchestration, agentMatchReport, summary }
      //
      // Folder-upload flow: a spec is sometimes a whole DIRECTORY of
      // files. The client base64-encodes every file (capturing each
      // file's path relative to the picked folder) and POSTs them here.
      // The server decodes each, runs the per-type extractor, and
      // AGGREGATES the results into ONE block array — prepending a
      // `## File: <relPath>` header before each file's blocks so the
      // designer sees the folder STRUCTURE. Input is CAPPED by file
      // count + total extracted text; anything over the cap is dropped
      // (NOT silently truncated) and listed in the summary. Then the
      // SAME shared designer path the from-file endpoint uses produces a
      // SINGLE orchestration covering the whole folder.
      server.middlewares.use(
        '/api/orchestrations/from-folder',
        async (req, res) => {
          if (req.method !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          let body: {
            files?: Array<{
              relPath?: string;
              filename?: string;
              mediaType?: string;
              data?: string;
            }>;
            dryRun?: boolean;
          };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          if (!Array.isArray(body.files) || body.files.length === 0) {
            return sendError(res, 400, 'files[] (non-empty) required');
          }
          // Decode every file up front; reject the whole request if any
          // entry is malformed (missing fields / bad base64).
          const folderFiles: FolderFile[] = [];
          for (const f of body.files) {
            if (!f || !f.data || !(f.relPath || f.filename)) {
              return sendError(
                res,
                400,
                'each file needs { relPath|filename, data(base64) }',
              );
            }
            let bytes: Buffer;
            try {
              bytes = Buffer.from(f.data, 'base64');
            } catch {
              return sendError(
                res,
                400,
                `data for "${f.relPath ?? f.filename}" must be valid base64`,
              );
            }
            const relPath = f.relPath ?? f.filename ?? 'file';
            const filename = f.filename ?? relPath.split('/').pop() ?? relPath;
            folderFiles.push({
              relPath,
              filename,
              mediaType: f.mediaType ?? '',
              bytes,
            });
          }

          // Aggregate the folder into one block array (with `## File:`
          // headers + the cap + a drop notice). Never throws on a single
          // unsupported file — it's recorded as dropped instead.
          let extracted;
          try {
            extracted = await extractFromFolder(folderFiles);
          } catch (err) {
            return sendError(res, 415, (err as Error).message);
          }
          if (extracted.blocks.length === 0) {
            return sendError(
              res,
              415,
              `No usable files in the folder. ${extracted.droppedNote ?? ''}`.trim(),
            );
          }

          const abortController = new AbortController();
          req.on('close', () => abortController.abort());

          // A stable stub name for dry-run, derived from the folder root
          // (first path segment of the first file).
          const folderRoot =
            folderFiles[0].relPath.split('/')[0] || 'folder';
          const result = await runOrchestrationDesigner(
            agentsDir,
            extracted,
            `folder "${folderRoot}" (${extracted.summary})`,
            {
              dryRun: body.dryRun,
              stubName: folderRoot,
              abortController,
            },
          );
          if (!result.ok) {
            return sendError(res, result.status, result.message);
          }
          return sendJson(res, 200, {
            orchestration: result.orchestration,
            agentMatchReport: result.agentMatchReport,
            summary: result.summary,
            ...(result.dryRun ? { dryRun: true } : {}),
          });
        },
      );

      // How many SSE run streams may be open at once, process-wide. Same
      // shape as SAMMY_MAX_RUN_LIST_LIMIT: a default that no honest UI
      // reaches (a Runs view holds one stream per open run detail), and a
      // named lever for an operator who genuinely wants more.
      const MAX_RUN_STREAMS = envPositiveInt('SAMMY_MAX_RUN_STREAMS', 64);
      let openRunStreams = 0;

      // GET /api/runs/:id/events  → SSE stream of the run's events.
      // POST /api/runs/:id/cancel → request cancellation.
      // Catches subpaths because the /api/runs handler above is
      // top-level; both handlers coexist by checking pathnames.
      server.middlewares.use('/api/runs', answered(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
        // /api/runs/:id/events or /api/runs/:id/cancel
        if (segs.length !== 2) return next();
        const [id, action] = segs;
        if (!isSafeName(id)) return next();

        // OWNER GATE for this middleware.
        //
        // `/events` and `/cancel` never call `store.getRun`, so unlike every
        // other per-id route there was nothing here to add a scope to: the SSE
        // stream replayed any run's entire event log to any caller, and cancel
        // stopped any caller's run. Resolve the run once, scoped, and treat a
        // miss as 404 — indistinguishable from "no such run", so this cannot
        // be used to probe which ids exist.
        //
        // Cheap: `getRunSummary` reads the header without shipping events,
        // and the handlers below re-resolve what they actually need.
        const owned = await store.getRunSummary(id, extractOwnerId(req));
        if (!owned) return sendError(res, 404, 'Run not found');

        if (action === 'events') {
          if ((req.method ?? 'GET') !== 'GET')
            return sendError(res, 405, 'Method not allowed');
          // BOUNDED, like every other read. `subscribe` replays the run's
          // ENTIRE event log into the socket in one synchronous loop, with no
          // check of `res.write`'s return value — and a real run reaches
          // hundreds to thousands of events, which is why the LIST endpoint
          // stopped shipping `events[]` at all and why `?limit=` got the
          // SAMMY_MAX_RUN_LIST_LIMIT ceiling. The stream ships strictly more
          // per request and had no ceiling of any kind: nothing capped
          // concurrent streams per run, per owner or per process, so N slow
          // or non-reading clients each made Node buffer a whole event log.
          // Refused rather than queued — an operator watching a run wants an
          // answer, not a stall — and the refusal names the lever.
          if (openRunStreams >= MAX_RUN_STREAMS) {
            return sendError(
              res,
              503,
              `Too many open run streams (${MAX_RUN_STREAMS}). Each replays a ` +
                'full event log, so they are capped — close a Runs view, or ' +
                'raise SAMMY_MAX_RUN_STREAMS.',
            );
          }
          openRunStreams += 1;
          let streamClosed = false;
          const closeStream = (): void => {
            if (streamClosed) return;
            streamClosed = true;
            openRunStreams -= 1;
          };
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          // Released on the RESPONSE closing, not on `end()` returning: a
          // client that does not read leaves the whole replayed log sitting in
          // Node's write queue long after `end()`, and that buffered copy is
          // the resource being bounded. `req`'s close covers a socket dropped
          // mid-stream. Both paths are idempotent — a slot that leaks is a cap
          // that silently becomes zero.
          res.on('close', closeStream);
          const sub = await subscribeServerRun(store, id, ev => {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          });
          if (sub.finished) {
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          // Client disconnect → unsubscribe, but the run keeps going
          // server-side. That's the whole point of durable execution.
          req.on('close', () => {
            sub.unsubscribe();
            closeStream();
          });
          return;
        }

        // `stop` is an ALIAS for cancel: the first verb an operator tries
        // against a wedged run should work (POST /stop used to 405, which
        // costs real time exactly when a run is already wedged).
        if (action === 'cancel' || action === 'stop') {
          if ((req.method ?? 'POST') !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          // Live executor in this process → abort it; its own run-cancelled
          // sentinel cleans up the stored status.
          const aborted = cancelServerRun(id);
          if (aborted) return sendJson(res, 200, { ok: true, aborted: true });
          // No live controller — the run is interrupted/paused (or owned by a
          // process that died) and just sitting in the store. Mark it
          // cancelled directly so the user can actually stop these from the
          // Runs view — via the shared, per-run-serialized cancel seam
          // (cancelStoredRunAndDrain): status flip + run-cancelled sentinel +
          // concurrency-group release/drain, with racing duplicate cancels
          // (double-click, bulk-stop) collapsing to ONE terminal + ONE drain.
          const out = await cancelStoredRunAndDrain(id);
          if (out.outcome === 'not-found') {
            return sendError(res, 404, 'Run not found');
          }
          if (out.outcome === 'already-terminal') {
            return sendJson(res, 200, { ok: false, status: out.status });
          }
          return sendJson(res, 200, { ok: true, cancelled: true });
        }

        if (action === 'resume') {
          if ((req.method ?? 'POST') !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          // The resume flow uses the run's stored orchestrationName
          // (NOT a client-supplied one) — we don't want a paused run
          // for orchestration A to be hijacked into running B's tree.
          const stored = await store.getRun(id, extractOwnerId(req));
          if (!stored) return sendError(res, 404, 'Run not found');
          // Resume covers three recoverable states: `paused` (snapshot+paused
          // at a lock gate or durable wait), `interrupted` (a crash/restart —
          // or an external signal kill — left it in-flight; checkpoint
          // preserved), and `error` (a run that died AFTER a 30–70-min phase
          // otherwise repays full price on restart even though
          // completedLeaves was persisted). All replay completed
          // leaves and re-execute from the cut point. The controller
          // re-checks the concurrency group for error/interrupted runs —
          // their terminal released it — and refuses (409) when busy. Note:
          // the original error terminal's `<orch>.error` event and
          // errorOrchestration already fired; resume does not rewind those.
          if (
            stored.status !== 'paused' &&
            stored.status !== 'interrupted' &&
            stored.status !== 'error'
          )
            return sendError(
              res,
              409,
              `Run is ${stored.status}, not paused/interrupted/error — nothing to resume.`,
            );
          const ctx = await loadRunContext(stored.orchestrationName, {
            orchestrationOverride: stored.orchestrationSnapshot as Node | null,
          });
          if (!ctx)
            return sendError(
              res,
              404,
              `Orchestration not found: ${stored.orchestrationName}`,
            );
          const result = await resumeServerRun({
            store,
            id,
            budgetGate: (await loadBudgetState(budgetFile, store, stored.ownerId)).gate,
            onTerminal: buildTerminalHook(
              stored.orchestrationName,
              ctx.orchestration,
              stored.ownerId,
            ),
            divergence: ctx.orchestration.notify?.divergence,
            buildEventSource: (signal, replayOutputs, autoApproveLocks, _gms, runId, waits, inputs) =>
              buildExecutorSource(
                ctx,
                {
                  initialInput: stored.initialInput ?? undefined,
                  // Resume reuses whatever model the original run used.
                  // (We don't store it explicitly today; fall back to
                  // the proxy default.)
                  allowAgentTools: true,
                  replayOutputs,
                  autoApproveLocks,
                  ownerId: stored.ownerId,
                  runId,
                  pendingWaits: waits.pendingWaits,
                  deliveredSignals: waits.deliveredSignals,
                  resolvedInputs: inputs,
                },
                signal,
              ),
          });
          if (!result.ok) return sendError(res, 409, result.reason);
          return sendJson(res, 200, { ok: true });
        }

        // POST /api/runs/:id/signal   body: { signal: string, payload?: any }
        //
        // External-signal delivery for `wait.signal` leaves. Durable-first:
        // the delivery is appended to the run's event log (the buffer a
        // resumed leg consumes via wait-resolution.ts) BEFORE any resume —
        // a crash between append and resume loses nothing (the sweeper's
        // once-per-leg buffered scan finds it). Then, when the run is
        // currently paused ON this exact signal, resume it immediately
        // (sub-second delivery instead of the ~30s sweep). Signals sent to
        // a RUNNING run buffer durably and are consumed when its `wait`
        // leaf crosses — or matched by the sweeper if the run parks first.
        // Non-string payloads are JSON-stringified; the payload string
        // becomes the wait phase's output.
        if (action === 'signal') {
          if ((req.method ?? 'POST') !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          let body: { signal?: unknown; payload?: unknown };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          const name =
            typeof body.signal === 'string' ? body.signal.trim() : '';
          if (!name)
            return sendError(res, 400, 'signal (non-empty string) required');
          const stored = await store.getRun(id, extractOwnerId(req));
          if (!stored) return sendError(res, 404, 'Run not found');
          if (
            stored.status === 'done' ||
            stored.status === 'error' ||
            stored.status === 'cancelled'
          ) {
            return sendError(
              res,
              409,
              `Run is ${stored.status} — signals can only be delivered to ` +
                `running or paused runs`,
            );
          }
          const payload =
            body.payload === undefined
              ? ''
              : typeof body.payload === 'string'
                ? body.payload
                : JSON.stringify(body.payload);
          await store.appendEvent(id, scrubEvent({
            type: 'signal-received',
            signal: name,
            payload,
            ts: Date.now(),
          }));
          const pw = pendingWaitOf(stored.stateJson);
          let resumed = false;
          if (
            stored.status === 'paused' &&
            pw?.kind === 'signal' &&
            pw.signal === name
          ) {
            const out = await resumeStoredRunForWait(id);
            resumed = out.ok;
            if (!out.ok) {
              console.warn(
                `[sammy-pack-api] signal "${name}" delivered to paused run ` +
                  `${id} but immediate resume failed (${out.reason}); the ` +
                  `wait sweeper will retry`,
              );
            }
          }
          return sendJson(res, 200, { ok: true, delivered: true, resumed });
        }

        // POST /api/runs/:id/gate
        //   body: { decision: 'approve' | 'reject' | 'request-changes', message?: string }
        //
        // Human-in-the-loop gate interaction for a run that snapshot+paused
        // at a `lock: true` phase. The richer counterpart to /resume
        // (which is approve-only, no body):
        //   - reject          → cancel the run (reuses the cancel path's
        //                        status write + run-cancelled sentinel).
        //   - approve         → resume THROUGH the gate (auto-approve
        //                        pausedFor; replay every completed leaf).
        //   - request-changes → REVISE-AND-RE-PAUSE loop. A `lock` gates
        //                        BEFORE its phase dispatches, so the artifact
        //                        the human is reviewing is the output of the
        //                        phase that ran immediately before the gate
        //                        (the last completed leaf). We INVALIDATE
        //                        that leaf's cached output so it re-runs,
        //                        feed the human's message to it as a fenced
        //                        instruction, and leave the gate's lock ARMED
        //                        (reArmLock) so once the revision is produced
        //                        the run pauses again at the same gate — the
        //                        human reviews the revision before approving.
        //                        Every OTHER completed leaf still replays from
        //                        cache, so upstream work is never redone; and
        //                        because the gate is pre-dispatch, nothing
        //                        downstream of it has executed, so there is no
        //                        downstream work to lose or repeat.
        //   - message (optional, with approve) → wired to the gated phase's
        //                        agent as an extra instruction. Mechanism: the
        //                        lock gates BEFORE the phase's agent runs, so
        //                        the gated phase hasn't dispatched yet. We seed
        //                        gateMessages:{[pausedFor]: message}; the
        //                        executor appends it to that phase's input as a
        //                        fenced HUMAN INSTRUCTION block (consumed once).
        //
        // Every decision also appends a lightweight `gate-decision` event so
        // the Approvals conversation thread can show the human's side of the
        // review, interleaved with the agent's plan/revision phase-ends.
        if (action === 'gate') {
          if ((req.method ?? 'POST') !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          let body: { decision?: string; message?: string };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          const decision = body.decision;
          if (
            decision !== 'approve' &&
            decision !== 'reject' &&
            decision !== 'request-changes'
          ) {
            return sendError(
              res,
              400,
              "decision must be 'approve', 'reject', or 'request-changes'",
            );
          }
          const message =
            typeof body.message === 'string' ? body.message : undefined;

          const stored = await store.getRun(id, extractOwnerId(req));
          if (!stored) return sendError(res, 404, 'Run not found');
          if (stored.status !== 'paused' || !stored.pausedFor) {
            return sendError(
              res,
              409,
              `Run is ${stored.status}${stored.pausedFor ? '' : ' (no gated phase)'}, not paused at a gate — nothing to act on.`,
            );
          }
          // A durable `wait` pauses with a `pausedFor` too, but no person is
          // being asked anything: approving it would cut its timer or signal
          // short. It resumes via its deadline or POST /api/runs/:id/signal.
          if (pendingWaitOf(stored.stateJson)) {
            return sendError(
              res,
              409,
              `Run is waiting at "${stored.pausedFor}" for a timer or signal, not paused at an approval gate.`,
            );
          }
          const pausedFor = stored.pausedFor;

          // request-changes requires feedback to act on — it's the whole
          // input to the revision.
          if (decision === 'request-changes' && !(message && message.trim())) {
            return sendError(
              res,
              400,
              "request-changes requires a non-empty 'message' (the feedback to revise against).",
            );
          }

          // Record the human's decision in the durable log first, so the
          // conversation thread shows it even if the resume below races the
          // next poll. Append BEFORE any status flip: while the run is still
          // `paused`, appendEvent's lease fence accepts the write.
          await store.appendEvent(id, scrubEvent({
            type: 'gate-decision',
            phaseName: pausedFor,
            decision,
            message: message?.trim() ?? '',
            // The approver's identity, from the same resolved owner the route
            // just authorized against (a verified JWT claim when one is
            // configured, otherwise the X-Sammy-User header). Without this the
            // approval trail cannot name who approved.
            decidedBy: extractOwnerId(req),
            ts: Date.now(),
          }));

          if (decision === 'reject') {
            // Reject the gate → cancel the run, through the shared
            // per-run-serialized cancel seam (cancelStoredRunAndDrain):
            // status flip + run-cancelled sentinel + concurrency-group
            // release/drain (a gate-paused run still HOLDS its group, and
            // this reject bypasses the executor's onTerminal hook — without
            // the drain a fire queued behind it stays stranded). The lock
            // means a reject racing a /cancel can't double-drain the queue.
            const out = await cancelStoredRunAndDrain(id);
            if (
              out.outcome === 'cancelled' ||
              (out.outcome === 'already-terminal' && out.status === 'cancelled')
            ) {
              // Cancelled by us — or by a concurrent cancel that won the
              // race; either way the state the human asked for. Idempotent.
              return sendJson(res, 200, { ok: true, cancelled: true });
            }
            return sendError(
              res,
              409,
              out.outcome === 'not-found'
                ? 'Run not found'
                : `Run is ${out.status}, no longer paused at a gate.`,
            );
          }

          // approve / request-changes both resume the run.
          const ctx = await loadRunContext(stored.orchestrationName, {
            orchestrationOverride: stored.orchestrationSnapshot as Node | null,
          });
          if (!ctx)
            return sendError(
              res,
              404,
              `Orchestration not found: ${stored.orchestrationName}`,
            );

          let gateMessages: Record<string, string> = {};
          let invalidateLeaves: string[] | undefined;
          let reArmLock = false;

          if (decision === 'request-changes') {
            // Compute which completed leaves to re-run. A `lock` gates BEFORE
            // its phase dispatches, so the reviewed work is what ran before
            // the gate — but that is NOT always a single leaf. When the gate
            // sits AFTER a refinement loop (the ticket-to-PR shape: implement
            // loop → review → open-pr[lock]), the last completed leaf is
            // `review` while the implementation lives in the loop body's
            // SCOPED leaves. Invalidating only `review` would let implement +
            // qa-verify REPLAY from cache, so the dev never re-implements with
            // the feedback and review re-runs against the same stale diff —
            // the same verdict, feedback silently dropped. The helper detects
            // the enclosing loop and invalidates its whole body (all
            // iterations) PLUS everything completed after it up to the gate,
            // so the resumed run genuinely re-implements → re-verifies →
            // re-reviews, then (reArmLock) re-pauses once. For a plain
            // pre-loop gate (e.g. the `plan` gate) it still invalidates just
            // the single reviewed leaf, unchanged.
            const completed = stored.completedLeaves ?? [];
            const invalidate = computeRequestChangesInvalidation(completed);
            if (invalidate.length === 0) {
              return sendError(
                res,
                409,
                'No completed phase precedes this gate — nothing to revise. ' +
                  'Use approve to proceed or reject to cancel.',
              );
            }
            // Route the human's feedback to the producer that should act on it
            // — the loop's `implement` leaf when present, else the single
            // reviewed leaf. Map its replayKey back to the display phase NAME
            // (the executor keys gateMessages by node.name, which differs from
            // the replayKey only for scoped loop/map leaves). The last
            // phase-end carrying this replayKey is authoritative.
            const targetKey = feedbackTargetKey(invalidate, completed);
            let targetPhaseName = targetKey ?? '';
            if (targetKey) {
              for (let i = stored.events.length - 1; i >= 0; i--) {
                const e = stored.events[i] as {
                  type?: string;
                  phaseName?: string;
                  replayKey?: string;
                };
                if (
                  e.type === 'phase-end' &&
                  typeof e.phaseName === 'string' &&
                  (e.replayKey === targetKey ||
                    (e.replayKey == null && e.phaseName === targetKey))
                ) {
                  targetPhaseName = e.phaseName;
                  break;
                }
              }
            }
            // Anti-retry-storm guard: if the phase this feedback would re-run
            // last declared its failure TERMINAL (a `SAMMY-TERMINAL:` marker /
            // TerminalPhaseError surfaced as `phase-terminal`), refuse to force
            // a re-implementation — the executor already flagged re-running it
            // as pointless (a broken validator / dead infra, not a wrong fix).
            // Re-running on request-changes is exactly the storm the terminal
            // marker exists to stop. The human can reject (cancel) or fix the
            // infra and start a fresh run.
            const terminalReason = terminalFailureForGate(
              stored.events as Array<{
                type?: string;
                phaseName?: string;
                reason?: string;
                error?: string;
              }>,
              targetPhaseName || null,
            );
            if (terminalReason) {
              return sendError(
                res,
                409,
                `Phase "${targetPhaseName}" reported a TERMINAL (do-not-retry) ` +
                  `failure — request-changes will not re-run it: ${terminalReason}. ` +
                  'Resolve the underlying cause and start a new run, or reject to cancel.',
              );
            }
            gateMessages =
              message && targetPhaseName ? { [targetPhaseName]: message } : {};
            invalidateLeaves = invalidate;
            reArmLock = true;
          } else {
            // approve (optionally with a correction wired to the gated phase).
            gateMessages =
              message && message.trim() ? { [pausedFor]: message } : {};
          }

          const result = await resumeServerRun({
            store,
            id,
            gateMessages,
            invalidateLeaves,
            reArmLock,
            // On a request-changes re-pause the hook fires with 'paused' —
            // notify sees the run park at the gate again, which is exactly
            // the visibility an unattended reviewer wants.
            budgetGate: (await loadBudgetState(budgetFile, store, stored.ownerId)).gate,
            onTerminal: buildTerminalHook(
              stored.orchestrationName,
              ctx.orchestration,
              stored.ownerId,
            ),
            divergence: ctx.orchestration.notify?.divergence,
            buildEventSource: (
              signal,
              replayOutputs,
              autoApproveLocks,
              gms,
              runId,
              waits,
              inputs,
            ) =>
              buildExecutorSource(
                ctx,
                {
                  initialInput: stored.initialInput ?? undefined,
                  allowAgentTools: true,
                  replayOutputs,
                  autoApproveLocks,
                  gateMessages: gms,
                  ownerId: stored.ownerId,
                  runId,
                  pendingWaits: waits.pendingWaits,
                  deliveredSignals: waits.deliveredSignals,
                  resolvedInputs: inputs,
                },
                signal,
              ),
          });
          if (!result.ok) return sendError(res, 409, result.reason);
          return sendJson(res, 200, {
            ok: true,
            resumed: true,
            decision,
            messageDelivered: Object.keys(gateMessages).length > 0,
          });
        }

        // POST /api/runs/:id/fork  body: { atPhase: string }
        // Tracepoint branching: fork a finished / paused / errored run
        // into a NEW run that replays every leaf phase completed BEFORE
        // `atPhase` from the source run's captured outputs, then
        // re-executes `atPhase` and everything after it fresh. Useful
        // for "the run went wrong at phase X — try X again without
        // re-paying for phases 1..X-1".
        if (action === 'fork') {
          if ((req.method ?? 'POST') !== 'POST')
            return sendError(res, 405, 'Method not allowed');
          let body: { atPhase?: string };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON');
          }
          const atPhase = body.atPhase;
          if (!atPhase || typeof atPhase !== 'string') {
            return sendError(res, 400, 'atPhase (a completed leaf name) required');
          }
          const stored = await store.getRun(id, extractOwnerId(req));
          if (!stored) return sendError(res, 404, 'Run not found');
          const completed = stored.completedLeaves ?? [];
          const cut = completed.indexOf(atPhase);
          if (cut < 0) {
            return sendError(
              res,
              400,
              `"${atPhase}" is not a completed leaf of run ${id}. Completed: ${completed.join(', ') || '(none)'}`,
            );
          }
          // Replay every leaf STRICTLY before the fork point; re-run
          // atPhase + everything after.
          const srcOutputs =
            (stored.stateJson as { leafOutputs?: Record<string, string> } | null)
              ?.leafOutputs ?? {};
          const replayOutputs: Record<string, string> = {};
          for (const name of completed.slice(0, cut)) {
            if (typeof srcOutputs[name] === 'string') {
              replayOutputs[name] = srcOutputs[name];
            }
          }
          const ctx = await loadRunContext(stored.orchestrationName, {
            orchestrationOverride: stored.orchestrationSnapshot as Node | null,
          });
          if (!ctx)
            return sendError(
              res,
              404,
              `Orchestration not found: ${stored.orchestrationName}`,
            );
          // A fork starts a fresh run — same spend gate as /runs/start.
          const { status: forkBudgetStatus, gate: forkBudgetGate } =
            await loadBudgetState(budgetFile, store, extractOwnerId(req));
          if (forkBudgetStatus.blocked) {
            return sendError(res, 402, budgetBlockedMessage(forkBudgetStatus));
          }
          const forkOwnerId = extractOwnerId(req);
          // The source run's resolved inputs come along: a fork re-runs the
          // steps after the fork point, and those read `${ticket}` too.
          const forkInputs = (stored.stateJson as { resolvedInputs?: Record<string, string> } | null)
            ?.resolvedInputs;
          const { id: forkedId } = await startServerRun({
            store,
            orchestrationName: stored.orchestrationName,
            initialInput: stored.initialInput ?? undefined,
            ...(forkInputs ? { resolvedInputs: forkInputs } : {}),
            orchestrationSnapshot: ctx.orchestration,
            budgetGate: forkBudgetGate,
            ownerId: forkOwnerId,
            onTerminal: buildTerminalHook(
              stored.orchestrationName,
              ctx.orchestration,
              forkOwnerId,
            ),
            buildEventSource: (signal, runId) =>
              buildExecutorSource(
                ctx,
                {
                  initialInput: stored.initialInput ?? undefined,
                  allowAgentTools: true,
                  replayOutputs,
                  ownerId: forkOwnerId,
                  resolvedInputs: forkInputs,
                  runId,
                  // The replayed leaves' ARTIFACTS come along: a replay does
                  // not re-run the step that recorded one, and the fork's
                  // own id has none — so an upload past the fork point
                  // failed with "no artifact named …".
                  // Matched on the recording step's exact checkpoint key, so
                  // a same-named step elsewhere (another branch, another map
                  // item) does not come along. (Events recorded before the
                  // key existed fall back to the phase name.)
                  seedArtifacts: (stored.events as Array<Record<string, unknown>>).filter(
                    e =>
                      e.type === 'artifact' &&
                      (typeof e.replayKey === 'string'
                        ? Object.prototype.hasOwnProperty.call(replayOutputs, e.replayKey)
                        : Object.keys(replayOutputs).some(
                            k => k === e.phaseName || k.endsWith(`/${String(e.phaseName)}`),
                          )),
                  ) as never,
                },
                signal,
              ),
          });
          return sendJson(res, 200, {
            id: forkedId,
            forkedFrom: id,
            atPhase,
            replayedLeaves: Object.keys(replayOutputs),
          });
        }

        // GET /api/runs/:id/artifacts            → list the run's artifacts
        // GET /api/runs/:id/artifacts?name=<n>   → one artifact's content
        // Artifacts are `artifact` events (a code.run step's `artifact` log),
        // so they are owner-scoped, durable and retained exactly like the run.
        // When a name repeats (a retried step), the latest wins.
        if (action === 'artifacts') {
          if ((req.method ?? 'GET') !== 'GET')
            return sendError(res, 405, 'Method not allowed');
          const run = await store.getRun(id, extractOwnerId(req));
          if (!run) return sendError(res, 404, 'Run not found');
          const arts = (run.events as Array<Record<string, unknown>>).filter(
            e => e.type === 'artifact',
          );
          const wanted = url.searchParams.get('name');
          if (wanted === null) {
            return sendJson(
              res,
              200,
              arts.map(a => ({
                name: a.name,
                phaseName: a.phaseName,
                mediaType: a.mediaType,
                bytes: a.bytes,
                truncated: a.truncated,
                ts: a.ts,
              })),
            );
          }
          const hit = [...arts].reverse().find(a => a.name === wanted);
          if (!hit) return sendError(res, 404, `No artifact named "${wanted}"`);
          res.statusCode = 200;
          res.setHeader('content-type', `${String(hit.mediaType ?? 'text/plain')}; charset=utf-8`);
          res.setHeader('x-content-type-options', 'nosniff');
          return res.end(String(hit.content ?? ''));
        }

        // GET /api/runs/:id/trace
        // Export the run as an OpenTelemetry trace (OTLP/JSON) — the
        // shape an OTLP/HTTP collector accepts at POST /v1/traces.
        // The run becomes the root span; each phase a child span.
        if (action === 'trace') {
          if ((req.method ?? 'GET') !== 'GET')
            return sendError(res, 405, 'Method not allowed');
          const run = await store.getRun(id, extractOwnerId(req));
          if (!run) return sendError(res, 404, 'Run not found');
          const trace = buildOtlpTrace({
            id: run.id,
            orchestrationName: run.orchestrationName,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            status: run.status,
            events: run.events as Array<
              Record<string, unknown> & { type: string; ts?: number }
            >,
          });
          return sendJson(res, 200, trace);
        }

        return next();
      }));

      // GET  /api/credentials       → { [name]: { value, description? } }
      // PUT  /api/credentials       → write the entire registry (full
      //                                  replace; client sends the new map)
      //
      // Foundation for per-orchestration credential references. Today,
      // the only consumer is the provider-key fallback chain (env wins,
      // then this registry by canonical name `openai` / `gemini` /
      // `anthropic`). Future use: nodes opt-in via `credential: "name"`.
      server.middlewares.use('/api/credentials', answered(async (req, res, next) => {
        // Vite's `use(prefix, ...)` is a prefix matcher: this handler
        // also gets hit for `/api/credentials/import` and any future
        // sub-routes (where the matched prefix is stripped — `req.url`
        // becomes `/import`). Only handle the exact root path; otherwise
        // pass through to the next middleware (the import route is
        // registered below). Without this guard the import POST fell
        // through here and returned 405 because this handler only
        // allows GET / PUT.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const segs = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
        if (segs.length > 0) return next();
        try {
          const method = req.method ?? 'GET';
          // Both verbs are OWNER-SCOPED. The raw file read ignored each
          // entry's own `owners` allowlist, so any caller listed every
          // credential in the registry (masked) and could rewrite any of
          // them. An entry is visible when it has no `owners` (the
          // back-compat default) or lists the caller — the same rule the
          // run-time resolver applies.
          const credOwnerId = extractOwnerId(req);
          if (method === 'GET') {
            // SECURITY: never return raw secrets from the list endpoint.
            // `maskCredentialEntry` masks EVERY secret-bearing field —
            // `value`, every `env` value, the `cache` tokens, any `headers`,
            // secret-looking `fields` — revealing at most a quarter of the
            // characters (a provider prefix + the last 2, e.g. ATATT3…28)
            // and a fixed placeholder below 16 chars, so an operator can
            // recognize an entry without the secret leaving the server.
            // (`maskSecret` in credentials-store.ts is the one policy; it
            // used to be an unconditional first 6 + last 2, which disclosed
            // most of a short password.) Masking only `value` shipped an
            // mcp-server entry's provider keys and an SSO entry's cached
            // role credentials verbatim. The raw values stay server-side;
            // resolution (provider routing, env injection, test-probe)
            // reads credentials.json directly.
            const raw = await readCredentials(credentialsFile);
            const masked: CredentialsConfig = {};
            for (const [name, entry] of Object.entries(raw)) {
              if (!credentialVisibleTo(entry, credOwnerId)) continue;
              masked[name] = maskCredentialEntry(entry);
            }
            return sendJson(res, 200, masked);
          }
          if (method === 'PUT') {
            let parsed: unknown;
            try {
              parsed = JSON.parse(await readBody(req));
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed)
            ) {
              return sendError(
                res,
                400,
                'Body must be a JSON object: { [name]: { value, description? } }',
              );
            }
            // The UI pre-fills its edit form from the (now MASKED) GET and
            // PUTs the whole map back. Reconcile against the on-disk values
            // so an entry the user didn't re-type — its secrets arriving as
            // the mask or empty — keeps its real stored secrets instead of
            // being overwritten by the mask. A genuinely changed value is
            // taken as-is. This is the explicit, separate path that keeps
            // editing working without ever shipping the raw value over GET.
            //
            // "Full replace" is now full replace OF THE CALLER'S VIEW:
            //   - an entry the caller cannot see is neither modifiable nor
            //     deletable. Naming one is refused 404-shaped (not 409 — a
            //     distinguishable answer would confirm the name exists);
            //     omitting one leaves it exactly as it was.
            //   - an entry saved WITHOUT its secret (a restored mask) may
            //     not move: `url` / `fields` decide where the stored secret
            //     is sent (the probe, the connection-ref resolver) and
            //     `owners` / `orchestrations` who may use it. A caller who
            //     never saw the secret could otherwise re-point it at a host
            //     of their choosing and have "Test connection" deliver it.
            const incoming = parsed as CredentialsConfig;
            const existing = await readCredentials(credentialsFile);
            const reconciled: CredentialsConfig = {};
            for (const [name, entry] of Object.entries(incoming)) {
              const prior = existing[name];
              if (prior && !credentialVisibleTo(prior, credOwnerId)) {
                return sendError(
                  res,
                  404,
                  `Connection "${name}" not found for this caller — it cannot be written.`,
                );
              }
              const { entry: merged, restored } = reconcileMaskedEntry(entry, prior);
              if (prior && restored) {
                const moved = credentialDestinationChange(merged, prior);
                if (moved) {
                  return sendError(
                    res,
                    400,
                    `Connection "${name}": cannot change \`${moved}\` while its ` +
                      'secret is masked. Re-enter the secret to change where it ' +
                      'is sent or who may use it.',
                  );
                }
              }
              reconciled[name] = merged;
            }
            // Entries outside the caller's view survive untouched.
            for (const [name, entry] of Object.entries(existing)) {
              if (!(name in reconciled) && !credentialVisibleTo(entry, credOwnerId)) {
                reconciled[name] = entry;
              }
            }
            const saved = await writeCredentials(credentialsFile, reconciled);
            // Echo back MASKED — the PUT response is just as much a list
            // surface as GET, so it must not return raw values either — and
            // scoped the same way.
            const maskedSaved: CredentialsConfig = {};
            for (const [name, entry] of Object.entries(saved)) {
              if (!credentialVisibleTo(entry, credOwnerId)) continue;
              maskedSaved[name] = maskCredentialEntry(entry);
            }
            return sendJson(res, 200, maskedSaved);
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] credentials error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      }));

      // POST /api/credentials/import
      // One-shot migration helper: gather pre-`kind` credential data
      // from every surface that historically held secrets (browser
      // localStorage, provider env vars, MCP env blocks) and merge it
      // into the unified `credentials.json` registry as kind-tagged
      // entries.
      //
      // The browser is the only one that can read its own localStorage;
      // it sends what it has in the request body:
      //
      //   { localStorage: { "sammy.connection.github.token": "ghp_…",
      //                     "sammy.connection.jira.email": "you@…",
      //                     "sammy.anthropicApiKey": "sk-ant-…", ... },
      //     dryRun?: boolean }
      //
      // The server adds env-var fallbacks (ANTHROPIC_API_KEY etc.) and
      // MCP env blocks, then writes through `writeCredentials`. Idempotent
      // — running twice produces the same registry (existing entries with
      // the same value are left alone; new entries get a `kind` tag and
      // a description noting the source).
      //
      // Returns `{ added: string[], updated: string[], unchanged: string[],
      //           skipped: Array<{ source: string; reason: string }>,
      //           registry: CredentialsConfig }`. With `dryRun: true`, the
      // file isn't written — useful for showing a preview before commit.
      server.middlewares.use('/api/credentials/import', async (req, res) => {
        try {
          if ((req.method ?? 'GET') !== 'POST') {
            return sendError(res, 405, 'POST only');
          }
          let body: { localStorage?: Record<string, string>; dryRun?: boolean };
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendError(res, 400, 'Invalid JSON body');
          }
          const ls = body.localStorage ?? {};
          const dryRun = body.dryRun === true;

          // Resolved BEFORE the merge loop, not just for the response mask
          // below: this writer had no owner gate at all, so one identity
          // overwrote another owner's `value` / `fields` / `kind` while
          // `owners` survived from `prev` — the entry stayed the victim's and
          // the damage was invisible to both. The identical PUT is 404'd.
          const importOwnerId = extractOwnerId(req);
          // Start from existing registry — never clobber entries the
          // user already set.
          const existing = await readCredentials(credentialsFile);
          const next: Record<string, Record<string, unknown>> = { ...existing };
          const added: string[] = [];
          const updated: string[] = [];
          const unchanged: string[] = [];
          const skipped: Array<{ source: string; reason: string }> = [];

          /** Upsert a kind-tagged entry; track which bucket it landed in. */
          function upsert(name: string, entry: Record<string, unknown>): void {
            const prev = existing[name];
            if (!prev) {
              next[name] = entry;
              added.push(name);
              return;
            }
            // THE SAME TWO RULES THE PUT OWNS — this is the third writer of
            // credentials.json and it had neither.
            //
            // 1) Visibility. Skipped with a reason rather than failing the
            //    whole request: this route is a one-shot batch migration, so
            //    one colliding name must not abort the caller's own entries.
            //    The reason is the PUT's wording, so neither writer says more
            //    about an entry the caller cannot see than the other.
            if (!credentialVisibleTo(prev as Credential, importOwnerId)) {
              skipped.push({
                source: name,
                reason: 'not found for this caller — it cannot be written',
              });
              return;
            }
            // 2) The masked-move rule. Reconciling first means an echoed mask
            //    restores the stored secret instead of being written to disk
            //    AS the secret (this route destroyed the value that way), and
            //    `restored` is then the same signal the PUT refuses a
            //    destination change on: a caller who never supplied the secret
            //    must not re-point where it is sent or who may use it.
            const { entry: reconciled, restored } = reconcileMaskedEntry(
              entry as Credential,
              prev,
            );
            // Preserve user-set scoping/description; merge new fields in.
            const merged = { ...prev, ...reconciled } as Credential;
            // Don't overwrite a non-empty value with an empty one.
            if (!reconciled.value && prev.value) merged.value = prev.value;
            if (restored) {
              const moved = credentialDestinationChange(merged, prev);
              if (moved) {
                skipped.push({
                  source: name,
                  reason:
                    `cannot change \`${moved}\` while its secret is masked — ` +
                    're-enter the secret to change where it is sent or who ' +
                    'may use it',
                });
                return;
              }
            }
            const changed = JSON.stringify(merged) !== JSON.stringify(prev);
            next[name] = merged as Record<string, unknown>;
            (changed ? updated : unchanged).push(name);
          }

          // ─── Legacy ConnectionsPage localStorage entries ───
          // Keys like `sammy.connection.<type>.token` and
          // `sammy.connection.<type>.<field>`. Hoist into kind-tagged
          // entries with name == the type id.
          const connTokenRe = /^sammy\.connection\.([^.]+)\.token$/;
          const connFieldRe = /^sammy\.connection\.([^.]+)\.(.+)$/;
          const groupedConn: Record<string, { token?: string; fields: Record<string, string> }> = {};
          for (const [key, value] of Object.entries(ls)) {
            const tk = key.match(connTokenRe);
            if (tk) {
              const type = tk[1];
              (groupedConn[type] ??= { fields: {} }).token = value;
              continue;
            }
            const fk = key.match(connFieldRe);
            if (fk && fk[2] !== 'token') {
              const type = fk[1];
              (groupedConn[type] ??= { fields: {} }).fields[fk[2]] = value;
            }
          }
          for (const [type, data] of Object.entries(groupedConn)) {
            if (!data.token) {
              skipped.push({ source: `connection:${type}`, reason: 'no token' });
              continue;
            }
            const entry: Record<string, unknown> = {
              kind: type, // matches CredentialKind values for github/jira/etc.
              value: data.token,
              description: `Imported from ConnectionsPage localStorage`,
            };
            if (Object.keys(data.fields).length > 0) entry.fields = data.fields;
            upsert(type, entry);
          }

          // ─── Browser-side LLM provider keys ───
          // localStorage keys live in `apiKey.ts`:
          //   sammy.anthropicApiKey, sammy.openaiApiKey, sammy.geminiApiKey
          const providerMap: Array<[string, string]> = [
            ['sammy.anthropicApiKey', 'anthropic'],
            ['sammy.openaiApiKey', 'openai'],
            ['sammy.geminiApiKey', 'gemini'],
          ];
          for (const [lsKey, canonicalName] of providerMap) {
            const v = ls[lsKey];
            if (!v) {
              skipped.push({ source: lsKey, reason: 'not present in browser' });
              continue;
            }
            upsert(canonicalName, {
              kind: canonicalName,
              value: v,
              description: 'Imported from Settings page localStorage',
            });
          }

          // ─── Server-side env-var fallbacks ───
          // ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY are read
          // at run time as a fallback already; importing them surfaces
          // the value in the Connections UI so users can see what's in
          // use. Only import if not already in the registry — env vars
          // remain authoritative at runtime.
          const envMap: Array<[string, string]> = [
            ['ANTHROPIC_API_KEY', 'anthropic'],
            ['OPENAI_API_KEY', 'openai'],
            ['GEMINI_API_KEY', 'gemini'],
          ];
          for (const [envName, canonicalName] of envMap) {
            const v = process.env[envName]?.trim();
            if (!v) continue;
            if (existing[canonicalName]?.value) {
              skipped.push({
                source: `env:${envName}`,
                reason: 'registry entry already exists',
              });
              continue;
            }
            upsert(canonicalName, {
              kind: canonicalName,
              value: v,
              description: `Imported from ${envName} environment variable`,
            });
          }

          // ─── MCP env blocks → mcp-server credentials ───
          // Walk mcp/servers.json; for any entry with a non-empty `env`
          // block, write a paired `mcp-<name>` credential carrying the
          // env block, and recommend the user replace inline values with
          // `${connections:mcp-<name>.env.<KEY>}` in mcp/servers.json.
          const mcpRegistry = await loadMcpRegistry();
          for (const [mcpName, raw] of Object.entries(mcpRegistry)) {
            const cfg = raw as { env?: Record<string, string> };
            if (!cfg.env || Object.keys(cfg.env).length === 0) continue;
            // Skip if every env value is already a ${connections:...} ref
            // (already migrated).
            const allRefs = Object.values(cfg.env).every(v =>
              typeof v === 'string' && v.includes('${connections:'),
            );
            if (allRefs) {
              skipped.push({
                source: `mcp:${mcpName}`,
                reason: 'env block already uses ${connections:...}',
              });
              continue;
            }
            const name = `mcp-${mcpName}`;
            upsert(name, {
              kind: 'mcp-server',
              ref: mcpName,
              value: '', // primary token field unused for env-only kinds
              env: cfg.env,
              description: `Imported from mcp/servers.json (env block of "${mcpName}")`,
            });
          }

          if (!dryRun) {
            await writeCredentials(
              credentialsFile,
              next as Record<string, { value: string; description?: string }>,
            );
          }
          // SECURITY: the import result is a list surface — mask `registry`
          // exactly like GET does (every secret-bearing field, not just
          // `value` — the imported mcp-server entries carry their provider
          // keys in `env`) and scope it to the caller's view. The
          // added/updated/unchanged NAME lists carry no secret; only the
          // registry map holds values. The UI re-fetches (masked) on a real
          // import anyway and only reads the count lists from this payload.
          const maskedRegistry: CredentialsConfig = {};
          for (const [n, entry] of Object.entries(next as CredentialsConfig)) {
            if (!credentialVisibleTo(entry, importOwnerId)) continue;
            maskedRegistry[n] = maskCredentialEntry(entry);
          }
          return sendJson(res, 200, {
            added,
            updated,
            unchanged,
            skipped,
            registry: maskedRegistry,
            dryRun,
          });
        } catch (err) {
          console.error('[sammy-pack-api] credentials import error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // POST /api/credentials/test
      // Live test of a connection by name. Request body:
      //   { name: string,
      //     /** Optional override URL — used by the Add/Edit form so
      //      *  unsaved field values can be probed without persisting. */
      //     urlOverride?: string,
      //     valueOverride?: string,
      //     fieldsOverride?: Record<string, string> }
      //
      // Looks up the credential's `kind` in the kind registry to get
      // the testProbe descriptor, resolves the URL template against
      // the credential's actual fields (or the overrides), sends the
      // request with the appropriate auth header, returns
      //   { ok: boolean, status?: number, message: string }
      //
      // Auth methods supported:
      //   - bearer: `Authorization: Bearer <value>`
      //   - basic-email-token: `Authorization: Basic base64(email:value)`
      //   - api-key-header: `<headerName>: <value>`
      //   - none: no auth header
      //
      // This is the server-side companion to the `testProbe` field on
      // ConnectionKindDef. Server-side because (a) the request needs
      // to be made from the dev server's network context (CORS-free)
      // and (b) the resolved credential value never has to leave the
      // server.
      server.middlewares.use('/api/credentials/test', async (req, res) => {
        try {
          if ((req.method ?? 'GET') !== 'POST') {
            return sendError(res, 405, 'POST only');
          }
          // The overrides are `unknown`, not `string` / `Record`: they come
          // off a caller-supplied JSON body, and the DESTINATION RULE below
          // decides what counts as "supplied" by shape. A narrower
          // declaration here only advertises a guarantee nothing checks.
          type Body = {
            name?: string;
            urlOverride?: unknown;
            valueOverride?: unknown;
            fieldsOverride?: unknown;
          };
          let body: Body;
          try {
            body = JSON.parse(await readBody(req)) as Body;
          } catch {
            return sendError(res, 400, 'Invalid JSON body');
          }
          if (!body.name || typeof body.name !== 'string') {
            return sendError(res, 400, '`name` is required');
          }
          // Read through the OWNER-SCOPED reader, not the raw file. The raw
          // read ignored each credential's own `owners` / `orchestrations`
          // allowlist, so any caller could address any credential by name —
          // the allowlists existed and this route walked straight past them.
          const creds = readCredentialsByNameRaw(credentialsFile, {
            ownerId: extractOwnerId(req),
          });
          const entry = creds[body.name];
          if (!entry) {
            return sendJson(res, 200, {
              ok: false,
              message: `Connection "${body.name}" not found in credentials.json`,
            });
          }
          const kindId = entry.kind ?? 'secret';
          // Single source of truth: the testProbe descriptor lives on
          // each kind def in `src/store/kindRegistry.ts`. Server reads
          // it directly so there's no inline duplicate table to keep
          // in sync — a second copy is a drift class, and collapsing to
          // one source removes it. A parity test in
          // __tests__/connections.test.ts asserts every kind def with
          // a testProbe has a complete/well-formed descriptor.
          const kindDef = KIND_REGISTRY.find(k => k.id === kindId);
          const probe = kindDef?.testProbe;
          if (!probe) {
            return sendJson(res, 200, {
              ok: false,
              message: `Kind "${kindId}" has no test probe defined.`,
            });
          }
          // Resolve the URL template — ${value} / ${url} /
          // ${fields.<key>} → entry fields, with overrides preferred
          // so the Add form can probe unsaved values.
          //
          // ── DESTINATION RULE ─────────────────────────────────────────────
          // The probe attaches the secret to an outbound request, so whoever
          // chooses the DESTINATION chooses where the secret goes. Overrides
          // existed so the Add form could probe a connection before saving
          // it — but they were merged over the STORED entry unconditionally,
          // so a request naming only `urlOverride` made the server deliver a
          // stored credential to a host of the caller's choosing. One request,
          // any credential, and it defeated the GET masking entirely: you
          // never needed to read the secret, the server posted it for you.
          //
          // The rule: a caller that supplies its OWN secret (`valueOverride`)
          // may also name the destination — it is probing its own material.
          // A caller relying on the STORED secret gets the STORED destination.
          //
          // "Supplies" is ONE predicate, read by the guard below AND by the
          // value/url/fields reads under it: absence tested one way here and
          // another way there is the hole. `=== undefined` with a nullish
          // `??` read was exactly that — `valueOverride: null` passed the
          // guard as "supplied" and then read the STORED secret, so one
          // request delivered a saved credential to a caller-chosen host,
          // which is the whole thing this rule exists to stop. A caller
          // supplies a secret when it sends a non-blank string that is not
          // the mask GET handed out (`isMaskOf`, the predicate the PUT
          // reconciliation makes the same call with): anything else — a
          // non-string, blank, or the echoed mask — is a caller that never
          // saw the secret, and it gets the STORED destination.
          const ownSecret =
            typeof body.valueOverride === 'string' &&
            body.valueOverride.trim() !== '' &&
            !isMaskOf(body.valueOverride, entry.value ?? '')
              ? body.valueOverride
              : null;
          const usesStoredSecret = ownSecret === null;
          if (
            usesStoredSecret &&
            (body.urlOverride !== undefined || body.fieldsOverride !== undefined)
          ) {
            return sendJson(res, 400, {
              ok: false,
              message:
                'urlOverride / fieldsOverride cannot be combined with the ' +
                'stored secret: that would send a saved credential to a ' +
                'caller-chosen destination. Supply valueOverride to probe ' +
                'your own value, or omit the overrides to probe the saved ' +
                'connection as stored.',
            });
          }
          const value = ownSecret ?? entry.value;
          // Each override is read through the shape the guard recognised as
          // an override, so neither can arrive here in a spelling the rule
          // above treated as absent.
          const ownUrl =
            typeof body.urlOverride === 'string' && body.urlOverride.trim() !== ''
              ? body.urlOverride
              : null;
          const ownFields =
            typeof body.fieldsOverride === 'object' &&
            body.fieldsOverride !== null &&
            !Array.isArray(body.fieldsOverride)
              ? (body.fieldsOverride as Record<string, string>)
              : null;
          const url = usesStoredSecret
            ? (entry.url ?? '')
            : (ownUrl ?? entry.url ?? '');
          const fields = usesStoredSecret
            ? { ...(entry.fields ?? {}) }
            : { ...(entry.fields ?? {}), ...(ownFields ?? {}) };
          const resolved = probe.urlTemplate.replace(
            /\$\{([^}]+)\}/g,
            (whole, expr) => {
              const e = String(expr).trim();
              if (e === 'value') return value ?? whole;
              if (e === 'url') return url || whole;
              if (e.startsWith('fields.')) {
                const k = e.slice('fields.'.length);
                return fields[k] ?? whole;
              }
              return whole;
            },
          );
          if (resolved.includes('${')) {
            return sendJson(res, 200, {
              ok: false,
              message: `URL template has unresolved placeholders: ${resolved}`,
            });
          }
          const headers: Record<string, string> = {
            Accept: 'application/json',
          };
          if (probe.auth === 'bearer') {
            if (!value) {
              return sendJson(res, 200, {
                ok: false,
                message: 'Bearer auth requires a `value` (token).',
              });
            }
            headers.Authorization = `Bearer ${value}`;
          } else if (probe.auth === 'basic-email-token') {
            const email = fields.email;
            if (!email || !value) {
              return sendJson(res, 200, {
                ok: false,
                message:
                  'Basic-email-token auth needs both `fields.email` and `value` (token).',
              });
            }
            const b64 = Buffer.from(`${email}:${value}`).toString('base64');
            headers.Authorization = `Basic ${b64}`;
          } else if (probe.auth === 'api-key-header' && probe.headerName) {
            if (!value) {
              return sendJson(res, 200, {
                ok: false,
                message: `${probe.headerName} requires a value.`,
              });
            }
            headers[probe.headerName] = value;
          }
          let response: Response;
          try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8000);
            response = await fetch(resolved, {
              method: probe.method,
              headers,
              signal: controller.signal as unknown as undefined,
            });
            clearTimeout(t);
          } catch (err) {
            return sendJson(res, 200, {
              ok: false,
              message: `Network error: ${(err as Error).message}`,
            });
          }
          const ok = response.status >= 200 && response.status < 300;
          return sendJson(res, 200, {
            ok,
            status: response.status,
            message: ok
              ? `${response.status} ${response.statusText}`
              : `Probe failed: ${response.status} ${response.statusText}`,
            probedUrl: resolved.replace(/\/+$/, ''),
          });
        } catch (err) {
          console.error('[sammy-pack-api] credentials test error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/credentials/usage
      // Reverse index: for each credential name in credentials.json,
      // list orchestrations in examples/ that reference it via
      // `credential: "<name>"` on any node, plus orchestrations that
      // request an MCP server whose env block references the
      // credential via `${connections:<name>...}`. Returns:
      //   { <credentialName>: { directRefs: [orchestrationName, ...],
      //                         viaMcp:     [{ orch, mcpName }, ...] } }
      // Walks every `.json` under examples/ once; cheap.
      server.middlewares.use('/api/credentials/usage', async (req, res) => {
        try {
          if ((req.method ?? 'GET') !== 'GET') {
            return sendError(res, 405, 'GET only');
          }
          // SCOPED to the caller's view, like GET /api/credentials and the
          // import echo. This read took the raw file, so the usage index
          // enumerated the NAME of every connection in the workspace — and
          // which orchestrations and MCP servers reference it — including the
          // entries the list endpoint deliberately hides, making it an
          // existence oracle for exactly what `owners` exists to withhold.
          const usageOwnerId = extractOwnerId(req);
          const credNames = Object.entries(
            await readCredentials(credentialsFile),
          )
            .filter(([, entry]) => credentialVisibleTo(entry, usageOwnerId))
            .map(([name]) => name);
          if (credNames.length === 0) {
            return sendJson(res, 200, {});
          }
          // Pre-compute the set of MCP server names that reference
          // each credential, so a single walk of orchestrations can
          // ask "does this orchestration request any MCP server that
          // uses credential X?" in O(1).
          const mcpRegistry = await loadMcpRegistry();
          const mcpUsingCred = new Map<string, Set<string>>(); // credName → mcpServerNames
          for (const [mcpName, raw] of Object.entries(mcpRegistry)) {
            const cfg = raw as { env?: Record<string, string> };
            if (!cfg.env) continue;
            for (const val of Object.values(cfg.env)) {
              if (typeof val !== 'string') continue;
              const matches = val.matchAll(
                /\$\{connections:([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_.-]+)?\}/g,
              );
              for (const m of matches) {
                const name = m[1];
                if (!credNames.includes(name)) continue;
                if (!mcpUsingCred.has(name)) mcpUsingCred.set(name, new Set());
                mcpUsingCred.get(name)!.add(mcpName);
              }
            }
          }
          // Walk examples/*.json.
          type Row = {
            directRefs: string[];
            viaMcp: Array<{ orch: string; mcpName: string }>;
          };
          const out: Record<string, Row> = {};
          for (const name of credNames) out[name] = { directRefs: [], viaMcp: [] };
          let files: string[] = [];
          try {
            files = (await fs.readdir(examplesDir)).filter(f => f.endsWith('.json'));
          } catch {
            return sendJson(res, 200, out);
          }
          for (const file of files) {
            const orchName = file.replace(/\.json$/, '');
            let raw: unknown;
            try {
              raw = JSON.parse(
                await fs.readFile(path.join(examplesDir, file), 'utf8'),
              );
            } catch {
              continue;
            }
            // Walk every node in the orchestration. `credential:` can
            // sit on any leaf or composite node; `mcp: [...]` only on
            // agent leaves. We recurse over every object/array.
            const stack: unknown[] = [raw];
            const declaredMcp = new Set<string>();
            while (stack.length > 0) {
              const cur = stack.pop();
              if (!cur || typeof cur !== 'object') continue;
              if (Array.isArray(cur)) {
                stack.push(...cur);
                continue;
              }
              const obj = cur as Record<string, unknown>;
              const credRef = obj.credential;
              if (typeof credRef === 'string' && out[credRef]) {
                if (!out[credRef].directRefs.includes(orchName)) {
                  out[credRef].directRefs.push(orchName);
                }
              }
              const mcpRef = obj.mcp;
              if (Array.isArray(mcpRef)) {
                for (const m of mcpRef) {
                  if (typeof m === 'string') declaredMcp.add(m);
                }
              }
              for (const v of Object.values(obj)) stack.push(v);
            }
            // For each MCP server declared by this orchestration,
            // record which credentials its env block uses.
            for (const mcpName of declaredMcp) {
              for (const [credName, usedBy] of mcpUsingCred) {
                if (usedBy.has(mcpName)) {
                  out[credName].viaMcp.push({ orch: orchName, mcpName });
                }
              }
            }
          }
          return sendJson(res, 200, out);
        } catch (err) {
          console.error('[sammy-pack-api] credentials usage error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET  /api/budget         → { dailyUsd, monthlyUsd } — the caps
      // PUT  /api/budget         → write the caps (JSON body, same shape)
      // GET  /api/budget/status  → computed spend status: used vs. limit
      //                            plus blocked / warning flags
      //
      // The caps live in budget.json at the workspace root; the durable
      // run store is the source of spend truth. That is what makes the
      // cap actually enforceable — POST /api/runs/start refuses a
      // blocked run server-side, instead of the cap being a greyed-out
      // button a direct API call would sail straight past.
      server.middlewares.use('/api/budget', async (req, res) => {
        try {
          const sub = (req.url ?? '/').split('?')[0].replace(/^\/|\/$/g, '');
          const method = req.method ?? 'GET';
          if (sub === 'status') {
            if (method !== 'GET')
              return sendError(res, 405, 'Method not allowed');
            // Scoped to the caller: the UI shows "your" remaining budget,
            // and the cap is enforced per owner, so a global figure here
            // would disagree with what actually blocks their next run.
            const { status } = await loadBudgetState(
              budgetFile,
              store,
              extractOwnerId(req),
            );
            return sendJson(res, 200, status);
          }
          if (sub !== '') return sendError(res, 404, 'Not found');
          if (method === 'GET') {
            return sendJson(res, 200, await readBudgetConfig(budgetFile));
          }
          if (method === 'PUT') {
            let parsed: unknown;
            try {
              parsed = JSON.parse(await readBody(req));
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed)
            ) {
              return sendError(res, 400, 'Body must be a JSON object');
            }
            const p = parsed as Record<string, unknown>;
            // A per-owner field that is ABSENT keeps the file's value (so a
            // client that only knows the global pair cannot wipe them — the
            // store's own rule); an explicit `null` clears it. The route
            // used to forward only the global pair, so the cap that most
            // often does the refusing could not be changed from Settings
            // at all.
            const perOwner = (
              key: 'perOwnerDailyUsd' | 'perOwnerMonthlyUsd',
            ): number | null | undefined =>
              !(key in p) ? undefined : typeof p[key] === 'number' ? (p[key] as number) : null;
            const saved = await writeBudgetConfig(budgetFile, {
              dailyUsd: typeof p.dailyUsd === 'number' ? p.dailyUsd : null,
              monthlyUsd:
                typeof p.monthlyUsd === 'number' ? p.monthlyUsd : null,
              perOwnerDailyUsd: perOwner('perOwnerDailyUsd'),
              perOwnerMonthlyUsd: perOwner('perOwnerMonthlyUsd'),
            });
            return sendJson(res, 200, saved);
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] budget error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // ─── A2A (Agent2Agent) protocol surface ───
      //
      // sammy-pack speaks A2A both ways. Inbound (here): each saved
      // orchestration is exposed as an A2A agent — discoverable via an
      // agent card, invocable via a JSON-RPC task endpoint that maps
      // onto the durable run store. Outbound: the `a2a` node body kind
      // (see the executor) dispatches a phase to a remote A2A agent.
      //
      // GET /.well-known/agent-card.json     → workspace root card
      // GET /api/a2a/:name/agent-card.json   → per-orchestration card
      // POST /api/a2a/:name                  → JSON-RPC 2.0 task surface
      //   methods: message/send, message/stream, tasks/get,
      //            tasks/cancel, tasks/resubscribe

      /** SSE response that relays a run's events as A2A-framed,
       *  JSON-RPC-wrapped streaming events. Shared by message/stream
       *  and tasks/resubscribe. Closes the stream after the run's
       *  final status-update. */
      async function streamA2aRun(
        req: Connect.IncomingMessage,
        res: import('node:http').ServerResponse,
        rpcId: string | number | null,
        runId: string,
      ): Promise<void> {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            res.end();
          } catch {
            /* already closed */
          }
        };
        const sub = await subscribeServerRun(store, runId, ev => {
          if (closed) return;
          const a2aEvent = runEventToA2aStreamEvent(ev, runId);
          if (!a2aEvent) return;
          res.write(
            `data: ${JSON.stringify(jsonRpcResult(rpcId, a2aEvent))}\n\n`,
          );
          if (a2aEvent.kind === 'status-update' && a2aEvent.final) close();
        });
        if (sub.finished) {
          close();
          return;
        }
        req.on('close', () => {
          sub.unsubscribe();
          closed = true;
        });
      }

      // Card signing: when SAMMY_A2A_SIGNING_KEY (RSA private key PEM) is
      // set, every served agent card carries a JWS RS256 signature so
      // callers can pin this workspace's publisher key
      // (SAMMY_A2A_REMOTE_PUBLIC_KEY on their side). A signing FAILURE with
      // a configured key throws — better a 500 the operator sees than
      // silently serving unsigned cards a pinning caller will refuse.
      const maybeSignCard = async (
        card: import('./src/llm/a2a').A2aAgentCard,
      ): Promise<import('./src/llm/a2a').A2aAgentCard> => {
        const pem = process.env.SAMMY_A2A_SIGNING_KEY?.trim();
        if (!pem) return card;
        return signAgentCard(card, pem);
      };

      // GET /.well-known/agent-card.json — workspace root card. A
      // discovery index whose skills enumerate every saved orchestration.
      //
      // Gated like root /metrics under SAMMY_REQUIRE_AUTH_READS=1, with the
      // SAME gate functions the /api mount uses: this mount too sits outside
      // /api and so escaped every gate — the card enumerated every
      // orchestration's name and description to an anonymous caller under
      // the posture that promises only the probes stay open. No public
      // opt-out: unlike a Prometheus scraper, the A2A discovery story needs
      // none — the outbound A2A client sends no credential at all, and the
      // per-orchestration card and the JSON-RPC surface it points at are
      // already behind the /api gates, so an open root card bought anonymous
      // federation nothing under this posture. Those gates classify a
      // MOUNT-RELATIVE path, so a sub-path reaches their own /api exemptions
      // (`<card>/livez` is `/livez` in there) — the handler's exact-path
      // check below is what keeps that from serving the card anonymously.
      if (requireAuthReads) {
        if (bearerGate) {
          server.middlewares.use('/.well-known/agent-card.json', bearerGate);
        }
        if (jwtGate) {
          server.middlewares.use('/.well-known/agent-card.json', jwtGate);
        }
      }
      server.middlewares.use(
        '/.well-known/agent-card.json',
        async (req, res) => {
          // An EXACT-path resource (the well-known URI), enforced here and
          // not left to the mount: connect strips the mount by LENGTH, so
          // `<card>/livez` reaches this handler — and reached the gates above
          // as `/livez`, their own probe exemption, which served the whole
          // discovery index anonymously under gated reads.
          //
          // Canonicalised by `gatePath` for the same reason root /metrics is:
          // the gates above classify that string, and a hand-rolled remainder
          // 404'd the card itself under an absolute-form target and a `#`
          // tail — spellings the gate had already read as the resource.
          const rest = gatePath(req.url);
          if (rest !== '/') return sendError(res, 404, 'Not found');
          if ((req.method ?? 'GET') !== 'GET')
            return sendError(res, 405, 'Method not allowed');
          try {
            const entries = await fs
              .readdir(examplesDir)
              .catch(() => [] as string[]);
            const orchestrations: Array<{
              name: string;
              description?: string;
            }> = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const parsed = (await readJsonFile(
                path.join(examplesDir, f),
              )) as {
                description?: string;
                lifecycle?: { deprecated?: boolean };
              } | null;
              // Hide deprecated orchestrations from A2A discovery —
              // they're still runnable by direct id but shouldn't show
              // up as a skill anyone might pick from the catalog.
              if (parsed?.lifecycle?.deprecated) continue;
              orchestrations.push({
                name: f.replace(/\.json$/, ''),
                description: parsed?.description,
              });
            }
            return sendJson(
              res,
              200,
              await maybeSignCard(
                buildRootCard({ baseUrl: baseUrlFromReq(req), orchestrations }),
              ),
            );
          } catch (err) {
            console.error('[sammy-pack-api] a2a root card error:', err);
            return sendError(res, 500, (err as Error).message);
          }
        },
      );

      // /api/a2a/:name/agent-card.json (GET) + /api/a2a/:name (POST RPC)
      server.middlewares.use('/api/a2a', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname
            .replace(/^\//, '')
            .split('/')
            .filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';
          if (!name || !isSafeName(name)) {
            return sendError(res, 400, 'A2A: invalid orchestration name');
          }

          // GET /api/a2a/:name/agent-card.json
          if (segs[1] === 'agent-card.json') {
            if (method !== 'GET')
              return sendError(res, 405, 'Method not allowed');
            const orch = (await readJsonFile(
              path.join(examplesDir, `${name}.json`),
            )) as { description?: string } | null;
            if (!orch)
              return sendError(res, 404, `Orchestration not found: ${name}`);
            return sendJson(
              res,
              200,
              await maybeSignCard(
                buildOrchestrationCard({
                  name,
                  description: orch.description,
                  baseUrl: baseUrlFromReq(req),
                }),
              ),
            );
          }

          // POST /api/a2a/:name — JSON-RPC 2.0. Errors are HTTP 200 with
          // a JSON-RPC error body, per the protocol.
          if (segs.length === 1 && method === 'POST') {
            let rpc: JsonRpcRequest;
            try {
              rpc = JSON.parse(await readBody(req));
            } catch {
              return sendJson(
                res,
                200,
                jsonRpcError(null, A2A_ERROR.parseError, 'Invalid JSON'),
              );
            }
            const rpcId =
              rpc && (typeof rpc.id === 'string' || typeof rpc.id === 'number')
                ? rpc.id
                : null;
            if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
              return sendJson(
                res,
                200,
                jsonRpcError(
                  rpcId,
                  A2A_ERROR.invalidRequest,
                  'Not a JSON-RPC 2.0 request',
                ),
              );
            }
            const params = (rpc.params ?? {}) as Record<string, unknown>;
            // OWNER-SCOPED, like every per-run REST route. Every task method
            // here looked runs up by id with no owner, which made this
            // JSON-RPC surface a complete unscoped twin of the per-run API:
            // a follow-up message resumed ANY paused run under ITS owner and
            // budget, tasks/get returned any run's artifacts, tasks/cancel
            // stopped any run, tasks/resubscribe streamed any run's events.
            // A run that is not the caller's answers "task not found" — the
            // JSON-RPC analogue of the REST 404, never a distinguishable
            // error that would turn the surface into an id-existence oracle.
            const rpcOwnerId = extractOwnerId(req);
            const messageText = (): string => {
              const m = params.message as A2aMessage | undefined;
              return m ? partsToText(m.parts) : '';
            };
            const taskIdParam = (): string => {
              const id = params.id;
              return typeof id === 'string' ? id : '';
            };

            if (rpc.method === 'message/send' || rpc.method === 'message/stream') {
              // Resume-via-follow-up: an A2A message can carry a
              // `taskId` to continue an existing (paused / input-required)
              // task instead of starting a new one. We append the new
              // text as a phase-user-message event for visibility, then
              // call resume() to unblock the run.
              const incomingMsg = params.message as
                | { taskId?: string }
                | undefined;
              const followUpId =
                typeof incomingMsg?.taskId === 'string'
                  ? incomingMsg.taskId
                  : undefined;
              if (followUpId) {
                if (!isSafeName(followUpId)) {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.invalidParams,
                      'message.taskId must be a valid run id',
                    ),
                  );
                }
                const existing = await store.getRun(followUpId, rpcOwnerId);
                if (!existing) {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.taskNotFound,
                      `Task not found: ${followUpId}`,
                    ),
                  );
                }
                if (existing.status !== 'paused') {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.invalidParams,
                      `Task ${followUpId} is ${existing.status}, not input-required — only paused tasks accept follow-up messages.`,
                    ),
                  );
                }
                // A follow-up message RESUMES a paused task, so it is a
                // resume path and pins to the task's own snapshot like the
                // other four.
                const ctx = await loadRunContext(existing.orchestrationName, {
                  orchestrationOverride:
                    existing.orchestrationSnapshot as Node | null,
                });
                if (!ctx) {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.internalError,
                      `Orchestration "${existing.orchestrationName}" not found in workspace`,
                    ),
                  );
                }
                const followText = messageText();
                if (followText) {
                  // Append the follow-up message as a phase-user-message
                  // event so it shows up in the run viewer and any
                  // subsequent A2A subscriber.
                  await store.appendEvent(followUpId, scrubEvent({
                    type: 'phase-user-message',
                    phaseName: existing.pausedFor ?? 'paused',
                    text: followText,
                    ts: Date.now(),
                  }));
                }
                const result = await resumeServerRun({
                  store,
                  id: followUpId,
                  budgetGate: (await loadBudgetState(budgetFile, store, existing.ownerId)).gate,
                  onTerminal: buildTerminalHook(
                    existing.orchestrationName,
                    ctx.orchestration,
                    existing.ownerId,
                  ),
                  divergence: ctx.orchestration.notify?.divergence,
                  buildEventSource: (signal, replayOutputs, autoApproveLocks, _gms, runId, waits, inputs) =>
                    buildExecutorSource(
                      ctx,
                      {
                        initialInput: existing.initialInput ?? undefined,
                        allowAgentTools: true,
                        replayOutputs,
                        autoApproveLocks,
                        ownerId: existing.ownerId,
                        runId,
                        pendingWaits: waits.pendingWaits,
                        deliveredSignals: waits.deliveredSignals,
                        resolvedInputs: inputs,
                      },
                      signal,
                    ),
                });
                if (!result.ok) {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.internalError,
                      result.reason,
                    ),
                  );
                }
                if (rpc.method === 'message/send') {
                  const reread = await store.getRun(followUpId, rpcOwnerId);
                  return sendJson(
                    res,
                    200,
                    jsonRpcResult(
                      rpcId,
                      reread ? buildTaskFromRun(reread) : null,
                    ),
                  );
                }
                return streamA2aRun(req, res, rpcId, followUpId);
              }

              // A server state file is never an orchestration — see
              // `namesServerStateFile`; the answer is the one a missing file
              // gets.
              const ctx = (await namesServerStateFile(name))
                ? null
                : await loadRunContext(name);
              if (!ctx) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.invalidParams,
                    `Orchestration not found: ${name}`,
                  ),
                );
              }
              const text = messageText();
              // Receiver-side idempotency: a repeated message/send carrying
              // the same metadata.idempotencyKey returns the EXISTING task
              // instead of starting a duplicate run. Checked BEFORE the
              // budget gate — a dedupe hit starts nothing, so it shouldn't
              // be refused for spend. Per-process cache (see
              // a2a-idempotency.ts for the honest scope).
              const a2aMeta = (params as { metadata?: Record<string, unknown> })
                .metadata;
              const idemKey =
                a2aMeta && typeof a2aMeta.idempotencyKey === 'string'
                  ? a2aMeta.idempotencyKey
                  : null;
              if (idemKey) {
                const priorId = a2aIdempotency.get(name, idemKey);
                if (priorId) {
                  // Scoped: another owner replaying the same key gets no
                  // dedupe hit (and so no view of this owner's task).
                  const prior = await store.getRun(priorId, rpcOwnerId);
                  if (prior) {
                    if (rpc.method === 'message/send') {
                      return sendJson(
                        res,
                        200,
                        jsonRpcResult(rpcId, buildTaskFromRun(prior)),
                      );
                    }
                    return streamA2aRun(req, res, rpcId, priorId);
                  }
                }
              }
              // Budget pre-flight — A2A is a run entry point like the
              // UI's Run button, so it gets the same spend gate.
              const { status: budgetStatus, gate: budgetGate } =
                await loadBudgetState(budgetFile, store, extractOwnerId(req));
              if (budgetStatus.blocked) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.internalError,
                    budgetBlockedMessage(budgetStatus),
                  ),
                );
              }
              const a2aOwnerId = rpcOwnerId;
              const { id } = await startServerRun({
                store,
                orchestrationName: name,
                initialInput: text,
                orchestrationSnapshot: ctx.orchestration,
                budgetGate,
                ownerId: a2aOwnerId,
                onTerminal: buildTerminalHook(
                  name,
                  ctx.orchestration,
                  a2aOwnerId,
                ),
                buildEventSource: (signal, runId) =>
                  buildExecutorSource(
                    ctx,
                    { initialInput: text, ownerId: a2aOwnerId, runId },
                    signal,
                  ),
              });
              if (idemKey) a2aIdempotency.record(name, idemKey, id);
              if (rpc.method === 'message/send') {
                const run = await store.getRun(id, rpcOwnerId);
                return sendJson(
                  res,
                  200,
                  jsonRpcResult(
                    rpcId,
                    run
                      ? buildTaskFromRun(run)
                      : {
                          id,
                          contextId: id,
                          status: { state: 'submitted' },
                          kind: 'task',
                        },
                  ),
                );
              }
              return streamA2aRun(req, res, rpcId, id);
            }

            if (rpc.method === 'tasks/get') {
              const id = taskIdParam();
              if (!id || !isSafeName(id)) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.invalidParams,
                    'tasks/get requires a valid task id',
                  ),
                );
              }
              const run = await store.getRun(id, rpcOwnerId);
              if (!run) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task not found: ${id}`,
                  ),
                );
              }
              return sendJson(
                res,
                200,
                jsonRpcResult(rpcId, buildTaskFromRun(run)),
              );
            }

            if (rpc.method === 'tasks/cancel') {
              const id = taskIdParam();
              if (!id || !isSafeName(id)) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.invalidParams,
                    'tasks/cancel requires a valid task id',
                  ),
                );
              }
              const run = await store.getRun(id, rpcOwnerId);
              if (!run) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task not found: ${id}`,
                  ),
                );
              }
              // Mirror the REST route: a controller live in this process
              // aborts in-process; anything else — a task paused at a gate,
              // interrupted, or a peer's — takes the store path. This used
              // to call `cancelServerRun` alone and ignore its `false`, so a
              // paused task "cancelled" over A2A stayed paused while the
              // caller was told it succeeded.
              if (!cancelServerRun(id)) {
                const out = await cancelStoredRunAndDrain(id);
                if (out.outcome === 'already-terminal') {
                  return sendJson(
                    res,
                    200,
                    jsonRpcError(
                      rpcId,
                      A2A_TASK_NOT_CANCELABLE,
                      `Task ${id} is already ${out.status} and cannot be cancelled`,
                    ),
                  );
                }
              }
              const after = await store.getRun(id, rpcOwnerId) ?? run;
              return sendJson(
                res,
                200,
                jsonRpcResult(rpcId, buildTaskFromRun(after)),
              );
            }

            if (rpc.method === 'tasks/resubscribe') {
              const id = taskIdParam();
              if (!id || !isSafeName(id) || !await store.getRun(id, rpcOwnerId)) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task not found: ${id}`,
                  ),
                );
              }
              return streamA2aRun(req, res, rpcId, id);
            }

            // A2A push-notification config — register a webhook URL on
            // the live run. In-memory only; lost on process restart.
            //
            // The run-controller POSTs EVERY event of the run — phase output
            // included — to this URL. Unscoped, any caller could register a
            // URL of their choosing on any live run and receive its output;
            // scoped, the owner could still point their own run's output at
            // an arbitrary host from the server's network position. So two
            // checks, in this order: the task must be the caller's (else
            // "task not found" — ownership before anything that would reveal
            // the id exists), and the URL's host must be in
            // SAMMY_NOTIFY_ALLOWED_HOSTS (empty = refuse all, said so).
            if (rpc.method === 'tasks/pushNotificationConfig/set') {
              const id = taskIdParam();
              const cfg = params.pushNotificationConfig as
                | { url?: string }
                | undefined;
              if (!id || !isSafeName(id) || !cfg?.url) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.invalidParams,
                    'pushNotificationConfig.url required + valid taskId',
                  ),
                );
              }
              if (!(await store.getRun(id, rpcOwnerId))) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task not found: ${id}`,
                  ),
                );
              }
              const refusal = pushUrlRefusal(cfg.url);
              if (refusal) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(rpcId, A2A_ERROR.invalidParams, refusal),
                );
              }
              const ok = setPushNotification(id, cfg.url);
              if (!ok) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task ${id} is not currently active — push config is a live-run feature.`,
                  ),
                );
              }
              return sendJson(
                res,
                200,
                jsonRpcResult(rpcId, {
                  taskId: id,
                  pushNotificationConfig: { url: cfg.url },
                }),
              );
            }

            if (rpc.method === 'tasks/pushNotificationConfig/get') {
              const id = taskIdParam();
              if (!id || !isSafeName(id)) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.invalidParams,
                    'tasks/pushNotificationConfig/get requires a valid id',
                  ),
                );
              }
              if (!(await store.getRun(id, rpcOwnerId))) {
                return sendJson(
                  res,
                  200,
                  jsonRpcError(
                    rpcId,
                    A2A_ERROR.taskNotFound,
                    `Task not found: ${id}`,
                  ),
                );
              }
              const url = getPushNotification(id);
              return sendJson(
                res,
                200,
                jsonRpcResult(rpcId, {
                  taskId: id,
                  pushNotificationConfig: url ? { url } : null,
                }),
              );
            }

            return sendJson(
              res,
              200,
              jsonRpcError(
                rpcId,
                A2A_ERROR.methodNotFound,
                `Unknown A2A method: ${rpc.method}`,
              ),
            );
          }

          return sendError(res, 404, 'A2A: not found');
        } catch (err) {
          console.error('[sammy-pack-api] a2a error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/mcp-servers
      // Lists the workspace's configured MCP servers. Returns the config
      // map with secret-looking values MASKED: any string under a key
      // matching the vocabulary scrub-secrets.ts and credentials-store.ts
      // share (`SECRET_NAME_SHAPE`), any `${connections:…}` reference, and
      // any VALUE that looks like a secret regardless of its key — a known
      // token prefix, a URL carrying a password, an argv `--token=…` /
      // `--api-key <next>` pair — comes back in `maskSecret` form (a
      // bounded prefix + the last 2, or a fixed placeholder when short).
      // It used to return env / headers as-is on
      // the reasoning that this is a localhost-only dev server — the same
      // server is the documented shared deployment, where that was a
      // one-GET dump of every MCP secret. The source of truth lives in
      // mcp/servers.json on disk. Body: none.
      // Returns: Record<string, McpServerConfig> (masked).
      //
      // PUT /api/mcp-servers
      // Writes the entire registry. Body must be a JSON object
      // (Record<string, McpServerConfig>); arrays / null / non-objects
      // are refused. Masked values the client echoed back (the UI PUTs
      // what GET returned) are restored from the on-disk registry before
      // the write, exactly as /api/credentials reconciles — otherwise
      // masking GET would have made every save corrupt the file. Atomically
      // replaces the file's contents; the echo is masked like GET.
      server.middlewares.use('/api/mcp-servers', async (req, res) => {
        try {
          const method = req.method ?? 'GET';
          if (method === 'GET') {
            const registry = await loadMcpRegistry();
            return sendJson(res, 200, maskSecretsDeep(registry));
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return sendError(res, 400, 'Body must be a JSON object');
            }
            const reconciled = reconcileMaskedDeep(parsed, await loadMcpRegistry());
            await fs.mkdir(path.dirname(mcpRegistryFile), { recursive: true });
            await fs.writeFile(
              mcpRegistryFile,
              JSON.stringify(reconciled, null, 2) + '\n',
              'utf8',
            );
            return sendJson(res, 200, maskSecretsDeep(reconciled));
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] mcp-servers error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // ─── Subprocess-spawning reads: bounded, like every other lever ───
      //
      // `GET /api/versions` and `GET /api/mcp-servers/status` are the only two
      // reads that spawn child processes, and they were the only
      // unauthenticated levers in this file with no ceiling — body bytes, poll
      // body bytes, poll timeout, run-list limit, retention batch and queue
      // depth all have one. Both are GETs, so a `read`-role identity reaches
      // them in every posture and an anonymous caller does under the
      // reads-open default, and a burst fanned out into unbounded concurrent
      // `git log` / `which` children each buffering into a string.
      //
      // Two bounds, deliberately separate: a per-process ceiling on how many
      // of these requests may be in flight (shed with a 503 naming the lever,
      // the way the queue cap sheds with a 429) and a wall-clock + output cap
      // on each child, so one wedged `git` cannot hold a slot forever.
      // The timeout and the output cap are env levers for the same reason the
      // in-flight ceiling is: a bound nothing can set to a testable value is
      // a bound nobody has measured, because no test can pin a constant it
      // cannot vary.
      const MAX_SPAWNING_READS = envPositiveInt('SAMMY_MAX_SPAWNING_READS', 4);
      const SPAWN_TIMEOUT_MS = envPositiveInt('SAMMY_SPAWN_TIMEOUT_MS', 10_000);
      const SPAWN_MAX_STDOUT = envPositiveInt(
        'SAMMY_SPAWN_MAX_STDOUT',
        4 * 1024 * 1024,
      );
      let spawningReadsInFlight = 0;
      /** Take a slot or refuse. Returns the release fn, or null when full. */
      const takeSpawnSlot = (
        res: import('node:http').ServerResponse,
      ): (() => void) | null => {
        if (spawningReadsInFlight >= MAX_SPAWNING_READS) {
          sendError(
            res,
            503,
            `Too many concurrent version / status reads (${MAX_SPAWNING_READS} ` +
              'in flight). These spawn child processes, so they are capped — ' +
              'retry, or raise SAMMY_MAX_SPAWNING_READS.',
          );
          return null;
        }
        spawningReadsInFlight += 1;
        let freed = false;
        return () => {
          if (freed) return;
          freed = true;
          spawningReadsInFlight -= 1;
        };
      };

      // GET /api/versions/:scope/:name              → list of commits touching this file
      // GET /api/versions/:scope/:name/:sha         → file content at a specific commit
      //
      // scope is 'agents' (foo → agents/foo.md) or 'examples'
      // (foo → examples/foo.json). Both shell out to `git log` and
      // `git show` against the repo root; safe because `name` is
      // validated with isSafeName and sha with a strict regex, and
      // args are passed as an array (no shell interpretation).
      server.middlewares.use('/api/versions', async (req, res) => {
        const freeSlot = req.method === 'GET' ? takeSpawnSlot(res) : () => {};
        if (!freeSlot) return;
        try {
          if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const scope = segs[0];
          const name = segs[1];
          const sha = segs[2];

          const scopeMap: Record<string, { dir: string; ext: string }> = {
            agents: { dir: 'agents', ext: '.md' },
            examples: { dir: 'examples', ext: '.json' },
          };
          const scopeCfg = scopeMap[scope];
          if (!scopeCfg) return sendError(res, 400, 'Invalid scope (agents | examples)');
          if (!name || !isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const relPath = `${scopeCfg.dir}/${name}${scopeCfg.ext}`;

          // Bounded in time AND in output: a `git log` on a pathological
          // history (or a `git show` of a huge blob) otherwise ran for as long
          // as it liked, accumulating stdout into a string with no ceiling.
          // A timeout or an over-long output is reported as a non-zero code,
          // which every caller below already turns into an error response.
          function runGit(args: string[]): Promise<{ stdout: string; code: number }> {
            return new Promise(resolve => {
              const proc = spawn('git', args, {
                cwd: root,
                timeout: SPAWN_TIMEOUT_MS,
              });
              let stdout = '';
              let overflowed = false;
              proc.stdout.on('data', d => {
                if (overflowed) return;
                stdout += d.toString();
                if (stdout.length > SPAWN_MAX_STDOUT) {
                  overflowed = true;
                  proc.kill('SIGKILL');
                }
              });
              proc.on('error', () => resolve({ stdout: '', code: 1 }));
              proc.on('close', (code, signal) =>
                resolve({
                  stdout: overflowed ? '' : stdout,
                  // A child a SIGNAL ended — the `timeout` above, or the
                  // overflow kill — exits with a null code, and `?? 0` read
                  // that as success: the bound fired and the caller was
                  // answered 200 with an empty commit list, i.e. "this file
                  // has no history", for a `git log` that never ran. A
                  // signalled child is a failure.
                  code: overflowed || signal !== null ? 1 : (code ?? 0),
                }),
              );
            });
          }

          if (!sha) {
            // List commits touching this file.
            const { stdout, code } = await runGit([
              'log',
              '--max-count=50',
              '--pretty=format:%H%ad%an%s',
              '--date=iso',
              '--',
              relPath,
            ]);
            if (code !== 0) return sendError(res, 500, 'git log failed');
            const commits = stdout
              .split('\n')
              .filter(Boolean)
              .map(line => {
                const [sha, date, author, ...rest] = line.split('');
                return {
                  sha,
                  date,
                  author,
                  message: rest.join('') /* in case message contained sep */,
                };
              });
            return sendJson(res, 200, commits);
          }

          // Validate sha (lowercase hex, 7..40 chars).
          if (!/^[0-9a-f]{7,40}$/.test(sha)) {
            return sendError(res, 400, 'Invalid sha');
          }
          const { stdout, code } = await runGit(['show', `${sha}:${relPath}`]);
          if (code !== 0) return sendError(res, 404, 'Commit/path not found at sha');
          return sendJson(res, 200, { sha, content: stdout });
        } catch (err) {
          console.error('[sammy-pack-api] versions error:', err);
          return sendError(res, 500, (err as Error).message);
        } finally {
          freeSlot();
        }
      });

      // GET /api/mcp-servers/status
      // Quick reachability check for every configured MCP server. Doesn't
      // do a full MCP handshake — that requires keeping a long-lived
      // process around, which our dev-server topology doesn't justify.
      // Instead:
      //   - stdio  → run `which <command>`; ok if exit 0 (binary on PATH).
      //   - http   → fetch HEAD with 3s timeout; ok if status < 500.
      //   - sse    → same as http.
      //   - sdk    → reported as 'unknown' (in-process; trust the SDK).
      //
      // Returns: Array<{ name, kind, status: 'ok'|'unreachable'|'unknown', message? }>
      server.middlewares.use('/api/mcp-servers/status', async (req, res) => {
        // Same cap as /api/versions: one request spawns a `which` per stdio
        // entry in the registry, so the fan-out is the registry's size times
        // however many requests arrive at once.
        const freeSlot = req.method === 'GET' ? takeSpawnSlot(res) : () => {};
        if (!freeSlot) return;
        try {
          if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const registry = await loadMcpRegistry();
          type StatusRow = {
            name: string;
            kind: string;
            status: 'ok' | 'unreachable' | 'unknown';
            message?: string;
          };
          const rows: StatusRow[] = [];
          for (const [name, raw] of Object.entries(registry)) {
            const cfg = raw as { type?: string; command?: string; url?: string };
            const kind = cfg.type ?? 'stdio';
            if (kind === 'stdio') {
              const cmd = cfg.command ?? '';
              if (!cmd) {
                rows.push({ name, kind, status: 'unreachable', message: 'no command' });
                continue;
              }
              const ok = await new Promise<boolean>(resolve => {
                const which = spawn('which', [cmd]);
                let done = false;
                const t = setTimeout(() => {
                  if (done) return;
                  done = true;
                  which.kill('SIGTERM');
                  resolve(false);
                }, 3000);
                which.on('close', code => {
                  if (done) return;
                  done = true;
                  clearTimeout(t);
                  resolve(code === 0);
                });
              });
              rows.push({
                name,
                kind,
                status: ok ? 'ok' : 'unreachable',
                message: ok ? undefined : `command "${cmd}" not on PATH`,
              });
            } else if (kind === 'http' || kind === 'sse') {
              const url = cfg.url ?? '';
              if (!url) {
                rows.push({ name, kind, status: 'unreachable', message: 'no url' });
                continue;
              }
              try {
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), 3000);
                const r = await fetch(url, {
                  method: 'HEAD',
                  // Node's fetch types vs DOM AbortSignal — runtime fine, types
                  // disagree across vite/node DOM lib boundaries. Cast.
                  signal: controller.signal as unknown as undefined,
                });
                clearTimeout(t);
                rows.push({
                  name,
                  kind,
                  status: r.status < 500 ? 'ok' : 'unreachable',
                  message: `${r.status} ${r.statusText}`,
                });
              } catch (err) {
                rows.push({
                  name,
                  kind,
                  status: 'unreachable',
                  message: (err as Error).message,
                });
              }
            } else {
              rows.push({ name, kind, status: 'unknown', message: 'in-process' });
            }
          }
          return sendJson(res, 200, rows);
        } catch (err) {
          console.error('[sammy-pack-api] mcp status error:', err);
          return sendError(res, 500, (err as Error).message);
        } finally {
          freeSlot();
        }
      });

      // GET /api/observability
      // Aggregates stats from runs/*.json into a digest the
      // Observability page renders. Server-side aggregation so the
      // browser doesn't have to load + walk every run JSON file —
      // important once a workspace has hundreds of runs.
      //
      // Returns:
      //   {
      //     totals: { runs, done, error, cancelled, inputTokens, outputTokens, costUsd },
      //     perOrchestration: [{
      //       name, runCount, doneCount, errorCount, cancelledCount,
      //       avgDurationMs, inputTokens, outputTokens, costUsd, lastRanAt
      //     }],
      //     daily: [{ day: 'YYYY-MM-DD', runCount, doneCount, errorCount, costUsd }],
      //     recent: [{ id, orchestrationName, status, startedAt, durationMs }],
      //   }
      server.middlewares.use('/api/observability', async (req, res) => {
        try {
          if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
          type Run = {
            id?: string;
            orchestrationName?: string;
            startedAt?: number;
            endedAt?: number;
            status?: string;
            events?: Array<{ type?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }>;
          };
          // Pull from the run store. Each row needs its events to aggregate
          // token + cost totals, so we hydrate — but SEQUENTIALLY, one run's
          // events at a time, so only a single run's event log is resident at
          // once. The old code Promise.all'd getRun across every row, holding
          // EVERY run's full events (800–1300 each) in memory simultaneously —
          // multi-GB, the same OOM class that took down /api/runs. Capped at
          // MAX_DIGEST_RUNS (most-recent-first) so an ever-growing workspace
          // can't unbound the sweep. Scoped to the requesting user.
          const headers = await store.listRuns(
            MAX_DIGEST_RUNS,
            extractOwnerId(req),
          );

          const totals = { runs: 0, done: 0, error: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
          const perOrch = new Map<string, {
            name: string;
            runCount: number;
            doneCount: number;
            errorCount: number;
            cancelledCount: number;
            durationsMs: number[];
            inputTokens: number;
            outputTokens: number;
            costUsd: number;
            lastRanAt: number;
          }>();
          const dayMap = new Map<string, {
            day: string;
            runCount: number;
            doneCount: number;
            errorCount: number;
            costUsd: number;
          }>();
          const recent: Array<{ id: string; orchestrationName: string; status: string; startedAt: number; durationMs?: number }> = [];

          // Per-phase rollup — for each (orchestrationName, phaseName)
          // pair, track call count, error count, total cost, durations.
          // Sorted by total cost descending so "expensive phase" rises.
          type PhaseAgg = {
            orchestration: string;
            phaseName: string;
            runs: number;
            errors: number;
            durationsMs: number[];
            inputTokens: number;
            outputTokens: number;
            costUsd: number;
          };
          const phaseMap = new Map<string, PhaseAgg>();
          // Branch coverage: for each (orchestration, switch/route phase),
          // tally how often each branch/case was actually taken across history.
          // The frontend cross-references this with the declared branches to
          // surface never-taken (dead) branches. Driven by `route-decision`
          // events, which both `route` and `switch` emit.
          const branchMap = new Map<string, Map<string, number>>();

          // ONE sequential pass per run: hydrate its events, fold them into
          // every aggregate, then let the reference fall out of scope so the
          // GC reclaims it before the next run is fetched. The run-level and
          // phase-level rollups (previously two passes over a fully-
          // materialized array of EVERY run's events) now share this loop, so
          // peak memory is one run's event log, not all of them at once.
          for (const h of headers) {
            if (!h.id || !h.orchestrationName || !h.startedAt) continue;
            const full = await store.getRun(h.id);
            const events = (full?.events ?? []) as Run['events'];
            const orchestrationName = h.orchestrationName;
            const startedAt = h.startedAt;
            const status = h.status ?? 'unknown';
            const durationMs =
              h.endedAt && h.startedAt ? h.endedAt - h.startedAt : undefined;
            // `lib/spend` is the one definition of what an event stream
            // spent — the caps, `sumCostUsd`, /api/cost and the run card all
            // read it, so this digest cannot drift from the 402 again.
            const { inputTokens, outputTokens, costUsd } = foldSpend(events ?? []);

            totals.runs += 1;
            if (status === 'done') totals.done += 1;
            else if (status === 'error') totals.error += 1;
            else if (status === 'cancelled') totals.cancelled += 1;
            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
            totals.costUsd += costUsd;

            const orch = perOrch.get(orchestrationName) ?? {
              name: orchestrationName,
              runCount: 0,
              doneCount: 0,
              errorCount: 0,
              cancelledCount: 0,
              durationsMs: [],
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              lastRanAt: 0,
            };
            orch.runCount += 1;
            if (status === 'done') orch.doneCount += 1;
            else if (status === 'error') orch.errorCount += 1;
            else if (status === 'cancelled') orch.cancelledCount += 1;
            if (durationMs != null) orch.durationsMs.push(durationMs);
            orch.inputTokens += inputTokens;
            orch.outputTokens += outputTokens;
            orch.costUsd += costUsd;
            orch.lastRanAt = Math.max(orch.lastRanAt, startedAt);
            perOrch.set(orchestrationName, orch);

            const day = new Date(startedAt).toISOString().slice(0, 10);
            const bucket = dayMap.get(day) ?? { day, runCount: 0, doneCount: 0, errorCount: 0, costUsd: 0 };
            bucket.runCount += 1;
            if (status === 'done') bucket.doneCount += 1;
            if (status === 'error') bucket.errorCount += 1;
            bucket.costUsd += costUsd;
            dayMap.set(day, bucket);

            recent.push({
              id: h.id,
              orchestrationName,
              status,
              startedAt,
              durationMs,
            });

            // Phase-level + branch-coverage rollup over the SAME run's events.
            for (const ev of events ?? []) {
              const e = ev as {
                type?: string;
                phaseName?: string;
                branch?: string;
                inputTokens?: number;
                outputTokens?: number;
                costUsd?: number;
                durationMs?: number;
              };
              if (e.type === 'route-decision' && e.phaseName && e.branch) {
                const key = `${orchestrationName}::${e.phaseName}`;
                const counts = branchMap.get(key) ?? new Map<string, number>();
                counts.set(e.branch, (counts.get(e.branch) ?? 0) + 1);
                branchMap.set(key, counts);
              }
              if (e.type === 'phase-end' && e.phaseName) {
                const key = `${orchestrationName}::${e.phaseName}`;
                const p = phaseMap.get(key) ?? {
                  orchestration: orchestrationName,
                  phaseName: e.phaseName,
                  runs: 0,
                  errors: 0,
                  durationsMs: [],
                  inputTokens: 0,
                  outputTokens: 0,
                  costUsd: 0,
                };
                p.runs += 1;
                if (e.durationMs != null) p.durationsMs.push(e.durationMs);
                p.inputTokens += e.inputTokens ?? 0;
                p.outputTokens += e.outputTokens ?? 0;
                p.costUsd += e.costUsd ?? 0;
                phaseMap.set(key, p);
              } else if (e.type === 'phase-error' && e.phaseName) {
                const key = `${orchestrationName}::${e.phaseName}`;
                const p = phaseMap.get(key) ?? {
                  orchestration: orchestrationName,
                  phaseName: e.phaseName,
                  runs: 0,
                  errors: 0,
                  durationsMs: [],
                  inputTokens: 0,
                  outputTokens: 0,
                  costUsd: 0,
                };
                p.errors += 1;
                // A failed attempt spent what it spent — `lib/spend` says so,
                // and the run-level totals in this same response charge it.
                // Counting it in `errors` but not in `costUsd` made the
                // per-phase column fail to add up to the totals beside it.
                p.inputTokens += e.inputTokens ?? 0;
                p.outputTokens += e.outputTokens ?? 0;
                p.costUsd += e.costUsd ?? 0;
                phaseMap.set(key, p);
              }
            }
          }
          function percentile(arr: number[], p: number): number {
            if (arr.length === 0) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.min(
              sorted.length - 1,
              Math.floor((sorted.length - 1) * p),
            );
            return sorted[idx];
          }
          const perPhase = Array.from(phaseMap.values())
            .map(p => ({
              orchestration: p.orchestration,
              phaseName: p.phaseName,
              runs: p.runs,
              errors: p.errors,
              avgDurationMs:
                p.durationsMs.length > 0
                  ? Math.round(
                      p.durationsMs.reduce((a, b) => a + b, 0) / p.durationsMs.length,
                    )
                  : 0,
              p95DurationMs: Math.round(percentile(p.durationsMs, 0.95)),
              inputTokens: p.inputTokens,
              outputTokens: p.outputTokens,
              costUsd: p.costUsd,
            }))
            .sort((a, b) => b.costUsd - a.costUsd);

          const perOrchestration = Array.from(perOrch.values())
            .map(o => ({
              name: o.name,
              runCount: o.runCount,
              doneCount: o.doneCount,
              errorCount: o.errorCount,
              cancelledCount: o.cancelledCount,
              avgDurationMs:
                o.durationsMs.length > 0
                  ? Math.round(
                      o.durationsMs.reduce((a, b) => a + b, 0) / o.durationsMs.length,
                    )
                  : 0,
              inputTokens: o.inputTokens,
              outputTokens: o.outputTokens,
              costUsd: o.costUsd,
              lastRanAt: o.lastRanAt,
            }))
            .sort((a, b) => b.lastRanAt - a.lastRanAt);

          const daily = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

          recent.sort((a, b) => b.startedAt - a.startedAt);
          const recentTrimmed = recent.slice(0, 30);

          const branchCoverage = Array.from(branchMap.entries())
            .map(([key, counts]) => {
              const [orchestration, phaseName] = key.split('::');
              const taken = Array.from(counts.entries())
                .map(([branch, count]) => ({ branch, count }))
                .sort((a, b) => b.count - a.count);
              return { orchestration, phaseName, taken };
            })
            .sort((a, b) => a.orchestration.localeCompare(b.orchestration));

          return sendJson(res, 200, {
            totals,
            perOrchestration,
            perPhase,
            daily,
            recent: recentTrimmed,
            branchCoverage,
          });
        } catch (err) {
          console.error('[sammy-pack-api] observability error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/cost
      // Token & cost dashboard digest. Server-side aggregation (same
      // rationale as /api/observability — don't ship every run's full
      // event log to the browser). Owner-scoped.
      //
      // Returns:
      //   {
      //     spend: { todayUsd, monthUsd },     // from store.costSummary()
      //     totals: { runs, inputTokens, outputTokens, costUsd },
      //     perRun: [{
      //       id, orchestrationName, status, startedAt, endedAt,
      //       inputTokens, outputTokens, costUsd, ceilingTrips
      //     }],
      //     perPhase: { [runId]: [{
      //       phaseName, agentPath, inputTokens, outputTokens, costUsd,
      //       durationMs, aborted
      //     }] },
      //     ceilingTrips: [{ runId, orchestrationName, phaseName, approxTokens }],
      //   }
      //
      // `aborted` / `ceilingTrips` are derived from the SDK circuit-breaker
      // marker ("[token-ceiling]") the sdk-stream emits as a text-delta when
      // it aborts a runaway agent — it lands in the phase's streamed text
      // (phase-delta) and in the final phase-end output, so we scan both.
      server.middlewares.use('/api/cost', async (req, res) => {
        try {
          if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

          // Top-line today/month spend — already bucketed by the store, and
          // scoped to the caller like the per-run rows below (an unscoped
          // read here put the whole workspace's spend under a heading that
          // said "Owner-scoped").
          const spend = await store.costSummary(extractOwnerId(req));

          type Ev = {
            type?: string;
            phaseName?: string;
            agentPath?: string;
            output?: string;
            text?: string;
            inputTokens?: number;
            outputTokens?: number;
            costUsd?: number;
            durationMs?: number;
          };
          const CEILING = '[token-ceiling]';
          // Pull ~k-tokens out of the ceiling message for the callout —
          // sdk-stream formats it as "stopped after ~NNNk tokens" (older
          // runs said "aborted after"; match either verb so historical
          // events still parse).
          const approxTokensFrom = (s: string): number | undefined => {
            const m = /(?:stopped|aborted) after ~(\d+)k tokens/.exec(s);
            return m ? Number(m[1]) * 1000 : undefined;
          };

          // Bounded + hydrated SEQUENTIALLY (one run's events resident at a
          // time) — same OOM-avoidance as /api/observability. The old
          // Promise.all held every run's full event log at once.
          const headers = await store.listRuns(
            MAX_DIGEST_RUNS,
            extractOwnerId(req),
          );

          const totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
          type PerRun = {
            id: string;
            orchestrationName: string;
            status: string;
            startedAt: number;
            endedAt: number | null;
            inputTokens: number;
            outputTokens: number;
            costUsd: number;
            ceilingTrips: number;
          };
          const perRun: PerRun[] = [];
          const perPhase: Record<
            string,
            Array<{
              phaseName: string;
              agentPath?: string;
              inputTokens: number;
              outputTokens: number;
              costUsd: number;
              durationMs?: number;
              aborted: boolean;
              /** The attempt ENDED in an error (a `phase-error`). Its spend
               *  counts — the caps charge it — so the row exists; the flag is
               *  what lets the UI say why a phase appears more than once. */
              failed?: boolean;
            }>
          > = {};
          const ceilingTrips: Array<{
            runId: string;
            orchestrationName: string;
            phaseName: string;
            approxTokens?: number;
          }> = [];

          for (const h of headers) {
            const full = await store.getRun(h.id);
            const events = (full?.events ?? []) as Ev[];

            // Which leaf phases carry an agentPath (set on phase-start) —
            // lets us label each phase with the agent that ran it.
            const agentPathByPhase = new Map<string, string>();
            for (const e of events) {
              if (
                e.type === 'phase-start' &&
                typeof e.agentPath === 'string' &&
                e.phaseName
              ) {
                agentPathByPhase.set(e.phaseName, e.agentPath);
              }
            }

            // Phases whose streamed text or final output contains the
            // circuit-breaker marker — these are the aborted runaways.
            const abortedPhases = new Set<string>();
            const tripApproxByPhase = new Map<string, number | undefined>();
            for (const e of events) {
              const body =
                e.type === 'phase-end'
                  ? e.output
                  : e.type === 'phase-delta'
                    ? e.text
                    : undefined;
              if (e.phaseName && typeof body === 'string' && body.includes(CEILING)) {
                abortedPhases.add(e.phaseName);
                const approx = approxTokensFrom(body);
                if (approx != null && !tripApproxByPhase.has(e.phaseName)) {
                  tripApproxByPhase.set(e.phaseName, approx);
                } else if (!tripApproxByPhase.has(e.phaseName)) {
                  tripApproxByPhase.set(e.phaseName, undefined);
                }
              }
            }

            // One definition of spend (`lib/spend`), folded in the loop this
            // route already walks for its per-phase rows. Folding only
            // phase-end made this digest disagree with the caps and the 402
            // by exactly what the retried attempts spent.
            const { inputTokens, outputTokens, costUsd } = foldSpend(events);
            const phaseRows: NonNullable<(typeof perPhase)[string]> = [];
            for (const e of events) {
              if (isSpendEvent(e) && e.phaseName) {
                phaseRows.push({
                  phaseName: e.phaseName,
                  agentPath: agentPathByPhase.get(e.phaseName),
                  inputTokens: e.inputTokens ?? 0,
                  outputTokens: e.outputTokens ?? 0,
                  costUsd: e.costUsd ?? 0,
                  durationMs: e.durationMs,
                  aborted: abortedPhases.has(e.phaseName),
                  failed: e.type === 'phase-error' || undefined,
                });
              }
            }
            // An aborted agent may never reach a phase-end (the abort throws
            // out of the loop) — surface those as a phase row too so the
            // runaway is visible even with no token/cost recorded.
            for (const name of abortedPhases) {
              if (!phaseRows.some(p => p.phaseName === name)) {
                phaseRows.push({
                  phaseName: name,
                  agentPath: agentPathByPhase.get(name),
                  inputTokens: 0,
                  outputTokens: 0,
                  costUsd: 0,
                  aborted: true,
                });
              }
            }

            // Most-expensive phase first within a run.
            phaseRows.sort((a, b) => b.costUsd - a.costUsd);
            perPhase[h.id] = phaseRows;

            totals.runs += 1;
            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
            totals.costUsd += costUsd;

            perRun.push({
              id: h.id,
              orchestrationName: h.orchestrationName,
              status: h.status,
              startedAt: h.startedAt,
              endedAt: h.endedAt,
              inputTokens,
              outputTokens,
              costUsd,
              ceilingTrips: abortedPhases.size,
            });

            for (const name of abortedPhases) {
              ceilingTrips.push({
                runId: h.id,
                orchestrationName: h.orchestrationName,
                phaseName: name,
                approxTokens: tripApproxByPhase.get(name),
              });
            }
          }

          // Most-expensive run first — the useful default sort.
          perRun.sort((a, b) => b.costUsd - a.costUsd);

          return sendJson(res, 200, {
            spend,
            totals,
            perRun,
            perPhase,
            ceilingTrips,
          });
        } catch (err) {
          console.error('[sammy-pack-api] cost error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/hooks               → load hooks/hooks.json
      // PUT /api/hooks               → overwrite the registry
      // Same model as /api/mcp-servers: localhost-only dev tool, full
      // configs travel over the wire. Body for PUT must be a JSON
      // object keyed by hook name.
      server.middlewares.use('/api/hooks', async (req, res) => {
        try {
          const method = req.method ?? 'GET';
          if (method === 'GET') {
            const registry = await loadHooksRegistry();
            return sendJson(res, 200, registry);
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return sendError(res, 400, 'Body must be a JSON object');
            }
            await fs.mkdir(path.dirname(hooksRegistryFile), { recursive: true });
            await fs.writeFile(
              hooksRegistryFile,
              JSON.stringify(parsed, null, 2) + '\n',
              'utf8',
            );
            return sendJson(res, 200, parsed);
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] hooks error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET /api/schemas                  → list of { name, content } from schema/
      // GET /api/schemas/:name            → one schema (raw JSON)
      // Read-only: schemas live in git and are edited there. UI is
      // a viewer, not an editor.
      const schemaDir = path.join(root, 'schema');
      server.middlewares.use('/api/schemas', async (req, res) => {
        try {
          if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];

          if (!name) {
            const entries = await fs.readdir(schemaDir).catch(() => [] as string[]);
            const out: Array<{ name: string; content: unknown }> = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const parsed = await readJsonFile(path.join(schemaDir, f));
              if (parsed !== null) {
                out.push({ name: f.replace(/\.json$/, ''), content: parsed });
              }
            }
            return sendJson(res, 200, out);
          }
          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(schemaDir, `${name}.json`);
          const parsed = await readJsonFile(file);
          if (parsed === null) return sendError(res, 404, 'Not found');
          return sendJson(res, 200, { name, content: parsed });
        } catch (err) {
          console.error('[sammy-pack-api] schemas error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });

      // GET    /api/workspaces            → list context/*.json
      // GET    /api/workspaces/:name      → one workspace
      // PUT    /api/workspaces/:name      → write
      // DELETE /api/workspaces/:name      → remove
      // Same file-backed CRUD shape as /api/orchestrations.
      server.middlewares.use('/api/workspaces', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const segs = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
          const name = segs[0];
          const method = req.method ?? 'GET';

          if (!name) {
            if (method !== 'GET') return sendError(res, 405, 'Method not allowed');
            const entries = await fs.readdir(contextDir).catch(() => [] as string[]);
            const out: Json[] = [];
            for (const f of entries) {
              if (!f.endsWith('.json')) continue;
              const parsed = await readJsonFile(path.join(contextDir, f));
              if (parsed) out.push(parsed);
            }
            return sendJson(res, 200, out);
          }

          if (!isSafeName(name)) return sendError(res, 400, 'Invalid name');
          const file = path.join(contextDir, `${name}.json`);

          if (method === 'GET') {
            const parsed = await readJsonFile(file);
            if (parsed === null) return sendError(res, 404, 'Not found');
            return sendJson(res, 200, parsed);
          }
          if (method === 'PUT') {
            const body = await readBody(req);
            let parsed: Json;
            try {
              parsed = JSON.parse(body);
            } catch {
              return sendError(res, 400, 'Invalid JSON body');
            }
            await fs.mkdir(contextDir, { recursive: true });
            await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
            return sendJson(res, 200, parsed);
          }
          if (method === 'DELETE') {
            try {
              await fs.unlink(file);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            res.statusCode = 204;
            return res.end();
          }
          return sendError(res, 405, 'Method not allowed');
        } catch (err) {
          console.error('[sammy-pack-api] workspaces error:', err);
          return sendError(res, 500, (err as Error).message);
        }
      });
}

export function sammyPackApiPlugin(): Plugin {
  return {
    name: 'sammy-pack-api',
    configureServer(server) {
      return mountSammyApi(server);
    },
  };
}
