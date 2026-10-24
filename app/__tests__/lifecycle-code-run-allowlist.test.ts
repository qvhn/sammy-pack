/**
 * code.run in ALLOWLIST mode (SAMMY_CODE_RUN_ALLOW, no SAMMY_ALLOW_CODE_RUN)
 * plus `code.artifact`, through real runs:
 *   - a matching command runs, WITHOUT a shell: an injected `; touch …` is a
 *     literal argument, never a second command;
 *   - a command outside the allowlist fails the phase and runs nothing;
 *   - a failing step's full log is kept as a named artifact, served by
 *     GET /api/runs/:id/artifacts[?name=], scrubbed of known secrets.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getJson,
  getRun,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  startRun,
  waitFor,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

describe('lifecycle: code.run allowlist + artifacts', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;
  const saved = process.env.SAMMY_CODE_RUN_ALLOW;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    process.env.SAMMY_CODE_RUN_ALLOW = 'echo *; sh -c *';
    tmpRoot = await makeWorkspace('code-allow');
    await writeOrchestration(tmpRoot, {
      name: 'allowed-echo',
      phases: [{ name: 'say', code: { run: 'echo "${input}"' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'unquoted-echo',
      phases: [{ name: 'say', code: { run: 'echo ${input}' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'not-allowed',
      phases: [{ name: 'list', code: { run: 'ls /' } }],
    });
    await writeOrchestration(tmpRoot, {
      name: 'failing-repro',
      phases: [
        {
          name: 'repro',
          code: {
            run: "sh -c 'echo running FooTest; echo AssertionError: expected 1 got 2 >&2; echo key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ; exit 1'",
            artifact: 'repro-log',
          },
        },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'hung-step',
      phases: [
        {
          name: 'slow',
          timeout: 1,
          code: { run: "sh -c 'echo started; sleep 15'", artifact: 'slow-log' },
        },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: 'per-item',
      phases: [
        {
          name: 'each',
          map: {
            over: '["a","b"]',
            serial: true,
            body: { name: 'say', code: { run: 'echo "${item}"', artifact: 'item-log' } },
          },
        },
      ],
    });
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SAMMY_CODE_RUN_ALLOW;
    else process.env.SAMMY_CODE_RUN_ALLOW = saved;
    restoreEnv();
  });

  const settled = (id: string) =>
    waitFor(async () => {
      const r = await getRun(mount.baseUrl, id);
      return r.status === 'done' || r.status === 'error' ? r : null;
    }, 'settled', { timeoutMs: 25_000, intervalMs: 100 });

  it('runs a matching command without a shell — injected syntax stays literal', async () => {
    const marker = path.join(tmpRoot, 'PWNED');
    const id = (await startRun(mount.baseUrl, 'allowed-echo', `hi; touch ${marker}`)).id!;
    const run = await settled(id);
    expect(run.status).toBe('done');
    // (The temp path itself is redacted by the high-entropy scrubber; the
    // point is that `; touch` came back as TEXT and created nothing.)
    expect(String(run.lastOutput).trim()).toMatch(/^hi; touch \//);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('refuses a payload that would add arguments to an allowed command', async () => {
    const id = (await startRun(mount.baseUrl, 'unquoted-echo', 'hi --extra flag')).id!;
    const run = await settled(id);
    expect(run.status).toBe('error');
    expect(JSON.stringify(run.events)).toMatch(/not in SAMMY_CODE_RUN_ALLOW/);
  });

  it('kills a step at its timeout and still keeps its log', async () => {
    const t0 = Date.now();
    const id = (await startRun(mount.baseUrl, 'hung-step')).id!;
    const run = await settled(id);
    expect(run.status).toBe('error');
    // Well under the 15s the command would sleep; slack for a loaded CI box.
    expect(Date.now() - t0).toBeLessThan(12_000);
    const res = await fetch(`${mount.baseUrl}/api/runs/${id}/artifacts?name=slow-log`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('started');
    expect(text).toMatch(/\[killed: timed out/);
  });

  it('keeps one artifact per map item, each fetchable', async () => {
    const id = (await startRun(mount.baseUrl, 'per-item')).id!;
    expect((await settled(id)).status).toBe('done');
    const list = await getJson<Array<{ name: string }>>(`${mount.baseUrl}/api/runs/${id}/artifacts`);
    const names = list.map(a => a.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const n of names) {
      const r = await fetch(`${mount.baseUrl}/api/runs/${id}/artifacts?name=${encodeURIComponent(n)}`);
      expect(r.status).toBe(200);
    }
  });

  it('refuses a command outside the allowlist', async () => {
    const id = (await startRun(mount.baseUrl, 'not-allowed')).id!;
    const run = await settled(id);
    expect(run.status).toBe('error');
    expect(JSON.stringify(run.events)).toMatch(/not in SAMMY_CODE_RUN_ALLOW/);
  });

  it('keeps a failing step\'s log as a scrubbed, retrievable artifact', async () => {
    const id = (await startRun(mount.baseUrl, 'failing-repro')).id!;
    const run = await settled(id);
    expect(run.status).toBe('error');
    const list = await getJson<Array<Record<string, unknown>>>(
      `${mount.baseUrl}/api/runs/${id}/artifacts`,
    );
    expect(list).toEqual([
      expect.objectContaining({ name: 'repro-log', phaseName: 'repro', mediaType: 'text/plain', truncated: false }),
    ]);
    const res = await fetch(`${mount.baseUrl}/api/runs/${id}/artifacts?name=repro-log`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('running FooTest');
    expect(text).toContain('--- stderr ---\nAssertionError: expected 1 got 2');
    expect(text).toContain('[exit 1]');
    expect(text).not.toContain('sk-ant-api03-ZZZZ');
    expect((await fetch(`${mount.baseUrl}/api/runs/${id}/artifacts?name=nope`)).status).toBe(404);
  });
});
