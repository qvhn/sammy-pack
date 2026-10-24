/**
 * Queue-source contract — the narrow waist for pluggable message brokers.
 *
 * sammy-pack's core knows exactly ONE thing about the outside world's
 * queues: "a message arrived → start a run with it as input." That
 * contract is the HTTP `queue` trigger (`POST /api/queue/<queue>`, body =
 * run input). Every broker — SQS, Kafka, RabbitMQ, Pub/Sub, Redis
 * streams — is an ADAPTER that sits on the FAR side of that contract and
 * is NEVER a dependency of the core engine.
 *
 * Two distinct axes (kept deliberately separate):
 *
 *   1. trigger KINDS  — *how* a run starts (webhook / cron / queue /
 *                       events / polling / deployment). Server-owned.
 *   2. queue SOURCES  — *where* a `queue` message came from (sqs / kafka /
 *                       rabbit / …). An adapter layer that lives UNDER the
 *                       `queue` kind. Out-of-process by default.
 *
 * This module defines axis (2): a tiny `QueueSource` consume-loop
 * interface, the `SourceMessage` it pulls, the `DeliveryResult` it gets
 * back from the narrow waist, and a shared `httpDeliver` helper that does
 * the POST (with optional HMAC signing, reusing the webhook-auth scheme).
 *
 * RELIABILITY MODEL — at-least-once without a broker client in core:
 *   An adapter ACKs the broker (SQS DeleteMessage / Kafka commit / Rabbit
 *   ack) ONLY after `deliver()` returns `{ ok: true }` — i.e. the queue
 *   trigger answered 2xx. A 2xx means the delivery is durably recorded in
 *   sammy-pack's Postgres-backed delivery queue, so it WILL become a run
 *   even across a server restart. Any non-2xx (or transport error) leaves
 *   the message un-acked → the broker redelivers it. End-to-end:
 *   at-least-once, with the durability boundary owned by the core, not the
 *   adapter.
 *
 * This file is the PUBLIC BOUNDARY for third-party adapters: a broker
 * adapter depends on `@sammy-pack/sdk` (this contract), NOT on the engine.
 * It imports ONLY `node:`-builtins + the SDK's own signing helpers. It
 * carries no broker SDK and adds none to anything that depends on it —
 * that is the whole point. The engine re-exports it (via
 * `app/src/server/queue-source.ts`) for back-compat.
 */

import { signWebhookBody, signWebhookBodyV2 } from './signing.js';

/** One message pulled from a broker by an adapter, normalized to what the
 *  narrow waist needs. The broker-native handle (SQS ReceiptHandle, Kafka
 *  offset, Rabbit deliveryTag, …) stays inside the adapter — the contract
 *  never sees it; the adapter acks using its own handle after `deliver`
 *  succeeds. */
export interface SourceMessage {
  /** The message payload that becomes the run's initial input verbatim. */
  body: string;
  /** Optional stable id used as the `Idempotency-Key` header so a
   *  broker redelivery (at-least-once) collapses to ONE delivery instead
   *  of starting a duplicate run. Use the broker's message id when it has
   *  one (SQS MessageId, Kafka `${topic}-${partition}-${offset}`, …). */
  idempotencyKey?: string;
}

/** Result of handing a message to the narrow waist. `ok` is true iff the
 *  queue trigger answered 2xx (202 accepted, or 200 for a deduped
 *  redelivery) — the ONLY case in which the adapter may ack the broker. */
export type DeliveryResult =
  | { ok: true; status: number; duplicate: boolean }
  | { ok: false; status: number; retryable: boolean; error: string };

/** Hand a single message to the narrow waist. An adapter calls this for
 *  each message, then acks the broker IFF the result is `{ ok: true }`. */
export type DeliverFn = (msg: SourceMessage) => Promise<DeliveryResult>;

/** A broker adapter: an abortable consume-loop. `start` long-polls /
 *  subscribes, calls `deliver` per message, acks on ok, and runs until
 *  `signal` aborts. It MUST resolve (not reject) on a clean shutdown. */
