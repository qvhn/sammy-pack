import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { importLegacyRunFiles } from '../src/server/run-store';
import { describeRunStoreContract } from './run-store-contract.helpers';

let tmpRoot: string;
let store: SqliteRunStore | null = null;

async function freshStore(): Promise<SqliteRunStore> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
  return store;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-db-'));
});

afterEach(async () => {
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runs CRUD', () => {
  it('upsert + read round-trips header + events in seq order', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'run-1',
      orchestrationName: 'ticket-to-pr',
      startedAt: 1000,
      endedAt: 2000,
      status: 'done',
      orchestrationSnapshot: { name: 'ticket-to-pr', phases: [] },
      initialInput: 'JIRA-42',
      events: [
        { type: 'run-start', orchestrationName: 'ticket-to-pr', ts: 1001 },
        { type: 'phase-start', phaseName: 'spec', ts: 1100 },
        { type: 'run-end', ts: 1999 },
      ],
    });
    const got = await s.getRun('run-1');
    expect(got?.id).toBe('run-1');
    expect(got?.status).toBe('done');
    expect(got?.startedAt).toBe(1000);
    expect(got?.endedAt).toBe(2000);
    expect(got?.events.map(e => e.type)).toEqual([
      'run-start',
      'phase-start',
      'run-end',
    ]);
    expect(got?.eventVersion).toBe(3);
    expect(got?.orchestrationSnapshot).toEqual({
      name: 'ticket-to-pr',
      phases: [],
    });
    expect(got?.initialInput).toBe('JIRA-42');
  });

  it('upsert replaces events for the same id', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'a', ts: 1 }, { type: 'b', ts: 2 }],
    });
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'done',
      endedAt: 99,
      events: [{ type: 'c', ts: 3 }],
    });
    const got = await s.getRun('r');
    expect(got?.events.map(e => e.type)).toEqual(['c']);
    expect(got?.status).toBe('done');
    expect(got?.endedAt).toBe(99);
  });

  it('listRuns returns headers in started_at DESC, no events', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'old',
      orchestrationName: 'a',
      startedAt: 100,
      status: 'done',
      events: [{ type: 'e1' }],
    });
    await s.upsertRun({
      id: 'new',
      orchestrationName: 'b',
      startedAt: 200,
      status: 'done',
      events: [{ type: 'e2' }],
    });
    const list = await s.listRuns();
    expect(list.map(r => r.id)).toEqual(['new', 'old']);
    expect(
      (list[0] as unknown as { events?: unknown }).events,
    ).toBeUndefined();
  });

  it('listRuns scopes by ownerId when one is provided', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'alice-1',
      orchestrationName: 'x',
      startedAt: 100,
      status: 'done',
      events: [],
      ownerId: 'alice',
    });
    await s.upsertRun({
      id: 'bob-1',
      orchestrationName: 'y',
      startedAt: 200,
      status: 'done',
      events: [],
      ownerId: 'bob',
    });
    await s.upsertRun({
      id: 'system-1',
      orchestrationName: 'z',
      startedAt: 300,
      status: 'done',
      events: [],
      // No ownerId — falls back to 'system'.
    });
    expect((await s.listRuns(500, 'alice')).map(r => r.id)).toEqual(['alice-1']);
    expect((await s.listRuns(500, 'bob')).map(r => r.id)).toEqual(['bob-1']);
    expect((await s.listRuns()).map(r => r.id).sort()).toEqual([
      'alice-1',
      'bob-1',
      'system-1',
    ]);
    expect((await s.getRun('system-1'))?.ownerId).toBe('system');
  });

  it('deleteRun cascades to events', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'gone',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'done',
      events: [{ type: 'a' }, { type: 'b' }],
    });
    expect(await s.deleteRun('gone')).toBe(true);
    expect(await s.getRun('gone')).toBeNull();
    expect(await s.deleteRun('gone')).toBe(false);
  });
});

describe('appendEvent', () => {
  it('assigns monotonically increasing seq numbers', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'live',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'seed', ts: 1 }],
    });
    await s.appendEvent('live', { type: 'first', ts: 10 });
    await s.appendEvent('live', { type: 'second', ts: 20 });
    await s.appendEvent('live', { type: 'third', ts: 30 });
    const got = await s.getRun('live');
    expect(got?.events.map(e => e.type)).toEqual([
      'seed',
      'first',
      'second',
      'third',
    ]);
  });

  it('falls back to Date.now when event has no ts', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await s.appendEvent('r', { type: 'notimestamp' });
    const got = await s.getRun('r');
    expect(got?.events[0].type).toBe('notimestamp');
    expect(got?.events).toHaveLength(1);
  });
});

