/**
 * LIFECYCLE CASE 5 — ENV-DRIFT PREFLIGHT (SAMMY_ALLOW_CODE_RUN).
 *
 * The drift: an orchestration using the `code.run` shell escape hatch works on
 * the machine where SAMMY_ALLOW_CODE_RUN=1 was exported, then silently fails
 * on every scheduled fire after a restart / new shell that lost the flag. The
 * defense is the run-START preflight: the run must halt IMMEDIATELY with one
 * explicit run-error naming the flag — before any phase dispatches — instead
 * of dying ~30s deep in the first code node.
 *
 * This is the only lifecycle case that uses `code.run` at all, and the
 * preflight halt IS the assertion. With the flag set ('1') the SAME
 * orchestration must sail past preflight and complete (`echo ok`).
 */

import { promises as fs } from 'node:fs';
import {
  eventsOfType,
  getJson,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  startRun,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(30_000);

const ORCH = 'lifecycle-envdrift';

describe('lifecycle: env-drift preflight for code.run (case 5)', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv(); // baseline: SAMMY_ALLOW_CODE_RUN is UNSET
    tmpRoot = await makeWorkspace('envdrift');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'shell', code: { run: 'echo ok' } }],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    await mount.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('flag unset → the run halts AT PREFLIGHT with one explicit run-error naming the flag', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;

    // /api/health tells the truth about the capability before any run.
    const health = await getJson<{ capabilities: { codeRun: boolean } }>(
      `${mount.baseUrl}/api/health`,
    );
    expect(health.capabilities.codeRun).toBe(false);

    // The start is ACCEPTED (the run row exists — drift is a run-level
    // failure, not a 4xx) but halts instantly.
    const started = await startRun(mount.baseUrl, ORCH);
    expect(started.id).toBeTruthy();
    const errored = await waitForRun(mount.baseUrl, started.id!, ['error']);

    const runErrors = eventsOfType(errored, 'run-error');
    expect(runErrors.length).toBe(1);
    const msg = String(runErrors[0].error);
    expect(msg).toContain('SAMMY_ALLOW_CODE_RUN'); // names the exact env fix
    expect(msg.toLowerCase()).toContain('preflight');

    // Halted BEFORE any phase: no phase-start, no phase-error, no run-end.
    expect(eventsOfType(errored, 'phase-start')).toEqual([]);
    expect(eventsOfType(errored, 'phase-error')).toEqual([]);
    expect(eventsOfType(errored, 'run-end')).toEqual([]);
    // Terminal + actionable, not a 30s-deep mystery.
    expect(errored.endedAt).toBeGreaterThan(0);
  });

  it("flag set ('1') → the SAME orchestration passes preflight and completes", async () => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';

    const health = await getJson<{ capabilities: { codeRun: boolean } }>(
      `${mount.baseUrl}/api/health`,
    );
    expect(health.capabilities.codeRun).toBe(true);

    const started = await startRun(mount.baseUrl, ORCH);
    const done = await waitForRun(mount.baseUrl, started.id!, ['done']);

    // The shell phase actually ran (echo ok) and nothing mentioned preflight.
    expect(done.lastOutput?.trim()).toBe('ok');
    expect(eventsOfType(done, 'phase-start').length).toBeGreaterThan(0);
    expect(eventsOfType(done, 'run-error')).toEqual([]);
    expect(done.events[done.events.length - 1].type).toBe('run-end');
  });
});
