/**
 * Kafka consume-loop — the broker-specific half of a sammy-pack queue
 * source.
 *
 * Like the SQS adapter, this is the "~50 lines to add a broker" core. It
 * depends on TWO things and nothing else:
 *
 *   1. the sammy-pack narrow waist (the `@sammy-pack/sdk` contract), via
 *      the injected `deliver` fn (`SourceMessage -> DeliveryResult`, ok
 *      iff the queue trigger answered 2xx); and
 *   2. a MINIMAL Kafka consumer surface (`KafkaConsumerLike`) — just the
 *      calls this loop makes. The real `kafkajs` consumer is wired in
 *      `index.ts`; keeping the loop client-agnostic is what lets the unit
 *      test mock Kafka with no `kafkajs` installed.
 *
 * RELIABILITY: a message's offset is COMMITTED ONLY after `deliver`
 * returns `{ ok: true }`. With Kafka, "ack" = advancing the committed
 * offset, so the loop runs with auto-commit OFF and commits `offset + 1`
 * per message only on success. On failure it commits nothing and STOPS
 * consuming the partition (it pauses), so the same offset is re-delivered
 * on the next run / after the pause — at-least-once, with the durability
 * boundary owned by the sammy-pack core (the 2xx), never by kafkajs.
 */

import type { DeliverFn, QueueSource, SourceMessage } from '@sammy-pack/sdk';

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** One Kafka record the loop understands (mapped from the kafkajs
 *  `eachMessage` payload in index.ts, or produced by the test double). */
export interface KafkaIncomingMessage {
  topic: string;
  partition: number;
  /** kafkajs delivers offsets as strings. */
  offset: string;
  /** The record value as a UTF-8 string (null/empty → ''). */
  value: string;
  /** The record key, if any (used to build a stable idempotency key). */
  key?: string;
}

/** The slice of a kafkajs consumer this loop uses. Structural, so both the
 *  real `Consumer` (adapted in index.ts) and a test double satisfy it. */
export interface KafkaConsumerLike {
  /** START consuming. The adapter invokes `eachMessage` for every record.
   *
   *  The returned promise resolves once consumption has STARTED, NOT when it
   *  ends — that is kafkajs's own `consumer.run()` semantics, which hands
   *  back control as soon as the fetch loop is running. A consumer group
   *  member then lives until it is told to stop, so the loop's lifetime is
   *  the abort signal (plus `onStopped`), never this promise. Returning
   *  "started" from a mock is therefore the faithful behaviour. */
  run(handler: {
    eachMessage: (msg: KafkaIncomingMessage) => Promise<void>;
  }): Promise<void>;
  /** OPTIONAL: register a callback for consumption ending on its own — a
   *  FATAL crash that kafkajs will not retry. Without it, a dead consumer
   *  would leave the loop waiting on an abort that never comes. */
  onStopped?(cb: (err?: Error) => void): void;
  /** Commit a specific offset (the ack). The loop passes `offset + 1` —
   *  Kafka's committed offset is the NEXT offset to read. */
  commitOffsets(
    offsets: Array<{ topic: string; partition: number; offset: string }>,
  ): Promise<void>;
  /** Pause a partition so no further records are delivered for it until
   *  resumed — used to STOP advancing past a failed (un-acked) message. */
  pause(topicPartitions: Array<{ topic: string; partition: number }>): void;
  /** Resume a paused partition. Kafka has no redelivery timer of its own:
   *  a paused partition stays paused until somebody resumes it, so without
   *  this a transient failure stalls the partition for the life of the
   *  process while the consumer still looks healthy. */
  resume(topicPartitions: Array<{ topic: string; partition: number }>): void;
  /** Stop consuming and release the connection (clean shutdown). */
  disconnect(): Promise<void>;
}

/** What to do with a record the core refused NON-retryably (a poison
 *  message: 401 bad signature, 404 unregistered queue, 4xx validation).
 *  Kafka has no dead-letter primitive the way AMQP does, so there is no
 *  option that is right for everyone — only a choice to make explicitly:
 *
 *    'stop' (default) — pause and STOP the source with an error. Loses
 *      nothing and preserves order; the process exits non-zero so a
 *      supervisor restarts it or an operator sees it. Choose this when
 *      silently skipping a record would be worse than halting.
 *    'skip' — commit past the record, logging loudly, and keep consuming.
 *      Choose this for liveness when one bad record must not stop the
 *      pipeline. It IS data loss, which is why it is opt-in.
 *
 *  What is NOT on offer is the old behaviour: pausing forever while
 *  reporting no error at all. */
export type KafkaPoisonPolicy = 'stop' | 'skip';

