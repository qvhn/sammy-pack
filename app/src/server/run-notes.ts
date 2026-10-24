/**
 * run-notes — a structured, human-readable run-END summary derived purely from
 * the durable event stream.
 *
 * The problem it solves: when an unattended run finishes, `status` alone (and
 * even the done-degraded verdict) is a thin signal — a human (or a Slack
 * reader) wants the STORY: which items succeeded vs failed, why, how many
 * retries each burned, what got promoted, and any health flags (a retry storm,
 * a partial fan-out). Reconstructing that from a 1000-event log by hand is
 * exactly the toil this removes. The notes are the end-of-run picture.
 *
 * Like {@link computeDegradation} / {@link computeDivergence}, this is a PURE
 * function over the event stream — no executor threading, no store reads. So it
 * stays faithful (it can't drift from what happened), survives a restart, and
 * is trivially testable. It is meant to run ONCE at terminal time.
 *
 * "Items". A run may fan out over a `map` (or refine in a `loop`), and each
 * fan-out item is the natural unit a human reasons about. Every leaf `phase-end`
 * carries a scoped `replayKey` (`<map>[idx]/<name>`, `<loop>@<iter>/<name>`); we
 * group by the item scope (the `[idx]` / `@iter` prefix) so each item gets its
 * own row. A flat run with no fan-out collapses to a single implicit item (the
 * run itself), so the notes degrade gracefully to "one thing happened".
 *
 * EXTENSIBILITY. Future event types that the executor / API may emit
 * ("promoted to stage", "stage validation passed", "figma captured at <url>")
 * are picked up automatically: per-item `signals` collect any event carrying a
 * recognised marker shape, and the run-total `events` tally counts every type.
 * A new event type needs no change here to appear in the per-item evidence — it
 * lands in `signals` as soon as it is emitted, keyed by its `type`. The small
 * curated set of structured fields (pr / promoted / cause) is opt-in on top.
 */

import type { DegradationResult } from './degradation';
import type { DivergenceResult } from './divergence';
import type { RunStatus, StoredEvent } from './run-store';

/** Max chars of any single evidence string (cause / signal value) folded into
 *  the notes, so one chatty failure can't bloat the record. */
const EVIDENCE_MAX = 280;

function clip(s: string): string {
  const t = (s ?? '').trim();
  return t.length > EVIDENCE_MAX ? `${t.slice(0, EVIDENCE_MAX)}…` : t;
}

/** A per-item line in the run notes. */
export type RunNoteItem = {
  /** Item identity — the fan-out scope (`[0]`, `@2`) or '(run)' for a flat run.
   *  Stable + human-readable; NOT the full scoped replay key. */
  id: string;
  /** Item verdict, derived from the item's events: `succeeded` when its last
   *  phase ended cleanly with no unhandled failure; `failed` when it ended on a
   *  terminal failure / unswallowed error; `incomplete` when it started but
   *  never produced a terminal outcome (e.g. cut short by a run-level abort). */
  status: 'succeeded' | 'failed' | 'incomplete';
  /** Re-runs this item burned — `phase-end` repeats beyond the first per phase,
   *  plus retries / loop re-iterations / stall recoveries attributed to it. The
   *  "how hard did we grind on this" number. */
  retriesUsed: number;
  /** A PR / artifact URL surfaced for this item, when one was emitted. */
  pr?: string;
  /** Short cause / evidence for a non-success (the terminal reason, the
   *  swallowed error, or the exhaustion note). Omitted on a clean success. */
  cause?: string;
  /** Open-ended signal bag — any recognised marker event for this item, keyed
   *  by a short label (event type or marker name) → value. This is the
   *  forward-compat seam: a new "promoted"/"stage-validated"/"figma" event
   *  shows up here automatically. */
  signals?: Record<string, string>;
};

/** Run-wide totals + health flags. */
export type RunNotesTotals = {
  items: number;
  succeeded: number;
  failed: number;
  incomplete: number;
  /** Count of items that surfaced a PR/artifact URL — a cheap "promoted" tally
   *  that needs no special event (grows automatically as PR-emitting items do). */
  promoted: number;
  /** Human-readable health flags, e.g. "RETRY STORM: 2 phase(s) thrashing",
   *  "DEGRADED (1): …", "1 item exhausted". Empty when the run was clean. */
  health: string[];
};

