/**
 * getRunSummary — the LIGHTWEIGHT run status snapshot (no events array), and
 * listRuns honoring its `limit`. Both back the monitoring API: a poller wants
 * a few recent runs + a cheap status line, not the multi-MB full event stream.
 *
 * Covers the SQLite backend unconditionally (mirrors db.test.ts); the Postgres
 * backend honors the same contract and is exercised by postgres-store.test.ts
 * when TEST_DATABASE_URL is set.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { sumCostUsd, summarizeRun, type RunSummary } from '../src/server/run-store';

let tmpRoot: string;
let store: SqliteRunStore | null = null;

async function freshStore(): Promise<SqliteRunStore> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
  return store;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-summary-'));
});

afterEach(async () => {
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('getRunSummary', () => {
  it('returns the lightweight shape with correct counts and no events array', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'run-1',
      orchestrationName: 'ticket-to-pr',
      startedAt: 1000,
      endedAt: 2000,
      status: 'done',
      events: [
        { type: 'run-start', orchestrationName: 'ticket-to-pr', ts: 1001 },
        { type: 'phase-start', phaseName: 'spec', ts: 1100 },
        { type: 'phase-tool-use', phaseName: 'spec', toolUseId: 'a', ts: 1110 },
        { type: 'phase-tool-use', phaseName: 'spec', toolUseId: 'b', ts: 1120 },
        { type: 'phase-end', phaseName: 'spec', ts: 1200 },
        { type: 'phase-start', phaseName: 'build', ts: 1300 },
        { type: 'phase-tool-use', phaseName: 'build', toolUseId: 'c', ts: 1310 },
        { type: 'phase-end', phaseName: 'build', ts: 1400 },
        { type: 'run-end', ts: 1999 },
      ],
    });

    const summary = await s.getRunSummary('run-1');
    expect(summary).not.toBeNull();
    const sum = summary as RunSummary;

    // Header fields carried through.
    expect(sum.id).toBe('run-1');
    expect(sum.orchestrationName).toBe('ticket-to-pr');
    expect(sum.status).toBe('done');
    expect(sum.startedAt).toBe(1000);
    expect(sum.endedAt).toBe(2000);

    // Counts derived by scanning the event stream.
    expect(sum.phasesStarted).toBe(2);
    expect(sum.phasesEnded).toBe(2);
    expect(sum.toolUses).toBe(3);

    // Last-event fields from the final event.
    expect(sum.lastEventType).toBe('run-end');
    expect(sum.lastEventTs).toBe(1999);

    // The whole point: the events array is NOT part of the lightweight shape.
    expect((sum as Record<string, unknown>).events).toBeUndefined();

    // Live cost + current phase (items 4/5). This run is terminal (done), so it
    // has no current phase; its cost is 0 here (no phase-end carried a cost).
    expect(sum.costUsd).toBe(0);
    expect(sum.currentPhase).toBeNull();
  });

  it('returns null for a missing run', async () => {
    const s = await freshStore();
    expect(await s.getRunSummary('nope')).toBeNull();
  });

  it('handles a run with zero events (null last-event fields, zero counts)', async () => {
    const s = await freshStore();
    await s.upsertRun({
      id: 'empty',
      orchestrationName: 'x',
      startedAt: 5,
      status: 'running',
      events: [],
    });
    const sum = (await s.getRunSummary('empty')) as RunSummary;
    expect(sum.phasesStarted).toBe(0);
    expect(sum.phasesEnded).toBe(0);
    expect(sum.toolUses).toBe(0);
    expect(sum.lastEventType).toBeNull();
    expect(sum.lastEventTs).toBeNull();
    expect(sum.endedAt).toBeNull();
  });
});

describe('sumCostUsd', () => {
  it('sums every phase-end costUsd and ignores other events / missing costs', () => {
    expect(
      sumCostUsd([
        { type: 'run-start', ts: 1 },
        { type: 'phase-end', phaseName: 'a', costUsd: 0.25, ts: 2 },
        { type: 'phase-tool-use', phaseName: 'a', ts: 2 }, // not a phase-end
        { type: 'phase-end', phaseName: 'b', costUsd: 0.75, ts: 3 },
        { type: 'phase-end', phaseName: 'c', ts: 4 }, // costUsd missing → 0
        { type: 'phase-end', phaseName: 'd', costUsd: Number.NaN, ts: 5 }, // non-finite → 0
      ]),
    ).toBeCloseTo(1.0, 6);
  });

  it('is 0 for a run with no phase-ends', () => {
    expect(sumCostUsd([{ type: 'run-start', ts: 1 }])).toBe(0);
    expect(sumCostUsd([])).toBe(0);
  });
});

describe('summarizeRun — currentPhase', () => {
  const header = {
    id: 'r',
    orchestrationName: 'demo',
    startedAt: 1,
    endedAt: null,
    status: 'running' as const,
    orchestrationSnapshot: null,
    initialInput: null,
    currentPath: null,
    stateJson: null,
    lastOutput: null,
    pausedFor: null,
    completedLeaves: null,
    updatedAt: 1,
    ownerId: 'system',
    concurrencyGroup: null,
    degraded: false,
    degradationReasons: [],
  };

  it('is the last phase-start while the run is live', () => {
    const s = summarizeRun(header, [
      { type: 'phase-start', phaseName: 'one', ts: 2 },
      { type: 'phase-end', phaseName: 'one', costUsd: 0.5, ts: 3 },
      { type: 'phase-start', phaseName: 'two', ts: 4 },
    ]);
    expect(s.currentPhase).toBe('two');
    expect(s.costUsd).toBeCloseTo(0.5, 6);
  });

  it('is null once the run is terminal', () => {
    const s = summarizeRun({ ...header, status: 'done', endedAt: 5 }, [
      { type: 'phase-start', phaseName: 'one', ts: 2 },
      { type: 'phase-end', phaseName: 'one', ts: 3 },
    ]);
    expect(s.currentPhase).toBeNull();
  });
});

describe('listRuns limit', () => {
  it('returns at most `limit` rows (latest-first)', async () => {
    const s = await freshStore();
    for (const [id, startedAt] of [
      ['r1', 100],
      ['r2', 200],
      ['r3', 300],
    ] as const) {
      await s.upsertRun({
        id,
        orchestrationName: 'a',
        startedAt,
        status: 'done',
        events: [],
      });
    }
    const limited = await s.listRuns(2);
    expect(limited).toHaveLength(2);
    // started_at DESC → the two newest.
    expect(limited.map(r => r.id)).toEqual(['r3', 'r2']);

    // No limit → all three.
    expect(await s.listRuns()).toHaveLength(3);
  });
});

describe('summarizeRun — lastProgressAt (the liveness clock)', () => {
  const header = {
    id: 'r2',
    orchestrationName: 'demo',
    startedAt: 1,
    endedAt: null,
    status: 'running' as const,
    orchestrationSnapshot: null,
    initialInput: null,
    currentPath: null,
    stateJson: null,
    lastOutput: null,
    pausedFor: null,
    completedLeaves: null,
    updatedAt: 1,
    ownerId: 'system',
    concurrencyGroup: null,
    degraded: false,
    degradationReasons: [],
  };

  it('advances on ANY event type — including phase-heartbeat beats', () => {
    // The contract: a poller reads lastProgressAt instead of
    // parsing events; heartbeats during a silent SDK tail keep it fresh.
    const s = summarizeRun(header, [
      { type: 'phase-start', phaseName: 'work', agentPath: 'a', ts: 10 },
      { type: 'phase-delta', phaseName: 'work', text: 'x', ts: 20 },
      {
        type: 'phase-heartbeat',
        phaseName: 'work',
        via: 'input_json_delta',
        messages: 9,
        toolUses: 1,
        textBytes: 0,
        ts: 99_000,
      },
    ]);
    expect(s.lastProgressAt).toBe(99_000);
    expect(s.lastEventTs).toBe(99_000);
  });

  it('is null before any event', () => {
    expect(summarizeRun(header, []).lastProgressAt).toBeNull();
  });
});
