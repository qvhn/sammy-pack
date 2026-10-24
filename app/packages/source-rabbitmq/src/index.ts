/**
 * @sammy-pack/source-rabbitmq — a RabbitMQ (AMQP 0-9-1) queue-source
 * adapter.
 *
 * The ONLY file that imports `amqplib`. It connects, opens a channel
 * (with prefetch), and adapts the amqplib `ConsumeMessage` + ack/nack/close
 * into the minimal `RabbitChannelLike` surface the broker-agnostic loop
 * (`rabbit-source.ts`) drives. The loop talks to sammy-pack only through
 * the `httpDeliver` narrow waist — so amqplib never enters the sammy-pack
 * core.
 *
 * Use the CLI (`sammy-source-rabbitmq`, see bin/run.ts) for the
 * out-of-process default, or call `startRabbitSource` to embed the loop in
 * your own runner.
 */

import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { makeHttpDeliver, type DeliverSigning } from '@sammy-pack/sdk';
import {
  runRabbitConsumer,
  type RabbitChannelLike,
  type RabbitIncomingMessage,
  type RabbitSourceConfig,
} from './rabbit-source.js';

export {
  runRabbitConsumer,
  deliverAndSettle,
  RabbitSource,
  type RabbitChannelLike,
  type RabbitIncomingMessage,
  type RabbitSourceConfig,
} from './rabbit-source.js';

/** Wrap a real amqplib `Channel` as the minimal `RabbitChannelLike`
 *  surface (the raw delivery is the amqplib `ConsumeMessage`). */
export function rabbitChannelAdapter(
  channel: Channel,
): RabbitChannelLike<ConsumeMessage> {
  return {
    async consume(queue, onMessage): Promise<void> {
      await channel.consume(queue, (raw: ConsumeMessage | null) => {
        if (raw === null) {
          onMessage(null);
          return;
        }
        const msg: RabbitIncomingMessage<ConsumeMessage> = {
          content: raw.content ? raw.content.toString('utf8') : '',
          messageId: raw.properties?.messageId
            ? String(raw.properties.messageId)
            : undefined,
          raw,
        };
        onMessage(msg);
      });
    },
    ack(raw): void {
      channel.ack(raw);
    },
    nack(raw, requeue): void {
      channel.nack(raw, false, requeue);
    },
    async close(): Promise<void> {
      await channel.close();
    },
  };
}

export interface StartRabbitSourceOptions {
  /** AMQP connection URL, e.g. "amqp://user:pass@host:5672/vhost". */
  url: string;
  /** Queue to consume from. */
  queue: string;
  /** sammy-pack server base URL, e.g. "http://localhost:5173". */
  baseUrl: string;
  /** The `queue` trigger name — messages land at `/api/queue/<deliverTo>`. */
  deliverTo: string;
  /** Channel prefetch (max unacked in flight). Default 10. */
  prefetch?: number;
  /** HMAC secret for a `"signed": true` queue trigger. */
  signing?: DeliverSigning;
  /** Tuning for the consume loop. */
  loop?: RabbitSourceConfig;
  /** Provide a pre-built channel (e.g. on a shared connection). When
   *  omitted, a connection + channel are created from `url`. */
  channel?: Channel;
  /** Abort to stop the loop. When omitted, the loop runs until the process
   *  is killed (the CLI wires SIGINT/SIGTERM to an internal controller). */
  signal?: AbortSignal;
}

/**
 * Start consuming a RabbitMQ queue and delivering to a sammy-pack `queue`
 * trigger. Resolves when the loop stops (signal aborted → channel close).
 * consume → `deliver()` each → ack on 2xx / nack(requeue) on retryable /
 * nack(drop→DLX) on poison.
 */
export async function startRabbitSource(opts: StartRabbitSourceOptions): Promise<void> {
  let channel = opts.channel;
  let ownedConnection: ChannelModel | undefined;
  if (!channel) {
    ownedConnection = await amqp.connect(opts.url);
    channel = await ownedConnection.createChannel();
    await channel.prefetch(opts.prefetch ?? 10);
  }

  const adapter = rabbitChannelAdapter(channel);
  // If we own the connection, close it too when the channel closes.
  const adapterWithConnClose: RabbitChannelLike<ConsumeMessage> = ownedConnection
    ? {
        ...adapter,
        async close(): Promise<void> {
          await adapter.close();
          await ownedConnection!.close();
        },
      }
    : adapter;

  const deliver = makeHttpDeliver({
    baseUrl: opts.baseUrl,
    queue: opts.deliverTo,
    signing: opts.signing,
  });
  const controller = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  await runRabbitConsumer(adapterWithConnClose, opts.queue, deliver, signal, opts.loop);
}
