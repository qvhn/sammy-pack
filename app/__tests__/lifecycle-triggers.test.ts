/**
 * LIFECYCLE CASE 4 — TRIGGER RE-REGISTRATION (save + restart, no leaked tasks)
 * LIFECYCLE CASE 6 — CRON DOUBLE-FIRE IDEMPOTENCY
 *
 * Case 4: an orchestration registers cron expr X at boot. Rewriting it with
 * expr Y through PUT /api/orchestrations/:name (the save path that calls
 * refreshTriggersForOrch) must leave Y and ONLY Y — in the introspection
 * endpoint AND in node-cron's process-global task registry (no leaked task
 * still scheduled for X). Then the historical melt-the-laptop leak: a
 * RE-MOUNT in the same process (vite restart / HMR) must not duplicate the
 * task — the deterministic task name (`sammy:cron:<orch>:<expr>`) sweep must
 * destroy the prior mount's task before rescheduling.
 *
 * Case 6: node-cron can deliver the same scheduled tick twice (event-loop
 * stall catch-up, duplicate registration around the fire window). The cron
 * closure guards this with a minute-bucketed HEADER idempotency key
 * (`cron:<orch>:<expr>:<bucket>`). We force the exact double-fire by invoking
 * the REAL registered task's callback twice (`task.execute()` — the same
 * function the scheduler runs) inside one bucket → exactly ONE durable
 * delivery row exists. No fake timers, no waiting for a real tick: the
 * schedule expressions used here (daily 09:00/10:30) never fire mid-test.
 *
 * The in-process delivery worker is disabled (harness default), so the
 * delivery layer — where the idempotency boundary lives — is directly
 * observable: an accepted fire is a durable `pending` row, not yet a run.
 */

import { promises as fs } from 'node:fs';
import {
  destroySammyCronTasks,
  getJson,
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  putJson,
  sammyCronTasksNamed,
  sleep,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-cron';
const EXPR_X = '0 9 * * *'; // daily 09:00 — never fires during the test
const EXPR_Y = '30 10 * * *'; // daily 10:30 — never fires during the test
const TASK_PREFIX = `sammy:cron:${ORCH}:`;

type TriggerRow = {
  kind: string;
  name: string;
  orchestration: string;
  firing: string;
  config: Record<string, unknown>;
};

const orchWithExpr = (expr: string) => ({
  name: ORCH,
  triggers: [{ kind: 'cron', expr }],
  phases: [{ name: 'noop', code: { source: "return 'ok';" } }],
});

describe('lifecycle: trigger re-registration + cron double-fire idempotency (cases 4 + 6)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount1: Mount;
  let mount2: Mount | null = null;

  const cronRows = async (baseUrl: string): Promise<TriggerRow[]> =>
    (await getJson<TriggerRow[]>(`${baseUrl}/api/triggers`)).filter(
      r => r.orchestration === ORCH && r.kind === 'cron',
    );

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('triggers');
    await writeOrchestration(tmpRoot, orchWithExpr(EXPR_X));
    mount1 = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount1.kill();
    await mount2?.kill();
    // node-cron's registry is process-global; drop what the mounts scheduled.
    destroySammyCronTasks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('boot scan registers cron X (introspection + exactly one scheduled task)', async () => {
    const rows = await cronRows(mount1.baseUrl);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe(EXPR_X);
    expect(rows[0].firing).toBe('schedule');
    expect(rows[0].config).toMatchObject({ expr: EXPR_X });

    const tasks = sammyCronTasksNamed(TASK_PREFIX);
    expect(tasks.map(t => t.name)).toEqual([`${TASK_PREFIX}${EXPR_X}`]);
  });

  it('case 4: PUT with expr Y re-registers — Y and ONLY Y, no leaked task for X', async () => {
    const { status } = await putJson(
      `${mount1.baseUrl}/api/orchestrations/${ORCH}`,
      orchWithExpr(EXPR_Y),
    );
    expect(status).toBe(200);

    // Introspection: exactly one cron row, showing Y — X is gone.
    const rows = await cronRows(mount1.baseUrl);
    expect(rows.map(r => r.name)).toEqual([EXPR_Y]);

    // The REGISTRY truth (what actually fires): only Y's task survives; the
    // task scheduled for X was destroyed, not just forgotten by the closure.
    const tasks = sammyCronTasksNamed(TASK_PREFIX);
    expect(tasks.map(t => t.name)).toEqual([`${TASK_PREFIX}${EXPR_Y}`]);
  });

  it('case 4 (restart flavor): a RE-MOUNT in the same process does not duplicate the task', async () => {
    // The historical stampede: each re-mount scheduled a fresh task while the
    // previous closure's task kept running invisibly. The deterministic-name
    // sweep must leave exactly ONE live task after a second mount over the
    // same workspace.
    mount2 = await mountServer(tmpRoot);

    const rows = await cronRows(mount2.baseUrl);
    expect(rows.map(r => r.name)).toEqual([EXPR_Y]);

    const tasks = sammyCronTasksNamed(TASK_PREFIX);
    expect(tasks.length).toBe(1);
    expect(tasks[0].name).toBe(`${TASK_PREFIX}${EXPR_Y}`);
  });

  it('case 6: firing the registered cron task twice in one idempotency bucket creates exactly ONE delivery', async () => {
    // The cron key buckets by MINUTE for a 5-field expr. If we're within
    // 2.5s of a minute rollover, wait past it so both fires land in the
    // same bucket deterministically.
    const msIntoMinute = Date.now() % 60_000;
    if (msIntoMinute > 57_500) await sleep(60_050 - msIntoMinute);

    const [task] = sammyCronTasksNamed(`${TASK_PREFIX}${EXPR_Y}`);
    expect(task).toBeDefined();

    // The double-fire, via the REAL registered callback (what the scheduler
    // itself invokes on a tick — including a stall catch-up duplicate).
    await task.execute!();
    await task.execute!();

    const deliveries = (await mount2!.store.listDeliveries(100)).filter(
      d => d.kind === 'cron' && d.orchestrationName === ORCH,
    );
    expect(deliveries.length).toBe(1);
    // Header-sourced bucketed key — dedupes for all time, across restarts.
    expect(deliveries[0].keySource).toBe('header');
    // The stored key is SCOPED to owner + kind + trigger name, with each
    // component percent-encoded, and carries the caller's bucketed key last.
    // The scope prefix is the fix for a dedupe namespace that used to be
    // global: one `Idempotency-Key` reused on two endpoints (or by two
    // tenants) collapsed them into one delivery and returned the first's ids.
    const storedKey = deliveries[0].idempotencyKey;
    expect(storedKey.startsWith(`hdr:system:cron:${encodeURIComponent(EXPR_Y)}:`)).toBe(
      true,
    );
    // The caller's own key is the LAST component, encoded whole, so it
    // round-trips intact — and still ends in the minute bucket, which is
    // what collapses the double fire.
    const callerKey = decodeURIComponent(storedKey.split(':').pop()!);
    expect(callerKey).toMatch(new RegExp(`^cron:${ORCH}:.+:\\d+$`));
    // Accept ≠ execute: with the worker off the fire is a durable pending
    // row; no run was spawned by either fire (and certainly not two).
    expect(deliveries[0].status).toBe('pending');
    const runs = (await listRuns(mount2!.baseUrl)).filter(
      r => r.orchestrationName === ORCH,
    );
    expect(runs.length).toBe(0);
  });
});
