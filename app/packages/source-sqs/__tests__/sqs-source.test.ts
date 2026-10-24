/**
 * SQS consume-loop unit tests.
 *
 * The loop is driven against a MOCK SqsLike + a mock deliver fn — no AWS
 * SDK and no sammy-pack server are imported or run. The contract under
 * test is the reliability rule: DeleteMessage (the broker ack) happens
 * IFF deliver() returned `{ ok: true }` (a 2xx from the queue trigger).
 *
 * Type-only imports from `@sammy-pack/sdk` in the source are erased by the
 * babel TS transform, so this runs with nothing extra installed.
 */

import {
  runSqsLoop,
  type SqsLike,
  type SqsIncomingMessage,
} from '../src/sqs-source';
import type { DeliverFn, DeliveryResult, SourceMessage } from '@sammy-pack/sdk';

/** A mock SQS queue: feeds a fixed batch on the first receive, then empty
 *  + aborts the loop so the test terminates deterministically. Records
 *  every receiptHandle passed to deleteMessage (the acks). */
function mockSqs(
  firstBatch: SqsIncomingMessage[],
  controller: AbortController,
): SqsLike & { deleted: string[]; receiveCalls: number } {
  const state = {
    deleted: [] as string[],
    receiveCalls: 0,
    async receive(): Promise<SqsIncomingMessage[]> {
      state.receiveCalls += 1;
      if (state.receiveCalls === 1) return firstBatch;
      // Second poll: nothing left — stop the loop.
      controller.abort();
      return [];
    },
    async deleteMessage(receiptHandle: string): Promise<void> {
      state.deleted.push(receiptHandle);
    },
  };
  return state;
}

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

const noSleep = () => Promise.resolve();

describe('runSqsLoop reliability — ack iff 2xx', () => {
  it('deletes (acks) a message only after deliver returns ok', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [{ messageId: 'm1', receiptHandle: 'rh-1', body: 'hello' }],
      ac,
    );
    const deliver: DeliverFn = jest.fn(async () => okResult);

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('passes body through as run input and MessageId as Idempotency-Key', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [{ messageId: 'mid-42', receiptHandle: 'rh-9', body: '{"x":1}' }],
      ac,
    );
    const seen: SourceMessage[] = [];
    const deliver: DeliverFn = async msg => {
      seen.push(msg);
      return okResult;
    };

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    expect(seen).toEqual([{ body: '{"x":1}', idempotencyKey: 'mid-42' }]);
    expect(sqs.deleted).toEqual(['rh-9']);
  });

  it('does NOT ack when delivery fails with a retryable (5xx) status', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [{ messageId: 'm2', receiptHandle: 'rh-2', body: 'payload' }],
      ac,
    );
    const deliver: DeliverFn = jest.fn(async () => serverErr);

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    expect(deliver).toHaveBeenCalledTimes(1);
    // Left in flight → SQS will redeliver after the visibility timeout.
    expect(sqs.deleted).toEqual([]);
  });

  it('does NOT ack when delivery fails with a non-retryable (401) status', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [{ messageId: 'm3', receiptHandle: 'rh-3', body: 'payload' }],
      ac,
    );
    const deliver: DeliverFn = async () => badSig;

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    // A poison message must not be silently dropped — still no ack.
    expect(sqs.deleted).toEqual([]);
  });

  it('does NOT ack when the deliver fn throws', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [{ messageId: 'm4', receiptHandle: 'rh-4', body: 'payload' }],
      ac,
    );
    const deliver: DeliverFn = async () => {
      throw new Error('network down');
    };

    // The loop must swallow the throw (resolve, not reject) and leave the
    // message un-acked.
    await expect(
      runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep }),
    ).resolves.toBeUndefined();
    expect(sqs.deleted).toEqual([]);
  });

  it('acks only the ok messages in a mixed batch (and treats 200 dedupe as ack)', async () => {
    const ac = new AbortController();
    const sqs = mockSqs(
      [
        { messageId: 'a', receiptHandle: 'rh-a', body: 'ok' },
        { messageId: 'b', receiptHandle: 'rh-b', body: 'fail' },
        { messageId: 'c', receiptHandle: 'rh-c', body: 'dup' },
      ],
      ac,
    );
    const deliver: DeliverFn = async msg => {
      if (msg.body === 'ok') return okResult;
      if (msg.body === 'dup') return dupResult; // 200 — still an ack
      return serverErr;
    };

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    // rh-a (202) and rh-c (200) acked; rh-b (503) left for redelivery.
    expect(sqs.deleted.sort()).toEqual(['rh-a', 'rh-c']);
  });

  it('stops promptly when the signal is already aborted (no receive)', async () => {
    const ac = new AbortController();
    ac.abort();
    const sqs = mockSqs([], ac);
    const deliver: DeliverFn = jest.fn(async () => okResult);

    await runSqsLoop(sqs, deliver, ac.signal, { sleep: noSleep });

    expect(sqs.receiveCalls).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('backs off and retries after a receive error, then continues', async () => {
    const ac = new AbortController();
    let receiveCalls = 0;
    const deleted: string[] = [];
    const sqs: SqsLike = {
      async receive(): Promise<SqsIncomingMessage[]> {
        receiveCalls += 1;
        if (receiveCalls === 1) throw new Error('throttled by AWS');
        if (receiveCalls === 2) {
          return [{ messageId: 'm', receiptHandle: 'rh-after-err', body: 'x' }];
        }
        ac.abort();
        return [];
      },
      async deleteMessage(rh: string): Promise<void> {
        deleted.push(rh);
      },
    };
    const sleep = jest.fn(async () => {});
    const deliver: DeliverFn = async () => okResult;

    await runSqsLoop(sqs, deliver, ac.signal, { sleep, errorBackoffMs: 5 });

    expect(sleep).toHaveBeenCalledWith(5); // backed off once after the error
    expect(deleted).toEqual(['rh-after-err']); // recovered and acked
  });
});
