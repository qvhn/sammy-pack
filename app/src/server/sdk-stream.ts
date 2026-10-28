/**
 * Server-side Claude Agent SDK invocation, factored out of the
 * /api/llm/stream HTTP handler so the same call path can be reused by
 * the server-owned run executor (Slice 2 of durable execution) without
 * making an HTTP round-trip to itself.
 *
 * Caller pre-expands MCP server names → configs and hook names →
 * grouped callbacks. This module is intentionally side-effect-free WRT
 * the workspace filesystem — registry lookups stay in the request
 * handler that has the context to read them.
 */

import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  query as sdkQuery,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { forgetProcess, registerRunProcess } from './run-process-registry';
import { classifySdkResult, TerminalPhaseError } from '../llm/terminal-failure';
import {
  CACHE_READ_WEIGHT,
  ceilingVerdict,
  formatCeilingShape,
  TokenLedger,
  type TokenCeilingDiagnostics,
  type TurnUsage,
} from './token-ledger';

// The spend-accounting vocabulary is re-exported here because this module
// is the circuit-breaker's public face (callers already import
// AgentTokenCeilingError from it).
export {
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  OUTPUT_WEIGHT,
  TokenLedger,
} from './token-ledger';
export type { TokenCeilingDiagnostics, TurnUsage } from './token-ledger';

export type SdkSubagentSpec = {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
};

/** The SDK's `query` entry point — the shape an injected stand-in must have. */
export type SdkQueryFn = typeof sdkQuery;

/** Thrown by streamSdk when a single agent loop's cumulative token spend
 *  exceeds its per-agent ceiling (the circuit-breaker). DISTINCT from a
 *  shared-AbortController cancel on purpose: a real user/run cancel aborts
 *  the run-wide signal (killing every leaf), whereas a runaway leaf must
 *  only stop ITSELF and surface as an ordinary per-leaf failure that the
 *  executor's retry / onError / continueOnError handling can swallow.
 *
 *  We throw out of streamSdk's `for await` rather than abort()-ing the
 *  shared controller: throwing calls `.return()` on the underlying SDK
 *  query iterator (stopping the runaway leaf immediately — it can't keep
 *  burning tokens), but leaves the shared AbortController un-aborted so
 *  downstream phases run normally. This mirrors how a per-phase timeout
 *  fails soft (TimeoutError + iterator .return()) instead of poisoning the
 *  run-wide signal the way a genuine cancel does. */
export class AgentTokenCeilingError extends Error {
  /** Cost-weighted ("input-equivalent") tokens spent when it tripped. */
  spentTokens: number;
  /** The ceiling that was exceeded. */
  ceiling: number;
  /** Loop shape at trip time; absent only for legacy constructions. */
  diagnostics?: TokenCeilingDiagnostics;
  constructor(
    spentTokens: number,
    ceiling: number,
    diagnostics?: TokenCeilingDiagnostics,
  ) {
    const d = diagnostics;
    const shape = d
      ? ` [turns=${d.turns}, elapsed=${Math.round(d.elapsedMs / 60_000)}min, ` +
        `context ${Math.round(d.firstPromptTokens / 1000)}k→` +
        `${Math.round(d.lastPromptTokens / 1000)}k, compactions=${d.compactions}, ` +
        `raw=${Math.round(d.rawTokens / 1000)}k]`
      : '';
    const advice =
      d && !d.contextGrew
        ? ' Context stayed FLAT — long legitimate work, not a runaway: raise ' +
          '`maxAgentTokens` on this phase (or `defaults.maxAgentTokens` / ' +
          'SAMMY_MAX_AGENT_TOKENS) rather than changing the agent.'
        : ' Context GREW across turns — runaway accumulation (e.g. re-sending a ' +
          'growing image/a11y context, or fat tool outputs piling up). Shrink ' +
          'tool outputs, poll less often, lower maxTurns, or raise ' +
          '`maxAgentTokens` for this phase.';
    super(
      `agent exceeded per-agent token ceiling: ~${Math.round(spentTokens / 1000)}k ` +
        `input-equivalent tokens (ceiling ${Math.round(ceiling / 1000)}k; cache ` +
        `reads weighted ${CACHE_READ_WEIGHT}×).${shape}${advice}`,
    );
    this.name = 'AgentTokenCeilingError';
    this.spentTokens = spentTokens;
    this.ceiling = ceiling;
    this.diagnostics = diagnostics;
  }
}

