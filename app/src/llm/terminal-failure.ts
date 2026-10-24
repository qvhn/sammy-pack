/**
 * terminal-failure — RETRYABLE-vs-TERMINAL phase-failure classification.
 *
 * The motivating failure mode: a per-item loop (reproduce → plan → implement →
 * validate → fail → re-do) can grind dozens of times per item when EVERY item
 * fails its `validate` phase — because the executor's re-run machinery (node
 * `retry`, `onStall` re-run, `onError`, loop `retryOnFailure`, a `request-changes`
 * gate) cannot tell "the fix is wrong, try again" from "the validator/infra is
 * broken, retrying is pointless". So it keeps re-doing fine work. That is a
 * RETRY STORM.
 *
 * This module lets a phase signal that its failure is TERMINAL — do-not-retry —
 * so the storm can't start. It mirrors the existing `retryable` convention used
 * by the durable queues (figma-publish.ts / delivery-worker.ts), where a handler
 * returns `{ ok: false, error, retryable? }` and the worker requeues only when
 * `retryable` is set. Here the polarity is inverted to match the executor's
 * throw-based control flow: a failure is retryable by DEFAULT, and a phase
 * OPTS IN to terminal by marking its failure.
 *
 * Two ways a failure is marked terminal:
 *   1. Structurally — code that throws a {@link TerminalPhaseError} (or any
 *      error carrying a truthy `terminal` property). Internal callers use this.
 *   2. By agent output — a leaf agent that cannot make progress emits a sentinel
 *      in its final text (a `SAMMY-TERMINAL:` line, or a JSON object with
 *      `"terminal": true`). {@link detectTerminalMarker} parses it; the executor
 *      then converts that phase's failure into a TerminalPhaseError so every
 *      re-run site treats it uniformly.
 *
 * The contract every re-run site honors (via {@link isTerminalFailure}):
 *   - node `retry`       → do NOT re-attempt; surface the failure immediately.
 *   - node `onStall`     → a terminal stall is not recovered-and-re-run.
 *   - loop `retryOnFailure` → do NOT re-iterate; stop the loop.
 *   - `request-changes` gate → refuse to force a re-run of a phase that already
 *      declared its failure terminal (a broken validator won't be re-implemented).
 *   - `onError` / `continueOnError` still apply — terminal means "don't REDO the
 *      same work", not "ignore the failure": a recovery branch or a
 *      log-it-and-move-on sibling is a deliberate, different action and still
 *      runs.
 *
 * Absent any marker, every failure stays retryable — the classification is
 * purely opt-in, so it can never make a run give up on work it could redo.
 */

/** Max chars of an agent's terminal-reason text we carry onto the error /
 *  events, so one chatty failing agent can't bloat the run record. */
const TERMINAL_REASON_MAX = 500;

function clipReason(s: string): string {
  const t = s.trim();
  return t.length > TERMINAL_REASON_MAX ? `${t.slice(0, TERMINAL_REASON_MAX)}…` : t;
}

/**
 * A phase failure the executor must NOT retry / re-run. Carries the underlying
 * reason plus an explicit `terminal: true` flag. Thrown by internal code that
 * knows a failure is non-retryable, and synthesized by the executor when a leaf
 * agent emits a terminal marker (see {@link detectTerminalMarker}). Subclasses
 * Error so it flows through the existing `catch (err)` sites unchanged; the
 * re-run sites consult {@link isTerminalFailure} to branch.
 */
export class TerminalPhaseError extends Error {
  /** Discriminant the re-run sites check (duck-typed via isTerminalFailure so a
   *  plain `{ terminal: true }` error from elsewhere is honored too). */
  readonly terminal = true as const;
  /** The bare reason, without the "phase failed (terminal): " framing — handy
   *  for surfacing in an event without the wrapper text. */
  readonly reason: string;
  constructor(reason: string) {
    const r = clipReason(reason || 'phase signalled a terminal (do-not-retry) failure');
    super(r);
    this.name = 'TerminalPhaseError';
    this.reason = r;
  }
}

/**
 * True when an error declares itself terminal (do-not-retry). Duck-typed: any
 * thrown value with a truthy `terminal` property qualifies, so a
 * {@link TerminalPhaseError} AND a bare `Object.assign(new Error(...), { terminal:
 * true })` both work. A non-object / unmarked error is retryable (false) — the
 * default, so unchanged behavior for everything that doesn't opt in.
 */
export function isTerminalFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { terminal?: unknown }).terminal === true
  );
}

