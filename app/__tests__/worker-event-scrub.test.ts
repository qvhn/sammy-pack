/**
 * The standalone worker publishes `<orch>.done` / `.error` to subscribers by
 * recording deliveries directly — so it must apply each subscriber's ingress
 * `scrub` exactly as the server's deliver() does. It used to store the raw
 * run output, so a subscriber that asked for it to be dropped got it anyway
 * whenever the producing run executed in the worker.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { makeWorkerTerminalHook } from '../src/server/worker-terminal-hook';

let tmpRoot: string;
let store: SqliteRunStore;
let seq = 0;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-worker-scrub-'));
  await fs.mkdir(path.join(tmpRoot, 'examples'));
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'scrubbed-listener.json'),
    JSON.stringify({
      name: 'scrubbed-listener',
      triggers: [{ kind: 'events', event: 'producer.done', scrub: { dropFields: ['output'] } }],
      phases: [{ name: 'p', code: { source: "return 'heard'" } }],
    }),
  );
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'plain-listener.json'),
    JSON.stringify({
      name: 'plain-listener',
      triggers: [{ kind: 'events', event: 'producer.done' }],
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

it('applies each subscriber\'s scrub to the lifecycle event body', async () => {
  await store.upsertRun({
    id: 'run-p',
    orchestrationName: 'producer',
    startedAt: Date.now(),
    status: 'done',
    endedAt: Date.now(),
    // lastOutput is derived from the run's events on upsert.
    events: [
      { type: 'phase-end', phaseName: 'p', output: 'contact jane@example.com at 415-555-0100', ts: Date.now() },
    ],
  });
  const hook = makeWorkerTerminalHook({
    orchName: 'producer',
    orch: { name: 'producer', phases: [] } as never,
    ownerId: 'system',
    store,
    examplesDir: path.join(tmpRoot, 'examples'),
    newDeliveryId: () => `d-${seq++}`,
  });
  await hook({ id: 'run-p', status: 'done', error: null });
  const ds = await store.listDeliveries(10);
  const scrubbed = ds.find(d => d.orchestrationName === 'scrubbed-listener');
  const plain = ds.find(d => d.orchestrationName === 'plain-listener');
  expect(JSON.parse(scrubbed!.body!)).toEqual({ runId: 'run-p', orchestration: 'producer', status: 'done' });
  expect(scrubbed!.detail).toMatch(/^scrubbed:/);
  expect(plain!.body).toContain('jane@example.com');
});
