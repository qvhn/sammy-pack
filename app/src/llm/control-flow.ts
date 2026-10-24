/**
 * Structured control-flow decisions for `route` and `loop.judge`.
 *
 * The router and judge are LLM phases whose *reply* is a decision the engine
 * acts on. Parsing that reply by raw substring (`reply.includes(branchKey)`,
 * `reply.includes('stop')`) is brittle: a branch key mentioned in prose, or a
 * judge that says "do not stop", mis-fires — and it makes resume less
 * deterministic. This module decides STRUCTURED-FIRST: it asks for a small JSON
 * verdict and parses that, then falls back to the legacy substring logic so
 * existing orchestrations (and replays of old runs) keep working unchanged.
 *
 * Pure + dependency-free → unit-tested in isolation (see control-flow.test.ts).
 */

/**
 * Tolerant JSON extraction from a model reply. Tries, in order: a direct parse,
 * a fenced ```json … ``` block, then the first `{ … }` span embedded in prose.
 * Returns the parsed value, or null if nothing parses. (A bare number like
 * "0.95" parses to a number, not an object — callers check the shape.)
 */
export function extractJson(text: string): unknown {
  const tryParse = (s: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch {
      return { ok: false };
    }
  };

  const direct = tryParse(text.trim());
  if (direct.ok) return direct.value;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) return fenced.value;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const span = tryParse(text.slice(start, end + 1));
    if (span.ok) return span.value;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export type RouteDecision = { branch: string; via: 'json' | 'substring' };

/**
 * Decide which route branch to take from the router's reply.
 *
 * Structured first: `{"branch": "<key>"}` (case-insensitive) where `<key>` is a
 * real branch — an explicit `"default"` resolves to null so the caller uses the
 * default branch. Then the legacy substring match (first branch key that
 * appears in the reply). Returns null when nothing matches (caller falls back
 * to the default branch, or errors). `branch` is always one of `branchKeys`.
 */
export function decideRoute(
  reply: string,
  branchKeys: string[],
  hasDefault: boolean,
): RouteDecision | null {
  const rec = asRecord(extractJson(reply));
  if (rec && typeof rec.branch === 'string') {
    const want = rec.branch.trim().toLowerCase();
    const match = branchKeys.find(k => k.toLowerCase() === want);
    if (match) return { branch: match, via: 'json' };
    // An explicit, valid "default" choice → no real branch (caller's default).
    if (want === 'default' && hasDefault) return null;
    // Unknown branch in a structured reply → fall through to substring.
  }

  const lower = reply.toLowerCase();
  for (const key of branchKeys) {
    if (lower.includes(key.toLowerCase())) return { branch: key, via: 'substring' };
  }
  return null;
}

export type LoopJudgeResult =
  | { stop: true; reason: string; via: 'json' | 'substring' }
  | { stop: false };

/**
 * Decide whether a refinement loop should stop, from the judge's reply.
 *
 * Structured first: `{"decision": "STOP" | "CONTINUE"}` or, in score mode,
 * `{"score": <number>, "stop": <bool>}`. A literal STOP (or `stop: true`)
 * always wins. Then the legacy substring (`includes('stop')`) + `parseFloat`
 * fallback. The reason strings match the originals exactly (callers/tests
 * depend on them).
 */
export function decideLoopJudge(
  reply: string,
  opts: { stopAtScore?: number | null },
): LoopJudgeResult {
  const threshold = opts.stopAtScore;
  const rec = asRecord(extractJson(reply));
  if (rec) {
    const decision =
      typeof rec.decision === 'string' ? rec.decision.trim().toUpperCase() : null;
    if (rec.stop === true || decision === 'STOP') {
      return { stop: true, reason: 'judge said STOP', via: 'json' };
    }
    if (threshold != null && typeof rec.score === 'number') {
      if (rec.score >= threshold) {
        return {
          stop: true,
          reason: `judge score ${rec.score} ≥ stopAtScore ${threshold}`,
          via: 'json',
        };
      }
      return { stop: false }; // structured score below threshold → continue
    }
    if (decision === 'CONTINUE' || rec.stop === false) {
      return { stop: false };
    }
    // Structured but ambiguous (no decision/score/stop) → fall through.
  }

  const lowered = reply.toLowerCase();
  if (lowered.includes('stop')) {
    return { stop: true, reason: 'judge said STOP', via: 'substring' };
  }
  if (threshold != null) {
    const score = parseFloat(reply);
    if (Number.isFinite(score) && score >= threshold) {
      return {
        stop: true,
        reason: `judge score ${score} ≥ stopAtScore ${threshold}`,
        via: 'substring',
      };
    }
  }
  return { stop: false };
}

/** Normalize a switch value/key for matching: trim, strip ONE layer of
 *  wrapping quotes, lower-case. Keeps discrete tokens (`true`, `X`, `"done"`)
 *  comparable without the brittle substring matching `route` uses. */
function normalizeSwitchToken(s: string): string {
  let t = s.trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') ||
      (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t.toLowerCase();
}

/**
 * Decide which `switch` case a value selects. EXACT-match (normalized), never
 * substring — `switch` is for discrete values, so "false" must not match a
 * "true" case. Tries, in order:
 *   1. the whole value, normalized, equals a case key;
 *   2. a structured verdict `{"case"|"value"|"branch"|"result": <key>}`
 *      (covers a script/agent that wraps its answer in JSON, incl. booleans);
 *   3. the last non-empty line (scripts often print the verdict last).
 * Returns the ORIGINAL matching case key, or null when nothing matches
 * (caller falls back to `default`, or errors).
 */
export function decideSwitch(
  value: string,
  caseKeys: string[],
): string | null {
  const byNorm = new Map<string, string>();
  for (const k of caseKeys) byNorm.set(normalizeSwitchToken(k), k);

  // 1. Whole-value exact match.
  const whole = normalizeSwitchToken(value);
  if (byNorm.has(whole)) return byNorm.get(whole)!;

  // 2. Structured verdict.
  const rec = asRecord(extractJson(value));
  if (rec) {
    for (const field of ['case', 'value', 'branch', 'result']) {
      const v = rec[field];
      if (typeof v === 'string') {
        const hit = byNorm.get(normalizeSwitchToken(v));
        if (hit) return hit;
      } else if (typeof v === 'boolean' || typeof v === 'number') {
        const hit = byNorm.get(String(v).toLowerCase());
        if (hit) return hit;
      }
    }
  }

  // 3. Last non-empty line.
  const lines = value
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    const last = byNorm.get(normalizeSwitchToken(lines[lines.length - 1]));
    if (last) return last;
  }

  return null;
}
