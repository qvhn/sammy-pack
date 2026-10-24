/**
 * Eval scoring — the single source of truth, shared by the Evals page and
 * the headless CLI runner.
 *
 * WHY THIS MODULE EXISTS: scoring that lives only inside
 * `pages/EvalsPage.tsx` lives only in the browser. Evals can then be
 * authored and run by a human clicking a button, but never headlessly — so
 * a regression can never fail a build, and an eval suite you cannot gate CI
 * on is a dashboard, not a test. Keeping the pure parts here lets `sammy
 * eval` reproduce the UI's verdicts EXACTLY (same scorers, same keys, same
 * pass rule) instead of growing a second, subtly-different implementation.
 *
 * Deterministic scorers (exact / contains / regex) are pure and live here
 * in full. The `llm-judge` scorer needs a model round-trip, so this module
 * owns its PROMPT and its REPLY PARSING — the two parts that must not
 * drift — while each surface supplies its own transport (the browser's
 * stream fn; the CLI's `/api/llm/stream` POST).
 */

import type { Scorer } from '../api';

/** A per-scorer score at or above this counts as a pass for that scorer. */
export const PASS_THRESHOLD = 0.5;

/** Stable per-scorer key (`exact#0`, `llm-judge#2`). Index-qualified so two
 *  scorers of the same type stay distinguishable in the score map. */
export function scorerKey(scorer: Scorer, index: number): string {
  return `${scorer.type}#${index}`;
}

/**
 * Score one row's output against its expected output with the DETERMINISTIC
 * scorers. `llm-judge` scorers are deliberately absent from the result —
 * the caller fills them in via {@link judgeRequest} + {@link parseJudgeReply}
 * — so a caller that forgets cannot silently "pass" a judged eval on
 * deterministic scores alone.
 */
export function scoreDeterministic(
  output: string,
  expected: string | undefined,
  scorers: ReadonlyArray<Scorer>,
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (let i = 0; i < scorers.length; i++) {
    const s = scorers[i];
    const key = scorerKey(s, i);
    if (s.type === 'exact') {
      scores[key] = output.trim() === (expected ?? '').trim() ? 1 : 0;
    } else if (s.type === 'contains') {
      const needle = (s.substring ?? expected ?? '').trim();
      scores[key] = needle && output.includes(needle) ? 1 : 0;
    } else if (s.type === 'regex') {
      try {
        scores[key] = new RegExp(s.pattern, s.flags ?? '').test(output) ? 1 : 0;
      } catch {
        // A malformed pattern scores 0 rather than throwing: one bad
        // scorer must not abort a whole eval sweep.
        scores[key] = 0;
      }
    }
    // llm-judge: intentionally not set here.
  }
  return scores;
}

/** The judge call for one `llm-judge` scorer: the system prompt (the judge
 *  agent's body) and the user message carrying output + expected +
 *  criteria. Shared so the UI and the CLI ask the judge the SAME question —
 *  otherwise the same eval scores differently depending on who ran it. */
export function judgeRequest(
  scorer: Extract<Scorer, { type: 'llm-judge' }>,
  judgeSystemPrompt: string,
  output: string,
  expected: string | undefined,
): { system: string; user: string } {
  const user = [
    `## OUTPUT to evaluate`,
    '```',
    output || '(empty)',
    '```',
    '',
    ...(expected ? ['## EXPECTED', '```', expected, '```', ''] : []),
    `## CRITERIA`,
    scorer.criteria || '(use your best judgement)',
    '',
    `Reply with exactly one of: PASS, FAIL.`,
    `Or, if you prefer, a single number between 0 and 1 (1 = perfect, 0 = wrong).`,
  ].join('\n');
  return { system: judgeSystemPrompt, user };
}

/** Strip a `---` frontmatter block from an agent file, leaving its body —
 *  which is the judge's system prompt. */
export function agentSystemPrompt(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : raw).trim();
}

/** Parse a judge's reply into 0..1. PASS/FAIL keywords win over numeric
 *  parsing so "0/5 — FAIL" isn't read as the number 0... and, more
 *  importantly, so "PASS" isn't missed because the text also contains
 *  digits. An empty, errored or ambiguous reply scores 0 — better to flag
 *  a row than to pass it silently. */
export function parseJudgeReply(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return 0;
  if (/\bpass\b/.test(t) && !/\bfail\b/.test(t)) return 1;
  if (/\bfail\b/.test(t) && !/\bpass\b/.test(t)) return 0;
  const m = t.match(/(?:^|\s)(\d+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (!Number.isNaN(n)) return Math.min(1, Math.max(0, n));
  }
  return 0;
}

/** A row passes when EVERY scorer is at or above the threshold. A row that
 *  produced no scores at all (e.g. the orchestration errored) fails. */
export function rowPassed(scores: Record<string, number>): boolean {
  const values = Object.values(scores);
  if (values.length === 0) return false;
  return values.every(s => s >= PASS_THRESHOLD);
}

export type EvalRowResult = {
  rowId: string;
  pass: boolean;
  scores: Record<string, number>;
  output?: string;
  expectedOutput?: string;
  error?: string;
  durationMs?: number;
};

export type EvalSummary = {
  total: number;
  passed: number;
  failed: number;
  /** 0..1; 0 for an empty dataset (nothing proven, so nothing passes). */
  passRate: number;
  /** Mean score per scorer key — shows WHICH scorer is dragging a suite
   *  down when the pass rate alone just says "something regressed". */
  byScorer: Record<string, number>;
};

export function summarize(
  rows: ReadonlyArray<EvalRowResult>,
): EvalSummary {
  const passed = rows.filter(r => r.pass).length;
  const totals: Record<string, { sum: number; n: number }> = {};
  for (const r of rows) {
    for (const [key, value] of Object.entries(r.scores)) {
      const t = (totals[key] ??= { sum: 0, n: 0 });
      t.sum += value;
      t.n += 1;
    }
  }
  const byScorer: Record<string, number> = {};
  for (const [key, t] of Object.entries(totals)) {
    byScorer[key] = t.n > 0 ? t.sum / t.n : 0;
  }
  return {
    total: rows.length,
    passed,
    failed: rows.length - passed,
    passRate: rows.length > 0 ? passed / rows.length : 0,
    byScorer,
  };
}