/** The full run-notes object surfaced on GET /api/runs/:id and folded (compact
 *  text form) into the notify webhook. */
export type RunNotes = {
  runId?: string;
  status: RunStatus;
  items: RunNoteItem[];
  totals: RunNotesTotals;
};

/** Context the run-controller passes alongside the events. All optional except
 *  status — the notes are derived from events, this just frames them + folds in
 *  the sibling verdicts so the health flags are one coherent set. */
export type RunNotesInput = {
  runId?: string;
  status: RunStatus;
  degradation?: DegradationResult;
  divergence?: DivergenceResult;
};

/** The ITEM a scoped replay key belongs to. The unit a human reasons about:
 *   - a `map` index is a DISTINCT item, so it keeps its index — `qa[2]/impl` →
 *     `[2]`, `qa[0]/impl` and `qa[1]/impl` are two items.
 *   - a `loop` refines the SAME work across iterations, so ALL iterations
 *     collapse to ONE item — `fix@1/edit`, `fix@3/edit` → the single item `fix`
 *     (the loop's base name, iteration number dropped). This is what makes a
 *     refinement loop read as "one thing that took 3 passes", not 3 items.
 *  The FIRST scope marker in the key wins (the outermost composite). Returns
 *  null for an unscoped (top-level) leaf — the implicit run-level item.
 *
 *  `synth` lets the iteration-marker events (which carry phaseName + iteration
 *  but no replayKey) resolve to the SAME item id their scoped phase-ends do, so
 *  a loop-exhausted / map-iteration lands in the right row.
 */
function itemScopeOf(replayKey: string): string | null {
  // A map index marker anywhere: keep `<prefix>[idx]` up to and including it.
  const mapM = replayKey.match(/^(.*?\[\d+\])/);
  if (mapM) {
    // But if a loop scope comes FIRST, the loop wins (outermost). Compare
    // positions of the first `[idx]` vs first `@n`.
    const loopIdx = replayKey.search(/@\d+/);
    const mapIdx = replayKey.search(/\[\d+\]/);
    if (loopIdx < 0 || mapIdx < loopIdx) return mapM[1];
  }
  // A loop marker: collapse to the loop base name (drop `@<iter>` and anything
  // after), so every iteration is the same item.
  const loopM = replayKey.match(/^(.*?)@\d+/);
  if (loopM) return loopM[1];
  return null;
}

/** Item id for an iteration-marker event (loop/map iteration, loop-exhausted),
 *  which carries `phaseName` (the composite's name) + `iteration` but no
 *  replayKey. A `map` iteration is item `<phaseName>[idx]`; a `loop` iteration
 *  is the single item `<phaseName>`. Mirrors {@link itemScopeOf} so the two
 *  resolve to the same row. */
function syntheticItemId(
  kind: 'map' | 'loop',
  phaseName: string,
  iteration: number,
): string {
  return kind === 'map' ? `${phaseName}[${iteration - 1}]` : phaseName;
}

/** Pull a URL out of an event (a `pr` / `url` field, or the first http(s) URL
 *  in an `output`/`value` string). Used to surface promoted-PR / figma links
 *  without the producing phase needing a bespoke event. */
function urlFrom(ev: Record<string, unknown>): string | null {
  for (const k of ['pr', 'url', 'prUrl', 'link']) {
    const v = ev[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v.trim())) return v.trim();
  }
  for (const k of ['output', 'value', 'text']) {
    const v = ev[k];
    if (typeof v === 'string') {
      const m = v.match(/https?:\/\/\S+/);
      if (m) return m[0];
    }
  }
  return null;
}

type ItemAcc = {
  id: string;
  /** phaseName → times that phase ended (for retry counting). */
  phaseEnds: Map<string, number>;
  retries: number;
  lastOutcome: 'success' | 'failed' | null;
  cause?: string;
  pr?: string;
  signals: Record<string, string>;
  started: boolean;
};

/**
 * Build the run notes from the event stream.
 *
 * One linear pass groups events into per-item accumulators (by fan-out scope),
 * tallying clean ends, failures, retries, PRs, and any recognised signals, then
 * derives each item's verdict and the run totals. The degraded + divergence
 * verdicts (passed in) become health flags so the notes are a single coherent
 * end-of-run summary.
 */
