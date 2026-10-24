import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Markdown } from '../Markdown';
import { getRun, listRuns } from '../api';
import type { RunEvent } from '../llm/executor';
import { navigateTo } from '../lib/hashRoute';
import type { PageId } from '../Sidebar';
import { requestRun } from '../store/runSelection';
import { useToast } from '../store/toast';
import { Page } from './Page';
import {
  MIN_PLAN_CHARS,
  artifactUrl,
  buildDeck,
  buildThread,
  decisionLabel,
  extractArtifacts,
  extractGate,
  fanOutReplacesPlan,
  formatBytes,
  formatOutput,
  tally,
  type ArtifactRef,
  type Outcome,
  type ThreadTurn,
} from './approvalsModel';

/**
 * Approvals — an INLINE FULL-PAGE STEPPER-REVIEWER for runs paused at a
 * human `lock` gate (status === 'paused', with a `pausedFor` phase).
 *
 * Approvals is its own nav section, so it renders as the PAGE body (inside
 * the shared `<Page>` chrome, the way Runs / Queue do) — NOT a modal
 * floating over a backdrop. There are usually MULTIPLE tickets to review,
 * so the primary UX is a Claude-artifact-style deck — back/next through the
 * pending runs, approve / reject / skip each, with the gated PLAN rendered
 * front-and-center (color-coded diff or rich markdown) so the human can
 * actually follow what they're approving. The empty state ("No runs
 * awaiting approval") renders inline as the page body.
 *
 * Leaving the surface is the left nav's job — there's no overlay to close,
 * so Esc is intentionally NOT bound here (←/→ traverse, Enter approves,
 * ⌘/Ctrl+Enter requests changes).
 *
 * It owns its own lightweight poller (GET /api/runs every few seconds)
 * rather than leaning on the RunsProvider, whose live state only tracks
 * the single active run — a paused run that nobody is "watching" still
 * needs to show up here.
 */

/** Shape we read off GET /api/runs. The list endpoint returns lightweight
 *  SUMMARIES (no events[]) — it ships `pausedFor` directly (authoritative for
 *  the gated phase), so the deck no longer needs the event stream here. Per
 *  card, ReviewCard still fetches GET /api/runs/:id for the full PLAN/thread.
 *  `events` is kept optional only for forward/back-compat with an older
 *  payload; it's absent on the summary shape. */
type RunListItem = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  pausedFor?: string;
  /** The full orchestration tree (a `Node`) — both GET /api/runs (summary)
   *  and GET /api/runs/:id include it. We only read its top-level
   *  `description` here (the run's purpose), so it's typed loosely. */
  orchestrationSnapshot?: { description?: unknown } | null;
  events?: RunEvent[];
  /** Present when the run is parked on a durable `wait` (timer / signal)
   *  rather than a human lock gate — served by GET /api/runs off the run
   *  header. Wait-parked runs are NOT reviewables (see toPausedRuns). */
  pendingWait?: { kind?: string } | null;
};

/** A single paused run, distilled to what the stepper card needs.
 *  `gatedPhase` and `plan` are derived from events (see extractGate).
 *  `plan` may be null if no substantial upstream phase-end output
 *  exists yet. */
type PausedRun = {
  id: string;
  orchestrationName: string;
  /** The orchestration's purpose — its top-level `description`, trimmed to
   *  the first sentence (see firstSentence). Tells the reviewer what this
   *  run is FOR. Null when the snapshot carried no description. Sourced from
   *  `orchestrationSnapshot.description` on the run list item. */
  orchestrationDescription: string | null;
  startedAt: number;
  /** When the run paused — the ts of the run-paused / lock-gate event,
   *  falling back to the last event's ts, then startedAt. */
  pausedAt: number;
  gatedPhase: string;
  plan: string | null;
  /** The phase whose phase-end output is the reviewed plan — i.e. the leaf
   *  that ran immediately before this (pre-dispatch) gate. The conversation
   *  thread collects every phase-end of THIS phase as the successive
   *  plan/revision turns, and `request-changes` re-runs exactly this phase.
   *  Null when no substantial upstream output was captured. */
  planPhase: string | null;
  /** Short breadcrumb (newest-first) of the substantive phase names BEHIND the
   *  reviewed plan — the lead-up the reviewer can glance at for context. Empty
   *  when there's no prior substantive phase. */
  upstream: string[];
  /** True when this run has been paused at its gate longer than STALE_GATE_MS
   *  (~7 days) — probably abandoned. Drives the amber flag + sort-last +
   *  clear-stale affordance. Derived from `pausedAt`. */
  stale: boolean;
  events: RunEvent[];
};

const POLL_MS = 5000;
/** How long a newly shown card's actions stay inert (see the card-swap guard
 *  in ApprovalsReviewer) — long enough to swallow the second click of a fast
 *  double click, short enough to be imperceptible to a deliberate reviewer. */
const CARD_SWAP_GUARD_MS = 600;
/** While a `request-changes` revision is in flight we poll the single run
 *  faster than the list poll, since the user is actively waiting on it. */
const REVISE_POLL_MS = 2500;
/** Give up actively watching a revision after this long (it keeps running
 *  server-side; the list poll will pick it up when it eventually pauses).
 *  Generous because a revising agent re-runs a full phase. */
const REVISE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** A paused run older than this is considered STALE — it's been sitting at a
 *  human gate long enough that it's probably abandoned. Stale cards sort LAST,
 *  carry an amber "paused Nd ago" flag, and surface a "clear stale" affordance
 *  so the deck doesn't accrete forgotten runs. ~7 days. */
const STALE_GATE_MS = 7 * 24 * 60 * 60 * 1000;

/** Promise-based delay — used to pace the revision poll loop. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(
      resolve,
      ms,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Source-ticket extraction                                                    */
/* -------------------------------------------------------------------------- */

/** The Jira ticket a run is processing when its pause sits inside a
 *  ticket-bearing map (e.g. a dev loop's per-ticket map over
 *  `${tickets}`, paused at a plan gate while fixing one ticket). `summary` is
 *  present only when we matched a real ticket object; `url` only when a Jira
 *  site host was reliably found in the run's own data. */
type SourceTicket = {
  id: string;
  summary: string | null;
  url: string | null;
};

/* -------------------------------------------------------------------------- */
/* Visual evidence (screenshot) extraction                                     */
/* -------------------------------------------------------------------------- */

/** A before/after screenshot pair surfaced above the plan so the reviewer can
 *  SEE what they're approving. Either side may be null (we render whichever
 *  is present). `loose` collects any additional standalone image URLs found in
 *  the gated phase output that aren't part of an actual/expected pair. */
type Evidence = {
  /** The observed/current screenshot (a finding's / ticket's `actualImageRef`). */
  actual: string | null;
  /** The intended/golden screenshot (a finding's / ticket's `expectedImageRef`). */
  expected: string | null;
  /** Any other image URLs found in the gated phase output, deduped, in order. */
  loose: string[];
};

/** Image-looking URL/path: an http(s) URL OR an absolute/relative file path
 *  ending in a common raster/vector image extension (query string tolerated).
 *  Used both to validate the explicit `*ImageRef` fields (so a non-image value
 *  is ignored) and to scrape loose image URLs out of the gated phase output. */
const IMAGE_URL_RE =
  /(?:https?:\/\/[^\s"'<>)]+|(?:\.{0,2}\/)?[^\s"'<>)]+)\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s"'<>)]*)?/gi;

/** Is `v` a non-empty string that points at an image (URL or file path)? Used
 *  to gate the explicit `actualImageRef`/`expectedImageRef` fields — the consumer
 *  side attaches EXACTLY those field names, so we consume them verbatim, but we
 *  still validate the value so a stray non-image string renders nothing. */
function asImageRef(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  // Reset lastIndex (global regex) before a one-off test.
  IMAGE_URL_RE.lastIndex = 0;
  return IMAGE_URL_RE.test(t) ? t : null;
}

/** Pull `actualImageRef` / `expectedImageRef` off a plain object (a finding or
 *  a ticket). Returns nulls when the object carries neither — the universal
 *  graceful-absence case. */
function imageRefsOf(o: Record<string, unknown> | null | undefined): {
  actual: string | null;
  expected: string | null;
} {
  if (!o || typeof o !== 'object') return { actual: null, expected: null };
  return {
    actual: asImageRef(o.actualImageRef),
    expected: asImageRef(o.expectedImageRef),
  };
}

/** Scan phase-end outputs (newest-first) for the first FINDING object carrying
 *  an `actualImageRef`/`expectedImageRef`. Returns the first hit's refs, or
 *  nulls when none. A finding payload may be a bare object or an array of
 *  findings — parseObjectsLoose handles both. */
function findImageRefsInEvents(events: RunEvent[]): {
  actual: string | null;
  expected: string | null;
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; output?: unknown };
    if (e.type !== 'phase-end' || typeof e.output !== 'string') continue;
    for (const o of parseObjectsLoose(e.output)) {
      const refs = imageRefsOf(o);
      if (refs.actual || refs.expected) return refs;
    }
  }
  return { actual: null, expected: null };
}

/** Scrape every image URL out of a blob of text (the gated phase output),
 *  deduped in first-seen order. Tolerant of markdown image syntax, JSON, and
 *  prose — we only care that an image URL appears somewhere. */
