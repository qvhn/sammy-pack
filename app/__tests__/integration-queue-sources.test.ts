/**
 * QUEUE-SOURCE INTEGRATION — real brokers, real client libraries.
 *
 * SKIPPED unless the matching broker env var is set (same convention as
 * postgres-store.test.ts). Bring the brokers up first:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait
 *   cd app && npm run test:integration
 *   docker compose -f docker-compose.test.yml down -v
 *
 * WHY THIS EXISTS: every adapter's unit test drives its consume loop
 * against a MOCK (`KafkaConsumerLike` / `RabbitChannelLike` / `SqsLike`).
 * That proves the ack / retry / poison semantics, but never executes a
 * single line of kafkajs, amqplib or the AWS SDK — so `kafkaConsumerAdapter`,
 * `rabbitChannelAdapter` and `sqsClientAdapter`, the glue between the real
 * libraries and those interfaces, were entirely unverified. That glue is
 * precisely what a client-library upgrade breaks, and a mock can never
 * catch it.
 *
 * Each case traces the WHOLE chain and nothing less:
 *   real broker message
 *     → real client library
 *     → the adapter under test
 *     → HTTP deliver to /api/queue/<name>
 *     → trigger ingress → durable delivery → worker claim
 *     → orchestration RUN reaching `done`, carrying the message body.
 *
 * The in-process delivery worker is enabled (the harness pins it off), so
 * "accepted" is not mistaken for "executed".
 */

import { promises as fs } from 'node:fs';
import {
  destroySammyCronTasks,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  writeOrchestration,
  type Mount,
  type RunListEntry,
} from './lifecycle-harness.helpers';

jest.setTimeout(120_000);

/* The broker clients and the adapters are loaded with `require` INSIDE each
 * case, the convention the rest of the suite uses (see otlp-trace.test.ts),
 * for two reasons: a dynamic `import()` throws
 * "A dynamic import callback was invoked without --experimental-vm-modules"
 * under this CJS jest setup, and a top-level static import would pull
 * kafkajs + amqplib + the AWS SDK into every ordinary `npm test` run, where
 * these suites are skipped. */
/* eslint-disable @typescript-eslint/no-require-imports */

const KAFKA_BROKERS = process.env.TEST_KAFKA_BROKERS; // 127.0.0.1:19092
const AMQP_URL = process.env.TEST_AMQP_URL; //           amqp://127.0.0.1:5673
const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT; //   http://127.0.0.1:9324

const kafkaSuite = KAFKA_BROKERS ? describe : describe.skip;
const rabbitSuite = AMQP_URL ? describe : describe.skip;
const sqsSuite = SQS_ENDPOINT ? describe : describe.skip;

/** A workspace whose orchestration fires off a `queue` trigger and echoes
 *  the delivered body, so we can prove the payload made the whole trip. */
async function mountWithQueueTrigger(
  label: string,
  queueName: string,
): Promise<{ mount: Mount; tmpRoot: string; orch: string }> {
  const tmpRoot = await makeWorkspace(`it-${label}`);
  const orch = `it-${label}`;
  await writeOrchestration(tmpRoot, {
    name: orch,
    triggers: [{ kind: 'queue', queue: queueName }],
    phases: [{ name: 'echo', code: { source: "return 'got:' + (input || '');" } }],
  });
  const mount = await mountServer(tmpRoot);
  return { mount, tmpRoot, orch };
}

const waitForDoneRun = (mount: Mount, orch: string, label: string): Promise<RunListEntry> =>
  waitFor(
    async () =>
      (await listRuns(mount.baseUrl)).find(
        r => r.orchestrationName === orch && r.status === 'done',
      ) ?? null,
    label,
    { timeoutMs: 60_000, intervalMs: 200 },
  );

let restoreEnv: () => void;
beforeAll(() => {
  restoreEnv = pinTestEnv();
  // These suites are specifically about delivery → RUN.
  delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
});
afterAll(() => {
  destroySammyCronTasks();
  restoreEnv();
});

