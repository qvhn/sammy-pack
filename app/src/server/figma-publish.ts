/**
 * Headless Figma publishing — REST receipt + a durable session-handoff queue.
 *
 * ─── Why this module exists ───────────────────────────────────────────────
 * A headless run (e.g. the nightly cron that captures a journey / nav-map)
 * cannot, today, write the captured layout into Figma: structural document
 * mutation — `createFrame()`, `createRectangle()`, `createImage()`, appending
 * children, setting image fills — lives ONLY in the Figma **Plugin API**,
 * which runs inside the Figma desktop/web editor with the plugin loaded.
 * That is a *live session*; it is not reachable from a server process.
 *
 * The Figma **REST API** (base `https://api.figma.com`, auth header
 * `X-Figma-Token`) is, by contrast, almost entirely READ-only for design
 * content:
 *
 *   READ  GET  /v1/files/:key                 file document tree
 *   READ  GET  /v1/files/:key/nodes           specific nodes
 *   READ  GET  /v1/images/:key?ids=…          RENDER nodes → image URLs
 *   READ  GET  /v1/files/:key/images          existing image-fill refs
 *   READ  GET  /v1/me                          token identity (probe)
 *
 * The only WRITE endpoints are narrow, non-structural metadata channels:
 *
 *   WRITE POST /v1/files/:key/comments         post a comment   ← used here
 *   WRITE POST /v1/dev_resources               attach dev-resource URLs to
 *                                              EXISTING nodes
 *   WRITE POST /v2/webhooks                     manage webhooks
 *   WRITE POST /v1/files/:key/variables         variables — ENTERPRISE-only
 *
 * Crucially there is **no** `POST /v1/files` (you cannot create a file), and
 * **no** endpoint that uploads an image and places it as a node. So a server
 * with only a personal-access token *cannot* build a nav-map (frames + placed
 * screenshots) over REST. The honest split this module implements:
 *
 *   • REST, genuinely headless → post a **publish receipt comment** on the
 *     target file: a human-readable breadcrumb (what was captured, when, a
 *     link to the rendered preview) so the cron leaves a visible, durable
 *     trace in Figma without a session. `postFigmaPublishReceipt`.
 *
 *   • Structural publish (frames/images) → **enqueue a publish job** that a
 *     session-context worker (the Figma plugin / an MCP-attached agent) drains
 *     when a session is available. The job carries the whole layout plan, so
 *     the headless run does all the *capture + planning* and the session does
 *     only the *mechanical write*. `FigmaPublishQueue`.
 *
 * ─── Credential tie-in ───────────────────────────────────────────────────
 * Both paths authenticate with the SAME secret the executor injects: a
 * registry credential of `kind: "figma"`, whose `value` the credential-env
 * mapping projects to `FIGMA_API_KEY` (see `credential-env.ts`). This module
 * reuses that exact projection (`credentialToEnv`) via `resolveFigmaToken`,
 * so there is one source of truth for the token — the REST client never reads
 * `process.env` or the registry directly, it takes the resolved value.
 *
 * Server-only. Domain-agnostic: no app- or nav-map-specific strings; the
 * caller supplies the file key, page, frames, and any human text.
 */

import { credentialToEnv } from './credential-env';
import type { Credential } from './credentials-store';

// ── REST surface ──────────────────────────────────────────────────────────

/** Figma REST base. Overridable only for tests (a mock server). */
export const FIGMA_API_BASE = 'https://api.figma.com';

/** The env var the `figma` credential kind projects to. Single source of
 *  truth shared with `credential-env.ts` — kept as a const so both the
 *  resolver here and any caller building env can reference the same name. */
export const FIGMA_TOKEN_ENV = 'FIGMA_API_KEY';

/** A minimal injectable HTTP surface so tests don't hit the network and the
 *  module carries no hard dependency on a fetch implementation. Defaults to
 *  the runtime global `fetch` (Node ≥18 / 22 here). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error(
      'figma-publish: global fetch is unavailable; pass opts.fetch explicitly',
    );
  }
  return f as FetchLike;
}

export type FigmaRestOptions = {
  /** Resolved personal-access token (the `figma` credential's value). */
  token: string;
  /** Injectable fetch (tests / custom agents). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Base URL override (tests). Defaults to {@link FIGMA_API_BASE}. */
  baseUrl?: string;
};

