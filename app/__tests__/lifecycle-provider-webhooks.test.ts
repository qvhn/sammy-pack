/**
 * PROVIDER-SIGNED INGRESS, END-TO-END.
 *
 * `provider-signatures.test.ts` pins each scheme's cryptography against
 * openssl. What it cannot show is the WIRING: that declaring
 * `"signed": "github"` on a trigger makes the mounted ingress read
 * `X-Hub-Signature-256` and enforce it — and, just as importantly, that a
 * rejection starts NO run.
 *
 * So this suite signs requests the way each provider really signs them and
 * fires them at a real server, asserting both directions per provider:
 *   - a correctly-signed request → 2xx → a run reaching `done` with the body
 *   - unsigned / wrong-secret / tampered-body → 401 and ZERO runs
 *
 * The signers below deliberately do NOT import the verifier's helpers: they
 * construct each signed payload from the provider's published format, so a
 * change that broke the construction on both sides at once would still fail
 * here rather than quietly agree with itself.
 */

import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  destroySammyCronTasks,
  getJson,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const SECRET = 'provider-ingress-secret';
/** `whsec_` + base64(SECRET) — the Standard Webhooks secret format, whose
 *  HMAC key is the DECODED bytes. */
const SWH_SECRET = `whsec_${Buffer.from(SECRET, 'utf8').toString('base64')}`;