describe('updateRunStatus', () => {
  it('updates only the columns provided in the patch', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await s.updateRunStatus('r', {
      currentPath: ['baseline', 2],
      stateJson: { lastOutput: 'hi' },
      lastOutput: 'hi',
    });
    let got = await s.getRun('r');
    expect(got?.status).toBe('running');
    expect(got?.currentPath).toEqual(['baseline', 2]);
    expect(got?.stateJson).toEqual({ lastOutput: 'hi' });
    expect(got?.lastOutput).toBe('hi');

    await s.updateRunStatus('r', { status: 'paused', pausedFor: 'approval' });
    got = await s.getRun('r');
    expect(got?.status).toBe('paused');
    expect(got?.pausedFor).toBe('approval');
    expect(got?.currentPath).toEqual(['baseline', 2]);
  });

  it('rejects unknown status values', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await expect(
      s.updateRunStatus('r', { status: 'totally-fake' as never }),
    ).rejects.toThrow(/Invalid run status/);
    await expect(
      s.upsertRun({
        id: 'r2',
        orchestrationName: 'x',
        startedAt: 1,
        status: 'also-fake' as never,
        events: [],
      }),
    ).rejects.toThrow(/Invalid run status/);
  });

  it('stores + reads completedLeaves checkpoint column', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'r',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [],
    });
    await s.updateRunStatus('r', {
      completedLeaves: ['spec', 'plan', 'implement'],
      stateJson: { lastOutput: 'ok', specReport: '...' },
    });
    const got = await s.getRun('r');
    expect(got?.completedLeaves).toEqual(['spec', 'plan', 'implement']);
    expect(got?.stateJson).toEqual({ lastOutput: 'ok', specReport: '...' });
  });
});

describe('markOrphanedRunsAsInterrupted', () => {
  it('flags still-running rows + appends a sentinel', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'live',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start' }, { type: 'phase-end' }],
    });
    await s.upsertRun({
      id: 'done',
      orchestrationName: 'x',
      startedAt: 2,
      status: 'done',
      events: [],
    });
    await s.upsertRun({
      id: 'cancelled',
      orchestrationName: 'x',
      startedAt: 3,
      status: 'cancelled',
      events: [],
    });

    // `live` was upserted as running, so it holds a fresh lease. Scan with a
    // `now` past the lease expiry to simulate its owner having died — from a
    // PEER handle: a store never reclaims a run its own instance leased (a
    // stalled event loop is not a dead process), so the dead owner's run has
    // to be taken by another process, as it is in production.
    const afterLease = Date.now() + 10 * 60_000;
    const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
    await peer.init();
    const result = await peer.markOrphanedRunsAsInterrupted(afterLease);
    expect(result.count).toBe(1);
    expect(result.ids).toEqual(['live']);

    const live = await s.getRun('live');
    expect(live?.status).toBe('interrupted');
    expect(live?.endedAt).toBeGreaterThan(0);
    expect(live?.events[live.events.length - 1]?.type).toBe('run-interrupted');

    expect((await s.getRun('done'))?.status).toBe('done');
    expect((await s.getRun('cancelled'))?.status).toBe('cancelled');

    expect((await peer.markOrphanedRunsAsInterrupted(afterLease)).count).toBe(0);
    await peer.close();
  });

  it('leaves a run with a live (unexpired) lease alone', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'live',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'running',
      events: [{ type: 'run-start' }],
    });
    // Default `now` is the wall clock; the fresh lease (now + TTL) is still in
    // the future, so the run is treated as actively owned and not reclaimed.
    const result = await s.markOrphanedRunsAsInterrupted();
    expect(result.count).toBe(0);
    expect((await s.getRun('live'))?.status).toBe('running');
  });

  it('a heartbeat (appendEvent) rescues a run whose create-time lease expired', async () => {
    // Tiny TTL so the create-time lease lapses during the sleep. Then `beat`
    // heartbeats (appendEvent re-stamps lease = now + TTL) while `quiet` does
    // not — so only `quiet` is reclaimed. The contrast proves the heartbeat.
    const s = new SqliteRunStore(tmpRoot, { leaseTtlMs: 20 });
    await s.init();
    store = s;
    for (const id of ['beat', 'quiet']) {
      await s.upsertRun({
        id,
        orchestrationName: 'x',
        startedAt: 1,
        status: 'running',
        events: [],
      });
    }
    await new Promise(r => setTimeout(r, 60)); // both create-time leases now stale
    await s.appendEvent('beat', { type: 'phase-start' }); // lease -> now + 20ms
    // Scanned by a PEER: a store never reclaims its own instance's runs.
    const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
    await peer.init();
    const result = await peer.markOrphanedRunsAsInterrupted();
    await peer.close();
    expect(result.ids).toContain('quiet'); // no heartbeat -> reclaimed
    expect(result.ids).not.toContain('beat'); // heartbeat -> still owned
    expect((await s.getRun('beat'))?.status).toBe('running');
  });
});