function scrapeImageUrls(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(IMAGE_URL_RE)) {
    const url = m[0];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Derive a before/after evidence pair for a paused run, purely from its data —
 *  graceful when nothing is present (returns null and the panel renders
 *  NOTHING).
 *
 *  Sources, most-authoritative first:
 *   1. The matched SOURCE-TICKET object (the same map item extractSourceTicket
 *      resolves) — the consumer side attaches `actualImageRef`/`expectedImageRef`
 *      to the ticket.
 *   2. The most recent FINDING object carrying those fields — scan phase-end
 *      outputs backward for a JSON object (or array of objects) whose item has
 *      an `actualImageRef`/`expectedImageRef`. This is what a QA/judge phase
 *      emits.
 *   3. Loose image URLs in the gated phase output text (`planText`), surfaced
 *      under the pair (or alone, if no pair was found).
 *
 *  Returns null only when NO image of any kind is found anywhere. */
function extractEvidence(
  events: RunEvent[],
  ticketItem: Record<string, unknown> | null,
  planText: string | null,
): Evidence | null {
  let actual: string | null = null;
  let expected: string | null = null;

  // (1) The source ticket the run is processing.
  const fromTicket = imageRefsOf(ticketItem);
  actual = fromTicket.actual;
  expected = fromTicket.expected;

  // (2) The most recent finding object carrying the explicit fields. Scan
  // phase-end outputs backward; parse each as JSON and look for an object —
  // or array of objects — with an *ImageRef. First hit (newest) wins.
  if (!actual && !expected) {
    const found = findImageRefsInEvents(events);
    actual = found.actual;
    expected = found.expected;
  }

  // (3) Loose image URLs in the gated phase output — exclude any already shown
  // as the actual/expected pair so we don't render the same shot twice.
  const pair = new Set([actual, expected].filter(Boolean) as string[]);
  const loose = scrapeImageUrls(planText).filter(u => !pair.has(u));

  if (!actual && !expected && loose.length === 0) return null;
  return { actual, expected, loose };
}

/** Best-effort parse of zero-or-more JSON OBJECTS out of a string: the whole
 *  string as an object, the first array's object elements, or (failing JSON) a
 *  fenced/embedded `{ … }` slice. Returns [] when nothing parses. Tolerant by
 *  design — a finding payload may be a bare object, an array of findings, or
 *  prose with an embedded JSON block. */
function parseObjectsLoose(text: string): Array<Record<string, unknown>> {
  const t = text.trim();
  const tryParse = (s: string): Array<Record<string, unknown>> | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) {
        return v.filter(
          (x): x is Record<string, unknown> => !!x && typeof x === 'object',
        );
      }
      if (v && typeof v === 'object') return [v as Record<string, unknown>];
    } catch {
      /* not JSON */
    }
    return null;
  };
  // Whole string.
  let r = tryParse(t);
  if (r) return r;
  // First embedded array.
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr && (r = tryParse(arr[0]))) return r;
  // First embedded object.
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj && (r = tryParse(obj[0]))) return r;
  return [];
}

const TICKET_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;
/** Atlassian site host (e.g. example.atlassian.net) — used to build a /browse/
 *  link. We only trust a host that actually appears in this run's data; we do
 *  NOT synthesize one from the opaque `cloudId`. */
const ATLASSIAN_HOST_RE = /https?:\/\/([a-z0-9.-]+\.atlassian\.net)\b/i;

/** Pull the FIRST JSON array of objects-with-`id` out of a string (tolerant of
 *  surrounding prose / code fences — the same shape the dev-cron's
 *  `normalize-tickets` bridge produces). Returns null if none parses. */
function parseTicketArray(text: unknown): Array<Record<string, unknown>> | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr) && arr.some(x => x && typeof x === 'object' && 'id' in x)) {
      return arr as Array<Record<string, unknown>>;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

/** Derive the SOURCE TICKET a paused run is processing, purely from its event
 *  stream — so it works for ANY run whose pause sits inside a ticket-bearing
 *  map, not just the dev-cron.
 *
 *  Strategy (most-reliable first):
 *   1. The current map iteration: the last `map-iteration` event's `iteration`
 *      is 1-based, so the active index is `iteration - 1`. This is a typed,
 *      first-class executor event.
 *   2. The tickets being mapped over: the most recent substantial `phase-end`
 *      output that parses as a JSON array of `{ id, summary, ... }` objects
 *      (the dev-cron's `normalize-tickets` / `fetch-tickets` bridge). Indexing
 *      that array at the iteration index yields a real `{ id, summary }`.
 *   3. Fallback when there's an iteration but no array (or the index is out of
 *      range): a ticket KEY via regex from the iteration's own context — the
 *      latest phase-end/delta input — yielding an id with no summary.
 *
 *  A Jira `/browse/` URL is attached only when an `*.atlassian.net` host
 *  appears somewhere in the run's events (e.g. a jira-adapter tool result).
 *
 *  Returns null when there's no map iteration or no ticket can be identified —
 *  most runs (e.g. an eval-gate run) have none, and render nothing. */
function extractSourceTicket(events: RunEvent[]): SourceTicket | null {
  // (1) Active map index — last map-iteration wins (handles serial maps that
  // emit one per ticket; the most recent is the one we're paused inside).
  let mapIndex: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; iteration?: number };
    if (e.type === 'map-iteration' && typeof e.iteration === 'number') {
      mapIndex = e.iteration - 1;
      break;
    }
  }
  if (mapIndex == null || mapIndex < 0) return null;

  // (2) The tickets array — scan backward for the most recent phase-end whose
  // output is a JSON array of {id,...} objects.
  let tickets: Array<Record<string, unknown>> | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; output?: unknown };
    if (e.type === 'phase-end') {
      const arr = parseTicketArray(e.output);
      if (arr) {
        tickets = arr;
        break;
      }
    }
  }

  if (tickets && mapIndex < tickets.length) {
    const item = tickets[mapIndex];
    const rawId = item.id;
    const id =
      typeof rawId === 'string' && TICKET_KEY_RE.test(rawId)
        ? (rawId.match(TICKET_KEY_RE) as RegExpMatchArray)[0]
        : typeof rawId === 'string'
          ? rawId
          : null;
    if (id) {
      const summary =
        typeof item.summary === 'string' && item.summary.trim()
          ? item.summary.trim()
          : null;
      return { id, summary, url: ticketUrl(events, id) };
    }
  }

  // (3) Fallback: a bare ticket key from the latest phase input/output text.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { input?: unknown; output?: unknown; text?: unknown };
    for (const field of [e.input, e.output, e.text]) {
      if (typeof field === 'string') {
        const km = field.match(TICKET_KEY_RE);
        if (km) return { id: km[0], summary: null, url: ticketUrl(events, km[0]) };
      }
    }
  }
  return null;
}

/** The RAW source-ticket OBJECT a paused run is processing — the same map item
 *  extractSourceTicket resolves its id/summary from, but returned whole so the
 *  evidence extractor can read the consumer-attached `actualImageRef` /
 *  `expectedImageRef` fields off it. Mirrors steps (1)+(2) of
 *  extractSourceTicket (active map index → tickets array → indexed item) and
 *  returns null when there's no map iteration or no array item at that index. */
function extractSourceTicketItem(
  events: RunEvent[],
): Record<string, unknown> | null {
  let mapIndex: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; iteration?: number };
    if (e.type === 'map-iteration' && typeof e.iteration === 'number') {
      mapIndex = e.iteration - 1;
      break;
    }
  }
  if (mapIndex == null || mapIndex < 0) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; output?: unknown };
    if (e.type === 'phase-end') {
      const arr = parseTicketArray(e.output);
      if (arr) return mapIndex < arr.length ? arr[mapIndex] : null;
    }
  }
  return null;
}

/** Build a Jira browse URL for `id`, but only if an Atlassian site host is
 *  present in the run's events. Returns null otherwise (we render plain text
 *  rather than guess a host). */
function ticketUrl(events: RunEvent[], id: string): string | null {
  for (const ev of events) {
    const e = ev as { output?: unknown; input?: unknown; text?: unknown };
    for (const field of [e.output, e.input, e.text]) {
      if (typeof field === 'string') {
        const m = field.match(ATLASSIAN_HOST_RE);
        if (m) return `https://${m[1]}/browse/${id}`;
      }
    }
  }
  return null;
}

/** Build the deck from a raw GET /api/runs payload. The summary carries no
 *  events[], so the gated phase resolves from the run-level `pausedFor`
 *  (extractGate's fallback); the plan/thread fill in per card from
 *  GET /api/runs/:id. */