export function computeRunNotes(
  events: ReadonlyArray<StoredEvent>,
  input: RunNotesInput,
): RunNotes {
  const items = new Map<string, ItemAcc>();
  const RUN_ITEM = '(run)';

  const accFor = (scope: string | null): ItemAcc => {
    const id = scope ?? RUN_ITEM;
    let acc = items.get(id);
    if (!acc) {
      acc = {
        id,
        phaseEnds: new Map(),
        retries: 0,
        lastOutcome: null,
        signals: {},
        started: false,
      };
      items.set(id, acc);
    }
    return acc;
  };

  for (const e of events) {
    const ev = e as Record<string, unknown> & { type: string };
    const replayKey =
      typeof ev.replayKey === 'string' ? (ev.replayKey as string) : undefined;
    const phaseName =
      typeof ev.phaseName === 'string' ? (ev.phaseName as string) : undefined;
    const scope = replayKey ? itemScopeOf(replayKey) : null;

    switch (ev.type) {
      case 'map-iteration':
      case 'loop-iteration': {
        // Establishes an item exists even before its first phase ends — so an
        // item cut short before any phase-end still shows up as `incomplete`.
        // These markers carry phaseName + iteration but no replayKey; the
        // synthetic id resolves to the SAME item their scoped phase-ends do.
        if (phaseName && typeof ev.iteration === 'number') {
          const id = syntheticItemId(
            ev.type === 'map-iteration' ? 'map' : 'loop',
            phaseName,
            ev.iteration,
          );
          accFor(id).started = true;
        }
        break;
      }
      case 'phase-end': {
        const acc = accFor(scope);
        acc.started = true;
        if (phaseName) {
          const n = (acc.phaseEnds.get(phaseName) ?? 0) + 1;
          acc.phaseEnds.set(phaseName, n);
          if (n > 1) acc.retries += 1; // a repeat of the same phase = a re-run
        }
        acc.lastOutcome = 'success';
        acc.cause = undefined;
        const url = urlFrom(ev);
        if (url) acc.pr = url;
        break;
      }
      case 'node-retried':
      case 'stall-recovery': {
        accFor(scope).retries += 1;
        break;
      }
      case 'phase-terminal': {
        const acc = accFor(scope);
        acc.started = true;
        acc.lastOutcome = 'failed';
        acc.cause = clip(
          (typeof ev.reason === 'string' && ev.reason) ||
            (typeof ev.error === 'string' && ev.error) ||
            'terminal (do-not-retry) failure',
        );
        break;
      }
      case 'phase-error': {
        // A swallowed phase error (the sequence continued). Records a cause but
        // does NOT by itself mark the item failed — a later clean phase-end can
        // still flip it back to success (continueOnError semantics).
        const acc = accFor(scope);
        acc.started = true;
        if (acc.lastOutcome !== 'success') {
          acc.lastOutcome = acc.lastOutcome ?? 'failed';
          acc.cause = clip(
            (typeof ev.error === 'string' && ev.error) || 'phase error',
          );
        }
        break;
      }
      case 'loop-exhausted': {
        // The loop give-up. Carries the loop's phaseName + iteration but no
        // replayKey — resolve to the loop's single item (same id as its
        // iteration markers / scoped phase-ends).
        const id =
          phaseName && typeof ev.iteration === 'number'
            ? syntheticItemId('loop', phaseName, ev.iteration)
            : (scope ?? RUN_ITEM);
        const acc = accFor(id);
        acc.started = true;
        acc.lastOutcome = 'failed';
        const fails = typeof ev.failures === 'number' ? ev.failures : '?';
        acc.cause = clip(`loop exhausted after ${fails} consecutive failures`);
        break;
      }
      default: {
        // Forward-compat signal capture. Any event NOT handled above that
        // carries a phase scope AND a recognised marker shape lands in the
        // item's signal bag, keyed by its type — so a future
        // "promoted"/"stage-validated"/"figma-captured" event surfaces in the
        // per-item evidence with no change here. We look for a URL or a short
        // string value to show.
        if (typeof ev.type === 'string' && (replayKey || phaseName)) {
          const url = urlFrom(ev);
          const val =
            url ??
            (typeof ev.value === 'string'
              ? clip(ev.value as string)
              : typeof ev.status === 'string'
                ? (ev.status as string)
                : undefined);
          if (val !== undefined && isSignalType(ev.type)) {
            accFor(scope).signals[ev.type] = val;
          }
        }
        break;
      }
    }
  }

  // Derive each item's final verdict + assemble rows (stable order: run item
  // first if present, then scoped items in first-seen order — Map preserves it).
  const rows: RunNoteItem[] = [];
  let succeeded = 0;
  let failed = 0;
  let incomplete = 0;
  let promoted = 0;
  for (const acc of items.values()) {
    let status: RunNoteItem['status'];
    if (acc.lastOutcome === 'success') status = 'succeeded';
    else if (acc.lastOutcome === 'failed') status = 'failed';
    else status = 'incomplete';
    if (status === 'succeeded') succeeded += 1;
    else if (status === 'failed') failed += 1;
    else incomplete += 1;
    if (acc.pr) promoted += 1;
    const row: RunNoteItem = {
      id: acc.id,
      status,
      retriesUsed: acc.retries,
    };
    if (acc.pr) row.pr = acc.pr;
    if (status !== 'succeeded' && acc.cause) row.cause = acc.cause;
    if (Object.keys(acc.signals).length > 0) row.signals = acc.signals;
    rows.push(row);
  }

  // Health flags — fold in the sibling verdicts so the notes are one picture.
  const health: string[] = [];
  if (input.divergence?.diverged) {
    const worst = input.divergence.hotspots
      .map(h => `${h.phase} ×${h.repeats}`)
      .join(', ');
    health.push(
      `RETRY STORM: ${input.divergence.hotspots.length} phase(s) thrashing (${worst})`,
    );
  }
  if (input.degradation?.degraded) {
    health.push(`DEGRADED (${input.degradation.reasons.length})`);
  }
  const exhausted = rows.filter(r => r.cause?.includes('exhausted')).length;
  if (exhausted > 0) health.push(`${exhausted} item(s) exhausted`);

  return {
    runId: input.runId,
    status: input.status,
    items: rows,
    totals: {
      items: rows.length,
      succeeded,
      failed,
      incomplete,
      promoted,
      health,
    },
  };
}

