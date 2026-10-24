/**
 * notify — outbound on-terminal webhook for a run.
 *
 * An orchestration root may declare `notify: { onTerminal: "<url>" }`. When a
 * run reaches a terminal status (done / error / cancelled / paused), the
 * server's terminal hook POSTs a small JSON envelope to that URL so an
 * unattended run (a nightly sweep) can ping Slack / an internal collector
 * instead of finishing silently.
 *
 * This module is the single, testable seam for that behavior: it builds the
 * payload and fires the POST. It is deliberately framework-agnostic (no store,
 * no run engine) and BEST-EFFORT — a slow / dead / misconfigured endpoint must
 * NEVER block or fail run finalization, so the fetch is not awaited and every
 * error (including a thrown URL parse) is swallowed.
 */

import type { NotifyConfig } from '../types';
import {
  formatDegradationSummary,
  type DegradationReason,
} from './degradation';
import {
  formatDivergenceSummary,
  type DivergenceResult,
} from './divergence';
import { formatRunNotes, type RunNotes } from './run-notes';
import type { RunStatus } from './run-store';

/** Max chars of the run's last output folded into the notification as
 *  `summary`. Bounded so a chatty run can't push a huge body to the webhook. */
export const NOTIFY_SUMMARY_MAX_CHARS = 2000;

export type TerminalNotifyInput = {
  /** The orchestration root's `notify` block (may be undefined / empty). */
  notify: NotifyConfig | undefined;
  runId: string;
  /** Orchestration name. */
  orchestration: string;
  status: RunStatus;
  /** The run's last output, if any — folded in (bounded tail) as `summary`. */
  lastOutput?: string | null;
  /** "done-but-degraded" verdict (Feature: done-degraded signal). When the run
   *  finished `done` but swallowed an error / finalized partials / took a
   *  fallback, this is true and `degradationReasons` explains why. Surfaced in
   *  the payload (machine-readable) and prepended to `summary` (human-readable)
   *  so an unattended notify can't report a degraded run as a clean success.
   *  Omitted / false for a clean run — exactly the prior envelope. */
  degraded?: boolean;
  degradationReasons?: DegradationReason[];
  /** Run-level thrash / retry-storm verdict. When the run thrashed, a `RETRY
   *  STORM: …` line is prepended to `summary` and the structured `divergence`
   *  field is set. Omitted / clean ⇒ no change to the envelope. */
  divergence?: DivergenceResult;
  /** Structured run-end summary (per-item verdicts + totals). Its compact text
   *  form is appended to `summary`, and the structured object is attached as
   *  `notes`. Omitted ⇒ no change to the envelope. */
  notes?: RunNotes;
};

/** The JSON envelope POSTed to `notify.onTerminal`. */
export type TerminalNotifyPayload = {
  runId: string;
  orchestration: string;
  status: RunStatus;
  summary?: string;
  /** True only on a degraded `done` run; omitted otherwise so a clean run's
   *  envelope is byte-identical to before this feature. */
  degraded?: boolean;
  /** Per-phase degradation reasons; present only when `degraded`. */
  degradationReasons?: DegradationReason[];
  /** Run-level thrash verdict; present only when the run diverged (thrashed). */
  divergence?: DivergenceResult;
  /** Structured run-end summary; present only when notes were supplied. */
  notes?: RunNotes;
};

/** Build the notification envelope. `summary` is a bounded tail of the run's
 *  last output, omitted when there is none. When the run is degraded, a
 *  `DEGRADED (N): …` line is PREPENDED to `summary` (so a Slack reader sees it
 *  first) and the structured `degraded` / `degradationReasons` fields are set.
 *  Pure — no I/O. */
