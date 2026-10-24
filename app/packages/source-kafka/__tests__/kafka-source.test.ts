/**
 * Kafka consume-loop unit tests.
 *
 * Driven against a MOCK KafkaConsumerLike + a mock deliver fn — no kafkajs
 * and no sammy-pack server are imported or run. The contract under test is
 * the reliability rule: the committed offset advances (the Kafka "ack")
 * IFF deliver() returned `{ ok: true }` (a 2xx). On any non-ok the loop
 * commits nothing and PAUSES the partition so it doesn't read past an
 * un-acked record.
 *
 * Type-only imports from `@sammy-pack/sdk` in the source are erased by the
 * babel TS transform, so this runs with nothing extra installed.
 */

import {
  deliverAndCommit,
  runKafkaConsumer,
  type KafkaConsumerLike,
  type KafkaIncomingMessage,
} from '../src/kafka-source';
import type { DeliverFn, DeliveryResult, SourceMessage } from '@sammy-pack/sdk';

const okResult: DeliveryResult = { ok: true, status: 202, duplicate: false };
const dupResult: DeliveryResult = { ok: true, status: 200, duplicate: true };
const serverErr: DeliveryResult = {
  ok: false,
  status: 503,
  retryable: true,
  error: 'unavailable',
};
const badSig: DeliveryResult = {
  ok: false,
  status: 401,
  retryable: false,
  error: 'bad signature',
};

/** A mock consumer that records commits + pauses. */
function mockConsumer(): KafkaConsumerLike & {
  committed: Array<{ topic: string; partition: number; offset: string }>;
  paused: Array<{ topic: string; partition: number }>;
  resumed: Array<{ topic: string; partition: number }>;
  disconnects: number;
} {
  const state = {
    committed: [] as Array<{ topic: string; partition: number; offset: string }>,
    paused: [] as Array<{ topic: string; partition: number }>,
    resumed: [] as Array<{ topic: string; partition: number }>,
    disconnects: 0,
    async run(): Promise<void> {
      /* not used in deliverAndCommit tests */
    },
    async commitOffsets(
      offsets: Array<{ topic: string; partition: number; offset: string }>,
    ): Promise<void> {
      state.committed.push(...offsets);
    },
    pause(tps: Array<{ topic: string; partition: number }>): void {
      state.paused.push(...tps);
    },
    resume(tps: Array<{ topic: string; partition: number }>): void {
      state.resumed.push(...tps);
    },
    async disconnect(): Promise<void> {
      state.disconnects += 1;
    },
  };
  return state;
}

const rec = (offset: string, value = 'hello'): KafkaIncomingMessage => ({
  topic: 't',
  partition: 0,
  offset,
  value,
});

describe('deliverAndCommit reliability — commit (ack) iff 2xx', () => {
  it('commits offset+1 only after deliver returns ok', async () => {
    const consumer = mockConsumer();
    const deliver: DeliverFn = jest.fn(async () => okResult);

    const outcome = await deliverAndCommit(consumer, deliver, rec('41'));

    expect(outcome).toBe('ack');
    expect(deliver).toHaveBeenCalledTimes(1);
    // Kafka's committed offset is the NEXT to read → 41 + 1 = 42.
    expect(consumer.committed).toEqual([{ topic: 't', partition: 0, offset: '42' }]);
    expect(consumer.paused).toEqual([]);
  });

  it('treats a 200 dedupe as an ack (still commits)', async () => {
    const consumer = mockConsumer();
    const deliver: DeliverFn = async () => dupResult;

    await deliverAndCommit(consumer, deliver, rec('7'));

    expect(consumer.committed).toEqual([{ topic: 't', partition: 0, offset: '8' }]);
  });

  it('passes value through as run input and a stable idempotency key', async () => {
    const consumer = mockConsumer();
    const seen: SourceMessage[] = [];
    const deliver: DeliverFn = async msg => {
      seen.push(msg);
      return okResult;
    };

    await deliverAndCommit(consumer, deliver, {
      topic: 'orders',
      partition: 3,
      offset: '99',
      value: '{"x":1}',
    });

    expect(seen).toEqual([{ body: '{"x":1}', idempotencyKey: 'orders-3-99' }]);
  });

  it('reports RETRY (and pauses) on a retryable 5xx', async () => {
    const consumer = mockConsumer();
    const deliver: DeliverFn = jest.fn(async () => serverErr);

    const outcome = await deliverAndCommit(consumer, deliver, rec('10'));

    // 'retry', not a bare false: the caller must resume this partition after
    // a backoff, and cannot know to without being told the kind of failure.
    expect(outcome).toBe('retry');
    expect(consumer.committed).toEqual([]);
    // Paused so we don't advance past the un-acked record.
    expect(consumer.paused).toEqual([{ topic: 't', partition: 0 }]);
  });

  it('reports POISON (and pauses) on a non-retryable 401 — not dropped', async () => {
    const consumer = mockConsumer();
    const deliver: DeliverFn = async () => badSig;

    const outcome = await deliverAndCommit(consumer, deliver, rec('10'));

    // Distinct from 'retry': retrying a bad signature forever is a hot loop.
    expect(outcome).toBe('poison');
    expect(consumer.committed).toEqual([]);
    expect(consumer.paused).toEqual([{ topic: 't', partition: 0 }]);
  });

  it('reports RETRY (and pauses) when the deliver fn throws', async () => {
    const consumer = mockConsumer();
    const deliver: DeliverFn = async () => {
      throw new Error('network down');
    };

    const outcome = await deliverAndCommit(consumer, deliver, rec('10'));

    // A transport throw means no durable record was made — always retryable.
    expect(outcome).toBe('retry');
    expect(consumer.committed).toEqual([]);
    expect(consumer.paused).toEqual([{ topic: 't', partition: 0 }]);
  });

  it('swallows a commit failure AFTER a durable deliver (idempotency covers re-consume)', async () => {
    const consumer = mockConsumer();
    consumer.commitOffsets = async () => {
      throw new Error('commit failed');
    };
    const deliver: DeliverFn = async () => okResult;

    // Must not reject — the re-consume will dedupe on the idempotency key.
    const outcome = await deliverAndCommit(consumer, deliver, rec('10'));
    // ACK, not a failure: the core already owns the work durably, so the
    // partition must NOT be paused or retried over a lost commit.
    expect(outcome).toBe('ack');
    expect(consumer.paused).toEqual([]);
  });
});

