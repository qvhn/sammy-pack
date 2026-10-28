/**
 * Per-model pricing in USD per million tokens.
 *
 * Numbers are from Anthropic's public pricing page; double-check before
 * relying on them in production budgets. Unknown models return 0 (i.e.
 * cost telemetry shows up as $0 rather than misleading you).
 */

type Price = { input: number; output: number };

const PRICING: Record<string, Price> = {
  // Claude 4.x family
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4-0': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Claude 3.x family
  'claude-3-7-sonnet-latest': { input: 3, output: 15 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
  'claude-3-opus-latest': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // OpenAI — public prices, double-check before relying in production.
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Gemini — public prices.
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-pro': { input: 1.25, output: 5 },
};

/** Anthropic prompt caching: a cache write costs 1.25x the input price (5-minute cache), a cache read 0.1x.
 *  The same factors TokenLedger weights its ceiling with. Providers that don't report cache tokens pass none. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** A Claude model newer than this table (claude-sonnet-5-5, claude-opus-5-5, a new family) would otherwise cost 0
 *  and slip past every spend cap. Price it like the most expensive listed model of its family (opus / sonnet /
 *  haiku), or the most expensive listed Claude model for a family the table doesn't know: an over-estimate
 *  until the table is updated, never a silent zero. Non-Claude models with no entry still cost 0 (no guess). */
function claudeFallback(key: string): Price | undefined {
  if (!key.startsWith('claude-')) return undefined;
  const family = /(opus|sonnet|haiku)/.exec(key)?.[1];
  const pool = Object.entries(PRICING)
    .filter(([k]) => k.startsWith('claude-') && (!family || k.includes(family)))
    .map(([, price]) => price);
  if (pool.length === 0) return undefined;
  return pool.reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));
}

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: { cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const key = normalize(model);
  const p = PRICING[key] ?? claudeFallback(key);
  if (!p) return 0;
  const writes = cache?.cacheWriteTokens ?? 0;
  const reads = cache?.cacheReadTokens ?? 0;
  return (
    (inputTokens * p.input +
      writes * p.input * CACHE_WRITE_MULTIPLIER +
      reads * p.input * CACHE_READ_MULTIPLIER +
      outputTokens * p.output) /
    1_000_000
  );
}

/** Lookup helper — strip date suffixes like `-20250115` so callers with dated
 * snapshot IDs still hit the table. */
function normalize(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function knownModel(model: string): boolean {
  return normalize(model) in PRICING;
}
