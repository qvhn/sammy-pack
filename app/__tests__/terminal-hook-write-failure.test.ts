/**
 * A terminal the store never recorded fires NO external side effect.
 *
 * When every attempt at the terminal status write fails, the leg tears itself
 * down and still calls `onTerminal` — so nothing downstream is stranded — but
 * the row keeps reading `running`, and is therefore reclaimed as `interrupted`
 * (resumable). With SAMMY_AUTO_RESUME=1 that reclaim RE-EXECUTES the leg, the
 * re-walk reaches the same terminal, and the hook ran a SECOND time for ONE
 * logical outcome: two `lifecycle.errorOrchestration` recovery runs spending
 * real money, two notify webhooks (`fireTerminalNotify` has no idempotency at
 * all), two breaker failure rows counted toward the cron auto-pause threshold,
 * and a second `<orch>.error` publish the auto-dedupe window cannot collapse —
 * the reclaim cannot happen before the 120s lease lapses and the window is
 * 60s. Repeating once per lease lapse for as long as the write keeps failing.
 *
 * `TerminalInfo.terminalWriteError` already carried the signal; neither hook
 * read it. The guard makes the authoritative terminal whichever leg actually
 * records one.
 *
 * The group drain is skipped with the rest, deliberately: the reclaim drains
 * the group when the run is not resumed (pinned by
 * lifecycle-terminal-write-reclaim.test.ts) and a resumed leg re-takes its
 * group and drains at its own terminal, so a parked fire waits up to the lease
 * TTL instead of being released by a terminal that was never recorded.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteRunStore } from '../src/server/db';
import { isActive } from '../src/server/run-controller';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  waitFor,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

const VICTIM = 'twf-victim';
const RECOVERY = 'twf-recovery';
const SUBSCRIBER = 'twf-subscriber';

describe('terminal-write failure + auto-resume fires the hook once, not twice', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let collector: http.Server;
  let notifies: Array<Record<string, unknown>>;

  const recoveryRuns = async (): Promise<number> =>
    (await mount.store.listRuns(100)).filter(
      r => r.orchestrationName === RECOVERY,
    ).length;

  /** Reactive fan-out of `<orch>.error`, as durable delivery rows. The
   *  in-process delivery worker is off in the harness baseline, so a fan-out
   *  stays observable as a row instead of racing into a run. */
  const errorDeliveries = async (): Promise<number> =>
    (await mount.store.listDeliveries(100)).filter(
      d => d.kind === 'events' && d.name === `${VICTIM}.error`,
    ).length;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    process.env.SAMMY_AUTO_RESUME = '1';
    process.env.SAMMY_ORPHAN_SWEEP_MS = '150';
    process.env.SAMMY_NOTIFY_ALLOWED_HOSTS = '127.0.0.1';

    notifies = [];
    collector = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          notifies.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          notifies.push({ raw: body });
        }
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
    const port = (collector.address() as AddressInfo).port;

    const tmpRoot = await makeWorkspace('terminal-write-hook');
    await writeOrchestration(tmpRoot, {
      name: VICTIM,
      lifecycle: { errorOrchestration: RECOVERY },
      notify: { onTerminal: `http://127.0.0.1:${port}/hook` },
      phases: [{ name: 'boom', code: { source: "throw new Error('boom')" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: RECOVERY,
      phases: [{ name: 'p', code: { source: "return 'recovered'" } }],
    });
    // A subscriber, so `<orch>.error` has somewhere to fan out to — with no
    // subscriber `publishEvent` is a no-op and the publish leaves no trace.
    await writeOrchestration(tmpRoot, {
      name: SUBSCRIBER,
      triggers: [{ kind: 'events', event: `${VICTIM}.error` }],
      phases: [{ name: 'p', code: { source: "return 'reacted'" } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await new Promise<void>(resolve => collector.close(() => resolve()));
    restoreEnv?.();
  });

  it('fires no side effect on the failed leg, then exactly one on the resumed leg', async () => {
    // The `error` status write fails the way a busy SQLite file does — every
    // attempt, while armed. Everything else about the store is real.
    let armed = true;
    const real = SqliteRunStore.prototype.updateRunStatus;
    mount.store.updateRunStatus = async function (
      this: SqliteRunStore,
      id,
      patch,
      opts,
    ) {
      if (armed && patch.status === 'error') {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return real.call(this, id, patch, opts);
    };

    const started = await fetch(`${mount.baseUrl}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orchestrationName: VICTIM }),
    });
    expect(started.status).toBe(200);
    const { id } = (await started.json()) as { id: string };

    // The leg gives up (bounded retries) and tears down.
    await waitFor(async () => (isActive(id) ? null : true), 'the leg to give up', {
      timeoutMs: 15_000,
    });
    // The row never reached `error`, so nothing external may have happened.
    expect((await mount.store.getRunSummary(id))?.status).toBe('running');
    // Give the hook's own async work a window in which it COULD have fired.
    await new Promise(r => setTimeout(r, 400));
    expect(await recoveryRuns()).toBe(0);
    expect(notifies).toHaveLength(0);
    expect(await errorDeliveries()).toBe(0);

    // The lease lapses (backdated — the TTL is two minutes), the sweep
    // reclaims the row, and auto-resume re-executes the leg.
    armed = false;
    const db = (
      mount.store as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }
    ).db;
    db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(
      Date.now() - 1,
      id,
    );
    await waitForRun(mount.baseUrl, id, ['error'], undefined, 'the resumed leg to record error');

    // ONE outcome, ONE of everything — this is where it used to be two.
    const oneRecovery = await waitFor(
      async () => ((await recoveryRuns()) >= 1 ? await recoveryRuns() : null),
      'the recovery run to be dispatched',
    );
    expect(oneRecovery).toBe(1);
    const oneNotify = await waitFor(
      async () => (notifies.length >= 1 ? notifies.length : null),
      'the terminal notify to arrive',
    );
    expect(oneNotify).toBe(1);
    expect(notifies[0]).toMatchObject({ runId: id, status: 'error' });
    // Settle, then prove it stayed at one (the duplicate arrived later).
    await new Promise(r => setTimeout(r, 600));
    expect(await recoveryRuns()).toBe(1);
    expect(notifies).toHaveLength(1);
    expect(await errorDeliveries()).toBe(1);
  });
});