const hex = (key: string | Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('hex');
const b64 = (key: string | Buffer, payload: string): string =>
  createHmac('sha256', key).update(payload, 'utf8').digest('base64');
const nowSec = (): number => Math.floor(Date.now() / 1000);

/** One provider case: how to sign, and what a wrong-secret attempt looks
 *  like. `body` is the exact wire string (postJson JSON-stringifies). */
type ProviderCase = {
  provider: string;
  orch: string;
  /** Headers a genuine delivery from this provider would carry. */
  sign: (body: string, secret: string) => Record<string, string>;
  /** False for gitlab, which signs nothing — see the scheme's doc comment. */
  bindsBody: boolean;
};

const CASES: ProviderCase[] = [
  {
    provider: 'github',
    orch: 'hook-github',
    bindsBody: true,
    sign: (body, secret) => ({ 'x-hub-signature-256': `sha256=${hex(secret, body)}` }),
  },
  {
    provider: 'stripe',
    orch: 'hook-stripe',
    bindsBody: true,
    sign: (body, secret) => {
      const t = nowSec();
      return { 'stripe-signature': `t=${t},v1=${hex(secret, `${t}.${body}`)}` };
    },
  },
  {
    provider: 'slack',
    orch: 'hook-slack',
    bindsBody: true,
    sign: (body, secret) => {
      const t = String(nowSec());
      return {
        'x-slack-request-timestamp': t,
        'x-slack-signature': `v0=${hex(secret, `v0:${t}:${body}`)}`,
      };
    },
  },
  {
    provider: 'shopify',
    orch: 'hook-shopify',
    bindsBody: true,
    sign: (body, secret) => ({ 'x-shopify-hmac-sha256': b64(secret, body) }),
  },
  {
    provider: 'linear',
    orch: 'hook-linear',
    bindsBody: true,
    sign: (body, secret) => ({ 'linear-signature': hex(secret, body) }),
  },
  {
    provider: 'standard-webhooks',
    orch: 'hook-swh',
    bindsBody: true,
    sign: (body, secret) => {
      const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
      const t = String(nowSec());
      // The key is the decoded bytes of the whsec_ secret.
      const key = secret.startsWith('whsec_')
        ? Buffer.from(secret.slice('whsec_'.length), 'base64')
        : Buffer.from(secret, 'utf8');
      return {
        'webhook-id': id,
        'webhook-timestamp': t,
        'webhook-signature': `v1,${b64(key, `${id}.${t}.${body}`)}`,
      };
    },
  },
  {
    provider: 'gitlab',
    orch: 'hook-gitlab',
    bindsBody: false,
    sign: (_body, secret) => ({ 'x-gitlab-token': secret }),
  },
];

/** The secret a given provider's trigger is verified against. Standard
 *  Webhooks uses the whsec_ form; the rest use the plain secret. */
const secretFor = (p: string): string => (p === 'standard-webhooks' ? SWH_SECRET : SECRET);

describe('lifecycle: provider-signed trigger ingress', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    tmpRoot = await makeWorkspace('provider-ingress');
    for (const c of CASES) {
      await writeOrchestration(tmpRoot, {
        name: c.orch,
        triggers: [
          { kind: 'webhook', path: c.orch, method: 'POST', signed: c.provider },
        ],
        phases: [{ name: 'echo', code: { source: "return 'ok:' + (input || '');" } }],
      });
    }
  });

  afterAll(async () => {
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  /** Each provider gets its own mount, because SAMMY_WEBHOOK_SECRET is a
   *  single process-wide secret and Standard Webhooks needs the whsec_ form. */
  const withMount = async (
    secret: string,
    fn: (mount: Mount) => Promise<void>,
  ): Promise<void> => {
    const prev = process.env.SAMMY_WEBHOOK_SECRET;
    process.env.SAMMY_WEBHOOK_SECRET = secret;
    const mount = await mountServer(tmpRoot);
    try {
      await fn(mount);
    } finally {
      await mount.kill();
      destroySammyCronTasks();
      if (prev === undefined) delete process.env.SAMMY_WEBHOOK_SECRET;
      else process.env.SAMMY_WEBHOOK_SECRET = prev;
    }
  };

  const deliveriesOf = async (mount: Mount, orch: string): Promise<number> =>
    (await mount.store.listDeliveries(500)).filter(
      d => d.orchestrationName === orch,
    ).length;

  /** Fire something that must be refused, and prove it queued NO work.
   *
   *  Asserted on DELIVERIES, not runs. A delivery row is written
   *  synchronously before the response, so its count is stable the moment
   *  the fire returns — whereas a run is created later by the worker, so
   *  counting runs races with an earlier case's delivery still draining and
   *  flakes under parallel load. No delivery also implies no run, since a
   *  run only ever comes from one. Counted as a delta because every mount
   *  here shares one workspace, hence one durable db, and the accept case's
   *  row is legitimately still there. */
  const expectRejectedWithNoRun = async (
    mount: Mount,
    orch: string,
    fire: () => Promise<{ status: number }>,
  ): Promise<void> => {
    const before = await deliveriesOf(mount, orch);
    const { status } = await fire();
    expect(status).toBe(401);
    // A 401 that still queued the work would be the dangerous version.
    expect(await deliveriesOf(mount, orch)).toBe(before);
  };

  describe.each(CASES.map(c => [c.provider, c] as const))(
    '%s',
    (provider, c) => {
      const PAYLOAD = { event: provider, n: 7 };
      const BODY = JSON.stringify(PAYLOAD); // the exact bytes postJson sends
      const url = (m: Mount) => `${m.baseUrl}/api/triggers/${c.orch}`;

      it('introspection names the scheme and the headers to send', async () => {
        await withMount(secretFor(provider), async mount => {
          type Row = {
            orchestration: string;
            config: {
              signed?: boolean;
              signatureProvider?: string;
              signatureHeaders?: string[];
            };
          };
          // Waited for, not read once: the boot trigger scan is async, so a
          // GET issued the instant the mount returns can legitimately see a
          // partial list (which flakes only under parallel load).
          const row = await waitFor(
            async () =>
              (await getJson<Row[]>(`${mount.baseUrl}/api/triggers`)).find(
                r => r.orchestration === c.orch,
              ) ?? null,
            `${provider} trigger registered`,
            { timeoutMs: 10_000, intervalMs: 50 },
          );
          expect(row?.config.signed).toBe(true);
          expect(row?.config.signatureProvider).toBe(provider);
          // A caller can discover what to send without reading the source.
          expect(row?.config.signatureHeaders?.length).toBeGreaterThan(0);
        });
      });

      it('ACCEPTS a genuinely-signed delivery and runs the orchestration', async () => {
        await withMount(secretFor(provider), async mount => {
          const { status } = await postJson(
            url(mount),
            PAYLOAD,
            c.sign(BODY, secretFor(provider)),
          );
          expect([200, 202]).toContain(status);
          const run = await waitFor(
            async () =>
              (await listRuns(mount.baseUrl)).find(
                r => r.orchestrationName === c.orch && r.status === 'done',
              ) ?? null,
            `${provider} signed webhook → done run`,
            { timeoutMs: 25_000, intervalMs: 100 },
          );
          expect(run.initialInput ?? '').toContain(`"event":"${provider}"`);
        });
      });

      it('rejects an UNSIGNED delivery and starts no run', async () => {
        await withMount(secretFor(provider), async mount => {
          await expectRejectedWithNoRun(mount, c.orch, () =>
            postJson(url(mount), PAYLOAD),
          );
        });
      });

      it('rejects the WRONG secret and starts no run', async () => {
        await withMount(secretFor(provider), async mount => {
          await expectRejectedWithNoRun(mount, c.orch, () =>
            postJson(url(mount), PAYLOAD, c.sign(BODY, 'not-the-secret')),
          );
        });
      });

      it("rejects sammy's OWN header — the provider's scheme is what's enforced", async () => {
        await withMount(secretFor(provider), async mount => {
          // Declaring a provider must not leave the native scheme as a
          // second, weaker way in.
          await expectRejectedWithNoRun(mount, c.orch, () =>
            postJson(url(mount), PAYLOAD, {
              'x-sammy-signature': `sha256=${hex(secretFor(provider), BODY)}`,
            }),
          );
        });
      });

      if (c.bindsBody) {
        it('rejects a valid signature over a DIFFERENT body (tamper in flight)', async () => {
          await withMount(secretFor(provider), async mount => {
            await expectRejectedWithNoRun(mount, c.orch, () =>
              postJson(
                url(mount),
                { event: provider, n: 9999 }, // not what was signed
                c.sign(BODY, secretFor(provider)),
              ),
            );
          });
        });
      }
    },
  );
});

