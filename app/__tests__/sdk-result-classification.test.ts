/**
 * Structured classification of the Claude Agent SDK's terminal `result`
 * message.
 *
 * Two problems this replaces:
 *   1. A non-success result was SILENTLY IGNORED — the stream ended, `done`
 *      was yielded, and the executor treated a failed turn as a successful
 *      phase carrying whatever partial text had streamed. (Same family as
 *      the "turn-end == phase-end" silent-partial bug.)
 *   2. Retryability was decided by matching the error STRING (max-turns) or
 *      an agent-emitted sentinel. The SDK reports `subtype`,
 *      `terminal_reason`, `api_error_status` and `stop_reason`; a retry
 *      costs a whole agent turn, so the decision should use them.
 */

import { classifySdkResult, isTerminalFailure, TerminalPhaseError } from '../src/llm/terminal-failure';

describe('classifySdkResult', () => {
  test('a successful result classifies as nothing to do', () => {
    expect(classifySdkResult({ subtype: 'success' })).toBeNull();
    expect(classifySdkResult({})).toBeNull();
  });

  test('max-turns is a pause-point, not a failure', () => {
    const v = classifySdkResult({ subtype: 'error_max_turns' })!;
    expect(v.maxTurns).toBe(true);
    expect(v.terminal).toBe(false);
  });

  describe('TERMINAL — retrying cannot plausibly succeed', () => {
    test('a refusal (retrying reproduces it at full cost)', () => {
      const v = classifySdkResult({
        subtype: 'error_during_execution',
        stopReason: 'refusal',
      })!;
      expect(v.terminal).toBe(true);
      expect(v.reason).toMatch(/refus/i);
    });

    test('an exhausted SDK spend budget', () => {
      expect(classifySdkResult({ subtype: 'error_max_budget_usd' })!.terminal).toBe(true);
      expect(
        classifySdkResult({
          subtype: 'error_during_execution',
          terminalReason: 'budget_exhausted',
        })!.terminal,
      ).toBe(true);
    });

    test('structured-output retries exhausted (schema/prompt is wrong)', () => {
      expect(
        classifySdkResult({ subtype: 'error_max_structured_output_retries' })!.terminal,
      ).toBe(true);
    });

    test('malformed tool calls until the SDK gave up', () => {
      const v = classifySdkResult({
        subtype: 'error_during_execution',
        terminalReason: 'malformed_tool_use_exhausted',
      })!;
      expect(v.terminal).toBe(true);
      expect(v.reason).toMatch(/tool-schema|malformed/i);
    });
  });

  describe('RETRYABLE — a second attempt plausibly succeeds', () => {
    test('529 overloaded is the canonical retry case', () => {
      const v = classifySdkResult({
        subtype: 'error_during_execution',
        apiErrorStatus: 529,
      })!;
      expect(v.terminal).toBe(false);
      expect(v.reason).toMatch(/overloaded/i);
    });

    test('any 5xx API error, and transient setup failures', () => {
      expect(
        classifySdkResult({ subtype: 'error_during_execution', apiErrorStatus: 503 })!
          .terminal,
      ).toBe(false);
      for (const terminalReason of [
        'api_error',
        'turn_setup_failed',
        'tool_deferred_unavailable',
      ]) {
        expect(
          classifySdkResult({ subtype: 'error_during_execution', terminalReason })!
            .terminal,
        ).toBe(false);
      }
    });

    test('an UNKNOWN subtype stays retryable — over-classifying would silently disable retries', () => {
      const v = classifySdkResult({ subtype: 'error_something_new_in_a_later_sdk' })!;
      expect(v.terminal).toBe(false);
      expect(v.reason).toContain('error_something_new_in_a_later_sdk');
    });
  });

  test('terminal verdicts travel as TerminalPhaseError, which the executor recognizes', () => {
    // This is the contract sdk-stream relies on: a terminal verdict is
    // thrown as TerminalPhaseError so the executor skips the phase's
    // retries instead of paying for the same failure N more times.
    const v = classifySdkResult({ subtype: 'error_max_budget_usd' })!;
    const err = new TerminalPhaseError(v.reason);
    expect(isTerminalFailure(err)).toBe(true);
    expect(isTerminalFailure(new Error(v.reason))).toBe(false);
  });
});
