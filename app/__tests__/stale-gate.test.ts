/**
 * Stale-gate TTL — a run paused at a human gate can sit `paused`
 * forever, invisibly, while STILL holding its concurrency group (a real run
 * held one for days; every cron fire queued silently behind it). These tests
 * pin the fix end to end:
 *
 *   - env parsing (SAMMY_GATE_TTL_HOURS float / 0-disables,
 *     SAMMY_GATE_TTL_ACTION notify|cancel, SAMMY_RUN_RETENTION_DAYS opt-in),
 *   - the pure derivations (pausedSince from the run-paused event, the
 *     once-per-pause-leg notified marker),
 *   - sweepStaleGates against a real SQLite store: marks + notifies ONCE per
 *     leg (durable across sweeps), re-notifies on a re-pause, TTL=0 no-ops,
 *   - the stale-gate notify envelope + best-effort POST,
 *   - the mounted API: boot sweep decorates GET /api/runs and
 *     GET /api/runs/:id with `stale` + `pausedSinceMs`, and
 *     SAMMY_GATE_TTL_ACTION=cancel auto-cancels the stale holder AND drains
 *     the fire queued behind its concurrency group.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import {
  buildGateStaleNotifyPayload,
  fireGateStaleNotify,
} from '../src/server/notify';
import {
  DEFAULT_GATE_TTL_HOURS,
  derivePausedSinceMs,
  GATE_STALE_EVENT_TYPE,
  gateTtlAction,
  gateTtlMs,
  runRetentionDays,
  staleNotifiedSincePause,
  sweepStaleGates,
  type StaleGateEntry,
} from '../src/server/run-store';

/** A drained fire whose start was refused (transiently, or by the budget) is
 *  kept as a durable `concurrency-drain` DELIVERY for the worker to retry —
 *  or, failing that, re-parked. Either way it is not lost. */
async function preservedDrains(
  store: { countPendingFires(g: string): Promise<number>; listDeliveries(n: number): Promise<Array<{ kind: string; name: string; status: string }>> },
  group: string,
): Promise<number> {
  const queued = (await store.listDeliveries(1000)).filter(
    d => d.kind === 'concurrency-drain' && d.name === group && d.status === 'pending',
  ).length;
  return (await store.countPendingFires(group)) + queued;
}


const HOUR = 3_600_000;

// ── Env parsing ────────────────────────────────────────────────────────────

describe('gate TTL / retention env parsing', () => {
  it('gateTtlMs: unset/empty → 24h default; 0 → disabled; float honored', () => {
    expect(gateTtlMs({})).toBe(DEFAULT_GATE_TTL_HOURS * HOUR);
    expect(gateTtlMs({ SAMMY_GATE_TTL_HOURS: '' })).toBe(24 * HOUR);
    expect(gateTtlMs({ SAMMY_GATE_TTL_HOURS: '0' })).toBe(0);
    expect(gateTtlMs({ SAMMY_GATE_TTL_HOURS: '2.5' })).toBe(2.5 * HOUR);
    // Malformed values must NOT silently disable a safety net.
    expect(gateTtlMs({ SAMMY_GATE_TTL_HOURS: 'nope' })).toBe(24 * HOUR);
    expect(gateTtlMs({ SAMMY_GATE_TTL_HOURS: '-3' })).toBe(24 * HOUR);
  });

  it('gateTtlAction: cancel only on the exact opt-in; anything else notifies', () => {
    expect(gateTtlAction({})).toBe('notify');
    expect(gateTtlAction({ SAMMY_GATE_TTL_ACTION: 'cancel' })).toBe('cancel');
    expect(gateTtlAction({ SAMMY_GATE_TTL_ACTION: ' CANCEL ' })).toBe('cancel');
    expect(gateTtlAction({ SAMMY_GATE_TTL_ACTION: 'nuke' })).toBe('notify');
  });

  it('runRetentionDays: OFF unless a positive number', () => {
    expect(runRetentionDays({})).toBeNull();
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: '' })).toBeNull();
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: '0' })).toBeNull();
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: '-2' })).toBeNull();
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: 'junk' })).toBeNull();
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: '30' })).toBe(30);
    expect(runRetentionDays({ SAMMY_RUN_RETENTION_DAYS: '0.5' })).toBe(0.5);
  });
});

