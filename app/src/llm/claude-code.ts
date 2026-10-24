/**
 * Browser → dev-server LLM adapter that uses the user's Claude Code CLI
 * login instead of an Anthropic API key.
 *
 * Mirrors the `streamAnthropic` interface from `./anthropic.ts` exactly so
 * the executor can pick either adapter at run time without caring which.
 *
 * The actual auth + LLM call happens server-side in `sammy-pack-api.ts`
 * (`POST /api/llm/stream`), which uses `@anthropic-ai/claude-agent-sdk`.
 * The SDK reads credentials from `~/.claude/` (left there by the user
 * running `claude` to log in).
 *
 * Wire format is SSE with the same per-event shape this file's parser
 * emits as StreamEvent — making the two adapters drop-in compatible.
 */

import type { Message, StreamEvent, Usage } from './anthropic';

type CallParams = {
  /** Ignored — proxy uses CLI auth. Kept in the signature so the type
   *  matches the direct-API adapter and the executor can swap them. */
  apiKey: string;
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  /** Claude Code built-in tools to expose (Bash / Read / Write / Edit
   *  / Glob / Grep / WebFetch / WebSearch). Forwarded to the proxy as
   *  the SDK's allowedTools. Empty/undefined → text-only completion. */
  tools?: string[];
  /** SDK permission mode for this call. Forwarded as-is to the proxy.
   *  Undefined → proxy picks: bypassPermissions when tools present,
   *  unset otherwise. */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
  /** Named subagents this call may dispatch via the Task tool. Each
   *  entry is a pre-built AgentDefinition (description + prompt + ...).
   *  Forwarded to the proxy as the SDK's `agents` option. */
  subagents?: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
    }
  >;
  /** Names of MCP servers from the workspace registry to expose to this
   *  call. Server-side `/api/llm/stream` expands them — including any
   *  secrets in env / headers — so they never traverse the browser. */
  mcp?: string[];
  /** Reasoning effort level for this call. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Cap on extended-thinking tokens for this call. */
  maxThinkingTokens?: number;
  /** Per-call SDK turn cap. When omitted, the proxy picks 250.
   *  Tool-heavy agents (UI automation, multi-file edits) routinely
   *  need more than the SDK's stock 25. */
  maxTurns?: number;
  /** Names of hooks from the workspace hooks/hooks.json registry. */
  hooks?: string[];
};

const ENDPOINT = '/api/llm/stream';

export async function* streamClaudeCode({
  model,
  system,
  messages,
  maxTokens = 4096,
  tools,
  permissionMode,
  subagents,
  mcp,
  effort,
  maxThinkingTokens,
  maxTurns,
  hooks,
}: CallParams): AsyncIterable<StreamEvent> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      system,
      messages,
      maxTokens,
      tools,
      permissionMode,
      subagents,
      mcp,
      effort,
      maxThinkingTokens,
      maxTurns,
      hooks,
    }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Claude Code proxy ${res.status}: ${errText.slice(0, 400)}`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev: unknown;
      try {
        ev = JSON.parse(data);
      } catch {
        continue; // malformed SSE; skip
      }
      const e = ev as { type?: string };
      if (e.type === 'text-delta' && typeof (e as { text?: unknown }).text === 'string') {
        yield { type: 'text-delta', text: (e as { text: string }).text };
      } else if (e.type === 'tool-use') {
        const t = e as { toolUseId?: string; name?: string; input?: unknown };
        yield {
          type: 'tool-use',
          toolUseId: t.toolUseId ?? '',
          name: t.name ?? '',
          input: t.input ?? {},
        };
      } else if (e.type === 'tool-result') {
        const t = e as { toolUseId?: string; output?: string; isError?: boolean };
        yield {
          type: 'tool-result',
          toolUseId: t.toolUseId ?? '',
          output: t.output ?? '',
          isError: t.isError === true,
        };
      } else if (e.type === 'done') {
        const u = (e as { usage?: Partial<Usage> }).usage ?? {};
        usage.inputTokens = u.inputTokens ?? 0;
        usage.outputTokens = u.outputTokens ?? 0;
      } else if (e.type === 'error') {
        throw new Error(
          `Claude Code proxy error: ${(e as { error?: string }).error ?? 'unknown'}`,
        );
      }
    }
  }
  yield { type: 'done', usage };
}