function toPausedRuns(items: RunListItem[]): PausedRun[] {
  const out: PausedRun[] = [];
  for (const r of items) {
    if (r.status !== 'paused') continue;
    // A durable-wait park (timer / signal) is paused but is NOT awaiting a
    // human: nothing to review, and an eager "approve" here would resume
    // it before its deadline/signal. The Runs page still shows it.
    if (r.pendingWait) continue;
    const events = Array.isArray(r.events) ? r.events : [];
    const gate = extractGate(events, r.pausedFor);
    const rawDesc = r.orchestrationSnapshot?.description;
    const pausedAt = gate?.pausedAt || r.endedAt || r.startedAt;
    out.push({
      id: r.id,
      orchestrationName: r.orchestrationName ?? 'unknown',
      orchestrationDescription:
        typeof rawDesc === 'string' ? firstSentence(rawDesc) : null,
      startedAt: r.startedAt,
      pausedAt,
      gatedPhase: gate?.gatedPhase ?? r.pausedFor ?? 'a gated phase',
      plan: gate?.plan ?? null,
      planPhase: gate?.planPhase ?? null,
      upstream: gate?.upstream ?? [],
      stale: !!pausedAt && Date.now() - pausedAt > STALE_GATE_MS,
      events,
    });
  }
  // Fresh runs first, stale (≥7d) runs last; newest-paused within each group —
  // a reviewer opening the deck sees what just landed, and forgotten runs sink
  // to the bottom rather than burying the actionable ones.
  out.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    return b.pausedAt - a.pausedAt;
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Parallel fan-out detection (verdict grid)                                   */
/* -------------------------------------------------------------------------- */

/** One sibling branch of a parallel/map fan-out — its phase name, the PASS/FAIL
 *  verdict we inferred from its output, the raw output (for the evidence/expand
 *  toggle), and any image URLs scraped from it. */
type FanOutBranch = {
  name: string;
  verdict: 'pass' | 'fail' | 'unknown';
  output: string;
  images: string[];
};

/** A detected pre-gate fan-out: the composite's name + kind and its sibling
 *  branch verdicts. */
type FanOut = {
  phaseName: string;
  kind: 'parallel' | 'map';
  branches: FanOutBranch[];
};

/** Words in an output that signal a FAIL / PASS verdict. Order matters: we look
 *  for an explicit fail signal first (a single failing branch is the headline),
 *  then a pass signal. Kept generic — keyed on verdict vocabulary, not any one
 *  orchestration's schema. */
const FAIL_RE =
  /\b(?:fail(?:ed|ure|s)?|error(?:ed)?|broke[n]?|regress(?:ed|ion)?|blocked|reject(?:ed)?|✗|❌|🔴)\b/i;
const PASS_RE =
  /\b(?:pass(?:ed|es|ing)?|success(?:ful)?|ok|green|approved|✓|✅|🟢)\b/i;
/** A `"verdict"`/`"status"`/`"result"`-style JSON field with a pass/fail value —
 *  a more reliable signal than free-text when the branch emits a structured
 *  verdict object. */
const VERDICT_FIELD_RE =
  /["']?(?:verdict|status|result|outcome|state|pass(?:ed)?)["']?\s*:\s*["']?\s*(pass(?:ed)?|fail(?:ed)?|success|error|ok|green|red|true|false)/i;

/** Infer a PASS/FAIL verdict from a branch's output. Prefers a structured
 *  verdict field; falls back to free-text fail-then-pass keyword detection;
 *  `unknown` when neither fires (rendered neutrally — never a false PASS). */
function inferVerdict(output: string): 'pass' | 'fail' | 'unknown' {
  const field = output.match(VERDICT_FIELD_RE);
  if (field) {
    const v = field[1].toLowerCase();
    if (/^(fail|failed|error|red|false)$/.test(v)) return 'fail';
    if (/^(pass|passed|success|ok|green|true)$/.test(v)) return 'pass';
  }
  // Free-text: a fail signal anywhere makes the branch FAIL (a failing check is
  // the thing the reviewer must see); else a pass signal makes it PASS.
  if (FAIL_RE.test(output)) return 'fail';
  if (PASS_RE.test(output)) return 'pass';
  return 'unknown';
}

/** Detect whether the phase BEHIND this gate was a parallel/map fan-out and, if
 *  so, distill each sibling branch into a verdict.
 *
 *  Walk the event stream backward to the most recent CLOSED `parallel`/`map`
 *  composite (its `composite-end`), find its matching `composite-start` (by
 *  name, balancing nesting), and collect the `phase-end` events that ran inside
 *  that scope as the sibling branches. Only treats it as a fan-out when that
 *  composite sits BEHIND the gate (its end precedes the run-paused/lock-gate
 *  sentinel, or there's no sentinel yet) AND it has ≥2 substantive branches —
 *  otherwise returns null and the caller renders the normal linear thread.
 *
 *  Robust to map (one composite, many iterations) and parallel (one composite,
 *  many sibling leaves) alike: both emit their leaves' phase-ends within the one
 *  composite scope. Returns null for the common linear case. */
function extractFanOut(events: RunEvent[]): FanOut | null {
  // Index of the gate sentinel (if any) — the fan-out must precede it.
  let gateIdx = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string };
    if (e.type === 'run-paused' || e.type === 'lock-gate') {
      gateIdx = i;
      break;
    }
  }

  // Most recent parallel/map composite-end that sits before the gate.
  let endIdx = -1;
  let name: string | null = null;
  let kind: 'parallel' | 'map' | null = null;
  for (let i = gateIdx - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; phaseName?: string; kind?: string };
    if (
      e.type === 'composite-end' &&
      (e.kind === 'parallel' || e.kind === 'map') &&
      typeof e.phaseName === 'string'
    ) {
      endIdx = i;
      name = e.phaseName;
      kind = e.kind;
      break;
    }
  }
  if (endIdx < 0 || !name || !kind) return null;

  // Matching composite-start for `name`, balancing same-named nesting.
  let startIdx = -1;
  let depth = 0;
  for (let i = endIdx - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; phaseName?: string };
    if (e.phaseName !== name) continue;
    if (e.type === 'composite-end') depth++;
    else if (e.type === 'composite-start') {
      if (depth === 0) {
        startIdx = i;
        break;
      }
      depth--;
    }
  }
  if (startIdx < 0) return null;

  // Collect this scope's branch phase-ends. To keep to the fan-out's OWN
  // leaves (not a nested composite's grandchildren), track nested composite
  // depth and only take phase-ends at depth 0 of THIS composite.
  const branches: FanOutBranch[] = [];
  let nest = 0;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const e = events[i] as {
      type?: string;
      phaseName?: string;
      output?: unknown;
    };
    if (e.type === 'composite-start') nest++;
    else if (e.type === 'composite-end') nest--;
    else if (
      e.type === 'phase-end' &&
      typeof e.phaseName === 'string' &&
      typeof e.output === 'string'
    ) {
      const output = e.output;
      if (output.trim().length < MIN_PLAN_CHARS) continue;
      // For a `map`, nested leaves (one per item) are the branches even though
      // they sit under per-item composites — so include phase-ends at any
      // nest level for map. For `parallel`, the branches are the direct
      // children (nest 0); deeper ones are a branch's internal sub-steps.
      if (kind === 'parallel' && nest !== 0) continue;
      branches.push({
        name: e.phaseName,
        verdict: inferVerdict(output),
        output,
        images: scrapeImageUrls(output),
      });
    }
  }

  // Need a genuine fan-out: at least two sibling branches. (A "parallel" with
  // one realized branch is effectively linear — let the thread view handle it.)
  if (branches.length < 2) return null;
  return { phaseName: name, kind, branches };
}

/* -------------------------------------------------------------------------- */
/* Plan-vs-diff detection + coloring                                          */
/* -------------------------------------------------------------------------- */

type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string };

/** Heuristic: does this output look like a unified diff rather than prose?
 *
 *  We don't want to misfire on a markdown bullet list (`- item`) or a
 *  task checklist, so a single leading `-` is NOT enough. We require
 *  real diff structure: a hunk header (`@@ ... @@`) or a git/unified
 *  file header (`diff --git`, `--- a/`, `+++ b/`, `Index:`), OR a
 *  meaningful density of +/- lines where BOTH additions AND deletions
 *  appear (a one-sided wall of `- bullets` stays prose). */
function looksLikeDiff(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n');
  let adds = 0;
  let dels = 0;
  let hunks = 0;
  let fileHeaders = 0;
  for (const raw of lines) {
    if (/^@@ .* @@/.test(raw)) hunks++;
    else if (/^diff --git /.test(raw)) fileHeaders++;
    else if (/^(---|\+\+\+) /.test(raw)) fileHeaders++;
    else if (/^Index: /.test(raw)) fileHeaders++;
    // Count body +/- lines, but not the +++/--- file markers (caught above).
    else if (/^\+/.test(raw)) adds++;
    else if (/^-/.test(raw)) dels++;
  }
  // Strong signal: an actual hunk header or git file header.
  if (hunks > 0 || fileHeaders >= 2) return true;
  // Fallback signal: genuine two-sided churn (both adds AND dels), and
  // enough of it to outweigh the chance it's a prose list with a stray
  // "+1" / "- bullet".
  if (adds >= 2 && dels >= 1) return true;
  if (dels >= 2 && adds >= 1) return true;
  return false;
}

/** Classify each line of a unified diff for coloring. */
function parseDiff(text: string): DiffLine[] {
  return text.split('\n').map(raw => {
    if (/^@@ .* @@/.test(raw)) return { kind: 'hunk' as const, text: raw };
    if (
      /^diff --git /.test(raw) ||
      /^index [0-9a-f]/.test(raw) ||
      /^(---|\+\+\+) /.test(raw) ||
      /^Index: /.test(raw) ||
      /^new file mode/.test(raw) ||
      /^deleted file mode/.test(raw)
    ) {
      return { kind: 'meta' as const, text: raw };
    }
    if (/^\+/.test(raw)) return { kind: 'add' as const, text: raw };
    if (/^-/.test(raw)) return { kind: 'del' as const, text: raw };
    return { kind: 'ctx' as const, text: raw };
  });
}

/** Render a unified diff with green/red line coloring — matches the
 *  app's existing diff palette (VersionHistoryPanel): dark Menlo lines,
 *  green for additions, red for deletions, dim for hunk/file headers. */
function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => parseDiff(text), [text]);
  return (
    <View style={styles.diffBlock}>
      {lines.map((line, i) => (
        <Text
          key={i}
          selectable
          style={[
            styles.diffLine,
            line.kind === 'add' && styles.diffLineAdd,
            line.kind === 'del' && styles.diffLineDel,
            line.kind === 'hunk' && styles.diffLineHunk,
            line.kind === 'meta' && styles.diffLineMeta,
          ]}>
          {line.text === '' ? ' ' : line.text}
        </Text>
      ))}
    </View>
  );
}

/** The proposal body: auto-detect JSON / diff / plan and render accordingly.
 *  JSON is pretty-printed monospace; diffs get green/red line coloring;
 *  everything else goes through the app's markdown renderer (headings /
 *  bullets / code emphasized). */
