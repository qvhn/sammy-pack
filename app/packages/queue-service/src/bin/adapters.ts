/**
 * First-party adapter shims for the CLI.
 *
 * Each entry lazily turns a `@sammy-pack/source-<name>` package into a
 * `SourceFactory` the runtime can host. The broker package is loaded with
 * a DYNAMIC import of a runtime-computed specifier, so:
 *   - no broker SDK is a static dependency of `@sammy-pack/queue-service`
 *     (the whole point — the runtime stays broker-agnostic), and
 *   - an adapter that isn't installed simply fails to load with a clear
 *     "is it installed?" message (handled by the CLI), instead of a
 *     compile-time missing-module error here.
 *
 * The shim's job is purely to translate a declarative binding's `config`
 * (+ resolved `credential`) into the arguments that adapter's
 * `start*Source` entry expects, and adapt it to the `QueueSource`
 * contract. Adding a first-party adapter = one entry here. Arbitrary /
 * third-party sources are registered programmatically by embedding the
 * runtime (see the README); CLI auto-discovery is a documented follow-on.
 */

import type { SourceFactory, ResolvedCredential } from '../types.js';

/** Dynamic import of a package by a runtime-computed specifier, so TS does
 *  not try to resolve a (possibly not-yet-installed) module at build time. */
async function loadPackage(name: string): Promise<Record<string, unknown>> {
  const specifier = name; // computed → typed `any`, not statically resolved
  return (await import(specifier)) as Record<string, unknown>;
}

/** Pull `region` from a resolved credential (fields or top-level extras). */
function credRegion(cred: ResolvedCredential | undefined): string | undefined {
  return cred?.fields?.region ?? cred?.extras?.ssoRegion;
}

/** SQS: wrap `@sammy-pack/source-sqs#startSqsSource`. Binding config:
 *  `{ queueUrl, region? }`; region also taken from the credential. */
async function loadSqs(): Promise<SourceFactory> {
  const mod = await loadPackage('@sammy-pack/source-sqs');
  const startSqsSource = mod.startSqsSource as (opts: {
    queueUrl: string;
    deliverTo: string;
    baseUrl: string;
    region?: string;
    signing?: { secret: string };
    signal?: AbortSignal;
  }) => Promise<void>;
  if (typeof startSqsSource !== 'function') {
    throw new Error('@sammy-pack/source-sqs has no startSqsSource export');
  }
  return ({ config, credential, deliversTo, baseUrl, signingSecret }) => {
    const queueUrl = config.queueUrl as string | undefined;
    if (!queueUrl) throw new Error('sqs binding requires "queueUrl"');
    const region = (config.region as string | undefined) ?? credRegion(credential);
    return {
      kind: 'sqs',
      start: ({ signal }) =>
        startSqsSource({
          queueUrl,
          deliverTo: deliversTo,
          baseUrl,
          region,
          signing: signingSecret ? { secret: signingSecret } : undefined,
          signal,
        }),
    };
  };
}

/** Kafka: wrap `@sammy-pack/source-kafka#startKafkaSource`. Binding config:
 *  `{ brokers, topic, groupId?, fromBeginning? }`. */
async function loadKafka(): Promise<SourceFactory> {
  const mod = await loadPackage('@sammy-pack/source-kafka');
  const startKafkaSource = mod.startKafkaSource as (opts: {
    brokers: string[];
    topic: string;
    groupId?: string;
    fromBeginning?: boolean;
    deliverTo: string;
    baseUrl: string;
    signing?: { secret: string };
    signal?: AbortSignal;
  }) => Promise<void>;
  if (typeof startKafkaSource !== 'function') {
    throw new Error('@sammy-pack/source-kafka has no startKafkaSource export');
  }
  return ({ config, deliversTo, baseUrl, signingSecret }) => {
    const brokers = normalizeBrokers(config.brokers);
    const topic = config.topic as string | undefined;
    if (brokers.length === 0) throw new Error('kafka binding requires "brokers"');
    if (!topic) throw new Error('kafka binding requires "topic"');
    return {
      kind: 'kafka',
      start: ({ signal }) =>
        startKafkaSource({
          brokers,
          topic,
          groupId: config.groupId as string | undefined,
          fromBeginning: config.fromBeginning as boolean | undefined,
          deliverTo: deliversTo,
          baseUrl,
          signing: signingSecret ? { secret: signingSecret } : undefined,
          signal,
        }),
    };
  };
}

/** RabbitMQ: wrap `@sammy-pack/source-rabbitmq#startRabbitSource`. Binding
 *  config: `{ url, queue, prefetch? }`. */
async function loadRabbit(): Promise<SourceFactory> {
  const mod = await loadPackage('@sammy-pack/source-rabbitmq');
  const startRabbitSource = mod.startRabbitSource as (opts: {
    url: string;
    queue: string;
    prefetch?: number;
    deliverTo: string;
    baseUrl: string;
    signing?: { secret: string };
    signal?: AbortSignal;
  }) => Promise<void>;
  if (typeof startRabbitSource !== 'function') {
    throw new Error('@sammy-pack/source-rabbitmq has no startRabbitSource export');
  }
  return ({ config, credential, deliversTo, baseUrl, signingSecret }) => {
    const url = (config.url as string | undefined) ?? credential?.value;
    const queue = config.queue as string | undefined;
    if (!url) throw new Error('rabbitmq binding requires "url" (or a credentialRef value)');
    if (!queue) throw new Error('rabbitmq binding requires "queue"');
    return {
      kind: 'rabbitmq',
      start: ({ signal }) =>
        startRabbitSource({
          url,
          queue,
          prefetch: config.prefetch as number | undefined,
          deliverTo: deliversTo,
          baseUrl,
          signing: signingSecret ? { secret: signingSecret } : undefined,
          signal,
        }),
    };
  };
}

function normalizeBrokers(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/** name → lazy SourceFactory loader. */
export const firstPartyAdapters: Record<string, () => Promise<SourceFactory>> = {
  sqs: loadSqs,
  kafka: loadKafka,
  rabbitmq: loadRabbit,
  rabbit: loadRabbit, // alias
};
