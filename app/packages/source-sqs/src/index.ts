/**
 * @sammy-pack/source-sqs — an Amazon SQS queue-source adapter.
 *
 * The ONLY file that imports `@aws-sdk/client-sqs`. It adapts the SDK into
 * the minimal `SqsLike` surface and hands it to the broker-agnostic loop
 * (`sqs-source.ts`). The loop talks to sammy-pack only through the
 * `httpDeliver` narrow waist — so the AWS SDK never enters the core engine.
 *
 * Use the CLI (`sammy-source-sqs`, see bin/run.ts) for the out-of-process
 * default, or call `startSqsSource` to embed the loop in your own runner.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { makeHttpDeliver, type DeliverSigning } from '@sammy-pack/sdk';
import {
  runSqsLoop,
  type SqsLike,
  type SqsIncomingMessage,
  type SqsSourceConfig,
} from './sqs-source.js';

export {
  runSqsLoop,
  SqsSource,
  type SqsLike,
  type SqsIncomingMessage,
  type SqsSourceConfig,
} from './sqs-source.js';

/** Wrap a real `SQSClient` + queue URL as the minimal `SqsLike` surface
 *  the loop needs. Maps the SDK's command/response shapes to the loop's. */
export function sqsClientAdapter(client: SQSClient, queueUrl: string): SqsLike {
  return {
    async receive(input): Promise<SqsIncomingMessage[]> {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: input.maxMessages,
          WaitTimeSeconds: input.waitTimeSeconds,
          VisibilityTimeout: input.visibilityTimeoutSeconds,
        }),
      );
      return (out.Messages ?? [])
        .filter(m => m.ReceiptHandle != null)
        .map(m => ({
          messageId: m.MessageId,
          receiptHandle: m.ReceiptHandle as string,
          body: m.Body ?? '',
        }));
    },
    async deleteMessage(receiptHandle): Promise<void> {
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    },
  };
}

export interface StartSqsSourceOptions {
  /** SQS queue URL to consume from. */
  queueUrl: string;
  /** sammy-pack server base URL, e.g. "http://localhost:5173". */
  baseUrl: string;
  /** The `queue` trigger name — messages land at `/api/queue/<deliverTo>`. */
  deliverTo: string;
  /** AWS region. Defaults to the SDK's env/instance resolution. */
  region?: string;
  /** HMAC secret for a `"signed": true` queue trigger. */
  signing?: DeliverSigning;
  /** Tuning for the receive→deliver→delete loop. */
  loop?: SqsSourceConfig;
  /** Provide a pre-built client (e.g. with custom credentials). When
   *  omitted, a default `SQSClient({ region })` is created. */
  client?: SQSClient;
  /** Abort to stop the loop. When omitted, the loop runs until the process
   *  is killed (the CLI wires SIGINT/SIGTERM to an internal controller). */
  signal?: AbortSignal;
}

/**
 * Start consuming an SQS queue and delivering to a sammy-pack `queue`
 * trigger. Resolves when the loop stops (signal aborted). Long-poll
 * ReceiveMessage → `deliver()` each → DeleteMessage (ack) only on 2xx.
 */
export async function startSqsSource(opts: StartSqsSourceOptions): Promise<void> {
  const client = opts.client ?? new SQSClient(opts.region ? { region: opts.region } : {});
  const sqs = sqsClientAdapter(client, opts.queueUrl);
  const deliver = makeHttpDeliver({
    baseUrl: opts.baseUrl,
    queue: opts.deliverTo,
    signing: opts.signing,
  });
  const controller = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  await runSqsLoop(sqs, deliver, signal, opts.loop);
}