describe('runKafkaConsumer lifecycle', () => {
  it('delivers each record via eachMessage and commits the ok ones', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    // Drive a fixed batch through the handler, then STOP the source the way
    // a real one stops — by aborting. `run()` resolving only means the fetch
    // loop started (kafkajs semantics), so it must not end the loop.
    consumer.run = async handler => {
      await handler.eachMessage(rec('0', 'ok'));
      await handler.eachMessage(rec('1', 'fail'));
      await handler.eachMessage(rec('2', 'ok2'));
      ac.abort();
    };
    const deliver: DeliverFn = async msg =>
      msg.body === 'fail' ? serverErr : okResult;

    await runKafkaConsumer(consumer, deliver, ac.signal);

    // offsets 0 and 2 committed (→1, →3); offset 1 left un-committed.
    expect(consumer.committed).toEqual([
      { topic: 't', partition: 0, offset: '1' },
      { topic: 't', partition: 0, offset: '3' },
    ]);
    expect(consumer.paused).toEqual([{ topic: 't', partition: 0 }]);
  });

  it('returns immediately when the signal is already aborted (no run)', async () => {
    const consumer = mockConsumer();
    const ran = jest.fn(async () => {});
    consumer.run = ran;
    const ac = new AbortController();
    ac.abort();

    await runKafkaConsumer(consumer, jest.fn() as unknown as DeliverFn, ac.signal);

    expect(ran).not.toHaveBeenCalled();
  });

  it('disconnects on abort and skips records seen after abort', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const deliver: DeliverFn = jest.fn(async () => okResult);
    consumer.run = async handler => {
      // Abort mid-stream; the post-abort record must be skipped.
      ac.abort();
      await handler.eachMessage(rec('5'));
    };

    await runKafkaConsumer(consumer, deliver, ac.signal);

    expect(deliver).not.toHaveBeenCalled();
    expect(consumer.committed).toEqual([]);
    expect(consumer.disconnects).toBe(1);
  });

  // The three below pin the lifetime contract. They exist because the mock
  // used to resolve `run()` to mean "consumption finished", while real
  // kafkajs resolves it to mean "consumption started" — so the loop returned
  // the instant the source came up, leaving a live consumer behind and
  // skipping the disconnect. `await startKafkaSource(...)` must span the
  // source's whole life, since that is what the CLI and the queue-service
  // supervisor treat as "the source is running".
  const settled = async (p: Promise<unknown>): Promise<boolean> =>
    Promise.race([
      p.then(() => true),
      new Promise<boolean>(r => setTimeout(() => r(false), 50)),
    ]);

  it('does NOT resolve just because run() returned — the consumer is live', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    // Real kafkajs semantics: hands back control once fetching has begun.
    consumer.run = async () => {};

    const loop = runKafkaConsumer(consumer, jest.fn() as unknown as DeliverFn, ac.signal);

    expect(await settled(loop)).toBe(false);
    expect(consumer.disconnects).toBe(0);

    ac.abort();
    await loop;
    expect(consumer.disconnects).toBe(1);
  });

  it('resolves only AFTER disconnect() has settled', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    consumer.run = async () => {};
    let releaseDisconnect!: () => void;
    const disconnecting = new Promise<void>(r => {
      releaseDisconnect = r;
    });
    consumer.disconnect = async () => {
      await disconnecting;
      consumer.disconnects += 1;
    };

    const loop = runKafkaConsumer(consumer, jest.fn() as unknown as DeliverFn, ac.signal);
    ac.abort();

    // A shutdown that resolves early is how a process exits mid-rebalance.
    expect(await settled(loop)).toBe(false);
    releaseDisconnect();
    await loop;
    expect(consumer.disconnects).toBe(1);
  });

  it('a fatal crash stops the loop and SURFACES the error (not a hang, not a clean exit)', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    let crash!: (err?: Error) => void;
    consumer.onStopped = cb => {
      crash = cb;
    };
    consumer.run = async () => {};

    const loop = runKafkaConsumer(consumer, jest.fn() as unknown as DeliverFn, ac.signal);
    expect(await settled(loop)).toBe(false);

    crash(new Error('fatal: group coordinator gone'));

    // It must REJECT. The consumer died; nobody asked it to stop. Resolving
    // would make the CLI print "stopped" and exit 0, so a crashed source
    // would look exactly like a clean shutdown and no supervisor would
    // restart it. Only an aborted signal is a clean exit.
    await expect(loop).rejects.toThrow('fatal: group coordinator gone');
    expect(consumer.disconnects).toBe(1);
  });

  it('a failure to START rejects, and still releases the client', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    consumer.run = async () => {
      throw new Error('broker unreachable');
    };

    await expect(
      runKafkaConsumer(consumer, jest.fn() as unknown as DeliverFn, ac.signal),
    ).rejects.toThrow('broker unreachable');
    // A leaked consumer on a failed start is a socket + group member left behind.
    expect(consumer.disconnects).toBe(1);
  });
});

