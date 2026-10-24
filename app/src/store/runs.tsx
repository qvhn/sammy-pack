import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { deleteRun, getRun, listRuns, readErrorBody, saveRun } from '../api';
import { readStoredIdentity } from '../../web/api-auth';
import { streamClaudeCode } from '../llm/claude-code';
import {
  PhaseChatQueue,
  runOrchestration,
  type RunEvent,
} from '../llm/executor';
import type { Node } from '../types';
import {
  collectNodeNames,
  deriveRunStatus,
  emptyRunStatus,
  type RunStatusInfo,
} from '../lib/runStatus';
import { addSpend, emptySpend } from '../lib/spend';
import {
  getAllowAgentTools,
  getApiKey,
  getAuthMode,
  getModel,
  getProviderKeys,
} from './apiKey';
import { buildProviderRegistry } from '../llm/providers';
import { useToast } from './toast';

export type RunStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'paused'
  | 'interrupted';

export type Run = {
  id: string;
  orchestrationName: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  events: RunEvent[];
  /** Monotonic counter bumped on every event push. The `events` array
   *  is mutated in place (push, or replace-last-on-coalesce) so its
   *  identity stays stable — components and useMemos that need to
   *  re-evaluate when events grow should depend on this counter, not
   *  on `events` itself. Avoids O(N²) array cloning under heavy
   *  streams (text-delta storms during agent tool loops). */
  eventVersion: number;
  /** Snapshot of the orchestration tree at run-start time. Lets us
   *  replay this run (with this exact orchestration shape) even if
   *  the saved orchestration file has since been edited. Optional
   *  for backward-compat with runs persisted before this field
   *  existed. */
  orchestrationSnapshot?: Node;
  /** The initial input fed into the orchestration. Same purpose as
   *  orchestrationSnapshot — needed for replay. */
  initialInput?: string;
  /** Short server-computed snippet of the run's most recent output —
   *  supplied by the LIST endpoint (GET /api/runs) so the sidebar row +
   *  its search-on-output work WITHOUT shipping the full events[]. On a
   *  hydrated / active run it's absent (the events array is the source of
   *  truth there); `runPreview` falls back to deriving from events. */
  preview?: string;
};

/** The lightweight shape GET /api/runs returns per run — no events[]. The
 *  list-load + poll paths normalize these into `Run` (events: []), then
 *  lazily hydrate the full event stream from GET /api/runs/:id on demand. */
type RunSummary = Omit<Run, 'events'> & { events?: RunEvent[] };

/** Normalize a list summary (or a full run) into a `Run` — events default to
 *  [] when the payload omitted them (the new summary shape), and eventVersion
 *  carries the server's true event count so hydrate/merge can detect growth. */
function summaryToRun(r: RunSummary): Run {
  const events = Array.isArray(r.events) ? r.events : [];
  return {
    ...r,
    events,
    eventVersion: r.eventVersion ?? events.length,
  };
}

export type PendingApproval = {
  phaseName: string;
  resolve: (approved: boolean) => void;
};

type Ctx = {
  active: Run | null;
  history: Run[];
  /** Async-fetch the full event stream for a history run and swap it
   *  into `history` in place. No-op for the active run or for runs
   *  already hydrated. Call this when the user navigates to a run
   *  detail view — avoids holding every run's full event log in
   *  memory just so the sidebar can show a one-line preview. */
  hydrateRun: (id: string) => void;
  /** Permanently delete a historical run from disk + drop it from
   *  the in-memory history list. Best-effort: persists asynchronously
   *  but updates state immediately so the UI reacts. Active run is
   *  not deletable — cancel it first. */
  deleteHistoryRuns: (ids: string[]) => Promise<void>;
  startRun: (orchestration: Node, initialInput?: string) => boolean;
  /** Like startRun, but the executor lives on the server. The browser
   *  becomes a thin SSE event consumer; closing the tab doesn't kill
   *  the run. Lock-gated phases snapshot+pause server-side (status
   *  flips to 'paused', a Resume button appears). Requires the
   *  Claude-Code-proxy auth path (uses CLI auth, not a browser-side
   *  API key). */
  startServerRun: (
    orchestration: Node,
    initialInput?: string,
    inputs?: Record<
      string,
      { value?: string; file?: { filename?: string; mediaType?: string; data?: string } }
    >,
  ) => boolean;
  /** Resume the currently-active run if it's in the paused state. */
  resumeServerRun: () => void;
  /** Act on a server-owned run paused at a `lock: true` gate. `approve`
   *  resumes it (re-attaching the live stream like resumeServerRun);
   *  `reject` cancels it. An optional `message` is delivered (with
   *  approve) to the gated phase's agent as an extra instruction.
   *  `request-changes` (message required) re-runs the gated work against
   *  the feedback and re-pauses — it resumes server-side like approve, so
   *  it re-attaches the stream the same way. Targets the live active run. */
  gateServerRun: (
    decision: 'approve' | 'reject' | 'request-changes',
    message?: string,
  ) => void;
  /** Resume ANY recoverable run by id — paused OR interrupted. Promotes
   *  it back into the active slot and re-attaches the live stream. Used
   *  by the Notifications view to pick up runs that didn't finish. */
  resumeServerRunById: (id: string) => Promise<void>;
  /** Recent run outcomes (done/error/interrupted/cancelled), newest
   *  first — the Notifications feed. Derived from history. */
  notifications: Run[];
  /** How many error/interrupted runs need attention — i.e. completed
   *  since the user last opened Notifications AND not individually
   *  acknowledged. Drives the sidebar badge. */
  attentionCount: number;
  /** Timestamp the user last viewed Notifications (drives unread). */
  notifSeenAt: number;
  /** Mark the Notifications feed as seen (clears the badge). */
  markNotificationsSeen: () => void;
  /** Run ids the user has explicitly acknowledged/dismissed in the
   *  Notifications feed. An acknowledged run no longer counts toward
   *  the attention badge, regardless of the seen-timestamp watermark.
   *  Persisted across reloads (best-effort, like notifSeenAt). */
  ackedIds: string[];
  /** Acknowledge/dismiss one or more runs by id — the granular
   *  counterpart to markNotificationsSeen. Adds the ids to the
   *  acknowledged set so they stop counting toward attention. Pass the
   *  full attention set to implement a "mark all seen" gesture. */
  acknowledgeNotifications: (ids: string[]) => void;
  /** Fork an existing run at a completed phase into a new run that
   *  replays everything before the fork point + re-executes from it. */
  forkServerRun: (sourceId: string, atPhase: string) => boolean;
  cancelRun: () => void;
  /** Cancel/stop ANY run by id (not just the live one) — used by the Runs
   *  view to stop a selected or interrupted run that isn't the active
   *  stream. Tells the server to abort it if it's executing, or mark it
   *  cancelled if it's only sitting interrupted/paused. Optimistically
   *  flips the run's local status to 'cancelled'. */
  cancelRunById: (id: string) => Promise<void>;
  /** Run ids for which a cancel has been requested but not yet confirmed
   *  terminal by the stream/poll. Drives instant "cancelling…" feedback on
   *  Stop buttons; prefer the `isCancelling` helper for readability. */
  cancelling: Set<string>;
  /** Whether a Stop/Cancel is in flight for this run id (added optimistically
   *  on the cancel POST, cleared when the run reaches a terminal status or the
   *  POST fails). */
  isCancelling: (id: string) => boolean;
  /** Whether the current run is paused (the agent has yielded control
   *  and is waiting between exchanges). UI surfaces this as a Pause /
   *  Resume button toggle. */
  paused: boolean;
  pauseRun: () => void;
  resumeRun: () => void;
  /** Inject a user message into the named phase's conversation. Takes
   *  effect on the next exchange — the agent receives it as the next
   *  user turn. If the phase is paused, this also acts as a resume. */
  sendChat: (phaseName: string, text: string) => void;
  pendingApproval: PendingApproval | null;
  approve: () => void;
  reject: () => void;
  lastError: string | null;
};

