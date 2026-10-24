/**
 * Provider registry — lets an orchestration route per-node to one of
 * several LLM providers behind the same `StreamFn` contract. Setting
 * `provider: "openai"` on a Node sends that phase to OpenAI; the rest
 * of the orchestration keeps using the default. Defaults preserve
 * today's behavior — no node-level provider means the caller's
 * `streamFn` is used (Claude Code proxy in the web app, direct
 * Anthropic in tests).
 *
 * Tool-use (Claude Code's `Bash` / `Read` / etc.), subagents, and MCP
 * are Claude-specific features; non-Anthropic providers silently
 * ignore those node-level declarations in this first cut.
 */

import type { StreamFn } from './executor';
import { ALL_PROVIDERS, type ProviderId } from '../types';
import { streamAnthropic } from './anthropic';
import { streamOpenAI } from './openai';
import { streamGemini } from './gemini';
import { streamBedrock } from './bedrock';

// Canonical provider type + list live in ../types (the single source of truth,
// also consumed by validate.ts and the schema-parity test). Re-exported here so
// existing `import { ProviderId, ALL_PROVIDERS } from './providers'` sites keep
// working.
export { ALL_PROVIDERS, type ProviderId };

/** Default model per provider — used when a node sets `provider` but
 *  not `model`. The orchestration-level `model` still overrides. */
export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-4-6',
  'claude-code': 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  bedrock: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
};

/** A registry maps a provider id → an `apiKey`-bound `StreamFn`. The
 *  caller builds one of these from its API-key store (browser
 *  localStorage, or process.env on the server). */
export type ProviderRegistry = Partial<Record<ProviderId, StreamFn>>;

/** Convenience: build a `StreamFn` for a provider given just its API
 *  key. Useful for the CLI binary + the standalone-runtime path. */
export function streamFnFor(
  provider: ProviderId,
  apiKey: string,
): StreamFn | null {
  if (provider === 'anthropic') {
    return params =>
      streamAnthropic({ ...params, apiKey: apiKey || params.apiKey });
  }
  if (provider === 'openai') {
    return params => streamOpenAI({ ...params, apiKey });
  }
  if (provider === 'gemini') {
    return params => streamGemini({ ...params, apiKey });
  }
  if (provider === 'bedrock') {
    // `apiKey` is JSON AWS creds (see bedrock.ts) — SigV4 signed per call.
    return params => streamBedrock({ ...params, apiKey });
  }
  // 'claude-code' has its own proxy path built by the caller — no
  // generic adapter here.
  return null;
}

/** Build a registry from a map of provider → api key (empty strings
 *  are skipped). The caller then passes the result as
 *  `providerStreamFns` into `runOrchestration`. */
export function buildProviderRegistry(
  keys: Partial<Record<ProviderId, string>>,
): ProviderRegistry {
  const reg: ProviderRegistry = {};
  for (const id of ALL_PROVIDERS) {
    const key = keys[id];
    if (!key || !key.trim()) continue;
    const fn = streamFnFor(id, key.trim());
    if (fn) reg[id] = fn;
  }
  return reg;
}

export { streamAnthropic } from './anthropic';
export { streamOpenAI } from './openai';
export { streamGemini } from './gemini';
export { streamBedrock } from './bedrock';