// ── Pure derivations ───────────────────────────────────────────────────────

describe('pausedSince / notified-marker derivations', () => {
  it('derivePausedSinceMs prefers the LATEST run-paused ts, else the fallback', () => {
    expect(derivePausedSinceMs([], 111)).toBe(111);
    expect(
      derivePausedSinceMs(
        [
          { type: 'run-paused', ts: 10 },
          { type: 'run-resumed', ts: 20 },
          { type: 'run-paused', ts: 30 },
        ],
        111,
      ),
    ).toBe(30);
    // A run-paused with no usable ts falls through to the fallback.
    expect(derivePausedSinceMs([{ type: 'run-paused' }], 111)).toBe(111);
  });

  it('staleNotifiedSincePause is scoped per pause leg', () => {
    // Marker after the pause → this leg already notified.
    expect(
      staleNotifiedSincePause([
        { type: 'run-paused', ts: 1 },
        { type: GATE_STALE_EVENT_TYPE, ts: 2 },
      ]),
    ).toBe(true);
    // A NEW pause after the marker starts a fresh leg → not notified.
    expect(
      staleNotifiedSincePause([
        { type: 'run-paused', ts: 1 },
        { type: GATE_STALE_EVENT_TYPE, ts: 2 },
        { type: 'run-resumed', ts: 3 },
        { type: 'run-paused', ts: 4 },
      ]),
    ).toBe(false);
    expect(staleNotifiedSincePause([{ type: 'run-paused', ts: 1 }])).toBe(false);
    expect(staleNotifiedSincePause([])).toBe(false);
  });
});

// ── sweepStaleGates over a real store ──────────────────────────────────────

