/**
 * Per-agent spend accounting for the token circuit-breaker — a pure
 * ledger, so the rule that decides when an agent is "running away" can be
 * reasoned about and tested without an SDK stream (same split as
 * degradation.ts / divergence.ts / wait-resolution.ts). sdk-stream.ts just
 * feeds it each turn's usage and asks whether the ceiling is crossed.
 *
 * WHY THE WEIGHTS EXIST. The breaker used to
 * sum raw tokens — `input + output + cache_read + cache_creation` at equal
 * weight — accumulated per turn. In ANY long agent loop the dominant term
 * is `cache_read_input_tokens`: the SAME context re-read every turn, which
 * bills at ~10% of a fresh input token. Summing that at face value makes
 * the counter the time-INTEGRAL of context size, so it grows with DURATION
 * rather than with waste. A legitimate hours-long supervision phase
 * (polling a detached job every 2–3 min) with a flat, healthy 40k context
 * accrued ~40k per turn and burned the 30M ceiling in ~20 minutes — while
 * the SDK was auto-compacting that context and keeping it bounded the
 * whole time. The breaker's own purpose is to stop runaway SPEND, so it
 * now counts spend: each token class weighted by its real price relative
 * to a fresh input token. A runaway (fresh images / fat tool outputs every
 * turn) still accrues full freight and is still caught.
 */

// Anthropic's standard price ratios relative to a fresh input token. Stable
// across the Claude model line, so they live here rather than per-model in
// pricing.ts (which prices only input/output).
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;
export const OUTPUT_WEIGHT = 5;

/** The usage shape the SDK reports per turn. Token fields are optional
 *  numbers; `iterations` (when present) is the PER-SAMPLING-PASS
 *  breakdown — see {@link TokenLedger.record}. */
export type TurnUsage = Record<string, unknown> & {
  iterations?: unknown;
};

/** What the agent's loop looked like when the breaker tripped — enough to
 *  tell a runaway from legitimately long work WITHOUT re-running it. */
export type TokenCeilingDiagnostics = {
  turns: number;
  elapsedMs: number;
  /** Prompt size on the first and last turn. first≪last ⇒ runaway growth. */
  firstPromptTokens: number;
  lastPromptTokens: number;
  /** SDK context compactions observed — a long phase that compacts is
   *  bounded by construction, so a trip means "raise the ceiling", not
   *  "fix the agent". */
  compactions: number;
  /** Unweighted tokens processed (cache reads at face value). */
  rawTokens: number;
  contextGrew: boolean;
};

/** Growth factor at which the last turn's prompt counts as "grew" vs the
 *  first. 1.5× tolerates normal warm-up without flagging a flat loop. */
const GROWTH_FACTOR = 1.5;

/** The prompt actually fed to the model on one pass (everything but
 *  output) — the signal that distinguishes a RUNAWAY context (grows every
 *  turn) from a long-but-healthy one (flat, or saw-toothed across
 *  compactions). */