describe('a paused partition is RESUMED — Kafka has no redelivery timer', () => {
  /**
   * THE BUG THIS PINS: the loop paused a partition on any failure and nothing
   * ever resumed it. Kafka, unlike SQS (visibility timeout) and AMQP
   * (requeue), has no redelivery mechanism of its own — a paused partition
   * stays paused until somebody calls resume. So ONE transient 503 from the
   * sammy server stopped that partition for the life of the process, with no
   * error raised, no further logging, and a consumer that still reported
   * healthy. On a single-partition topic that is the whole source going
   * silently deaf. These tests make the resume non-optional.
   */
  const flush = () => new Promise(r => setImmediate(r));

  it('resumes after a backoff, so a transient failure is RETRIED not fatal', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const sleeps: number[] = [];
    consumer.run = async handler => {
      await handler.eachMessage(rec('5'));
    };
    const loop = runKafkaConsumer(consumer, async () => serverErr, ac.signal, {
      // Injected sleep: resolves immediately but records the delay asked for.
      sleep: async ms => {
        sleeps.push(ms);
      },
      retryBackoffMs: 1_000,
    });

    await flush();
    await flush();
    expect(consumer.paused).toEqual([{ topic: 't', partition: 0 }]);
    expect(consumer.resumed).toEqual([{ topic: 't', partition: 0 }]);
    expect(sleeps).toEqual([1_000]);

    ac.abort();
    await loop;
  });

  it('backs off exponentially, capped, across consecutive failures', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const sleeps: number[] = [];
    // Resolved by run() once every record has been delivered. Awaiting a
    // fixed number of flushes instead would assert while the loop was still
    // mid-batch (and then abort, making the rest short-circuit).
    let delivered!: () => void;
    const allDelivered = new Promise<void>(r => {
      delivered = r;
    });
    consumer.run = async handler => {
      // Five failures in a row on the same partition, each awaited so the
      // scheduled resume lands before the next one is delivered.
      for (let i = 0; i < 5; i++) {
        await handler.eachMessage(rec(String(i)));
        await flush();
        await flush();
      }
      delivered();
    };
    const loop = runKafkaConsumer(consumer, async () => serverErr, ac.signal, {
      sleep: async ms => {
        sleeps.push(ms);
      },
      retryBackoffMs: 100,
      maxRetryBackoffMs: 400,
    });

    await allDelivered;
    // 100, 200, 400 then CAPPED at 400 — never unbounded.
    expect(sleeps).toEqual([100, 200, 400, 400, 400]);

    ac.abort();
    await loop;
  });

  it('a success RESETS the backoff, so a blip does not inflate later waits', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const sleeps: number[] = [];
    let failNext = true;
    let delivered!: () => void;
    const allDelivered = new Promise<void>(r => {
      delivered = r;
    });
    consumer.run = async handler => {
      await handler.eachMessage(rec('0')); // fail  → 100
      await flush();
      await flush();
      failNext = false;
      await handler.eachMessage(rec('1')); // ok    → resets
      await flush();
      failNext = true;
      await handler.eachMessage(rec('2')); // fail  → 100 again, not 200
      await flush();
      await flush();
      delivered();
    };
    const loop = runKafkaConsumer(
      consumer,
      async () => (failNext ? serverErr : okResult),
      ac.signal,
      {
        sleep: async ms => {
          sleeps.push(ms);
        },
        retryBackoffMs: 100,
      },
    );

    await allDelivered;
    expect(sleeps).toEqual([100, 100]);

    ac.abort();
    await loop;
  });

  it('N failures in one batch schedule ONE resume, not N racing timers', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const sleeps: number[] = [];
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    consumer.run = async handler => {
      // Three failures delivered before any resume can land.
      await handler.eachMessage(rec('0'));
      await handler.eachMessage(rec('1'));
      await handler.eachMessage(rec('2'));
    };
    const loop = runKafkaConsumer(consumer, async () => serverErr, ac.signal, {
      sleep: async ms => {
        sleeps.push(ms);
        await held;
      },
      retryBackoffMs: 100,
    });

    await flush();
    // One scheduled wait for the partition, not three.
    expect(sleeps).toEqual([100]);
    release();
    await flush();
    await flush();
    expect(consumer.resumed).toEqual([{ topic: 't', partition: 0 }]);

    ac.abort();
    await loop;
  });

  it('does NOT resume after the source has stopped', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    let release!: () => void;
    const held = new Promise<void>(r => {
      release = r;
    });
    consumer.run = async handler => {
      await handler.eachMessage(rec('0'));
    };
    const loop = runKafkaConsumer(consumer, async () => serverErr, ac.signal, {
      sleep: async () => held,
      retryBackoffMs: 10,
    });

    await flush();
    ac.abort();
    await loop;
    // The backoff elapses AFTER shutdown; resuming a disconnected consumer
    // would throw inside a floating promise.
    release();
    await flush();
    await flush();
    expect(consumer.resumed).toEqual([]);
  });
});