describe('sweepStaleGates (store-driven)', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-stale-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Seed a run paused at `pausedAtMs` (the run-paused event carries the
   *  authoritative ts; header timestamps are whatever "now" is). */
  async function seedPaused(id: string, pausedAtMs: number): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'gated-orch',
      startedAt: pausedAtMs - HOUR,
      status: 'paused',
      events: [
        { type: 'run-start', ts: pausedAtMs - HOUR },
        { type: 'run-paused', pausedFor: 'review-gate', ts: pausedAtMs },
      ],
      orchestrationSnapshot: {
        name: 'gated-orch',
        notify: { onTerminal: 'http://127.0.0.1:1/dead' },
      },
    });
    await store.updateRunStatus(id, { pausedFor: 'review-gate' });
  }

  it('an OLD paused run beyond the newest-500 listRuns window is still swept', async () => {
    // The sweepers used listRuns() (newest 500 by started_at): on a busy
    // store with retention off, a paused run older than the 500 newest
    // rows became INVISIBLE — a wait-park never resumed, an abandoned
    // gate held its concurrency group forever. listPausedRuns is the
    // unbounded fix; this pins it against the real SQLite store.
    const now = Date.UTC(2026, 6, 1);
    await seedPaused('ancient-gate', now - 48 * HOUR);
    // Bury it under 510 newer terminal runs.
    for (let i = 0; i < 510; i++) {
      await store.upsertRun({
        id: `filler-${i}`,
        orchestrationName: 'filler',
        startedAt: now - HOUR + i, // all newer than the paused run
        status: 'done',
        events: [],
      });
    }
    // Sanity: the old window really would have missed it.
    const windowed = await store.listRuns();
    expect(windowed.some(h => h.id === 'ancient-gate')).toBe(false);
    // The sweep still finds and flags it.
    const entries = await sweepStaleGates(store, { ttlMs: 24 * HOUR, now });
    expect(entries.map(e => e.runId)).toEqual(['ancient-gate']);
  });

  it('a wait-parked run is NEVER a stale gate — only real lock pauses are flagged', async () => {
    // A legitimate multi-day durable timer is `paused` far past the gate
    // TTL, but nobody is supposed to approve it: flagging it produces nag
    // notifies at best and (SAMMY_GATE_TTL_ACTION=cancel) auto-cancels a
    // healthy run at worst. The pendingWait header index is the tell.
    const now = Date.UTC(2026, 6, 1);
    await seedPaused('wait-parked', now - 30 * HOUR);
    await store.updateRunStatus('wait-parked', {
      stateJson: {
        leafOutputs: {},
        pendingWait: {
          replayKey: 'cool-down',
          kind: 'timer',
          resumeAt: now + 42 * HOUR, // 3-day timer, still running
        },
      },
    });
    await seedPaused('real-gate', now - 30 * HOUR); // control: flagged
    const onStale = jest.fn<void, [StaleGateEntry, unknown]>();

    const entries = await sweepStaleGates(store, {
      ttlMs: 24 * HOUR,
      now,
      onStale,
    });
    expect(entries.map(e => e.runId)).toEqual(['real-gate']);
    expect(onStale).toHaveBeenCalledTimes(1);
    const parked = await store.getRun('wait-parked');
    expect(
      parked!.events.filter(e => e.type === GATE_STALE_EVENT_TYPE),
    ).toHaveLength(0);
  });

  it('marks + notifies ONCE per crossing, across repeated sweeps', async () => {
    const now = Date.UTC(2026, 6, 1);
    await seedPaused('stale-1', now - 25 * HOUR);
    const onStale = jest.fn<void, [StaleGateEntry, unknown]>();

    const first = await sweepStaleGates(store, {
      ttlMs: 24 * HOUR,
      now,
      onStale,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      runId: 'stale-1',
      orchestrationName: 'gated-orch',
      pausedFor: 'review-gate',
      pausedSinceMs: now - 25 * HOUR, // epoch, from the run-paused event
    });
    expect(onStale).toHaveBeenCalledTimes(1);

    // The durable marker landed exactly once…
    const run1 = await store.getRun('stale-1');
    const markers = run1!.events.filter(e => e.type === GATE_STALE_EVENT_TYPE);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      phaseName: 'review-gate',
      pausedSinceMs: now - 25 * HOUR,
      action: 'notify',
    });

    // …and a second sweep still REPORTS the run as stale (for the list
    // decoration) but does NOT re-notify or re-mark.
    const second = await sweepStaleGates(store, {
      ttlMs: 24 * HOUR,
      now: now + HOUR,
      onStale,
    });
    expect(second).toHaveLength(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    const run2 = await store.getRun('stale-1');
    expect(
      run2!.events.filter(e => e.type === GATE_STALE_EVENT_TYPE),
    ).toHaveLength(1);
  });

  it('defaults `now` to the (fake) clock — the sweep works timer-driven', async () => {
    // The API wiring calls the sweep from setInterval with no explicit `now`;
    // pin that the default clock path detects the crossing too.
    jest.useFakeTimers();
    const t0 = Date.UTC(2026, 6, 1);
    jest.setSystemTime(t0);
    await seedPaused('stale-clock', t0 - HOUR); // 1h old — not stale yet

    const onStale = jest.fn();
    expect(
      await sweepStaleGates(store, { ttlMs: 24 * HOUR, onStale }),
    ).toHaveLength(0);
    expect(onStale).not.toHaveBeenCalled();

    // 25 hours later the same pause has crossed the TTL.
    jest.setSystemTime(t0 + 25 * HOUR);
    const entries = await sweepStaleGates(store, { ttlMs: 24 * HOUR, onStale });
    expect(entries).toHaveLength(1);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('a resume + re-pause that crosses the TTL again notifies again (new leg)', async () => {
    const t0 = Date.UTC(2026, 6, 1);
    await seedPaused('re-paused', t0 - 25 * HOUR);
    const onStale = jest.fn();
    await sweepStaleGates(store, { ttlMs: 24 * HOUR, now: t0, onStale });
    expect(onStale).toHaveBeenCalledTimes(1);

    // Human resumed it; it re-paused at a later gate and was forgotten again.
    await store.appendEvent('re-paused', { type: 'run-resumed', ts: t0 + 1 });
    await store.appendEvent('re-paused', {
      type: 'run-paused',
      pausedFor: 'review-gate',
      ts: t0 + HOUR,
    });

    const entries = await sweepStaleGates(store, {
      ttlMs: 24 * HOUR,
      now: t0 + 26 * HOUR,
      onStale,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].pausedSinceMs).toBe(t0 + HOUR); // the NEW pause
    expect(onStale).toHaveBeenCalledTimes(2); // fresh leg → fresh alert
    const run = await store.getRun('re-paused');
    expect(
      run!.events.filter(e => e.type === GATE_STALE_EVENT_TYPE),
    ).toHaveLength(2);
  });

  it('ignores fresh pauses, non-paused runs, and no-ops entirely at TTL 0', async () => {
    const now = Date.UTC(2026, 6, 1);
    await seedPaused('fresh', now - HOUR);
    await store.upsertRun({
      id: 'old-but-done',
      orchestrationName: 'o',
      startedAt: now - 48 * HOUR,
      endedAt: now - 47 * HOUR,
      status: 'done',
      events: [],
    });
    const onStale = jest.fn();

    expect(
      await sweepStaleGates(store, { ttlMs: 24 * HOUR, now, onStale }),
    ).toHaveLength(0);

    // TTL=0 (SAMMY_GATE_TTL_HOURS=0) disables the sweep even for a run that
    // WOULD be stale under any positive TTL.
    await seedPaused('ancient', now - 500 * HOUR);
    expect(
      await sweepStaleGates(store, { ttlMs: 0, now, onStale }),
    ).toHaveLength(0);
    expect(onStale).not.toHaveBeenCalled();
    const run = await store.getRun('ancient');
    expect(run!.events.some(e => e.type === GATE_STALE_EVENT_TYPE)).toBe(false);
  });
});

