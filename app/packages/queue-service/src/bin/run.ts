#!/usr/bin/env node
/**
 * sammy-queue-service — run a declarative `sources` binding as a single
 * out-of-process connector host.
 *
 * Reads a config file (a workspace JSON, or any JSON with a `sources`
 * array), resolves each binding's `credentialRef` from the credential
 * registry, registers the matching first-party adapter (dynamically
 * imported so its broker SDK is NOT a dependency of this package), and
 * hosts every consume loop until SIGINT/SIGTERM.
 *
 * Usage:
 *   sammy-queue-service \
 *     --config    ./workspace.json     # JSON containing { "sources": [...] }
 *     --base-url  http://localhost:5173 \
 *     [--connections ./credentials.json]   # else SAMMY_CONNECTIONS_FILE / cwd
 *     [--secret <hmac>]                     # else SAMMY_WEBHOOK_SECRET
 *     [--dry-run]                           # validate + resolve, don't start
 *
 * Each `sources` entry:
 *   { "source": "sqs", "queueUrl": "...", "credentialRef": "aws-prod",
 *     "deliversTo": "my-queue-trigger" }
 *
 * The first-party adapter shims below dynamic-import the broker package
 * (`@sammy-pack/source-<source>`); install the ones you reference. Any
 * other `source` name must be registered programmatically (embed the
 * runtime) — auto-discovery is a documented follow-on.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  QueueService,
  SourceRegistry,
  defaultFileCredentialResolver,
  resolveCredentialsFile,
  validateBindings,
  type SourceBinding,
  type SourceFactory,
} from '../index.js';
import { firstPartyAdapters } from './adapters.js';

interface Args {
  config?: string;
  baseUrl?: string;
  connections?: string;
  secret?: string;
  dryRun?: boolean;
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
      case '--config':
        args.config = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--connections':
        args.connections = next();
        break;
      case '--secret':
        args.secret = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
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
    'sammy-queue-service — host a declarative `sources` binding',
    '',
    'Required:',
    '  --config     <path>  JSON file with a "sources": [...] array',
    '  --base-url   <url>   sammy-pack server base URL',
    '',
    'Optional:',
    '  --connections <path> credential registry file',
    '                       (else SAMMY_CONNECTIONS_FILE / <cwd>/credentials.json)',
    '  --secret      <s>    HMAC secret for signed queue triggers',
    '                       (else SAMMY_WEBHOOK_SECRET)',
    '  --dry-run            validate bindings + resolve creds, do not start',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(usage);
  process.exit(code);
}

/** Read the `sources` array out of a config/workspace JSON. */
async function readBindings(file: string): Promise<SourceBinding[]> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const sources =
    raw && typeof raw === 'object' && Array.isArray((raw as { sources?: unknown }).sources)
      ? ((raw as { sources: unknown[] }).sources as SourceBinding[])
      : null;
  if (!sources) {
    throw new Error(`${file} has no "sources" array`);
  }
  return sources;
}

/** Build a registry containing only the first-party adapters the bindings
 *  actually reference, importing each lazily so an unreferenced broker
 *  SDK is never loaded. */
async function buildRegistry(bindings: SourceBinding[]): Promise<SourceRegistry> {
  const registry = new SourceRegistry();
  const wanted = new Set(bindings.map(b => b.source).filter(Boolean));
  for (const name of wanted) {
    const loader = firstPartyAdapters[name];
    if (!loader) continue; // validateBindings will report the unknown source
    let factory: SourceFactory;
    try {
      factory = await loader();
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(
        `source "${name}" is referenced but its adapter package ` +
          `(@sammy-pack/source-${name}) could not be loaded — is it installed? (${msg})`,
      );
    }
    registry.register(name, factory);
  }
  return registry;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing = (['config', 'baseUrl'] as const).filter(k => !args[k]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `missing required flag(s): ${missing
        .map(m => `--${m.replace(/([A-Z])/g, '-$1').toLowerCase()}`)
        .join(', ')}\n`,
    );
    printUsageAndExit(1);
  }

  const bindings = await readBindings(path.resolve(args.config!));
  const registry = await buildRegistry(bindings);

  const problems = validateBindings(bindings, registry);
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`invalid sources binding:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  const connectionsFile = args.connections
    ? path.resolve(args.connections)
    : resolveCredentialsFile();
  const secret = args.secret ?? process.env.SAMMY_WEBHOOK_SECRET;

  const svc = new QueueService({
    registry,
    bindings,
    baseUrl: args.baseUrl!,
    credentialResolver: defaultFileCredentialResolver(connectionsFile),
    signingSecret: secret,
    log: m => console.log(`[queue-service] ${m}`),
  });

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(
      `[queue-service] dry-run OK — ${bindings.length} binding(s) valid; ` +
        `adapters: ${registry.names().join(', ') || 'none'}`,
    );
    return;
  }

  const stop = async (sig: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[queue-service] ${sig} — shutting down`);
    await svc.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  const { started, failed } = await svc.start();
  // eslint-disable-next-line no-console
  console.log(
    `[queue-service] ${started} connector(s) running → ${args.baseUrl}` +
      (failed.length ? ` (${failed.length} failed to start)` : '') +
      (secret ? ' (signed)' : ''),
  );
  if (started === 0 && failed.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[queue-service] fatal:', err);
  process.exit(1);
});