/** Thrown by streamSdk (only when `failOnToolPrompt` is set — the headless
 *  path) when the agent tries to use a tool that requires a human permission
 *  "Allow" that no one is present to give. In a headless server run that prompt
 *  can NEVER be answered, so the SDK would otherwise stall the phase forever
 *  with no output and no signal. We deny the tool and throw this instead, so the
 *  executor can emit a loud `awaiting-approval` event and fail the phase FAST
 *  (routed through the normal per-leaf retry / onError / continueOnError
 *  handling, exactly like {@link AgentTokenCeilingError}). Pre-approve the tool
 *  (node `autoApproveTools` / `SAMMY_ALLOWED_MCP_TOOLS`) to let it run. */
export class ToolPermissionRequiredError extends Error {
  /** The tool the agent tried to use that needed approval. */
  toolName: string;
  constructor(toolName: string) {
    super(
      `tool "${toolName}" needs permission to run, but this is a headless run ` +
        `with no human to approve it — the phase would stall forever. Pre-approve ` +
        `it via the phase's \`autoApproveTools\` or the SAMMY_ALLOWED_MCP_TOOLS ` +
        `env, or run it attended.`,
    );
    this.name = 'ToolPermissionRequiredError';
    this.toolName = toolName;
  }
}

/** Would `toolName` be allowed WITHOUT a permission prompt, given the merged
 *  pre-approval allowlist? A match is either an exact tool id, or an entry that
 *  names a whole MCP server (`mcp__<server>`) which covers every
 *  `mcp__<server>__<tool>` under it. Pure + exported so the headless
 *  fail-fast decision is unit-testable without a live SDK. */
export function isToolPreApproved(
  toolName: string,
  allowlist: ReadonlySet<string>,
): boolean {
  if (allowlist.has(toolName)) return true;
  // A server-level grant (`mcp__github`) pre-approves all its tools. The SDK ids
  // MCP tools as `mcp__<server>__<tool>` (`__` is the delimiter), so the server
  // grant is the first two `__`-segments.
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3 && allowlist.has(`mcp__${parts[1]}`)) return true;
  }
  return false;
}

export type SdkStreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; output: string; isError: boolean }
  | {
      /** Throttled liveness beat (≤ ~1 per SDK_HEARTBEAT_MS). Emitted when
       *  SDK messages are flowing but none has produced another chunk —
       *  thinking deltas, streamed tool-call arguments (input_json_delta),
       *  content_block_start/stop, system chatter are all consumed silently
       *  otherwise. `via` = the newest activity's label; the counts cover
       *  everything since the previous beat (or stream start). */
      type: 'heartbeat';
      via: string;
      messages: number;
      toolUses: number;
      textBytes: number;
    }
  | {
      /** The SDK compacted the session's context (its own auto-compaction,
       *  or a manual trigger). Surfaced because a compaction boundary is
       *  the PROOF that a long phase's context is bounded rather than
       *  running away — and it explains an otherwise baffling
       *  discontinuity in the agent's narrative. `preTokens`/`postTokens`
       *  are the SDK's own before/after context sizes. */
      type: 'compaction';
      trigger: 'manual' | 'auto';
      preTokens: number;
      postTokens?: number;
    }
  | {
      /** Cumulative spend so far, after each turn's usage arrives — only when
       *  the caller asked (`reportUsage`). Output tokens are final only on
       *  `done`, so this is a running floor, not the bill. */
      type: 'usage';
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  | {
      type: 'done';
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    };

/** Heartbeat throttle: at most one liveness beat per this window while the
 *  SDK stream produces nothing else. 30s ≈ 120 rows/hour of silent tail —
 *  cheap against the false-silence it removes: with no beat, a healthy phase
 *  working quietly can look dead for over an hour. */
export const SDK_HEARTBEAT_MS = 30_000;



/** Content blocks the SDK's prompt option accepts. Strings are
 *  legacy / convenience; the full form is an array of typed blocks
 *  so a user message can mix text + images (vision). */
export type SdkPromptBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    };