export function buildTerminalNotifyPayload(
  input: TerminalNotifyInput,
): TerminalNotifyPayload {
  const { runId, orchestration, status, lastOutput } = input;
  const payload: TerminalNotifyPayload = { runId, orchestration, status };
  const degraded = input.degraded === true;
  const reasons = degraded ? (input.degradationReasons ?? []) : [];
  const degradedLine = degraded
    ? formatDegradationSummary({ degraded, reasons })
    : '';
  // Run-level thrash banner — loudest, so it leads the summary.
  const diverged = input.divergence?.diverged === true;
  const divergenceLine = diverged
    ? formatDivergenceSummary(input.divergence as DivergenceResult)
    : '';
  // Structured run-end summary as a compact plain-text block.
  const notesText = input.notes ? formatRunNotes(input.notes) : '';
  const tail =
    typeof lastOutput === 'string' && lastOutput.length > 0
      ? lastOutput.slice(-NOTIFY_SUMMARY_MAX_CHARS)
      : '';
  // Compose: divergence banner, then degraded banner, then the run-notes block,
  // then the output tail — each only when present, newline-joined. Order is
  // loudest-first so a Slack reader sees the storm / degradation before detail.
  const summary = [divergenceLine, degradedLine, notesText, tail]
    .filter(s => s.length > 0)
    .join('\n');
  if (summary) payload.summary = summary;
  if (degraded) {
    payload.degraded = true;
    payload.degradationReasons = reasons;
  }
  if (diverged) payload.divergence = input.divergence;
  if (input.notes) payload.notes = input.notes;
  return payload;
}

/** Minimal fetch shape this module needs — lets a test inject a spy. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<unknown>;

/** The shared best-effort POST both notify paths ride: fire-and-forget (not
 *  awaited — a slow / dead endpoint must not hold up the caller), every
 *  rejection swallowed, a synchronous throw from the fetch impl caught.
 *  Returns true only when a fetch was actually kicked off. */