export interface KafkaSourceConfig {
  log?: (msg: string) => void;
  /** First backoff before resuming a partition paused by a RETRYABLE
   *  failure. Doubles per consecutive failure. Default 1000ms. */
  retryBackoffMs?: number;
  /** Ceiling for that backoff. Default 30_000ms. */
  maxRetryBackoffMs?: number;
  /** Handling for a non-retryable refusal. Default 'stop'. */
  onPoison?: KafkaPoisonPolicy;
  /** Injectable sleep (tests). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** The decision made about one record. */
export type DeliverOutcome =
  /** 2xx: offset committed, keep consuming. */
  | 'ack'
  /** Transient refusal: nothing committed, partition paused for retry. */
  | 'retry'
  /** Non-retryable refusal: nothing committed, policy decides. */
  | 'poison';

/** Deliver one record, then commit-iff-2xx. Shared between
 *  `runKafkaConsumer` and tests so the ack rule is exercised directly.
 *
 *  Returns WHICH outcome occurred, not merely whether the offset moved,
 *  because the caller has to treat the two failure kinds differently: a
 *  transient refusal must be retried (pause → backoff → resume) while a
 *  poison record must not be retried forever. Collapsing both to `false`
 *  is what let a transient 503 pause a partition permanently. */
export async function deliverAndCommit(
  consumer: KafkaConsumerLike,
  deliver: DeliverFn,
  m: KafkaIncomingMessage,
  log: (msg: string) => void = () => {},
): Promise<DeliverOutcome> {
  const msg: SourceMessage = {
    body: m.value,
    // `${topic}-${partition}-${offset}` is globally unique + stable, so a
    // re-consumed record (after a pause / rebalance) collapses to ONE run.
    idempotencyKey: `${m.topic}-${m.partition}-${m.offset}`,
  };

  let result;
  try {
    result = await deliver(msg);
  } catch (err) {
    log(
      `deliver threw for ${msg.idempotencyKey}: ${(err as Error)?.message ?? err}` +
        ' — pausing partition, not committing',
    );
    consumer.pause([{ topic: m.topic, partition: m.partition }]);
    // A thrown deliver is transport-level — always worth retrying.
    return 'retry';
  }

  if (!result.ok) {
    log(
      `deliver not-ok for ${msg.idempotencyKey} (status ${result.status}, ` +
        `retryable=${result.retryable}): ${result.error} — pausing partition, not committing`,
    );
    // Don't advance the offset; stop pulling more from this partition so we
    // don't process past an un-acked record. The caller resumes it after a
    // backoff (retryable) or applies the poison policy.
    consumer.pause([{ topic: m.topic, partition: m.partition }]);
    return result.retryable ? 'retry' : 'poison';
  }

  // 2xx → durably accepted by the core → commit offset+1 (the ack).
  try {
    await consumer.commitOffsets([
      {
        topic: m.topic,
        partition: m.partition,
        offset: (BigInt(m.offset) + 1n).toString(),
      },
    ]);
    return 'ack';
  } catch (err) {
    // Commit failed AFTER a successful, durable deliver. The Idempotency-Key
    // makes the inevitable re-consume a no-op, so this is safe to swallow —
    // and it is an ACK, not a failure: the core owns the work, so the
    // partition must NOT be paused or retried over it.
    log(`commit (ack) failed for ${msg.idempotencyKey}: ${(err as Error)?.message ?? err}`);
    return 'ack';
  }
}

/**
 * Drive the Kafka consume loop until `signal` aborts (or the consumer dies
 * fatally). Resolves only once the consumer has actually been DISCONNECTED;
 * never rejects on a per-message failure (those are logged + left
 * un-committed for re-delivery). The real adapter wires the kafkajs consumer
 * (auto-commit OFF) in index.ts.
 *
 * The promise's lifetime is the whole source's lifetime, which is what makes
 * `await startKafkaSource(...)` a correct way to run one: the CLI prints
 * "stopped" and the queue-service supervisor restarts a binding off the back
 * of it. Since kafkajs's `run()` resolves as soon as the fetch loop STARTS,
 * awaiting that call alone would return while the consumer was still live
 * and skip the shutdown entirely — so the stop is a deferred, resolved after
 * `disconnect()` settles, exactly as the Rabbit loop does with its channel
 * close.
 */
export async function runKafkaConsumer(
  consumer: KafkaConsumerLike,
  deliver: DeliverFn,
  signal: AbortSignal,
  config: KafkaSourceConfig = {},
): Promise<void> {
  const log = config.log ?? (() => {});
  if (signal.aborted) return;

  const baseBackoff = Math.max(0, config.retryBackoffMs ?? 1_000);
  const maxBackoff = Math.max(baseBackoff, config.maxRetryBackoffMs ?? 30_000);
  const onPoison: KafkaPoisonPolicy = config.onPoison ?? 'stop';
  const sleep = config.sleep ?? realSleep;

  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => {
    resolveDone = resolve;
  });