export type SdkStreamParams = {
  /** The user message that kicks off the agent loop. String for
   *  text-only calls; array of content blocks for vision (text +
   *  one or more images). */
  userMessage: string | SdkPromptBlock[];
  systemPrompt?: string;
  model: string;
  /** Per-call turn cap. Defaults to 250, the same cap /api/llm/stream
   *  applies. A long tool-driving flow burns turns fast, and a cap in
   *  the low hundreds ends it with "Reached maximum number of turns"
   *  mid-task — a phase failure caused by the cap and nothing else.
   *  Per-phase overrides come from the orchestration node's `maxTurns`
   *  decorator. */
  maxTurns?: number;
  /** Required — the caller is responsible for aborting on cancel.
   *  Pass a fresh controller per call so cancelling one phase doesn't
   *  bleed into the next. */
  abortController: AbortController;
  /** Claude Code built-in tools to expose (Bash, Read, Write, Edit,
   *  Glob, Grep, WebFetch, WebSearch, …). Empty → no tools (text-only
   *  completion). */
  tools?: string[];
  /** RESTRICT the SDK's built-in toolset to exactly these names (its
   *  `tools` option; `[]` disables every built-in). `tools` above only
   *  PRE-APPROVES — the SDK still loads its full default preset, and under
   *  permissionMode `default` the permission-free members of it (Read,
   *  Glob, Grep, …) run unprompted. So a route that polices tools by
   *  allowlist must also pin the base set, or a "no tools" request still
   *  reads the filesystem. Undefined leaves the SDK's default preset (the
   *  orchestration path, which is sandbox-policed, relies on that). */
  builtinTools?: string[];
  /** Per-call permission mode override. When undefined, defaults to
   *  bypassPermissions if tools are present, otherwise unset. */
  permissionMode?: PermissionMode;
  /** Tool ids to PRE-APPROVE (merged into the SDK's `allowedTools`) so a
   *  headless run never blocks on a permission "Allow" for them. Fully-qualified
   *  MCP tool ids (`mcp__server__tool`), whole servers (`mcp__server`), or
   *  built-in tool names. Sourced from the phase's `autoApproveTools` ∪ the
   *  run-wide SAMMY_ALLOWED_MCP_TOOLS env. */
  autoApproveTools?: string[];
  /** Headless mode: FAIL FAST instead of stalling when the agent hits a tool
   *  that needs an interactive "Allow". A server run has no human to answer the
   *  SDK's permission prompt, so such a tool would hang the phase forever. When
   *  true, a non-pre-approved permission-gated tool is denied and streamSdk
   *  throws {@link ToolPermissionRequiredError} — the executor turns that into a
   *  loud `awaiting-approval` event + a fast phase failure. Default false keeps
   *  the interactive behavior exactly as before. */
  failOnToolPrompt?: boolean;
  /** Map of subagent name → AgentDefinition. Wired to the SDK's
   *  `agents` option; the orchestrator agent dispatches via
   *  Task("name", "prompt"). */
  subagents?: Record<string, SdkSubagentSpec>;
  /** Already-resolved MCP server configs. Caller looked up names
   *  against the workspace mcp/servers.json registry. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Reasoning effort level passed straight to the SDK. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Cap on extended-thinking tokens; 0 disables thinking. */
  maxThinkingTokens?: number;
  /** Already-grouped hook callbacks. Caller looked up names against
   *  the workspace hooks/hooks.json registry and wrapped each spec as
   *  a shell-bridged callback. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Extra environment variables to inject into the spawned agent
   *  subprocess. SECURITY: this is the sanctioned sink for per-phase
   *  credential secrets (see server/credential-env.ts) — the secret is
   *  set here and ONLY here, never in the prompt / system / context. The
   *  SDK's `env` option defaults to `process.env`; passing a partial map
   *  would REPLACE the whole environment, so we merge over `process.env`
   *  below. Undefined leaves the SDK's default (inherit process.env). */
  env?: Record<string, string>;
  /** Working directory for the agent session (a run's worktree). Undefined
   *  = the SDK default, process.cwd(). */
  cwd?: string;
  /** Per-agent token circuit-breaker. If a single agent loop's cumulative
   *  token spend (summed across turns — input + cache + output) exceeds this,
   *  the loop is aborted to stop runaway spend. The motivating case: QA runs
   *  that exhausted the usage quota because the agent re-sent a growing
   *  image/a11y context EVERY turn, so cost balloons ~quadratically.
   *  Resolution chain (each tier only applies when the previous is unset):
   *  the node's `maxAgentTokens` → the orchestration root's
   *  `defaults.maxAgentTokens` (both applied in the executor's
   *  `resolveNodeLimits`) → the SAMMY_MAX_AGENT_TOKENS env var (parsed in
   *  run-runner's `parseMaxAgentTokensEnv`, which threads the winner into
   *  this param) → the built-in default below (30_000_000). Set 0 to disable.
   *  Pair with low `maxTurns` + a run `budget` for defence in depth. */
  maxAgentTokens?: number;
  /** Start a new session with this id (a UUID) — a harness run picks it up
   *  front so it can show the resume command before the agent says anything. */
  sessionId?: string;
  /** Continue this saved session (a harness run's next leg, after a gate). */
  resume?: string;
  /** Only these skills are listed to the agent and runnable by its Skill
   *  tool. Undefined leaves the SDK's own default. */
  skills?: string[];
  /** Yield a `usage` chunk after each turn's usage arrives (a harness
   *  session enforces budgets mid-leg with it). */
  reportUsage?: boolean;
  /** The SDK entry point. Defaults to the real `query`, resolved by a dynamic
   *  import that jest cannot execute — so this is the seam through which the
   *  options this module builds and the errors it stamps are tested without
   *  a `claude` subprocess (the executor's `streamFn` is the same shape). */
  queryFn?: SdkQueryFn;
};

