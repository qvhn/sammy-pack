/**
 * Connector-runtime unit tests.
 *
 * The runtime is driven against TWO fake `QueueSource` adapters + a mock
 * credential resolver — no broker SDK, no sammy-pack server. Under test:
 *   - lifecycle: start launches each source's loop; stop aborts + awaits
 *     every loop (and the contract's "resolve on clean shutdown" holds);
 *   - binding resolution: the right factory is selected per `source`,
 *     adapter-specific config + the resolved credential reach the factory,
 *     and reserved keys (source/deliversTo/credentialRef) are stripped;
 *   - validation: unknown source / missing fields are reported, and a
 *     credentialRef with no resolver is an error.
 *
 * Type-only imports from `@sammy-pack/sdk` are erased by the babel TS
 * transform, so this runs with nothing extra installed.
 */

import {
  QueueService,
  SourceRegistry,
  validateBindings,
  type SourceBinding,
  type SourceFactory,
  type CredentialResolver,
} from '../src/index';
import type { QueueSource, DeliverFn } from '@sammy-pack/sdk';

/** A fake source whose loop blocks until aborted, recording how it was
 *  constructed + whether it saw a usable `deliver`. */
function makeFakeSource(kind: string) {
  const calls: Array<{
    config: Record<string, unknown>;
    credential: unknown;
    deliversTo: string;
    baseUrl: string;
    signingSecret?: string;
  }> = [];
  let started = 0;
  let aborted = 0;
  let sawDeliver = false;

  const factory: SourceFactory = args => {
    calls.push({
      config: args.config,
      credential: args.credential,
      deliversTo: args.deliversTo,
      baseUrl: args.baseUrl,
      signingSecret: args.signingSecret,
    });
    const source: QueueSource = {
      kind,
      start: ({ deliver, signal }: { deliver: DeliverFn; signal: AbortSignal }) => {
        started += 1;
        sawDeliver = typeof deliver === 'function';
        return new Promise<void>(resolve => {
          if (signal.aborted) {
            aborted += 1;
            return resolve();
          }
          signal.addEventListener('abort', () => {
            aborted += 1;
            resolve();
          });
        });
      },
    };
    return source;
  };

  return {
    factory,
    get calls() {
      return calls;
    },
    get started() {
      return started;
    },
    get aborted() {
      return aborted;
    },
    get sawDeliver() {
      return sawDeliver;
    },
  };
}

