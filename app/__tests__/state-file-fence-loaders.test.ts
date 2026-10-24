/**
 * "A server state file is never an orchestration" — at every LOADER, not just
 * at the orchestration handler.
 *
 * The import routes refuse a state file as a SOURCE, and the orchestration
 * routes refuse one as a SINK (`resolvesToServerStateFile`), which is what
 * makes a link an earlier build or a hand edit already left in `examples/`
 * harmless THERE. It was not harmless everywhere: the same name goes to
 * `loadRunContext` from the run mirror, `/api/runs/start`, `/api/preview`,
 * the A2A RPC and every trigger fire, and whatever that returns is persisted
 * as the run's `orchestrationSnapshot` — which `GET /api/runs` (the 4-second
 * UI poll) and `GET /api/runs/:id` republish verbatim. So the fence answered
 * 404 on one route while another shipped the whole credential registry in
 * plaintext, to an identity the entry's `owners` list does not name.
 *
 * The agent surface had the same hole on BOTH halves: `GET /api/agents`
 * returns every file's contents, and `PUT /api/agents/:name` writes THROUGH a
 * symlink (write-through to an imported agent is a documented feature), so a
 * planted link there was a credential read AND a credential overwrite.
 *
 * Every case plants the link the way the exploited import route used to, then
 * drives the real mount. The no-drift cases are not decoration: the fence must
 * not stop a legitimately imported (symlinked) orchestration or agent from
 * loading, which is the whole reason it tests the realpath rather than
 * containment.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const SECRET = 'ATATT3xFfGF0onlyaliceconnection0123456789';
const BOB = 'bob';

describe('the state-file fence holds at every loader', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let tmpRoot: string;
  let credentialsFile: string;
  /** A real orchestration, imported the documented way: a SYMLINK into
   *  examples/ from outside it. The fence must leave this one alone. */
  let importedSource: string;

  async function writeCredentials(): Promise<void> {
    await fs.writeFile(
      credentialsFile,
      JSON.stringify(
        {
          'alice-jira': {
            kind: 'atlassian',
            value: SECRET,
            owners: ['alice'],
            fields: { email: 'ops@acme.test', site: 'https://alice.example.test' },
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  async function call(
    pathname: string,
    init: { method?: string; body?: unknown; owner?: string } = {},
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${mount.baseUrl}${pathname}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(init.owner ? { 'x-sammy-user': init.owner } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('state-file-fence');
    credentialsFile = path.join(tmpRoot, 'credentials.json');
    await writeCredentials();
    await writeOrchestration(tmpRoot, {
      name: 'plain-orch',
      phases: [{ name: 'p', code: { source: "return 'ok'" } }],
    });
    // The planted links — `examples/leak.json` and `agents/leak.md`, both
    // pointing at the connections file.
    await fs.symlink(credentialsFile, path.join(tmpRoot, 'examples', 'leak.json'));
    await fs.mkdir(path.join(tmpRoot, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'agents', 'real-agent.md'),
      '# a real agent\n',
      'utf8',
    );
    await fs.symlink(credentialsFile, path.join(tmpRoot, 'agents', 'leak.md'));
    // A legitimate import: the source lives outside examples/, the entry is a
    // link to it.
    importedSource = path.join(tmpRoot, 'imported-orch.json');
    await fs.writeFile(
      importedSource,
      JSON.stringify({
        name: 'imported-orch',
        phases: [{ name: 'p', code: { source: "return 'imported'" } }],
      }),
      'utf8',
    );
    await fs.symlink(
      importedSource,
      path.join(tmpRoot, 'examples', 'imported-orch.json'),
    );
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  beforeEach(writeCredentials);

  it('CONTROL: the handler fence already refuses the orchestration routes', async () => {
    const one = await call('/api/orchestrations/leak', { owner: BOB });
    expect(one.status).toBe(404);
    const list = await call('/api/orchestrations', { owner: BOB });
    expect(list.text).not.toContain(SECRET);
  });

  // ── The run surface ─────────────────────────────────────────────────────
  it('the run mirror refuses the planted name instead of storing the registry as a snapshot', async () => {
    const mirrored = await call('/api/runs', {
      method: 'POST',
      owner: BOB,
      body: {
        id: 'planted-mirror',
        orchestrationName: 'leak',
        status: 'done',
        events: [],
      },
    });
    expect(mirrored.status).toBe(404);

    const detail = await call('/api/runs/planted-mirror', { owner: BOB });
    expect(detail.text).not.toContain(SECRET);
    const list = await call('/api/runs', { owner: BOB });
    expect(list.text).not.toContain(SECRET);
    expect(await mount.store.getRun('planted-mirror')).toBeNull();
  });

  it('/api/runs/start refuses to run the registry as an orchestration', async () => {
    const started = await call('/api/runs/start', {
      method: 'POST',
      body: { orchestrationName: 'leak' },
    });
    expect(started.status).toBe(404);
    const list = await call('/api/runs');
    expect(list.text).not.toContain(SECRET);
  });

  it('/api/preview refuses it too', async () => {
    const preview = await call('/api/preview', {
      method: 'POST',
      body: { orchestrationName: 'leak' },
    });
    expect(preview.status).toBe(404);
    expect(preview.text).not.toContain(SECRET);
  });

  it('the A2A RPC refuses it, with the not-found answer', async () => {
    const rpc = await call('/api/a2a/leak', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
      },
    });
    expect(rpc.text).not.toContain(SECRET);
    expect(rpc.text).toContain('Orchestration not found');
  });

  // ── The agent surface, both halves ──────────────────────────────────────
  it('the agent listing skips a planted link instead of printing the registry', async () => {
    const list = await call('/api/agents');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(SECRET);
    expect(list.text).toContain('real-agent');
  });

  it('GET /api/agents/:name is 404-shaped for a planted link', async () => {
    const one = await call('/api/agents/leak');
    expect(one.status).toBe(404);
    expect(one.text).not.toContain(SECRET);
  });

  it('PUT /api/agents/:name refuses to write THROUGH a planted link', async () => {
    const put = await call('/api/agents/leak', {
      method: 'PUT',
      body: { raw: 'OVERWRITTEN' },
    });
    expect(put.status).toBe(404);
    // The write half: the connections file is still the connections file.
    const onDisk = JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
    expect(onDisk['alice-jira'].value).toBe(SECRET);
  });

  // ── No drift: the fence is about WHAT the file is, not where it lives ───
  it('a legitimately imported (symlinked) orchestration still loads and runs', async () => {
    const one = await call('/api/orchestrations/imported-orch');
    expect(one.status).toBe(200);
    const preview = await call('/api/preview', {
      method: 'POST',
      body: { orchestrationName: 'imported-orch' },
    });
    expect(preview.status).toBe(200);
    const started = await call('/api/runs/start', {
      method: 'POST',
      body: { orchestrationName: 'imported-orch' },
    });
    expect(started.status).toBe(200);
    // Let it finish inside the test rather than leaving an executor running
    // past teardown.
    const { id } = JSON.parse(started.text) as { id: string };
    await waitForRun(mount.baseUrl, id, ['done', 'error']);
  });

  it('an ordinary agent still reads and writes', async () => {
    const one = await call('/api/agents/real-agent');
    expect(one.status).toBe(200);
    const put = await call('/api/agents/real-agent', {
      method: 'PUT',
      body: { raw: '# edited\n' },
    });
    expect(put.status).toBe(200);
    expect(
      await fs.readFile(path.join(tmpRoot, 'agents', 'real-agent.md'), 'utf8'),
    ).toBe('# edited\n');
  });

  it('an ordinary run still mirrors with the server-loaded snapshot', async () => {
    const mirrored = await call('/api/runs', {
      method: 'POST',
      owner: BOB,
      body: {
        id: 'plain-mirror',
        orchestrationName: 'plain-orch',
        status: 'done',
        events: [],
      },
    });
    expect(mirrored.status).toBe(200);
    const stored = await mount.store.getRun('plain-mirror');
    expect(
      (stored?.orchestrationSnapshot as { name?: string } | null)?.name,
    ).toBe('plain-orch');
  });
});
