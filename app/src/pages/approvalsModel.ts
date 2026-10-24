import type { RunEvent } from '../llm/executor';

/**
 * Pure (React-free) logic behind the Approvals page — which phase output a
 * gate card shows, the review thread, the deck, artifact listing and output
 * formatting. Kept apart from ApprovalsPage.tsx so it is unit-testable
 * (__tests__/approvals-model.test.ts) without rendering anything.
 */

/** A phase-end output must be at least this many trimmed chars to count
 *  as "the plan". Guards against picking up a one-word status line from
 *  some tiny upstream phase as if it were the gated plan. */
export const MIN_PLAN_CHARS = 12;

/** A JSON *object* output at or under this many trimmed chars is treated as a
 *  small structural/control payload (a routing/verdict/status decision), not a
 *  reviewable artifact — so the plan-picker skips it in favor of richer
 *  upstream content. Sized to clear terse control objects like
 *  `{"branch":"default"}` (21) or `{"status":"ENV_READY","sha":"…","sims":3}`
 *  (47) while staying well below real structured artifacts (a normalize-tickets
 *  array, a config blob, a JSON report) which run into the hundreds–thousands
 *  of chars. */
const SMALL_CONTROL_CHARS = 80;

/** A single-line output at or under this many chars AND this many words is a
 *  mechanical TOKEN — a routing key (`needs-review`), a verdict
 *  (`DECISION: SHIP`), a status line (`ENV_READY abc123`) — not prose a human
 *  reviews. Anything longer, multi-line, or sentence-shaped is content. */
const SHORT_TOKEN_CHARS = 48;
const SHORT_TOKEN_WORDS = 3;

/** A "few-key" routing/verdict object — a flat JSON object with only a handful
 *  of keys whose first key reads like a control field (branch/verdict/gate/…).
 *  Catches a terse decision object even if it nudges past SMALL_CONTROL_CHARS,
 *  without misfiring on a large structured artifact that merely starts with a
 *  matching key. */
const CONTROL_KEY_RE =
  /^["']?(?:branch|verdict|gate|route|decision|status|action|next|result|outcome)["']?\s*:/i;

/** Does this phase-end output look MECHANICAL — a routing key / verdict token
 *  or a small structural/control object — rather than a substantive artifact
 *  to review?
 *
 *  Classified on the OUTPUT only, never the phase name: a phase called
 *  `decide` or `classify` that writes a reasoned paragraph ending in
 *  "DECISION: SHIP" is exactly what the approver is approving, while a router
 *  leaf that emits `{"branch":"default"}` is not. True when EITHER:
 *   - the trimmed output is a short single-line token (≤ SHORT_TOKEN_CHARS
 *     chars and ≤ SHORT_TOKEN_WORDS words), OR
 *   - it is a JSON OBJECT (`{ … }`) that is either tiny (≤ SMALL_CONTROL_CHARS)
 *     or a flat few-key object whose first key is a control field
 *     (CONTROL_KEY_RE) with at most a few keys.
 *
 *  Deliberately conservative: prose/markdown, a JSON ARRAY, or a large
 *  multi-key object is NEVER flagged. Used only to RANK candidates — if a
 *  control output is all that exists, the caller still falls back to it. */
export function isControlOutput(output: string): boolean {
  const t = output.trim();
  // A JSON array is a list of things (tickets, findings) — always content.
  if (t.startsWith('[')) return false;
  if (
    !t.includes('\n') &&
    t.length <= SHORT_TOKEN_CHARS &&
    t.split(/\s+/).length <= SHORT_TOKEN_WORDS
  ) {
    return true;
  }
  // Only OBJECTS are control-shaped; arrays/prose are content.
  if (!(t.startsWith('{') && t.endsWith('}'))) return false;
  if (t.length <= SMALL_CONTROL_CHARS) return true;
  // Slightly larger, but a flat few-key object led by a control key.
  const inner = t.slice(1, -1).trim();
  if (!CONTROL_KEY_RE.test(inner)) return false;
  // Count top-level keys cheaply (commas not nested in braces/brackets). A
  // routing object has a handful; a rich object has many.
  let depth = 0;
  let keys = inner ? 1 : 0;
  for (const ch of inner) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) keys++;
  }
  return keys <= 4;
}