kafkaSuite('Kafka source (real broker via kafkajs)', () => {
  const TOPIC = `sammy-it-${Date.now()}`;
  const QUEUE_TRIGGER = 'it-kafka-jobs';
  let mount: Mount;
  let tmpRoot: string;
  let orch: string;
  const stop = new AbortController();
  let loop: Promise<void> | undefined;

  afterAll(async () => {
    stop.abort();
    await loop?.catch(() => {});
    await mount?.kill();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('a produced record runs the orchestration with the record value as input', async () => {
    const { Kafka, logLevel } = require('kafkajs') as typeof import('kafkajs');
    const { startKafkaSource } =
      require('../packages/source-kafka/src/index') as typeof import('../packages/source-kafka/src/index');

    ({ mount, tmpRoot, orch } = await mountWithQueueTrigger('kafka', QUEUE_TRIGGER));

    const kafka = new Kafka({
      brokers: KAFKA_BROKERS!.split(','),
      clientId: 'sammy-it',
      logLevel: logLevel.NOTHING,
    });

    // Create the topic explicitly rather than relying on auto-create, so a
    // failure here is a broker problem and not a race.
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
    await admin.disconnect();

    // `fromBeginning` so the record is seen regardless of whether the
    // consumer finished joining the group before it was produced.
    loop = startKafkaSource({
      brokers: KAFKA_BROKERS!.split(','),
      topic: TOPIC,
      groupId: `sammy-it-${Date.now()}`,
      fromBeginning: true,
      baseUrl: mount.baseUrl,
      deliverTo: QUEUE_TRIGGER,
      kafka: { logLevel: logLevel.NOTHING },
      signal: stop.signal,
    });

    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPIC,
      messages: [{ value: '{"job":"kafka-payload"}' }],
    });
    await producer.disconnect();

    const run = await waitForDoneRun(mount, orch, 'kafka record → done run');
    expect(run.initialInput ?? '').toContain('kafka-payload');

    // The loop must still be pending: `await startKafkaSource(...)` spans the
    // source's WHOLE life. Against a real client it used to resolve the
    // moment the fetch loop started — so a CLI logged "stopped" at startup,
    // the queue-service supervisor saw the binding end immediately, and the
    // shutdown disconnect was fire-and-forget. Only a real broker shows
    // this; the mock's run() resolved to mean "finished".
    const stillRunning = await Promise.race([
      loop.then(() => 'resolved' as const),
      new Promise<'live'>(r => setTimeout(() => r('live'), 100)),
    ]);
    expect(stillRunning).toBe('live');
  });

  it('aborting the signal disconnects the consumer and resolves the loop', async () => {
    // The afterAll teardown relies on this: an un-awaited disconnect leaves
    // kafkajs heartbeating after the test env is gone (which is what first
    // surfaced the bug — jest refused to exit).
    stop.abort();
    await expect(loop).resolves.toBeUndefined();
  });
});

rabbitSuite('RabbitMQ source (real broker via amqplib)', () => {
  const QUEUE = `sammy-it-${Date.now()}`;
  const QUEUE_TRIGGER = 'it-rabbit-jobs';
  let mount: Mount;
  let tmpRoot: string;
  let orch: string;
  const stop = new AbortController();
  let loop: Promise<void> | undefined;

  afterAll(async () => {
    stop.abort();
    await loop?.catch(() => {});
    await mount?.kill();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('a published message runs the orchestration with the body as input', async () => {
    const amqp = require('amqplib') as typeof import('amqplib');
    const { startRabbitSource } =
      require('../packages/source-rabbitmq/src/index') as typeof import('../packages/source-rabbitmq/src/index');

    ({ mount, tmpRoot, orch } = await mountWithQueueTrigger('rabbit', QUEUE_TRIGGER));

    // The adapter consumes an EXISTING queue, so declare it first.
    const conn = await amqp.connect(AMQP_URL!);
    const ch = await conn.createChannel();
    await ch.assertQueue(QUEUE, { durable: false });

    loop = startRabbitSource({
      url: AMQP_URL!,
      queue: QUEUE,
      baseUrl: mount.baseUrl,
      deliverTo: QUEUE_TRIGGER,
      signal: stop.signal,
    });

    ch.sendToQueue(QUEUE, Buffer.from('{"job":"rabbit-payload"}'));
    await ch.close();
    await conn.close();

    const run = await waitForDoneRun(mount, orch, 'rabbit message → done run');
    expect(run.initialInput ?? '').toContain('rabbit-payload');
  });
});

sqsSuite('SQS source (real SQS-compatible endpoint via @aws-sdk/client-sqs)', () => {
  const QUEUE_TRIGGER = 'it-sqs-jobs';
  let mount: Mount;
  let tmpRoot: string;
  let orch: string;
  const stop = new AbortController();
  let loop: Promise<void> | undefined;

  afterAll(async () => {
    stop.abort();
    await loop?.catch(() => {});
    await mount?.kill();
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('a sent message runs the orchestration with the body as input', async () => {
    const { SQSClient, CreateQueueCommand, SendMessageCommand } =
      require('@aws-sdk/client-sqs') as typeof import('@aws-sdk/client-sqs');
    const { startSqsSource } =
      require('../packages/source-sqs/src/index') as typeof import('../packages/source-sqs/src/index');

    ({ mount, tmpRoot, orch } = await mountWithQueueTrigger('sqs', QUEUE_TRIGGER));

    // ElasticMQ ignores credentials but the SDK requires them to be present.
    const client = new SQSClient({
      endpoint: SQS_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const created = await client.send(
      new CreateQueueCommand({ QueueName: `sammy-it-${Date.now()}` }),
    );
    const queueUrl = created.QueueUrl!;
    expect(queueUrl).toBeTruthy();

    loop = startSqsSource({
      queueUrl,
      baseUrl: mount.baseUrl,
      deliverTo: QUEUE_TRIGGER,
      client,
      // Short poll so the test isn't waiting on a 20s long-poll window.
      loop: { waitTimeSeconds: 1 },
      signal: stop.signal,
    });

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{"job":"sqs-payload"}',
      }),
    );

    const run = await waitForDoneRun(mount, orch, 'sqs message → done run');
    expect(run.initialInput ?? '').toContain('sqs-payload');
  });
});
