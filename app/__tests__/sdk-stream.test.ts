/**
 * streamSdk's SDK seam — the options it hands the SDK and the usage it
 * stamps on the errors it throws — driven through an injected `queryFn`.
 *
 * The real entry point is a dynamic import this jest config cannot execute,
 * and `jest.mock` of the SDK package does not intercept a native dynamic
 * import, so every other suite mocks `streamSdk` itself. That left this layer
 * with zero executable coverage: the `tools` forwarding that makes
 * SAMMY_LLM_STREAM_TOOLS=off text-only, and the `withUsage` stamping the
 * executor's spend accounting consumes, were both pinned only by text — an
 * inverted condition on the one and a neutered helper on the other shipped
 * green. These assert what the SDK receives and what the caller catches.
 */

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { TerminalPhaseError } from '../src/llm/terminal-failure';
import {
  AgentTokenCeilingError,
  streamSdk,
  ToolPermissionRequiredError,
  type SdkQueryFn,
  type SdkStreamChunk,
  type SdkStreamParams,
} from '../src/server/sdk-stream';
import { runOfProcess } from '../src/server/run-process-registry';

type QueryParams = Parameters<SdkQueryFn>[0];
/** Messages as plain records — the shapes streamSdk reads, nothing more. */
type SdkMsg = Record<string, unknown>;

/** A stand-in for the SDK: records the params it was called with, then
 *  replays `messages` (or whatever `messages(params)` produces). */
function fakeQuery(
  messages: SdkMsg[] | ((p: QueryParams) => Promise<SdkMsg[]>),
): { calls: QueryParams[]; queryFn: SdkQueryFn } {
  const calls: QueryParams[] = [];
  const queryFn = ((p: QueryParams) => {
    calls.push(p);
    return (async function* () {
      const list = typeof messages === 'function' ? await messages(p) : messages;
      for (const m of list) yield m;
    })();
  }) as unknown as SdkQueryFn;
  return { calls, queryFn };
}

async function drain(
  params: Partial<SdkStreamParams> & { queryFn: SdkQueryFn },
): Promise<SdkStreamChunk[]> {
  const out: SdkStreamChunk[] = [];
  for await (const chunk of streamSdk({
    userMessage: 'hi',
    model: 'claude-sonnet-4-6',
    abortController: new AbortController(),
    ...params,
  })) {
    out.push(chunk);
  }
  return out;
}

const turn = (input_tokens: number, output_tokens = 0): SdkMsg => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { usage: { input_tokens, output_tokens } } },
});
const result = (extra: SdkMsg = {}): SdkMsg => ({ type: 'result', subtype: 'success', ...extra });

const usageOf = (err: unknown): unknown => (err as { usage?: unknown }).usage;

async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (err) {
    return err;
  }
  throw new Error('expected streamSdk to throw');
}

describe('streamSdk → SDK options', () => {
  it('builtinTools: [] reaches the SDK as `tools: []` — every built-in disabled', async () => {
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, builtinTools: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.tools).toEqual([]);
  });

  it("builtinTools: ['Read'] pins the base set to exactly that", async () => {
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, builtinTools: ['Read'], tools: ['Read'] });
    expect(calls[0].options?.tools).toEqual(['Read']);
  });

  it('builtinTools undefined leaves the key ABSENT — the SDK keeps its default preset', async () => {
    // The orchestration path relies on the default preset; `tools: undefined`
    // would be an explicit value, not an omission.
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, tools: ['Bash'] });
    expect(calls[0].options !== undefined && 'tools' in calls[0].options).toBe(false);
  });

  it('allowedTools is the pre-approval union of `tools` and `autoApproveTools`', async () => {
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, tools: ['Bash', 'Read'], autoApproveTools: ['mcp__jira', 'Read'] });
    expect([...(calls[0].options?.allowedTools ?? [])].sort()).toEqual(
      ['Bash', 'Read', 'mcp__jira'].sort(),
    );
  });

  it('an explicit permissionMode is forwarded as given; omitted with tools present defaults to bypass', async () => {
    const explicit = fakeQuery([result()]);
    await drain({ queryFn: explicit.queryFn, tools: ['Bash'], permissionMode: 'default' });
    expect(explicit.calls[0].options?.permissionMode).toBe('default');
    const omitted = fakeQuery([result()]);
    await drain({ queryFn: omitted.queryFn, tools: ['Bash'] });
    expect(omitted.calls[0].options?.permissionMode).toBe('bypassPermissions');
  });
});