function ProposalBody({ plan }: { plan: string }) {
  // JSON is pretty-printed (monospace); a JSON-encoded string or text with
  // literal `\n` escapes gets real newlines (see formatOutput).
  const formatted = useMemo(() => formatOutput(plan), [plan]);
  const isDiff = useMemo(
    () => formatted.kind === 'text' && looksLikeDiff(formatted.text),
    [formatted],
  );
  if (formatted.kind === 'json') {
    return (
      <View style={styles.jsonBlock}>
        <Text selectable style={styles.jsonText}>
          {formatted.text}
        </Text>
      </View>
    );
  }
  if (isDiff) return <DiffView text={formatted.text} />;
  return (
    <View style={styles.markdownBody}>
      <Markdown source={formatted.text} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The page — renders the reviewer inline as the page body                    */
/* -------------------------------------------------------------------------- */

export function ApprovalsPage({
  onNavigate,
}: {
  /** The shell's page navigator (App.tsx). Optional: without it, "Open on
   *  Runs page" routes through the URL hash instead. */
  onNavigate?: (page: PageId) => void;
} = {}) {
  const toast = useToast();
  const [runs, setRuns] = useState<PausedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tickets the user has acted on this session — kept (with their
  // outcome) so the progress header can show "X approved · Y rejected"
  // even though they've left the live `runs` list.
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  // Tickets mid-`request-changes`: the run has gone `running` to produce a
  // revision, so it has dropped out of the paused `runs` list. We PIN the
  // run's last paused snapshot here so the card stays in focus showing a
  // "revising…" state until it re-pauses with the revision.
  const [revising, setRevising] = useState<Record<string, PausedRun>>({});
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const items = await listRuns<RunListItem>();
      if (!mounted.current) return;
      setRuns(toPausedRuns(items));
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError((err as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Poll the run list. Lightweight: one GET every POLL_MS, paused while
  // the tab is hidden so a backgrounded surface isn't hammering the
  // server.
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const g = globalThis as unknown as {
      setInterval: (fn: () => void, ms: number) => number;
      clearInterval: (h: number) => void;
      document?: { hidden?: boolean };
    };
    const h = g.setInterval(() => {
      if (g.document?.hidden) return;
      void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      g.clearInterval(h);
    };
  }, [refresh]);

  // The deck: paused runs the user hasn't acted on yet this session, PLUS
  // any run currently revising (pinned from its last paused snapshot so it
  // doesn't vanish while it's transiently `running`). Acted-on ids linger
  // in `runs` for a poll or two until the server flips their status —
  // `outcomes` masks them out immediately.
  const deck = useMemo(
    () => buildDeck(runs, outcomes, revising),
    [runs, outcomes, revising],
  );

  // The session tally counts only decisions THIS reviewer made. It is derived
  // from `outcomes`, which a poll never touches — so it can't flicker back.
  const { approved: approvedCount, rejected: rejectedCount } = useMemo(
    () => tally(outcomes),
    [outcomes],
  );

  // Runs with a gate POST in flight. A ref is the double-submit guard (it's
  // read synchronously, so a fast double click / Enter-on-a-focused-button +
  // the global Enter handler can't both get through before a re-render); the
  // mirrored state drives the disabled buttons.
  const inFlight = useRef<Set<string>>(new Set());
  const [inFlightCount, setInFlightCount] = useState(0);
  const beginFlight = useCallback((id: string): boolean => {
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    setInFlightCount(inFlight.current.size);
    return true;
  }, []);
  const endFlight = useCallback((id: string) => {
    inFlight.current.delete(id);
    if (mounted.current) setInFlightCount(inFlight.current.size);
  }, []);

  const act = useCallback(
    async (run: PausedRun, decision: 'approve' | 'reject', message?: string) => {
      // Already decided this session, or a decision for it is in flight —
      // a second POST would only 409 (and used to roll the tally back).
      if (outcomes[run.id] || !beginFlight(run.id)) return;
      // Optimistically record the outcome so the card drops from the deck
      // immediately and the counts update; reconcile on the next poll.
      const outcome: Outcome = decision === 'approve' ? 'approved' : 'rejected';
      setOutcomes(prev => ({ ...prev, [run.id]: outcome }));
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/gate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, message }),
        });
        if (res.status === 409) {
          // The gate is no longer open — decided elsewhere (another tab, the
          // API, a teammate). Keep the card out of the deck, but it isn't
          // this reviewer's decision, so it leaves the tally.
          setOutcomes(prev => ({ ...prev, [run.id]: 'resolved' }));
          toast.show(
            `"${run.orchestrationName}" was already decided elsewhere — removed from the deck.`,
            'info',
          );
          await refresh();
          return;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} ${body}`.trim());
        }
        if (decision === 'approve') {
          toast.show(
            message && message.trim()
              ? `Approved "${run.orchestrationName}" + sent correction — resuming`
              : `Approved "${run.orchestrationName}" — resuming`,
            'success',
          );
        } else {
          toast.show(`Rejected "${run.orchestrationName}" — run cancelled`, 'info');
        }
        // Re-sync so the badge + the next poll's truth are reflected.
        void refresh();
      } catch (err) {
        // Roll back the optimistic outcome so the ticket returns to the
        // deck and can be retried.
        setOutcomes(prev => {
          const next = { ...prev };
          delete next[run.id];
          return next;
        });
        toast.show(`Gate failed: ${(err as Error).message}`, 'error');
      } finally {
        endFlight(run.id);
      }
    },
    [toast, refresh, outcomes, beginFlight, endFlight],
  );

  // CLEAR STALE — cancel every run that's been paused past the stale window
  // (~7d). These are abandoned gates cluttering the deck; rejecting them
  // clears the gate server-side (the only durable way — a non-destructive
  // "dismiss" would just reappear on the next poll, since the run is still
  // paused). Optimistically masks each so the deck collapses immediately.
  const clearStale = useCallback(
    async (staleRuns: PausedRun[]) => {
      if (staleRuns.length === 0) return;
      setOutcomes(prev => {
        const next = { ...prev };
        for (const r of staleRuns) next[r.id] = 'rejected';
        return next;
      });
      const results = await Promise.allSettled(
        staleRuns.map(r =>
          fetch(`/api/runs/${encodeURIComponent(r.id)}/gate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decision: 'reject',
              message: 'Cleared as a stale gate (paused > 7 days).',
            }),
          }).then(res => {
            if (!res.ok) throw new Error(String(res.status));
          }),
        ),
      );
      const failed: PausedRun[] = [];
      results.forEach((res, i) => {
        if (res.status === 'rejected') failed.push(staleRuns[i]);
      });
      if (failed.length) {
        // Roll back the ones that didn't actually clear so they return to
        // the deck and can be retried.
        setOutcomes(prev => {
          const next = { ...prev };
          for (const r of failed) delete next[r.id];
          return next;
        });
      }
      const cleared = staleRuns.length - failed.length;
      if (cleared > 0) {
        toast.show(
          `Cleared ${cleared} stale gate${cleared === 1 ? '' : 's'}.`,
          'info',
        );
      }
      if (failed.length) {
        toast.show(
          `${failed.length} stale gate${
            failed.length === 1 ? '' : 's'
          } couldn't be cleared — try again.`,
          'error',
        );
      }
      void refresh();
    },
    [toast, refresh],
  );

  // REQUEST CHANGES — the revise-and-re-pause loop. POST the gate, then
  // poll GET /api/runs/:id until the run pauses again with a NEW revision
  // (a phase-end of the reviewed phase appended after our gate-decision).
  // Keeps the SAME ticket in focus throughout (pinned in `revising`).
  const requestChanges = useCallback(
    async (run: PausedRun, message: string) => {
      const msg = message.trim();
      if (!msg) {
        toast.show('Enter feedback to request changes.', 'info');
        return;
      }
      // One gate POST per run at a time (a repeated ⌘/Ctrl+Enter would 409).
      if (!beginFlight(run.id)) return;
      // Baseline the reviewed phase's revision count from the AUTHORITATIVE
      // run (not the possibly-stale list snapshot) so we can detect a
      // genuinely-new revision once it re-pauses. Counts phase-end events
      // for the reviewed phase directly — robust even if planPhase wasn't
      // derivable from the list payload.
      const countAgentTurns = (events: RunEvent[]): number => {
        const g = extractGate(events, run.gatedPhase);
        if (!g?.planPhase) return 0;
        return buildThread(events, g.planPhase).filter(t => t.kind === 'agent')
          .length;
      };
      let priorAgentTurns = run.planPhase
        ? buildThread(run.events, run.planPhase).filter(t => t.kind === 'agent')
            .length
        : 0;
      try {
        const base = await getRun<{ events?: RunEvent[] }>(run.id);
        if (Array.isArray(base.events)) {
          priorAgentTurns = countAgentTurns(base.events);
        }
      } catch {
        // Fall back to the list-derived baseline.
      }
      setRevising(prev => ({ ...prev, [run.id]: run }));
      try {
        let res: Response;
        try {
          res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/gate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'request-changes', message: msg }),
          });
        } finally {
          // The revise loop below is covered by `revising`; only the POST
          // itself needs the in-flight guard.
          endFlight(run.id);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} ${body}`.trim());
        }
        toast.show(
          `Requested changes on "${run.orchestrationName}" — revising…`,
          'info',
        );

        // Poll for the re-pause. Bounded so a stuck/aborted revision frees
        // the card instead of spinning forever.
        const deadline = Date.now() + REVISE_POLL_TIMEOUT_MS;
        let repaused = false;
        while (mounted.current && Date.now() < deadline) {
          await sleep(REVISE_POLL_MS);
          if (!mounted.current) return;
          let full: {
            status?: string;
            pausedFor?: string;
            events?: RunEvent[];
          };
          try {
            full = await getRun(run.id);
          } catch {
            continue; // transient — keep polling until the deadline
          }
          const status = full.status;
          if (status === 'paused') {
            const events = Array.isArray(full.events) ? full.events : [];
            // Re-paused AND a fresh revision landed (one more agent turn for
            // the reviewed phase than before we sent the feedback).
            if (countAgentTurns(events) > priorAgentTurns) {
              repaused = true;
              break;
            }
            // Paused but no new revision yet (rare race) — keep waiting.
          } else if (
            status === 'done' ||
            status === 'error' ||
            status === 'cancelled'
          ) {
            // The run finished/failed instead of re-pausing — stop tracking
            // it as revising; the deck will reconcile on the next poll.
            toast.show(
              `"${run.orchestrationName}" ${status} during revision.`,
              status === 'error' ? 'error' : 'info',
            );
            break;
          }
        }
        if (repaused) {
          toast.show(`Revision ready for "${run.orchestrationName}".`, 'success');
        } else if (mounted.current && Date.now() >= deadline) {
          toast.show(
            `Still revising "${run.orchestrationName}" — check back shortly.`,
            'info',
          );
        }
        await refresh();
      } catch (err) {
        toast.show(`Request changes failed: ${(err as Error).message}`, 'error');
      } finally {
        // Unpin — the fresh paused snapshot (with the revision) now comes
        // from the normal `runs` poll.
        if (mounted.current) {
          setRevising(prev => {
            const next = { ...prev };
            delete next[run.id];
            return next;
          });
        }
      }
    },
    [toast, refresh, beginFlight, endFlight],
  );

  const revisingIds = useMemo(() => new Set(Object.keys(revising)), [revising]);

  // "Open on Runs page" for a card. Hands the run id to the Runs page (so it
  // opens on THAT run) and navigates there.
  const openRun = useCallback(
    (runId: string) => {
      requestRun(runId);
      if (onNavigate) onNavigate('runs');
      else navigateTo({ page: 'runs' });
    },
    [onNavigate],
  );

  const subtitle = loading
    ? 'Loading paused runs…'
    : deck.length > 0
      ? `${deck.length} run${deck.length === 1 ? '' : 's'} paused at a human gate — review the plan, then approve, reject, or request changes`
      : 'Runs paused at a human gate land here for review';

  return (
    <Page
      title="Approvals"
      subtitle={subtitle}
      badge={deck.length > 0 ? String(deck.length) : undefined}>
      <ApprovalsReviewer
        deck={deck}
        loading={loading}
        error={error}
        approvedCount={approvedCount}
        rejectedCount={rejectedCount}
        revisingIds={revisingIds}
        deciding={inFlightCount > 0}
        onOpenRun={openRun}
        onApprove={(run, msg) => void act(run, 'approve', msg)}
        onReject={run => void act(run, 'reject')}
        onRequestChanges={(run, msg) => void requestChanges(run, msg)}
        onRefresh={() => void refresh()}
        onClearStale={staleRuns => void clearStale(staleRuns)}
      />
    </Page>
  );
}

/* -------------------------------------------------------------------------- */
/* The inline stepper-reviewer (the page body)                                */
/* -------------------------------------------------------------------------- */

function ApprovalsReviewer({
  deck,
  loading,
  error,
  approvedCount,
  rejectedCount,
  revisingIds,
  deciding,
  onOpenRun,
  onApprove,
  onReject,
  onRequestChanges,
  onRefresh,
  onClearStale,
}: {
  deck: PausedRun[];
  loading: boolean;
  error: string | null;
  approvedCount: number;
  rejectedCount: number;
  revisingIds: Set<string>;
  /** A gate decision is in flight — the action buttons stay disabled. */
  deciding: boolean;
  /** Open this run on the Runs page. */
  onOpenRun: (runId: string) => void;
  onApprove: (run: PausedRun, message?: string) => void;
  onReject: (run: PausedRun) => void;
  onRequestChanges: (run: PausedRun, message: string) => void;
  onRefresh: () => void;
  /** Cancel all currently-stale (≥7d) paused runs, clearing them from the deck. */
  onClearStale: (staleRuns: PausedRun[]) => void;
}) {
  // Index into the deck. Clamped as the deck shrinks (a card leaves the
  // deck the instant it's approved/rejected).
  const [idx, setIdx] = useState(0);
  // Per-card entry-box text, keyed by run id so stepping away and back
  // doesn't lose what you typed.
  const [messages, setMessages] = useState<Record<string, string>>({});

  const total = deck.length;
  const clampedIdx = total === 0 ? 0 : Math.min(idx, total - 1);
  const current: PausedRun | undefined = deck[clampedIdx];
  const currentRevising = current ? revisingIds.has(current.id) : false;

  // CARD-SWAP GUARD. After an approve the next card slides into the same slot
  // with its Approve button under the cursor, so a fast double click would
  // approve a run nobody looked at. A freshly shown card is "armed" only
  // after CARD_SWAP_GUARD_MS; until then its actions (buttons AND keyboard)
  // are inert. Keyed on the card id, so a poll refreshing the same card
  // doesn't re-trigger it.
  const currentId = current?.id ?? null;
  const [armedId, setArmedId] = useState<string | null>(null);
  useEffect(() => {
    if (!currentId) return;
    const g = globalThis as unknown as {
      setTimeout: (fn: () => void, ms: number) => number;
      clearTimeout: (h: number) => void;
    };
    const h = g.setTimeout(() => setArmedId(currentId), CARD_SWAP_GUARD_MS);
    return () => g.clearTimeout(h);
  }, [currentId]);
  const actionsLocked = deciding || (currentId != null && armedId !== currentId);

  // Keep idx in range whenever the deck length changes underneath us.
  useEffect(() => {
    setIdx(i => (total === 0 ? 0 : Math.min(i, total - 1)));
  }, [total]);

  const goPrev = useCallback(() => setIdx(i => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setIdx(i => Math.min(Math.max(0, total - 1), i + 1)),
    [total],
  );

  const setMessage = useCallback((id: string, text: string) => {
    setMessages(prev => ({ ...prev, [id]: text }));
  }, []);

  const clearMessage = useCallback((id: string) => {
    setMessages(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const approveCurrent = useCallback(() => {
    if (!current || revisingIds.has(current.id) || actionsLocked) return;
    const msg = (messages[current.id] ?? '').trim();
    onApprove(current, msg ? msg : undefined);
    // Card leaves the deck; the index stays put so the NEXT pending card
    // (which slides into this slot) is shown. Clamp handles the tail.
  }, [current, messages, onApprove, revisingIds, actionsLocked]);

  const rejectCurrent = useCallback(() => {
    if (!current || revisingIds.has(current.id) || actionsLocked) return;
    onReject(current);
  }, [current, onReject, revisingIds, actionsLocked]);

  // REQUEST CHANGES — send the feedback, clear the box, keep the card in
  // focus (it flips to a "revising…" state via revisingIds).
  const requestChangesCurrent = useCallback(() => {
    if (!current || revisingIds.has(current.id) || actionsLocked) return;
    const msg = (messages[current.id] ?? '').trim();
    if (!msg) return;
    onRequestChanges(current, msg);
    clearMessage(current.id);
  }, [current, messages, onRequestChanges, clearMessage, revisingIds, actionsLocked]);

  // SKIP-FOR-NOW: leave the ticket pending, just advance past it. At the
  // tail it wraps back to the start so you can keep circling the
  // remaining deck.
  const skipCurrent = useCallback(() => {
    setIdx(i => (total <= 1 ? 0 : (i + 1) % total));
  }, [total]);

  // Keyboard map. ←/→ traverse, Enter approves + advances, ⌘/Ctrl+Enter
  // requests changes (works even from the entry box — the modifier
  // disambiguates it from a plain newline). A plain Enter inside the entry
  // textarea makes a newline rather than approving. Arrows still traverse
  // even from the textarea — they don't conflict with multiline editing in
  // practice and keep the deck navigable, but we let the textarea keep
  // ← / → when it's focused so caret movement works.
  //
  // Esc is intentionally NOT bound: Approvals is a full nav page now, not a
  // modal, so there's nothing to "close" — leaving is the left nav's job.
  useEffect(() => {
    function onKey(e: {
      key: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      preventDefault: () => void;
      target?: unknown;
    }) {
      const targetTag =
        ((e.target as { tagName?: string } | undefined)?.tagName ?? '').toLowerCase();
      const inTextField = targetTag === 'textarea' || targetTag === 'input';
      // ⌘/Ctrl+Enter — request changes (allowed from inside the entry box).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        requestChangesCurrent();
        return;
      }
      if (e.key === 'ArrowLeft' && !inTextField) {
        e.preventDefault();
        goPrev();
        return;
      }
      if (e.key === 'ArrowRight' && !inTextField) {
        e.preventDefault();
        goNext();
        return;
      }
      if (e.key === 'Enter' && !inTextField) {
        e.preventDefault();
        approveCurrent();
        return;
      }
    }
    const g = globalThis as unknown as {
      addEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
      removeEventListener(t: string, fn: (e: KeyboardEvent) => void): void;
    };
    g.addEventListener('keydown', onKey as (e: KeyboardEvent) => void);
    return () =>
      g.removeEventListener('keydown', onKey as (e: KeyboardEvent) => void);
  }, [goPrev, goNext, approveCurrent, requestChangesCurrent]);

  const reviewedTotal = approvedCount + rejectedCount;

  // Stale (≥7d) runs currently in the deck — drives the "clear stale"
  // affordance. The clear is destructive (cancels the runs), so it's a
  // two-step press: the first tap arms a "Confirm" state, the second fires.
  const staleRuns = useMemo(() => deck.filter(r => r.stale), [deck]);
  const [confirmClear, setConfirmClear] = useState(false);
  // Disarm the confirm if the stale set empties (e.g. after a successful clear
  // or a poll that reconciled them away).
  useEffect(() => {
    if (staleRuns.length === 0) setConfirmClear(false);
  }, [staleRuns.length]);
  const onClearStalePress = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    onClearStale(staleRuns);
  }, [confirmClear, onClearStale, staleRuns]);

  return (
    <View style={styles.reviewer}>
      {/* Progress / review-state header — a section sub-header inside the
          page (the <Page> chrome already names the section "Approvals"). */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>
            {total > 0
              ? `Ticket ${clampedIdx + 1} of ${total}`
              : reviewedTotal > 0
                ? 'All caught up'
                : 'Approvals'}
          </Text>
          <Text style={styles.headerCounts}>
            <Text style={styles.countApproved}>{approvedCount} approved</Text>
            {'  ·  '}
            <Text style={styles.countRejected}>{rejectedCount} rejected</Text>
            {total > 0 ? `  ·  ${total} pending` : ''}
            {staleRuns.length > 0 ? (
              <Text style={styles.countStale}>
                {'  ·  '}
                {staleRuns.length} stale
              </Text>
            ) : null}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {staleRuns.length > 0 ? (
            <Pressable
              onPress={onClearStalePress}
              style={[styles.clearStaleBtn, confirmClear && styles.clearStaleBtnArmed]}
              accessibilityRole="button"
              accessibilityLabel={
                confirmClear
                  ? `Confirm clearing ${staleRuns.length} stale runs`
                  : `Clear ${staleRuns.length} stale runs`
              }>
              <Text
                style={[
                  styles.clearStaleText,
                  confirmClear && styles.clearStaleTextArmed,
                ]}>
                {confirmClear
                  ? `Confirm — clear ${staleRuns.length}?`
                  : `Clear stale (${staleRuns.length})`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onRefresh}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Refresh">
            <Text style={styles.iconBtnText}>↻</Text>
          </Pressable>
        </View>
      </View>

      {/* Body: the current card, or an empty / loading / error state. */}
      {error ? (
        <View style={styles.stateBox}>
          <Text style={styles.errorText}>Couldn't load runs: {error}</Text>
          <Pressable onPress={onRefresh} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : total === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.emptyTitle}>
            {loading ? 'Loading…' : 'No runs awaiting approval.'}
          </Text>
          {!loading && (
            <Text style={styles.emptySub}>
              {reviewedTotal > 0
                ? `You reviewed ${reviewedTotal} this session. A run reappears here whenever it pauses at a human lock gate.`
                : 'A run shows up here when it pauses at a human lock gate.'}
            </Text>
          )}
        </View>
      ) : current ? (
        <ReviewCard
          // Key by id so the entry box + per-run fetch reset when a
          // different card slides into the slot.
          key={current.id}
          run={current}
          message={messages[current.id] ?? ''}
          revising={currentRevising}
          actionsLocked={actionsLocked}
          onOpenRun={() => onOpenRun(current.id)}
          onChangeMessage={text => setMessage(current.id, text)}
          onApprove={approveCurrent}
          onReject={rejectCurrent}
          onRequestChanges={requestChangesCurrent}
        />
      ) : null}

      {/* Stepper controls + keyboard hint. Hidden in empty/error states. */}
      {total > 0 && current && (
        <View style={styles.footer}>
          <View style={styles.navRow}>
            <Pressable
              onPress={goPrev}
              disabled={clampedIdx === 0}
              style={[styles.navBtn, clampedIdx === 0 && styles.navBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Previous ticket">
              <Text style={styles.navBtnText}>← Back</Text>
            </Pressable>
            <Pressable
              onPress={skipCurrent}
              style={styles.skipBtn}
              accessibilityRole="button"
              accessibilityLabel="Skip for now">
              <Text style={styles.skipBtnText}>Skip for now</Text>
            </Pressable>
            <Pressable
              onPress={goNext}
              disabled={clampedIdx >= total - 1}
              style={[
                styles.navBtn,
                clampedIdx >= total - 1 && styles.navBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Next ticket">
              <Text style={styles.navBtnText}>Next →</Text>
            </Pressable>
          </View>
          <Text style={styles.kbdHint}>
            <Text style={styles.kbd}>←</Text>/<Text style={styles.kbd}>→</Text>{' '}
            move · <Text style={styles.kbd}>Enter</Text> approve ·{' '}
            <Text style={styles.kbd}>⌘/Ctrl+Enter</Text> request changes
          </Text>
        </View>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Conversation thread                                                        */
/* -------------------------------------------------------------------------- */

/** Render the per-ticket review conversation chat-style: agent turns (the
 *  plan + each revision) color-coded via ProposalBody (diff or markdown),
 *  and the human's feedback turns as right-aligned bubbles. Most recent at
 *  the bottom. The first agent turn is labelled "Plan"; subsequent ones
 *  "Revision N". */
function ConversationThread({
  thread,
  planPhase,
}: {
  thread: ThreadTurn[];
  planPhase: string;
}) {
  let agentSeen = 0;
  return (
    <View style={styles.thread}>
      {thread.map((turn, i) => {
        if (turn.kind === 'agent') {
          const n = agentSeen++;
          const label = n === 0 ? 'Plan' : `Revision ${n}`;
          return (
            <View key={i} style={styles.agentTurn}>
              <Text style={styles.turnLabelAgent}>
                {label} · {planPhase}
              </Text>
              <ProposalBody plan={turn.text} />
            </View>
          );
        }
        // user turn. Name the approver when the event recorded a real one —
        // an audit trail has to say who actually decided. An identity-less
        // decision (the server's `system` placeholder) came from a person
        // using this UI, so it reads "You" (see decisionLabel).
        return (
          <View key={i} style={styles.userTurn}>
            <Text style={styles.turnLabelUser}>{decisionLabel(turn)}</Text>
            {turn.text.trim() ? (
              <View style={styles.userBubble}>
                <Text selectable style={styles.userBubbleText}>
                  {turn.text}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Visual evidence (screenshots)                                              */
/* -------------------------------------------------------------------------- */

/** One screenshot: the image (RN-Web <Image>, contained so it never overflows
 *  the card), a caption beneath, and a tap-to-open-full link. If the image
 *  fails to load (404, auth, expired signed URL) we degrade to a labelled
 *  placeholder with a "open" link rather than a broken-image icon — so a dead
 *  ref never blocks the reviewer. */
function Screenshot({ uri, caption }: { uri: string; caption: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.shotCol}>
      <Text style={styles.shotCaption}>{caption}</Text>
      {failed ? (
        <Pressable
          onPress={() => openUrl(uri)}
          style={styles.shotBroken}
          accessibilityRole="button"
          accessibilityLabel={`${caption} — image unavailable, open in a new tab`}>
          <Text style={styles.shotBrokenText}>
            image unavailable{'\n'}
            <Text style={styles.shotBrokenLink}>open ↗</Text>
          </Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => openUrl(uri)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${caption} screenshot — tap to open full size`}>
          <Image
            source={{ uri }}
            resizeMode="contain"
            onError={() => setFailed(true)}
            style={styles.shotImg}
            accessibilityLabel={`${caption} screenshot`}
          />
        </Pressable>
      )}
    </View>
  );
}

