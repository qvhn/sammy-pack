/**
 * Runs retention. runs.db grows without bound (a real one reached
 * 268 MB — per-chunk phase-delta events dominate). SAMMY_RUN_RETENTION_DAYS
 * turns on a prune of TERMINAL runs (done / error / cancelled) older than N
 * days, at boot + daily. These tests pin the safety property — paused /
 * interrupted / running rows are NEVER deleted, however old — plus the event
 * cascade, the reclaimed-bytes measurement, and the boot wiring.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import type { RunStatus } from '../src/server/run-store';

const DAY = 86_400_000;

describe('pruneTerminalRuns (store layer)', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-retention-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function seed(
    id: string,
    status: RunStatus,
    endedAt: number | null,
  ): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'o',
      startedAt: (endedAt ?? Date.now()) - 1_000,
      endedAt,
      status,
      events: [
        { type: 'run-start', ts: 1 },
        { type: 'phase-end', phaseName: 'p', output: 'x'.repeat(500), ts: 2 },
      ],
    });
  }

  it('deletes only OLD TERMINAL runs — never paused/interrupted/running, never recent', async () => {
    // Fake time so rows with endedAt=null get an OLD updated_at (upsert
    // stamps updated_at with "now") — that is the COALESCE fallback path.
    jest.useFakeTimers();
    const t0 = Date.UTC(2026, 5, 1);
    jest.setSystemTime(t0);

    // Old (40 days before "now"): the three terminal statuses + every
    // protected status, plus a terminal row that never stamped endedAt.
    await seed('old-done', 'done', t0 - 100);
    await seed('old-error', 'error', t0 - 100);
    await seed('old-cancelled', 'cancelled', t0 - 100);
    await seed('old-cancelled-no-end', 'cancelled', null); // ages via updated_at
    await seed('old-paused', 'paused', null);
    await seed('old-interrupted', 'interrupted', null);
    await seed('old-running', 'running', null);

    // Recent (1 day old): must survive any prune with a >1d window.
    const now = t0 + 40 * DAY;
    jest.setSystemTime(now - 1 * DAY);
    await seed('recent-done', 'done', now - 1 * DAY);

    const res = await store.pruneTerminalRuns(30 * DAY, now);
    expect(res.count).toBe(4); // done + error + cancelled + cancelled-no-end

    // Deleted rows are gone, events cascaded.
    for (const id of [
      'old-done',
      'old-error',
      'old-cancelled',
      'old-cancelled-no-end',
    ]) {
      expect(await store.getRun(id)).toBeNull();
    }
    expect((await store.eventCounts(['old-done', 'old-error'])).size).toBe(0);

    // The protected + recent rows survive, events intact.
    for (const id of [
      'old-paused',
      'old-interrupted',
      'old-running',
      'recent-done',
    ]) {
      const run = await store.getRun(id);
      expect(run).not.toBeNull();
      expect(run!.events.length).toBe(2);
    }

    // VACUUM is OPT-IN (SAMMY_RETENTION_VACUUM=1), so a prune reports no
    // reclaim by default. It used to run unconditionally: a full-file rewrite
    // is a multi-second SYNCHRONOUS freeze on a large store, and better-sqlite3
    // blocks the event loop — including the 40s lease renewal — so a prune
    // longer than the 120s lease TTL let a peer reclaim this process's live
    // runs and re-execute them. Freed pages are reused by future writes
    // either way, so reclaiming bytes is a disk-space optimisation, not a
    // correctness one.
    expect(res.reclaimedBytes).toBeNull();
    const noop = await store.pruneTerminalRuns(30 * DAY, now);
    expect(noop).toEqual({ count: 0, reclaimedBytes: null });
  });

  it('reports reclaimed bytes only when VACUUM is opted into', async () => {
    jest.useFakeTimers();
    const now = Date.now();
    jest.setSystemTime(now - 90 * DAY);
    await seed('vac-old', 'done', now - 90 * DAY);
    jest.setSystemTime(now);
    jest.useRealTimers();

    process.env.SAMMY_RETENTION_VACUUM = '1';
    try {
      const res = await store.pruneTerminalRuns(30 * DAY, now);
      expect(res.count).toBe(1);
      expect(res.reclaimedBytes).not.toBeNull();
      expect(res.reclaimedBytes!).toBeGreaterThanOrEqual(0);
    } finally {
      delete process.env.SAMMY_RETENTION_VACUUM;
    }
  });

  it('exposes the db file path for the banner / size reporting', () => {
    expect(store.filePath).toBe(path.join(tmpRoot, 'runs.db'));
  });
});

describe('retention over the mounted API (boot sweep)', () => {
  let server: http.Server;
  let tmpRoot: string;
  let store: SqliteRunStore;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SAMMY_RUN_RETENTION_DAYS',
    'SAMMY_DISABLE_INPROCESS_WORKER',
    'DATABASE_URL',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function mount(): Promise<void> {
    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        config: { root: path.join(tmpRoot, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(resolve => server.listen(0, resolve));
  }

  async function until(probe: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (await probe()) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('condition not reached');
  }

  it('boot prunes old terminal runs when SAMMY_RUN_RETENTION_DAYS is set', async () => {
    process.env.SAMMY_RUN_RETENTION_DAYS = '7';
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-ret-api-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    const old = Date.now() - 30 * DAY;
    // Old + terminal → pruned at boot. Old + paused → untouchable. (These
    // age via their explicit endedAt / the paused-protection, so no fake
    // timers are needed under a live mount.)
    await store.upsertRun({
      id: 'ancient-done',
      orchestrationName: 'o',
      startedAt: old - 1_000,
      endedAt: old,
      status: 'done',
      events: [{ type: 'run-end', ts: old }],
    });
    await store.upsertRun({
      id: 'ancient-paused',
      orchestrationName: 'o',
      startedAt: old - 1_000,
      status: 'paused',
      events: [{ type: 'run-paused', pausedFor: 'gate', ts: old }],
    });
    await mount();

    await until(async () => (await store.getRun('ancient-done')) === null);
    expect(await store.getRun('ancient-paused')).not.toBeNull();
  });

  it('leaves everything alone when the env var is unset (opt-in only)', async () => {
    delete process.env.SAMMY_RUN_RETENTION_DAYS;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-ret-api-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    const old = Date.now() - 365 * DAY;
    await store.upsertRun({
      id: 'year-old-done',
      orchestrationName: 'o',
      startedAt: old - 1_000,
      endedAt: old,
      status: 'done',
      events: [],
    });
    await mount();

    // Give the (disabled) boot sweep a beat; the run must still be there.
    await new Promise(r => setTimeout(r, 300));
    expect(await store.getRun('year-old-done')).not.toBeNull();
  });
});