function promptOf(usage: TurnUsage): number {
  const n = (k: string): number => {
    const v = usage[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return (
    n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens')
  );
}

export class TokenLedger {
  /** Cost-weighted ("input-equivalent") tokens — what the ceiling checks. */
  private weighted = 0;
  /** Raw tokens processed, every class at face value — reported only. */
  private raw = 0;
  private turns = 0;
  private firstPrompt = 0;
  private lastPrompt = 0;
  private compactions = 0;
  private readonly startedAtMs: number;
  /** Plain input/output totals, for the caller's own usage reporting. */
  inputTokens = 0;
  outputTokens = 0;

  constructor(now: number = Date.now()) {
    this.startedAtMs = now;
  }

  /**
   * Fold one turn's usage into the ledger.
   *
   * ITERATIONS: a turn is not always one sampling pass. With threshold
   * compaction enabled the API runs an EXTRA pass to summarize the
   * conversation, and reports each pass separately in `usage.iterations[]`
   * (`{type:"compaction"}` alongside `{type:"message"}`). Those extra
   * passes are NOT included in the top-level `input_tokens` /
   * `output_tokens`, so a budget that reads only the top level silently
   * UNDER-COUNTS exactly when the agent is doing the long work that
   * triggers compaction in the first place. When the breakdown is present
   * it is authoritative and the top level is ignored (summing both would
   * double-count the message pass).
   *
   * The turn still counts as ONE turn for diagnostics, and the context
   * trajectory tracks the LAST pass — the real message — so a compaction
   * pass can't masquerade as a shrinking context.
   */
  record(usage: TurnUsage): void {
    const iterations = Array.isArray(usage.iterations)
      ? (usage.iterations as TurnUsage[])
      : null;
    if (iterations && iterations.length > 0) {
      for (const pass of iterations) this.accumulate(pass);
      const last = iterations[iterations.length - 1];
      this.lastPrompt = promptOf(last);
    } else {
      this.accumulate(usage);
      this.lastPrompt = promptOf(usage);
    }
    this.turns += 1;
    if (this.turns === 1) this.firstPrompt = this.lastPrompt;
  }

  /** Add one sampling pass's tokens to the running totals. */
  private accumulate(usage: TurnUsage): void {
    const n = (k: string): number => {
      const v = usage[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    this.inputTokens += n('input_tokens');
    this.outputTokens += n('output_tokens');
    this.raw +=
      n('input_tokens') +
      n('output_tokens') +
      n('cache_read_input_tokens') +
      n('cache_creation_input_tokens');
    this.weighted +=
      n('input_tokens') +
      n('cache_creation_input_tokens') * CACHE_WRITE_WEIGHT +
      n('cache_read_input_tokens') * CACHE_READ_WEIGHT +
      n('output_tokens') * OUTPUT_WEIGHT;
  }

  /** The SDK compacted the session context. */
  noteCompaction(): void {
    this.compactions += 1;
  }

  get weightedTokens(): number {
    return this.weighted;
  }
  get rawTokens(): number {
    return this.raw;
  }

  /** True when a positive ceiling has been crossed (0 = breaker off). */
  exceeded(ceiling: number): boolean {
    return ceiling > 0 && this.weighted > ceiling;
  }

  diagnostics(now: number = Date.now()): TokenCeilingDiagnostics {
    return {
      turns: this.turns,
      elapsedMs: now - this.startedAtMs,
      firstPromptTokens: this.firstPrompt,
      lastPromptTokens: this.lastPrompt,
      compactions: this.compactions,
      rawTokens: this.raw,
      contextGrew: this.lastPrompt > this.firstPrompt * GROWTH_FACTOR,
    };
  }
}

/** The operator-facing verdict for a trip: which lever to reach for. */
export function ceilingVerdict(d: TokenCeilingDiagnostics): string {
  return d.contextGrew
    ? 'Context GREW across turns — runaway accumulation (e.g. re-sending a ' +
        'growing image/a11y context, or fat tool outputs piling up). Shrink ' +
        'tool outputs, poll less often, lower maxTurns, or raise ' +
        '`maxAgentTokens` for this phase.'
    : 'Context stayed FLAT — long legitimate work, not a runaway: raise ' +
        '`maxAgentTokens` on this phase (or `defaults.maxAgentTokens` / ' +
        'SAMMY_MAX_AGENT_TOKENS) rather than changing the agent.';
}

/** Compact loop shape for a log line / error message. */
export function formatCeilingShape(d: TokenCeilingDiagnostics): string {
  return (
    `turns=${d.turns}, elapsed=${Math.round(d.elapsedMs / 60_000)}min, ` +
    `context ${Math.round(d.firstPromptTokens / 1000)}k→` +
    `${Math.round(d.lastPromptTokens / 1000)}k, compactions=${d.compactions}, ` +
    `raw=${Math.round(d.rawTokens / 1000)}k`
  );
}
