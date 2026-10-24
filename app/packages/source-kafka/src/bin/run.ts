#!/usr/bin/env node
/**
 * sammy-source-kafka — standalone out-of-process Kafka → sammy-pack runner.
 *
 * Runs the Kafka consume-loop in ITS OWN process so broker flakiness never
 * touches the orchestration server. It only speaks the HTTP narrow waist
 * (`POST /api/queue/<deliver-to>`), so it can run anywhere with network
 * access to the server + the Kafka brokers.
 *
 * Usage:
 *   sammy-source-kafka \
 *     --brokers     broker-1:9092,broker-2:9092 \
 *     --topic       orders \
 *     --deliver-to  orders-trigger \
 *     --base-url    http://localhost:5173 \
 *     [--group-id sammy-pack] \
 *     [--from-beginning] \
 *     [--secret <hmac>]        # or SAMMY_WEBHOOK_SECRET env, for signed triggers
 *     [--sig-scheme v2|v1]     # default v2 (replay-protected)
 *
 * SASL/SSL: set via env for the kafkajs default client (or embed
 * `startKafkaSource` with a `kafka:` config block). No secrets are read
 * from argv beyond the optional HMAC.
 */

import { startKafkaSource } from '../index.js';
import type { DeliverSigning } from '@sammy-pack/sdk';

interface Args {
  brokers?: string;
  topic?: string;
  deliverTo?: string;
  baseUrl?: string;
  groupId?: string;
  fromBeginning?: boolean;
  secret?: string;
  sigScheme?: 'v1' | 'v2';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--brokers':
        args.brokers = next();
        break;
      case '--topic':
        args.topic = next();
        break;
      case '--deliver-to':
        args.deliverTo = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--group-id':
        args.groupId = next();
        break;
      case '--from-beginning':
        args.fromBeginning = true;
        break;
      case '--secret':
        args.secret = next();
        break;
      case '--sig-scheme': {
        const v = next();
        if (v !== 'v1' && v !== 'v2') throw new Error(`--sig-scheme must be v1 or v2`);
        args.sigScheme = v;
        break;
      }
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function printUsageAndExit(code: number): never {
  const usage = [
    'sammy-source-kafka — Kafka → sammy-pack queue-trigger runner',
    '',
    'Required:',
    '  --brokers     <list>  comma-separated bootstrap brokers',
    '  --topic       <name>  Kafka topic to consume',
    '  --deliver-to  <name>  sammy-pack queue trigger name',
    '  --base-url    <url>   sammy-pack server base URL',
    '',
    'Optional:',
    '  --group-id      <id>  consumer group id (default sammy-pack)',
    '  --from-beginning      start at earliest offset on first run',
    '  --secret        <s>   HMAC secret for a signed queue trigger',
    '                        (or set SAMMY_WEBHOOK_SECRET)',
    '  --sig-scheme    v2|v1 signature scheme (default v2)',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(usage);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing = (['brokers', 'topic', 'deliverTo', 'baseUrl'] as const).filter(
    k => !args[k],
  );
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `missing required flag(s): ${missing
        .map(m => `--${m.replace(/([A-Z])/g, '-$1').toLowerCase()}`)
        .join(', ')}\n`,
    );
    printUsageAndExit(1);
  }

  const brokers = args.brokers!.split(',').map(s => s.trim()).filter(Boolean);
  if (brokers.length === 0) {
    // eslint-disable-next-line no-console
    console.error('--brokers must list at least one broker\n');
    printUsageAndExit(1);
  }

  const secret = args.secret ?? process.env.SAMMY_WEBHOOK_SECRET;
  const signing: DeliverSigning | undefined = secret
    ? { secret, scheme: args.sigScheme ?? 'v2' }
    : undefined;

  const controller = new AbortController();
  const stop = (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[source-kafka] ${sig} — shutting down`);
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // eslint-disable-next-line no-console
  console.log(
    `[source-kafka] consuming ${args.topic} @ ${brokers.join(',')} → ` +
      `${args.baseUrl}/api/queue/${args.deliverTo}` +
      (signing ? ` (signed ${signing.scheme})` : ''),
  );

  await startKafkaSource({
    brokers,
    topic: args.topic!,
    deliverTo: args.deliverTo!,
    baseUrl: args.baseUrl!,
    groupId: args.groupId,
    fromBeginning: args.fromBeginning,
    signing,
    signal: controller.signal,
  });

  // eslint-disable-next-line no-console
  console.log('[source-kafka] stopped');
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[source-kafka] fatal:', err);
  process.exit(1);
});
