/**
 * Intake-safety guards:
 *   - `switch.on` with an unresolved reference fails instead of silently
 *     taking `default`;
 *   - `registrySecretValues` returns every registry secret, unscoped;
 *   - `SAMMY_CODE_RUN_ENV` narrows a code.run child's environment.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrchestration, type RunEvent } from '../src/llm/executor';
import { registrySecretValues } from '../src/server/credentials-store';
import { codeRunChildEnv } from '../src/llm/code-run-policy';
import type { Node } from '../src/types';
import { DeliveryWorker } from '../src/server/delivery-worker';
import { checkLimits } from '../src/server/admission';

jest.setTimeout(30_000);

async function run(orchestration: Node): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: '',
    model: 'x',
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: [],
    orchestrationsOverride: [],
  } as never)) {
    events.push(ev);
  }
  return events;
}

describe('switch.on with an unresolved reference', () => {
  const orch = (on: string) =>
    ({
      name: 's',
      phases: [
        { name: 'count', code: { source: "return JSON.stringify({ count: 0 });" }, as: 'count' },
        {
          name: 'route',
          switch: {
            on,
            cases: { '0': { name: 'triage', code: { source: "return 'triage'" } } },
            default: { name: 'bump', code: { source: "return 'bump'" } },
          },
        },
      ],
    }) as unknown as Node;

  it('fails when the base names nothing, instead of taking default', async () => {
    const events = await run(orch('${cuont.count}')).catch(e => [{ type: 'thrown', error: String(e) }] as never);
    const text = JSON.stringify(events);
    expect(text).toMatch(/\$\{cuont\.count\} name nothing/);
    expect(text).not.toMatch(/"phaseName":"bump"/);
  });

  it('takes default — visibly — when only the field is missing', async () => {
    const events = await run(orch('${count.total}'));
    expect(events.some(e => e.type === 'phase-end' && (e as { phaseName: string }).phaseName === 'bump')).toBe(true);
    expect(events.some(e => e.type === 'route-decision' && (e as { unresolved?: string[] }).unresolved?.length)).toBe(true);
    expect(events.some(e => e.type === 'interpolation-unresolved')).toBe(false); // not a degradation
  });

  it('still routes on a resolved value', async () => {
    const events = await run(orch('${count.count}'));
    expect(events.some(e => e.type === 'phase-end' && (e as { phaseName: string }).phaseName === 'triage')).toBe(true);
  });
});

describe('registrySecretValues', () => {
  it('returns every secret-bearing value regardless of owner / orchestration scope', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-reg-'));
    const file = path.join(dir, 'credentials.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        mine: { value: 'value-one-123', owners: ['alice'] },
        theirs: { value: 'value-two-456', orchestrations: ['other'] },
        mcp: { kind: 'mcp-server', env: { API_TOKEN: 'env-secret-789' } },
        withFields: { kind: 'jira', value: 'tok-000000', fields: { email: 'bot@example.test', apiSecret: 'field-secret-1' } },
      }),
    );
    const v = registrySecretValues(file);
    expect(v).toEqual(
      expect.arrayContaining(['value-one-123', 'value-two-456', 'env-secret-789', 'tok-000000', 'field-secret-1']),
    );
    expect(v).not.toContain('bot@example.test');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('codeRunChildEnv', () => {
  const env = { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 'x', MY_TOOL_OPT: 'y' };
  it('inherits everything when SAMMY_CODE_RUN_ENV is unset (historical behavior)', () => {
    expect(codeRunChildEnv({ SAMMY_WORKTREE_A: '/w' }, env)).toEqual({ ...env, SAMMY_WORKTREE_A: '/w' });
  });
  it('passes only the base set + listed names when it is set', () => {
    const out = codeRunChildEnv({ SAMMY_WORKTREE_A: '/w' }, { ...env, SAMMY_CODE_RUN_ENV: 'MY_TOOL_OPT' });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', MY_TOOL_OPT: 'y', SAMMY_WORKTREE_A: '/w' });
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe('older RunStore implementations (no holdDelivery / orchestrationUsage)', () => {
  it('a hold falls back to a retry at `until`, and limits admit with a warning', async () => {
    const failDelivery = jest.fn(async () => true);
    const store = {
      claimNextDelivery: jest.fn()
        .mockResolvedValueOnce({ id: 'd1', claimToken: 1, attempts: 1 })
        .mockResolvedValue(null),
      failDelivery,
    } as never;
    const worker = new DeliveryWorker({
      store,
      now: () => 100,
      runDelivery: async () => ({ ok: false, hold: true, until: 5_000, detail: 'paused' }),
    });
    await worker.processOne();
    expect(failDelivery).toHaveBeenCalledWith('d1', expect.objectContaining({ retryAt: 5_000 }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkLimits({} as never, 'o', { maxRunsPerDay: 1 }, Date.now())).toEqual({ action: 'admit' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT enforced/));
    warn.mockRestore();
  });
});