export type GateInfo = {
  gatedPhase: string;
  plan: string | null;
  planPhase: string | null;
  upstream: string[];
  pausedAt: number;
};

/** Derive the gated phase + the plan from a run's event stream.
 *
 *  Mirrors the `serverGate` memo in RunsPage for the gated phase: scan
 *  backward, take the first run-paused.pausedFor (else lock-gate.phaseName).
 *  A `lock` gates BEFORE its phase runs, so the phase-ends behind it are the
 *  lead-up the human is approving to proceed FROM.
 *
 *  PLAN SELECTION — the most recent completed phase output before the gate,
 *  unless it is MECHANICAL (a routing key / verdict token / small control
 *  object — see isControlOutput), in which case we keep walking back to the
 *  most recent SUBSTANTIVE one. Only when nothing substantive exists do we
 *  FALL BACK to the most-recent control output (correct-over-empty).
 *
 *  `upstream` is a short breadcrumb (newest-first, distinct, never the plan
 *  phase itself) of the substantive phase names BEHIND the chosen plan, so
 *  the reviewer can see the lead-up. A phase that ran more than once (a
 *  revision, or a resumed run replaying its checkpoints) shows up once.
 *
 *  `fallbackPhase` lets the caller supply the authoritative run-level
 *  `pausedFor` (most reliable from GET /api/runs/:id) when the event
 *  stream lacks an explicit run-paused/lock-gate sentinel. */
export function extractGate(
  events: RunEvent[],
  fallbackPhase?: string,
): GateInfo | null {
  let gatedPhase: string | null = null;
  let pausedAt = 0;
  // The chosen substantive plan (preferred).
  let plan: string | null = null;
  let planPhase: string | null = null;
  // Fallback: the most-recent phase-end of ANY kind (incl. a control object),
  // used only if no substantive output is found.
  let fallbackPlan: string | null = null;
  let fallbackPlanPhase: string | null = null;
  const upstream: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as {
      type: string;
      pausedFor?: string;
      phaseName?: string;
      output?: unknown;
      ts?: number;
    };
    if (!gatedPhase && e.type === 'run-paused' && e.pausedFor) {
      gatedPhase = e.pausedFor;
      if (typeof e.ts === 'number') pausedAt = e.ts;
    }
    if (!gatedPhase && e.type === 'lock-gate' && e.phaseName) {
      gatedPhase = e.phaseName;
      if (typeof e.ts === 'number') pausedAt = e.ts;
    }
    if (e.type === 'phase-end' && e.output != null) {
      const output = String(e.output);
      if (output.trim().length >= MIN_PLAN_CHARS) {
        const name = typeof e.phaseName === 'string' ? e.phaseName : undefined;
        if (fallbackPlan == null) {
          fallbackPlan = output;
          fallbackPlanPhase = name ?? null;
        }
        const isControl = isControlOutput(output);
        if (plan == null && !isControl) {
          // First SUBSTANTIVE output (scanning backward) → the reviewed leaf.
          plan = output;
          planPhase = name ?? null;
        } else if (
          plan != null &&
          !isControl &&
          name &&
          name !== planPhase &&
          !upstream.includes(name)
        ) {
          // A distinct substantive phase BEHIND the chosen plan → breadcrumb.
          upstream.push(name);
        }
      }
    }
    // Bounded: once we have the gate, a plan and a short breadcrumb, stop.
    if (gatedPhase && plan != null && upstream.length >= 3) break;
  }
  const phase = gatedPhase ?? fallbackPhase ?? null;
  if (!phase) return null;
  if (!pausedAt) {
    const last = events[events.length - 1] as { ts?: number } | undefined;
    pausedAt = typeof last?.ts === 'number' ? last.ts : 0;
  }
  return {
    gatedPhase: phase,
    plan: plan ?? fallbackPlan,
    planPhase: plan != null ? planPhase : fallbackPlanPhase,
    upstream,
    pausedAt,
  };
}

/** One turn in the per-ticket review conversation: an `agent` turn is a
 *  plan / revision (a phase-end output of the reviewed phase); a `user`
 *  turn is the human's gate feedback. */
export type ThreadTurn =
  | { kind: 'agent'; text: string; ts: number; revision: number }
  | {
      kind: 'user';
      text: string;
      ts: number;
      decision: 'approve' | 'reject' | 'request-changes';
      /** Who decided — shown so the review thread is an audit trail and not
       *  just an anonymous verdict. Absent on decisions recorded before the
       *  event carried an actor. */
      decidedBy?: string;
    };