/** VISUAL EVIDENCE panel: an Actual | Expected screenshot pair side-by-side
 *  above the plan, plus any additional ("loose") image URLs found in the gated
 *  phase output. Each side is shown only when present, so a finding with just
 *  an `actualImageRef` still renders (single column). The whole panel is
 *  conditionally mounted by the caller, so it contributes NOTHING when there's
 *  no evidence. */
function EvidencePanel({ evidence }: { evidence: Evidence }) {
  const { actual, expected, loose } = evidence;
  return (
    <View style={styles.evidence}>
      <Text style={styles.evidenceLabel}>Visual evidence</Text>
      {actual || expected ? (
        <View style={styles.shotRow}>
          {actual ? <Screenshot uri={actual} caption="Actual" /> : null}
          {expected ? <Screenshot uri={expected} caption="Expected" /> : null}
        </View>
      ) : null}
      {loose.length > 0 ? (
        <View style={styles.shotRow}>
          {loose.map((u, i) => (
            <Screenshot
              key={u}
              uri={u}
              caption={loose.length > 1 ? `Screenshot ${i + 1}` : 'Screenshot'}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Parallel fan-out verdict grid                                              */
/* -------------------------------------------------------------------------- */

/** PARALLEL FAN-OUT verdict grid: one row per sibling branch of a parallel/map
 *  composite — branch name, a PASS/FAIL/— pill, any screenshots scraped from
 *  the branch, and an expandable raw output. Replaces the linear thread when
 *  the phase behind the gate fanned out, so the reviewer sees all branches'
 *  verdicts at a glance instead of a single linear plan. A FAIL pill is the
 *  headline a reviewer needs before approving a fan-out. */
function VerdictGrid({ fanOut }: { fanOut: FanOut }) {
  const failCount = fanOut.branches.filter(b => b.verdict === 'fail').length;
  const passCount = fanOut.branches.filter(b => b.verdict === 'pass').length;
  return (
    <View style={styles.grid}>
      <Text style={styles.gridLabel}>
        {fanOut.kind === 'map' ? 'Map' : 'Parallel'} fan-out ·{' '}
        <Text style={styles.gridPhase}>{fanOut.phaseName}</Text>
      </Text>
      <Text style={styles.gridSummary}>
        {fanOut.branches.length} branch
        {fanOut.branches.length === 1 ? '' : 'es'}
        {passCount > 0 ? (
          <Text style={styles.gridSummaryPass}> · {passCount} pass</Text>
        ) : null}
        {failCount > 0 ? (
          <Text style={styles.gridSummaryFail}> · {failCount} fail</Text>
        ) : null}
      </Text>
      {fanOut.branches.map((b, i) => (
        <VerdictRow key={`${b.name}-${i}`} branch={b} />
      ))}
    </View>
  );
}

/** A single fan-out branch row: name + verdict pill, screenshots (if any), and
 *  a tap-to-expand of the raw output. Collapsed by default so a wide fan-out
 *  stays scannable; failing branches start expanded so the problem is visible
 *  without a click. */
function VerdictRow({ branch }: { branch: FanOutBranch }) {
  const [open, setOpen] = useState(branch.verdict === 'fail');
  const pill =
    branch.verdict === 'pass'
      ? styles.pillPass
      : branch.verdict === 'fail'
        ? styles.pillFail
        : styles.pillUnknown;
  const pillText =
    branch.verdict === 'pass'
      ? 'PASS'
      : branch.verdict === 'fail'
        ? 'FAIL'
        : '—';
  return (
    <View
      style={[
        styles.gridRow,
        branch.verdict === 'fail' && styles.gridRowFail,
      ]}>
      <Pressable
        onPress={() => setOpen(o => !o)}
        style={styles.gridRowHead}
        accessibilityRole="button"
        accessibilityLabel={`${branch.name}: ${pillText}. Tap to ${
          open ? 'collapse' : 'expand'
        } output.`}>
        <View style={[styles.pill, pill]}>
          <Text style={styles.pillLabel}>{pillText}</Text>
        </View>
        <Text style={styles.gridRowName} numberOfLines={1}>
          {branch.name}
        </Text>
        <Text style={styles.gridRowChevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {branch.images.length > 0 ? (
        <View style={styles.shotRow}>
          {branch.images.map((u, i) => (
            <Screenshot
              key={u}
              uri={u}
              caption={
                branch.images.length > 1 ? `Shot ${i + 1}` : 'Screenshot'
              }
            />
          ))}
        </View>
      ) : null}
      {open ? <ProposalBody plan={branch.output} /> : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Decision-context strip                                                      */
/* -------------------------------------------------------------------------- */

/** Compact context ABOVE the plan so a reviewer understands WHAT they're
 *  approving and FOR WHAT — addresses "I'm not sure what I'm approving and
 *  for what." Two parts, both kept terse so the plan stays the focus:
 *
 *   1. PURPOSE — the orchestration's `description` (first sentence), shown
 *      only when present. Tells the reviewer what this run does.
 *   2. WHAT THIS DECISION DOES — names the producing phase (the plan shown
 *      below) and spells out each of the three actions: Approve clears the
 *      gate and continues; Reject cancels; Request changes re-runs the
 *      reviewed phase.
 *
 *  We deliberately do NOT try to name the phase(s) AFTER the gate: the
 *  orchestration tree mixes phases/parallel/route/map/subflow composites and
 *  unwinding to "the next sequential node" is non-trivial and easy to get
 *  wrong. Correct-but-general ("continues the orchestration") beats
 *  specific-but-wrong. We DO name the gated phase itself (`gatedPhase`, the
 *  run's authoritative `pausedFor`) and the producing phase (`planPhase`),
 *  both of which are reliably derived. */
function DecisionContext({
  description,
  sourceTicket,
  gatedPhase,
  planPhase,
  fanOutPhase,
  upstream,
}: {
  description: string | null;
  /** The Jira ticket this paused run is processing (when its pause sits inside
   *  a ticket-bearing map); null for runs with no source ticket. */
  sourceTicket: SourceTicket | null;
  /** The locked phase the gate sits before — clears on approve. */
  gatedPhase: string;
  /** The phase whose output is the reviewed plan; null when not derivable. */
  planPhase: string | null;
  /** Set when the reviewed output is a parallel/map fan-out's verdict grid —
   *  names that composite instead of whichever branch happened to end last. */
  fanOutPhase: string | null;
  /** Substantive phase names leading up to the reviewed plan (newest-first);
   *  rendered as a compact breadcrumb so the reviewer sees the lead-up. */
  upstream: string[];
}) {
  return (
    <View style={styles.ctxStrip}>
      {description ? (
        <View style={styles.ctxPurposeRow}>
          <Text style={styles.ctxPurposeLabel}>Purpose</Text>
          <Text style={styles.ctxPurposeText}>{description}</Text>
        </View>
      ) : null}

      {sourceTicket ? (
        <View style={styles.ctxPurposeRow}>
          <Text style={styles.ctxPurposeLabel}>Source ticket</Text>
          <Text style={styles.ctxPurposeText} numberOfLines={2}>
            {sourceTicket.url ? (
              <Text
                accessibilityRole="link"
                style={styles.ctxTicketLink}
                onPress={() => openUrl(sourceTicket.url)}>
                {sourceTicket.id}
              </Text>
            ) : (
              <Text style={styles.ctxStrong}>{sourceTicket.id}</Text>
            )}
            {sourceTicket.summary ? ` — ${sourceTicket.summary}` : ''}
          </Text>
        </View>
      ) : null}

      <View style={styles.ctxDecisionBox}>
        <Text style={styles.ctxDecisionTitle}>What this decision does</Text>
        {fanOutPhase ? (
          <Text style={styles.ctxLine}>
            You're reviewing the results of the{' '}
            <Text style={styles.ctxStrong}>{fanOutPhase}</Text> fan-out (shown
            below).
          </Text>
        ) : planPhase ? (
          <Text style={styles.ctxLine}>
            You're reviewing the output of{' '}
            <Text style={styles.ctxStrong}>{planPhase}</Text> (the phase shown
            below).
          </Text>
        ) : (
          <Text style={styles.ctxLine}>
            You're reviewing the output produced before the{' '}
            <Text style={styles.ctxStrong}>{gatedPhase}</Text> gate (shown
            below).
          </Text>
        )}
        {upstream.length > 0 ? (
          <Text style={styles.ctxLine} numberOfLines={2}>
            <Text style={styles.ctxUpstreamLabel}>upstream: </Text>
            {/* Reverse to oldest-first so the breadcrumb reads in run order
                (lead-up → plan). */}
            <Text style={styles.ctxUpstream}>
              {[...upstream].reverse().join(' → ')}
            </Text>
          </Text>
        ) : null}
        <Text style={styles.ctxLine}>
          <Text style={styles.ctxApprove}>Approve</Text> → clears the{' '}
          <Text style={styles.ctxStrong}>{gatedPhase}</Text> gate and the run
          continues.
        </Text>
        <Text style={styles.ctxLine}>
          <Text style={styles.ctxReject}>Reject</Text> → cancels the run.{'   '}
          <Text style={styles.ctxChanges}>Request changes</Text> → sends your
          feedback and re-runs{' '}
          <Text style={styles.ctxStrong}>{planPhase ?? 'the reviewed phase'}</Text>{' '}
          for another look.
        </Text>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* -------------------------------------------------------------------------- */

/** The run's named artifacts (e.g. a code.run step's full log), each with a
 *  View link that opens GET /api/runs/:id/artifacts?name= in a new tab. A
 *  gated step often points the reviewer at one ("open the test-log
 *  artifact"), so they sit right above the output under review. */
function ArtifactLinks({
  runId,
  artifacts,
}: {
  runId: string;
  artifacts: ArtifactRef[];
}) {
  return (
    <View style={styles.artifacts}>
      <Text style={styles.artifactsTitle}>Artifacts</Text>
      {artifacts.map(a => (
        <View key={a.name} style={styles.artifactRow}>
          <Text style={styles.artifactName}>{a.name}</Text>
          <Text style={styles.artifactMeta} numberOfLines={1}>
            {a.phaseName ? `${a.phaseName} · ` : ''}
            {formatBytes(a.bytes)}
            {a.truncated ? ' · truncated' : ''}
            {a.dropped ? ' · dropped' : ''}
          </Text>
          {a.dropped ? null : (
            <Pressable
              onPress={() => openUrl(artifactUrl(runId, a.name))}
              accessibilityRole="link"
              accessibilityLabel={`View the ${a.name} artifact in a new tab`}>
              <Text style={styles.artifactLink}>View ↗</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* A single review card                                                       */
/* -------------------------------------------------------------------------- */

function ReviewCard({
  run,
  message,
  revising,
  actionsLocked,
  onOpenRun,
  onChangeMessage,
  onApprove,
  onReject,
  onRequestChanges,
}: {
  run: PausedRun;
  message: string;
  revising: boolean;
  /** A decision is in flight, or the card was just swapped in (the
   *  card-swap guard) — the action buttons are disabled. */
  actionsLocked: boolean;
  onOpenRun: () => void;
  onChangeMessage: (text: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: () => void;
}) {
  // Start from the list-derived gate; refine with the authoritative
  // per-run fetch (it carries the run-level pausedFor + freshest events,
  // and the checkpoint's lastOutput as a final fallback for the plan).
  // `events` drives the conversation thread, so we hold the freshest copy.
  const [gate, setGate] = useState<{
    gatedPhase: string;
    plan: string | null;
    planPhase: string | null;
    upstream: string[];
  }>({
    gatedPhase: run.gatedPhase,
    plan: run.plan,
    planPhase: run.planPhase,
    upstream: run.upstream,
  });
  const [events, setEvents] = useState<RunEvent[]>(run.events);
  // Has the authoritative per-run fetch landed (or failed)? The list payload
  // carries no events, so until then the card has nothing to show — render a
  // loading state rather than claiming no output was captured.
  const [loaded, setLoaded] = useState(run.events.length > 0);

  // Re-fetch the authoritative run on mount AND whenever a revision
  // finishes (revising flips true→false), so the thread picks up the new
  // revision + the latest gate-decision turns.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const full = await getRun<{
          status?: string;
          pausedFor?: string;
          events?: RunEvent[];
          lastOutput?: string;
        }>(run.id);
        if (!alive) return;
        const evs = Array.isArray(full.events) ? full.events : [];
        setEvents(evs);
        const g = extractGate(evs, full.pausedFor);
        if (g) {
          setGate({
            gatedPhase: g.gatedPhase,
            planPhase: g.planPhase,
            upstream: g.upstream,
            plan:
              g.plan ??
              (full.lastOutput && full.lastOutput.trim()
                ? full.lastOutput
                : null),
          });
        }
      } catch {
        // Keep the list-derived gate/events; the card still renders.
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [run.id, revising]);

  // The conversation: plan → feedback → revision → … (most recent last).
  const thread = useMemo(
    () => buildThread(events, gate.planPhase, gate.gatedPhase),
    [events, gate.planPhase, gate.gatedPhase],
  );
  // The Jira ticket this run is processing, if its pause sits inside a
  // ticket-bearing map (e.g. a dev loop fixing PROJ-123). Null for runs
  // with no source ticket (e.g. an eval-gate run) — renders nothing.
  const sourceTicket = useMemo(() => extractSourceTicket(events), [events]);
  // The raw source-ticket object (same map item), kept so we can read its
  // consumer-attached actualImageRef/expectedImageRef. Null when no map item.
  const sourceTicketItem = useMemo(
    () => extractSourceTicketItem(events),
    [events],
  );
  // VISUAL EVIDENCE — a before/after screenshot pair (+ any loose image URLs in
  // the plan), drawn from the source ticket, a finding object, or the gated
  // phase output. Null when there's no image anywhere → renders nothing.
  const evidence = useMemo(
    () => extractEvidence(events, sourceTicketItem, gate.plan),
    [events, sourceTicketItem, gate.plan],
  );
  // PARALLEL FAN-OUT — if the phase behind this gate was a parallel/map with
  // ≥2 sibling outputs (e.g. a deploy-fanout's qa-component branches), render a
  // verdict grid instead of the linear thread. Null for the linear case.
  const fanOut = useMemo(() => extractFanOut(events), [events]);
  // The fan-out REPLACES the plan only when the reviewed output is one of its
  // branches; when a later step synthesized the checks (e.g. a decide phase
  // ending "DECISION: SHIP"), that output is the headline and the fan-out
  // is shown beneath it as supporting context.
  const fanOutIsPlan = fanOutReplacesPlan(fanOut, gate.planPhase);
  // Named artifacts the run kept (e.g. a code.run step's test log) — a gated
  // step often says "open the X artifact", so list them with a View link.
  const artifacts = useMemo(() => extractArtifacts(events), [events]);
  // Fallback single-plan view when no thread turns exist yet (e.g. the
  // plan output is below the substantiality threshold but lastOutput is
  // present) — preserves the original card's behavior.
  const hasThread = thread.length > 0;
  const totalRevisions = thread.filter(t => t.kind === 'agent').length;

  const trimmed = message.trim();

  return (
    <View style={styles.cardWrap}>
      {/* Card header */}
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {run.orchestrationName}
        </Text>
        <Text style={styles.cardSub}>
          🔒 gate before{' '}
          <Text style={styles.cardPhase}>{gate.gatedPhase}</Text>
          {'  ·  '}
          {shortId(run.id)}
          {'  ·  '}
          {run.stale ? (
            <Text style={styles.cardStale}>paused {timeSince(run.pausedAt)}</Text>
          ) : (
            <>paused {timeSince(run.pausedAt)}</>
          )}
          {totalRevisions > 1
            ? `  ·  ${totalRevisions - 1} revision${
                totalRevisions - 1 === 1 ? '' : 's'
              }`
            : ''}
          {'  ·  '}
          <Text
            accessibilityRole="link"
            style={styles.cardRunLink}
            onPress={onOpenRun}>
            Open on Runs page ↗
          </Text>
        </Text>
        {run.stale ? (
          <Text style={styles.cardStaleBanner}>
            ⚠ This gate has been paused for over a week — likely abandoned.
          </Text>
        ) : null}
      </View>

      {/* The conversation thread — scrollable, chat-style. */}
      <ScrollView style={styles.cardScroll} nestedScrollEnabled>
        {/* Compact context strip: WHAT this run is for + WHAT approving does.
            Sits above the plan so the reviewer has the framing before the
            details; the plan stays the visual focus below it. */}
        <DecisionContext
          description={run.orchestrationDescription}
          sourceTicket={sourceTicket}
          gatedPhase={gate.gatedPhase}
          planPhase={gate.planPhase}
          fanOutPhase={fanOutIsPlan && fanOut ? fanOut.phaseName : null}
          upstream={gate.upstream}
        />
        {/* VISUAL EVIDENCE — before/after screenshots above the plan. Renders
            nothing when no image refs are present (graceful). */}
        {evidence ? <EvidencePanel evidence={evidence} /> : null}
        {artifacts.length > 0 ? (
          <ArtifactLinks runId={run.id} artifacts={artifacts} />
        ) : null}
        {!loaded ? (
          <Text style={styles.loadingPlan}>Loading the output under review…</Text>
        ) : fanOut && fanOutIsPlan ? (
          /* PARALLEL FAN-OUT — a verdict grid of the sibling branches, in
             place of the linear plan/thread. */
          <VerdictGrid fanOut={fanOut} />
        ) : hasThread ? (
          <ConversationThread
            thread={thread}
            planPhase={gate.planPhase ?? gate.gatedPhase}
          />
        ) : gate.plan ? (
          <>
            <Text style={styles.proposalLabel}>
              Proposal — output before "{gate.gatedPhase}"
            </Text>
            <ProposalBody plan={gate.plan} />
          </>
        ) : (
          <Text style={styles.noPlan}>
            No plan output was captured before this gate. The phase before
            the lock produced no substantial output — approve only if you
            know what's being unblocked.
          </Text>
        )}
        {/* The checks behind the reviewed decision, as context. */}
        {loaded && fanOut && !fanOutIsPlan ? <VerdictGrid fanOut={fanOut} /> : null}
        {revising && (
          <View style={styles.revisingRow}>
            <Text style={styles.revisingText}>
              Revising "{gate.planPhase ?? gate.gatedPhase}" with your
              feedback…
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Entry box + actions */}
      <View style={styles.actionArea}>
        <Text style={styles.msgLabel}>
          {revising
            ? 'Revising — actions paused until the revision lands'
            : 'Reply with feedback to revise, or approve to proceed'}
        </Text>
        <TextInput
          value={message}
          onChangeText={onChangeMessage}
          editable={!revising}
          placeholder="e.g. Tighten scope to the auth flow; drop the billing checks. Then I'll re-review…"
          style={[styles.msgInput, revising && styles.msgInputDisabled]}
          multiline
        />
        <View style={styles.actionButtons}>
          <Pressable
            onPress={onReject}
            disabled={revising || actionsLocked}
            style={[
              styles.actBtn,
              styles.rejectBtn,
              (revising || actionsLocked) && styles.actBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Reject and cancel this run">
            <Text style={styles.rejectBtnText}>✕ Reject</Text>
          </Pressable>
          <View style={styles.actionRight}>
            <Pressable
              onPress={onRequestChanges}
              disabled={revising || actionsLocked || !trimmed}
              style={[
                styles.actBtn,
                styles.changesBtn,
                (revising || actionsLocked || !trimmed) && styles.actBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Request changes — send feedback and revise this phase">
              <Text style={styles.changesBtnText}>
                {revising ? '↻ Revising…' : '↻ Request changes'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onApprove}
              disabled={revising || actionsLocked}
              style={[
                styles.actBtn,
                styles.approveBtn,
                (revising || actionsLocked) && styles.actBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Approve and resume this run">
              <Text style={styles.approveBtnText}>
                {trimmed ? '✓ Approve + send' : '✓ Approve'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** "3m ago" / "2h ago" / "just now" from an epoch-ms timestamp. */
function timeSince(ts: number): string {
  if (!ts) return 'unknown';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Last 8 chars of a run id, for a compact reference. */
function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}

/** Open an external URL in a new tab. RN-Web tsconfig doesn't pull DOM types,
 *  so we reach `window` through globalThis (the same pattern SettingsPage uses
 *  for in-app links); on native the cast finds nothing and it's a no-op. */
function openUrl(url: string | null): void {
  if (!url) return;
  try {
    const g = globalThis as unknown as {
      open?: (url: string, target?: string) => unknown;
    };
    g.open?.(url, '_blank');
  } catch {
    /* native — no-op */
  }
}

/** Trim an orchestration `description` to a compact lead-in for the context
 *  strip: the first sentence (up to the first `. ! ?`), else the first line,
 *  hard-capped so a paragraph-long description can't balloon the strip into a
 *  wall of text. Keeps the plan the visual focus. */
function firstSentence(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // First line only — a description's first line is its summary; later lines
  // are detail we don't need in the strip.
  const firstLine = t
    .split('\n')[0]
    // Drop parenthetical path/doc refs (e.g. "(docs/FOO.md)") — UI noise.
    .replace(/\s*\([^)]*\/[^)]*\)/g, '')
    .trim();
  // Stop at the first sentence terminator followed by whitespace/end.
  const m = firstLine.match(/^(.+?[.!?])(\s|$)/);
  let out = (m ? m[1] : firstLine).trim();
  const MAX = 180;
  if (out.length > MAX) out = out.slice(0, MAX).trimEnd() + '…';
  return out || null;
}

const styles = StyleSheet.create({
  // The inline reviewer — a full-height card filling the <Page> body, the
  // way RunsPage's two-column layout fills its page. `minHeight` keeps it
  // tall enough to be usable even inside the page's scroll container; the
  // ReviewCard's own scroll + the fixed footer handle overflow within it.
  reviewer: {
    flex: 1,
    minHeight: 520,
    flexDirection: 'column',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },

  // Progress / review-state header (a section sub-header within the page).
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  headerLeft: { flex: 1, gap: 2 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  headerCounts: { fontSize: 12, color: '#6b7280' },
  countApproved: { color: '#059669', fontWeight: '700' },
  countRejected: { color: '#dc2626', fontWeight: '700' },
  countStale: { color: '#b45309', fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // "Clear stale" affordance — a low-chrome amber button that arms a confirm
  // on first press (it cancels runs).
  clearStaleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
  },
  clearStaleBtnArmed: { borderColor: '#dc2626', backgroundColor: '#fef2f2' },
  clearStaleText: { fontSize: 12, color: '#b45309', fontWeight: '700' },
  clearStaleTextArmed: { color: '#dc2626' },
  iconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  iconBtnText: { fontSize: 16, color: '#6b7280' },

  // Empty / loading / error states.
  stateBox: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 200,
  },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: '#374151' },
  emptySub: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 420,
  },
  errorText: { fontSize: 13, color: '#b91c1c', textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  retryBtnText: { fontSize: 12, color: '#374151', fontWeight: '600' },

  // Review card.
  cardWrap: { flex: 1, flexDirection: 'column', minHeight: 0 },
  cardHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#111827' },
  cardSub: { fontSize: 12, color: '#6b7280' },
  cardPhase: { fontFamily: 'Menlo', fontWeight: '700', color: '#92400e' },
  cardRunLink: { color: '#2563eb', fontWeight: '600' },
  // Stale (≥7d) markers in the card header.
  cardStale: { color: '#b45309', fontWeight: '700' },
  cardStaleBanner: {
    marginTop: 6,
    fontSize: 11,
    color: '#92400e',
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },

  // Decision-context strip (above the plan). Compact + low-chrome so it
  // frames the plan without becoming a wall of text.
  ctxStrip: { gap: 8, marginBottom: 12 },
  ctxPurposeRow: { flexDirection: 'row', gap: 8, alignItems: 'baseline' },
  ctxPurposeLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  ctxPurposeText: {
    flex: 1,
    fontSize: 12,
    color: '#374151',
    lineHeight: 17,
  },
  ctxDecisionBox: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  ctxDecisionTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  ctxLine: { fontSize: 12, color: '#374151', lineHeight: 18 },
  ctxStrong: { fontWeight: '700', color: '#111827' },
  ctxTicketLink: {
    fontWeight: '700',
    color: '#2563eb',
    textDecorationLine: 'underline',
  },
  ctxApprove: { fontWeight: '700', color: '#059669' },
  ctxReject: { fontWeight: '700', color: '#dc2626' },
  ctxChanges: { fontWeight: '700', color: '#2563eb' },
  ctxUpstreamLabel: { fontSize: 11, color: '#9ca3af', fontWeight: '600' },
  ctxUpstream: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },

  cardScroll: {
    flexGrow: 1,
    flexShrink: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  proposalLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  markdownBody: {
    backgroundColor: '#fcfcfd',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f3f4f6',
    padding: 12,
    marginBottom: 12,
  },
  // Shown until the per-run fetch lands (the list payload has no events).
  loadingPlan: {
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
    paddingVertical: 12,
    marginBottom: 12,
  },
  // Pretty-printed JSON output — monospace, light. Long values WRAP: a
  // sideways scroller hid the end of a long string behind a scrollbar that
  // did not show, so the approver never saw the whole value.
  jsonBlock: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    marginBottom: 12,
  },
  jsonText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
    color: '#0f172a',
  },
  // Artifact list (mirrors RunsPage's ArtifactList).
  artifacts: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    padding: 8,
    gap: 4,
    backgroundColor: '#f9fafb',
    marginBottom: 12,
  },
  artifactsTitle: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  artifactRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  artifactName: { fontFamily: 'Menlo', fontSize: 12, color: '#111827' },
  artifactMeta: { fontSize: 12, color: '#6b7280', flex: 1 },
  artifactLink: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  noPlan: {
    fontSize: 12,
    color: '#92400e',
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fde68a',
    padding: 12,
    lineHeight: 18,
    marginBottom: 12,
  },

  // Conversation thread.
  thread: { gap: 4, paddingBottom: 4 },
  agentTurn: { marginBottom: 4 },
  turnLabelAgent: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  userTurn: { alignItems: 'flex-end', marginBottom: 10, marginTop: 2 },
  turnLabelUser: {
    fontSize: 10,
    fontWeight: '700',
    color: '#2563eb',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  userBubble: {
    maxWidth: '85%',
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    borderBottomRightRadius: 2,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  userBubbleText: { fontSize: 13, color: '#1e3a5f', lineHeight: 19 },

  // "Revising…" inline indicator (below the thread, above the entry box).
  revisingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  revisingText: { fontSize: 12, color: '#1d4ed8', fontWeight: '600' },

  // Diff view — matches VersionHistoryPanel's dark diff palette.
  diffBlock: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  diffLine: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#cbd5e1',
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  diffLineAdd: { backgroundColor: '#064e3b', color: '#a7f3d0' },
  diffLineDel: { backgroundColor: '#7f1d1d', color: '#fecaca' },
  diffLineHunk: { color: '#67e8f9', backgroundColor: '#0b2530' },
  diffLineMeta: { color: '#94a3b8', fontWeight: '700' },

  // Visual evidence — Actual | Expected screenshots above the plan.
  evidence: {
    marginBottom: 12,
    padding: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    gap: 8,
  },
  evidenceLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  // Side-by-side row that wraps to stacked on a narrow card.
  shotRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  shotCol: { flexGrow: 1, flexBasis: 200, minWidth: 160, gap: 4 },
  shotCaption: { fontSize: 11, fontWeight: '700', color: '#374151' },
  shotImg: {
    width: '100%',
    height: 220,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  shotBroken: {
    height: 220,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shotBrokenText: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'center',
    lineHeight: 20,
  },
  shotBrokenLink: { color: '#2563eb', fontWeight: '700' },

  // Parallel fan-out verdict grid.
  grid: { marginBottom: 12, gap: 6 },
  gridLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  gridPhase: { fontFamily: 'Menlo', color: '#92400e' },
  gridSummary: { fontSize: 12, color: '#6b7280', marginBottom: 2 },
  gridSummaryPass: { color: '#059669', fontWeight: '700' },
  gridSummaryFail: { color: '#dc2626', fontWeight: '700' },
  gridRow: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 8,
    gap: 6,
    backgroundColor: '#ffffff',
  },
  gridRowFail: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  gridRowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 44,
    alignItems: 'center',
  },
  pillPass: { backgroundColor: '#dcfce7' },
  pillFail: { backgroundColor: '#fee2e2' },
  pillUnknown: { backgroundColor: '#f3f4f6' },
  pillLabel: { fontSize: 10, fontWeight: '800', color: '#374151' },
  gridRowName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    fontFamily: 'Menlo',
  },
  gridRowChevron: { fontSize: 12, color: '#9ca3af', fontWeight: '700' },

  // Action area (correction + buttons).
  actionArea: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  msgLabel: { fontSize: 12, fontWeight: '600', color: '#374151' },
  msgInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    borderRadius: 6,
    padding: 9,
    fontSize: 13,
    minHeight: 56,
    color: '#1f2937',
  },
  msgInputDisabled: { backgroundColor: '#f3f4f6', color: '#9ca3af' },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  actionRight: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  actBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 6 },
  actBtnDisabled: { opacity: 0.45 },
  approveBtn: { backgroundColor: '#059669' },
  approveBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 13 },
  changesBtn: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#2563eb',
  },
  changesBtnText: { color: '#2563eb', fontWeight: '700', fontSize: 13 },
  rejectBtn: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dc2626',
  },
  rejectBtnText: { color: '#dc2626', fontWeight: '700', fontSize: 13 },

  // Stepper footer.
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
    gap: 6,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  navBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  skipBtn: { paddingHorizontal: 12, paddingVertical: 7 },
  skipBtnText: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  kbdHint: { fontSize: 11, color: '#9ca3af', textAlign: 'center' },
  kbd: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#6b7280',
    fontWeight: '700',
  },
});
