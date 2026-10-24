#!/usr/bin/env node
/**
 * sammy-source-rabbitmq — standalone out-of-process RabbitMQ → sammy-pack
 * runner.
 *
 * Runs the AMQP consume-loop in ITS OWN process so broker flakiness never
 * touches the orchestration server. It only speaks the HTTP narrow waist
 * (`POST /api/queue/<deliver-to>`), so it can run anywhere with network
 * access to the server + the RabbitMQ broker.
 *
 * Usage:
 *   sammy-source-rabbitmq \
 *     --url         amqp://user:pass@host:5672/vhost \
 *     --queue       orders \
 *     --deliver-to  orders-trigger \
 *     --base-url    http://localhost:5173 \
 *     [--prefetch 10] \
 *     [--secret <hmac>]        # or SAMMY_WEBHOOK_SECRET env, for signed triggers
 *     [--sig-scheme v2|v1]     # default v2 (replay-protected)
 *
 * The AMQP URL carries the broker credentials; prefer passing it via env
 * (e.g. --url "$RABBIT_URL") so it isn't visible in the process list. No
 * secrets are read from argv beyond the optional HMAC.
 */

import { startRabbitSource } from '../index.js';
import type { DeliverSigning } from '@sammy-pack/sdk';

interface Args {
  url?: string;
  queue?: string;
  deliverTo?: string;
  baseUrl?: string;
  prefetch?: number;
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
      case '--url':
        args.url = next();
        break;
      case '--queue':
        args.queue = next();
        break;
      case '--deliver-to':
        args.deliverTo = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--prefetch': {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) throw new Error('--prefetch must be a number');
        args.prefetch = Math.floor(n);
        break;
      }
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
    'sammy-source-rabbitmq — RabbitMQ → sammy-pack queue-trigger runner',
    '',
    'Required:',
    '  --url         <url>   AMQP connection URL (carries credentials)',
    '  --queue       <name>  RabbitMQ queue to consume',
    '  --deliver-to  <name>  sammy-pack queue trigger name',
    '  --base-url    <url>   sammy-pack server base URL',
    '',
    'Optional:',
    '  --prefetch    <n>     max unacked in flight (default 10)',
    '  --secret      <s>     HMAC secret for a signed queue trigger',
    '                        (or set SAMMY_WEBHOOK_SECRET)',
    '  --sig-scheme  v2|v1   signature scheme (default v2)',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(usage);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing = (['url', 'queue', 'deliverTo', 'baseUrl'] as const).filter(k => !args[k]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `missing required flag(s): ${missing
        .map(m => `--${m.replace(/([A-Z])/g, '-$1').toLowerCase()}`)
        .join(', ')}\n`,
    );
    printUsageAndExit(1);
  }

  const secret = args.secret ?? process.env.SAMMY_WEBHOOK_SECRET;
  const signing: DeliverSigning | undefined = secret
    ? { secret, scheme: args.sigScheme ?? 'v2' }
    : undefined;

  const controller = new AbortController();
  const stop = (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[source-rabbitmq] ${sig} — shutting down`);
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // eslint-disable-next-line no-console
  console.log(
    `[source-rabbitmq] consuming ${args.queue} → ` +
      `${args.baseUrl}/api/queue/${args.deliverTo}` +
      (signing ? ` (signed ${signing.scheme})` : ''),
  );

  await startRabbitSource({
    url: args.url!,
    queue: args.queue!,
    deliverTo: args.deliverTo!,
    baseUrl: args.baseUrl!,
    prefetch: args.prefetch,
    signing,
    signal: controller.signal,
  });

  // eslint-disable-next-line no-console
  console.log('[source-rabbitmq] stopped');
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[source-rabbitmq] fatal:', err);
  process.exit(1);
});