/** Build the per-ticket review conversation from a run's events.
 *
 *  Agent turns = every substantial phase-end output of the REVIEWED phase
 *  (`planPhase`) — the original plan followed by each revision a
 *  `request-changes` round produced. A phase-end whose text is identical to
 *  the previous agent turn is a checkpoint REPLAY (a resumed run re-emits its
 *  completed leaves), not a revision, so it is skipped. User turns = the
 *  human's `gate-decision` events FOR THIS GATE (`gatedPhase`, when given —
 *  a decision at an earlier gate, e.g. an error-recovery ask, is not part of
 *  this review). Merged in timestamp order (most-recent last): plan →
 *  feedback → revision → feedback → …
 *
 *  When `planPhase` is unknown we still surface the human's gate-decisions,
 *  so the user's side of the conversation is never lost. */
export function buildThread(
  events: RunEvent[],
  planPhase: string | null,
  gatedPhase?: string | null,
): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  let revision = 0;
  let lastAgentText: string | null = null;
  for (const ev of events) {
    const e = ev as {
      type?: string;
      phaseName?: string;
      output?: unknown;
      message?: unknown;
      decision?: string;
      decidedBy?: unknown;
      ts?: number;
    };
    if (
      planPhase &&
      e.type === 'phase-end' &&
      e.phaseName === planPhase &&
      e.output != null &&
      String(e.output).trim().length >= MIN_PLAN_CHARS
    ) {
      const text = String(e.output);
      if (text === lastAgentText) continue; // a replay, not a revision
      lastAgentText = text;
      turns.push({
        kind: 'agent',
        text,
        ts: typeof e.ts === 'number' ? e.ts : 0,
        revision: revision++,
      });
    } else if (
      e.type === 'gate-decision' &&
      !(gatedPhase && typeof e.phaseName === 'string' && e.phaseName !== gatedPhase)
    ) {
      const decision =
        e.decision === 'approve' ||
        e.decision === 'reject' ||
        e.decision === 'request-changes'
          ? e.decision
          : 'request-changes';
      const text = typeof e.message === 'string' ? e.message : '';
      // Skip empty approvals by nobody in particular — they add nothing.
      // Keep request-changes, any decision with a note, and any decision
      // that names a REAL approver (for an approval trail the approver is
      // the content, even with no message).
      const actor = decisionActorName(e.decidedBy);
      if (!text.trim() && !actor && decision === 'approve') continue;
      turns.push({
        kind: 'user',
        text,
        ts: typeof e.ts === 'number' ? e.ts : 0,
        decision,
        ...(actor ? { decidedBy: actor } : {}),
      });
    }
  }
  // Stable order by ts (defensive — events already arrive in sequence).
  turns.sort((a, b) => a.ts - b.ts);
  return turns;
}

/** The server records `decidedBy: 'system'` when the request carried no
 *  identity (the default for this UI — see extractOwnerId), so that value
 *  names NOBODY: treat it like an absent actor. Returns the real actor name,
 *  or null when the decision has no identity. */
export function decisionActorName(decidedBy: unknown): string | null {
  if (typeof decidedBy !== 'string') return null;
  const t = decidedBy.trim();
  if (!t || t.toLowerCase() === 'system') return null;
  return t;
}

/** Label for a human turn: the named approver when there is one, else "You"
 *  (an identity-less decision came from a person using this UI). */
export function decisionLabel(turn: {
  decision: 'approve' | 'reject' | 'request-changes';
  decidedBy?: string;
}): string {
  const verb =
    turn.decision === 'request-changes'
      ? 'Requested changes'
      : turn.decision === 'reject'
        ? 'Rejected'
        : 'Approved';
  return `${decisionActorName(turn.decidedBy) ?? 'You'} · ${verb}`;
}

/** Should a pre-gate parallel/map fan-out REPLACE the linear plan view?
 *  Only when the reviewed output is one of the fan-out's own branches (the
 *  gate sits right after the fan-out). When a later phase (e.g. a `decide`
 *  step that synthesizes the checks) produced the reviewed output, that
 *  output is the headline and the fan-out is supporting context. */
