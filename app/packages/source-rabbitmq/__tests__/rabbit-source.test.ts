/**
 * RabbitMQ consume-loop unit tests.
 *
 * Driven against a MOCK RabbitChannelLike + a mock deliver fn — no amqplib
 * and no sammy-pack server are imported or run. The contract under test is
 * the settle rule:
 *   - 2xx                → ack
 *   - retryable (5xx/429) → nack(requeue: true)   → broker redelivers
 *   - non-retryable (4xx) → nack(requeue: false)  → dead-letter (poison)
 *   - deliver throws      → nack(requeue: true)
 *
 * Type-only imports from `@sammy-pack/sdk` in the source are erased by the
 * babel TS transform, so this runs with nothing extra installed.
 */

import {
  deliverAndSettle,
  runRabbitConsumer,
  type RabbitChannelLike,
  type RabbitIncomingMessage,
} from '../src/rabbit-source';
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

type Raw = { id: string };

/** A mock channel recording acks + nacks (with their requeue flag). */
function mockChannel(): RabbitChannelLike<Raw> & {
  acked: string[];
  nacked: Array<{ id: string; requeue: boolean }>;
  closes: number;
  consumeCb?: (msg: RabbitIncomingMessage<Raw> | null) => void;
} {
  const state = {
    acked: [] as string[],
    nacked: [] as Array<{ id: string; requeue: boolean }>,
    closes: 0,
    consumeCb: undefined as
      | ((msg: RabbitIncomingMessage<Raw> | null) => void)
      | undefined,
    async consume(
      _queue: string,
      onMessage: (msg: RabbitIncomingMessage<Raw> | null) => void,
    ): Promise<void> {
      state.consumeCb = onMessage;
    },
    ack(raw: Raw): void {
      state.acked.push(raw.id);
    },
    nack(raw: Raw, requeue: boolean): void {
      state.nacked.push({ id: raw.id, requeue });
    },
    async close(): Promise<void> {
      state.closes += 1;
    },
  };
  return state;
}

const msg = (
  id: string,
  content = 'hello',
  messageId?: string,
): RabbitIncomingMessage<Raw> => ({ content, messageId, raw: { id } });

describe('deliverAndSettle reliability — ack/nack by result', () => {
  it('acks on a 2xx', async () => {
    const ch = mockChannel();
    const deliver: DeliverFn = jest.fn(async () => okResult);

    const verdict = await deliverAndSettle(ch, deliver, msg('d1'));

    expect(verdict).toBe('ack');
    expect(ch.acked).toEqual(['d1']);
    expect(ch.nacked).toEqual([]);
  });

  it('acks a 200 dedupe too', async () => {
    const ch = mockChannel();
    const deliver: DeliverFn = async () => dupResult;
    await deliverAndSettle(ch, deliver, msg('d2'));
    expect(ch.acked).toEqual(['d2']);
  });

  it('passes content as run input and messageId as Idempotency-Key', async () => {
    const ch = mockChannel();
    const seen: SourceMessage[] = [];
    const deliver: DeliverFn = async m => {
      seen.push(m);
      return okResult;
    };

    await deliverAndSettle(ch, deliver, msg('d3', '{"x":1}', 'mid-7'));

    expect(seen).toEqual([{ body: '{"x":1}', idempotencyKey: 'mid-7' }]);
  });

  it('nacks with requeue on a retryable 5xx', async () => {
    const ch = mockChannel();
    const deliver: DeliverFn = jest.fn(async () => serverErr);

    const verdict = await deliverAndSettle(ch, deliver, msg('d4'));

    expect(verdict).toBe('nack-requeue');
    expect(ch.acked).toEqual([]);
    expect(ch.nacked).toEqual([{ id: 'd4', requeue: true }]);
  });

  it('nacks WITHOUT requeue (dead-letter) on a non-retryable 401', async () => {
    const ch = mockChannel();
    const deliver: DeliverFn = async () => badSig;

    const verdict = await deliverAndSettle(ch, deliver, msg('d5'));

    // Poison: not requeued (no hot loop), not silently dropped (goes to DLX).
    expect(verdict).toBe('nack-drop');
    expect(ch.acked).toEqual([]);
    expect(ch.nacked).toEqual([{ id: 'd5', requeue: false }]);
  });

  it('nacks with requeue when the deliver fn throws', async () => {
    const ch = mockChannel();
    const deliver: DeliverFn = async () => {
      throw new Error('network down');
    };

    const verdict = await deliverAndSettle(ch, deliver, msg('d6'));

    expect(verdict).toBe('nack-requeue');
    expect(ch.nacked).toEqual([{ id: 'd6', requeue: true }]);
  });
});

