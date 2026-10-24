/**
 * OpenAI Chat Completions streaming adapter. Implements the same
 * `StreamFn` shape every other provider does, so the executor can
 * route a node to OpenAI by setting `provider: "openai"`.
 *
 * Text streaming only in this first cut. Tool-use, multi-content,
 * subagents, and MCP are Claude-Code-proxy features — node-level
 * `tools` / `subagents` / `mcp` declarations are silently ignored
 * when the provider is OpenAI. Token usage is captured from the
 * `stream_options.include_usage` trailing chunk.
 *
 * No SDK dependency — fetch + SSE parsing only.
 */

import type { StreamEvent } from './anthropic';

export type OpenAiStreamParams = {
  apiKey: string;
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
};

/** Base URL for the OpenAI-compatible endpoint. Override via OPENAI_BASE_URL
 *  to target Azure OpenAI or any OpenAI-compatible gateway (vLLM, Together,
 *  OpenRouter, a local proxy, …). The `/chat/completions` path is appended,
 *  so set the base to e.g. `https://my-gateway/v1`. Defaults to OpenAI. */
function chatCompletionsUrl(): string {
  const base = (
    globalThis.process as { env?: Record<string, string | undefined> }
  )?.env?.OPENAI_BASE_URL?.trim();
  if (!base) return 'https://api.openai.com/v1/chat/completions';
  return `${base.replace(/\/+$/, '')}/chat/completions`;
}

export async function* streamOpenAI(
  params: OpenAiStreamParams,
): AsyncIterable<StreamEvent> {
  const body = {
    model: params.model,
    messages: [
      ...(params.system
        ? [{ role: 'system' as const, content: params.system }]
        : []),
      ...params.messages,
    ],
    max_tokens: params.maxTokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  const res = await fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let doneEmitted = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          yield { type: 'done', usage: { inputTokens, outputTokens } };
          doneEmitted = true;
          return;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            yield { type: 'text-delta', text: delta };
          }
          if (json.usage) {
            inputTokens = json.usage.prompt_tokens ?? inputTokens;
            outputTokens = json.usage.completion_tokens ?? outputTokens;
          }
        } catch {
          // Skip malformed SSE frames — keep streaming.
        }
      }
    }
  }
  if (!doneEmitted) {
    yield { type: 'done', usage: { inputTokens, outputTokens } };
  }
}