describe('poison handling — never paused-and-silent', () => {
  const flush = () => new Promise(r => setImmediate(r));

  it("default 'stop' HALTS the source with an error, instead of idling", async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    consumer.run = async handler => {
      await handler.eachMessage(rec('9'));
    };

    // Rejecting is the point: a poison record used to leave the process
    // running and consuming nothing, which is indistinguishable from idle.
    await expect(
      runKafkaConsumer(consumer, async () => badSig, ac.signal),
    ).rejects.toThrow(/poison record at t\/0 offset 9/);
    expect(consumer.disconnects).toBe(1);
    expect(consumer.committed).toEqual([]);
  });

  it("'skip' commits past the record and keeps consuming", async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    const logs: string[] = [];
    consumer.run = async handler => {
      await handler.eachMessage(rec('9'));
      await flush();
      ac.abort();
    };

    await runKafkaConsumer(consumer, async () => badSig, ac.signal, {
      onPoison: 'skip',
      log: m => logs.push(m),
    });

    expect(consumer.committed).toEqual([{ topic: 't', partition: 0, offset: '10' }]);
    expect(consumer.resumed).toEqual([{ topic: 't', partition: 0 }]);
    // Data loss must be loud, not a debug line.
    expect(logs.join('\n')).toMatch(/POISON SKIPPED/);
    expect(logs.join('\n')).toMatch(/LOST/);
  });

  it("'skip' that cannot commit falls back to retry rather than spinning", async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    consumer.commitOffsets = async () => {
      throw new Error('coordinator down');
    };
    consumer.run = async handler => {
      await handler.eachMessage(rec('9'));
    };
    const loop = runKafkaConsumer(consumer, async () => badSig, ac.signal, {
      onPoison: 'skip',
      sleep: async () => {},
      retryBackoffMs: 5,
    });

    await flush();
    await flush();
    // Neither skipped nor hot-looped: paused, then resumed for another try.
    expect(consumer.resumed).toEqual([{ topic: 't', partition: 0 }]);

    ac.abort();
    await loop;
  });

  it('an abort is still a CLEAN exit — only a real failure rejects', async () => {
    const consumer = mockConsumer();
    const ac = new AbortController();
    consumer.run = async () => {};
    const loop = runKafkaConsumer(consumer, async () => okResult, ac.signal);
    ac.abort();
    await expect(loop).resolves.toBeUndefined();
  });
});