export interface QueueSource {
  /** Stable adapter id for logs/registry, e.g. "sqs", "kafka". */
  readonly kind: string;
  start(opts: { deliver: DeliverFn; signal: AbortSignal }): Promise<void>;
}

/** Optional HMAC signing for `httpDeliver`. Mirrors the signed-trigger
 *  scheme in webhook-auth: the secret lives only in the runner's env, never
 *  in committed config. `scheme: 'v2'` (default) is replay-protected. */
export interface DeliverSigning {
  secret: string;
  scheme?: 'v1' | 'v2';
}

export interface HttpDeliverOptions {
  /** Base URL of the sammy-pack server, e.g. "http://localhost:5173". */
  baseUrl: string;
  /** The `queue` trigger name — the run lands at `/api/queue/<queue>`. */
  queue: string;
  /** Sign the POST so a `"signed": true` queue trigger accepts it. */
  signing?: DeliverSigning;
  /** Per-request timeout (ms). Default 15000. A timeout is retryable. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Is an HTTP status one the broker should retry (leave the message
 *  un-acked for)? 5xx = server transient; 429 = backpressure (the delivery
 *  queue is full) — both retryable. A 401 (bad signature) / 404 (no such
 *  queue trigger) / other 4xx is a config error: NOT retryable, but we
 *  still don't ack — a poison message must not be silently dropped. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Build the request body + `X-Sammy-Signature` header for a payload,
 *  reusing the webhook-auth signer (never re-implementing HMAC here). */
function signedHeaders(
  body: string,
  signing: DeliverSigning | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'text/plain' };
  if (signing?.secret) {
    headers['X-Sammy-Signature'] =
      signing.scheme === 'v1'
        ? signWebhookBody(body, signing.secret)
        : signWebhookBodyV2(body, signing.secret, { nonce: cryptoNonce() });
  }
  return headers;
}

/** A short unique nonce for v2 signatures. Uses the global crypto UUID
 *  when present (Node 19+, all supported runtimes) and falls back to a
 *  random hex string. */
function cryptoNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/**
 * The shared narrow-waist call: POST a message to `/api/queue/<queue>` and
 * classify the response into a `DeliveryResult`. Adapters depend on THIS,
 * not on `fetch` semantics — so the ack rule ("ack iff `ok`") lives in one
 * place. 2xx (202 accept / 200 dedupe) → ok; everything else → not ok.
 */
export function makeHttpDeliver(opts: HttpDeliverOptions): DeliverFn {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/queue/${encodeURIComponent(opts.queue)}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;

  return async function httpDeliver(msg: SourceMessage): Promise<DeliveryResult> {
    const headers = signedHeaders(msg.body, opts.signing);
    if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: msg.body,
        signal: ac.signal,
      });
      if (res.status >= 200 && res.status < 300) {
        // 200 = deduped redelivery, 202 = freshly accepted. Both mean the
        // delivery is durably owned by the core → safe to ack the broker.
        return { ok: true, status: res.status, duplicate: res.status === 200 };
      }
      const error = await res.text().catch(() => res.statusText);
      return {
        ok: false,
        status: res.status,
        retryable: isRetryableStatus(res.status),
        error: error || `HTTP ${res.status}`,
      };
    } catch (err) {
      // Transport failure / timeout — always retryable (no durable record
      // was made), so the broker must redeliver.
      return {
        ok: false,
        status: 0,
        retryable: true,
        error: (err as Error)?.message ?? String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Convenience: build a deliver fn and immediately deliver one message.
 *  Most adapters keep one `makeHttpDeliver` and reuse it per message; this
 *  is for one-shot callers and tests. */
export async function httpDeliver(
  msg: SourceMessage,
  opts: HttpDeliverOptions,
): Promise<DeliveryResult> {
  return makeHttpDeliver(opts)(msg);
}