/** The literal a leaf agent emits to declare its failure terminal. Matched
 *  case-insensitively, anywhere on a line; the text AFTER the colon (to end of
 *  line) is the human-readable reason. Kept generic + framework-namespaced so it
 *  can't collide with domain output. */
export const TERMINAL_MARKER_PREFIX = 'SAMMY-TERMINAL:';

/** Result of scanning an agent's output for a terminal marker. `reason` is the
 *  text the agent gave (bounded), or a generic default when the marker carried
 *  none. */
export type TerminalMarkerHit = { terminal: true; reason: string };

/**
 * Scan a leaf agent's final output for a terminal (do-not-retry) marker.
 * Returns the parsed hit, or null when no marker is present (the overwhelming
 * common case — so this is a cheap negative for normal output).
 *
 * Two accepted forms, checked in order:
 *   1. A `SAMMY-TERMINAL: <reason>` line anywhere in the text (the simplest
 *      thing an agent can print). Everything after the colon on that line is the
 *      reason.
 *   2. A JSON object on its own line (or the whole output) with a truthy
 *      `terminal` field — `{"terminal": true, "reason": "validator offline"}`.
 *      Mirrors the structured-verdict convention the loop judge / router use
 *      (control-flow.ts), so an agent already emitting a JSON verdict can add one
 *      field. `reason` / `error` / `message` are accepted as the reason key.
 *
 * IMPORTANT: this only fires when the marker is present. It does NOT decide
 * whether the phase failed — the executor calls it ONLY on a phase that already
 * errored (or to upgrade a contract failure), so a SUCCESSFUL phase that merely
 * mentions the marker text in passing is never affected.
 */
export function detectTerminalMarker(output: string | undefined | null): TerminalMarkerHit | null {
  if (typeof output !== 'string' || output.length === 0) return null;

  // Form 1: a SAMMY-TERMINAL: line. Scan line-by-line so the reason is just
  // that line's tail, not the rest of the output.
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.toUpperCase().indexOf(TERMINAL_MARKER_PREFIX);
    if (idx >= 0) {
      const reason = line.slice(idx + TERMINAL_MARKER_PREFIX.length).trim();
      return {
        terminal: true,
        reason: clipReason(reason || 'agent signalled a terminal (do-not-retry) failure'),
      };
    }
  }

  // Form 2: a JSON object with `terminal: true`. Try each line that looks like
  // an object, plus the whole trimmed output, so it works whether the agent
  // printed bare JSON or wrapped it in prose.
  const candidates = [output.trim(), ...lines.map(l => l.trim())];
  for (const c of candidates) {
    if (!(c.startsWith('{') && c.endsWith('}'))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { terminal?: unknown }).terminal === true
    ) {
      const obj = parsed as { reason?: unknown; error?: unknown; message?: unknown };
      const reasonRaw =
        (typeof obj.reason === 'string' && obj.reason) ||
        (typeof obj.error === 'string' && obj.error) ||
        (typeof obj.message === 'string' && obj.message) ||
        '';
      return {
        terminal: true,
        reason: clipReason(reasonRaw || 'agent signalled a terminal (do-not-retry) failure'),
      };
    }
  }

  return null;
}

// ── External signal kills ────────────────────────────────────────────────

/** Exit codes 128+N mean "killed by signal N". The two that reach the SDK
 *  subprocess from OUTSIDE the run — an operator kill or the host shedding
 *  memory pressure — are SIGTERM (143) and SIGKILL (137). SIGSEGV (139)
 *  and friends stay ordinary errors: those are crashes, not kills. */
const SIGNAL_EXIT_NAMES: Record<string, string> = {
  '137': 'SIGKILL',
  '143': 'SIGTERM',
};

/**
 * Classify an error message as an EXTERNAL signal kill of a subprocess.
 * Returns the signal name (e.g. "SIGTERM") or null.
 *
 * Why it matters: "Claude Code process exited with code 143" — host memory
 * pressure SIGTERMing the SDK subprocess — otherwise reads identically to an
 * agent failure and leaves the run terminal `error`, i.e. not resumable,
 * when nothing about the work itself failed. An externally-killed subprocess is
 * exactly the crash case checkpoints + resume were built for, so the
 * run-controller uses this to mark such terminals `interrupted` instead:
 * resumable in one click, completed leaves replayed. Matches both the
 * "exited with code N" shape (SDK subprocess, code.run scripts) and an
 * explicit "killed by SIG…"/"signal SIG…" mention.
 */