function postBestEffort(
  url: string,
  payload: unknown,
  fetchImpl?: FetchLike,
): boolean {
  const doFetch =
    fetchImpl ??
    (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return false;
  try {
    void Promise.resolve(
      doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    ).catch(() => {
      /* notify endpoint unreachable — drop silently */
    });
  } catch {
    /* synchronous throw from the fetch impl — swallow, best-effort */
    return false;
  }
  return true;
}

/**
 * Fire the on-terminal notification if one is configured. Returns true when a
 * POST was dispatched (a URL was present), false when there was nothing to do.
 * BEST-EFFORT: the returned boolean reflects only whether a fetch was kicked
 * off — the fetch itself is fire-and-forget (not awaited) and any rejection is
 * swallowed, so a dead endpoint never surfaces here. A synchronous throw from
 * the fetch impl is likewise caught.
 */
export function fireTerminalNotify(
  input: TerminalNotifyInput,
  fetchImpl?: FetchLike,
): boolean {
  const url = input.notify?.onTerminal;
  if (typeof url !== 'string' || url.length === 0) return false;
  return postBestEffort(url, buildTerminalNotifyPayload(input), fetchImpl);
}

// ── Stale-gate notification ────────────────────────────────────────────────
//
// A run paused at a human gate past the stale-gate TTL (SAMMY_GATE_TTL_HOURS)
// is invisible by default — it never reaches a terminal status, so the
// on-terminal webhook above never fires, while the run silently holds its
// concurrency group and queues every later fire behind it. This is the same
// out-of-band signal for THAT case: reuse the orchestration's one configured
// sink (`notify.onTerminal` — a stale gate is an "attention needed" condition
// for exactly the audience that URL already reaches) with an unmistakably
// distinct envelope (`stale: true`, status 'paused', a STALE GATE summary).

export type GateStaleNotifyInput = {
  /** The orchestration root's `notify` block (from the run's snapshot). */
  notify: NotifyConfig | undefined;
  runId: string;
  orchestration: string;
  /** The gated phase the run is waiting at, if known. */
  pausedFor: string | null;
  /** EPOCH ms the run paused (not a duration). */
  pausedSinceMs: number;
  /** The configured TTL that was crossed, ms. */
  ttlMs: number;
  /** What the sweeper is configured to do ('cancel' ⇒ the run is about to be
   *  auto-cancelled; folded into the summary so the reader knows). */
  action: 'notify' | 'cancel';
};

/** The JSON envelope POSTed for a stale gate. `stale: true` + status
 *  'paused' distinguish it structurally from every terminal envelope. */
export type GateStaleNotifyPayload = {
  runId: string;
  orchestration: string;
  status: 'paused';
  stale: true;
  pausedFor: string | null;
  /** EPOCH ms the run paused. */
  pausedSinceMs: number;
  summary: string;
};

/** Render a millisecond span as a compact human age ("3.2h", "5.9d"). */
function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(1)}h`;
}

/** Build the stale-gate envelope. Pure — no I/O. `now` is injectable so the
 *  summary's age is deterministic under test. */
export function buildGateStaleNotifyPayload(
  input: GateStaleNotifyInput,
  now: number = Date.now(),
): GateStaleNotifyPayload {
  const age = formatAge(Math.max(0, now - input.pausedSinceMs));
  const ttl = formatAge(input.ttlMs);
  const tail =
    input.action === 'cancel'
      ? ' — auto-cancelling (SAMMY_GATE_TTL_ACTION=cancel), which frees its concurrency group.'
      : ' — it still holds its concurrency group; approve or reject it.';
  return {
    runId: input.runId,
    orchestration: input.orchestration,
    status: 'paused',
    stale: true,
    pausedFor: input.pausedFor,
    pausedSinceMs: input.pausedSinceMs,
    summary:
      `STALE GATE: run ${input.runId} (${input.orchestration}) has been ` +
      `paused at "${input.pausedFor ?? 'unknown'}" for ${age} ` +
      `(TTL ${ttl})${tail}`,
  };
}

/** Fire the stale-gate notification if a sink is configured. Same best-effort
 *  contract as {@link fireTerminalNotify}: true only when a POST was kicked
 *  off; never throws; never blocks. */
export function fireGateStaleNotify(
  input: GateStaleNotifyInput,
  fetchImpl?: FetchLike,
): boolean {
  const url = input.notify?.onTerminal;
  if (typeof url !== 'string' || url.length === 0) return false;
  return postBestEffort(url, buildGateStaleNotifyPayload(input), fetchImpl);
}

// ── Gate-reached notification ──────────────────────────────────────────────
//
// `notify.onGate`: the moment a run stops at an approval gate, tell someone.
// `onTerminal` also fires on a pause, but it can't say WHICH kind of pause, and
// the stale-gate alert only fires after the TTL — by then a reviewer who could
// have approved in five minutes has left the run holding its concurrency group
// for hours. The envelope carries `text` so a Slack / Teams incoming webhook
// renders it unmodified.

export type GateNotifyInput = {
  notify: NotifyConfig | undefined;
  runId: string;
  orchestration: string;
  /** The gated phase, from the run's `pausedFor`. */
  gate: string | null;
  /** The run's last output — what the reviewer is being asked to approve. */
  lastOutput?: string | null;
  /** `SAMMY_PUBLIC_URL`, when set — where a reviewer opens the app. */
  publicUrl?: string;
};

export type GateNotifyPayload = {
  type: 'gate';
  runId: string;
  orchestration: string;
  status: 'paused';
  gate: string | null;
  text: string;
  summary?: string;
  /** The app's Approvals view and the run's API record, when
   *  SAMMY_PUBLIC_URL is set. */
  appUrl?: string;
  runUrl?: string;
};

export function buildGateNotifyPayload(input: GateNotifyInput): GateNotifyPayload {
  const base = input.publicUrl?.replace(/\/+$/, '');
  const where = input.gate ? ` at "${input.gate}"` : '';
  const text =
    `Approval needed: ${input.orchestration} (run ${input.runId}) is waiting${where}.` +
    (base ? ` Review it in Approvals: ${base}/` : ' Review it in the Approvals view.');
  const payload: GateNotifyPayload = {
    type: 'gate',
    runId: input.runId,
    orchestration: input.orchestration,
    status: 'paused',
    gate: input.gate,
    text,
  };
  if (typeof input.lastOutput === 'string' && input.lastOutput.length > 0) {
    payload.summary = input.lastOutput.slice(-NOTIFY_SUMMARY_MAX_CHARS);
  }
  if (base) {
    payload.appUrl = `${base}/`;
    payload.runUrl = `${base}/api/runs/${encodeURIComponent(input.runId)}`;
  }
  return payload;
}

/** POST the gate-reached envelope when `notify.onGate` is set. Best-effort,
 *  same contract as `fireTerminalNotify`. */
export function fireGateNotify(input: GateNotifyInput, fetchImpl?: FetchLike): boolean {
  const url = input.notify?.onGate;
  if (typeof url !== 'string' || url.length === 0) return false;
  return postBestEffort(url, buildGateNotifyPayload(input), fetchImpl);
}

/** A paused run is parked at a GATE (not a timed `wait`) when its persisted
 *  state holds no pending wait — the run controller clears `pendingWait` on a
 *  lock-gate pause for exactly this distinction. */
export function isGatePause(run: { status: string; stateJson?: unknown } | null): boolean {
  if (!run || run.status !== 'paused') return false;
  const st = run.stateJson as { pendingWait?: unknown } | null | undefined;
  return !st || st.pendingWait == null;
}