// ── Notify envelope + best-effort POST ─────────────────────────────────────

describe('gate-stale notify', () => {
  const input = {
    notify: { onTerminal: 'https://hooks.example/x' },
    runId: 'run-9',
    orchestration: 'nightly-qa',
    pausedFor: 'ship-gate',
    pausedSinceMs: 1_000,
    ttlMs: 24 * HOUR,
    action: 'notify' as const,
  };

  it('builds a structurally-distinct paused/stale envelope with a loud summary', () => {
    const payload = buildGateStaleNotifyPayload(
      input,
      1_000 + 30 * HOUR, // 30h after the pause
    );
    expect(payload).toMatchObject({
      runId: 'run-9',
      orchestration: 'nightly-qa',
      status: 'paused',
      stale: true,
      pausedFor: 'ship-gate',
      pausedSinceMs: 1_000,
    });
    expect(payload.summary).toContain('STALE GATE');
    expect(payload.summary).toContain('ship-gate');
    expect(payload.summary).toContain('30.0h');
    expect(payload.summary).toContain('holds its concurrency group');
    // The cancel variant tells the reader what is about to happen.
    expect(
      buildGateStaleNotifyPayload({ ...input, action: 'cancel' }).summary,
    ).toContain('auto-cancelling');
  });

  it('POSTs once to notify.onTerminal; no sink → no fetch, returns false', () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchSpy = (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({});
    };
    expect(fireGateStaleNotify(input, fetchSpy)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.example/x');
    expect(JSON.parse(calls[0].body)).toMatchObject({ stale: true });

    expect(fireGateStaleNotify({ ...input, notify: undefined }, fetchSpy)).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
  });

  it('swallows a rejecting/throwing sink (best-effort, never blocks)', () => {
    expect(
      fireGateStaleNotify(input, () => Promise.reject(new Error('down'))),
    ).toBe(true);
    expect(
      fireGateStaleNotify(input, () => {
        throw new Error('sync boom');
      }),
    ).toBe(false);
  });
});

// ── Mounted API: boot sweep → list/detail decoration; action=cancel ───────

