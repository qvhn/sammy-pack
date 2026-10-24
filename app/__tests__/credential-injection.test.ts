/**
 * Integration test for the per-phase credential ENV injection +
 * cross-phase secret scrubbing in the executor. Proves the security
 * invariant at the executor boundary:
 *   - a phase's `credential` is projected onto subprocess env vars and
 *     passed to streamFn's `env` param ONLY (never into system/messages),
 *   - an injected secret echoed into a phase's output is redacted before
 *     it's piped as the next phase's input (model-context surface), and
 *   - the secret is recorded in the run's injectedSecrets sink.
 */

import { runOrchestration, type StreamFn, type RunEvent } from '../src/llm/executor';
import type { Credential } from '../src/server/credentials-store';
import type { Node } from '../src/types';

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'a', raw: '---\nname: a\n---\nAgent A. Input: ${input}' },
    { name: 'b', raw: '---\nname: b\n---\nAgent B.' },
  ],
  listOrchestrations: async () => [],
}));

const JIRA: Credential = {
  kind: 'jira',
  value: 'ATATT-supersecret-token-value-123',
  fields: { email: 'bot@example.com', siteUrl: 'https://team.atlassian.net' },
};

type CapturedCall = {
  system?: string;
  user: string;
  env?: Record<string, string>;
};

/** A streamFn that records what it was called with and echoes the
 *  injected token back into its text output (simulating an agent that
 *  prints `$JIRA_API_TOKEN`). */
function makeCapturingStreamFn(calls: CapturedCall[]): StreamFn {
  return async function* (params) {
    calls.push({
      system: params.system,
      user: params.messages[0]?.content ?? '',
      env: params.env,
    });
    // Echo the secret from the injected env back into output — the leak we
    // must scrub. On the first call only (the credential-bearing phase).
    const token = params.env?.JIRA_API_TOKEN;
    const text = token ? `done; token was ${token}` : 'second-phase-output';
    yield { type: 'text-delta', text };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

async function run(
  orchestration: Node,
  extra: {
    streamFn: StreamFn;
    credentialsRaw?: Record<string, Credential>;
    injectedSecrets?: Set<string>;
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
    injectedSecrets: extra.injectedSecrets,
  })) {
    events.push(ev);
  }
  return events;
}

describe('per-phase credential env injection', () => {
  it('injects the kind-mapped env vars into streamFn for a phase with `credential`', async () => {
    const calls: CapturedCall[] = [];
    await run(
      {
        name: 'flow',
        phases: [{ name: 'p', agent: 'agents/a.md', credential: 'jira' }],
      },
      { streamFn: makeCapturingStreamFn(calls), credentialsRaw: { jira: JIRA } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].env).toEqual({
      JIRA_API_TOKEN: 'ATATT-supersecret-token-value-123',
      JIRA_EMAIL: 'bot@example.com',
      JIRA_BASE_URL: 'https://team.atlassian.net',
    });
  });

  it('NEVER puts the secret into the system prompt or the user message', async () => {
    const calls: CapturedCall[] = [];
    await run(
      {
        name: 'flow',
        phases: [{ name: 'p', agent: 'agents/a.md', credential: 'jira' }],
      },
      { streamFn: makeCapturingStreamFn(calls), credentialsRaw: { jira: JIRA } },
    );
    expect(calls[0].system ?? '').not.toContain(JIRA.value);
    expect(calls[0].user).not.toContain(JIRA.value);
  });

  it('supports a `credentials` array (merged env)', async () => {
    const calls: CapturedCall[] = [];
    const gh: Credential = { kind: 'github', value: 'ghp_merged_token_value' };
    await run(
      {
        name: 'flow',
        phases: [
          {
            name: 'p',
            agent: 'agents/a.md',
            credentials: ['jira', 'gh'],
          },
        ],
      },
      {
        streamFn: makeCapturingStreamFn(calls),
        credentialsRaw: { jira: JIRA, gh },
      },
    );
    expect(calls[0].env).toMatchObject({
      JIRA_API_TOKEN: JIRA.value,
      GITHUB_TOKEN: 'ghp_merged_token_value',
    });
  });

  it('does NOT inject env for a phase without a credential', async () => {
    const calls: CapturedCall[] = [];
    await run(
      { name: 'flow', phases: [{ name: 'p', agent: 'agents/a.md' }] },
      { streamFn: makeCapturingStreamFn(calls), credentialsRaw: { jira: JIRA } },
    );
    expect(calls[0].env).toBeUndefined();
  });

  it('records injected secrets and SCRUBS an echoed secret from the piped next-phase input + phase-end output', async () => {
    const calls: CapturedCall[] = [];
    const injectedSecrets = new Set<string>();
    const events = await run(
      {
        name: 'flow',
        phases: [
          { name: 'p1', agent: 'agents/a.md', credential: 'jira' },
          { name: 'p2', agent: 'agents/b.md' },
        ],
      },
      {
        streamFn: makeCapturingStreamFn(calls),
        credentialsRaw: { jira: JIRA },
        injectedSecrets,
      },
    );
    // The secret was recorded for run-wide scrubbing.
    expect(injectedSecrets.has(JIRA.value)).toBe(true);
    // p1 echoed the token in its output; that output is PIPED to p2. The
    // second streamFn call's user message must NOT contain the raw secret.
    expect(calls).toHaveLength(2);
    expect(calls[1].user).not.toContain(JIRA.value);
    expect(calls[1].user).toContain('[REDACTED]');
    // The phase-end output event for p1 must also be redacted.
    const p1End = events.find(
      e => e.type === 'phase-end' && (e as { phaseName?: string }).phaseName === 'p1',
    ) as { output?: string } | undefined;
    expect(p1End?.output).toBeDefined();
    expect(p1End?.output).not.toContain(JIRA.value);
    expect(p1End?.output).toContain('[REDACTED]');
  });
});
