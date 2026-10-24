/**
 * A sandbox-denied Bash command, when the stream adapter can refuse it
 * (the server SDK path's PreToolUse hook): the ONE call is refused and the
 * phase carries on — recorded as a `sandbox-refused:` tools-warning — instead
 * of the whole phase failing after the fact. Without enforcement upstream
 * the executor's backstop still fails the phase (unchanged).
 */
import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { AgentFile } from '../src/api';
import type { Node } from '../src/types';

const AGENTS: AgentFile[] = [{ name: 'a', raw: '---\nname: a\n---\nAgent A.' }];

const flow: Node = {
  name: 'flow',
  phases: [{ name: 'work', agent: 'agents/a.md', tools: ['Bash'], sandbox: { deniedCommands: ['git reset --hard'] } }],
};

/** The agent tries a denied command, is refused, then finishes another way. */
let seen: { deniedCommands?: string[] } = {};
const stream: StreamFn = async function* (params) {
  seen = { deniedCommands: params.deniedCommands };
  yield { type: 'tool-use', name: 'Bash', toolUseId: 't1', input: { command: 'git reset --hard' } };
  yield { type: 'text-delta', text: 'used git restore instead' };
  yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
};

async function run(enforcesDeniedCommands: boolean): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration: flow,
    apiKey: 'k',
    model: 'claude-opus-4-7',
    streamFn: stream,
    allowAgentTools: true,
    enforcesDeniedCommands,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

test('the adapter receives the deny list', async () => {
  await run(true);
  expect(seen.deniedCommands).toEqual(['git reset --hard']);
});

test('enforced upstream: the call is refused, the phase completes', async () => {
  const events = await run(true);
  expect(events.some(e => e.type === 'tools-warning' && e.missing.includes('sandbox-refused:git reset --hard'))).toBe(true);
  const end = events.find(e => e.type === 'phase-end' && e.phaseName === 'work');
  expect(end?.type === 'phase-end' && end.output).toContain('used git restore instead');
  expect(events.some(e => e.type === 'run-error')).toBe(false);
});

test('not enforced upstream: the backstop still fails the phase', async () => {
  const events = await run(false);
  expect(events.some(e => e.type === 'phase-error' && /sandbox blocked a Bash command/.test(e.error))).toBe(true);
});