function nodeChildProcess(): typeof import('node:child_process') {
  return (
    process as unknown as { getBuiltinModule(id: string): typeof import('node:child_process') }
  ).getBuiltinModule('node:child_process');
}

/** SAMMY_AGENT_AMBIENT_MCP=1: let agents use the MCP servers of the host's
 *  own Claude configuration (off by default — see the query options). */
function ambientMcpAllowed(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SAMMY_AGENT_AMBIENT_MCP?.trim() ?? '');
}

/** Stream chunks from a single SDK invocation. The shape matches the
 *  wire format /api/llm/stream emits, so the proxy handler can relay
 *  each chunk straight to the SSE stream without translation. */
export async function* streamSdk(
  params: SdkStreamParams,
): AsyncIterable<SdkStreamChunk> {
  const query =
    params.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  const {
    userMessage,
    systemPrompt = '',
    model,
    maxTurns = 250,
    abortController,
    tools = [],
    builtinTools,
    permissionMode,
    autoApproveTools = [],
    failOnToolPrompt = false,
    subagents,
    mcpServers,
    effort,
    maxThinkingTokens,
    hooks,
    env,
    cwd,
    maxAgentTokens = 30_000_000,
    sessionId,
    resume,
    skills,
    reportUsage = false,
  } = params;

  // Pre-approval allowlist: the built-in `tools` plus any explicitly pre-approved
  // tool ids (phase `autoApproveTools` ∪ SAMMY_ALLOWED_MCP_TOOLS). Feeding these
  // to the SDK's `allowedTools` is what stops a headless run stalling on a
  // permission prompt for a write-capable MCP tool — an allowed tool never
  // prompts. De-duplicated; order is irrelevant to the SDK.
  const allowlist = new Set<string>([...tools, ...autoApproveTools]);
  const allowedTools = [...allowlist];
  // Headless fail-fast: if the agent reaches a tool that STILL needs an
  // interactive "Allow" (not pre-approved), there is no human to answer it, so
  // deny it and remember it — after the loop we throw
  // ToolPermissionRequiredError so the phase fails fast instead of wedging.
  let blockedTool: string | null = null;
  const canUseTool = failOnToolPrompt
    ? async (toolName: string): Promise<PermissionResult> => {
        if (isToolPreApproved(toolName, allowlist)) {
          return { behavior: 'allow', updatedInput: {} };
        }
        blockedTool = toolName;
        return {
          behavior: 'deny',
          message:
            `headless run: "${toolName}" requires approval that no human is ` +
            `present to give. Pre-approve it via the phase's autoApproveTools ` +
            `or SAMMY_ALLOWED_MCP_TOOLS.`,
          interrupt: true,
        };
      }
    : undefined;

  // Merge injected vars OVER the inherited process.env. The SDK's `env`
  // option defaults to process.env, so a partial map passed alone would
  // wipe PATH/HOME/etc. and break the spawned CLI. Build the merged map
  // only when there's something to inject; otherwise leave `env` undefined
  // so the SDK uses its own default (full process.env inheritance).
  const mergedEnv =
    env && Object.keys(env).length > 0
      ? { ...process.env, ...env }
      : undefined;

  // NOTE: these are CUMULATIVE across the agent's turns. The previous version
  // overwrote them with each message's usage, which under-counted a multi-turn
  // agent (every turn re-sends the full, growing context) — so the run budget
  // never saw the real spend. We now accumulate, and use the running total to
  // enforce the per-agent circuit-breaker below.
  // Spend accounting + trip diagnostics live in the pure ledger
  // (token-ledger.ts) so the "is this a runaway?" rule is testable without
  // an SDK stream. This layer just feeds it usage and asks.
  const ledger = new TokenLedger();
  /** Stamp the ledger on an error thrown mid-turn. The turn that died still
   *  consumed these tokens, and `done` — the executor's only usage signal —
   *  never follows a throw. Without this, the `result` branch's promise that
   *  "a failed turn still spent tokens and the run budget must see them" held
   *  for the ledger and not for the budget: the executor charged nothing, so
   *  every `retry` of a failed turn was free as far as the caps could tell. */
  const withUsage = <E extends Error>(err: E): E =>
    Object.assign(err, {
      usage: {
        inputTokens: ledger.inputTokens,
        outputTokens: ledger.outputTokens,
        cacheReadTokens: ledger.cacheReadTokens,
        cacheWriteTokens: ledger.cacheWriteTokens,
      },
    });
  // tool_use blocks we've already emitted, keyed by id. The SDK
  // surfaces them both in stream_event partials and the final
  // assistant message — we want one emit per id. Assistant-message
  // path carries the full input, so we emit from there and ignore
  // the partial path.
  const emittedToolUseIds = new Set<string>();

  // Normalize the prompt. The SDK's `prompt` option accepts EITHER
  // a string OR an AsyncIterable<SDKUserMessage>. There's no
  // direct "content blocks array" form — for multi-modal content
  // (text + image, etc.) we wrap the blocks in a single
  // SDKUserMessage and yield it from a one-shot async iterable.
  //
  // The previous version cast an array to string, which the SDK
  // silently dropped — produced empty model output + no error.
  const prompt =
    typeof userMessage === 'string'
      ? userMessage || 'Start the phase.'
      : (async function* (): AsyncIterable<{
          type: 'user';
          message: { role: 'user'; content: typeof userMessage };
          parent_tool_use_id: null;
        }> {
          yield {
            type: 'user',
            message: { role: 'user', content: userMessage },
            parent_tool_use_id: null,
          };
        })();
  // ── Liveness heartbeat state ──────────────────────────────────────────
  // Only SOME SDK messages become chunks (text deltas, completed tool
  // calls, tool results). The rest — thinking deltas, streamed tool-call
  // ARGUMENTS (input_json_delta), content_block_start/stop — are consumed
  // silently, so a turn can work for an hour while the phase emits
  // nothing: the run's event stream reads as dead, the stall watchdog
  // (which resets only on emitted events) starves, and an operator cannot
  // tell a healthy long tail from a hang. `lastYieldAt` tracks the last
  // chunk of ANY kind; when messages flow but nothing has been yielded for
  // SDK_HEARTBEAT_MS, a `heartbeat` chunk goes out carrying what the turn
  // was last doing + compact counts since the previous beat — the event
  // stream and the stall clock then agree BY CONSTRUCTION, and the silent
  // tail is diagnosable from the durable log after the fact.
  let lastYieldAt = Date.now();
  let beatMessages = 0;
  let beatToolUses = 0;
  let beatTextBytes = 0;
  let lastActivity = 'start';

  for await (const msg of query({
    // The cast targets the SDK's `string | AsyncIterable<SDKUserMessage>`
    // union — our local iterable matches structurally but the SDK's
    // SDKUserMessage type carries optional fields we don't bother filling.
    prompt: prompt as Parameters<typeof query>[0]['prompt'],
    options: {
      systemPrompt,
      model,
      maxTurns,
      abortController,
      allowedTools,
      // Only when the caller pins the base set; otherwise the SDK's default
      // preset stays, which the orchestration path depends on. `satisfies`
      // because a conditional spread is exempt from excess-property checking:
      // without it an SDK-side rename of the option would compile clean and
      // silently re-enable every built-in tool under `off`.
      ...(builtinTools !== undefined
        ? ({ tools: builtinTools } satisfies Pick<Options, 'tools'>)
        : {}),
      permissionMode:
        permissionMode ?? (tools.length > 0 ? 'bypassPermissions' : undefined),
      // Headless fail-fast hook (only when failOnToolPrompt is set). A
      // pre-approved tool is allowed; anything else that would prompt is denied
      // + recorded so we throw after the loop instead of stalling.
      ...(canUseTool ? { canUseTool } : {}),
      agents: subagents,
      mcpServers,
      effort,
      maxThinkingTokens,
      hooks,
      ...(mergedEnv ? { env: mergedEnv } : {}),
      ...(cwd ? { cwd } : {}),
      ...(resume ? { resume } : sessionId ? { sessionId } : {}),
      ...(skills ? { skills } : {}),
      // Only the MCP servers this call names (`mcpServers`, from the phase's
      // `mcp`). Without the flag the agent also inherits every server in the
      // host's own Claude configuration and account connectors — a step that
      // declares read-only tools could write to a tracker or a design file,
      // and the same orchestration behaves differently on every machine.
      // SAMMY_AGENT_AMBIENT_MCP=1 restores the inheritance.
      ...(ambientMcpAllowed() ? {} : { strictMcpConfig: true }),
      // Record which run owns the agent's process, so a run reaping its own
      // leftovers never kills another run's agents (reap.ts). Same spawn as
      // the SDK's default (stderr is ignored: no `stderr` option is set).
      ...(mergedEnv?.SAMMY_RUN_ID
        ? {
            spawnClaudeCodeProcess: (o: SpawnOptions) => {
              // Loaded at call time: this module is in the browser bundle's
              // import graph (through the executor), where `node:` imports fail.
              const { spawn } = nodeChildProcess();
              const child = spawn(o.command, o.args, {
                cwd: o.cwd,
                env: o.env,
                signal: o.signal,
                stdio: ['pipe', 'pipe', 'ignore'],
                windowsHide: true,
              });
              const pid = child.pid;
              if (pid !== undefined) {
                registerRunProcess(String(o.env.SAMMY_RUN_ID), pid);
                // Forget it when it exits: pids are reused, and a stale entry
                // would credit an unrelated later process to this run.
                child.once('exit', () => forgetProcess(pid));
              }
              return child;
            },
          }
        : {}),
      includePartialMessages: true,
    },
  })) {
    // Heartbeat accounting: every SDK message counts as activity; label the
    // newest one so a silent tail's beats say what the turn was doing
    // (thinking_delta, input_json_delta, assistant-message, tool-result, …).
    beatMessages += 1;
    if (msg.type === 'stream_event') {
      const e = msg.event as { type?: string; delta?: { type?: string } };
      lastActivity = e.delta?.type ?? e.type ?? 'stream_event';
    } else if (msg.type === 'assistant') {
      lastActivity = 'assistant-message';
    } else if (msg.type === 'user') {
      lastActivity = 'tool-result';
    } else {
      lastActivity = msg.type;
    }
    if (Date.now() - lastYieldAt >= SDK_HEARTBEAT_MS) {
      lastYieldAt = Date.now();
      yield {
        type: 'heartbeat',
        via: lastActivity,
        messages: beatMessages,
        toolUses: beatToolUses,
        textBytes: beatTextBytes,
      };
      beatMessages = 0;
      beatToolUses = 0;
      beatTextBytes = 0;
    }
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (
        ev.type === 'content_block_delta' &&
        ev.delta &&
        'type' in ev.delta &&
        ev.delta.type === 'text_delta' &&
        'text' in ev.delta
      ) {
        lastYieldAt = Date.now();
        beatTextBytes += ev.delta.text.length;
        yield { type: 'text-delta', text: ev.delta.text };
      } else if (ev.type === 'message_start' && ev.message?.usage) {
        // Accumulate (don't overwrite) — every turn's input re-sends the full
        // context, so the sum is the agent's true spend.
        ledger.record(ev.message.usage as unknown as TurnUsage);
        if (reportUsage) {
          lastYieldAt = Date.now();
          yield {
            type: 'usage',
            usage: {
              inputTokens: ledger.inputTokens,
              outputTokens: ledger.outputTokens,
              cacheReadTokens: ledger.cacheReadTokens,
              cacheWriteTokens: ledger.cacheWriteTokens,
            },
          };
        }
        // Circuit-breaker: a single agent cannot exceed maxAgentTokens. Catches
        // runaway sim-vision loops before they exhaust the whole usage quota.
        //
        // We do NOT abort the (shared, run-wide) AbortController here — doing so
        // poisons every DOWNSTREAM leaf's SDK call too (each would then fail
        // "Operation aborted"), which made the breaker indistinguishable from a
        // genuine user/run cancel and killed the whole run even past phases
        // marked continueOnError. Instead we throw a distinct
        // AgentTokenCeilingError: leaving this `for await` calls `.return()` on
        // the query iterator (stopping THIS runaway leaf at once — it can't keep
        // burning tokens), while the shared signal stays clean so sibling /
        // downstream phases run normally. The executor catches this error and
        // routes it through retry / onError / continueOnError like any other
        // per-leaf failure (and a true cancel still kills the run via the shared
        // signal — that path is untouched).
        if (ledger.exceeded(maxAgentTokens)) {
          // Diagnosis the operator needs to tell the two classes apart: a
          // RUNAWAY grows its prompt every turn (first≪last); a long but
          // healthy supervision loop is flat or saw-toothed across
          // compactions. The shape + verdict go in the stream too, so the
          // phase's own output carries why it stopped.
          const diag = ledger.diagnostics();
          yield {
            type: 'text-delta',
            text:
              `\n\n[token-ceiling] agent stopped after ~${Math.round(ledger.weightedTokens / 1000)}k ` +
              `input-equivalent tokens (ceiling ${Math.round(maxAgentTokens / 1000)}k; ` +
              `cache reads counted at ${CACHE_READ_WEIGHT}×). ` +
              `${formatCeilingShape(diag)}. ${ceilingVerdict(diag)}\n`,
          };
          throw withUsage(
            new AgentTokenCeilingError(ledger.weightedTokens, maxAgentTokens, diag),
          );
        }
      }
    } else if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'tool_use'
          ) {
            const b = block as { id?: string; name?: string; input?: unknown };
            if (b.id && !emittedToolUseIds.has(b.id)) {
              emittedToolUseIds.add(b.id);
              lastYieldAt = Date.now();
              beatToolUses += 1;
              lastActivity = `tool:${b.name ?? '(unknown)'}`;
              yield {
                type: 'tool-use',
                toolUseId: b.id,
                name: b.name ?? '(unknown)',
                input: b.input ?? {},
              };
            }
          }
        }
      }
    } else if (msg.type === 'user') {
      const content = (msg as { message?: { content?: unknown } }).message
        ?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'tool_result'
          ) {
            const b = block as {
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            };
            let output = '';
            if (typeof b.content === 'string') {
              output = b.content;
            } else if (Array.isArray(b.content)) {
              output = b.content
                .map(c =>
                  c && typeof c === 'object' && (c as { text?: string }).text
                    ? (c as { text: string }).text
                    : JSON.stringify(c),
                )
                .join('\n');
            } else if (b.content != null) {
              output = JSON.stringify(b.content);
            }
            lastYieldAt = Date.now();
            yield {
              type: 'tool-result',
              toolUseId: b.tool_use_id ?? '',
              output,
              isError: b.is_error === true,
            };
          }
        }
      }
    } else if (
      msg.type === 'system' &&
      (msg as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      // The SDK compacted the session context (auto, at its own threshold,
      // or manual). This is the bounded-context proof for a long phase —
      // and without it, the agent's narrative appears to lose its memory
      // mid-phase for no visible reason.
      const meta =
        (msg as { compact_metadata?: Record<string, unknown> })
          .compact_metadata ?? {};
      ledger.noteCompaction();
      lastYieldAt = Date.now();
      lastActivity = 'compaction';
      yield {
        type: 'compaction',
        trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
        preTokens:
          typeof meta.pre_tokens === 'number' ? meta.pre_tokens : 0,
        ...(typeof meta.post_tokens === 'number'
          ? { postTokens: meta.post_tokens }
          : {}),
      };
    } else if (msg.type === 'result') {
      const r = msg as {
        subtype?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        terminal_reason?: string;
        api_error_status?: number;
        stop_reason?: string;
      };
      // Keep the larger of our accumulated total and the SDK's reported total
      // (semantics vary by SDK version) so the run budget never under-counts.
      // Done for EVERY terminal result, success or not — a failed turn still
      // spent tokens and the run budget must see them.
      ledger.inputTokens = Math.max(ledger.inputTokens, r.usage?.input_tokens ?? 0);
      ledger.outputTokens = Math.max(ledger.outputTokens, r.usage?.output_tokens ?? 0);

      // A NON-success result used to fall through this branch silently: the
      // loop ended, `done` was yielded, and the executor treated a failed
      // turn as a successful phase carrying whatever partial text had
      // streamed so far. Classify it structurally instead (the SDK reports
      // subtype / terminal_reason / api_error_status / stop_reason) and
      // throw, so the phase fails through the normal retry / onError /
      // continueOnError path — with retryability decided by the SDK's own
      // signals rather than by matching the error string.
      const verdict = classifySdkResult({
        subtype: r.subtype,
        terminalReason: r.terminal_reason,
        apiErrorStatus: r.api_error_status,
        stopReason: r.stop_reason,
      });
      if (verdict) {
        if (verdict.maxTurns) {
          // The executor treats max-turns as a pause-point, not a failure.
          // It matched on this phrase before; now the detection is
          // structural and the message is just for humans.
          throw withUsage(new Error('Reached maximum number of turns'));
        }
        throw withUsage(
          verdict.terminal
            ? new TerminalPhaseError(verdict.reason)
            : new Error(verdict.reason),
        );
      }
    }
  }

  // Headless fail-fast: canUseTool denied a permission-gated tool (with
  // interrupt), ending the loop. Surface it loudly instead of returning a
  // silently-truncated result — the executor maps this to an `awaiting-approval`
  // event + a fast phase failure.
  if (blockedTool !== null) {
    throw withUsage(new ToolPermissionRequiredError(blockedTool));
  }

  yield {
    type: 'done',
    usage: {
        inputTokens: ledger.inputTokens,
        outputTokens: ledger.outputTokens,
        cacheReadTokens: ledger.cacheReadTokens,
        cacheWriteTokens: ledger.cacheWriteTokens,
      },
  };
}

/** Convenience for callers that want a friendlier error message when
 *  the SDK call fails due to a missing CLI auth. The SDK throws
 *  generic Error / network errors that don't surface the underlying
 *  "you need to run `claude login` first" reason. */
export function decorateAuthError(message: string): string {
  if (/auth|unauthor|login|token|credential/i.test(message)) {
    return (
      message + ' (Hint: run `claude` in a terminal to verify your Claude Code login.)'
    );
  }
  return message;
}