export class FigmaRestError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly bodyText: string,
  ) {
    super(`Figma REST ${endpoint} → HTTP ${status}: ${truncate(bodyText, 300)}`);
    this.name = 'FigmaRestError';
  }
}

function authHeaders(token: string): Record<string, string> {
  // X-Figma-Token is the personal-access-token header. (OAuth bearer tokens
  // use Authorization: Bearer, but the credential-env projection is a PAT, so
  // we use the PAT header — the canonical headless auth.)
  return { 'X-Figma-Token': token, 'Content-Type': 'application/json' };
}

async function figmaRequest(
  opts: FigmaRestOptions,
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown,
): Promise<unknown> {
  if (!opts.token || !opts.token.trim()) {
    throw new Error(
      `figma-publish: no token (the resolved \`figma\` credential / ${FIGMA_TOKEN_ENV} is empty)`,
    );
  }
  const fetchFn = opts.fetch ?? defaultFetch();
  const base = (opts.baseUrl ?? FIGMA_API_BASE).replace(/\/+$/, '');
  const res = await fetchFn(`${base}${endpoint}`, {
    method,
    headers: authHeaders(opts.token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new FigmaRestError(res.status, endpoint, text);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Token-identity probe — `GET /v1/me`. Cheap pre-flight that confirms the
 *  injected credential is valid (and which Figma user it is) BEFORE the run
 *  bothers to post a receipt or enqueue a job. READ-only. */
export async function figmaWhoAmI(
  opts: FigmaRestOptions,
): Promise<{ id: string; email?: string; handle?: string }> {
  const me = (await figmaRequest(opts, 'GET', '/v1/me')) as {
    id?: string;
    email?: string;
    handle?: string;
  };
  return { id: String(me?.id ?? ''), email: me?.email, handle: me?.handle };
}

/** A point/region to anchor a publish-receipt comment at (optional). Figma's
 *  comment API accepts a frame-relative offset; omit for a file-level
 *  comment. */
export type CommentAnchor = {
  /** Node id the comment is pinned to (its coordinate space). */
  nodeId?: string;
  x?: number;
  y?: number;
};

export type PublishReceipt = {
  /** Target file key (the `:key` in figma.com/file/<key>/…). */
  fileKey: string;
  /** Human-readable receipt text — what was captured + when. Domain text is
   *  the CALLER's; this module never invents app-specific strings. */
  message: string;
  /** Optional anchor; omit for a file-level comment. */
  anchor?: CommentAnchor;
};

/**
 * Post a **publish-receipt comment** — the one structural-free write the REST
 * API genuinely allows headlessly (`POST /v1/files/:key/comments`). Use it so
 * a headless capture leaves a visible, durable breadcrumb in the Figma file
 * (e.g. "nav-map captured 2026-06-23 — 14 screens — preview: <url>") even
 * though it cannot draw the frames itself.
 *
 * Returns the created comment's id. Throws {@link FigmaRestError} on a non-2xx
 * (the worker treats that as retryable; see {@link FigmaPublishQueue}).
 */
export async function postFigmaPublishReceipt(
  opts: FigmaRestOptions,
  receipt: PublishReceipt,
): Promise<{ commentId: string }> {
  if (!receipt.fileKey?.trim()) {
    throw new Error('postFigmaPublishReceipt: fileKey is required');
  }
  if (!receipt.message?.trim()) {
    throw new Error('postFigmaPublishReceipt: message is required');
  }
  const body: Record<string, unknown> = { message: receipt.message };
  if (receipt.anchor) {
    // client_meta is Figma's anchor shape: a frame-relative offset, optionally
    // within a node's coordinate space.
    const meta: Record<string, unknown> = {
      x: receipt.anchor.x ?? 0,
      y: receipt.anchor.y ?? 0,
    };
    if (receipt.anchor.nodeId) meta.node_id = receipt.anchor.nodeId;
    body.client_meta = meta;
  }
  const created = (await figmaRequest(
    opts,
    'POST',
    `/v1/files/${encodeURIComponent(receipt.fileKey)}/comments`,
    body,
  )) as { id?: string };
  return { commentId: String(created?.id ?? '') };
}

// ── Credential resolution ──────────────────────────────────────────────────

/**
 * Project a resolved `figma` credential to its token, reusing the SAME
 * mapping the executor uses to inject `FIGMA_API_KEY` into agent subprocesses
 * (`credential-env.ts`). This keeps ONE source of truth: the REST client gets
 * exactly the value the agent env would have gotten.
 *
 * Returns null when the credential is missing / wrong-kind / empty, so callers
 * can decide whether to fall back to the queue-only path (no REST receipt).
 */
export function resolveFigmaToken(cred: Credential | undefined): string | null {
  if (!cred) return null;
  const env = credentialToEnv(cred);
  const token = env[FIGMA_TOKEN_ENV];
  return token && token.trim() ? token : null;
}

/**
 * Pick the `figma`-kind credential out of a name→Credential registry map
 * (the shape `readCredentialsByNameRaw` returns) and resolve its token. When
 * `name` is given, only that entry is considered; otherwise the first
 * `kind: "figma"` entry wins. Returns null when none resolves.
 */
export function resolveFigmaTokenFromRegistry(
  registry: Record<string, Credential>,
  name?: string,
): string | null {
  if (name) return resolveFigmaToken(registry[name]);
  for (const cred of Object.values(registry)) {
    if (cred?.kind === 'figma') {
      const token = resolveFigmaToken(cred);
      if (token) return token;
    }
  }
  return null;
}

// ── Durable session-handoff queue (the structural-publish path) ─────────────
//
// Structural writes need a session, so the headless run can't do them inline.
// Instead it ENQUEUES a fully-specified job here; a session-context worker
// (the Figma plugin, or an MCP-attached agent with a live editor) drains the
// queue and performs the mechanical create-frames / place-images write.
//
// The queue is modelled on `DeliveryWorker`'s idiom — pluggable store,
// injectable clock, attempts + backoff, atomic claim — so it has the same
// reliability shape and can later be backed by the durable RunStore
// (`trigger_deliveries` already has attempts/available_at/claimed_at columns)
// without changing this surface. The default store is in-memory so the
// capability lands with zero schema change.

/** One placed asset in a publish plan: an image (by source ref) at a frame
 *  position. The headless run renders/captures the bytes elsewhere; the job
 *  references them so the payload stays small and serialisable. */
export type PublishFrame = {
  /** Stable id within the plan (the session worker maps it to a created node). */
  id: string;
  /** Display name for the created frame/node. */
  name: string;
  /** Layout box in the page's coordinate space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** How the session worker should source the image fill. EXACTLY ONE of: */
  image?:
    | { kind: 'url'; url: string }
    | { kind: 'base64'; mediaType: string; base64: string }
    | { kind: 'imageRef'; ref: string };
  /** Optional directed edges to other frame ids (nav-map connectors). */
  edgesTo?: string[];
  /** Optional caption/label text for the node. */
  caption?: string;
};

/** A complete, self-contained structural-publish plan. Everything the session
 *  worker needs — it does NOT re-capture or re-plan. Domain-agnostic: the
 *  caller fills `frames`; this module imposes no nav-map-specific schema. */
export type FigmaPublishPlan = {
  /** Target file key. */
  fileKey: string;
  /** Target page name (created if absent) — keeps a publish scoped to its own
   *  page so re-publishes don't trample sibling content. */
  pageName: string;
  /** The frames/images to place + connect. */
  frames: PublishFrame[];
  /** Optional title for the published section. */
  title?: string;
  /** Free-form metadata (capture timestamp, source run id, …) — opaque here. */
  meta?: Record<string, unknown>;
};

export type PublishJobStatus =
  | 'pending' // enqueued, waiting for a session worker
  | 'claimed' // a session worker is publishing it now
  | 'done' // published (terminal)
  | 'failed'; // exhausted retries (dead-letter; terminal)

export type FigmaPublishJob = {
  id: string;
  plan: FigmaPublishPlan;
  status: PublishJobStatus;
  /** How many times a worker has claimed it (drives retry/backoff). */
  attempts: number;
  /** Earliest ms-epoch a worker may claim it (retry backoff). */
  availableAt: number;
  /** When claimed; null when not in flight. */
  claimedAt: number | null;
  /** Last failure reason. */
  lastError: string | null;
  createdAt: number;
  /** Owner identity — mirrors the run/delivery multi-tenancy seam. */
  ownerId: string;
};

export type EnqueuePublishInput = {
  id?: string;
  plan: FigmaPublishPlan;
  ownerId?: string;
  /** Earliest claim time; defaults to now. */
  availableAt?: number;
};

/**
 * Pluggable persistence for publish jobs. The default
 * {@link MemoryFigmaPublishStore} is in-memory (zero infra); a durable
 * implementation can be added later (the RunStore's delivery table already
 * has the needed columns) behind this same interface.
 */
export interface FigmaPublishStore {
  enqueue(job: FigmaPublishJob): Promise<void>;
  /** Atomically claim the oldest claimable (`pending`, availableAt ≤ now):
   *  flip to `claimed`, stamp claimedAt, bump attempts. Null when none. */
  claimNext(now: number): Promise<FigmaPublishJob | null>;
  complete(id: string, now: number): Promise<void>;
  /** With `retryAt`, requeue (`pending`, availableAt = retryAt); without it,
   *  dead-letter (`failed`). */
  fail(
    id: string,
    opts: { error: string; now: number; retryAt?: number | null },
  ): Promise<void>;
  /** Requeue jobs stuck `claimed` past `olderThanMs` (worker died). */
  reclaimStale(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; ids: string[] }>;
  list(status?: PublishJobStatus): Promise<FigmaPublishJob[]>;
  get(id: string): Promise<FigmaPublishJob | null>;
}

/** Zero-infra in-memory store. Single-process; replace with a durable
 *  implementation for multi-process/cross-restart durability. */
export class MemoryFigmaPublishStore implements FigmaPublishStore {
  private readonly jobs = new Map<string, FigmaPublishJob>();

  async enqueue(job: FigmaPublishJob): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async claimNext(now: number): Promise<FigmaPublishJob | null> {
    // Oldest claimable first (FIFO by createdAt) — deterministic + fair.
    const claimable = [...this.jobs.values()]
      .filter(j => j.status === 'pending' && j.availableAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const next = claimable[0];
    if (!next) return null;
    next.status = 'claimed';
    next.claimedAt = now;
    next.attempts += 1;
    return { ...next };
  }

  async complete(id: string, _now: number): Promise<void> {
    const j = this.jobs.get(id);
    if (j) {
      j.status = 'done';
      j.claimedAt = null;
      j.lastError = null;
    }
  }

  async fail(
    id: string,
    opts: { error: string; now: number; retryAt?: number | null },
  ): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) return;
    j.lastError = opts.error;
    j.claimedAt = null;
    if (opts.retryAt != null) {
      j.status = 'pending';
      j.availableAt = opts.retryAt;
    } else {
      j.status = 'failed';
    }
  }

  async reclaimStale(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; ids: string[] }> {
    const ids: string[] = [];
    for (const j of this.jobs.values()) {
      if (
        j.status === 'claimed' &&
        j.claimedAt != null &&
        now - j.claimedAt >= olderThanMs
      ) {
        j.status = 'pending';
        j.claimedAt = null;
        ids.push(j.id);
      }
    }
    return { count: ids.length, ids };
  }

  async list(status?: PublishJobStatus): Promise<FigmaPublishJob[]> {
    const all = [...this.jobs.values()].map(j => ({ ...j }));
    return status ? all.filter(j => j.status === status) : all;
  }

  async get(id: string): Promise<FigmaPublishJob | null> {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }
}

let publishSeq = 0;
function newJobId(now: number): string {
  publishSeq = (publishSeq + 1) % 1_000_000;
  return `fpub_${now.toString(36)}_${publishSeq.toString(36)}`;
}

const defaultPublishBackoff = (attempt: number): number =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));

export type FigmaPublishQueueOpts = {
  store?: FigmaPublishStore;
  /** Total tries before a job is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Retry backoff by attempt (1-based). Default capped exponential. */
  backoffMs?: (attempt: number) => number;
  /** A `claimed` job older than this is presumed orphaned. Default 5 min
   *  (a session publish — opening the editor, placing N images — is slow). */
  reclaimAfterMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
};

/**
 * The handler a session-context worker provides: it performs the actual
 * structural write (create page/frames, place images, draw connectors) using
 * the Plugin API / a live MCP editor session, then resolves. Throwing — or
 * returning `{ ok: false, retryable: true }` — requeues with backoff; a
 * non-retryable failure dead-letters immediately.
 */
export type PublishHandler = (
  job: FigmaPublishJob,
) => Promise<{ ok: true } | { ok: false; error: string; retryable?: boolean }>;

/**
 * Durable-ish publish queue. The headless side calls {@link enqueue}; the
 * session side calls {@link drain} (or {@link processOne}) with a handler that
 * does the structural write. Same claim/attempt/backoff/dead-letter shape as
 * the run DeliveryWorker, so its reliability semantics carry over.
 */
export class FigmaPublishQueue {
  private readonly store: FigmaPublishStore;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly reclaimAfterMs: number;
  private readonly now: () => number;

  constructor(opts: FigmaPublishQueueOpts = {}) {
    this.store = opts.store ?? new MemoryFigmaPublishStore();
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.backoffMs = opts.backoffMs ?? defaultPublishBackoff;
    this.reclaimAfterMs = Math.max(1000, opts.reclaimAfterMs ?? 300_000);
    this.now = opts.now ?? Date.now;
  }

  /** Enqueue a structural-publish job (the headless capture's output). */
  async enqueue(input: EnqueuePublishInput): Promise<FigmaPublishJob> {
    validatePlan(input.plan);
    const now = this.now();
    const job: FigmaPublishJob = {
      id: input.id ?? newJobId(now),
      plan: input.plan,
      status: 'pending',
      attempts: 0,
      availableAt: input.availableAt ?? now,
      claimedAt: null,
      lastError: null,
      createdAt: now,
      ownerId: input.ownerId ?? 'system',
    };
    await this.store.enqueue(job);
    return job;
  }

  /** Claim one job and settle it via `handler` (complete / retry / fail).
   *  Returns the job processed, or null if nothing was claimable. */
  async processOne(handler: PublishHandler): Promise<FigmaPublishJob | null> {
    // Opportunistic stale-claim reclaim so a dead session worker doesn't wedge
    // the head of the queue forever (cheap; no background timer needed).
    await this.store.reclaimStale(this.reclaimAfterMs, this.now());
    const job = await this.store.claimNext(this.now());
    if (!job) return null;
    try {
      const res = await handler(job);
      if (res.ok) {
        await this.store.complete(job.id, this.now());
      } else if (res.retryable) {
        await this.retryOrFail(job, res.error);
      } else {
        await this.store.fail(job.id, { error: res.error, now: this.now() });
      }
    } catch (err) {
      await this.retryOrFail(job, (err as Error)?.message ?? String(err));
    }
    return job;
  }

  private async retryOrFail(job: FigmaPublishJob, error: string): Promise<void> {
    if (job.attempts < this.maxAttempts) {
      const retryAt = this.now() + this.backoffMs(job.attempts);
      await this.store.fail(job.id, { error, now: this.now(), retryAt });
    } else {
      await this.store.fail(job.id, { error, now: this.now() });
    }
  }

  /** Drain claimable jobs until the queue is empty. Bounded so a runaway
   *  producer can't spin a single drain forever. */
  async drain(handler: PublishHandler): Promise<number> {
    let n = 0;
    while (n < 10_000) {
      const job = await this.processOne(handler);
      if (!job) break;
      n += 1;
    }
    return n;
  }

  list(status?: PublishJobStatus): Promise<FigmaPublishJob[]> {
    return this.store.list(status);
  }
  get(id: string): Promise<FigmaPublishJob | null> {
    return this.store.get(id);
  }
}

/** Validate a publish plan enough to fail fast at enqueue time (a bad plan
 *  should never reach the session worker). Domain-agnostic structural checks
 *  only. */
function validatePlan(plan: FigmaPublishPlan): void {
  if (!plan || typeof plan !== 'object') {
    throw new Error('figma publish: plan is required');
  }
  if (!plan.fileKey?.trim()) {
    throw new Error('figma publish: plan.fileKey is required');
  }
  if (!plan.pageName?.trim()) {
    throw new Error('figma publish: plan.pageName is required');
  }
  if (!Array.isArray(plan.frames) || plan.frames.length === 0) {
    throw new Error('figma publish: plan.frames must be a non-empty array');
  }
  const ids = new Set<string>();
  for (const f of plan.frames) {
    if (!f.id?.trim()) throw new Error('figma publish: every frame needs an id');
    if (ids.has(f.id)) {
      throw new Error(`figma publish: duplicate frame id "${f.id}"`);
    }
    ids.add(f.id);
  }
  // Edges must reference frames that exist in the same plan.
  for (const f of plan.frames) {
    for (const to of f.edgesTo ?? []) {
      if (!ids.has(to)) {
        throw new Error(
          `figma publish: frame "${f.id}" has an edge to unknown frame "${to}"`,
        );
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
