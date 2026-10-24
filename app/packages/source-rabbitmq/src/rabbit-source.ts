/**
 * RabbitMQ consume-loop — the broker-specific half of a sammy-pack queue
 * source.
 *
 * Like the SQS + Kafka adapters, this is the "~50 lines to add a broker"
 * core. It depends on TWO things and nothing else:
 *
 *   1. the sammy-pack narrow waist (the `@sammy-pack/sdk` contract), via
 *      the injected `deliver` fn (`SourceMessage -> DeliveryResult`, ok
 *      iff the queue trigger answered 2xx); and
 *   2. a MINIMAL AMQP channel surface (`RabbitChannelLike`) — just the
 *      calls this loop makes. The real `amqplib` channel is wired in
 *      `index.ts`; keeping the loop client-agnostic is what lets the unit
 *      test mock RabbitMQ with no `amqplib` installed.
 *
 * RELIABILITY: a message is ACKed (`channel.ack`) ONLY after `deliver`
 * returns `{ ok: true }`. On failure the loop NACKs:
 *   - retryable (5xx / 429 / transport) → `nack(requeue: true)` so the
 *     broker redelivers it;
 *   - non-retryable (poison: 401 / 404 / other 4xx) → `nack(requeue: false)`
 *     so it goes to the dead-letter exchange instead of hot-looping — the
 *     same "a poison message is not silently dropped, it surfaces via the
 *     broker's DLQ" rule the SQS adapter follows.
 * With the core's durable delivery queue behind the 2xx, that's
 * at-least-once end-to-end — and amqplib never enters the sammy-pack core.
 */

import type { DeliverFn, QueueSource, SourceMessage } from '@sammy-pack/sdk';

/** One AMQP delivery the loop understands (mapped from the amqplib
 *  `ConsumeMessage` in index.ts, or produced by the test double). The
 *  broker-native delivery is carried opaquely so the loop can hand it back
 *  to ack/nack without knowing amqplib's shape. */
export interface RabbitIncomingMessage<TRaw = unknown> {
  /** The message payload as a UTF-8 string. */
  content: string;
  /** Broker-provided message id, if the publisher set one. Used as the
   *  Idempotency-Key when present. */
  messageId?: string;
  /** The opaque amqplib delivery, passed back to ack/nack. */
  raw: TRaw;
}

/** The slice of an amqplib channel this loop uses. Structural, so both the
 *  real `Channel` (adapted in index.ts) and a test double satisfy it. */
export interface RabbitChannelLike<TRaw = unknown> {
  /** Begin consuming `queue`; the adapter invokes `onMessage` per delivery.
   *  Resolves once the consumer is registered (amqplib's consume is
   *  push-based and returns immediately). */
  consume(
    queue: string,
    onMessage: (msg: RabbitIncomingMessage<TRaw> | null) => void,
  ): Promise<void>;
  /** Ack one delivery (the success path). */
  ack(raw: TRaw): void;
  /** Nack one delivery. `requeue: true` → broker redelivers; `false` →
   *  dead-letter (poison). */
  nack(raw: TRaw, requeue: boolean): void;
  /** Close the channel/connection (clean shutdown). */
  close(): Promise<void>;
}