describe('lifecycle: a signed trigger with no secret configured fails closed', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv(); // clears SAMMY_WEBHOOK_SECRET
    tmpRoot = await makeWorkspace('provider-no-secret');
    await writeOrchestration(tmpRoot, {
      name: 'needs-secret',
      triggers: [{ kind: 'webhook', path: 'needs-secret', method: 'POST', signed: 'github' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('answers 500, not 202 — a misconfigured gate must never open', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/needs-secret`, {
      pr: 1,
    });
    expect(status).toBe(500);
    expect(
      (await listRuns(mount.baseUrl)).filter(r => r.orchestrationName === 'needs-secret'),
    ).toHaveLength(0);
  });
});

describe('lifecycle: subscribers demanding different providers', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_WEBHOOK_SECRET = SECRET;
    tmpRoot = await makeWorkspace('provider-conflict');
    // Two orchestrations on ONE queue name, each naming a different scheme.
    await writeOrchestration(tmpRoot, {
      name: 'conflict-a',
      triggers: [{ kind: 'queue', queue: 'shared-jobs', signed: 'github' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'conflict-b',
      triggers: [{ kind: 'queue', queue: 'shared-jobs', signed: 'stripe' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('refuses the fire and names the conflict, rather than picking a winner', async () => {
    // Silently enforcing whichever registered first would mean one
    // orchestration's stated requirement was being ignored.
    const body = JSON.stringify({ job: 1 });
    const { status, body: out } = await postJson<{ error?: string }>(
      `${mount.baseUrl}/api/queue/shared-jobs`,
      { job: 1 },
      { 'x-hub-signature-256': `sha256=${hex(SECRET, body)}` },
    );
    expect(status).toBe(500);
    const msg = JSON.stringify(out);
    expect(msg).toContain('conflict-a');
    expect(msg).toContain('conflict-b');
    expect(await listRuns(mount.baseUrl)).toHaveLength(0);
  });

  it('reports the conflict in introspection too', async () => {
    const rows = await getJson<
      Array<{ orchestration: string; config: { signatureConflict?: string } }>
    >(`${mount.baseUrl}/api/triggers`);
    const row = rows.find(r => r.orchestration === 'conflict-a');
    expect(row?.config.signatureConflict).toContain('github');
    expect(row?.config.signatureConflict).toContain('stripe');
  });
});

describe('lifecycle: a typo in `signed` must never open the endpoint', () => {
  // The dangerous shape: the ingress enforces nothing when `signed` resolves
  // to no provider, so an unrecognized value would publish an endpoint its
  // author believed was authenticated. Validation flags it, and registration
  // refuses it — no endpoint at all beats an unprotected one.
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  let errors: string[];
  let consoleError: jest.SpyInstance;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_WEBHOOK_SECRET = SECRET;
    tmpRoot = await makeWorkspace('provider-typo');
    await writeOrchestration(tmpRoot, {
      name: 'typo-hook',
      triggers: [{ kind: 'webhook', path: 'typo-hook', method: 'POST', signed: 'githbu' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    errors = [];
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    consoleError.mockRestore();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('refuses to register the trigger, and says why', () => {
    const msg = errors.join('\n');
    expect(msg).toContain('typo-hook');
    expect(msg).toContain('githbu');
    expect(msg).toMatch(/REFUSING to register/i);
  });

  it('the endpoint does not exist — 404, not an unsigned 202', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/triggers/typo-hook`, {
      pr: 1,
    });
    expect(status).toBe(404);
    expect(await listRuns(mount.baseUrl)).toHaveLength(0);
  });

  it('validation flags it at author time too, naming the valid set', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateOrchestration } = require('../src/validate') as {
      validateOrchestration: (n: unknown) => Array<{
        path: string;
        message: string;
        severity: string;
      }>;
    };
    const issues = validateOrchestration({
      name: 'typo-hook',
      triggers: [{ kind: 'webhook', path: 'typo-hook', signed: 'githbu' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    const signedIssue = issues.find(i => i.path.includes('signed'));
    expect(signedIssue).toBeDefined();
    expect(signedIssue!.severity).toBe('error');
    // The message must name the alternatives, or the author is left guessing.
    expect(signedIssue!.message).toContain('github');
    expect(signedIssue!.message).toContain('githbu');
  });

  it('a VALID provider name passes validation', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validateOrchestration } = require('../src/validate') as {
      validateOrchestration: (n: unknown) => Array<{ path: string }>;
    };
    for (const signed of [true, false, 'github', 'standard-webhooks']) {
      const issues = validateOrchestration({
        name: 'ok-hook',
        triggers: [{ kind: 'webhook', path: 'ok-hook', signed }],
        phases: [{ name: 'echo', code: { source: 'return input;' } }],
      });
      expect(issues.filter(i => i.path.includes('signed'))).toHaveLength(0);
    }
  });
});

describe('lifecycle: signatures cover the RAW BYTES, and bodies are bounded', () => {
  /**
   * THE BUG THIS PINS: the ingress read bodies with
   * `Buffer.concat(chunks).toString('utf8')` and HMACed that string. Any byte
   * sequence that is not valid UTF-8 becomes U+FFFD on decode, so re-encoding
   * produced `ef bf bd` where the sender had sent, say, `80` — a different
   * digest, and a 401 on a delivery that was correctly signed. Providers sign
   * the raw bytes (GitHub and Shopify say so explicitly), and a payload
   * carrying a lone surrogate, latin-1 text or anything binary hits this.
   *
   * These cases POST with `fetch` and a Buffer body so the exact bytes go on
   * the wire, which `postJson` (which JSON-stringifies) cannot express.
   */
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  /** Bytes that are NOT valid UTF-8: a bare continuation byte and 0xfe. */
  const INVALID_UTF8 = Buffer.concat([
    Buffer.from('{"t":"'),
    Buffer.from([0x80, 0xfe]),
    Buffer.from('"}'),
  ]);

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_WEBHOOK_SECRET = SECRET;
    delete process.env.SAMMY_DISABLE_INPROCESS_WORKER;
    tmpRoot = await makeWorkspace('raw-bytes');
    await writeOrchestration(tmpRoot, {
      name: 'raw-hook',
      triggers: [{ kind: 'webhook', path: 'raw-hook', method: 'POST', signed: 'github' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'open-hook',
      triggers: [{ kind: 'webhook', path: 'open-hook', method: 'POST' }],
      phases: [{ name: 'echo', code: { source: 'return input;' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  const postRaw = async (
    path: string,
    bytes: Buffer,
    headers: Record<string, string> = {},
  ): Promise<number> => {
    const res = await fetch(`${mount.baseUrl}/api/triggers/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...headers },
      // A Blob preserves the exact bytes and IS in this project's BodyInit
      // union (the react-native DOM lib types omit typed arrays, even though
      // the runtime accepts them).
      body: new Blob([Uint8Array.from(bytes)]),
    });
    return res.status;
  };

  it('ACCEPTS a signature over bytes that are not valid UTF-8', async () => {
    // Signed over the raw bytes, exactly as GitHub would.
    const sig = createHmac('sha256', SECRET).update(INVALID_UTF8).digest('hex');
    const status = await postRaw('raw-hook', INVALID_UTF8, {
      'x-hub-signature-256': `sha256=${sig}`,
    });
    expect([200, 202]).toContain(status);
  });

  it('still REJECTS a signature over the utf8-mangled form of those bytes', async () => {
    // What the old code effectively hashed. It must not verify, or the fix
    // would just have moved the bug.
    const mangled = Buffer.from(INVALID_UTF8.toString('utf8'), 'utf8');
    expect(mangled.equals(INVALID_UTF8)).toBe(false);
    const sig = createHmac('sha256', SECRET).update(mangled).digest('hex');
    const status = await postRaw('raw-hook', INVALID_UTF8, {
      'x-hub-signature-256': `sha256=${sig}`,
    });
    expect(status).toBe(401);
  });

  it('a body over the cap is 413, and starts no run', async () => {
    // The ingress is reachable unauthenticated — the signature cannot be
    // checked until the body is read — so the cap is the only thing between
    // a stranger and unbounded memory.
    // Scoped to THIS orchestration: an earlier case's accepted fire drains
    // into a run asynchronously, so a global run count would drift under it.
    const openRuns = async () =>
      (await listRuns(mount.baseUrl)).filter(r => r.orchestrationName === 'open-hook')
        .length;
    const before = await openRuns();
    const huge = Buffer.alloc(6 * 1024 * 1024, 0x61); // 6 MiB > 5 MiB default
    const status = await postRaw('open-hook', huge);
    expect(status).toBe(413);
    await new Promise(r => setTimeout(r, 250));
    expect(await openRuns()).toBe(before);
  });

  it('a body just under the cap is still accepted', async () => {
    const ok = Buffer.alloc(1024, 0x62);
    const status = await postRaw('open-hook', ok);
    expect([200, 202]).toContain(status);
  });
});
