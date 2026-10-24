/**
 * Route-level hardening of the operator surfaces that sat beside the
 * per-run API and had none of its scoping or masking:
 *
 *   - GET /api/credentials masked only `value`; `env` (an mcp-server
 *     entry's provider keys) and `cache` (an SSO entry's role credentials)
 *     went out verbatim, and the list ignored each entry's `owners`.
 *   - PUT /api/credentials was an unscoped full-map replace, and because
 *     the reconcile restores the stored secret when the incoming value is
 *     the mask, a caller who never saw a secret could re-point its
 *     `url`/`fields` and have "Test connection" deliver it there.
 *   - POST /api/credentials/test dropped every entry with an
 *     `orchestrations` allowlist because no orchestration name was given.
 *   - POST /api/agents/scan walked ANY absolute path and returned every
 *     .md file's path and preview; its "resolve symlinks" was path.resolve.
 *   - GET /api/mcp-servers returned env/header secrets as-is.
 *   - GET /api/cost summed the whole workspace's spend under "Owner-scoped".
 *   - The errorOrchestration recovery read the budget unscoped, one line
 *     above starting the recovery run under the failed run's owner.
 *
 * Everything runs over the real mounted API against a real store.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const ALICE = 'alice';
const BOB = 'bob';

function asOwner(owner?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(owner ? { 'x-sammy-user': owner } : {}),
  };
}

async function call<T = unknown>(
  url: string,
  init: { method?: string; owner?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: asOwner(init.owner),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body, text };
}

// Raw secrets the fixtures hold. None may ever appear in a list response.
const RAW = {
  sharedEnv: 'ghp_sharedenvtoken0123456789abcdefghij',
  aliceToken: 'ghp_aliceonlytoken0123456789abcdefghi',
  ssoAccess: 'sso-access-token-value-7731',
  ssoKeyId: 'AKIAIOSFODNN7EXAMPLE',
  ssoSecret: 'sso-secret-access-key-value-7731',
  ssoSession: 'sso-session-token-value-7731',
  scoped: 'ghp_orchscopedtoken0123456789abcdefgh',
  jiraToken: 'ATATT3xFfGF0storedjira0123456789abcd',
};

describe('API surface hardening', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let tmpRoot: string;
  let credentialsFile: string;

  async function writeCredentialsFixture(): Promise<void> {
    await fs.writeFile(
      credentialsFile,
      JSON.stringify(
        {
          'shared-mcp': {
            kind: 'mcp-server',
            value: '',
            env: { GITHUB_TOKEN: RAW.sharedEnv, PLAIN: 'visible' },
          },
          'team-aws': {
            kind: 'aws',
            authMethod: 'sso',
            value: '',
            ssoStartUrl: 'https://d-1.awsapps.com/start',
            owners: [ALICE],
            cache: {
              accessToken: RAW.ssoAccess,
              accessKeyId: RAW.ssoKeyId,
              secretAccessKey: RAW.ssoSecret,
              sessionToken: RAW.ssoSession,
              expiresAt: '2030-01-01T00:00:00Z',
            },
          },
          'alice-only': {
            kind: 'a2a',
            value: RAW.aliceToken,
            url: 'https://agent.example.test/a2a',
            fields: { site: 'https://site.example.test' },
            owners: [ALICE],
            description: 'original',
          },
          'orch-scoped': {
            kind: 'github',
            value: RAW.scoped,
            orchestrations: ['only-this-orch'],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  async function onDisk(): Promise<Record<string, Record<string, unknown>>> {
    return JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
  }

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('api-hardening');
    credentialsFile = path.join(tmpRoot, 'credentials.json');
    await writeCredentialsFixture();
    await writeOrchestration(tmpRoot, {
      name: 'failing-orch',
      lifecycle: { errorOrchestration: 'recovery-orch' },
      phases: [{ name: 'boom', code: { source: "throw new Error('boom')" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'recovery-orch',
      phases: [{ name: 'p', code: { source: "return 'recovered'" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  // ── GET /api/credentials ─────────────────────────────────────────────────
  describe('GET /api/credentials', () => {
    beforeEach(writeCredentialsFixture);

    it('masks env and cache secrets, not just value', async () => {
      const r = await call<Record<string, Record<string, unknown>>>(
        `${mount.baseUrl}/api/credentials`,
        { owner: ALICE },
      );
      expect(r.status).toBe(200);
      const env = r.body['shared-mcp'].env as Record<string, string>;
      expect(env.GITHUB_TOKEN).not.toBe(RAW.sharedEnv);
      expect(env.GITHUB_TOKEN).toBe('ghp_sh…ij');
      const cache = r.body['team-aws'].cache as Record<string, string>;
      expect(cache.secretAccessKey).not.toBe(RAW.ssoSecret);
      expect(cache.accessToken).not.toBe(RAW.ssoAccess);
      expect(cache.sessionToken).not.toBe(RAW.ssoSession);
      expect(cache.accessKeyId).not.toBe(RAW.ssoKeyId);
      // Not a secret: stays readable so the UI can show when a refresh is due.
      expect(cache.expiresAt).toBe('2030-01-01T00:00:00Z');
      for (const raw of Object.values(RAW)) expect(r.text).not.toContain(raw);
    });

    it("hides entries whose owners don't list the caller", async () => {
      const bob = await call<Record<string, unknown>>(`${mount.baseUrl}/api/credentials`, {
        owner: BOB,
      });
      expect(Object.keys(bob.body).sort()).toEqual(['orch-scoped', 'shared-mcp']);
      const alice = await call<Record<string, unknown>>(
        `${mount.baseUrl}/api/credentials`,
        { owner: ALICE },
      );
      expect(Object.keys(alice.body).sort()).toEqual([
        'alice-only',
        'orch-scoped',
        'shared-mcp',
        'team-aws',
      ]);
    });
  });

  // ── PUT /api/credentials ─────────────────────────────────────────────────
  describe('PUT /api/credentials', () => {
    beforeEach(writeCredentialsFixture);

    it("refuses (404-shaped) to touch an entry the caller cannot see, and leaves it untouched", async () => {
      const r = await call(`${mount.baseUrl}/api/credentials`, {
        method: 'PUT',
        owner: BOB,
        body: {
          'alice-only': { kind: 'a2a', value: '', url: 'https://exfil.example.test' },
        },
      });
      expect(r.status).toBe(404);
      expect((await onDisk())['alice-only'].url).toBe('https://agent.example.test/a2a');
    });

    it('refuses to move the destination of an entry saved with a masked secret', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        )
      ).body;
      const r = await call(`${mount.baseUrl}/api/credentials`, {
        method: 'PUT',
        owner: ALICE,
        body: {
          ...masked,
          'alice-only': { ...masked['alice-only'], url: 'https://exfil.example.test' },
        },
      });
      expect(r.status).toBe(400);
      expect(r.text).toContain('url');
      expect(r.text).toMatch(/masked/i);
      expect((await onDisk())['alice-only'].url).toBe('https://agent.example.test/a2a');
    });

    it('refuses to widen the audience (owners) of an entry saved with a masked secret', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        )
      ).body;
      const r = await call(`${mount.baseUrl}/api/credentials`, {
        method: 'PUT',
        owner: ALICE,
        body: {
          ...masked,
          'alice-only': { ...masked['alice-only'], owners: [ALICE, BOB] },
        },
      });
      expect(r.status).toBe(400);
      expect(r.text).toContain('owners');
      expect((await onDisk())['alice-only'].owners).toEqual([ALICE]);
    });

    it('the plain edit flow still works: metadata changes without re-typing, and every masked secret round-trips', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        )
      ).body;
      const r = await call<Record<string, Record<string, unknown>>>(
        `${mount.baseUrl}/api/credentials`,
        {
          method: 'PUT',
          owner: ALICE,
          body: {
            ...masked,
            'alice-only': { ...masked['alice-only'], description: 'edited' },
          },
        },
      );
      expect(r.status).toBe(200);
      const disk = await onDisk();
      expect(disk['alice-only'].description).toBe('edited');
      expect(disk['alice-only'].value).toBe(RAW.aliceToken);
      // The newly-masked fields must survive the round trip too.
      expect((disk['shared-mcp'].env as Record<string, string>).GITHUB_TOKEN).toBe(
        RAW.sharedEnv,
      );
      expect((disk['team-aws'].cache as Record<string, string>).secretAccessKey).toBe(
        RAW.ssoSecret,
      );
      // And the echo is masked + scoped like GET.
      for (const raw of Object.values(RAW)) expect(r.text).not.toContain(raw);
    });

    it("a caller's full-map PUT never deletes entries outside their view", async () => {
      const bobView = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: BOB },
        )
      ).body;
      const r = await call(`${mount.baseUrl}/api/credentials`, {
        method: 'PUT',
        owner: BOB,
        body: bobView,
      });
      expect(r.status).toBe(200);
      const disk = await onDisk();
      expect(disk['alice-only'].value).toBe(RAW.aliceToken);
      expect(disk['team-aws']).toBeDefined();
    });
  });

  // ── POST /api/credentials/import ─────────────────────────────────────────
  // The THIRD writer of credentials.json, and it had neither of the PUT's
  // rules: it read the raw registry and merged into any named entry, so one
  // identity overwrote another owner's value / fields / kind while `owners`
  // survived from the stored entry — the entry stayed the victim's, so nothing
  // in her view said otherwise. The suite above is what made that invisible:
  // it covered GET and PUT route by route and never touched this one.
  describe('POST /api/credentials/import', () => {
    beforeEach(writeCredentialsFixture);

    type ImportReply = {
      added: string[];
      updated: string[];
      unchanged: string[];
      skipped: Array<{ source: string; reason: string }>;
    };

    it('answers like the PUT for an entry the caller cannot see, and leaves it untouched', async () => {
      const put = await call(`${mount.baseUrl}/api/credentials`, {
        method: 'PUT',
        owner: BOB,
        body: { 'alice-only': { kind: 'a2a', value: 'BOB-PLANTED' } },
      });
      expect(put.status).toBe(404);
      const r = await call<ImportReply>(`${mount.baseUrl}/api/credentials/import`, {
        method: 'POST',
        owner: BOB,
        body: {
          localStorage: {
            'sammy.connection.alice-only.token': 'BOB-PLANTED-TOKEN',
            'sammy.connection.alice-only.site': 'https://exfil.example.test',
          },
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.updated).not.toContain('alice-only');
      expect(r.body.skipped).toEqual(
        expect.arrayContaining([
          { source: 'alice-only', reason: expect.stringContaining('not found for this caller') },
        ]),
      );
      const disk = await onDisk();
      expect(disk['alice-only'].value).toBe(RAW.aliceToken);
      expect(disk['alice-only'].fields).toEqual({ site: 'https://site.example.test' });
      expect(disk['alice-only'].kind).toBe('a2a');
      expect(disk['alice-only'].owners).toEqual([ALICE]);
    });

    it('refuses to move the destination of an entry whose secret arrives masked', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        )
      ).body;
      const r = await call<ImportReply>(`${mount.baseUrl}/api/credentials/import`, {
        method: 'POST',
        owner: ALICE,
        body: {
          localStorage: {
            'sammy.connection.alice-only.token': masked['alice-only'].value as string,
            'sammy.connection.alice-only.site': 'https://exfil.example.test',
          },
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.updated).not.toContain('alice-only');
      expect(r.body.skipped).toEqual(
        expect.arrayContaining([
          { source: 'alice-only', reason: expect.stringMatching(/masked/i) },
        ]),
      );
      const disk = await onDisk();
      expect(disk['alice-only'].value).toBe(RAW.aliceToken);
      expect(disk['alice-only'].fields).toEqual({ site: 'https://site.example.test' });
    });

    it('restores an echoed mask instead of writing it to disk as the secret', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        )
      ).body;
      const r = await call<ImportReply>(`${mount.baseUrl}/api/credentials/import`, {
        method: 'POST',
        owner: ALICE,
        body: {
          localStorage: {
            'sammy.connection.alice-only.token': masked['alice-only'].value as string,
          },
        },
      });
      expect(r.status).toBe(200);
      expect((await onDisk())['alice-only'].value).toBe(RAW.aliceToken);
    });

    it('still migrates the caller\'s own entries and creates new ones', async () => {
      const r = await call<ImportReply>(`${mount.baseUrl}/api/credentials/import`, {
        method: 'POST',
        owner: BOB,
        body: {
          localStorage: {
            // A brand-new entry: the ordinary migration path.
            'sammy.connection.gitlab.token': 'glpat-bobs-own-token-0123456789',
            // An existing entry with no `owners` — unrestricted by the
            // back-compat default, so bob may genuinely update it.
            'sammy.connection.orch-scoped.token': 'ghp_bobsreplacement0123456789abcdef',
          },
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.added).toContain('gitlab');
      expect(r.body.updated).toContain('orch-scoped');
      const disk = await onDisk();
      expect(disk.gitlab.value).toBe('glpat-bobs-own-token-0123456789');
      expect(disk['orch-scoped'].value).toBe('ghp_bobsreplacement0123456789abcdef');
      // …and no secret ever rides back on the echo.
      for (const raw of Object.values(RAW)) expect(r.text).not.toContain(raw);
    });
  });

  // ── GET /api/credentials/usage ───────────────────────────────────────────
  // The reverse index is keyed BY credential name, and it read the raw file —
  // so it enumerated the name of every connection in the workspace, including
  // the ones GET /api/credentials deliberately hides, which makes it an
  // existence oracle for exactly what `owners` exists to withhold.
  describe('GET /api/credentials/usage', () => {
    beforeEach(writeCredentialsFixture);

    it('covers the caller\'s view only, and agrees with GET /api/credentials', async () => {
      for (const owner of [ALICE, BOB]) {
        const list = await call<Record<string, unknown>>(
          `${mount.baseUrl}/api/credentials`,
          { owner },
        );
        const usage = await call<Record<string, unknown>>(
          `${mount.baseUrl}/api/credentials/usage`,
          { owner },
        );
        expect(usage.status).toBe(200);
        expect(Object.keys(usage.body).sort()).toEqual(
          Object.keys(list.body).sort(),
        );
      }
      // Concretely: the entry scoped to alice is named to alice and to nobody
      // else — not even as an empty row.
      const bob = await call<Record<string, unknown>>(
        `${mount.baseUrl}/api/credentials/usage`,
        { owner: BOB },
      );
      expect(bob.text).not.toContain('alice-only');
      expect(bob.text).not.toContain('team-aws');
      const alice = await call<Record<string, unknown>>(
        `${mount.baseUrl}/api/credentials/usage`,
        { owner: ALICE },
      );
      expect(Object.keys(alice.body)).toContain('alice-only');
    });
  });

  // ── POST /api/credentials/test ───────────────────────────────────────────
  describe('POST /api/credentials/test', () => {
    beforeEach(writeCredentialsFixture);

    it('finds an orchestrations-scoped entry — that allowlist applies to runs, not to the probe', async () => {
      // Probe destinations are real hosts; answer them locally while letting
      // the test's own calls to the mounted server through.
      const realFetch = globalThis.fetch;
      const probed: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.startsWith(mount.baseUrl)) return realFetch(input, init);
        probed.push(url);
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      try {
        const r = await call<{ ok: boolean; message: string }>(
          `${mount.baseUrl}/api/credentials/test`,
          { method: 'POST', body: { name: 'orch-scoped' } },
        );
        expect(r.status).toBe(200);
        expect(r.body.message).not.toMatch(/not found/);
        expect(r.body.ok).toBe(true);
        expect(probed).toHaveLength(1);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    // ── The DESTINATION RULE, over every spelling of "no secret supplied" ──
    //
    // The rule refuses an override that would send a STORED secret to a
    // caller-chosen host. It was gated on `valueOverride === undefined` while
    // the value was read with `??`, so `valueOverride: null` was "supplied"
    // to the guard and "absent" to the read: the guard was skipped and the
    // STORED secret went to the caller's host, in plaintext, for a caller who
    // had only ever seen the mask. The assertion that matters is therefore
    // the SINK — a status code alone passes for spellings that reach the host
    // with an empty bearer and tells you nothing.
    describe('the DESTINATION RULE is total', () => {
      const SINK = 'http://127.0.0.1:1/exfil';

      /** Capture every outbound probe (url + Authorization) without letting
       *  one leave the process; the test's own calls pass through. */
      async function probeWith(body: Record<string, unknown>): Promise<{
        status: number;
        text: string;
        sink: Array<{ url: string; authorization: string }>;
      }> {
        const realFetch = globalThis.fetch;
        const sink: Array<{ url: string; authorization: string }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url.startsWith(mount.baseUrl)) return realFetch(input, init);
          const headers = new Headers((init?.headers ?? {}) as HeadersInit);
          sink.push({ url, authorization: headers.get('authorization') ?? '' });
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch;
        try {
          const r = await call<unknown>(`${mount.baseUrl}/api/credentials/test`, {
            method: 'POST',
            owner: ALICE,
            body,
          });
          return { status: r.status, text: r.text, sink };
        } finally {
          globalThis.fetch = realFetch;
        }
      }

      /** An `${fields.*}`-templated entry, so `fieldsOverride` moves the
       *  destination the same way `urlOverride` does for `${url}`. */
      async function writeJiraEntry(): Promise<void> {
        const now = await onDisk();
        now['team-jira'] = {
          kind: 'atlassian',
          value: RAW.jiraToken,
          fields: { email: 'ops@acme.test', site: 'https://real.atlassian.test' },
          owners: [ALICE],
        };
        await fs.writeFile(credentialsFile, JSON.stringify(now, null, 2), 'utf8');
      }

      /** The mask GET hands out for one entry — the spelling a client that
       *  re-saves a form it never re-typed sends back. Read from the API, so
       *  the case cannot drift from `maskSecret`. */
      async function maskOf(name: string): Promise<string> {
        const r = await call<Record<string, { value: string }>>(
          `${mount.baseUrl}/api/credentials`,
          { owner: ALICE },
        );
        return r.body[name].value;
      }

      // Every spelling of "the caller supplied no secret": absent, the
      // nullish one, blank, whitespace-only, the echoed mask, and the
      // non-string shapes. `undefined` is spelled by omitting the key — JSON
      // has no other way to send it. MASK is substituted per entry.
      const MASK = '<the mask for this entry>';
      const NO_SECRET: Array<[string, Record<string, unknown>]> = [
        ['absent', {}],
        ['null', { valueOverride: null }],
        ['empty string', { valueOverride: '' }],
        ['whitespace', { valueOverride: '   ' }],
        ['the mask GET returned', { valueOverride: MASK }],
        ['a number', { valueOverride: 0 }],
        ['an object', { valueOverride: {} }],
      ];

      async function resolveMask(
        override: Record<string, unknown>,
        name: string,
      ): Promise<Record<string, unknown>> {
        return override.valueOverride === MASK
          ? { valueOverride: await maskOf(name) }
          : override;
      }

      it.each(NO_SECRET)(
        'refuses urlOverride when the secret is %s — nothing reaches the sink',
        async (_label, override) => {
          const r = await probeWith({
            name: 'alice-only',
            urlOverride: SINK,
            ...(await resolveMask(override, 'alice-only')),
          });
          expect(r.status).toBe(400);
          expect(r.text).toContain('cannot be combined with the stored secret');
          expect(r.sink).toEqual([]);
        },
      );

      it.each(NO_SECRET)(
        'refuses fieldsOverride when the secret is %s — nothing reaches the sink',
        async (_label, override) => {
          await writeJiraEntry();
          const r = await probeWith({
            name: 'team-jira',
            fieldsOverride: { site: SINK },
            ...(await resolveMask(override, 'team-jira')),
          });
          expect(r.status).toBe(400);
          expect(r.sink).toEqual([]);
        },
      );

      it('a caller that supplies its OWN secret may still name the destination', async () => {
        const r = await probeWith({
          name: 'alice-only',
          valueOverride: 'my-own-token',
          urlOverride: SINK,
        });
        expect(r.status).toBe(200);
        expect(r.sink).toEqual([
          {
            url: `${SINK}/.well-known/agent-card.json`,
            authorization: 'Bearer my-own-token',
          },
        ]);
      });

      it('no override still probes the STORED destination with the stored secret', async () => {
        const r = await probeWith({ name: 'alice-only' });
        expect(r.status).toBe(200);
        expect(r.sink).toEqual([
          {
            url: 'https://agent.example.test/a2a/.well-known/agent-card.json',
            authorization: `Bearer ${RAW.aliceToken}`,
          },
        ]);
      });
    });
  });

  // ── POST /api/agents/scan ────────────────────────────────────────────────
  describe('POST /api/agents/scan', () => {
    let outside: string;

    beforeAll(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-outside-'));
      await fs.writeFile(path.join(outside, 'leak.md'), '# an agent outside', 'utf8');
      await fs.mkdir(path.join(tmpRoot, 'agents'), { recursive: true });
      await fs.writeFile(
        path.join(tmpRoot, 'agents', 'scanner.md'),
        '# scanner agent',
        'utf8',
      );
      await fs.symlink(outside, path.join(tmpRoot, 'linked-out'));
    });

    afterAll(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });

    it('refuses a directory outside the import roots', async () => {
      const r = await call(`${mount.baseUrl}/api/agents/scan`, {
        method: 'POST',
        body: { path: outside },
      });
      expect(r.status).toBe(400);
      expect(r.text).toContain('outside the allowed import roots');
      expect(r.text).not.toContain('an agent outside');
    });

    it('refuses a symlink inside the workspace that points outside (containment runs on the realpath)', async () => {
      const r = await call(`${mount.baseUrl}/api/agents/scan`, {
        method: 'POST',
        body: { path: path.join(tmpRoot, 'linked-out') },
      });
      expect(r.status).toBe(400);
      expect(r.text).not.toContain('an agent outside');
    });

    it('scans a directory inside the workspace', async () => {
      const r = await call<Array<{ suggestedName: string }>>(
        `${mount.baseUrl}/api/agents/scan`,
        { method: 'POST', body: { path: path.join(tmpRoot, 'agents') } },
      );
      expect(r.status).toBe(200);
      expect(r.body.map(a => a.suggestedName)).toContain('scanner');
    });
  });

  // ── /api/mcp-servers ─────────────────────────────────────────────────────
  describe('/api/mcp-servers', () => {
    const registryFile = () => path.join(tmpRoot, 'mcp', 'servers.json');
    const MCP = {
      token: 'svc-token-raw-value-7731',
      bearer: 'Bearer bearer-raw-value-7731',
      ref: '${connections:svc-token.value}',
    };

    beforeEach(async () => {
      await fs.mkdir(path.dirname(registryFile()), { recursive: true });
      await fs.writeFile(
        registryFile(),
        JSON.stringify({
          svc: {
            command: 'svc-mcp',
            args: ['--port', '1'],
            env: { SVC_TOKEN: MCP.token, PLAIN: 'visible' },
            headers: { Authorization: MCP.bearer },
          },
          chained: { command: 'x', env: { T: MCP.ref } },
        }),
        'utf8',
      );
    });

    it('GET masks secret-looking values and connection refs, keeps the rest', async () => {
      const r = await call<Record<string, Record<string, unknown>>>(
        `${mount.baseUrl}/api/mcp-servers`,
      );
      expect(r.status).toBe(200);
      const svc = r.body.svc;
      expect((svc.env as Record<string, string>).SVC_TOKEN).not.toBe(MCP.token);
      expect((svc.env as Record<string, string>).PLAIN).toBe('visible');
      expect((svc.headers as Record<string, string>).Authorization).not.toBe(MCP.bearer);
      expect(svc.command).toBe('svc-mcp');
      expect(svc.args).toEqual(['--port', '1']);
      expect((r.body.chained.env as Record<string, string>).T).not.toBe(MCP.ref);
      expect(r.text).not.toContain(MCP.token);
      expect(r.text).not.toContain('bearer-raw-value');
    });

    it('PUT of the masked GET body round-trips the real values (the UI saves what it fetched)', async () => {
      const masked = (await call<Record<string, unknown>>(`${mount.baseUrl}/api/mcp-servers`))
        .body;
      const r = await call(`${mount.baseUrl}/api/mcp-servers`, {
        method: 'PUT',
        body: masked,
      });
      expect(r.status).toBe(200);
      const disk = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
      expect(disk.svc.env.SVC_TOKEN).toBe(MCP.token);
      expect(disk.svc.headers.Authorization).toBe(MCP.bearer);
      expect(disk.chained.env.T).toBe(MCP.ref);
      expect(r.text).not.toContain(MCP.token);
    });

    it('PUT with a genuinely new value writes it', async () => {
      const masked = (
        await call<Record<string, Record<string, unknown>>>(`${mount.baseUrl}/api/mcp-servers`)
      ).body;
      const next = {
        ...masked,
        svc: {
          ...masked.svc,
          env: { ...(masked.svc.env as Record<string, string>), SVC_TOKEN: 'rotated-9999' },
        },
      };
      expect(
        (await call(`${mount.baseUrl}/api/mcp-servers`, { method: 'PUT', body: next })).status,
      ).toBe(200);
      const disk = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
      expect(disk.svc.env.SVC_TOKEN).toBe('rotated-9999');
      expect(disk.svc.env.PLAIN).toBe('visible');
    });
  });

  // ── GET /api/cost ────────────────────────────────────────────────────────
  describe('GET /api/cost', () => {
    it("the top-line spend is the caller's, not the workspace's", async () => {
      const now = Date.now();
      await mount.store.upsertRun({
        id: 'cost-alice',
        orchestrationName: 'spender',
        startedAt: now,
        endedAt: now,
        status: 'done',
        ownerId: ALICE,
        events: [{ type: 'phase-end', phaseName: 'p', costUsd: 1.25, ts: now } as never],
      });
      await mount.store.upsertRun({
        id: 'cost-bob',
        orchestrationName: 'spender',
        startedAt: now,
        endedAt: now,
        status: 'done',
        ownerId: BOB,
        events: [{ type: 'phase-end', phaseName: 'p', costUsd: 4, ts: now } as never],
      });
      const bob = await call<{ spend: { todayUsd: number } }>(`${mount.baseUrl}/api/cost`, {
        owner: BOB,
      });
      expect(bob.status).toBe(200);
      expect(bob.body.spend.todayUsd).toBeCloseTo(4, 6);
      const alice = await call<{ spend: { todayUsd: number } }>(`${mount.baseUrl}/api/cost`, {
        owner: ALICE,
      });
      expect(alice.body.spend.todayUsd).toBeCloseTo(1.25, 6);
    });
  });

  // ── errorOrchestration recovery ──────────────────────────────────────────
  describe('lifecycle.errorOrchestration recovery', () => {
    it("reads the budget under the failed run's owner, like the run it starts", async () => {
      const spy = jest.spyOn(mount.store, 'costSummary');
      try {
        const started = await call<{ id: string }>(`${mount.baseUrl}/api/runs/start`, {
          method: 'POST',
          owner: ALICE,
          body: { orchestrationName: 'failing-orch' },
        });
        expect(started.status).toBe(200);
        await waitFor(
          async () => {
            const r = await mount.store.getRun(started.body.id, ALICE);
            return r?.status === 'error' ? r : null;
          },
          'failing run errors',
        );
        const recovery = await waitFor(
          async () =>
            (await mount.store.listRuns(50, ALICE)).find(
              r => r.orchestrationName === 'recovery-orch',
            ) ?? null,
          'recovery run dispatched',
        );
        expect(recovery.ownerId).toBe(ALICE);
        // Every budget read in this window — the start route AND the
        // recovery dispatch — evaluated the owner's cap. Pre-fix the
        // recovery read passed no owner at all. Each loadBudgetState reads
        // spend twice: unscoped for the workspace ceiling and scoped for the
        // per-owner cap, so the scoped calls are what prove the owner was
        // threaded, and no call may name a DIFFERENT owner.
        const owners = spy.mock.calls.map(c => c[0]);
        const scoped = owners.filter(o => o !== undefined);
        expect(scoped.length).toBeGreaterThanOrEqual(2);
        expect(scoped.every(o => o === ALICE)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