const RunsContext = createContext<Ctx | null>(null);

/** The SSE URL for a server-owned run, carrying the SAME identity and token
 *  the global fetch wrapper (web/api-auth.ts) sends as headers — as query
 *  parameters, because an EventSource cannot send headers. The server lifts
 *  `?owner=` into `X-Sammy-User` and `?token=` into `Authorization` for this
 *  one route before its gates run, so the stream is scoped and authenticated
 *  exactly like every fetch. Without this, a run started AS a user from
 *  Settings → User identity streamed as `system` and 404'd — the Runs view
 *  showed nothing for any non-default identity. Reads the wrapper's own
 *  localStorage keys through its own reader, so the key the Settings page
 *  writes, the header and the query string are one definition; absent (the
 *  single-user default) → the bare path. */
export function serverRunEventsUrl(runId: string): string {
  const base = `/api/runs/${encodeURIComponent(runId)}/events`;
  const { token, userId } = readStoredIdentity();
  const q = new URLSearchParams();
  if (userId) q.set('owner', userId);
  if (token) q.set('token', token);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Why the server refused to open a run's event stream. An EventSource
 *  reports a non-2xx response only as a closed socket, so re-ask for the
 *  run through the header-carrying fetch path and relay the status and
 *  the server's own text: a 401 names the auth gate (and where the token
 *  goes), a 404 the identity the run is not visible to. */