/** Whether an unrecognised event type looks like a milestone worth surfacing as
 *  a per-item signal. Deliberately permissive on a small marker vocabulary so
 *  future event types ("promoted", "stage-validation-passed", "figma-captured",
 *  anything with these stems) are picked up WITHOUT editing this file. Keeps the
 *  signal bag from filling with low-value chatter (deltas, tool-uses). */
function isSignalType(type: string): boolean {
  return /promot|stage|deploy|publish|figma|captur|validat|ship|release/i.test(
    type,
  );
}

/** Bound on the compact notes text folded into the notify webhook. */
export const RUN_NOTES_TEXT_MAX_CHARS = 1500;

/**
 * Render the run notes as a compact PLAIN-TEXT block for the notify webhook /
 * terminal report. One header line of totals, the health flags, then one line
 * per item (capped). Designed to read cleanly in Slack / a plain terminal — no
 * markdown tables, just aligned `id: status (retries) — cause/pr` lines.
 * Bounded so a wide fan-out can't push a giant body to the webhook.
 */
export function formatRunNotes(notes: RunNotes): string {
  const t = notes.totals;
  const lines: string[] = [];
  lines.push(
    `Run summary: ${t.succeeded} ok / ${t.failed} failed / ${t.incomplete} incomplete` +
      (t.promoted > 0 ? ` — ${t.promoted} promoted` : '') +
      ` (${t.items} item${t.items === 1 ? '' : 's'})`,
  );
  for (const flag of t.health) lines.push(`  ! ${flag}`);
  for (const it of notes.items) {
    const bits: string[] = [`${it.id}: ${it.status}`];
    if (it.retriesUsed > 0) bits.push(`(${it.retriesUsed} retr${it.retriesUsed === 1 ? 'y' : 'ies'})`);
    if (it.pr) bits.push(`pr ${it.pr}`);
    if (it.cause) bits.push(`— ${it.cause}`);
    if (it.signals) {
      const sig = Object.entries(it.signals)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      if (sig) bits.push(`[${sig}]`);
    }
    lines.push(`  ${bits.join(' ')}`);
  }
  let out = lines.join('\n');
  if (out.length > RUN_NOTES_TEXT_MAX_CHARS) {
    out = `${out.slice(0, RUN_NOTES_TEXT_MAX_CHARS - 1)}…`;
  }
  return out;
}