describe('stale gates over the mounted API', () => {
  let server: http.Server;
  let tmpRoot: string;
  let baseUrl: string;
  let store: SqliteRunStore;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SAMMY_GATE_TTL_HOURS',
    'SAMMY_GATE_TTL_ACTION',
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

  /** Mount over the (already seeded) tmpRoot + store. Env must be set BEFORE
   *  this runs — the mount reads the TTL config at boot; and seeding must
   *  happen before it so the BOOT sweep is what the tests observe. */
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Seed a paused holder BEFORE boot so the boot sweep sees it. */
  async function seedStaleHolder(
    id: string,
    pausedAtMs: number,
    group?: string,
  ): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'gated-orch',
      startedAt: pausedAtMs - HOUR,
      status: 'paused',
      events: [
        { type: 'run-start', ts: pausedAtMs - HOUR },
        { type: 'run-paused', pausedFor: 'review-gate', ts: pausedAtMs },
      ],
      concurrencyGroup: group ?? null,
    });
    await store.updateRunStatus(id, { pausedFor: 'review-gate' });
  }

  /** Poll `probe` until truthy (the boot sweep is fire-and-forget). */
  async function until<T>(probe: () => Promise<T | undefined | false>): Promise<T> {
    for (let i = 0; i < 100; i += 1) {
      const v = await probe();
      if (v) return v;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('condition not reached');
  }

  it('boot sweep surfaces stale:true + pausedSinceMs on the list AND detail', async () => {
    process.env.SAMMY_GATE_TTL_HOURS = '1';
    const pausedAt = Date.now() - 2 * HOUR; // 2h paused > 1h TTL
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-stale-api-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    await seedStaleHolder('stuck-run', pausedAt);
    await mount();

    type Row = { id: string; stale?: boolean; pausedSinceMs?: number };
    const row = await until(async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      const rows = (await res.json()) as Row[];
      const r = rows.find(x => x.id === 'stuck-run');
      return r?.stale ? r : false;
    });
    expect(row.stale).toBe(true);
    expect(row.pausedSinceMs).toBe(pausedAt); // epoch — from the run-paused event

    const detail = (await (
      await fetch(`${baseUrl}/api/runs/stuck-run`)
    ).json()) as { stale?: boolean; pausedSinceMs?: number; status: string };
    expect(detail.status).toBe('paused');
    expect(detail.stale).toBe(true);
    expect(detail.pausedSinceMs).toBe(pausedAt);

    // The durable once-per-leg marker landed exactly once.
    const run = await store.getRun('stuck-run');
    expect(
      run!.events.filter(e => e.type === GATE_STALE_EVENT_TYPE),
    ).toHaveLength(1);
  });

  it('SAMMY_GATE_TTL_ACTION=cancel auto-cancels the stale holder and drains its queue', async () => {
    process.env.SAMMY_GATE_TTL_HOURS = '1';
    process.env.SAMMY_GATE_TTL_ACTION = 'cancel';
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-stale-api-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    await seedStaleHolder('stale-holder', Date.now() - 2 * HOUR, 'stage-env');
    // One fire parked behind the stale holder — the queue the TTL frees. The
    // orch is deliberately NOT on disk, so the drain dequeues it (the proof)
    // and the follow-on start refuses without touching an executor.
    await store.enqueuePendingFire('stage-env', {
      orchName: 'ghost-orch',
      initialInput: null,
      ownerId: 'system',
    });
    await mount();

    await until(async () =>
      (await store.getRun('stale-holder'))?.status === 'cancelled'
        ? true
        : false,
    );
    // The cancel released the group and drained the parked fire — dequeued,
    // its start refused transiently (the orchestration is not in this
    // workspace), and RE-PARKED rather than discarded. This read `0` before,
    // when a transiently-refused drain silently destroyed the parked work.
    expect(await preservedDrains(store, 'stage-env')).toBe(1);
    const run = await store.getRun('stale-holder');
    expect(run!.events.some(e => e.type === GATE_STALE_EVENT_TYPE)).toBe(true);
    expect(run!.events.some(e => e.type === 'run-cancelled')).toBe(true);
  });

  it('SAMMY_GATE_TTL_HOURS=0 disables the sweep (ancient pause left untouched)', async () => {
    process.env.SAMMY_GATE_TTL_HOURS = '0';
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-stale-api-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    await seedStaleHolder('never-flagged', Date.now() - 500 * HOUR);
    await mount();

    // Give the (disabled) boot sweep a beat, then assert nothing happened.
    await new Promise(r => setTimeout(r, 300));
    const res = await fetch(`${baseUrl}/api/runs`);
    const rows = (await res.json()) as Array<{ id: string; stale?: boolean }>;
    expect(rows.find(r => r.id === 'never-flagged')?.stale).toBeUndefined();
    const run = await store.getRun('never-flagged');
    expect(run!.status).toBe('paused');
    expect(run!.events.some(e => e.type === GATE_STALE_EVENT_TYPE)).toBe(false);
    // Detail endpoint still reports the pause age, just never flags stale.
    const detail = (await (
      await fetch(`${baseUrl}/api/runs/never-flagged`)
    ).json()) as { stale?: boolean; pausedSinceMs?: number };
    expect(detail.stale).toBe(false);
    expect(typeof detail.pausedSinceMs).toBe('number');
  });
});
