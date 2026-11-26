/**
 * Where an agent step works when its run has no worktree: the run's own
 * empty folder (`scratchCwd`), never the server's — and the worktree when
 * the run has one.
 */
import { runOrchestration, type StreamFn } from '../src/llm/executor';
import type { Node } from '../src/types';

type Params = Parameters<StreamFn>[0];

async function cwdsOf(extra: Partial<Parameters<typeof runOrchestration>[0]>): Promise<Array<string | undefined>> {
  const calls: Params[] = [];
  const streamFn: StreamFn = params => {
    calls.push(params);
    return (async function* () {
      yield { type: 'text-delta' as const, text: 'ok' };
      yield { type: 'done' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    })();
  };
  const orchestration = { name: 'two', phases: [{ name: 'a', agent: 'agents/w.md' }, { name: 'b', agent: 'agents/w.md' }] } as unknown as Node;
  for await (const _ of runOrchestration({
    orchestration,
    apiKey: '',
    model: 'claude-sonnet-4-6',
    streamFn,
    initialInput: 'go',
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: [{ name: 'w', raw: '---\nname: w\n---\nDo it.' }],
    orchestrationsOverride: [],
    ...extra,
  })) {
    void _;
  }
  return calls.map(c => (c as { cwd?: string }).cwd);
}

test('agent steps without a worktree work in the run folder', async () => {
  expect(await cwdsOf({ scratchCwd: '/tmp/run-1', harnessCwd: '/ws' })).toEqual(['/tmp/run-1', '/tmp/run-1']);
});

test('a worktree wins over the run folder', async () => {
  const wt = [{ name: 'repo', path: '/w/repo', branch: 'sammy/x-repo', base: 'abc', repo: '/r' }];
  expect(await cwdsOf({ scratchCwd: '/tmp/run-1', worktrees: wt })).toEqual(['/w/repo', '/w/repo']);
});

test('without either, agent steps inherit the host folder as before', async () => {
  expect(await cwdsOf({})).toEqual([undefined, undefined]);
});