describe('QueueService lifecycle + binding resolution', () => {
  it('starts the right adapter per binding and stops cleanly', async () => {
    const sqs = makeFakeSource('sqs');
    const kafka = makeFakeSource('kafka');
    const registry = new SourceRegistry()
      .register('sqs', sqs.factory)
      .register('kafka', kafka.factory);

    const bindings: SourceBinding[] = [
      { source: 'sqs', deliversTo: 'q-a', queueUrl: 'https://sqs/x' },
      { source: 'kafka', deliversTo: 'q-b', topic: 't', brokers: ['b:9092'] },
    ];

    const svc = new QueueService({ registry, bindings, baseUrl: 'http://localhost:5173' });
    const { started, failed } = await svc.start();

    expect(started).toBe(2);
    expect(failed).toEqual([]);
    expect(sqs.started).toBe(1);
    expect(kafka.started).toBe(1);
    expect(svc.statuses().map(s => s.state)).toEqual(['running', 'running']);

    await svc.stop();

    expect(sqs.aborted).toBe(1);
    expect(kafka.aborted).toBe(1);
    expect(svc.statuses().map(s => s.state)).toEqual(['stopped', 'stopped']);
  });

  it('passes adapter-specific config + a usable deliver, stripping reserved keys', async () => {
    const sqs = makeFakeSource('sqs');
    const registry = new SourceRegistry().register('sqs', sqs.factory);
    const bindings: SourceBinding[] = [
      {
        source: 'sqs',
        deliversTo: 'my-trigger',
        credentialRef: 'aws-prod',
        queueUrl: 'https://sqs/x',
        region: 'us-east-1',
      },
    ];
    const resolver: CredentialResolver = jest.fn(async (ref: string) =>
      ref === 'aws-prod'
        ? { kind: 'aws', fields: { region: 'us-east-1' }, value: 'AKIAFAKE' }
        : undefined,
    );

    const svc = new QueueService({
      registry,
      bindings,
      baseUrl: 'http://localhost:5173',
      credentialResolver: resolver,
      signingSecret: 'shh',
    });
    await svc.start();

    expect(resolver).toHaveBeenCalledWith('aws-prod');
    expect(sqs.calls).toHaveLength(1);
    const call = sqs.calls[0];
    // Reserved keys stripped; adapter config passed through.
    expect(call.config).toEqual({ queueUrl: 'https://sqs/x', region: 'us-east-1' });
    expect(call.config).not.toHaveProperty('source');
    expect(call.config).not.toHaveProperty('deliversTo');
    expect(call.config).not.toHaveProperty('credentialRef');
    // Credential resolved + forwarded.
    expect(call.credential).toEqual({
      kind: 'aws',
      fields: { region: 'us-east-1' },
      value: 'AKIAFAKE',
    });
    expect(call.deliversTo).toBe('my-trigger');
    expect(call.signingSecret).toBe('shh');
    // The loop received a real deliver fn (built from makeHttpDeliver).
    expect(sqs.sawDeliver).toBe(true);

    await svc.stop();
  });

  it('marks a binding failed (and skips it) when its factory throws, without aborting others', async () => {
    const good = makeFakeSource('good');
    const badFactory: SourceFactory = () => {
      throw new Error('bad config');
    };
    const registry = new SourceRegistry()
      .register('good', good.factory)
      .register('bad', badFactory);
    const bindings: SourceBinding[] = [
      { source: 'bad', deliversTo: 'q-bad' },
      { source: 'good', deliversTo: 'q-good' },
    ];

    const svc = new QueueService({ registry, bindings, baseUrl: 'http://localhost:5173' });
    const { started, failed } = await svc.start();

    expect(started).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ source: 'bad', deliversTo: 'q-bad', state: 'failed' });
    expect(good.started).toBe(1);

    await svc.stop();
    expect(good.aborted).toBe(1);
  });

  it('throws on a credentialRef with no resolver configured', async () => {
    const sqs = makeFakeSource('sqs');
    const registry = new SourceRegistry().register('sqs', sqs.factory);
    const svc = new QueueService({
      registry,
      bindings: [{ source: 'sqs', deliversTo: 'q', credentialRef: 'aws-prod' }],
      baseUrl: 'http://localhost:5173',
    });
    // The construction error is captured as a `failed` connector, not thrown
    // out of start() (one bad binding mustn't crash the host).
    const { started, failed } = await svc.start();
    expect(started).toBe(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/no credentialResolver/);
    await svc.stop();
  });

  it('start() is not re-entrant', async () => {
    const sqs = makeFakeSource('sqs');
    const registry = new SourceRegistry().register('sqs', sqs.factory);
    const svc = new QueueService({
      registry,
      bindings: [{ source: 'sqs', deliversTo: 'q', queueUrl: 'u' }],
      baseUrl: 'http://localhost:5173',
    });
    await svc.start();
    await expect(svc.start()).rejects.toThrow(/already started/);
    await svc.stop();
  });

  it('stop() before start() is a safe no-op', async () => {
    const registry = new SourceRegistry();
    const svc = new QueueService({ registry, bindings: [], baseUrl: 'http://x' });
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});

describe('validateBindings', () => {
  const registry = new SourceRegistry().register('sqs', (() => {
    throw new Error('unused');
  }) as SourceFactory);

  it('reports an unknown source with the registered set', () => {
    const problems = validateBindings([{ source: 'kafka', deliversTo: 'q' }], registry);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no adapter registered for source "kafka"/);
    expect(problems[0]).toMatch(/registered: sqs/);
  });

  it('reports missing source / deliversTo', () => {
    const problems = validateBindings(
      [{ deliversTo: 'q' } as SourceBinding, { source: 'sqs' } as SourceBinding],
      registry,
    );
    expect(problems.some(p => /sources\[0\]: missing "source"/.test(p))).toBe(true);
    expect(problems.some(p => /sources\[1\]: missing "deliversTo"/.test(p))).toBe(true);
  });

  it('accepts a well-formed binding', () => {
    expect(
      validateBindings([{ source: 'sqs', deliversTo: 'q', queueUrl: 'u' }], registry),
    ).toEqual([]);
  });
});