export async function explainRefusedStream(runId: string): Promise<string> {
  const label = `Run ${runId}: event stream refused`;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/summary`);
    if (res.ok) return `${label} by the server.`;
    const detail = await readErrorBody(res);
    const hint =
      res.status === 401 || res.status === 403
        ? ' — set the API token under Settings → User identity.'
        : '';
    return `${label} (${res.status}${detail ? ` ${detail}` : ''})${hint}`;
  } catch (err) {
    return `${label} (${(err as Error).message})`;
  }
}

export function RunsProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Run | null>(null);
  const [historyRaw, setHistory] = useState<Run[]>([]);
  // Readers see each run once, the FIRST copy kept. A run that finishes in
  // this tab is prepended with its full event stream; a poll that lands just
  // before can already have listed it as an event-less summary — two rows
  // with one id, and the detail showing the empty one ("(starting…)") with a
  // duplicate-key error.
  const history = useMemo(() => {
    const seen = new Set<string>();
    return historyRaw.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [historyRaw]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const approvalQueue = useRef<PendingApproval[]>([]);
  const cancelFlag = useRef<{ v: boolean }>({ v: false });
  const pauseFlag = useRef<{ v: boolean }>({ v: false });
  // Single chat queue per run — re-created on each startRun.
  const chatQueueRef = useRef<PhaseChatQueue>(new PhaseChatQueue());
  const [paused, setPaused] = useState(false);
  // Run ids for which a Stop/Cancel was requested but the run hasn't yet
  // reached a terminal status. Lets every Stop button flip to "cancelling"
  // instantly instead of waiting ~10s for the server to reap the subprocess
  // and the stream to reflect it. A NEW Set is created on every mutation so
  // React sees a fresh identity and re-renders. Cleared when the run goes
  // terminal (see clearCancelling) or if the cancel POST fails.
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  const markCancelling = useCallback((id: string) => {
    setCancelling(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const clearCancelling = useCallback((id: string) => {
    setCancelling(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  // For server-owned runs: the live EventSource handle (so we can
  // close it on cancel / unmount) and the run id (so resume + cancel
  // know what to address).
  const serverSourceRef = useRef<EventSource | null>(null);
  const serverRunIdRef = useRef<string | null>(null);
  // Runs whose full event stream is loaded in memory (active run is
  // always considered hydrated). Used to dedupe hydrateRun calls.
  const hydratedIds = useRef<Set<string>>(new Set());
  const inflightHydration = useRef<Set<string>>(new Set());
  // Out-of-band full event streams for NON-active running/paused runs, fetched
  // by the poll (the list ships summaries only now). Keyed by run id; the poll
  // merge splices these onto the summary so the editor canvas can animate a
  // CLI-mirrored / other-tab live run. `liveEventCounts` records the count we
  // last fetched so we only re-fetch when the run has grown.
  const liveEventsRef = useRef<Map<string, RunEvent[]>>(new Map());
  const liveEventCounts = useRef<Map<string, number>>(new Map());
  const liveFetchInflight = useRef<Set<string>>(new Set());

  /** Fetch the full event stream for a non-active running/paused run when it
   *  has grown past what we last pulled, caching it in liveEventsRef for the
   *  poll merge to splice on. Growth-aware (unlike hydrateRun, which is a
   *  one-shot for terminal-run detail views). No-op while a fetch is in
   *  flight or when we're already current. */
  const hydrateLiveRun = useCallback(
    async (id: string, freshVersion: number) => {
      if (liveFetchInflight.current.has(id)) return;
      const have = liveEventCounts.current.get(id) ?? -1;
      if (have >= freshVersion && freshVersion > 0) return;
      liveFetchInflight.current.add(id);
      try {
        const full = await getRun<Run>(id);
        const events = Array.isArray(full.events) ? full.events : [];
        liveEventsRef.current.set(id, events);
        liveEventCounts.current.set(id, events.length);
      } catch {
        /* transient — the next poll retries */
      } finally {
        liveFetchInflight.current.delete(id);
      }
    },
    [],
  );

  // ─── Notifications ────────────────────────────────────────────────
  // RunsProvider is mounted INSIDE ToastProvider (see App.tsx), so we can
  // pop a live toast the moment a run reaches a terminal state. The
  // persistent feed itself is derived from `history` further down, so it
  // also reflects runs that finished server-side while this tab was
  // closed (the production "pick up the latest events" case).
  const toast = useToast();
  const NOTIF_SEEN_KEY = 'sammy.notifSeenAt';
  const readNotifSeen = (): number => {
    try {
      const v = (
        globalThis as { localStorage?: { getItem(k: string): string | null } }
      ).localStorage?.getItem(NOTIF_SEEN_KEY);
      return v ? Number(v) || 0 : 0;
    } catch {
      return 0;
    }
  };
  const [notifSeenAt, setNotifSeenAt] = useState<number>(readNotifSeen);
  const markNotificationsSeen = useCallback(() => {
    const now = Date.now();
    setNotifSeenAt(now);
    try {
      (
        globalThis as { localStorage?: { setItem(k: string, v: string): void } }
      ).localStorage?.setItem(NOTIF_SEEN_KEY, String(now));
    } catch {
      /* localStorage unavailable (native / private mode) — badge just
         won't persist across reloads; not worth failing over. */
    }
  }, []);

  // Per-run acknowledgement set — the granular complement to the
  // seen-timestamp watermark. Lets the user dismiss an individual
  // outcome (or all of them) so it stops counting toward attention,
  // independent of when they last opened the feed.
  const NOTIF_ACK_KEY = 'sammy.notifAckedIds';
  const readAckedIds = (): string[] => {
    try {
      const v = (
        globalThis as { localStorage?: { getItem(k: string): string | null } }
      ).localStorage?.getItem(NOTIF_ACK_KEY);
      const parsed = v ? (JSON.parse(v) as unknown) : null;
      return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const [ackedIds, setAckedIds] = useState<string[]>(readAckedIds);
  const acknowledgeNotifications = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setAckedIds(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      const arr = [...next];
      try {
        (
          globalThis as { localStorage?: { setItem(k: string, v: string): void } }
        ).localStorage?.setItem(NOTIF_ACK_KEY, JSON.stringify(arr));
      } catch {
        /* localStorage unavailable — ack just won't persist across reloads. */
      }
      return arr;
    });
  }, []);
  // Live terminal toast. Held in a ref so attachServerRunStream (deps: [])
  // can call the latest version without re-binding on every render.
  const notifyTerminal = useCallback(
    (run: Run, status: RunStatus) => {
      const name = run.orchestrationName || 'run';
      if (status === 'done') toast.show(`✓ ${name} finished`, 'success');
      else if (status === 'error') toast.show(`✕ ${name} failed`, 'error');
      else if (status === 'interrupted')
        toast.show(`⚠ ${name} interrupted — resumable in Notifications`, 'error');
      else if (status === 'cancelled')
        toast.show(`⊘ ${name} cancelled`, 'info');
      // 'paused' is an expected lock gate, already surfaced inline — no toast.
    },
    [toast],
  );
  const notifyTerminalRef = useRef(notifyTerminal);
  useEffect(() => {
    notifyTerminalRef.current = notifyTerminal;
  }, [notifyTerminal]);

  /** Normalize a list SUMMARY into the minimum the sidebar needs. The list
   *  endpoint no longer ships events[] (it OOM'd the server), so there's
   *  nothing to trim — we keep an empty events array + the server's true
   *  event count (eventVersion) and the short `preview` snippet. Full events
   *  hydrate lazily from GET /api/runs/:id on selection (terminal runs) or
   *  via the poll (live runs, for the canvas). */
  function compactForSidebar(r: RunSummary): Run {
    return summaryToRun({ ...r, events: undefined });
  }

  // Load history from disk on mount — summaries only (no events[]).
  useEffect(() => {
    listRuns<RunSummary>()
      .then(list => {
        list.sort((a, b) => b.startedAt - a.startedAt);
        setHistory(list.map(compactForSidebar));
      })
      .catch(err => {
        // Non-fatal: persistence might not be set up yet.
        console.warn('[runs] failed to load history:', err);
      });
  }, []);

  const deleteHistoryRuns = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    // Drop from local state first so the UI reacts immediately; if
    // a server-side delete fails the user can re-list to recover
    // (the on-disk file still exists at that point).
    setHistory(prev => prev.filter(r => !ids.includes(r.id)));
    for (const id of ids) {
      hydratedIds.current.delete(id);
      inflightHydration.current.delete(id);
      liveEventsRef.current.delete(id);
      liveEventCounts.current.delete(id);
    }
    await Promise.all(
      ids.map(id =>
        deleteRun(id).catch(err => {
          console.warn(`[runs] failed to delete run ${id}:`, err);
        }),
      ),
    );
  }, []);

  const hydrateRun = useCallback((id: string) => {
    if (hydratedIds.current.has(id) || inflightHydration.current.has(id)) return;
    // Look up the compact copy in history; if it has as many events
    // as eventVersion, we already have the full set (e.g. very short
    // runs where tail >= total). Skip the network round-trip.
    const existing = historyRef.current.find(r => r.id === id);
    if (existing && existing.events.length >= existing.eventVersion) {
      hydratedIds.current.add(id);
      return;
    }
    fetchFullRun(id);
  }, []);

  /** Fetch a run's full event stream and swap it into `history`
   *  unconditionally (hydrateRun's dedupe checks are the caller's job). Also
   *  used by the poll to RE-hydrate a detail run that changed server-side —
   *  e.g. one approved from the Runs gate panel that then finished — whose
   *  hydrated copy the merge had to replace with an event-less summary. */
  function fetchFullRun(id: string): void {
    if (inflightHydration.current.has(id)) return;
    inflightHydration.current.add(id);
    getRun<Run>(id)
      .then(full => {
        hydratedIds.current.add(id);
        inflightHydration.current.delete(id);
        setHistory(prev =>
          prev.map(r =>
            r.id === id
              ? {
                  ...full,
                  eventVersion: full.eventVersion ?? full.events?.length ?? 0,
                }
              : r,
          ),
        );
      })
      .catch(err => {
        inflightHydration.current.delete(id);
        console.warn(`[runs] failed to hydrate run ${id}:`, err);
      });
  }

  // Mirror history into a ref so hydrateRun (which doesn't depend on
  // history in its deps) can read current state without re-creating
  // on every event.
  const historyRef = useRef<Run[]>([]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Mirror active into a ref so resumeServerRun (which is created
  // before the run exists) can read the current Run without forcing
  // a re-bind on every event.
  const activeRef = useRef<Run | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Poll the shared run store so runs started OUTSIDE this tab — a CLI/skill
  // run mirrored via `sammy-cli run-open`, or another browser — show up here
  // live and follow along (status flips, the Pipelines status dots update).
  // The locally-active run is driven by its own SSE stream, so we exclude it
  // from the merge to avoid clobbering its full event log with a header copy.
  // Hydrated detail runs are preserved when unchanged to avoid view churn.
  //
  // The list is SUMMARIES (no events[]) — so for non-active running/paused
  // runs whose events we need (the editor canvas derives live per-node status
  // from them) we fetch the full stream out-of-band into `liveEvents`, then
  // splice it onto the summary in the merge. Terminal runs stay event-light
  // and hydrate only on selection.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await listRuns<RunSummary>();
        if (cancelled) return;
        list.sort((a, b) => b.startedAt - a.startedAt);
        const activeId = activeRef.current?.id;
        // Kick off (growth-aware) event fetches for live, non-active runs so
        // the canvas can animate them. Fire-and-forget — results land in
        // liveEventsRef and show on a subsequent poll/render.
        const liveIds = new Set<string>();
        for (const fresh of list) {
          if (
            fresh.id !== activeId &&
            (fresh.status === 'running' || fresh.status === 'paused')
          ) {
            liveIds.add(fresh.id);
            void hydrateLiveRun(fresh.id, fresh.eventVersion ?? 0);
          }
        }
        // Prune the out-of-band live caches for runs that are no longer live
        // (terminal or gone) so the maps don't grow unbounded. Terminal-run
        // events hydrate on selection via hydrateRun instead.
        for (const id of [...liveEventsRef.current.keys()]) {
          if (!liveIds.has(id)) {
            liveEventsRef.current.delete(id);
            liveEventCounts.current.delete(id);
          }
        }
        // A hydrated (detail-viewed) run that changed server-side and is not
        // live — it finished after being approved / resumed outside this
        // tab's stream. The merge must drop its stale events for the
        // summary, and hydrateRun would never refetch an id it already
        // hydrated, so refetch the full run here.
        for (const fresh of list) {
          if (
            fresh.id === activeId ||
            liveIds.has(fresh.id) ||
            !hydratedIds.current.has(fresh.id)
          ) {
            continue;
          }
          const old = historyRef.current.find(r => r.id === fresh.id);
          const freshVersion = fresh.eventVersion ?? fresh.events?.length ?? 0;
          if (old && (old.status !== fresh.status || old.eventVersion < freshVersion)) {
            hydratedIds.current.delete(fresh.id);
            fetchFullRun(fresh.id);
          }
        }
        setHistory(prev => {
          // First copy wins (see `history`): it is the newest, full one.
          const prevById = new Map<string, Run>();
          for (const r of prev) if (!prevById.has(r.id)) prevById.set(r.id, r);
          return list
            .filter(fresh => fresh.id !== activeId)
            .map(fresh => {
              const old = prevById.get(fresh.id);
              const freshVersion = fresh.eventVersion ?? fresh.events?.length ?? 0;
              // Keep the full-event copy if nothing changed: one hydrated on
              // selection, or one that already holds every event because it
              // just finished in this tab (moved from `active` with its SSE
              // stream). Swapping the latter for the event-less summary made
              // a finished run's detail fall back to "(starting…)".
              // Never "keep" an event-less copy: once a hydrated live run grows
              // (a gate re-pause after request-changes) the merge below swaps
              // in the summary (events: [], eventVersion: the new count), and
              // trusting hydratedIds alone then pinned that EMPTY copy forever
              // — the detail stuck on "(starting…)".
              const complete =
                old !== undefined &&
                old.events.length > 0 &&
                (hydratedIds.current.has(fresh.id) || old.events.length >= freshVersion);
              if (
                old &&
                complete &&
                old.status === fresh.status &&
                old.eventVersion >= freshVersion
              ) {
                return old;
              }
              const base = compactForSidebar(fresh);
              // Splice in any out-of-band live events we've fetched for a
              // running/paused run (the canvas needs them). Only when they're
              // at least as fresh as the summary's count.
              const live = liveEventsRef.current.get(fresh.id);
              if (
                (fresh.status === 'running' || fresh.status === 'paused') &&
                live &&
                live.length >= freshVersion &&
                live.length > 0
              ) {
                return { ...base, events: live, eventVersion: live.length };
              }
              // Preserve a previously-spliced live-events copy across a poll
              // where our out-of-band fetch hasn't caught up yet, so the
              // canvas doesn't flicker empty.
              if (
                old &&
                (fresh.status === 'running' || fresh.status === 'paused') &&
                old.events.length >= freshVersion &&
                old.events.length > 0
              ) {
                return { ...base, events: old.events, eventVersion: old.events.length };
              }
              return base;
            });
        });
      } catch {
        /* transient — try again next tick */
      }
    };
    const iv = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close any live server-run SSE on provider unmount so we don't
  // leak EventSource handles + their auto-retry loops.
  useEffect(
    () => () => {
      serverSourceRef.current?.close();
    },
    [],
  );

  const waitForApproval = useCallback(
    (phaseName: string) =>
      new Promise<boolean>(resolve => {
        const approval: PendingApproval = { phaseName, resolve };
        setPendingApproval(curr => {
          if (curr) {
            // Already showing one — queue this for after.
            approvalQueue.current.push(approval);
            return curr;
          }
          return approval;
        });
      }),
    [],
  );

  const approve = useCallback(() => {
    setPendingApproval(curr => {
      if (curr) curr.resolve(true);
      return approvalQueue.current.shift() ?? null;
    });
  }, []);

  const reject = useCallback(() => {
    setPendingApproval(curr => {
      if (curr) curr.resolve(false);
      // Cascade-reject any queued approvals (user cancelled at the gate).
      for (const a of approvalQueue.current) a.resolve(false);
      approvalQueue.current = [];
      return null;
    });
  }, []);

  const startRun = useCallback(
    (orchestration: Node, initialInput?: string): boolean => {
      const authMode = getAuthMode();
      const apiKey = getApiKey() ?? '';
      if (authMode === 'direct-api-key' && !apiKey) {
        setLastError(
          'No Anthropic API key configured. Set one in Settings, or switch to Claude Code login mode.',
        );
        return false;
      }
      const model = getModel();
      const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : undefined;
      // Tools only flow through when auth mode is the proxy — direct-API
      // browser mode can't execute server-side tools, so we silently
      // strip them there regardless of the Settings toggle.
      const allowAgentTools =
        authMode === 'claude-code-proxy' && getAllowAgentTools();
      setLastError(null);

      // Events array is MUTATED in place across the whole run. We
      // re-create only the wrapper Run object on each event (cheap O(1))
      // and bump eventVersion so React sees a new reference. Drops
      // memory churn from O(N²) (full clone per event) to O(N) total.
      const eventsArr: RunEvent[] = [];
      let run: Run = {
        id: `run-${Date.now()}`,
        orchestrationName: orchestration.name,
        startedAt: Date.now(),
        status: 'running',
        events: eventsArr,
        eventVersion: 0,
        // Snapshot enables future replay even if the on-disk
        // orchestration is edited after this run starts.
        orchestrationSnapshot: orchestration,
        initialInput,
      };
      setActive(run);
      cancelFlag.current = { v: false };
      pauseFlag.current = { v: false };
      setPaused(false);
      chatQueueRef.current = new PhaseChatQueue();

      (async () => {
        let status: RunStatus = 'done';
        try {
          for await (const event of runOrchestration({
            orchestration,
            apiKey,
            model,
            streamFn,
            initialInput,
            waitForApproval,
            cancelled: cancelFlag.current,
            allowAgentTools,
            paused: pauseFlag.current,
            chatQueue: chatQueueRef.current,
            // Per-provider routing — any node with `provider: "openai"`
            // / `"gemini"` lands on the matching adapter. Keys come
            // from Settings; missing keys = that provider isn't in
            // the registry and the node falls back to the run-wide
            // streamFn (which will surface as a model mismatch).
            providerStreamFns: buildProviderRegistry(getProviderKeys()),
          })) {
            // Coalesce: consecutive phase-delta events for the same
            // phase are merged into the trailing one. Streaming text
            // arrives as many small chunks (sometimes one per token);
            // merging them ~10x reduces the array length and the
            // amount of work groupEvents does on each re-render.
            const last = eventsArr[eventsArr.length - 1];
            if (
              event.type === 'phase-delta' &&
              last?.type === 'phase-delta' &&
              last.phaseName === event.phaseName
            ) {
              eventsArr[eventsArr.length - 1] = {
                ...last,
                text: last.text + event.text,
                ts: event.ts,
              };
            } else {
              eventsArr.push(event);
            }
            if (event.type === 'run-error' || event.type === 'phase-error') {
              status = 'error';
            } else if (event.type === 'run-cancelled') {
              status = 'cancelled';
            } else if (event.type === 'phase-paused') {
              setPaused(true);
            } else if (event.type === 'phase-resumed') {
              setPaused(false);
            }
            run = { ...run, eventVersion: run.eventVersion + 1 };
            setActive(run);
          }
        } catch (err) {
          status = 'error';
          eventsArr.push({
            type: 'run-error',
            error: (err as Error).message,
            ts: Date.now(),
          });
          run = { ...run, eventVersion: run.eventVersion + 1 };
        }
        const completed: Run = { ...run, endedAt: Date.now(), status };
        setHistory(prev => [completed, ...prev].slice(0, 100));
        setActive(null);
        clearCancelling(completed.id);
        // Persist to disk (best-effort).
        try {
          await saveRun(completed);
        } catch (err) {
          console.warn('[runs] failed to persist run:', err);
        }
      })();
      return true;
    },
    [waitForApproval, clearCancelling],
  );

  /** Common SSE subscription logic shared by startServerRun + resume.
   *  Opens an EventSource on /api/runs/:id/events, pipes each parsed
   *  event into the local `eventsArr` (with phase-delta coalescing
   *  identical to the client-side path), and finalizes the run when a
   *  sentinel arrives. */
  const attachServerRunStream = useCallback(
    (
      runId: string,
      eventsArr: RunEvent[],
      seedRun: Run,
      onTerminal: (status: RunStatus) => void,
    ) => {
      // Close any prior subscription first — we should only ever have
      // one server-owned run streaming.
      serverSourceRef.current?.close();
      const es = new EventSource(serverRunEventsUrl(runId));
      serverSourceRef.current = es;
      serverRunIdRef.current = runId;
      let run = seedRun;
      // Track the latest status seen in the stream. run-paused and
      // run-resumed flip back and forth as the run pauses/resumes;
      // only run-end / run-error / run-cancelled are truly final.
      // If the server closes the SSE (es.onerror), we report
      // whatever status we last observed — that handles paused runs
      // (server closes after history) and run-interrupted alike.
      let latestStatus: RunStatus = 'running';
      let terminalFired = false;
      // Whether the server ever delivered an event on this socket. A
      // refused stream (non-2xx) never does; a clean close after history
      // always has.
      let receivedAny = false;
      const fireTerminalOnce = (status: RunStatus) => {
        if (terminalFired) return;
        terminalFired = true;
        es.close();
        // Run reached a terminal status — drop any pending "cancelling"
        // signal so the Stop button stops showing the in-flight state.
        // 'paused' is not terminal, but the stream never routes it here.
        clearCancelling(runId);
        onTerminal(status);
        // Live toast for the outcome (no-op for 'paused'/'running').
        notifyTerminalRef.current?.(run, status);
      };
      es.onmessage = msg => {
        receivedAny = true;
        if (msg.data === '[DONE]') {
          fireTerminalOnce(latestStatus);
          return;
        }
        let event: RunEvent;
        try {
          event = JSON.parse(msg.data);
        } catch {
          return;
        }
        const last = eventsArr[eventsArr.length - 1];
        if (
          event.type === 'phase-delta' &&
          last?.type === 'phase-delta' &&
          last.phaseName === event.phaseName
        ) {
          eventsArr[eventsArr.length - 1] = {
            ...last,
            text: last.text + event.text,
            ts: event.ts,
          };
        } else {
          eventsArr.push(event);
        }
        // Truly final — these close the stream.
        if (event.type === 'run-end') {
          latestStatus = (event as { status?: RunStatus }).status ?? 'done';
          fireTerminalOnce(latestStatus);
          return;
        }
        if (event.type === 'run-error') {
          latestStatus = 'error';
          fireTerminalOnce('error');
          return;
        }
        if (event.type === 'run-cancelled') {
          latestStatus = 'cancelled';
          fireTerminalOnce('cancelled');
          return;
        }
        if (event.type === 'run-interrupted') {
          latestStatus = 'interrupted';
          fireTerminalOnce('interrupted');
          return;
        }
        // Reversible — flip the status but keep listening. A
        // paused run that's later resumed sends run-resumed and
        // eventually a truly terminal event.
        if (event.type === 'run-paused') {
          latestStatus = 'paused';
          run = { ...run, status: 'paused', eventVersion: run.eventVersion + 1 };
          setActive(run);
          return;
        }
        if (event.type === 'run-resumed') {
          latestStatus = 'running';
          run = { ...run, status: 'running', eventVersion: run.eventVersion + 1 };
          setActive(run);
          return;
        }
        run = { ...run, eventVersion: run.eventVersion + 1 };
        setActive(run);
      };
      es.onerror = () => {
        // A non-2xx response — 401 under gated reads, 404 for a run this
        // identity cannot see — fails the connection for good: readyState
        // CLOSED with no event ever delivered. That is not "the server
        // closed the stream"; reporting the last status seen ('running')
        // here parked the run card as running forever with nothing said.
        // Name the refusal instead and end the run as an error locally.
        if (es.readyState === EventSource.CLOSED && !receivedAny) {
          void explainRefusedStream(runId).then(reason => {
            setLastError(reason);
            fireTerminalOnce('error');
          });
          return;
        }
        // Server closed the stream — either the run is done or the
        // run was paused and the controller closed after delivering
        // history. Report whatever status we last observed (default
        // 'running' if the stream closed before any terminal-ish
        // event arrived, which can happen on a freshly-paused run
        // we just reconnected to).
        fireTerminalOnce(latestStatus);
      };
    },
    [clearCancelling],
  );

  const startServerRun = useCallback(
    (
      orchestration: Node,
      initialInput?: string,
      inputs?: Record<
        string,
        { value?: string; file?: { filename?: string; mediaType?: string; data?: string } }
      >,
    ): boolean => {
      const authMode = getAuthMode();
      if (authMode !== 'claude-code-proxy') {
        setLastError(
          'Server-owned runs require Claude Code login mode. Switch in Settings.',
        );
        return false;
      }
      const allowAgentTools = getAllowAgentTools();
      const model = getModel();
      setLastError(null);

      const eventsArr: RunEvent[] = [];
      const seedRun: Run = {
        // Server assigns the real id; this placeholder updates when
        // the POST returns.
        id: 'pending-server-id',
        orchestrationName: orchestration.name,
        startedAt: Date.now(),
        status: 'running',
        events: eventsArr,
        eventVersion: 0,
        orchestrationSnapshot: orchestration,
        initialInput,
      };
      setActive(seedRun);

      (async () => {
        try {
          const res = await fetch('/api/runs/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              orchestrationName: orchestration.name,
              initialInput,
              model,
              allowAgentTools,
              inputs,
            }),
          });
          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`POST /api/runs/start failed: ${res.status} ${err}`);
          }
          const { id } = (await res.json()) as { id: string };
          const updated = { ...seedRun, id };
          setActive(updated);
          attachServerRunStream(id, eventsArr, updated, status => {
            // Paused runs stay active so the user can Resume; others
            // move to history.
            if (status === 'paused' || status === 'interrupted') {
              setActive(curr =>
                curr ? { ...curr, status, eventVersion: curr.eventVersion + 1 } : curr,
              );
              return;
            }
            setActive(null);
            setHistory(prev =>
              [
                {
                  ...updated,
                  endedAt: Date.now(),
                  status,
                  eventVersion: eventsArr.length,
                },
                ...prev,
              ].slice(0, 100),
            );
          });
        } catch (err) {
          setLastError((err as Error).message);
          setActive(null);
        }
      })();
      return true;
    },
    [attachServerRunStream],
  );

  /** Fork a finished / paused run at a chosen phase into a brand-new
   *  run. The server replays every leaf completed before `atPhase`
   *  from the source run's captured outputs, then re-executes from
   *  `atPhase`. Returns false if server-owned runs aren't available. */
  const forkServerRun = useCallback(
    (sourceId: string, atPhase: string): boolean => {
      if (getAuthMode() !== 'claude-code-proxy') {
        setLastError(
          'Server-owned runs require Claude Code login mode. Switch in Settings.',
        );
        return false;
      }
      setLastError(null);
      const eventsArr: RunEvent[] = [];
      const seedRun: Run = {
        id: 'pending-fork-id',
        orchestrationName: 'forking…',
        startedAt: Date.now(),
        status: 'running',
        events: eventsArr,
        eventVersion: 0,
      };
      setActive(seedRun);
      (async () => {
        try {
          const res = await fetch(
            `/api/runs/${encodeURIComponent(sourceId)}/fork`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ atPhase }),
            },
          );
          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`POST fork failed: ${res.status} ${err}`);
          }
          const { id } = (await res.json()) as { id: string };
          const updated = { ...seedRun, id };
          setActive(updated);
          attachServerRunStream(id, eventsArr, updated, status => {
            if (status === 'paused' || status === 'interrupted') {
              setActive(curr =>
                curr
                  ? { ...curr, status, eventVersion: curr.eventVersion + 1 }
                  : curr,
              );
              return;
            }
            setActive(null);
            setHistory(prev =>
              [
                {
                  ...updated,
                  endedAt: Date.now(),
                  status,
                  eventVersion: eventsArr.length,
                },
                ...prev,
              ].slice(0, 100),
            );
          });
        } catch (err) {
          setLastError((err as Error).message);
          setActive(null);
        }
      })();
      return true;
    },
    [attachServerRunStream],
  );

  const resumeServerRun = useCallback(() => {
    const id = serverRunIdRef.current;
    if (!id) {
      setLastError('No active server-owned run to resume.');
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(id)}/resume`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const err = await res.text().catch(() => '');
          throw new Error(`POST resume failed: ${res.status} ${err}`);
        }
        // The SSE stream replays history first; bump active back to
        // 'running' to flip the UI immediately.
        setActive(curr =>
          curr
            ? { ...curr, status: 'running', eventVersion: curr.eventVersion + 1 }
            : curr,
        );
        // Reattach. The server will replay full history first via the
        // subscribe() history path, then live-tail new events.
        const curr = activeRef.current;
        if (!curr) return;
        attachServerRunStream(id, curr.events, curr, status => {
          if (status === 'paused' || status === 'interrupted') {
            setActive(c =>
              c ? { ...c, status, eventVersion: c.eventVersion + 1 } : c,
            );
            return;
          }
          setActive(null);
          setHistory(prev =>
            [
              {
                ...curr,
                endedAt: Date.now(),
                status,
                eventVersion: curr.events.length,
              },
              ...prev,
            ].slice(0, 100),
          );
        });
      } catch (err) {
        setLastError((err as Error).message);
      }
    })();
  }, [attachServerRunStream]);

  const gateServerRun = useCallback(
    (decision: 'approve' | 'reject' | 'request-changes', message?: string) => {
      const id = serverRunIdRef.current;
      if (!id) {
        setLastError('No active server-owned run at a gate.');
        return;
      }
      (async () => {
        try {
          const res = await fetch(
            `/api/runs/${encodeURIComponent(id)}/gate`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ decision, message }),
            },
          );
          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`POST gate failed: ${res.status} ${err}`);
          }
          if (decision === 'reject') {
            // The server wrote a run-cancelled sentinel + flipped status.
            // Move the run out of the active slot into history.
            const curr = activeRef.current;
            if (curr) {
              setActive(null);
              setHistory(prev =>
                [
                  {
                    ...curr,
                    endedAt: Date.now(),
                    status: 'cancelled' as RunStatus,
                    eventVersion: curr.events.length,
                  },
                  ...prev,
                ].slice(0, 100),
              );
            }
            return;
          }
          // approve / request-changes → the run resumed server-side (a
          // revision re-pauses at the same gate). Flip UI to running and
          // re-attach the SSE stream (replays full history, then live-tails)
          // — identical to resumeServerRun's reattach path.
          setActive(curr =>
            curr
              ? { ...curr, status: 'running', eventVersion: curr.eventVersion + 1 }
              : curr,
          );
          const curr = activeRef.current;
          if (!curr) return;
          attachServerRunStream(id, curr.events, curr, status => {
            if (status === 'paused' || status === 'interrupted') {
              setActive(c =>
                c ? { ...c, status, eventVersion: c.eventVersion + 1 } : c,
              );
              return;
            }
            setActive(null);
            setHistory(prev =>
              [
                {
                  ...curr,
                  endedAt: Date.now(),
                  status,
                  eventVersion: curr.events.length,
                },
                ...prev,
              ].slice(0, 100),
            );
          });
        } catch (err) {
          setLastError((err as Error).message);
        }
      })();
    },
    [attachServerRunStream],
  );

  const resumeServerRunById = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}/resume`, {
          method: 'POST',
        });
        if (!res.ok) {
          const err = await res.text().catch(() => '');
          throw new Error(`POST resume failed: ${res.status} ${err}`);
        }
        // Pull the full run so the active slot is seeded with real history
        // (a compact history entry only keeps the last couple events); the
        // SSE stream replays the full log on top regardless.
        const full = await getRun<Run>(id).catch(() => null);
        const base = full ?? historyRef.current.find(r => r.id === id) ?? null;
        if (!base) {
          setLastError(`Resumed run ${id} not found locally.`);
          return;
        }
        const eventsArr: RunEvent[] = [...(base.events ?? [])];
        const seed: Run = {
          ...base,
          events: eventsArr,
          status: 'running',
          endedAt: undefined,
          eventVersion: eventsArr.length,
        };
        // Promote into the live slot and drop the (now-stale) history copy.
        setHistory(prev => prev.filter(r => r.id !== id));
        setActive(seed);
        attachServerRunStream(id, eventsArr, seed, status => {
          if (status === 'paused' || status === 'interrupted') {
            setActive(c =>
              c ? { ...c, status, eventVersion: c.eventVersion + 1 } : c,
            );
            return;
          }
          setActive(null);
          setHistory(prev =>
            [
              {
                ...seed,
                endedAt: Date.now(),
                status,
                eventVersion: eventsArr.length,
              },
              ...prev,
            ].slice(0, 100),
          );
        });
      } catch (err) {
        setLastError((err as Error).message);
      }
    },
    [attachServerRunStream],
  );

  const cancelRun = useCallback(() => {
    // Server-owned run: tell the server to abort. The SSE handler will
    // see a run-cancelled sentinel and clean up. Don't touch
    // cancelFlag (that's for client-side runs).
    if (serverRunIdRef.current) {
      const id = serverRunIdRef.current;
      // Flip the Stop button to "cancelling…" now — the run keeps
      // streaming until the server reaps the subprocess (~seconds);
      // fireTerminalOnce clears this when it lands terminal.
      markCancelling(id);
      fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
      }).catch(err => {
        console.warn('[runs] cancel POST failed:', err);
        // Cancel never reached the server — don't leave a stuck badge.
        clearCancelling(id);
      });
      return;
    }
    // Client-side run: flag it and reflect cancelling on the active run so
    // the button gives instant feedback until the executor loop finalizes.
    const activeId = activeRef.current?.id;
    if (activeId) markCancelling(activeId);
    cancelFlag.current.v = true;
    // Also reject any pending + queued approvals so all blocked branches unblock.
    setPendingApproval(curr => {
      if (curr) curr.resolve(false);
      for (const a of approvalQueue.current) a.resolve(false);
      approvalQueue.current = [];
      return null;
    });
  }, [markCancelling, clearCancelling]);

  const cancelRunById = useCallback(
    async (id: string) => {
      // If this id IS the live streaming run, the SSE handler already does
      // the right cleanup via cancelRun(); but POSTing cancel directly is
      // safe either way and also covers history/interrupted runs that have
      // no client stream attached.
      // Flip the Stop button to "stopping…" immediately.
      markCancelling(id);
      try {
        await fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        });
      } catch (err) {
        console.warn(`[runs] cancel-by-id POST failed for ${id}:`, err);
        // Cancel never reached the server — don't leave a stuck badge.
        clearCancelling(id);
      }
      // Optimistically reflect cancellation in local history so the Stop
      // button gives immediate feedback. Terminal runs are left untouched.
      setHistory(prev =>
        prev.map(r =>
          r.id === id &&
          (r.status === 'running' ||
            r.status === 'paused' ||
            r.status === 'interrupted')
            ? { ...r, status: 'cancelled', endedAt: r.endedAt ?? Date.now() }
            : r,
        ),
      );
      // The row is now terminal locally — drop the in-flight signal.
      clearCancelling(id);
    },
    [markCancelling, clearCancelling],
  );

  const pauseRun = useCallback(() => {
    pauseFlag.current.v = true;
    // setPaused fires when the executor actually yields phase-paused;
    // we don't pre-emptively flip the UI state because the agent may
    // still produce a few events before reaching the exchange boundary.
  }, []);

  const resumeRun = useCallback(() => {
    pauseFlag.current.v = false;
    // Same: executor's phase-resumed event drives the UI flip.
  }, []);

  const sendChat = useCallback((phaseName: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    chatQueueRef.current.enqueue(phaseName, trimmed);
    // If currently paused, sending chat implicitly resumes the agent;
    // the executor's pause-wait loop breaks on either resume flag OR
    // a new chat message in the queue.
  }, []);

  // Notifications feed: recent terminal/interrupted outcomes, newest
  // first. Derived from `history` so it also reflects runs that finished
  // server-side while this tab was closed.
  const notifications = useMemo(
    () =>
      history
        .filter(
          r =>
            r.status === 'done' ||
            r.status === 'error' ||
            r.status === 'interrupted' ||
            r.status === 'cancelled',
        )
        .slice()
        .sort(
          (a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt),
        ),
    [history],
  );
  // Badge count: error/interrupted runs that finished since last seen
  // and haven't been individually acknowledged.
  const attentionCount = useMemo(() => {
    const acked = new Set(ackedIds);
    return history.filter(
      r =>
        (r.status === 'error' || r.status === 'interrupted') &&
        (r.endedAt ?? r.startedAt) > notifSeenAt &&
        !acked.has(r.id),
    ).length;
  }, [history, notifSeenAt, ackedIds]);

  const value = useMemo<Ctx>(
    () => ({
      active,
      history,
      hydrateRun,
      deleteHistoryRuns,
      startRun,
      startServerRun,
      resumeServerRun,
      gateServerRun,
      resumeServerRunById,
      forkServerRun,
      cancelRun,
      cancelRunById,
      cancelling,
      isCancelling: (id: string) => cancelling.has(id),
      notifications,
      attentionCount,
      notifSeenAt,
      markNotificationsSeen,
      ackedIds,
      acknowledgeNotifications,
      paused,
      pauseRun,
      resumeRun,
      sendChat,
      pendingApproval,
      approve,
      reject,
      lastError,
    }),
    [
      active,
      history,
      hydrateRun,
      deleteHistoryRuns,
      startRun,
      startServerRun,
      resumeServerRun,
      gateServerRun,
      resumeServerRunById,
      forkServerRun,
      cancelRun,
      cancelRunById,
      cancelling,
      notifications,
      attentionCount,
      notifSeenAt,
      markNotificationsSeen,
      ackedIds,
      acknowledgeNotifications,
      paused,
      pauseRun,
      resumeRun,
      sendChat,
      pendingApproval,
      approve,
      reject,
      lastError,
    ],
  );

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>;
}

export function useRuns(): Ctx {
  const ctx = useContext(RunsContext);
  if (!ctx) throw new Error('useRuns must be used within RunsProvider');
  return ctx;
}

/** Live per-node run status for a single orchestration, for the editor views
 *  (Pipeline / Graph / Tree) and the sidebar to highlight progress as a run
 *  streams. Returns the derived status map plus `isLive` (true while the run
 *  is actively running/paused — gates the pulse/flow animations).
 *
 *  Persist-after-end: once a run finishes, `active` flips to null but we keep
 *  showing the last derived snapshot (non-live) until the caller switches to a
 *  different orchestration or starts a new run — so the final colors linger
 *  instead of vanishing the instant the run ends. */
export function useLiveRunStatus(orchestration: Node | null): {
  info: RunStatusInfo;
  isLive: boolean;
} {
  const { active, history } = useRuns();
  const name = orchestration?.name ?? null;
  const isRunningStatus = (s: string) => s === 'running' || s === 'paused';

  // Prefer the in-session active run; otherwise pick up a RUNNING run for this
  // orchestration from the polled store — a CLI-mirrored run, a trigger run, or
  // one started in another tab — so the canvas animates for ANY live run, not
  // only ones launched here. (Running runs keep full events in `history` via
  // liveOrCompact, so per-node status can be derived.)
  const liveRun =
    name && active && active.orchestrationName === name && isRunningStatus(active.status)
      ? active
      : name
        ? (history.find(
            r => r.orchestrationName === name && isRunningStatus(r.status),
          ) ?? null)
        : null;
  const isLive = !!liveRun;

  // Last derived snapshot, keyed by orchestration name — survives the run
  // ending so the final colors persist.
  const cacheRef = useRef<{ name: string | null; info: RunStatusInfo }>({
    name: null,
    info: emptyRunStatus(),
  });

  const allNames = useMemo(
    () => (orchestration ? collectNodeNames(orchestration) : []),
    [orchestration],
  );

  return useMemo(() => {
    const name = orchestration?.name ?? null;
    // Switched orchestration → discard the previous one's snapshot.
    if (cacheRef.current.name !== name) {
      cacheRef.current = { name, info: emptyRunStatus() };
    }
    if (liveRun) {
      // Depend on eventVersion (not events — mutated in place) for re-derive.
      const info = deriveRunStatus(liveRun.events, allNames);
      cacheRef.current = { name, info };
      return { info, isLive };
    }
    return { info: cacheRef.current.info, isLive: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestration?.name, liveRun, liveRun?.eventVersion, isLive, allNames]);
}

export function totalUsage(run: Run): {
  input: number;
  output: number;
  /** USD; sums per-phase costUsd — the completed phases AND the failed
   *  attempts, the same two events the server's `sumCostUsd` and the
   *  budget caps charge, so the figure on the run card agrees with the
   *  402 for a run with retries. 0 if no models with known pricing were
   *  used. */
  costUsd: number;
  /** Sum of per-phase durationMs; rough since parallel branches overlap. */
  durationMs: number;
} {
  // "Which events count" belongs in ONE place (`lib/spend`), not in a
  // per-reader copy: six hand-rolled folds over the same stream is how four
  // of them moved onto phase-end + phase-error and two were left behind.
  // Latency is not spend and stays phase-end-only — a failed attempt's wall
  // time is not a phase's duration.
  const spend = emptySpend();
  let durationMs = 0;
  for (const e of run.events) {
    addSpend(spend, e);
    if (e.type === 'phase-end') durationMs += e.durationMs ?? 0;
  }
  return {
    input: spend.inputTokens,
    output: spend.outputTokens,
    costUsd: spend.costUsd,
    durationMs,
  };
}