export interface RabbitSourceConfig {
  log?: (msg: string) => void;
  /** Wait before requeueing a retryable failure. Doubles per consecutive
   *  failure, reset on the first success. Default 1000ms.
   *
   *  Without this, `nack(requeue: true)` hands the message straight back to
   *  the broker, which redelivers it immediately — so while the core is
   *  down, every in-flight message spins deliver → fail → requeue →
   *  redeliver as fast as the network allows. That is a retry STORM: it
   *  turns a brief outage into sustained load on the very service that is
   *  already struggling, and buries the real error in log noise. AMQP has no
   *  server-side redelivery delay (unlike SQS's visibility timeout), so the
   *  pacing has to live here. */
  retryBackoffMs?: number;
  /** Ceiling for that backoff. Default 30_000ms. */
  maxRetryBackoffMs?: number;
  /** Injectable sleep (tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Deliver one message, then ack/nack per the result. The single point
 *  where the ack rule lives. Exported so the unit test drives it directly. */
export async function deliverAndSettle<TRaw>(
  channel: RabbitChannelLike<TRaw>,
  deliver: DeliverFn,
  m: RabbitIncomingMessage<TRaw>,
  log: (msg: string) => void = () => {},
  opts: {
    /** Awaited immediately BEFORE a `nack(requeue: true)`. The loop passes
     *  its backoff here; the delay must come before the nack, because once
     *  the broker has the message back it redelivers at once. Omitted (as in
     *  the direct unit tests) means settle with no delay. */
    beforeRequeue?: () => Promise<void>;
  } = {},
): Promise<'ack' | 'nack-requeue' | 'nack-drop'> {
  // Map the AMQP delivery to the contract's SourceMessage (body +
  // idempotencyKey). A publisher-set messageId becomes the Idempotency-Key
  // so a redelivery collapses to ONE run.
  const sourceMsg: SourceMessage = {
    body: m.content,
    idempotencyKey: m.messageId,
  };

  let result;
  try {
    result = await deliver(sourceMsg);
  } catch (err) {
    // Deliver fn itself threw — treat as retryable, requeue.
    log(
      `deliver threw for ${m.messageId ?? '?'}: ${(err as Error)?.message ?? err}` +
        ' — nack(requeue) for redelivery',
    );
    await opts.beforeRequeue?.();
    channel.nack(m.raw, true);
    return 'nack-requeue';
  }

  if (result.ok) {
    // 2xx → durably accepted by the core → ack the broker.
    channel.ack(m.raw);
    return 'ack';
  }

  if (result.retryable) {
    log(
      `deliver not-ok for ${m.messageId ?? '?'} (status ${result.status}, retryable): ` +
        `${result.error} — nack(requeue) for redelivery`,
    );
    await opts.beforeRequeue?.();
    channel.nack(m.raw, true);
    return 'nack-requeue';
  }

  // Non-retryable (poison) → nack WITHOUT requeue → dead-letter, not a hot
  // loop. Not silently dropped: it surfaces via the broker's DLX.
  log(
    `deliver not-ok for ${m.messageId ?? '?'} (status ${result.status}, NOT retryable): ` +
      `${result.error} — nack(drop → dead-letter)`,
  );
  channel.nack(m.raw, false);
  return 'nack-drop';
}

/**
 * Drive the RabbitMQ consume loop until `signal` aborts. amqplib's consume
 * is push-based, so this registers the consumer and then waits for the
 * abort, closing the channel on shutdown. Resolves (never rejects) on a
 * clean shutdown; per-message failures are logged + nacked, not thrown.
 */
export async function runRabbitConsumer<TRaw>(
  channel: RabbitChannelLike<TRaw>,
  queue: string,
  deliver: DeliverFn,
  signal: AbortSignal,
  config: RabbitSourceConfig = {},
): Promise<void> {
  const log = config.log ?? (() => {});
  if (signal.aborted) return;

  const baseBackoff = Math.max(0, config.retryBackoffMs ?? 1_000);
  const maxBackoff = Math.max(baseBackoff, config.maxRetryBackoffMs ?? 30_000);
  const sleep = config.sleep ?? realSleep;
  /** Consecutive retryable failures, cleared by the first success, so one
   *  blip never inflates later waits. */
  let consecutiveFailures = 0;

  /** Sleep that gives up early on abort, so a shutdown isn't held for the
   *  full backoff (a 30s wait would otherwise stall every exit). */
  const abortableSleep = async (ms: number): Promise<void> => {
    if (signal.aborted) return;
    await Promise.race([
      sleep(ms),
      new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
  };

  /** The pacing that keeps a core outage from becoming a redelivery storm. */
  const backoffBeforeRequeue = async (): Promise<void> => {
    const n = ++consecutiveFailures;
    const delay = Math.min(baseBackoff * 2 ** (n - 1), maxBackoff);
    log(`consecutive failure ${n} — holding ${delay}ms before requeue`);
    await abortableSleep(delay);
  };

  // One deferred that resolves runRabbitConsumer when the source has
  // stopped — whether because the caller aborted OR the server cancelled
  // the consumer (null delivery). Either way we close the channel once.
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => {
    resolveDone = resolve;
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await channel.close();
    } catch (err) {
      log(`channel close failed: ${(err as Error)?.message ?? err}`);
    } finally {
      resolveDone();
    }
  };

  const onAbort = () => void close();
  signal.addEventListener('abort', onAbort, { once: true });

  await channel.consume(queue, msg => {
    // amqplib delivers `null` if the consumer is cancelled by the server.
    if (msg === null) {
      log('consumer cancelled by server — closing');
      void close();
      return;
    }
    if (closed || signal.aborted) {
      // Shutting down: requeue so we don't lose an un-delivered message.
      channel.nack(msg.raw, true);
      return;
    }
    // Settle each delivery; swallow throws so one bad message can't reject
    // the consumer callback.
    void deliverAndSettle(channel, deliver, msg, log, {
      beforeRequeue: backoffBeforeRequeue,
    })
      .then(outcome => {
        // Only a success clears the backoff. A dead-letter drop is not
        // evidence the core recovered, so it must not reset the counter.
        if (outcome === 'ack') consecutiveFailures = 0;
      })
      .catch(err =>
        log(`settle failed for ${msg.messageId ?? '?'}: ${(err as Error)?.message ?? err}`),
      );
  });

  // Resolve when aborted or server-cancelled (close() resolves `done`).
  try {
    await done;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * `QueueSource` wrapper around `runRabbitConsumer`. Construct with a
 * `RabbitChannelLike` + queue name (the amqplib-backed adapter from
 * index.ts, or a mock) and use it anywhere a `QueueSource` is expected.
 */
export class RabbitSource<TRaw = unknown> implements QueueSource {
  readonly kind = 'rabbitmq';
  constructor(
    private readonly channel: RabbitChannelLike<TRaw>,
    private readonly queue: string,
    private readonly config: RabbitSourceConfig = {},
  ) {}

  start(opts: { deliver: DeliverFn; signal: AbortSignal }): Promise<void> {
    return runRabbitConsumer(this.channel, this.queue, opts.deliver, opts.signal, this.config);
  }
}
