/**
 * Shared eval scoring — the module that lets `sammy eval` reproduce the
 * Evals page's verdicts exactly.
 *
 * Scoring used to live only in `pages/EvalsPage.tsx`, so evals could be
 * watched but never ENFORCED: no headless runner meant no CI gate, and a
 * regression could not fail a build. These tests pin the semantics both
 * surfaces now share — including the two that silently decide outcomes:
 * the pass rule (EVERY scorer ≥ threshold) and judge-reply parsing
 * (keywords beat digits; anything ambiguous scores 0).
 */

import {
  PASS_THRESHOLD,
  agentSystemPrompt,
  judgeRequest,
  parseJudgeReply,
  rowPassed,
  scoreDeterministic,
  scorerKey,
  summarize,
  type EvalRowResult,
} from '../src/lib/eval-scoring';
import type { Scorer } from '../src/api';

describe('deterministic scorers', () => {
  test('exact compares trimmed output to the expected label', () => {
    const scorers: Scorer[] = [{ type: 'exact' }];
    expect(scoreDeterministic('  isolated \n', 'isolated', scorers)).toEqual({
      'exact#0': 1,
    });
    expect(scoreDeterministic('wide', 'isolated', scorers)).toEqual({
      'exact#0': 0,
    });
  });

  test('contains falls back to the expected label when no substring is given', () => {
    expect(
      scoreDeterministic('the verdict is PASS', undefined, [
        { type: 'contains', substring: 'PASS' },
      ]),
    ).toEqual({ 'contains#0': 1 });
    // No substring configured → the dataset's expected output is the needle.
    expect(
      scoreDeterministic('the verdict is PASS', 'PASS', [{ type: 'contains' }]),
    ).toEqual({ 'contains#0': 1 });
  });

  test('regex honors flags, and a malformed pattern scores 0 instead of throwing', () => {
    expect(
      scoreDeterministic('Converged Board', undefined, [
        { type: 'regex', pattern: '^converged', flags: 'i' },
      ]),
    ).toEqual({ 'regex#0': 1 });
    // One bad scorer must not abort a whole sweep.
    expect(
      scoreDeterministic('anything', undefined, [
        { type: 'regex', pattern: '([unclosed' },
      ]),
    ).toEqual({ 'regex#0': 0 });
  });

  test('llm-judge keys are ABSENT — a caller that skips the judge cannot pass by default', () => {
    const scores = scoreDeterministic('out', 'out', [
      { type: 'exact' },
      { type: 'llm-judge', judgeAgent: 'agents/j.md', criteria: 'is it good' },
    ]);
    expect(scores).toEqual({ 'exact#0': 1 });
    expect(Object.keys(scores)).not.toContain('llm-judge#1');
  });

  test('scorer keys are index-qualified so duplicates stay distinct', () => {
    const scorers: Scorer[] = [
      { type: 'contains', substring: 'a' },
      { type: 'contains', substring: 'zzz' },
    ];
    expect(scoreDeterministic('a', undefined, scorers)).toEqual({
      'contains#0': 1,
      'contains#1': 0,
    });
    expect(scorerKey(scorers[1], 1)).toBe('contains#1');
  });
});

describe('pass rule', () => {
  test('a row passes only when EVERY scorer clears the threshold', () => {
    expect(rowPassed({ a: 1, b: 1 })).toBe(true);
    expect(rowPassed({ a: 1, b: 0 })).toBe(false);
    expect(rowPassed({ a: PASS_THRESHOLD })).toBe(true);
    expect(rowPassed({ a: PASS_THRESHOLD - 0.01 })).toBe(false);
  });

  test('no scores at all is a FAIL (e.g. the orchestration errored)', () => {
    expect(rowPassed({})).toBe(false);
  });
});

describe('judge prompt + reply parsing', () => {
  test('the judge prompt carries output, expected and criteria', () => {
    const { system, user } = judgeRequest(
      { type: 'llm-judge', judgeAgent: 'agents/j.md', criteria: 'be strict' },
      'JUDGE SYSTEM',
      'the output',
      'the expectation',
    );
    expect(system).toBe('JUDGE SYSTEM');
    expect(user).toContain('the output');
    expect(user).toContain('the expectation');
    expect(user).toContain('be strict');
    expect(user).toMatch(/PASS, FAIL/);
  });

  test('an empty output is labelled rather than sent blank', () => {
    const { user } = judgeRequest(
      { type: 'llm-judge', judgeAgent: 'a', criteria: '' },
      'sys',
      '',
      undefined,
    );
    expect(user).toContain('(empty)');
    expect(user).not.toContain('## EXPECTED');
  });

  test('PASS/FAIL keywords beat digits; ambiguity and errors score 0', () => {
    expect(parseJudgeReply('PASS')).toBe(1);
    expect(parseJudgeReply('fail')).toBe(0);
    // The trap this rule exists for: a numeric-looking failure verdict.
    expect(parseJudgeReply('0/5 — FAIL')).toBe(0);
    expect(parseJudgeReply('score 5/5 — PASS')).toBe(1);
    // Both keywords, or neither, is ambiguous → 0 (flag, don't pass).
    expect(parseJudgeReply('pass or fail? unclear')).toBe(0);
    expect(parseJudgeReply('')).toBe(0);
    // Bare numerics are honored and clamped to 0..1.
    expect(parseJudgeReply('0.75')).toBe(0.75);
    expect(parseJudgeReply('42')).toBe(1);
  });

  test('agentSystemPrompt strips frontmatter, leaving the judge body', () => {
    expect(agentSystemPrompt('---\nname: j\n---\nYou are a judge.')).toBe(
      'You are a judge.',
    );
    expect(agentSystemPrompt('No frontmatter here.')).toBe('No frontmatter here.');
  });
});

describe('summarize', () => {
  const rows: EvalRowResult[] = [
    { rowId: 'a', pass: true, scores: { 'exact#0': 1 } },
    { rowId: 'b', pass: false, scores: { 'exact#0': 0 } },
    { rowId: 'c', pass: true, scores: { 'exact#0': 1 } },
  ];

  test('aggregates pass rate and per-scorer means', () => {
    const s = summarize(rows);
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(s.passRate).toBeCloseTo(2 / 3);
    // Per-scorer mean is what tells you WHICH scorer dragged the suite down.
    expect(s.byScorer['exact#0']).toBeCloseTo(2 / 3);
  });

  test('an empty run proves nothing — pass rate 0, not 1', () => {
    expect(summarize([])).toMatchObject({ total: 0, passed: 0, passRate: 0 });
  });
});
