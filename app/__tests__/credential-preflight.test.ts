/**
 * Run-start preflight for declared credentials. A node that declares a
 * `credential` / `credentials[]` not present in the run's resolved
 * credentials registry must fail FAST at run start — naming the missing
 * credential AND its owning node — instead of failing deep when the node
 * dispatches (env injection silently no-ops, then the external service dies
 * confusingly downstream). The same orchestration WITH the credential
 * supplied must proceed past preflight into the phase.
 */

import { runOrchestration, type StreamFn, type RunEvent } from '../src/llm/executor';
import type { Credential } from '../src/server/credentials-store';
import type { Node } from '../src/types';

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'a', raw: '---\nname: a\n---\nAgent A.' },
    { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
  ],
  listOrchestrations: async () => [],
}));

const JIRA: Credential = {
  kind: 'jira',
  value: 'ATATT-secret',
  fields: { email: 'bot@example.com', siteUrl: 'https://team.atlassian.net' },
};

/** A streamFn that records that it ran — used to prove the phase was (not)
 *  reached. */
function makeStreamFn(calls: { user: string }[]): StreamFn {
  return async function* (params) {
    calls.push({ user: params.messages[0]?.content ?? '' });
    yield { type: 'text-delta', text: 'ok' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

async function run(
  orchestration: Node,
  extra: {
    streamFn: StreamFn;
    credentialsRaw?: Record<string, Credential>;
    credentialsByName?: Record<string, string>;
  },
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: '',
    model: 'claude-sonnet-4-6',
    waitForApproval: async () => true,
    cancelled: { v: false },
    streamFn: extra.streamFn,
    credentialsRaw: extra.credentialsRaw,
    credentialsByName: extra.credentialsByName,
  })) {
    events.push(ev);
  }
  return events;
}

describe('credential preflight', () => {
  const orchestration: Node = {
    name: 'flow',
    phases: [{ name: 'p', agent: 'agents/a.md', credential: 'jira' }],
  };

  it('fails fast at preflight when a declared credential is missing from the registry (and never starts the phase)', async () => {
    const calls: { user: string }[] = [];
    // Registry supplied but EMPTY — `jira` is genuinely missing.
    const events = await run(orchestration, {
      streamFn: makeStreamFn(calls),
      credentialsRaw: {},
    });

    const runError = events.find(e => e.type === 'run-error') as
      | { error?: string }
      | undefined;
    expect(runError).toBeDefined();
    expect(runError?.error).toContain('Run halted at preflight');
    // Names both the credential and the owning node.
    expect(runError?.error).toContain('"jira"');
    expect(runError?.error).toContain('"p"');
    // The phase never started — no agent dispatch, no phase-start event.
    expect(calls).toHaveLength(0);
    expect(events.some(e => e.type === 'phase-start')).toBe(false);
  });

  it('names EVERY missing credential when several are absent', async () => {
    const calls: { user: string }[] = [];
    const multi: Node = {
      name: 'flow',
      phases: [
        { name: 'p1', agent: 'agents/a.md', credential: 'jira' },
        { name: 'p2', agent: 'agents/b.md', credentials: ['github', 'slack'] },
      ],
    };
    const events = await run(multi, {
      streamFn: makeStreamFn(calls),
      credentialsRaw: {},
    });
    const runError = events.find(e => e.type === 'run-error') as
      | { error?: string }
      | undefined;
    expect(runError?.error).toContain('"jira"');
    expect(runError?.error).toContain('"github"');
    expect(runError?.error).toContain('"slack"');
    expect(calls).toHaveLength(0);
  });

  it('proceeds past preflight when the declared credential IS provided', async () => {
    const calls: { user: string }[] = [];
    const events = await run(orchestration, {
      streamFn: makeStreamFn(calls),
      credentialsRaw: { jira: JIRA },
    });
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'phase-start')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('treats a credential present in credentialsByName (provider routing) as available', async () => {
    const calls: { user: string }[] = [];
    // Only the name→value map is populated (no raw entry). Should NOT fire.
    const events = await run(orchestration, {
      streamFn: makeStreamFn(calls),
      credentialsByName: { jira: 'ATATT-secret' },
    });
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'phase-start')).toBe(true);
  });

  it('does NOT false-positive when NO registry is supplied (anonymous / CLI run)', async () => {
    const calls: { user: string }[] = [];
    // Neither credentialsRaw nor credentialsByName passed — can't tell
    // "configured with nothing" from "resolved elsewhere", so no-op.
    const events = await run(orchestration, { streamFn: makeStreamFn(calls) });
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    expect(events.some(e => e.type === 'phase-start')).toBe(true);
  });

  it('catches a credential declared inside a nested composite (switch case)', async () => {
    const calls: { user: string }[] = [];
    const nested: Node = {
      name: 'flow',
      phases: [
        {
          name: 'router',
          switch: {
            on: '${x}',
            cases: {
              go: { name: 'deep', agent: 'agents/a.md', credential: 'jira' },
            },
          },
        },
      ],
    };
    const events = await run(nested, {
      streamFn: makeStreamFn(calls),
      credentialsRaw: {},
    });
    const runError = events.find(e => e.type === 'run-error') as
      | { error?: string }
      | undefined;
    expect(runError?.error).toContain('Run halted at preflight');
    expect(runError?.error).toContain('"deep"');
    expect(runError?.error).toContain('"jira"');
  });
});
