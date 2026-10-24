/**
 * The SSE stream authenticates and scopes through the query string.
 *
 * An EventSource cannot send headers. That bought `/api/runs/:id/events` an
 * exemption from both auth gates — and the exemption did not strip
 * `X-Sammy-User`, so under SAMMY_API_TOKEN + SAMMY_REQUIRE_AUTH_READS=1 an
 * anonymous caller with a chosen header streamed any owner's run.
 * Meanwhile the UI's own headerless EventSource resolved to `system` and
 * 404'd on every other run. One design problem, two symptoms.
 *
 * Now `?token=` is lifted into `Authorization` and `?owner=` into
 * `X-Sammy-User` for this ONE route before the gates run, so a query token is
 * verified by the same bearer / JWT code as a header token, and the stream
 * needs no exemption. Each posture is pinned here against the real mount.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { signJwtHS256 } from '../src/server/jwt-verify';

jest.setTimeout(60_000);

const ORCH = 'sse-orch';

async function startAs(
  mount: Mount,
  headers: Record<string, string>,
): Promise<string> {
  const { status, body } = await postJson<{ id: string }>(
    `${mount.baseUrl}/api/runs/start`,
    { orchestrationName: ORCH },
    headers,
  );
  if (status !== 200) throw new Error(`start → ${status}: ${JSON.stringify(body)}`);
  // Let it finish so the stream replays the log and ENDS (a plain fetch of a
  // live stream would hang).
  await waitFor(
    async () => {
      const res = await fetch(`${mount.baseUrl}/api/runs/${body.id}`, { headers });
      if (!res.ok) return null;
      const run = (await res.json()) as { status: string };
      return run.status === 'done' ? run : null;
    },
    `run ${body.id} → done`,
    { timeoutMs: 20_000, intervalMs: 25 },
  );
  return body.id;
}

const events = (mount: Mount, id: string, query = '', headers?: Record<string, string>) =>
  fetch(`${mount.baseUrl}/api/runs/${id}/events${query}`, { headers });

describe('SSE identity — open-reads posture (the default)', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let aliceRun: string;
  let systemRun: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('sse-open');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
    aliceRun = await startAs(mount, { 'x-sammy-user': 'alice' });
    systemRun = await startAs(mount, {});
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('a UI-shaped headerless EventSource streams a system-owned run', async () => {
    const res = await events(mount, systemRun);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[DONE]');
  });

  it('headerless, another owner’s run is 404 (the symptom the UI hit)', async () => {
    expect((await events(mount, aliceRun)).status).toBe(404);
  });

  it('?owner= is accepted as the identity, at the header’s trust level', async () => {
    const res = await events(mount, aliceRun, '?owner=alice');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[DONE]');
    // Same channel, same (spoofable) trust: a wrong owner is still a miss.
    expect((await events(mount, aliceRun, '?owner=bob')).status).toBe(404);
  });

  it('a header, when present, wins over the query', async () => {
    const res = await events(mount, aliceRun, '?owner=alice', { 'x-sammy-user': 'bob' });
    expect(res.status).toBe(404);
  });
});

describe('SSE identity — bearer posture with reads gated', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let aliceRun: string;
  const TOKEN = 'sse-bearer-token';
  const prevReads = process.env.SAMMY_REQUIRE_AUTH_READS;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_API_TOKEN = TOKEN;
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    const tmpRoot = await makeWorkspace('sse-bearer');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
    aliceRun = await startAs(mount, { ...auth, 'x-sammy-user': 'alice' });
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevReads === undefined) delete process.env.SAMMY_REQUIRE_AUTH_READS;
    else process.env.SAMMY_REQUIRE_AUTH_READS = prevReads;
    restoreEnv?.();
  });

  it('anonymous + spoofed X-Sammy-User no longer streams another owner’s run', async () => {
    const res = await events(mount, aliceRun, '', { 'x-sammy-user': 'alice' });
    expect([401, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('?owner= without a token is refused — the query is no back door past the gate', async () => {
    expect((await events(mount, aliceRun, '?owner=alice')).status).toBe(401);
  });

  it('?token= is checked by the SAME bearer gate as the header', async () => {
    expect((await events(mount, aliceRun, '?token=wrong&owner=alice')).status).toBe(401);
    const ok = await events(mount, aliceRun, `?token=${TOKEN}&owner=alice`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('[DONE]');
  });

  it('a valid ?token= with no owner is scoped to system, like a headerless fetch', async () => {
    expect((await events(mount, aliceRun, `?token=${TOKEN}`)).status).toBe(404);
  });

  it('no other route accepts credentials in the query', async () => {
    const res = await fetch(`${mount.baseUrl}/api/runs?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });
});

describe('SSE identity — JWT posture with reads gated', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let aliceRun: string;
  const SECRET = 'sse-jwt-secret';
  const prevReads = process.env.SAMMY_REQUIRE_AUTH_READS;
  const jwt = (sub: string) => signJwtHS256({ sub }, SECRET);

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_JWT_SECRET = SECRET;
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    const tmpRoot = await makeWorkspace('sse-jwt');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
    aliceRun = await startAs(mount, { authorization: `Bearer ${jwt('alice')}` });
  });

  afterAll(async () => {
    await mount?.kill();
    if (prevReads === undefined) delete process.env.SAMMY_REQUIRE_AUTH_READS;
    else process.env.SAMMY_REQUIRE_AUTH_READS = prevReads;
    restoreEnv?.();
  });

  it('a verified ?token= JWT is the identity; ?owner= cannot override it', async () => {
    expect((await events(mount, aliceRun)).status).toBe(401);
    expect((await events(mount, aliceRun, `?token=${jwt('alice')}`)).status).toBe(200);
    expect((await events(mount, aliceRun, `?token=${jwt('bob')}`)).status).toBe(404);
    // The verified claim overwrites the client-supplied owner, as it does
    // for the header.
    expect(
      (await events(mount, aliceRun, `?token=${jwt('bob')}&owner=alice`)).status,
    ).toBe(404);
  });
});
