/**
 * A terminal the store never RECORDED owns no side effects.
 *
 * The controller retries its terminal write and, when every attempt fails,
 * tears the leg down anyway and fires the hook with `terminalWriteError` set —
 * so nothing downstream is stranded. But the row still reads `running`, so the
 * orphan scan reclaims it as `interrupted` and the next leg re-walks to the
 * same terminal and fires the hook AGAIN. Nothing the hook owns is idempotent
 * across that gap: the reactive delivery keys are `auto:evt:<runId>:<sub>` but
 * the reclaim is a lease TTL out, past the auto-dedupe window, and the
 * `errorOrchestration` recovery run has no key at all — so one logical outcome
 * bought a duplicate fan-out and a duplicate recovery run, which spends.
 *
 * The hook now skips its external side effects when the status could not be
 * recorded; the leg that records a terminal owns them. Keep in sync with the
 * server's `buildTerminalHook`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { makeWorkerTerminalHook } from '../src/server/worker-terminal-hook';

const GROUP = 'unrecorded-group';
let tmpRoot: string;
let store: SqliteRunStore;
let seq = 0;
const newDeliveryId = () => `del-${Date.now()}-${(seq++).toString(36)}`;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-worker-unrec-'));
  await fs.mkdir(path.join(tmpRoot, 'examples'));
  // A subscriber to `q.error`, so the reactive fan-out has somewhere to go.
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'listener.json'),
    JSON.stringify({
      name: 'listener',
      triggers: [{ kind: 'events', event: 'q.error' }],
      phases: [{ name: 'p', code: { source: "return 'heard'" } }],
    }),
  );
  store = new SqliteRunStore(tmpRoot);
  await store.init();
});

afterEach(async () => {
  await store.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function seedRun(id: string): Promise<void> {
  await store.upsertRun({
    id,
    orchestrationName: 'q',
    startedAt: Date.now(),
    status: 'running',
    events: [{ type: 'run-start', orchestrationName: 'q', ts: 0 }],
    concurrencyGroup: GROUP,
  });
  await store.enqueuePendingFire(GROUP, {
    orchName: 'q',
    initialInput: 'parked',
    ownerId: 'system',
  });
}

function hookFor(startRecoveryRun: jest.Mock) {
  return makeWorkerTerminalHook({
    orchName: 'q',
    orch: {
      name: 'q',
      lifecycle: { errorOrchestration: 'q-recovery' },
      concurrency: { group: GROUP, policy: 'queue' },
    },
    ownerId: 'system',
    store,
    examplesDir: path.join(tmpRoot, 'examples'),
    newDeliveryId,
    startRecoveryRun,
  });
}

describe("the worker's terminal hook and a terminal that was never recorded", () => {
  it('skips the fan-out, the recovery run and the drain when terminalWriteError is set', async () => {
    await seedRun('r-unrecorded');
    const recovery = jest.fn(async () => {});
    await hookFor(recovery)({
      id: 'r-unrecorded',
      status: 'error',
      error: 'boom',
      terminalWriteError: 'SQLITE_BUSY: database is locked',
    });
    expect(await store.listDeliveries(10)).toEqual([]);
    expect(recovery).not.toHaveBeenCalled();
    // Still parked: the reclaim path (`scanOrphanedRuns`) drains a reclaimed
    // run's group itself, so the queue is not stranded by skipping it here.
    expect(await store.countPendingFires(GROUP)).toBe(1);
  });

  it('does all three for a terminal the store DID record', async () => {
    await seedRun('r-recorded');
    const recovery = jest.fn(async () => {});
    await hookFor(recovery)({
      id: 'r-recorded',
      status: 'error',
      error: 'boom',
    });
    expect(
      (await store.listDeliveries(10)).map(d => ({
        kind: d.kind,
        name: d.name,
        orchestrationName: d.orchestrationName,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'events', name: 'q.error', orchestrationName: 'listener' },
        { kind: 'concurrency-drain', name: GROUP, orchestrationName: 'q' },
      ]),
    );
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(await store.countPendingFires(GROUP)).toBe(0);
  });
});
