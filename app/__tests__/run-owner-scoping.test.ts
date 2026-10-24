/**
 * Cross-owner denial on EVERY per-run route.
 *
 * `SECURITY.md` lists owner scoping as a boundary that is meant to hold:
 * "A caller reading or mutating another owner's runs, deliveries or approvals
 * is a vulnerability." It did not hold. Only the LIST endpoint scoped; every
 * per-id REST route called `store.getRun(id)` with no owner comparison — and
 * could not have made one, because the store interface had no owner parameter
 * to pass. There was no test in the suite asserting denial on any route, which
 * is why a documented boundary could be absent for its whole life without
 * anything going red.
 *
 * Worst case was `fork`: it reads an arbitrary run's `stateJson.leafOutputs` —
 * every completed phase's output text — and seeds them into a NEW run owned by
 * the caller. Cross-tenant data extraction and cross-tenant execution in one
 * authenticated POST.
 *
 * The REST routes are not the only per-run surface. The A2A JSON-RPC endpoint
 * (`POST /api/a2a/:name`) is a complete parallel per-run API — follow-up
 * messages resume a task, tasks/get returns its artifacts, tasks/cancel stops
 * it, tasks/resubscribe streams its events, pushNotificationConfig/set points
 * every event of it at a caller-chosen URL — and every one of its methods
 * looked runs up with no owner either. Those are covered here too.
 *
 * This asserts both directions for each route: the owner still gets through,
 * and a different owner gets 404 (never 403 — a distinguishable response would
 * turn every route into an id-existence oracle); on the JSON-RPC surface the
 * equivalent is the protocol's "task not found" error.
 *
 * Runs are created through the real HTTP API against a real store and the real
 * executor; owners are the `X-Sammy-User` header the server already reads.
 */

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
const PLAIN = 'owner-plain';
const GATED = 'owner-gated';

function asOwner(owner: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-sammy-user': owner };
}

/**
 * Poll a run's status AS a given owner.
 *
 * The shared poller in the harness sends no identity header, so it resolves
 * owner `system` — which now correctly 404s on another owner's run. That is
 * the feature working, so this file needs its own owner-aware poller rather
 * than a weaker route.
 */
async function waitRunAs(
  baseUrl: string,
  owner: string,
  id: string,
  statuses: string[],
): Promise<{ status: string }> {
  return waitFor(
    async () => {
      const res = await fetch(`${baseUrl}/api/runs/${id}`, {
        headers: { 'x-sammy-user': owner },
      });
      if (!res.ok) return null;
      const run = (await res.json()) as { status: string };
      return statuses.includes(run.status) ? run : null;
    },
    `run ${id} (owner ${owner}) → ${statuses.join('|')}`,
    { timeoutMs: 20_000, intervalMs: 25 },
  );
}

