/**
 * Google Gemini streaming adapter. Same `StreamFn` shape as every
 * other provider — set `provider: "gemini"` on a node to route to it.
 *
 * Text streaming only in this first cut. Tool / function-calling on
 * Gemini follows a different shape than Claude's tool-use protocol;
 * node-level `tools` / `subagents` declarations are silently ignored
 * when the provider is Gemini.
 *
 * No SDK dependency — fetch + SSE parsing only.
 */

import type { StreamEvent } from './anthropic';

export type GeminiStreamParams = {
  apiKey: string;
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
};

export async function* streamGemini(
  params: GeminiStreamParams,
): AsyncIterable<StreamEvent> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(params.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(params.apiKey)}`;
  const body: Record<string, unknown> = {
    contents: params.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: params.maxTokens ?? 4096 },
  };
  if (params.system) {
    body.systemInstruction = { parts: [{ text: params.system }] };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
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
        try {
          const json = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
            };
          };
          const parts = json.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (typeof p.text === 'string' && p.text) {
              yield { type: 'text-delta', text: p.text };
            }
          }
          if (json.usageMetadata) {
            inputTokens = json.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens =
              json.usageMetadata.candidatesTokenCount ?? outputTokens;
          }
        } catch {
          // Skip malformed frames.
        }
      }
    }
  }
  yield { type: 'done', usage: { inputTokens, outputTokens } };
}