export function fanOutReplacesPlan(
  fanOut: { branches: Array<{ name: string }> } | null,
  planPhase: string | null,
): boolean {
  if (!fanOut) return false;
  if (!planPhase) return true;
  return fanOut.branches.some(b => b.name === planPhase);
}

/* -------------------------------------------------------------------------- */
/* Output formatting                                                          */
/* -------------------------------------------------------------------------- */

export type FormattedOutput = { kind: 'json' | 'text'; text: string };

/** Make a phase output readable:
 *   - JSON (an object/array, optionally inside one ```json fence) →
 *     pretty-printed with 2-space indent, kind `json` (render monospace);
 *   - a JSON-ENCODED STRING (`"line 1\nline 2"`) → its decoded text;
 *   - single-line text carrying literal `\n` escapes and no real newline →
 *     unescaped so it reads as lines;
 *   - anything else → unchanged text. */
export function formatOutput(raw: string, depth = 0): FormattedOutput {
  const t = raw.trim();
  const fenced = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  const body = fenced ? fenced[1].trim() : t;
  const first = body[0];
  if (first === '{' || first === '[' || (first === '"' && depth === 0)) {
    try {
      const v: unknown = JSON.parse(body);
      if (typeof v === 'string') return formatOutput(v, depth + 1);
      if (v && typeof v === 'object') {
        return { kind: 'json', text: JSON.stringify(v, null, 2) };
      }
    } catch {
      /* not JSON — fall through to text */
    }
  }
  if (!raw.includes('\n') && /\\n/.test(raw)) {
    return {
      kind: 'text',
      text: raw.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t'),
    };
  }
  return { kind: 'text', text: raw };
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* -------------------------------------------------------------------------- */

export type ArtifactRef = {
  name: string;
  phaseName: string;
  bytes: number;
  truncated: boolean;
  dropped: boolean;
};

/** The run's named artifacts (`artifact` events), one per name — the latest
 *  wins, matching GET /api/runs/:id/artifacts?name=. First-seen order. */
export function extractArtifacts(events: RunEvent[]): ArtifactRef[] {
  const byName = new Map<string, ArtifactRef>();
  for (const ev of events) {
    const e = ev as {
      type?: string;
      name?: unknown;
      phaseName?: unknown;
      bytes?: unknown;
      truncated?: unknown;
      dropped?: unknown;
    };
    if (e.type !== 'artifact' || typeof e.name !== 'string' || !e.name) continue;
    byName.set(e.name, {
      name: e.name,
      phaseName: typeof e.phaseName === 'string' ? e.phaseName : '',
      bytes: typeof e.bytes === 'number' ? e.bytes : 0,
      truncated: e.truncated === true,
      dropped: e.dropped === true,
    });
  }
  return [...byName.values()];
}

/** URL serving one artifact's content (opened in a new tab). */
export function artifactUrl(runId: string, name: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts?name=${encodeURIComponent(name)}`;
}

/** "512 B" / "2.3 KB" / "1.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* The deck                                                                   */
/* -------------------------------------------------------------------------- */

/** What happened to a card this session. `resolved` = the gate was already
 *  decided elsewhere (the POST got a 409): drop the card, but don't count it
 *  as this reviewer's approval/rejection. */
export type Outcome = 'approved' | 'rejected' | 'resolved';

/** Build the deck: the paused runs not yet acted on this session, plus any
 *  run pinned while it revises (it is transiently `running`, so absent from
 *  the paused list). Fresh-then-stale, newest-paused first within each. */
export function buildDeck<
  R extends { id: string; stale: boolean; pausedAt: number },
>(runs: R[], outcomes: Record<string, Outcome>, revising: Record<string, R>): R[] {
  const byId = new Map<string, R>();
  for (const r of runs) {
    if (!outcomes[r.id]) byId.set(r.id, r);
  }
  for (const [id, r] of Object.entries(revising)) {
    if (!outcomes[id]) byId.set(id, byId.get(id) ?? r);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    return b.pausedAt - a.pausedAt;
  });
}

/** The session tally — counts only THIS reviewer's decisions. */
export function tally(outcomes: Record<string, Outcome>): {
  approved: number;
  rejected: number;
} {
  let approved = 0;
  let rejected = 0;
  for (const o of Object.values(outcomes)) {
    if (o === 'approved') approved++;
    else if (o === 'rejected') rejected++;
  }
  return { approved, rejected };
}
