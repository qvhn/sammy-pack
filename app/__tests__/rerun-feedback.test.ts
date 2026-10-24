/**
 * Unit coverage for the rerun-feedback engine seams:
 *
 *   - PHASE_TURN_CONTRACT reaches every phase agent's system prompt
 *   - string `pattern` output contracts fail partial narratives fast
 *   - externalKillSignal classifies SIGTERM/SIGKILL exits (and nothing else)
 *   - TimeoutError names the node and calls out a defaulted cap
 *
 * (Resume-from-error + the interrupted classification run on the real
 * stack in lifecycle-resume-error.test.ts.)
 */

import {
  runOrchestration,
  PHASE_TURN_CONTRACT,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import { externalKillSignal } from '../src/llm/terminal-failure';
import { checkContract } from '../src/lib/json-schema-check';
import type { Node } from '../src/types';

const AGENTS = [{ name: 'a', raw: '---\nname: a\n---\nAgent A body.' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function collect(
  orchestration: Node,
  streamFn: StreamFn,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

describe('1a — the framework turn-contract reaches every phase agent', () => {
  test('system prompt = agent body + PHASE_TURN_CONTRACT', async () => {
    let seenSystem = '';
    const streamFn: StreamFn = async function* (params) {
      seenSystem = params.system ?? '';
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await collect(
      { name: 'flow', phases: [{ name: 'p', agent: 'agents/a.md' }] },
      streamFn,
    );
    expect(seenSystem).toContain('Agent A body.');
    expect(seenSystem).toContain('[sammy-pack phase contract]');
    expect(seenSystem).toContain(PHASE_TURN_CONTRACT);
    // The agent's own instructions come FIRST; the contract is appended.
    expect(seenSystem.indexOf('Agent A body.')).toBeLessThan(
      seenSystem.indexOf('[sammy-pack phase contract]'),
    );
  });
});

describe('1b — narrative output contracts via string `pattern`', () => {
  const contract = { type: 'string', pattern: '## Converged board' };

  test('a complete deliverable passes; a partial fails with the pattern named', () => {
    const good = checkContract(
      contract,
      'Long analysis…\n\n## Converged board\n| pass | fail |',
    );
    expect(good).toMatchObject({ enforce: true, ok: true });

    const partial = checkContract(
      contract,
      "Pass 1 in flight — I'll poll in 2 minutes.",
    );
    expect(partial).toMatchObject({ enforce: true, ok: false });
    expect((partial as { reason: string }).reason).toContain(
      '## Converged board',
    );
  });

  test('a malformed pattern fails loudly instead of passing everything', () => {
    const out = checkContract(
      { type: 'string', pattern: '([unclosed' },
      'anything',
    );
    expect(out).toMatchObject({ enforce: true, ok: false });
    expect((out as { reason: string }).reason).toContain('not a valid regex');
  });
});

describe('3 — externalKillSignal classification', () => {
  test('SIGTERM/SIGKILL exit codes and named signals classify; crashes do not', () => {
    expect(
      externalKillSignal('Claude Code process exited with code 143'),
    ).toBe('SIGTERM');
    expect(externalKillSignal('script exited with code 137')).toBe('SIGKILL');
    expect(externalKillSignal('child killed by SIGTERM')).toBe('SIGTERM');
    // Crashes and ordinary failures are NOT external kills.
    expect(externalKillSignal('process exited with code 139')).toBeNull(); // SIGSEGV
    expect(externalKillSignal('exited with code 1')).toBeNull();
    expect(externalKillSignal('Error: request timed out')).toBeNull();
  });
});

describe('4 — TimeoutError provenance', () => {
  const prevDefault = process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC;
  afterEach(() => {
    if (prevDefault === undefined) delete process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC;
    else process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC = prevDefault;
  });

  const slowStream: StreamFn = async function* () {
    yield { type: 'text-delta', text: 'working…' };
    await sleep(2_000);
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };

  test('a DEFAULTED cap names the node, says it was the default, and how to raise it', async () => {
    process.env.SAMMY_DEFAULT_NODE_TIMEOUT_SEC = '1';
    const events = await collect(
      // No `timeout` anywhere — the env-tuned default is the cap. Generous
      // stallTimeout so the hard cap, not the watchdog, is what fires.
      { name: 'flow', phases: [{ name: 'digger', agent: 'agents/a.md', stallTimeout: 30 }] },
      slowStream,
    );
    const err = events.find(e => e.type === 'run-error') as
      | { error: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.error).toContain('"digger"');
    expect(err!.error).toContain('DEFAULT phase timeout');
    expect(err!.error).toContain('defaults.timeout');
  }, 15000);

  test('an author-chosen cap does NOT claim to be a default', async () => {
    const events = await collect(
      { name: 'flow', phases: [{ name: 'digger', agent: 'agents/a.md', timeout: 1, stallTimeout: 30 }] },
      slowStream,
    );
    const err = events.find(e => e.type === 'run-error') as
      | { error: string }
      | undefined;
    expect(err).toBeDefined();
    expect(err!.error).toContain('"digger"');
    expect(err!.error).not.toContain('DEFAULT phase timeout');
  }, 15000);
});
