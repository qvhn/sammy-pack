#!/usr/bin/env node
/**
 * sammy-source-sqs — standalone out-of-process SQS → sammy-pack runner.
 *
 * Runs the SQS consume-loop in ITS OWN process so broker flakiness never
 * touches the orchestration server. It only speaks the HTTP narrow waist
 * (`POST /api/queue/<deliver-to>`), so it can run anywhere with network
 * access to the server + AWS — a sidecar, a separate host, a CronJob.
 *
 * Usage:
 *   sammy-source-sqs \
 *     --queue-url   https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
 *     --deliver-to  my-queue-trigger \
 *     --base-url    http://localhost:5173 \
 *     [--region us-east-1] \
 *     [--secret <hmac>]        # or SAMMY_WEBHOOK_SECRET env, for signed triggers
 *     [--sig-scheme v2|v1]     # default v2 (replay-protected)
 *
 * AWS credentials resolve via the standard SDK chain (env vars, shared
 * config/credentials, instance/role). No credentials are read from argv.
 */

import { startSqsSource } from '../index.js';
import type { DeliverSigning } from '@sammy-pack/sdk';

interface Args {
  queueUrl?: string;
  deliverTo?: string;
  baseUrl?: string;
  region?: string;
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
      case '--queue-url':
        args.queueUrl = next();
        break;
      case '--deliver-to':
        args.deliverTo = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--region':
        args.region = next();
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
    'sammy-source-sqs — SQS → sammy-pack queue-trigger runner',
    '',
    'Required:',
    '  --queue-url   <url>   SQS queue URL to consume',
    '  --deliver-to  <name>  sammy-pack queue trigger name',
    '  --base-url    <url>   sammy-pack server base URL',
    '',
    'Optional:',
    '  --region      <r>     AWS region (else SDK default chain)',
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
  const missing = (['queueUrl', 'deliverTo', 'baseUrl'] as const).filter(k => !args[k]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`missing required flag(s): ${missing.map(m => `--${m.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}\n`);
    printUsageAndExit(1);
  }

  const secret = args.secret ?? process.env.SAMMY_WEBHOOK_SECRET;
  const signing: DeliverSigning | undefined = secret
    ? { secret, scheme: args.sigScheme ?? 'v2' }
    : undefined;

  const controller = new AbortController();
  const stop = (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[source-sqs] ${sig} — shutting down`);
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // eslint-disable-next-line no-console
  console.log(
    `[source-sqs] consuming ${args.queueUrl} → ${args.baseUrl}/api/queue/${args.deliverTo}` +
      (signing ? ` (signed ${signing.scheme})` : ''),
  );

  await startSqsSource({
    queueUrl: args.queueUrl!,
    deliverTo: args.deliverTo!,
    baseUrl: args.baseUrl!,
    region: args.region,
    signing,
    signal: controller.signal,
  });

  // eslint-disable-next-line no-console
  console.log('[source-sqs] stopped');
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[source-sqs] fatal:', err);
  process.exit(1);
});
