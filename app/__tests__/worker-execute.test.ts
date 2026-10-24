/**
 * Integration test for executor-in-worker: a delivery is claimed and the run
 * is built + EXECUTED entirely via the extracted engine (run-context.ts +
 * run-runner.ts + run-controller), with NO server process. Uses a no-LLM
 * `code` orchestration so it's free + deterministic.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunStore } from '../src/server/run-store';
import { SqliteRunStore } from '../src/server/db';
import { DeliveryWorker } from '../src/server/delivery-worker';
import { makeLoadRunContext } from '../src/server/run-context';
import { createRunRunner } from '../src/server/run-runner';
import { startRun, _resetForTests } from '../src/server/run-controller';
import { loadBudgetState } from '../src/server/budget-store';
import { makeWorkerTerminalHook } from '../src/server/worker-terminal-hook';

let tmpRoot: string;
let store: RunStore | null = null;
let seq = 0;
const newDeliveryId = () => `del-${Date.now()}-${(seq++).toString(36)}`;

// The exact direct-mode runDelivery worker.ts uses: budget gate + in-process
// execution + the worker terminal-hook (eventing + errorOrchestration).
function makeDirectRunDelivery(s: RunStore, root: string) {
  const examplesDir = path.join(root, 'examples');
  const loadRunContext = makeLoadRunContext({
    examplesDir,
    agentsDir: path.join(root, 'agents'),
  });
  const runner = createRunRunner({ root });
  const budgetFile = path.join(root, 'budget.json');
  const startRecoveryRun = async (name: string, envelope: string, owner: string) => {
    const ctx = await loadRunContext(name);
    if (!ctx) return;
    await startRun({
      store: s,
      orchestrationName: name,
      initialInput: envelope,
      orchestrationSnapshot: ctx.orchestration,
      ownerId: owner,
      buildEventSource: signal =>
        runner.buildExecutorSource(
          ctx,
          { initialInput: envelope, allowAgentTools: true, ownerId: owner },
          signal,
        ),
    });
  };
  return async (d: { orchestrationName: string; body: string | null; ownerId: string }) => {
    const ctx = await loadRunContext(d.orchestrationName);
    if (!ctx) return { ok: false as const, error: 'missing', retryable: false };
    const { status: bs, gate } = await loadBudgetState(budgetFile, s);
    if (bs.blocked) {
      return { ok: false as const, error: 'budget cap reached — run refused', retryable: false };
    }
    const { id } = await startRun({
      store: s,
      orchestrationName: d.orchestrationName,
      initialInput: d.body ?? '',
      orchestrationSnapshot: ctx.orchestration,
      budgetGate: gate,
      ownerId: d.ownerId,
      onTerminal: makeWorkerTerminalHook({
        orchName: d.orchestrationName,
        orch: ctx.orchestration,
        ownerId: d.ownerId,
        store: s,
        examplesDir,
        newDeliveryId,
        startRecoveryRun,
      }),
      buildEventSource: signal =>
        runner.buildExecutorSource(
          ctx,
          { initialInput: d.body ?? '', allowAgentTools: true, ownerId: d.ownerId },
          signal,
        ),
    });
    return { ok: true as const, runId: id };
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-worker-exec-'));
  await fs.mkdir(path.join(tmpRoot, 'examples'));
  await fs.mkdir(path.join(tmpRoot, 'agents'));
  // A no-LLM code orchestration: prefixes its input.
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 't.json'),
    JSON.stringify({
      name: 't',
      phases: [{ name: 'p', code: { source: "return 'ok:' + input" } }],
    }),
  );
  const sqlite = new SqliteRunStore(tmpRoot);
  await sqlite.init();
  store = sqlite;
});

afterEach(async () => {
  _resetForTests();
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

it('worker claims a delivery and executes the run in-process (no server)', async () => {
  const s = store!;
  await s.recordDelivery({
    id: 'd1',
    kind: 'webhook',
    name: 't-hook',
    orchestrationName: 't',
    idempotencyKey: 'k1',
    keySource: 'header',
    status: 'pending',
    body: 'hi',
    ownerId: 'system',
    receivedAt: Date.now(),
  });

  const worker = new DeliveryWorker({
    store: s,
    runDelivery: makeDirectRunDelivery(s, tmpRoot),
  });

  const processed = await worker.processOne();
  expect(processed?.id).toBe('d1');

  const deliv = (await s.listDeliveries(10)).find(x => x.id === 'd1');
  expect(deliv?.status).toBe('fired');
  const runId = deliv?.runId;
  expect(runId).toBeTruthy();

  // The run executes in the background — poll until it terminates.
  let run = await s.getRun(runId!);
  for (let i = 0; i < 60 && (!run || run.status === 'running'); i += 1) {
    await new Promise(r => setTimeout(r, 50));
    run = await s.getRun(runId!);
  }
  expect(run?.status).toBe('done');
  expect(run?.lastOutput).toBe('ok:hi'); // the code node ran, in-worker
}, 15000);

it('direct-mode worker refuses a delivery when the budget cap is breached', async () => {
  const s = store!;
  // A tiny daily cap, already exceeded by a prior costly run today.
  await fs.writeFile(
    path.join(tmpRoot, 'budget.json'),
    JSON.stringify({ dailyUsd: 0.01 }),
  );
  await s.upsertRun({
    id: 'prior',
    orchestrationName: 't',
    startedAt: Date.now(),
    endedAt: Date.now(),
    status: 'done',
    events: [{ type: 'phase-end', costUsd: 5, ts: Date.now() }],
  });
  await s.recordDelivery({
    id: 'd-budget',
    kind: 'webhook',
    name: 't-hook',
    orchestrationName: 't',
    idempotencyKey: 'kb',
    keySource: 'header',
    status: 'pending',
    body: 'hi',
    ownerId: 'system',
    receivedAt: Date.now(),
  });

  const worker = new DeliveryWorker({
    store: s,
    runDelivery: makeDirectRunDelivery(s, tmpRoot),
  });
  await worker.processOne();

  const deliv = (await s.listDeliveries(10)).find(x => x.id === 'd-budget');
  expect(deliv?.status).toBe('rejected'); // refused, not fired — no uncapped run
  expect(deliv?.runId).toBeNull();
  expect(deliv?.lastError).toMatch(/budget/i);
}, 15000);

it('direct-mode worker fires reactive events to subscribers (in-worker)', async () => {
  const s = store!;
  // A consumer that subscribes to the producer's `t.done` lifecycle event.
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'consumer.json'),
    JSON.stringify({
      name: 'consumer',
      triggers: [{ kind: 'events', event: 't.done' }],
      phases: [{ name: 'c', code: { source: "return 'consumed:' + input" } }],
    }),
  );
  await s.recordDelivery({
    id: 'dp',
    kind: 'webhook',
    name: 't',
    orchestrationName: 't',
    idempotencyKey: 'kp',
    keySource: 'header',
    status: 'pending',
    body: 'hi',
    ownerId: 'system',
    receivedAt: Date.now(),
  });

  const worker = new DeliveryWorker({
    store: s,
    runDelivery: makeDirectRunDelivery(s, tmpRoot),
  });

  // Drain repeatedly: producer runs → on done, the terminal hook publishes
  // `t.done` → a `consumer` delivery is enqueued → the next drain runs it.
  let evtDeliv;
  let consumerRun;
  for (let i = 0; i < 100; i += 1) {
    await worker.drain();
    evtDeliv = (await s.listDeliveries(50)).find(
      d => d.kind === 'events' && d.name === 't.done' && d.orchestrationName === 'consumer',
    );
    consumerRun = (await s.listRuns(50)).find(
      r => r.orchestrationName === 'consumer' && r.status === 'done',
    );
    if (evtDeliv && consumerRun) break;
    await new Promise(r => setTimeout(r, 50));
  }

  expect(evtDeliv).toBeDefined(); // the worker published the lifecycle event
  expect(consumerRun).toBeDefined(); // and the subscriber ran, in-worker
  expect(consumerRun?.lastOutput).toMatch(/^consumed:/);
}, 20000);

it('direct-mode worker runs lifecycle.errorOrchestration recovery (with gate + hook)', async () => {
  const s = store!;
  // `bad` errors; its errorOrchestration `rescue` should run via the worker's
  // startRecoveryRun (now wired with budgetGate + a terminal hook).
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'bad.json'),
    JSON.stringify({
      name: 'bad',
      lifecycle: { errorOrchestration: 'rescue' },
      phases: [{ name: 'p', code: { source: "throw new Error('boom')" } }],
    }),
  );
  await fs.writeFile(
    path.join(tmpRoot, 'examples', 'rescue.json'),
    JSON.stringify({
      name: 'rescue',
      phases: [{ name: 'r', code: { source: "return 'rescued:' + input" } }],
    }),
  );
  await s.recordDelivery({
    id: 'd-bad',
    kind: 'webhook',
    name: 'bad',
    orchestrationName: 'bad',
    idempotencyKey: 'kbad',
    keySource: 'header',
    status: 'pending',
    body: 'hi',
    ownerId: 'system',
    receivedAt: Date.now(),
  });

  const worker = new DeliveryWorker({
    store: s,
    runDelivery: makeDirectRunDelivery(s, tmpRoot),
  });

  let rescueRun;
  for (let i = 0; i < 100; i += 1) {
    await worker.drain();
    rescueRun = (await s.listRuns(50)).find(
      r => r.orchestrationName === 'rescue' && r.status === 'done',
    );
    if (rescueRun) break;
    await new Promise(r => setTimeout(r, 50));
  }
  expect(rescueRun).toBeDefined(); // recovery actually fired, in-worker
  expect(rescueRun?.lastOutput).toMatch(/^rescued:/);
}, 20000);