export function externalKillSignal(message: string): string | null {
  const named = /\b(?:killed by|signal)\s+(SIGTERM|SIGKILL)\b/i.exec(message);
  if (named) return named[1].toUpperCase();
  const code = /\bexited with code (\d{3})\b/.exec(message);
  if (code && SIGNAL_EXIT_NAMES[code[1]]) return SIGNAL_EXIT_NAMES[code[1]];
  return null;
}

// ── SDK result classification ────────────────────────────────────────────

/** The outcome fields the Claude Agent SDK reports on its terminal `result`
 *  message. Captured structurally rather than by string-matching the error
 *  text, where a `529` overload is indistinguishable from a real failure. */
export type SdkResultOutcome = {
  /** `success`, `error_max_turns`, `error_max_budget_usd`,
   *  `error_during_execution`, `error_max_structured_output_retries`, … */
  subtype?: string;
  /** `api_error`, `malformed_tool_use_exhausted`, `budget_exhausted`,
   *  `structured_output_retry_exhausted`, `tool_deferred_unavailable`,
   *  `turn_setup_failed`, … */
  terminalReason?: string;
  /** HTTP status when the turn died on an API error — 529 = overloaded. */
  apiErrorStatus?: number;
  /** `refusal` when the model declined the request. */
  stopReason?: string;
};

export type SdkResultVerdict = {
  /** True when re-running the SAME call cannot plausibly succeed, so the
   *  phase should skip its retries and surface immediately. */
  terminal: boolean;
  /** True for the SDK's own "ran out of turns" outcome, which the executor
   *  treats as a pause-point rather than a failure. */
  maxTurns: boolean;
  reason: string;
};

/**
 * Classify a non-success SDK result into retryable vs terminal, using the
 * SDK's structured outcome fields.
 *
 * Why this matters: a retry costs a full agent turn. Retrying a refusal or
 * an exhausted structured-output budget burns money to reproduce the same
 * answer, while NOT retrying a 529 overload fails a phase that would have
 * succeeded a second later.
 *
 * Returns null for a successful result (nothing to classify).
 */
export function classifySdkResult(
  outcome: SdkResultOutcome,
): SdkResultVerdict | null {
  const { subtype, terminalReason, apiErrorStatus, stopReason } = outcome;
  if (!subtype || subtype === 'success') return null;

  if (subtype === 'error_max_turns') {
    return {
      terminal: false,
      maxTurns: true,
      reason: 'agent reached its maximum number of turns',
    };
  }
  if (stopReason === 'refusal') {
    return {
      terminal: true,
      maxTurns: false,
      reason:
        'the model REFUSED this request — retrying would reproduce the same ' +
        'refusal at full cost; change the prompt or the task',
    };
  }
  if (
    subtype === 'error_max_budget_usd' ||
    terminalReason === 'budget_exhausted'
  ) {
    return {
      terminal: true,
      maxTurns: false,
      reason:
        'the agent exhausted its SDK spend budget — retrying re-spends it; ' +
        'raise the budget or shrink the work',
    };
  }
  if (
    subtype === 'error_max_structured_output_retries' ||
    terminalReason === 'structured_output_retry_exhausted'
  ) {
    return {
      terminal: true,
      maxTurns: false,
      reason:
        'the agent could not produce output matching its structured-output ' +
        'schema after the SDK’s own retries — the schema or prompt is wrong',
    };
  }
  if (terminalReason === 'malformed_tool_use_exhausted') {
    return {
      terminal: true,
      maxTurns: false,
      reason:
        'the agent kept emitting malformed tool calls until the SDK gave up — ' +
        'usually a tool-schema or prompt problem, not bad luck',
    };
  }
  // Transient classes: an API error (notably 529 overloaded) and setup /
  // tool-availability hiccups are exactly what `retry` exists for.
  if (typeof apiErrorStatus === 'number' && apiErrorStatus >= 500) {
    return {
      terminal: false,
      maxTurns: false,
      reason: `transient API error ${apiErrorStatus}${apiErrorStatus === 529 ? ' (overloaded)' : ''} — retryable`,
    };
  }
  if (
    terminalReason === 'api_error' ||
    terminalReason === 'turn_setup_failed' ||
    terminalReason === 'tool_deferred_unavailable'
  ) {
    return {
      terminal: false,
      maxTurns: false,
      reason: `transient SDK failure (${terminalReason}) — retryable`,
    };
  }
  // Unknown subtype: stay retryable. Over-classifying as terminal would
  // silently disable a phase's configured retries.
  return {
    terminal: false,
    maxTurns: false,
    reason: `agent turn ended as "${subtype}"${terminalReason ? ` (${terminalReason})` : ''}`,
  };
}