describe('streamSdk stamps its usage on every error it throws', () => {
  it('a successful turn yields `done` with the ledger totals', async () => {
    const { queryFn } = fakeQuery([
      turn(100, 20),
      turn(300, 40),
      result({ usage: { input_tokens: 400, output_tokens: 60 } }),
    ]);
    const chunks = await drain({ queryFn });
    expect(chunks[chunks.length - 1]).toEqual({
      type: 'done',
      usage: { inputTokens: 400, outputTokens: 60 },
    });
  });

  it('the per-agent ceiling throw carries what the agent had spent', async () => {
    const { queryFn } = fakeQuery([turn(500), result()]);
    const err = await thrownBy(drain({ queryFn, maxAgentTokens: 100 }));
    expect(err).toBeInstanceOf(AgentTokenCeilingError);
    expect(usageOf(err)).toEqual({ inputTokens: 500, outputTokens: 0 });
  });

  it('a non-success result throws with the larger of the accumulated and reported totals', async () => {
    // `done` never follows a throw, so the thrower is the only party that
    // knows what the dead turn spent — the executor charges exactly this.
    const { queryFn } = fakeQuery([
      turn(1_000),
      result({
        subtype: 'error_during_execution',
        terminal_reason: 'api_error',
        usage: { input_tokens: 1_200, output_tokens: 300 },
      }),
    ]);
    const err = await thrownBy(drain({ queryFn }));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/api_error/);
    expect(usageOf(err)).toEqual({ inputTokens: 1_200, outputTokens: 300 });
  });

  it('a max-turns result throws the pause-point error, with usage', async () => {
    const { queryFn } = fakeQuery([turn(10, 5), result({ subtype: 'error_max_turns' })]);
    const err = await thrownBy(drain({ queryFn }));
    expect((err as Error).message).toBe('Reached maximum number of turns');
    expect(usageOf(err)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('a terminal verdict (a refusal) throws TerminalPhaseError, with usage', async () => {
    const { queryFn } = fakeQuery([
      turn(10, 5),
      result({ subtype: 'error_during_execution', stop_reason: 'refusal' }),
    ]);
    const err = await thrownBy(drain({ queryFn }));
    expect(err).toBeInstanceOf(TerminalPhaseError);
    expect(usageOf(err)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('a headless tool block throws ToolPermissionRequiredError after the loop, with usage', async () => {
    // The fake SDK asks canUseTool for a tool nobody pre-approved: denied
    // with interrupt, the loop ends, and the block surfaces as the error.
    let decision: PermissionResult | null = null;
    const { queryFn } = fakeQuery(async p => {
      decision = await p.options!.canUseTool!('Bash', {}, {
        signal: new AbortController().signal,
        toolUseID: 'tu-1',
      });
      return [turn(10, 5), result()];
    });
    const err = await thrownBy(drain({ queryFn, failOnToolPrompt: true, tools: ['Read'] }));
    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(err).toBeInstanceOf(ToolPermissionRequiredError);
    expect((err as ToolPermissionRequiredError).toolName).toBe('Bash');
    expect(usageOf(err)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('MCP servers an agent can reach', () => {
  const saved = process.env.SAMMY_AGENT_AMBIENT_MCP;
  afterEach(() => {
    if (saved === undefined) delete process.env.SAMMY_AGENT_AMBIENT_MCP;
    else process.env.SAMMY_AGENT_AMBIENT_MCP = saved;
  });

  test('only the declared ones by default — the host configuration is not inherited', async () => {
    delete process.env.SAMMY_AGENT_AMBIENT_MCP;
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, mcpServers: { tracker: { command: 'tracker-mcp' } } as SdkStreamParams['mcpServers'] });
    expect(calls[0].options?.strictMcpConfig).toBe(true);
    expect(Object.keys(calls[0].options?.mcpServers ?? {})).toEqual(['tracker']);
  });

  test('SAMMY_AGENT_AMBIENT_MCP=1 restores the inheritance', async () => {
    process.env.SAMMY_AGENT_AMBIENT_MCP = '1';
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn });
    expect(calls[0].options?.strictMcpConfig).toBeUndefined();
  });
});

describe('agent process ownership', () => {
  test('a call carrying SAMMY_RUN_ID spawns through the ownership hook — registered, then forgotten on exit', async () => {
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn, env: { SAMMY_RUN_ID: 'run-x' } });
    const spawnHook = calls[0].options?.spawnClaudeCodeProcess;
    expect(typeof spawnHook).toBe('function');
    // Drive the hook the way the SDK does, with a real short-lived process.
    const child = spawnHook!({
      command: 'sleep',
      args: ['0.2'],
      env: { ...process.env, SAMMY_RUN_ID: 'run-x' },
      signal: new AbortController().signal,
    }) as unknown as import('node:child_process').ChildProcess;
    expect(runOfProcess(child.pid!)).toBe('run-x');
    await new Promise(r => child.once('exit', r));
    await new Promise(r => setImmediate(r));
    expect(runOfProcess(child.pid!)).toBeUndefined();
  });

  test('a call without a run id keeps the SDK default spawn', async () => {
    const { calls, queryFn } = fakeQuery([result()]);
    await drain({ queryFn });
    expect(calls[0].options?.spawnClaudeCodeProcess).toBeUndefined();
  });
});
