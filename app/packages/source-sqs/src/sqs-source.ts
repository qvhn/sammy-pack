/**
 * SQS consume-loop — the broker-specific half of a sammy-pack queue source.
 *
 * This is the "~50 lines to add a broker" core. It depends on TWO things
 * and nothing else:
 *
 *   1. the sammy-pack narrow waist (the `@sammy-pack/sdk` contract), via
 *      the injected `deliver` fn (`SourceMessage -> DeliveryResult`, ok
 *      iff the queue trigger answered 2xx); and
 *   2. a MINIMAL SQS client surface (`SqsLike`) — just the two calls this
 *      loop makes. The real `@aws-sdk/client-sqs` is wired in `index.ts`;
 *      keeping the loop client-agnostic is what lets the unit test mock SQS
 *      with no AWS SDK installed.
 *
 * RELIABILITY: a message is deleted from SQS (the ack) ONLY after
 * `deliver` returns `{ ok: true }`. If delivery fails, the message is left
 * in flight; once its visibility timeout lapses, SQS redelivers it. With
 * the core's durable delivery queue behind the 2xx, that's at-least-once
 * end-to-end — and the AWS SDK never enters the sammy-pack core.
 */

import type { DeliverFn, QueueSource, SourceMessage } from '@sammy-pack/sdk';

/** The slice of the SQS client this loop uses. Structural, so both the
 *  real `SQSClient` (adapted in index.ts) and a test double satisfy it. */
export interface SqsLike {
  /** Long-poll for up to `maxMessages`, waiting up to `waitTimeSeconds`. */
  receive(input: {
    maxMessages: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
  }): Promise<SqsIncomingMessage[]>;
  /** Ack one message (SQS DeleteMessage) by its receipt handle. */
  deleteMessage(receiptHandle: string): Promise<void>;
}

/** Normalized SQS message the loop understands (mapped from the SDK shape
 *  in index.ts, or produced directly by the test double). */
export interface SqsIncomingMessage {
  messageId?: string;
  receiptHandle: string;
  body: string;
}

export interface SqsSourceConfig {
  /** Messages per ReceiveMessage call (1–10). Default 10. */
  maxMessages?: number;
  /** Long-poll wait (0–20s). Default 20 (max — fewer empty receives). */
  waitTimeSeconds?: number;
  /** Visibility timeout while a message is being delivered. Should exceed
   *  the deliver timeout so a slow 2xx doesn't race a redelivery. Default
   *  30s. */
  visibilityTimeoutSeconds?: number;
  /** Backoff after a ReceiveMessage error before retrying. Default 1000ms. */
  errorBackoffMs?: number;
  /** Injectable sleep (tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Drive the SQS receive→deliver→delete loop until `signal` aborts.
 * Returns (resolves) on a clean shutdown; never rejects on a per-message
 * or per-poll failure (those are logged + retried / left for redelivery).
 *
 * Exported standalone (not just via the class) so the unit test can drive
 * exactly one or two iterations deterministically.
 */
export async function runSqsLoop(
  sqs: SqsLike,
  deliver: DeliverFn,
  signal: AbortSignal,
  config: SqsSourceConfig = {},
): Promise<void> {
  const maxMessages = clamp(config.maxMessages ?? 10, 1, 10);
  const waitTimeSeconds = clamp(config.waitTimeSeconds ?? 20, 0, 20);
  const visibilityTimeoutSeconds = Math.max(0, config.visibilityTimeoutSeconds ?? 30);
  const errorBackoffMs = Math.max(0, config.errorBackoffMs ?? 1000);
  const sleep = config.sleep ?? realSleep;
  const log = config.log ?? (() => {});

  while (!signal.aborted) {
    let messages: SqsIncomingMessage[];
    try {
      messages = await sqs.receive({
        maxMessages,
        waitTimeSeconds,
        visibilityTimeoutSeconds,
      });
    } catch (err) {
      log(`sqs receive failed: ${(err as Error)?.message ?? err}`);
      if (!signal.aborted) await sleep(errorBackoffMs);
      continue;
    }

    for (const m of messages) {
      if (signal.aborted) break;
      await deliverAndAck(sqs, deliver, m, log);
    }
  }
}

/** Deliver one message, then DeleteMessage (ack) IFF delivery returned ok.
 *  A failure leaves the message in flight → SQS redelivers after the
 *  visibility timeout. This is the single point where the ack rule lives. */
async function deliverAndAck(
  sqs: SqsLike,
  deliver: DeliverFn,
  m: SqsIncomingMessage,
  log: (msg: string) => void,
): Promise<void> {
  const msg: SourceMessage = {
    body: m.body,
    // SQS MessageId → Idempotency-Key, so a redelivery (visibility-timeout
    // expiry, or a delete that didn't land) collapses to ONE run.
    idempotencyKey: m.messageId,
  };

  let result;
  try {
    result = await deliver(msg);
  } catch (err) {
    // Deliver fn itself threw — treat as not-ok, leave un-acked.
    log(`deliver threw for ${m.messageId ?? '?'}: ${(err as Error)?.message ?? err}`);
    return;
  }

  if (!result.ok) {
    if (result.retryable) {
      log(
        `deliver not-ok for ${m.messageId ?? '?'} (status ${result.status}, ` +
          `retryable): ${result.error} — leaving for redelivery after the ` +
          'visibility timeout',
      );
      return;
    }
    // POISON. SQS has no per-message drop, so the message simply becomes
    // visible again — which means a non-retryable refusal (a bad signature,
    // an unregistered queue trigger) redelivers FOREVER unless the queue has
    // a redrive policy. That is a queue-side setting this adapter cannot
    // make, so the least it can do is name the condition instead of logging
    // it identically to a transient blip, which is how an infinite
    // redelivery loop goes unnoticed.
    log(
      `POISON message ${m.messageId ?? '?'} (status ${result.status}, NOT ` +
        `retryable): ${result.error} — SQS will redeliver it after the ` +
        'visibility timeout, and will keep doing so. Configure a redrive ' +
        'policy (maxReceiveCount + a dead-letter queue) on this queue, or ' +
        'fix the refusal; the adapter cannot drop a message itself.',
    );
    return;
  }

  // 2xx → durably accepted by the core → safe to ack the broker.
  try {
    await sqs.deleteMessage(m.receiptHandle);
  } catch (err) {
    // Ack failed AFTER a successful, durable deliver. The Idempotency-Key
    // makes the inevitable redelivery a no-op, so this is safe to swallow.
    log(`delete (ack) failed for ${m.messageId ?? '?'}: ${(err as Error)?.message ?? err}`);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * `QueueSource` wrapper around `runSqsLoop`. Construct with an `SqsLike`
 * (the AWS-backed adapter from index.ts, or a mock) and use it anywhere a
 * `QueueSource` is expected (e.g. a future in-process connector-runner).
 */
export class SqsSource implements QueueSource {
  readonly kind = 'sqs';
  constructor(
    private readonly sqs: SqsLike,
    private readonly config: SqsSourceConfig = {},
  ) {}

  start(opts: { deliver: DeliverFn; signal: AbortSignal }): Promise<void> {
    return runSqsLoop(this.sqs, opts.deliver, opts.signal, this.config);
  }
}
