/**
 * @sammy-pack/source-kafka — an Apache Kafka queue-source adapter.
 *
 * The ONLY file that imports `kafkajs`. It connects a consumer with
 * AUTO-COMMIT OFF, subscribes to the topic, and adapts the kafkajs
 * `eachMessage` payload + commit/pause/disconnect into the minimal
 * `KafkaConsumerLike` surface the broker-agnostic loop (`kafka-source.ts`)
 * drives. The loop talks to sammy-pack only through the `httpDeliver`
 * narrow waist — so kafkajs never enters the sammy-pack core.
 *
 * Use the CLI (`sammy-source-kafka`, see bin/run.ts) for the
 * out-of-process default, or call `startKafkaSource` to embed the loop in
 * your own runner.
 */

import { Kafka, type Consumer, type KafkaConfig, logLevel } from 'kafkajs';
import { makeHttpDeliver, type DeliverSigning } from '@sammy-pack/sdk';
import {
  runKafkaConsumer,
  type KafkaConsumerLike,
  type KafkaIncomingMessage,
  type KafkaSourceConfig,
} from './kafka-source.js';

export {
  runKafkaConsumer,
  deliverAndCommit,
  KafkaSource,
  type KafkaConsumerLike,
  type KafkaIncomingMessage,
  type KafkaSourceConfig,
  type KafkaPoisonPolicy,
  type DeliverOutcome,
} from './kafka-source.js';

/** kafkajs groups partitions per topic ([{ topic, partitions: [] }]) while
 *  the loop speaks flat { topic, partition } pairs. Shared by pause+resume so
 *  the two can never disagree about the shape. */
function groupByTopic(
  topicPartitions: Array<{ topic: string; partition: number }>,
): Array<{ topic: string; partitions: number[] }> {
  const byTopic = new Map<string, number[]>();
  for (const { topic, partition } of topicPartitions) {
    const arr = byTopic.get(topic) ?? [];
    arr.push(partition);
    byTopic.set(topic, arr);
  }
  return [...byTopic.entries()].map(([topic, partitions]) => ({ topic, partitions }));
}

/** Wrap a connected kafkajs `Consumer` (subscribed to `topic`) as the
 *  minimal `KafkaConsumerLike` surface. Auto-commit MUST be off — the loop
 *  commits explicitly only after a 2xx. */
export function kafkaConsumerAdapter(consumer: Consumer): KafkaConsumerLike {
  return {
    onStopped(cb): void {
      // kafkajs retries most failures itself and re-emits CRASH with
      // `restart: true`; only a non-restarting crash means this consumer is
      // really finished and the loop should stop waiting on it.
      consumer.on(consumer.events.CRASH, ({ payload }) => {
        if (payload?.restart === false) cb(payload.error);
      });
    },
    async run(handler): Promise<void> {
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          const msg: KafkaIncomingMessage = {
            topic,
            partition,
            offset: message.offset,
            value: message.value ? message.value.toString('utf8') : '',
            key: message.key ? message.key.toString('utf8') : undefined,
          };
          await handler.eachMessage(msg);
        },
      });
    },
    async commitOffsets(offsets): Promise<void> {
      await consumer.commitOffsets(offsets);
    },
    pause(topicPartitions): void {
      consumer.pause(groupByTopic(topicPartitions));
    },
    resume(topicPartitions): void {
      consumer.resume(groupByTopic(topicPartitions));
    },
    async disconnect(): Promise<void> {
      await consumer.disconnect();
    },
  };
}

export interface StartKafkaSourceOptions {
  /** Kafka bootstrap brokers, e.g. ["broker-1:9092", "broker-2:9092"]. */
  brokers: string[];
  /** Topic to consume from. */
  topic: string;
  /** Consumer group id. Defaults to "sammy-pack". */
  groupId?: string;
  /** Start at the earliest offset on first run. Default false (latest). */
  fromBeginning?: boolean;
  /** sammy-pack server base URL, e.g. "http://localhost:5173". */
  baseUrl: string;
  /** The `queue` trigger name — messages land at `/api/queue/<deliverTo>`. */
  deliverTo: string;
  /** HMAC secret for a `"signed": true` queue trigger. */
  signing?: DeliverSigning;
  /** Extra kafkajs client config (ssl, sasl, clientId, …) merged in. */
  kafka?: Partial<KafkaConfig>;
  /** Tuning for the consume loop. */
  loop?: KafkaSourceConfig;
  /** Provide a pre-built consumer (already created from a Kafka client).
   *  When omitted, a client + consumer are created from `brokers`/`groupId`. */
  consumer?: Consumer;
  /** Abort to stop the loop. When omitted, the loop runs until the process
   *  is killed (the CLI wires SIGINT/SIGTERM to an internal controller). */
  signal?: AbortSignal;
}

/**
 * Start consuming a Kafka topic and delivering to a sammy-pack `queue`
 * trigger. Resolves when the loop stops (signal aborted → disconnect).
 * subscribe → `deliver()` each → commit offset (ack) only on 2xx.
 */
export async function startKafkaSource(opts: StartKafkaSourceOptions): Promise<void> {
  let consumer = opts.consumer;
  if (!consumer) {
    const kafka = new Kafka({
      brokers: opts.brokers,
      clientId: opts.kafka?.clientId ?? 'sammy-source-kafka',
      logLevel: opts.kafka?.logLevel ?? logLevel.WARN,
      ...opts.kafka,
    });
    consumer = kafka.consumer({ groupId: opts.groupId ?? 'sammy-pack' });
    await consumer.connect();
    await consumer.subscribe({
      topic: opts.topic,
      fromBeginning: opts.fromBeginning ?? false,
    });
  }

  const adapter = kafkaConsumerAdapter(consumer);
  const deliver = makeHttpDeliver({
    baseUrl: opts.baseUrl,
    queue: opts.deliverTo,
    signing: opts.signing,
  });
  const controller = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? controller!.signal;
  await runKafkaConsumer(adapter, deliver, signal, opts.loop);
}