describe('runRabbitConsumer lifecycle', () => {
  it('registers a consumer, settles delivered messages, and closes on abort', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    const deliver: DeliverFn = async m => (m.body === 'fail' ? serverErr : okResult);

    // Zero-delay injected sleep: the requeue backoff is real (and tested
    // below), but this case is about ack/nack routing, not pacing.
    const done = runRabbitConsumer(ch, 'orders', deliver, ac.signal, {
      sleep: async () => {},
    });
    // consume() registered the callback synchronously-ish; flush microtasks.
    await Promise.resolve();
    expect(typeof ch.consumeCb).toBe('function');

    // Push three deliveries through the registered callback.
    ch.consumeCb!(msg('a', 'ok'));
    ch.consumeCb!(msg('b', 'fail'));
    ch.consumeCb!(msg('c', 'ok'));
    // A macrotask tick, which drains ALL pending microtasks: the requeue path
    // awaits the backoff hook before nacking, so counting individual
    // microtask hops is fragile.
    await new Promise(r => setImmediate(r));

    expect(ch.acked.sort()).toEqual(['a', 'c']);
    expect(ch.nacked).toEqual([{ id: 'b', requeue: true }]);

    ac.abort();
    await done;
    expect(ch.closes).toBe(1);
  });

  it('returns immediately when the signal is already aborted (no consume)', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    ac.abort();

    await runRabbitConsumer(ch, 'q', jest.fn() as unknown as DeliverFn, ac.signal);

    expect(ch.consumeCb).toBeUndefined();
    expect(ch.closes).toBe(0);
  });

  it('requeues a message that arrives after abort (no loss)', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    const deliver: DeliverFn = jest.fn(async () => okResult);

    const done = runRabbitConsumer(ch, 'q', deliver, ac.signal);
    await Promise.resolve();
    ac.abort();
    await done;
    // A late delivery (e.g. in-flight before close) must be requeued, not
    // delivered.
    ch.consumeCb!(msg('late'));
    expect(deliver).not.toHaveBeenCalled();
    expect(ch.nacked).toEqual([{ id: 'late', requeue: true }]);
  });

  it('closes when the server cancels the consumer (null delivery)', async () => {
    const ch = mockChannel();
    const ac = new AbortController();

    const done = runRabbitConsumer(ch, 'q', jest.fn() as unknown as DeliverFn, ac.signal);
    await Promise.resolve();
    ch.consumeCb!(null); // server-side cancel
    await done;
    expect(ch.closes).toBe(1);
  });
});

describe('requeue backoff — a core outage must not become a retry STORM', () => {
  /**
   * THE BUG THIS PINS: `nack(requeue: true)` hands the message straight back
   * to the broker, which redelivers it immediately. AMQP has no server-side
   * redelivery delay (unlike SQS's visibility timeout), so while the core was
   * down every in-flight message spun deliver -> fail -> requeue -> redeliver
   * as fast as the network allowed — sustained load aimed at the service that
   * was already failing, with the real error buried in the noise.
   */
  /** A macrotask tick — drains every pending microtask, so these cases do
   *  not depend on how many awaits the settle path happens to contain. */
  const flush = (): Promise<void> => new Promise(r => setImmediate(r));

  it('waits BEFORE requeueing, and the delay grows then caps', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    const sleeps: number[] = [];
    const done = runRabbitConsumer(ch, 'q', async () => serverErr, ac.signal, {
      sleep: async ms => {
        sleeps.push(ms);
      },
      retryBackoffMs: 100,
      maxRetryBackoffMs: 400,
    });
    await Promise.resolve();

    for (let i = 0; i < 5; i++) {
      ch.consumeCb!(msg(`m${i}`, 'fail'));
      await flush();
    }

    // 100, 200, 400, then CAPPED — not unbounded, and never zero.
    expect(sleeps).toEqual([100, 200, 400, 400, 400]);
    // The delay precedes the nack: the broker must not get it back early.
    expect(ch.nacked).toHaveLength(5);

    ac.abort();
    await done;
  });

  it('a success RESETS the backoff', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    const sleeps: number[] = [];
    let fail = true;
    const done = runRabbitConsumer(
      ch,
      'q',
      async () => (fail ? serverErr : okResult),
      ac.signal,
      {
        sleep: async ms => {
          sleeps.push(ms);
        },
        retryBackoffMs: 100,
      },
    );
    await Promise.resolve();

    ch.consumeCb!(msg('a', 'fail'));
    await flush();
    fail = false;
    ch.consumeCb!(msg('b', 'ok'));
    await flush();
    fail = true;
    ch.consumeCb!(msg('c', 'fail'));
    await flush();

    expect(sleeps).toEqual([100, 100]);

    ac.abort();
    await done;
  });

  it('a dead-letter DROP does not reset the backoff', async () => {
    // A poison message being dropped is not evidence the core recovered, so
    // treating it as a success would let poison traffic keep the retry
    // interval pinned at its minimum.
    const ch = mockChannel();
    const ac = new AbortController();
    const sleeps: number[] = [];
    let poison = false;
    const done = runRabbitConsumer(
      ch,
      'q',
      async () => (poison ? badSig : serverErr),
      ac.signal,
      {
        sleep: async ms => {
          sleeps.push(ms);
        },
        retryBackoffMs: 100,
      },
    );
    await Promise.resolve();

    ch.consumeCb!(msg('a', 'fail'));
    await flush();
    poison = true;
    ch.consumeCb!(msg('b', 'poison')); // nack-drop, no sleep
    await flush();
    poison = false;
    ch.consumeCb!(msg('c', 'fail'));
    await flush();

    // Second retryable failure still escalates to 200.
    expect(sleeps).toEqual([100, 200]);

    ac.abort();
    await done;
  });

  it('an abort cuts the backoff short — shutdown is not held for 30s', async () => {
    const ch = mockChannel();
    const ac = new AbortController();
    // A sleep that never resolves on its own; only the abort can end it.
    const done = runRabbitConsumer(ch, 'q', async () => serverErr, ac.signal, {
      sleep: () => new Promise<void>(() => {}),
      retryBackoffMs: 30_000,
    });
    await Promise.resolve();

    ch.consumeCb!(msg('a', 'fail'));
    await flush();
    expect(ch.nacked).toHaveLength(0); // still waiting

    ac.abort();
    await done; // must not hang for the full 30s
    expect(ch.closes).toBe(1);
  });
});
