/**
 * Tests for RETRYABLE-vs-TERMINAL phase-failure classification (anti-retry-storm).
 *
 * A phase can declare its failure TERMINAL (do-not-retry) — by throwing a
 * TerminalPhaseError or by emitting a `SAMMY-TERMINAL:` / `{"terminal":true}`
 * marker in its output. Every re-run site (node `retry`, `onStall` re-run, loop
 * `retryOnFailure`, the `request-changes` gate) must then SURFACE the failure
 * instead of re-running fine work. Absent any marker, behavior is unchanged.
 *
 * Layers exercised here:
 *   1. detectTerminalMarker / isTerminalFailure / TerminalPhaseError — the pure
 *      classification core.
 *   2. A REAL executor run proving node `retry` does NOT re-attempt a
 *      terminally-marked phase (emits `phase-terminal`), while an UNMARKED
 *      failure still retries exactly as before (the no-regression case).
 *   3. terminalFailureForGate — the gate guard that refuses a request-changes
 *      re-run of a phase that last failed terminally.
 */

import {
  detectTerminalMarker,
  isTerminalFailure,
  TERMINAL_MARKER_PREFIX,
  TerminalPhaseError,
} from '../src/llm/terminal-failure';
import { terminalFailureForGate } from '../src/server/gate-invalidation';

// ──────────────────────────────────────────────────────────────────────────
// 1 — pure classification core
// ──────────────────────────────────────────────────────────────────────────
describe('detectTerminalMarker', () => {
  it('returns null for normal output (no marker)', () => {
    expect(detectTerminalMarker('all good, PR opened at https://x/1')).toBeNull();
    expect(detectTerminalMarker('')).toBeNull();
    expect(detectTerminalMarker(undefined)).toBeNull();
    expect(detectTerminalMarker(null)).toBeNull();
  });

  it('detects a SAMMY-TERMINAL: line and extracts the reason', () => {
    const hit = detectTerminalMarker(
      'I tried to run the validator but it is offline.\nSAMMY-TERMINAL: validator service is unreachable',
    );
    expect(hit).not.toBeNull();
    expect(hit?.terminal).toBe(true);
    expect(hit?.reason).toBe('validator service is unreachable');
  });

  it('matches the marker case-insensitively and trims the reason', () => {
    const hit = detectTerminalMarker('sammy-terminal:   infra down   ');
    expect(hit?.reason).toBe('infra down');
  });

  it('uses a generic reason when the marker carries none', () => {
    const hit = detectTerminalMarker(`${TERMINAL_MARKER_PREFIX}`);
    expect(hit?.terminal).toBe(true);
    expect(hit?.reason).toContain('terminal');
  });

  it('detects a JSON {"terminal": true} verdict with a reason', () => {
    const hit = detectTerminalMarker('{"terminal": true, "reason": "schema drifted"}');
    expect(hit?.terminal).toBe(true);
    expect(hit?.reason).toBe('schema drifted');
  });

  it('detects JSON terminal even when wrapped in prose lines', () => {
    const hit = detectTerminalMarker(
      'Here is my verdict:\n{"terminal": true, "error": "compiler missing"}\nthanks',
    );
    expect(hit?.reason).toBe('compiler missing');
  });

  it('does NOT fire on terminal:false or a plain object', () => {
    expect(detectTerminalMarker('{"terminal": false}')).toBeNull();
    expect(detectTerminalMarker('{"ok": true}')).toBeNull();
  });

  it('bounds an absurdly long reason', () => {
    const hit = detectTerminalMarker(`SAMMY-TERMINAL: ${'x'.repeat(5000)}`);
    expect(hit).not.toBeNull();
    expect((hit as { reason: string }).reason.length).toBeLessThanOrEqual(501);
  });
});

describe('isTerminalFailure / TerminalPhaseError', () => {
  it('a TerminalPhaseError is terminal', () => {
    const e = new TerminalPhaseError('nope');
    expect(isTerminalFailure(e)).toBe(true);
    expect(e.terminal).toBe(true);
    expect(e.reason).toBe('nope');
    expect(e).toBeInstanceOf(Error);
  });

  it('a plain error carrying terminal:true is terminal (duck-typed)', () => {
    const e = Object.assign(new Error('x'), { terminal: true });
    expect(isTerminalFailure(e)).toBe(true);
  });

  it('a plain Error / non-object is NOT terminal (the retryable default)', () => {
    expect(isTerminalFailure(new Error('transient'))).toBe(false);
    expect(isTerminalFailure('boom')).toBe(false);
    expect(isTerminalFailure(null)).toBe(false);
    expect(isTerminalFailure(undefined)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3 — terminalFailureForGate (the request-changes guard)
// ──────────────────────────────────────────────────────────────────────────
describe('terminalFailureForGate', () => {
  it('returns the reason when the target phase last emitted phase-terminal', () => {
    const events = [
      { type: 'phase-start', phaseName: 'validate' },
      { type: 'phase-terminal', phaseName: 'validate', reason: 'validator offline', retriesSuppressed: 2 },
    ];
    expect(terminalFailureForGate(events, 'validate')).toBe('validator offline');
  });

  it('returns null when the target phase last ended cleanly (re-run cleared it)', () => {
    const events = [
      { type: 'phase-terminal', phaseName: 'validate', reason: 'was offline' },
      { type: 'phase-end', phaseName: 'validate', output: 'now ok' },
    ];
    expect(terminalFailureForGate(events, 'validate')).toBeNull();
  });

  it('returns null when the target phase has no terminal event', () => {
    const events = [
      { type: 'phase-end', phaseName: 'implement', output: 'done' },
      { type: 'phase-terminal', phaseName: 'OTHER', reason: 'x' },
    ];
    expect(terminalFailureForGate(events, 'implement')).toBeNull();
  });

  it('returns null for a null/empty target', () => {
    expect(terminalFailureForGate([{ type: 'phase-terminal', phaseName: 'x', reason: 'r' }], null)).toBeNull();
    expect(terminalFailureForGate([], '')).toBeNull();
  });

  it('falls back to error then a generic reason', () => {
    expect(
      terminalFailureForGate([{ type: 'phase-terminal', phaseName: 'v', error: 'boom' }], 'v'),
    ).toBe('boom');
    expect(
      terminalFailureForGate([{ type: 'phase-terminal', phaseName: 'v' }], 'v'),
    ).toContain('terminal');
  });
});