describe('lease fencing (two processes, one db)', () => {
  // Two stores on the same runs.db with distinct instanceIds = two processes.
  async function twoProcs() {
    const a = new SqliteRunStore(tmpRoot, { instanceId: 'proc-A' });
    await a.init();
    const b = new SqliteRunStore(tmpRoot, { instanceId: 'proc-B' });
    await b.init();
    return { a, b, close: async () => { await a.close(); await b.close(); } };
  }

  it('fences a non-owner appendEvent while the run is running', async () => {
    const { a, b, close } = await twoProcs();
    try {
      await a.upsertRun({
        id: 'r', orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
      // The owner (A) may write; a peer (B) is rejected, not silently accepted.
      await expect(a.appendEvent('r', { type: 'phase-start' })).resolves.toBeUndefined();
      await expect(b.appendEvent('r', { type: 'phase-start' })).rejects.toThrow(
        /lease for run "r"/,
      );
    } finally {
      await close();
    }
  });

  it('allows a non-owner appendEvent on a non-running run (A2A follow-up)', async () => {
    const { a, b, close } = await twoProcs();
    try {
      await a.upsertRun({
        id: 'r', orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
      await a.updateRunStatus('r', { status: 'paused', pausedFor: 'lock' });
      // No active executor on a paused run — a cross-process follow-up write is fine.
      await expect(
        b.appendEvent('r', { type: 'phase-user-message', text: 'more' }),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it('after a peer reclaims + resumes, the old owner is fenced out', async () => {
    const { a, b, close } = await twoProcs();
    try {
      await a.upsertRun({
        id: 'r', orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
      // B reclaims the (expired-lease) run, clearing the old owner...
      const reclaimed = await b.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000);
      expect(reclaimed.ids).toContain('r');
      // ...then resumes it, claiming the lease for itself.
      await b.updateRunStatus('r', { status: 'running' });
      // B (new owner) can write; A (old owner) is now fenced.
      await expect(b.appendEvent('r', { type: 'phase-start' })).resolves.toBeUndefined();
      await expect(a.appendEvent('r', { type: 'phase-start' })).rejects.toThrow(
        /lease for run "r"/,
      );
    } finally {
      await close();
    }
  });
});

describe('renewLease (interval heartbeat)', () => {
  it('the owner renews a running run; a non-owner and a non-running run cannot', async () => {
    const a = new SqliteRunStore(tmpRoot, { instanceId: 'A' });
    await a.init();
    const b = new SqliteRunStore(tmpRoot, { instanceId: 'B' });
    await b.init();
    try {
      await a.upsertRun({
        id: 'r', orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
      expect(await a.renewLease('r')).toBe(true); // owner, running -> renews
      expect(await b.renewLease('r')).toBe(false); // not the owner -> no-op
      await a.updateRunStatus('r', { status: 'done', endedAt: Date.now() });
      expect(await a.renewLease('r')).toBe(false); // not running -> no-op
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('a renew keeps a run alive that an event-only heartbeat would have lost', async () => {
    // Tiny TTL: the create-time lease lapses during the sleep. `kept` renews
    // (no events) and survives; `idle` does neither and is reclaimed.
    const s = new SqliteRunStore(tmpRoot, { leaseTtlMs: 20 });
    await s.init();
    store = s;
    for (const id of ['kept', 'idle']) {
      await s.upsertRun({
        id, orchestrationName: 'x', startedAt: 1, status: 'running', events: [],
      });
    }
    await new Promise(r => setTimeout(r, 60)); // both create-time leases stale
    expect(await s.renewLease('kept')).toBe(true); // timer-style renew, no event
    // Scanned by a PEER: a store never reclaims its own instance's runs.
    const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
    await peer.init();
    const result = await peer.markOrphanedRunsAsInterrupted();
    await peer.close();
    expect(result.ids).toContain('idle'); // never renewed -> reclaimed
    expect(result.ids).not.toContain('kept'); // renewed -> still owned
  });
});

describe('trigger deliveries (P0 durable ingress)', () => {
  const base = {
    kind: 'webhook',
    name: 'deploy',
    orchestrationName: 'ticket-to-pr',
    keySource: 'header' as const,
  };

  it('recordDelivery + listDeliveries round-trips, newest first', async () => {
    const s = await freshStore();
    await s.recordDelivery({
      ...base,
      id: 'del-1',
      idempotencyKey: 'hdr:a',
      body: 'JIRA-1',
      receivedAt: 100,
    });
    await s.recordDelivery({
      ...base,
      id: 'del-2',
      idempotencyKey: 'hdr:b',
      body: 'JIRA-2',
      receivedAt: 200,
    });
    const list = await s.listDeliveries();
    expect(list.map(d => d.id)).toEqual(['del-2', 'del-1']);
    const first = list[0];
    expect(first.kind).toBe('webhook');
    expect(first.name).toBe('deploy');
    expect(first.orchestrationName).toBe('ticket-to-pr');
    expect(first.status).toBe('accepted'); // default
    expect(first.runId).toBeNull();
    expect(first.body).toBe('JIRA-2');
    expect(first.ownerId).toBe('system'); // default
    expect(first.firedAt).toBeNull();
  });

  it('findDeliveriesByKey matches all for a header key, windows auto keys', async () => {
    const s = await freshStore();
    const now = Date.now();
    await s.recordDelivery({
      ...base,
      keySource: 'auto',
      id: 'old',
      idempotencyKey: 'auto:k',
      receivedAt: now - 120_000, // 2 min ago
    });
    await s.recordDelivery({
      ...base,
      keySource: 'auto',
      id: 'recent',
      idempotencyKey: 'auto:k',
      receivedAt: now,
    });
    // No window → both.
    expect(
      (await s.findDeliveriesByKey('auto:k')).map(d => d.id).sort(),
    ).toEqual(['old', 'recent']);
    // 60s window → only the recent one (the 2-min-old fire is excluded).
    expect(
      (await s.findDeliveriesByKey('auto:k', { sinceMs: 60_000 })).map(
        d => d.id,
      ),
    ).toEqual(['recent']);
    // A key nobody used → empty.
    expect(await s.findDeliveriesByKey('hdr:none')).toEqual([]);
  });

  it('updateDelivery patches status / runId / firedAt / detail', async () => {
    const s = await freshStore();
    await s.recordDelivery({
      ...base,
      id: 'd',
      idempotencyKey: 'hdr:x',
      receivedAt: 1,
    });
    await s.updateDelivery('d', {
      status: 'fired',
      runId: 'run-99',
      firedAt: 1234,
    });
    let got = (await s.listDeliveries()).find(d => d.id === 'd');
    expect(got?.status).toBe('fired');
    expect(got?.runId).toBe('run-99');
    expect(got?.firedAt).toBe(1234);

    await s.updateDelivery('d', { status: 'rejected', detail: 'budget blocked' });
    got = (await s.listDeliveries()).find(d => d.id === 'd');
    expect(got?.status).toBe('rejected');
    expect(got?.detail).toBe('budget blocked');
    expect(got?.runId).toBe('run-99'); // untouched
  });

  it('listDeliveries scopes by ownerId when provided', async () => {
    const s = await freshStore();
    await s.recordDelivery({
      ...base,
      id: 'a',
      idempotencyKey: 'hdr:a',
      ownerId: 'alice',
      receivedAt: 1,
    });
    await s.recordDelivery({
      ...base,
      id: 'b',
      idempotencyKey: 'hdr:b',
      ownerId: 'bob',
      receivedAt: 2,
    });
    expect((await s.listDeliveries(100, 'alice')).map(d => d.id)).toEqual(['a']);
    expect((await s.listDeliveries(100, 'bob')).map(d => d.id)).toEqual(['b']);
    expect((await s.listDeliveries()).map(d => d.id).sort()).toEqual(['a', 'b']);
  });

  it('rejects unknown delivery status values', async () => {
    const s = await freshStore();
    await expect(
      s.recordDelivery({
        ...base,
        id: 'bad',
        idempotencyKey: 'hdr:bad',
        status: 'totally-fake' as never,
        receivedAt: 1,
      }),
    ).rejects.toThrow(/Invalid delivery status/);
  });
});

describe('delivery queue (P1)', () => {
  const base = {
    kind: 'webhook',
    name: 'deploy',
    orchestrationName: 'ticket-to-pr',
    keySource: 'header' as const,
    status: 'pending' as const,
  };

  async function enqueue(
    s: SqliteRunStore,
    id: string,
    over: Partial<Parameters<SqliteRunStore['recordDelivery']>[0]> = {},
  ) {
    await s.recordDelivery({
      ...base,
      id,
      idempotencyKey: id,
      receivedAt: 1,
      availableAt: 1,
      ...over,
    });
  }

  it('claimNextDelivery takes the oldest claimable, bumps attempts', async () => {
    const s = await freshStore();
    await enqueue(s, 'old', { receivedAt: 1, availableAt: 1 });
    await enqueue(s, 'new', { receivedAt: 5, availableAt: 1 });
    const claimed = await s.claimNextDelivery(100);
    expect(claimed?.id).toBe('old');
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedAt).toBe(100);
    // The second claim takes 'new'; a third finds nothing.
    expect((await s.claimNextDelivery(100))?.id).toBe('new');
    expect(await s.claimNextDelivery(100)).toBeNull();
  });

  it('claimNextDelivery skips deliveries not yet available', async () => {
    const s = await freshStore();
    await enqueue(s, 'future', { availableAt: 5000 });
    expect(await s.claimNextDelivery(1000)).toBeNull();
    expect((await s.claimNextDelivery(5000))?.id).toBe('future');
  });

  it('completeDelivery / rejectDelivery / failDelivery transitions', async () => {
    const s = await freshStore();
    await enqueue(s, 'done');
    const c_82217 = await s.claimNextDelivery(10);
    await s.completeDelivery('done', 'run-1', 20, c_82217!.claimToken);
    let got = (await s.listDeliveries(10)).find(d => d.id === 'done');
    expect(got?.status).toBe('fired');
    expect(got?.runId).toBe('run-1');
    expect(got?.claimedAt).toBeNull();

    await enqueue(s, 'rej');
    const r_35915 = await s.claimNextDelivery(10);
    await s.rejectDelivery('rej', 'no budget', 20, r_35915!.claimToken);
    got = (await s.listDeliveries(10)).find(d => d.id === 'rej');
    expect(got?.status).toBe('rejected');
    expect(got?.lastError).toBe('no budget');

    await enqueue(s, 'retry');
    const f_5827 = await s.claimNextDelivery(10);
    await s.failDelivery('retry', { error: 'transient', now: 20, retryAt: 999, claimToken: f_5827!.claimToken });
    got = (await s.listDeliveries(10)).find(d => d.id === 'retry');
    expect(got?.status).toBe('pending');
    expect(got?.availableAt).toBe(999);
    expect(got?.claimedAt).toBeNull();

    await enqueue(s, 'dead');
    const f_37054 = await s.claimNextDelivery(10);
    await s.failDelivery('dead', { error: 'boom', now: 20, claimToken: f_37054!.claimToken }); // no retryAt
    got = (await s.listDeliveries(10)).find(d => d.id === 'dead');
    expect(got?.status).toBe('failed');
    expect(got?.lastError).toBe('boom');
  });

  it('reclaimStaleDeliveries requeues claimed rows older than the cutoff', async () => {
    const s = await freshStore();
    await enqueue(s, 'stuck');
    await enqueue(s, 'fresh');
    await s.claimNextDelivery(1000); // 'stuck' claimed at 1000
    await s.claimNextDelivery(9000); // 'fresh' claimed at 9000
    // now=10000, olderThanMs=5000 → cutoff 5000: only 'stuck' (claimed@1000).
    const r = await s.reclaimStaleDeliveries(5000, 10000);
    expect(r.ids).toEqual(['stuck']);
    expect((await s.listDeliveries(10)).find(d => d.id === 'stuck')?.status).toBe(
      'pending',
    );
    expect((await s.listDeliveries(10)).find(d => d.id === 'fresh')?.status).toBe(
      'claimed',
    );
  });

  it('countDeliveries filters by status + orchestration', async () => {
    const s = await freshStore();
    await enqueue(s, 'p1', { orchestrationName: 'a' });
    await enqueue(s, 'p2', { orchestrationName: 'a' });
    await enqueue(s, 'p3', { orchestrationName: 'b' });
    const c_25012 = await s.claimNextDelivery(1);
    await s.completeDelivery('p1', 'r', 2, c_25012!.claimToken);
    expect(await s.countDeliveries({ status: 'pending' })).toBe(2);
    expect(await s.countDeliveries({ status: 'fired' })).toBe(1);
    expect(await s.countDeliveries({ orchestrationName: 'a' })).toBe(2);
    expect(await s.countDeliveries()).toBe(3);
  });

  it('findDeliveryByRunId locates the producing delivery', async () => {
    const s = await freshStore();
    await enqueue(s, 'd');
    const c_10700 = await s.claimNextDelivery(1);
    await s.completeDelivery('d', 'run-xyz', 2, c_10700!.claimToken);
    expect((await s.findDeliveryByRunId('run-xyz'))?.id).toBe('d');
    expect(await s.findDeliveryByRunId('nope')).toBeNull();
  });

  it('chain_depth persists and is recoverable by run id (P3 substrate)', async () => {
    const s = await freshStore();
    // A delivery produced by a depth-2 event publication.
    await enqueue(s, 'evt', { chainDepth: 2 });
    const c_76754 = await s.claimNextDelivery(1);
    await s.completeDelivery('evt', 'run-evt', 2, c_76754!.claimToken);
    const found = await s.findDeliveryByRunId('run-evt');
    expect(found?.chainDepth).toBe(2);
    // A plain (non-event) delivery defaults to depth 0.
    await enqueue(s, 'plain');
    expect(
      (await s.listDeliveries(10)).find(d => d.id === 'plain')?.chainDepth,
    ).toBe(0);
  });

  it('replayDelivery re-drives only failed/rejected deliveries', async () => {
    const s = await freshStore();
    await enqueue(s, 'dead');
    const f_36846 = await s.claimNextDelivery(1);
    await s.failDelivery('dead', { error: 'boom', now: 2, claimToken: f_36846!.claimToken }); // → failed
    expect(await s.replayDelivery('dead', 100)).toBe(true);
    let got = (await s.listDeliveries(10)).find(d => d.id === 'dead');
    expect(got?.status).toBe('pending');
    expect(got?.attempts).toBe(0);
    expect(got?.availableAt).toBe(100);
    expect(got?.lastError).toBeNull();

    // A still-pending delivery is not replayable; unknown id is false.
    await enqueue(s, 'live');
    expect(await s.replayDelivery('live', 100)).toBe(false);
    expect(await s.replayDelivery('nope', 100)).toBe(false);
  });

  it('claimNextDelivery honors a per-orch in-flight cap', async () => {
    const s = await freshStore();
    // Two deliveries for orch A, one for B.
    await enqueue(s, 'a1', { orchestrationName: 'A', receivedAt: 1 });
    await enqueue(s, 'a2', { orchestrationName: 'A', receivedAt: 2 });
    await enqueue(s, 'b1', { orchestrationName: 'B', receivedAt: 3 });
    // Cap 1 per orch: first claim takes A's oldest; with A now at 1 in
    // flight, the next claim must skip A's second and take B's.
    const c1 = await s.claimNextDelivery(100, { maxInFlightPerOrch: 1 });
    expect(c1?.id).toBe('a1');
    const c2 = await s.claimNextDelivery(100, { maxInFlightPerOrch: 1 });
    expect(c2?.id).toBe('b1'); // a2 skipped — A is at cap
    // A still at cap, B at cap → nothing claimable.
    expect(await s.claimNextDelivery(100, { maxInFlightPerOrch: 1 })).toBeNull();
    // Finish a1 → A drops below cap → a2 claimable.
    await s.completeDelivery('a1', 'r', 110, c1!.claimToken);
    expect(
      (await s.claimNextDelivery(120, { maxInFlightPerOrch: 1 }))?.id,
    ).toBe('a2');
  });

  it('listDeliveries filters by status', async () => {
    const s = await freshStore();
    await enqueue(s, 'p');
    await enqueue(s, 'f');
    const c_22181 = await s.claimNextDelivery(1);
    await s.completeDelivery('p', 'r', 2, c_22181!.claimToken);
    expect((await s.listDeliveries(10, undefined, 'fired')).map(d => d.id)).toEqual(
      ['p'],
    );
    expect(
      (await s.listDeliveries(10, undefined, 'pending')).map(d => d.id),
    ).toEqual(['f']);
  });
});

describe('importLegacyRunFiles', () => {
  it('imports runs/*.json that aren’t already in the store', async () => {
    const runsDir = path.join(tmpRoot, 'runs');
    await fs.mkdir(runsDir);
    await fs.writeFile(
      path.join(runsDir, 'run-old.json'),
      JSON.stringify({
        id: 'run-old',
        orchestrationName: 'ticket-to-pr',
        startedAt: 1700000000000,
        endedAt: 1700000060000,
        status: 'done',
        events: [
          { type: 'run-start', ts: 1700000000001 },
          { type: 'run-end', ts: 1700000059999 },
        ],
      }),
    );
    await fs.writeFile(
      path.join(runsDir, 'run-running.json'),
      JSON.stringify({
        id: 'run-running',
        orchestrationName: 'ticket-to-pr',
        startedAt: 1700000010000,
        status: 'running',
        events: [{ type: 'run-start', ts: 1700000010001 }],
      }),
    );

    const s = await freshStore();
    const result = await importLegacyRunFiles(s, runsDir);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    expect((await s.getRun('run-old'))?.status).toBe('done');
    expect((await s.getRun('run-old'))?.events).toHaveLength(2);
    // A stale 'running' file-run can't be resumed → imported as cancelled.
    expect((await s.getRun('run-running'))?.status).toBe('cancelled');

    const second = await importLegacyRunFiles(s, runsDir);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('returns zero counts when the runs dir doesn’t exist', async () => {
    const s = await freshStore();
    const result = await importLegacyRunFiles(s, path.join(tmpRoot, 'nope'));
    expect(result).toEqual({ imported: 0, skipped: 0, errors: 0 });
  });

  it('counts malformed files as errors, doesn’t crash', async () => {
    const runsDir = path.join(tmpRoot, 'runs');
    await fs.mkdir(runsDir);
    await fs.writeFile(path.join(runsDir, 'bad.json'), '{not json');
    await fs.writeFile(
      path.join(runsDir, 'no-id.json'),
      JSON.stringify({ orchestrationName: 'x' }),
    );
    await fs.writeFile(
      path.join(runsDir, 'good.json'),
      JSON.stringify({
        id: 'good',
        orchestrationName: 'x',
        startedAt: 1,
        status: 'done',
        events: [],
      }),
    );
    const s = await freshStore();
    const result = await importLegacyRunFiles(s, runsDir);
    expect(result.imported).toBe(1);
    expect(result.errors).toBe(2);
    expect(await s.getRun('good')).not.toBeNull();
  });
});

describe('header idempotency keys are unique at the STORAGE layer', () => {
  /**
   * THE BUG THIS PINS: dedupe was check-then-insert — `findDeliveriesByKey`
   * followed by `recordDelivery`, with no transaction and only a NON-unique
   * index behind it. Two simultaneous posts of one Idempotency-Key both read
   * zero priors and both inserted, so the key that exists specifically to
   * collapse a double-send did not. The partial unique index makes the insert
   * itself the boundary; the read is only a fast path.
   *
   * PARTIAL (header keys only), because auto keys are deliberately windowed
   * and are SUPPOSED to repeat outside the window. Per orchestration, because
   * one fire legitimately fans out to a row per subscriber sharing the key.
   */
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'webhook',
    name: 'n',
    orchestrationName: 'o',
    idempotencyKey: 'hdr:system:webhook:n:same-key',
    keySource: 'header' as const,
    status: 'pending' as const,
    body: 'b',
    receivedAt: 1,
    availableAt: 1,
    ...over,
  });

  it('the second insert of one header key is refused, not duplicated', async () => {
    const s = await freshStore();
    expect(await s.recordDelivery(row('first'))).toBe(true);
    // Same key, same orchestration → refused rather than throwing.
    expect(await s.recordDelivery(row('second'))).toBe(false);
    expect((await s.listDeliveries(50)).length).toBe(1);
  });

  it('CONCURRENT inserts of one key yield exactly one row', async () => {
    const s = await freshStore();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(id => s.recordDelivery(row(id))),
    );
    // Exactly one winner; the rest are deduped, none throw.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await s.listDeliveries(50)).length).toBe(1);
  });

  it('the same key FANS OUT to one row per subscribed orchestration', async () => {
    const s = await freshStore();
    expect(await s.recordDelivery(row('to-a', { orchestrationName: 'a' }))).toBe(true);
    expect(await s.recordDelivery(row('to-b', { orchestrationName: 'b' }))).toBe(true);
    expect(await s.recordDelivery(row('to-c', { orchestrationName: 'c' }))).toBe(true);
    // Three subscribers, three rows, one key — and a retry adds none.
    expect(await s.recordDelivery(row('dup-a', { orchestrationName: 'a' }))).toBe(
      false,
    );
    expect((await s.listDeliveries(50)).length).toBe(3);
  });

  it('AUTO keys may repeat — the constraint must not catch them', async () => {
    const s = await freshStore();
    const auto = (id: string) =>
      row(id, { keySource: 'auto' as const, idempotencyKey: 'auto:same-digest' });
    // Windowed dedupe is enforced in deliver(), not by the index: two
    // legitimately-identical events far apart must both be recordable.
    expect(await s.recordDelivery(auto('t1'))).toBe(true);
    expect(await s.recordDelivery(auto('t2'))).toBe(true);
    expect((await s.listDeliveries(50)).length).toBe(2);
  });
});

describe('delivery retention — the dedupe table must be boundable', () => {
  /**
   * Retention covered `runs` + `events` only, so `trigger_deliveries` grew
   * without bound: one row per cron tick, forever. It is also the table
   * header-key idempotency is checked against, so the dedupe guarantee was
   * quietly resting on something nobody ever trimmed.
   */
  const old = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'cron',
    name: '* * * * *',
    orchestrationName: 'o',
    idempotencyKey: `hdr:k-${id}`,
    keySource: 'header' as const,
    status: 'fired' as const,
    body: 'b',
    receivedAt: 1_000,
    availableAt: 1_000,
    ...over,
  });

  it('prunes terminal rows past the window and leaves fresh ones', async () => {
    const s = await freshStore();
    await s.recordDelivery(old('stale'));
    await s.recordDelivery(old('fresh', { receivedAt: 9_000 }));

    // Window of 1000ms evaluated at t=5000 → cutoff 4000.
    const { count } = await s.pruneTerminalDeliveries(1_000, 5_000);
    expect(count).toBe(1);
    const left = (await s.listDeliveries(50)).map(d => d.id);
    expect(left).toEqual(['fresh']);
  });

  it('never prunes LIVE work, however old', async () => {
    // A pending or claimed row is work that still has to happen; deleting it
    // would lose an accepted fire.
    const s = await freshStore();
    await s.recordDelivery(old('p', { status: 'pending' }));
    await s.recordDelivery(old('c', { status: 'claimed' }));
    await s.recordDelivery(old('f', { status: 'fired' }));

    expect((await s.pruneTerminalDeliveries(1, 1e12)).count).toBe(1);
    expect((await s.listDeliveries(50)).map(d => d.id).sort()).toEqual(['c', 'p']);
  });

  it('prunes every terminal status, including deferred', async () => {
    const s = await freshStore();
    for (const st of ['fired', 'rejected', 'deferred', 'duplicate', 'failed'] as const) {
      await s.recordDelivery(old(`t-${st}`, { status: st }));
    }
    expect((await s.pruneTerminalDeliveries(1, 1e12)).count).toBe(5);
    expect(await s.listDeliveries(50)).toEqual([]);
  });

  it('pruning a row FORGETS its idempotency key (the documented trade)', async () => {
    const s = await freshStore();
    await s.recordDelivery(old('gone'));
    expect(await s.findDeliveriesByKey('hdr:k-gone')).toHaveLength(1);

    await s.pruneTerminalDeliveries(1, 1e12);
    // The key is now unknown, so the same key can fire again. Bounded table
    // vs. forever-dedupe is a real trade — it is the operator's call, which
    // is why delivery retention is opt-in with the rest of retention.
    expect(await s.findDeliveriesByKey('hdr:k-gone')).toHaveLength(0);
    expect(await s.recordDelivery(old('again'))).toBe(true);
  });
});

describe('a REFUSED delivery must not consume its idempotency key', () => {
  /**
   * THE BUG THIS PINS: the dedupe matched prior rows in ANY status, and the
   * unique index covered every status too. So one `rejected` or `failed` row
   * owned that key forever: a sender retrying after the cause was fixed —
   * budget cap lifted, orchestration redeployed, queue drained — got a
   * 200/duplicate and its event was never run. A webhook provider's own retry
   * of a delivery we had refused was silently dropped.
   *
   * A refusal means the work NEVER RAN, so it must not suppress a retry. The
   * protection that matters is unchanged: at most one LIVE-or-FIRED row per
   * key per orchestration, so two concurrent posts still cannot both create
   * work.
   */
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'webhook',
    name: 'n',
    orchestrationName: 'o',
    idempotencyKey: 'hdr:system:webhook:n:retry-me',
    keySource: 'header' as const,
    status: 'pending' as const,
    body: 'b',
    receivedAt: 1,
    availableAt: 1,
    ...over,
  });

  it.each(['rejected', 'failed'] as const)(
    'a %s row lets the same key be re-fired',
    async status => {
      const s = await freshStore();
      expect(await s.recordDelivery(row('refused', { status }))).toBe(true);
      // The index no longer blocks it …
      expect(await s.recordDelivery(row('retry'))).toBe(true);
      // … and the dedupe read no longer sees it as a prior.
      expect(
        (await s.findDeliveriesByKey(row('x').idempotencyKey, { excludeRefused: true }))
          .map(d => d.id),
      ).toEqual(['retry']);
    },
  );

  it.each(['pending', 'claimed', 'fired', 'deferred'] as const)(
    'a %s row still OWNS the key',
    async status => {
      // Live or already-run work must keep deduping, or a provider retry
      // would double-run it.
      const s = await freshStore();
      expect(await s.recordDelivery(row('live', { status }))).toBe(true);
      expect(await s.recordDelivery(row('dup'))).toBe(false);
      expect(
        (await s.findDeliveriesByKey(row('x').idempotencyKey, { excludeRefused: true }))
          .map(d => d.id),
      ).toEqual(['live']);
    },
  );

  it('the full read still returns refused rows — the audit trail is intact', async () => {
    // Only the DEDUPE view excludes them; the row itself is history and the
    // dead-letter view reads it.
    const s = await freshStore();
    await s.recordDelivery(row('refused', { status: 'rejected' }));
    expect((await s.findDeliveriesByKey(row('x').idempotencyKey)).map(d => d.id)).toEqual(
      ['refused'],
    );
  });

  it('a row that BECOMES refused releases the key', async () => {
    // The realistic sequence: claimed → rejected by policy → the sender
    // retries → it runs.
    const s = await freshStore();
    await s.recordDelivery(row('first'));
    const c = await s.claimNextDelivery(10);
    expect(await s.rejectDelivery('first', 'budget cap', 20, c!.claimToken)).toBe(true);
    expect(await s.recordDelivery(row('second'))).toBe(true);
  });
});

describe('suppressed duplicates are COUNTED, not invisible', () => {
  /**
   * `'duplicate'` is a valid DeliveryStatus that nothing ever wrote: a
   * suppressed fire was reported as duplicate in the HTTP response and left
   * no trace, so the stats endpoint's duplicate bucket was permanently 0 and
   * a provider double-sending was undetectable.
   *
   * A row per suppressed fire is the obvious fix and the wrong one — that is
   * unbounded writes driven by whoever is retrying. A counter on the row that
   * WON the key is bounded, and answers the question that matters: how many
   * times has this fire been re-sent.
   */
  const row = (id: string) => ({
    id,
    kind: 'webhook' as const,
    name: 'n',
    orchestrationName: 'o',
    idempotencyKey: `hdr:${id}`,
    keySource: 'header' as const,
    status: 'pending' as const,
    body: 'b',
    receivedAt: 1,
    availableAt: 1,
  });

  const get = async (s: SqliteRunStore, id: string) =>
    (await s.listDeliveries(100)).find(d => d.id === id);

  it('starts at zero and increments per suppression', async () => {
    const s = await freshStore();
    await s.recordDelivery(row('d'));
    expect((await get(s, 'd'))?.duplicateCount).toBe(0);

    await s.noteDuplicateSuppressed('d');
    await s.noteDuplicateSuppressed('d');
    expect((await get(s, 'd'))?.duplicateCount).toBe(2);
  });

  it('the total is summable for the stats endpoint', async () => {
    const s = await freshStore();
    await s.recordDelivery(row('a'));
    await s.recordDelivery(row('b'));
    expect(await s.sumDuplicatesSuppressed()).toBe(0);

    await s.noteDuplicateSuppressed('a');
    await s.noteDuplicateSuppressed('a');
    await s.noteDuplicateSuppressed('b');
    expect(await s.sumDuplicatesSuppressed()).toBe(3);
  });

  it('counting is bounded — N suppressions add no rows', async () => {
    const s = await freshStore();
    await s.recordDelivery(row('d'));
    for (let i = 0; i < 50; i++) await s.noteDuplicateSuppressed('d');
    expect((await s.listDeliveries(100)).length).toBe(1);
    expect((await get(s, 'd'))?.duplicateCount).toBe(50);
  });
});

// The SHARED conformance suite — identical assertions run against Postgres in
// postgres-store.test.ts. New store contracts belong there, not written twice.
describeRunStoreContract('SqliteRunStore', {
  make: async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-contract-'));
    const s = new SqliteRunStore(dir);
    await s.init();
    (s as unknown as { __tmpDir: string }).__tmpDir = dir;
    return s;
  },
  dispose: async st => {
    const dir = (st as unknown as { __tmpDir?: string }).__tmpDir;
    await st.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  },
});
