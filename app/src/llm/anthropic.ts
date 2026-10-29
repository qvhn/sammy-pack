/**
 * Direct browser → Anthropic API client. No SDK dep.
 *
 * The user's API key is sent client-side. They've explicitly opted in to this
 * (by entering it in Settings); the trade-off vs server-side proxying is that
 * the key sits in localStorage and never leaves their browser. Production
 * deployments should swap this for a server proxy.
 */

export type Message = { role: 'user' | 'assistant'; content: string };
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads / writes (Anthropic). Not part of inputTokens; priced separately (pricing.ts). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; output: string; isError: boolean }
  | {
      /** Throttled liveness beat from the SDK stream (see sdk-stream's
       *  SdkStreamChunk twin): SDK messages are flowing but none produced
       *  another event — thinking, streamed tool arguments, block
       *  boundaries. The executor forwards it as `phase-heartbeat` so the
       *  run's event stream and the stall watchdog observe the same clock. */
      type: 'heartbeat';
      via: string;
      messages: number;
      toolUses: number;
      textBytes: number;
    }
  | {
      /** The SDK compacted the session context (see sdk-stream's twin).
       *  The executor forwards it as `phase-compacted`. */
      type: 'compaction';
      trigger: 'manual' | 'auto';
      preTokens: number;
      postTokens?: number;
    }
  | {
      /** Cumulative spend so far (server SDK path, harness sessions only —
       *  see sdk-stream's `reportUsage`). */
      type: 'usage';
      usage: Usage;
    }
  | { type: 'done'; usage: Usage };

type CallParams = {
  apiKey: string;
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
};

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function headers(apiKey: string) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/**
 * Streaming variant. Yields text deltas as they arrive, then a final `done`
 * event with token usage.
 */
export async function* streamAnthropic({
  apiKey,
  model,
  system,
  messages,
  maxTokens = 4096,
}: CallParams): AsyncIterable<StreamEvent> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 400)}`);
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
      try {
        const ev = JSON.parse(data);
        if (
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          typeof ev.delta.text === 'string'
        ) {
          yield { type: 'text-delta', text: ev.delta.text };
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          usage.inputTokens = ev.message.usage.input_tokens ?? 0;
          usage.outputTokens = ev.message.usage.output_tokens ?? 0;
          usage.cacheReadTokens = ev.message.usage.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = ev.message.usage.cache_creation_input_tokens ?? 0;
        } else if (ev.type === 'message_delta' && ev.usage) {
          if (typeof ev.usage.output_tokens === 'number') {
            usage.outputTokens = ev.usage.output_tokens;
          }
        }
      } catch {
        /* ignore malformed SSE event */
      }
    }
  }
  yield { type: 'done', usage };
}

/**
 * Non-streaming variant — kept for callers that want a single round-trip.
 */
export async function callAnthropic({
  apiKey,
  model,
  system,
  messages,
  maxTokens = 4096,
}: CallParams): Promise<{ text: string; usage: Usage }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const text = Array.isArray(data.content)
    ? data.content
        .filter((c: { type?: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('')
    : '';
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}