async function start(
  baseUrl: string,
  owner: string,
  orchestrationName: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/runs/start`, {
    method: 'POST',
    headers: asOwner(owner),
    body: JSON.stringify({ orchestrationName }),
  });
  const body = (await res.json()) as { id: string | null };
  if (!body.id) throw new Error(`start failed: ${JSON.stringify(body)}`);
  return body.id;
}

describe('per-run routes are owner-scoped', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let aliceDone: string;
  let aliceGated: string;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('owner-scoping');
    await writeOrchestration(tmpRoot, {
      name: PLAIN,
      phases: [{ name: 'only', code: { source: "return 'secret-output';" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: GATED,
      phases: [
        { name: 'draft', code: { source: "return 'draft';" } },
        { name: 'review', code: { source: "return 'reviewed';" }, lock: true },
      ],
    });
    mount = await mountServer(tmpRoot);

    aliceDone = await start(mount.baseUrl, ALICE, PLAIN);
    await waitRunAs(mount.baseUrl, ALICE, aliceDone, ['done']);
    aliceGated = await start(mount.baseUrl, ALICE, GATED);
    await waitRunAs(mount.baseUrl, ALICE, aliceGated, ['paused']);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  // ── reads ────────────────────────────────────────────────────────────────
  describe('reads', () => {
    it.each([
      ['GET :id', (id: string) => `/api/runs/${id}`],
      ['GET :id/summary', (id: string) => `/api/runs/${id}/summary`],
      ['GET :id/status', (id: string) => `/api/runs/${id}/status`],
      ['GET :id/trace', (id: string) => `/api/runs/${id}/trace`],
      ['GET :id/events', (id: string) => `/api/runs/${id}/events`],
    ])('%s — owner 200, other owner 404', async (_label, path) => {
      const mine = await fetch(`${mount.baseUrl}${path(aliceDone)}`, {
        headers: { 'x-sammy-user': ALICE },
      });
      expect(mine.status).toBe(200);

      const theirs = await fetch(`${mount.baseUrl}${path(aliceDone)}`, {
        headers: { 'x-sammy-user': BOB },
      });
      // 404, not 403: a distinguishable answer would confirm the id exists.
      expect(theirs.status).toBe(404);
    });

    it('the full event stream does not leak phase output to another owner', async () => {
      // The concrete harm, not just the status code: `getRun` ships every
      // event body, which is where agent/code output lives.
      const mine = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        headers: { 'x-sammy-user': ALICE },
      });
      expect(JSON.stringify(await mine.json())).toContain('secret-output');

      const theirs = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        headers: { 'x-sammy-user': BOB },
      });
      expect(theirs.status).toBe(404);
      expect(await theirs.text()).not.toContain('secret-output');
    });

    it('the list endpoint stays scoped (it always was)', async () => {
      const mine = (await (
        await fetch(`${mount.baseUrl}/api/runs`, {
          headers: { 'x-sammy-user': ALICE },
        })
      ).json()) as Array<{ id: string }>;
      expect(mine.map(r => r.id)).toContain(aliceDone);

      const theirs = (await (
        await fetch(`${mount.baseUrl}/api/runs`, {
          headers: { 'x-sammy-user': BOB },
        })
      ).json()) as Array<{ id: string }>;
      expect(theirs.map(r => r.id)).not.toContain(aliceDone);
    });
  });

  // ── A2A JSON-RPC task surface ────────────────────────────────────────────
  describe('A2A task methods are owner-scoped', () => {
    const TASK_NOT_FOUND = -32001;
    const INVALID_PARAMS = -32602;
    type Rpc = {
      result?: Record<string, unknown> | null;
      error?: { code: number; message: string };
    };

    async function rpc(
      owner: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<Rpc> {
      const res = await fetch(`${mount.baseUrl}/api/a2a/${GATED}`, {
        method: 'POST',
        headers: asOwner(owner),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as Rpc;
    }

    const followUp = (id: string) => ({
      message: {
        role: 'user',
        kind: 'message',
        messageId: 'm1',
        taskId: id,
        parts: [{ kind: 'text', text: 'carry on' }],
      },
    });

    it.each([
      ['tasks/get', (id: string) => ({ id })],
      ['tasks/cancel', (id: string) => ({ id })],
      ['tasks/resubscribe', (id: string) => ({ id })],
      ['tasks/pushNotificationConfig/get', (id: string) => ({ id })],
      [
        'tasks/pushNotificationConfig/set',
        (id: string) => ({
          id,
          pushNotificationConfig: { url: 'http://hooks.example.test/x' },
        }),
      ],
      ['message/send', followUp],
      ['message/stream', followUp],
    ])('%s → "task not found" for a different owner', async (method, params) => {
      const out = await rpc(BOB, method, params(aliceGated));
      expect(out.result).toBeUndefined();
      expect(out.error?.code).toBe(TASK_NOT_FOUND);
      // No artifact leak alongside the denial.
      expect(JSON.stringify(out)).not.toContain('draft');
    });

    it("tasks/cancel by another owner leaves the run paused; a follow-up by another owner appends nothing", async () => {
      const run = (await (
        await fetch(`${mount.baseUrl}/api/runs/${aliceGated}`, {
          headers: { 'x-sammy-user': ALICE },
        })
      ).json()) as { status: string; events: Array<{ type: string }> };
      expect(run.status).toBe('paused');
      expect(run.events.some(e => e.type === 'phase-user-message')).toBe(false);
    });

    it('the owner reads their own task (tasks/get)', async () => {
      const out = await rpc(ALICE, 'tasks/get', { id: aliceGated });
      expect(out.error).toBeUndefined();
      expect(out.result?.id).toBe(aliceGated);
    });

    describe('tasks/pushNotificationConfig/set host allowlist', () => {
      const prev = process.env.SAMMY_NOTIFY_ALLOWED_HOSTS;
      afterEach(() => {
        if (prev === undefined) delete process.env.SAMMY_NOTIFY_ALLOWED_HOSTS;
        else process.env.SAMMY_NOTIFY_ALLOWED_HOSTS = prev;
      });

      it('refuses every URL when SAMMY_NOTIFY_ALLOWED_HOSTS is empty, and says so', async () => {
        delete process.env.SAMMY_NOTIFY_ALLOWED_HOSTS;
        const out = await rpc(ALICE, 'tasks/pushNotificationConfig/set', {
          id: aliceGated,
          pushNotificationConfig: { url: 'http://hooks.example.test/x' },
        });
        expect(out.error?.code).toBe(INVALID_PARAMS);
        expect(out.error?.message).toContain('SAMMY_NOTIFY_ALLOWED_HOSTS');
      });

      it('refuses a host outside the allowlist, by name', async () => {
        process.env.SAMMY_NOTIFY_ALLOWED_HOSTS = 'hooks.example.test';
        const out = await rpc(ALICE, 'tasks/pushNotificationConfig/set', {
          id: aliceGated,
          pushNotificationConfig: { url: 'http://exfil.example.test/x' },
        });
        expect(out.error?.code).toBe(INVALID_PARAMS);
        expect(out.error?.message).toContain('exfil.example.test');
      });

      it('an allowlisted host passes the URL gate (only the live-run check remains)', async () => {
        process.env.SAMMY_NOTIFY_ALLOWED_HOSTS = 'hooks.example.test';
        const out = await rpc(ALICE, 'tasks/pushNotificationConfig/set', {
          id: aliceGated,
          pushNotificationConfig: { url: 'http://hooks.example.test/x' },
        });
        // A gate-paused run has no live controller, so registration is
        // refused for THAT reason — not the allowlist, not ownership.
        expect(out.error?.message ?? '').not.toContain('SAMMY_NOTIFY_ALLOWED_HOSTS');
        expect(out.error?.message ?? '').not.toMatch(/^Task not found/);
      });
    });
  });

  // ── mutations ────────────────────────────────────────────────────────────
  describe('mutations by another owner are refused', () => {
    it.each([
      ['cancel', (id: string) => `/api/runs/${id}/cancel`, {}],
      ['stop', (id: string) => `/api/runs/${id}/stop`, {}],
      ['resume', (id: string) => `/api/runs/${id}/resume`, {}],
      ['signal', (id: string) => `/api/runs/${id}/signal`, { signal: 'go' }],
      [
        'gate',
        (id: string) => `/api/runs/${id}/gate`,
        { decision: 'approve' },
      ],
      [
        'fork',
        (id: string) => `/api/runs/${id}/fork`,
        { atPhase: 'draft' },
      ],
    ])('POST :id/%s → 404 for a different owner', async (_label, path, body) => {
      const res = await fetch(`${mount.baseUrl}${path(aliceGated)}`, {
        method: 'POST',
        headers: asOwner(BOB),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(404);
    });

    it("fork cannot copy another owner's leaf outputs into a new run", async () => {
      // Fork is the sharpest case: it seeds the source run's completed leaf
      // OUTPUTS as replay outputs into a run owned by the caller.
      const res = await fetch(`${mount.baseUrl}/api/runs/${aliceGated}/fork`, {
        method: 'POST',
        headers: asOwner(BOB),
        body: JSON.stringify({ atPhase: 'draft' }),
      });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain('draft');

      // And no run was created for Bob as a side effect.
      const bobRuns = (await (
        await fetch(`${mount.baseUrl}/api/runs`, {
          headers: { 'x-sammy-user': BOB },
        })
      ).json()) as Array<{ id: string }>;
      expect(bobRuns).toHaveLength(0);
    });

    it('DELETE :id → 404 for a different owner, and the run survives', async () => {
      const del = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        method: 'DELETE',
        headers: asOwner(BOB),
      });
      expect(del.status).toBe(404);

      // The important half: refused means NOT DELETED.
      const still = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        headers: { 'x-sammy-user': ALICE },
      });
      expect(still.status).toBe(200);
    });

    it('the owner can still act on their own run', async () => {
      // Guard against "fixed" by breaking everything: Alice's gate approval
      // must still work end to end.
      const res = await fetch(`${mount.baseUrl}/api/runs/${aliceGated}/gate`, {
        method: 'POST',
        headers: asOwner(ALICE),
        body: JSON.stringify({ decision: 'approve' }),
      });
      expect(res.status).toBe(200);
      const done = await waitRunAs(mount.baseUrl, ALICE, aliceGated, ['done']);
      expect(done.status).toBe('done');
    });

    it('records WHO decided the gate (approval audit trail)', async () => {
      // The gate-decision event recorded phase, decision, message and time —
      // and no actor. "Human review as a product" is the headline capability,
      // and its audit record could not answer "who approved this release".
      const run = (await (
        await fetch(`${mount.baseUrl}/api/runs/${aliceGated}`, {
          headers: { 'x-sammy-user': ALICE },
        })
      ).json()) as { events: Array<Record<string, unknown>> };
      const decisions = run.events.filter(e => e.type === 'gate-decision');
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions[0].decidedBy).toBe(ALICE);
      expect(decisions[0].decision).toBe('approve');
    });

    it('the owner can delete their own run', async () => {
      const del = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        method: 'DELETE',
        headers: asOwner(ALICE),
      });
      expect(del.status).toBe(204);
      const gone = await fetch(`${mount.baseUrl}/api/runs/${aliceDone}`, {
        headers: { 'x-sammy-user': ALICE },
      });
      expect(gone.status).toBe(404);
    });
  });

  // ── the default-owner path must be unchanged ─────────────────────────────
  it('an anonymous caller still sees anonymous runs (single-user dev)', async () => {
    // With no header the server resolves owner `system`, so a local
    // single-user workflow — which never sends one — is unaffected.
    const id = await (async () => {
      const res = await fetch(`${mount.baseUrl}/api/runs/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orchestrationName: PLAIN }),
      });
      return ((await res.json()) as { id: string }).id;
    })();
    await waitRunAs(mount.baseUrl, 'system', id, ['done']);
    const read = await fetch(`${mount.baseUrl}/api/runs/${id}`);
    expect(read.status).toBe(200);
  });
});
