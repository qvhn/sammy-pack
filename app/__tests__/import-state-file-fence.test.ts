/**
 * The server's own state files are not importable content.
 *
 * `importRoots()` always includes the workspace root, and the default
 * connections file is `<root>/credentials.json` — so the import confinement
 * (which only ever asked "is this inside an allowed root?") accepted the
 * credential store itself. `POST /api/orchestrations/import` symlinked it into
 * `examples/`, and from there two routes finished the job:
 *
 *   - `GET /api/orchestrations/<as>` returns the symlink target VERBATIM, so
 *     one read defeated both credential controls at once — `maskCredentialEntry`
 *     (the quarter rule) and the per-entry `owners` allowlist, which an
 *     identity the entry does not list bypasses entirely.
 *   - `PUT /api/orchestrations/<as>` writes THROUGH the link, replacing the
 *     operator's credential store with caller-chosen JSON — defeating the
 *     owner check and the cannot-move-while-masked rule `PUT /api/credentials`
 *     enforces.
 *
 * Both halves are driven here, over the real mount, because the unit cases in
 * `import-confinement.test.ts` would stay green under a sink-only regression
 * (a link already on disk from a pre-fix build, or a hand-made one in a
 * bind-mounted data dir, never goes through `checkImportSource` again).
 *
 * Write-through to an imported file is a DOCUMENTED feature, so the fence is
 * not "the realpath must stay inside examples/" — it is "a server state file
 * is never an orchestration". The legitimate-import case below is what pins
 * that distinction.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const SECRET = 'ATATT3xFfGF0-ONLY-ALICE-MAY-SEE-THIS-0123456789';

async function call<T = unknown>(
  url: string,
  init: { method?: string; owner?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.owner ? { 'x-sammy-user': init.owner } : {}),
    },
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

type ImportReply = {
  imported: string[];
  copied: string[];
  skipped: Array<{ from: string; as: string; reason: string }>;
};

describe('server state files are not importable', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let tmpRoot: string;
  let credentialsFile: string;

  async function writeStateFiles(): Promise<void> {
    await fs.writeFile(
      credentialsFile,
      JSON.stringify({
        'alice-jira': {
          kind: 'jira',
          value: SECRET,
          owners: ['alice'],
          fields: { site: 'https://alice.example.test' },
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'budget.json'),
      JSON.stringify({ limits: { daily: { usd: 5 } } }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpRoot, 'mcp'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'mcp', 'servers.json'),
      JSON.stringify({ gh: { command: 'gh-mcp', env: { GH_TOKEN: SECRET } } }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpRoot, 'hooks'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'hooks', 'hooks.json'),
      JSON.stringify({}),
      'utf8',
    );
  }

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await fs.realpath(await makeWorkspace('state-file-fence'));
    credentialsFile = path.join(tmpRoot, 'credentials.json');
    await writeStateFiles();
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  beforeEach(writeStateFiles);

  it('masks the credential through its own route (the control this bypassed)', async () => {
    const r = await call<Record<string, Record<string, unknown>>>(
      `${mount.baseUrl}/api/credentials`,
      { owner: 'alice' },
    );
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(SECRET);
    // …and it is invisible to anyone the `owners` list does not name.
    const bob = await call<Record<string, unknown>>(
      `${mount.baseUrl}/api/credentials`,
      { owner: 'bob' },
    );
    expect(Object.keys(bob.body)).toEqual([]);
  });

  it('refuses every server state file as an import source, by name', async () => {
    for (const [as, from] of [
      ['leak-creds', credentialsFile],
      ['leak-budget', path.join(tmpRoot, 'budget.json')],
      ['leak-mcp', path.join(tmpRoot, 'mcp', 'servers.json')],
      ['leak-hooks', path.join(tmpRoot, 'hooks', 'hooks.json')],
    ] as const) {
      const r = await call<ImportReply>(
        `${mount.baseUrl}/api/orchestrations/import`,
        { method: 'POST', body: { from, as } },
      );
      expect(r.status).toBe(200);
      expect(r.body.imported).toEqual([]);
      expect(r.body.skipped).toHaveLength(1);
      expect(r.body.skipped[0].reason).toContain("server's own state files");
      // Nothing landed in examples/, so neither read half is reachable.
      expect(
        await fs.lstat(path.join(tmpRoot, 'examples', `${as}.json`)).catch(() => null),
      ).toBeNull();
    }
  });

  it('refuses a FOLDER import that contains a state file, and imports the rest', async () => {
    // The folder shape re-checks each file, so the deny list must hold there
    // too — the root itself is the most natural folder to point at.
    const r = await call<ImportReply>(
      `${mount.baseUrl}/api/orchestrations/import`,
      { method: 'POST', body: { from: tmpRoot } },
    );
    expect(r.status).toBe(200);
    expect(r.body.imported).not.toContain('credentials');
    expect(r.body.imported).not.toContain('budget');
    expect(
      r.body.skipped.filter(s => s.reason.includes("server's own state files")),
    ).not.toHaveLength(0);
  });

  it('still imports an ordinary .json from inside the workspace', async () => {
    const src = path.join(tmpRoot, 'legit-orch.json');
    await fs.writeFile(
      src,
      JSON.stringify({ name: 'legit-orch', phases: [{ name: 'p', agent: 'x' }] }),
      'utf8',
    );
    const r = await call<ImportReply>(
      `${mount.baseUrl}/api/orchestrations/import`,
      { method: 'POST', body: { from: src, as: 'legit' } },
    );
    expect(r.status).toBe(200);
    expect(r.body.imported).toEqual(['legit']);
    // The documented write-through feature still works on it: the PUT must
    // reach the SOURCE file, not just the link.
    const put = await call(`${mount.baseUrl}/api/orchestrations/legit`, {
      method: 'PUT',
      body: { name: 'legit', phases: [{ name: 'p2', agent: 'x' }] },
    });
    expect(put.status).toBe(200);
    expect(await fs.readFile(src, 'utf8')).toContain('p2');
    await fs.unlink(path.join(tmpRoot, 'examples', 'legit.json'));
  });

  // ── The sink half: a link that is already on disk ────────────────────────
  describe('a pre-planted link to a state file', () => {
    const LINK = 'leak';

    beforeEach(async () => {
      const target = path.join(tmpRoot, 'examples', `${LINK}.json`);
      await fs.unlink(target).catch(() => {});
      await fs.symlink(credentialsFile, target);
    });

    afterEach(async () => {
      await fs.unlink(path.join(tmpRoot, 'examples', `${LINK}.json`)).catch(() => {});
    });

    it('is not readable through the orchestration GET, by anyone', async () => {
      for (const owner of [undefined, 'bob', 'alice']) {
        const r = await call(`${mount.baseUrl}/api/orchestrations/${LINK}`, {
          owner,
        });
        expect(r.status).toBe(404);
        expect(r.text).not.toContain(SECRET);
      }
    });

    it('is not readable through the orchestration LIST either', async () => {
      const r = await call<unknown[]>(`${mount.baseUrl}/api/orchestrations`);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(SECRET);
    });

    it('cannot be written through: the credential store survives the PUT', async () => {
      const before = await fs.readFile(credentialsFile, 'utf8');
      const r = await call(`${mount.baseUrl}/api/orchestrations/${LINK}`, {
        method: 'PUT',
        body: {
          name: LINK,
          phases: [{ name: 'p', agent: 'x' }],
          'bob-tok': { kind: 'github', value: 'bobs-pat', owners: ['bob'] },
        },
      });
      expect(r.status).toBe(404);
      expect(await fs.readFile(credentialsFile, 'utf8')).toBe(before);
      // And the planted entry never became a live registry entry.
      const creds = await call<Record<string, unknown>>(
        `${mount.baseUrl}/api/credentials`,
        { owner: 'bob' },
      );
      expect(Object.keys(creds.body)).toEqual([]);
    });

    it('does not break the listing of real orchestrations beside it', async () => {
      await writeOrchestration(tmpRoot, {
        name: 'real-orch',
        phases: [{ name: 'p', agent: 'x' }],
      });
      const r = await call<Array<{ name?: string }>>(
        `${mount.baseUrl}/api/orchestrations`,
      );
      expect(r.status).toBe(200);
      expect(r.body.map(o => o.name)).toContain('real-orch');
    });
  });
});
