/**
 * /api/deliveries is owner-scoped on every verb, headerless included.
 *
 * It was the one route that resolved identity by hand instead of through
 * `extractOwnerId`, and the hand-rolled version turned an absent header into
 * `undefined` — which the store reads as UNSCOPED. So a caller who sent no
 * header saw every owner's rows (raw webhook bodies included), the replay
 * ownership check was skipped entirely (it sat inside `if (ownerId)`), and
 * the stats were global. Everywhere else, anonymous means `system`.
 */

import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(45_000);

type Row = { id: string; ownerId: string; body?: string };

describe('/api/deliveries owner scoping', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let aliceId: string;

  const list = async (headers?: Record<string, string>): Promise<Row[]> =>
    (await (await fetch(`${mount.baseUrl}/api/deliveries?limit=100`, { headers })).json()) as Row[];
  const stats = async (headers?: Record<string, string>) =>
    (await (await fetch(`${mount.baseUrl}/api/deliveries/stats`, { headers })).json()) as {
      total: number;
      byStatus: Record<string, number>;
      duplicatesSuppressed: number;
    };

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('deliveries-scope');
    await writeOrchestration(tmpRoot, {
      name: 'd-orch',
      triggers: [{ kind: 'webhook', path: 'd-hook', method: 'POST' }],
      phases: [{ name: 'p', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);
    // One delivery per owner: alice, bob, and an anonymous (system) sender.
    // Alice's second fire reuses her idempotency key so her row carries a
    // suppressed duplicate the stats can be checked against.
    const fire = (headers: Record<string, string>, n: number) =>
      postJson<{ deliveryId: string }>(`${mount.baseUrl}/api/triggers/d-hook`, { n }, headers);
    aliceId = (await fire({ 'x-sammy-user': 'alice', 'idempotency-key': 'k-alice' }, 1)).body
      .deliveryId;
    await fire({ 'x-sammy-user': 'alice', 'idempotency-key': 'k-alice' }, 1);
    await fire({ 'x-sammy-user': 'bob' }, 2);
    await fire({}, 3);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('the list is scoped to the caller — and headerless means system, not everyone', async () => {
    expect((await list({ 'x-sammy-user': 'alice' })).map(r => r.ownerId)).toEqual(['alice']);
    expect((await list({ 'x-sammy-user': 'bob' })).map(r => r.ownerId)).toEqual(['bob']);
    const anon = await list();
    expect(anon.map(r => r.ownerId)).toEqual(['system']);
    // The thing that leaked: another tenant's raw webhook body.
    expect(JSON.stringify(anon)).not.toContain('"n":1');
  });

  it('stats are scoped the same way', async () => {
    const alice = await stats({ 'x-sammy-user': 'alice' });
    expect(alice.total).toBe(1);
    expect(alice.byStatus.pending).toBe(1);
    expect(alice.duplicatesSuppressed).toBe(1);
    const anon = await stats();
    expect(anon.total).toBe(1);
    expect(anon.duplicatesSuppressed).toBe(0);
  });

  it('replay is refused across owners — headerless included — as 404, not an oracle', async () => {
    // Ownership is checked BEFORE the replayable-state check, so a foreign
    // caller sees 404 and the owner (whose row is merely not replayable
    // yet) sees 409: the two responses prove which check ran.
    const replay = (headers?: Record<string, string>) =>
      postJson(`${mount.baseUrl}/api/deliveries/${aliceId}/replay`, undefined, headers);
    expect((await replay()).status).toBe(404);
    expect((await replay({ 'x-sammy-user': 'bob' })).status).toBe(404);
    expect((await replay({ 'x-sammy-user': 'alice' })).status).toBe(409);
  });
});