  let stopped = false;
  let failure: Error | undefined;
  /** Disconnect once, then release the caller. */
  const stop = async (reason?: Error): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (reason) {
      failure = reason;
      log(`consumer stopped: ${reason.message} — disconnecting`);
    }
    try {
      await consumer.disconnect();
    } catch (err) {
      log(`disconnect failed: ${(err as Error)?.message ?? err}`);
    } finally {
      resolveDone();
    }
  };

  const onAbort = (): void => void stop();
  signal.addEventListener('abort', onAbort, { once: true });
  // A fatal crash ends consumption without an abort; without this the loop
  // would wait forever on a consumer that is already gone.
  consumer.onStopped?.(err => void stop(err));

  /** Consecutive retryable failures per partition, for the backoff. Cleared
   *  on the first success, so an occasional blip never inflates the wait. */
  const failures = new Map<string, number>();
  /** Partitions with a resume already scheduled, so N failed records in one
   *  batch schedule ONE resume instead of N racing timers. */
  const resuming = new Set<string>();

  /** Resume a partition paused by a retryable failure, after a backoff.
   *  THIS is the step whose absence was the bug: Kafka has no redelivery
   *  timer, so a paused partition stays paused forever and the source goes
   *  silently deaf while still looking healthy. */
  const scheduleResume = (topic: string, partition: number): void => {
    const key = `${topic}/${partition}`;
    if (resuming.has(key)) return;
    resuming.add(key);
    const n = (failures.get(key) ?? 0) + 1;
    failures.set(key, n);
    // Exponential, capped: 1s, 2s, 4s … 30s.
    const delay = Math.min(baseBackoff * 2 ** (n - 1), maxBackoff);
    log(`${key} paused after ${n} consecutive failure(s) — resuming in ${delay}ms`);
    void sleep(delay)
      .then(() => {
        resuming.delete(key);
        if (stopped || signal.aborted) return;
        consumer.resume([{ topic, partition }]);
        log(`${key} resumed — retrying the un-committed offset`);
      })
      .catch(err => {
        resuming.delete(key);
        log(`${key} resume failed: ${(err as Error)?.message ?? err}`);
      });
  };

  /** Commit past a poison record (the opt-in 'skip' policy). */
  const skipPoison = async (m: KafkaIncomingMessage): Promise<void> => {
    const key = `${m.topic}/${m.partition}`;
    try {
      await consumer.commitOffsets([
        {
          topic: m.topic,
          partition: m.partition,
          offset: (BigInt(m.offset) + 1n).toString(),
        },
      ]);
      // Loud on purpose: this is data loss, chosen deliberately via config.
      log(
        `POISON SKIPPED (onPoison='skip'): ${key} offset ${m.offset} was refused ` +
          'non-retryably and has been committed past — the record is LOST.',
      );
      consumer.resume([{ topic: m.topic, partition: m.partition }]);
    } catch (err) {
      // Could not commit past it — leave paused and retry later rather than
      // spinning on a record we can neither deliver nor skip.
      log(`could not commit past poison at ${key}: ${(err as Error)?.message ?? err}`);
      scheduleResume(m.topic, m.partition);
    }
  };

  try {
    await consumer.run({
      eachMessage: async (m: KafkaIncomingMessage) => {
        if (stopped || signal.aborted) return;
        const outcome = await deliverAndCommit(consumer, deliver, m, log);
        const key = `${m.topic}/${m.partition}`;
        if (outcome === 'ack') {
          failures.delete(key);
          return;
        }
        if (outcome === 'retry') {
          scheduleResume(m.topic, m.partition);
          return;
        }
        // Poison. Never leave it paused-and-silent, which is what used to
        // happen for every failure kind.
        if (onPoison === 'skip') {
          await skipPoison(m);
          return;
        }
        await stop(
          new Error(
            `poison record at ${key} offset ${m.offset} refused non-retryably; ` +
              "onPoison='stop' — halting the source rather than skipping it " +
              "(set onPoison: 'skip' to commit past it and keep consuming)",
          ),
        );
      },
    });
    await done;
    // A stop triggered by a fatal crash or a poison halt is a FAILURE, not a
    // clean shutdown: an aborted signal is the only clean way out. Surfacing
    // it is what makes the CLI exit non-zero and a supervisor restart.
    if (failure && !signal.aborted) throw failure;
  } catch (err) {
    // Failing to start (bad brokers, auth) must still release the client.
    await stop();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * `QueueSource` wrapper around `runKafkaConsumer`. Construct with a
 * `KafkaConsumerLike` (the kafkajs-backed adapter from index.ts, or a
 * mock) and use it anywhere a `QueueSource` is expected.
 */
export class KafkaSource implements QueueSource {
  readonly kind = 'kafka';
  constructor(
    private readonly consumer: KafkaConsumerLike,
    private readonly config: KafkaSourceConfig = {},
  ) {}

  start(opts: { deliver: DeliverFn; signal: AbortSignal }): Promise<void> {
    return runKafkaConsumer(this.consumer, opts.deliver, opts.signal, this.config);
  }
}
