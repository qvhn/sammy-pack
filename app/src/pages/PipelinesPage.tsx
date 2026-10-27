import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  deleteOrchestration,
  listAgents,
  listOrchestrations,
  previewOrchestration,
  renameOrchestration,
  saveAgent,
  saveOrchestration,
  type PreviewResult,
} from '../api';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import { getApiKey, getAuthMode, getModel } from '../store/apiKey';
// Lazy-loaded: the Graph editor pulls in @xyflow/react (the largest single
// dependency). Code-splitting it keeps the initial bundle small — it's only
// fetched when the user opens Graph view.
const GraphEditor = lazy(() =>
  import('../GraphEditor').then(m => ({ default: m.GraphEditor })),
);
import { OrchestrationJsonPanel } from '../OrchestrationJsonPanel';
import { OrchestrationTree } from '../OrchestrationTree';
import { RunDock } from '../RunDock';
import { PipelineEditor } from '../PipelineEditor';
import { TriggersHead } from '../TriggersHead';
import { InputsHead } from '../InputsHead';
import { RunInputsModal } from '../RunInputsModal';
import { VersionHistoryPanel } from '../VersionHistoryPanel';
import {
  budgetBannerText,
  getBudgetStatus,
  type BudgetStatus,
} from '../store/budget';
import { useLiveRunStatus, useRuns } from '../store/runs';
import {
  buildSelectedInstruction,
  onOpenImprove,
  parseCritiqueItems,
  useImproveJob,
  useImproveJobs,
  type ImproveItem,
  type ImproveJob,
} from '../store/improveJobs';
import { useSpin, usePulse } from '../lib/usePulse';
import { Tooltip } from '../lib/Tooltip';
import {
  complexityDescription,
  complexityLabel,
  computeComplexity,
  TIER_COLOR,
  type Complexity,
} from '../lib/complexity';
import type { PageId } from '../Sidebar';
import {
  currentRoute,
  onRouteChange,
  rememberPipeline,
  rememberedPipeline,
  replaceRoute,
} from '../lib/hashRoute';
import { TEMPLATES, type Template } from '../templates';
import { compositeKey, type Node } from '../types';
import {
  detectSubflowCycles,
  validateAgentExistence,
  validateCredentialExistence,
  validateOrchestration,
  type ValidationError,
} from '../validate';
import { getCredentials } from '../store/credentials';
import {
  getPipelineFilter,
  isDefaultPipeline,
  setPipelineFilter,
  type PipelineFilter,
} from '../defaultPipelines';

type ViewMode = 'pipeline' | 'graph' | 'tree';
type Status = 'idle' | 'loading' | 'saving' | 'error';

/** A spinning ⟳ + status word shown next to the orchestration that's
 *  currently running in the sidebar list — so a run is visible from the
 *  home list, not just inside the open editor. */
function SidebarRunningBadge({ paused }: { paused: boolean }) {
  const rotate = useSpin(!paused);
  return (
    <View style={styles.runningBadge}>
      <Animated.Text
        style={[styles.runningSpinner, { transform: [{ rotate }] }]}>
        ⟳
      </Animated.Text>
      <Text style={styles.runningBadgeText}>{paused ? 'paused' : 'running'}</Text>
    </View>
  );
}

/**
 * Count the by-name references to OTHER orchestrations anywhere in a node tree
 * — i.e. how many sub-orchestrations this one nests. Two reference kinds count:
 *   - `subflow`                  — invoke another orchestration as a sub-step
 *     (the same edge detectSubflowCycles guards), and
 *   - `lifecycle.errorOrchestration` — run another orchestration if this one
 *     fails (a chained handler, but still a reference to a separate flow).
 * A non-zero count means this orchestration is a "parent" in the nesting graph.
 *
 * Crucially this counts references, not copies: an orchestration that inlines
 * (copies in) another's phases has no such field and so is NOT counted, while
 * one that references it does — matching the intent that a parent points at a
 * child rather than duplicating it.
 *
 * Walks every composite body kind (phases / parallel / converge / loop / map /
 * route / onError); conversation / a2a / code reference agents or remote
 * endpoints rather than orchestrations, so they carry no nesting edge.
 */
function countNestedOrchestrations(node: Node): number {
  let n = 0;
  function visit(x: Node) {
    if (x.subflow) n++;
    if (x.lifecycle?.errorOrchestration) n++;
    for (const arr of [x.phases, x.parallel, x.converge] as (Node[] | undefined)[]) {
      if (Array.isArray(arr)) for (const c of arr) visit(c);
    }
    if (x.loop?.body) visit(x.loop.body);
    if (x.map?.body) visit(x.map.body);
    if (x.route?.branches) {
      for (const b of Object.values(x.route.branches)) if (b) visit(b);
      if (x.route.default) visit(x.route.default);
    }
    if (x.onError) visit(x.onError);
  }
  visit(node);
  return n;
}

/** How many triggers an orchestration declares — i.e. how it's invoked beyond
 *  the manual Run button (webhook / cron / events / deployment / polling /
 *  queue). Triggers are top-level only, so this is just the root's trigger
 *  count. A non-zero count means this orchestration is "reactive" — it reacts to
 *  an external signal rather than only running on demand. Drives the "⚡ Triggers"
 *  filter pill and the per-row ⚡ badge. */
function countTriggers(node: Node): number {
  return Array.isArray(node.triggers) ? node.triggers.length : 0;
}

/** A pipeline's latest-run status, bucketed for the list dot + status filter.
 *  running → in-progress; paused → awaiting human approval (HITL); done →
 *  success; error/interrupted → failed; everything else → other. `paused` is
 *  split out from `running` so a run blocked on a human is visibly distinct. */
type PipelineStatusCat = 'running' | 'paused' | 'success' | 'failed' | 'other';
function statusCategory(s: string | undefined): PipelineStatusCat {
  if (s === 'paused') return 'paused';
  if (s === 'running') return 'running';
  if (s === 'done') return 'success';
  if (s === 'error' || s === 'interrupted') return 'failed';
  return 'other';
}

/** A small status light on a pipeline row — green pulsing while running, AMBER
 *  pulsing while paused awaiting approval (HITL needed), solid green on
 *  success, red on failure. */
function PipelineStatusDot({ category }: { category: PipelineStatusCat }) {
  const pulse = usePulse(category === 'running' || category === 'paused');
  const color =
    category === 'running'
      ? '#10b981'
      : category === 'paused'
        ? '#f59e0b'
        : category === 'success'
          ? '#059669'
          : category === 'failed'
            ? '#dc2626'
            : '#d1d5db';
  return (
    <Animated.View
      style={[styles.pipelineStatusDot, { backgroundColor: color, opacity: pulse }]}
    />
  );
}

/** A complexity badge — the orchestration's tier + score, colored by tier.
 *  `compact` (the sidebar-row form) shows just the tier glyph + score; the
 *  full form (detail line) shows "tier · score". The metric is structural and
 *  domain-agnostic — see lib/complexity.ts. */
function ComplexityBadge({
  complexity,
  compact = false,
  active = false,
}: {
  complexity: Complexity;
  compact?: boolean;
  active?: boolean;
}) {
  const color = TIER_COLOR[complexity.tier];
  const description = complexityDescription(complexity);
  return (
    // Tooltip (web) shows `description` on hover; on native it's a passthrough
    // and the View's accessibilityLabel carries the same text for a11y.
    <Tooltip text={description} style={styles.complexityBadgeWrap}>
      <View
        style={[
          styles.complexityBadge,
          { borderColor: color },
          active && styles.complexityBadgeActive,
        ]}
        accessibilityLabel={description}>
        <Text style={[styles.complexityBadgeText, { color }]} numberOfLines={1}>
          {compact ? `◆ ${complexity.score}` : complexityLabel(complexity)}
        </Text>
      </View>
    </Tooltip>
  );
}

export function PipelinesPage({
  onNavigate,
}: {
  onNavigate?: (page: PageId) => void;
}) {
  const [docs, setDocs] = useState<Node[]>([]);
  // The selected pipeline round-trips through the URL hash
  // (`#/pipelines/<name>`): a reload or a deep link opens it, and leaving
  // Pipelines then coming back restores it (see lib/hashRoute.ts).
  const [activeName, setActiveName] = useState<string | null>(
    () => currentRoute().pipeline ?? rememberedPipeline(),
  );
  const [mode, setMode] = useState<ViewMode>('pipeline');
  // C.1 — vertical sidebar list w/ search. With ~5 pipelines the
  // horizontal pill strip was already cramped; sammy-pack is
  // designed to host dozens. Filter is case-insensitive substring
  // over the name; future: also match against composite types or
  // agent paths.
  const [pipelineSearch, setPipelineSearch] = useState('');
  // Which slice of the sidebar list to show — all / mine / defaults-only
  // (see defaultPipelines.ts). Persisted across reloads.
  const [pipelineFilter, setPipelineFilterState] =
    useState<PipelineFilter>(getPipelineFilter);
  // Independent toggle: show only orchestrations that nest a sub-orchestration
  // via `subflow` (the "parents"). Composes (ANDs) with the all/mine/defaults
  // slice above. Intentionally NOT persisted — it's a transient drill-in, not a
  // sticky default, so a reload always starts from the full list.
  const [nestedOnly, setNestedOnly] = useState(false);
  // Independent toggle: show only orchestrations that declare a trigger (the
  // "reactive" ones — webhook/cron/events/deployment/polling/queue). Composes
  // (ANDs) with the slice + nested + status filters. Transient, not persisted —
  // same rationale as nestedOnly.
  const [triggersOnly, setTriggersOnly] = useState(false);
  // Single-select tag filter — show only pipelines whose lifecycle.tags
  // include the selected tag. Tap the active tag again to clear. Composes
  // (ANDs) with the other filters. Transient, not persisted — like
  // nestedOnly.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // The tag chip cloud is tall (one chip per distinct tag), so it renders
  // behind a collapsed toggle by default — expanding it is a deliberate
  // act, and picking a tag re-collapses it to give the list its space back.
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  // Filter the list by each pipeline's latest-run status (all / running /
  // success / failed). Pairs with the per-row status dot. Transient, not
  // persisted — like nestedOnly.
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'running' | 'paused' | 'success' | 'failed'
  >('all');
  // JSON side-panel toggle. Lives on Pipeline + Tree views so they
  // have a complete edit path even before they catch up to Graph's
  // visual-editing parity. Graph already exposes everything visually,
  // so we hide the toggle there to keep the canvas full-width.
  const [showJson, setShowJson] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateFromFileOpen, setGenerateFromFileOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [improveOpen, setImproveOpen] = useState(false);
  const [missingAgentToFix, setMissingAgentToFix] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // Orchestration awaiting its declared run inputs before launch (null = none).
  const [pendingRun, setPendingRun] = useState<Node | null>(null);
  const [runStartFailed, setRunStartFailed] = useState(false);
  const [inputsConfigOpen, setInputsConfigOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Overflow menu for the toolbar — collapses History / Explain /
  // Improve / Duplicate / JSON / Delete into a ⋮ popover so the
  // inline row stays at the 4 high-frequency actions (Rename,
  // Undo, Redo, Run) instead of 10 flat pills.
  const [overflowOpen, setOverflowOpen] = useState(false);
  // "+ New" popover in the sidebar — collapses the 4 creation actions
  // (blank / paste JSON / generate from spec / drop diagram) behind one button.
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  // UI density toggles — persisted so the choice sticks across reloads.
  // descExpanded: the (often long) orchestration description can collapse to
  // reclaim vertical space. sidebarCollapsed: the left pipelines list can
  // minimize to a thin rail so the canvas gets the full width.
  const [descExpanded, setDescExpanded] = useState(() => {
    try {
      return typeof localStorage === 'undefined'
        ? true
        : localStorage.getItem('sammy.pipelines.descCollapsed') !== '1';
    } catch {
      return true;
    }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return typeof localStorage === 'undefined'
        ? false
        : localStorage.getItem('sammy.pipelines.sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  // Draggable sidebar width — pipeline names are long, so let the list be
  // pulled wider (clamped 200–560px) via the divider handle. Persisted.
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 560;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const v =
        typeof localStorage === 'undefined'
          ? null
          : localStorage.getItem('sammy.pipelines.sidebarWidth');
      const n = v ? parseInt(v, 10) : NaN;
      return Number.isFinite(n)
        ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n))
        : 240;
    } catch {
      return 240;
    }
  });
  const persistSidebarWidth = (w: number) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sammy.pipelines.sidebarWidth', String(Math.round(w)));
      }
    } catch {
      /* ignore */
    }
  };
  // Resize via WINDOW-level mouse listeners (not the RN responder system,
  // which drops the drag the moment the pointer crosses another element and
  // lets the browser text-select). On mousedown we capture the origin, then
  // track on window until mouseup — disabling text selection for the drag.
  const startSidebarResize = (clientX: number) => {
    if (typeof window === 'undefined') return;
    const startX = clientX;
    const startW = sidebarWidth;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)),
      );
      setSidebarWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (typeof document !== 'undefined') {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
      persistSidebarWidth(latest);
    };
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const toggleDesc = () =>
    setDescExpanded(v => {
      const next = !v;
      try {
        if (typeof localStorage !== 'undefined') {
          if (next) localStorage.removeItem('sammy.pipelines.descCollapsed');
          else localStorage.setItem('sammy.pipelines.descCollapsed', '1');
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  const toggleSidebar = () =>
    setSidebarCollapsed(v => {
      const next = !v;
      try {
        if (typeof localStorage !== 'undefined') {
          if (next) localStorage.setItem('sammy.pipelines.sidebarCollapsed', '1');
          else localStorage.removeItem('sammy.pipelines.sidebarCollapsed');
        }
      } catch {
        /* ignore */
      }
      return next;
    });
  // Page-level selection state — lifted from GraphEditor so each
  // view can highlight the matching node and selection persists
  // across Pipeline → Graph → Tree round-trips. Cleared when the
  // active orchestration changes (see effect below).
  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runs = useRuns();
  const improveJobs = useImproveJobs();

  // A completed-improvement toast (fired from the store) dispatches a global
  // event asking us to open the Improve modal for a named orchestration. Make
  // that orchestration active, then open the modal as a VIEWER of its job.
  useEffect(
    () =>
      onOpenImprove(name => {
        setActiveName(name);
        setImproveOpen(true);
      }),
    [],
  );

  // Re-fetch the server-computed budget status after every run
  // completes so the banner stays in sync. The status is derived from
  // the durable run store, so it reflects exactly what the server-side
  // run gate sees.
  useEffect(() => {
    if (runs.active) return;
    let cancelled = false;
    getBudgetStatus()
      .then(s => {
        if (cancelled) return;
        setBudget(s);
      })
      .catch(() => {
        // Non-fatal: the budget UI hides itself if the fetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, [runs.active]);

  // Per-orchestration undo / redo stacks. Captured BEFORE each mutation.
  // Capped at 50 entries to keep memory bounded.
  const undoMap = useRef<Map<string, Node[]>>(new Map());
  const redoMap = useRef<Map<string, Node[]>>(new Map());
  const [undoTick, setUndoTick] = useState(0);

  function pushUndo(name: string, prev: Node) {
    const stack = undoMap.current.get(name) ?? [];
    stack.push(prev);
    while (stack.length > 50) stack.shift();
    undoMap.current.set(name, stack);
    // Any new edit clears the redo stack for this orchestration.
    redoMap.current.delete(name);
    setUndoTick(t => t + 1);
  }

  // Load orchestrations from API on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listOrchestrations();
        if (cancelled) return;
        setDocs(list);
        // Keep the routed/remembered selection only if it still exists.
        setActiveName(prev =>
          prev && list.some(d => d.name === prev) ? prev : list[0]?.name ?? null,
        );
        setStatus('idle');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorMsg((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the selection into the hash (no history entry — picking a
  // pipeline isn't a Back step) and follow hand-edited / linked hashes.
  useEffect(() => {
    rememberPipeline(activeName);
    if (activeName) replaceRoute({ page: 'pipelines', pipeline: activeName });
  }, [activeName]);
  useEffect(
    () =>
      onRouteChange(route => {
        if (route.page === 'pipelines' && route.pipeline) {
          setActiveName(route.pipeline);
        }
      }),
    [],
  );

  useEffect(() => {
    setDeleteConfirm(false);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    // Reset selection too — a node name from the previous
    // orchestration doesn't make sense in the new one, and rendering
    // a stale highlight would suggest a node exists that doesn't.
    setSelectedNodeName(null);
  }, [activeName]);

  const active = activeName ? docs.find(d => d.name === activeName) ?? null : null;

  // Live per-node run status for the active orchestration — shared by all
  // three views so a run can be followed visually (highlight + animation),
  // not just in the chat console. Persists final colors after the run ends.
  const live = useLiveRunStatus(active);

  // Escape closes the open toolbar / sidebar popovers (the ⋮ overflow and the
  // "+ New" menu), matching the click-outside dismiss with a keyboard path.
  useEffect(() => {
    if (!overflowOpen && !newMenuOpen) return;
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOverflowOpen(false);
        setNewMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overflowOpen, newMenuOpen]);

  // How many of the loaded pipelines are shipped defaults — drives the
  // All / Mine / Defaults filter's visibility (only worth showing when
  // there's a mix of defaults and user-authored pipelines).
  const defaultCount = useMemo(
    () => docs.reduce((n, d) => n + (isDefaultPipeline(d.name) ? 1 : 0), 0),
    [docs],
  );

  // name → how many sub-orchestrations it nests (only the parents are kept).
  // Drives both the "has subflows" filter pill and the per-row 🔗 badge.
  // Computed once per docs change; the trees are tiny so this is cheap.
  const nestedCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of docs) {
      const c = countNestedOrchestrations(d);
      if (c > 0) m.set(d.name, c);
    }
    return m;
  }, [docs]);

  // Total nested sub-orchestrations across the workspace (the SUM of every
  // parent's count) — what the "Nested N" pill shows. Distinct from
  // nestedCounts.size, which is the number of parent pipelines.
  const totalNestedCount = useMemo(() => {
    let s = 0;
    for (const v of nestedCounts.values()) s += v;
    return s;
  }, [nestedCounts]);

  // name → how many triggers it declares (only the reactive ones are kept).
  // Drives the "⚡ Triggers" filter pill and the per-row ⚡ badge.
  const triggerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of docs) {
      const c = countTriggers(d);
      if (c > 0) m.set(d.name, c);
    }
    return m;
  }, [docs]);

  // Total triggers across the workspace (SUM of every reactive orchestration's
  // count) — the number on the "⚡ Triggers N" pill is the count of reactive
  // orchestrations (triggerCounts.size); this sum backs the a11y label.
  const totalTriggerCount = useMemo(() => {
    let s = 0;
    for (const v of triggerCounts.values()) s += v;
    return s;
  }, [triggerCounts]);

  // tag → how many pipelines carry it (from lifecycle.tags). Drives the tag
  // filter chips; sorted by count so the busiest tags lead. Cheap — tags are
  // tiny arrays.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of docs) {
      for (const t of d.lifecycle?.tags ?? []) {
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return m;
  }, [docs]);

  // name → structural complexity (tier + score + signals). Drives the per-row
  // ◆ badge in the sidebar list and the detail-line badge. Cheap — the trees
  // are tiny and this only recomputes when the docs change. Generic metric;
  // see lib/complexity.ts.
  const complexityByOrch = useMemo(() => {
    const m = new Map<string, Complexity>();
    for (const d of docs) m.set(d.name, computeComplexity(d));
    return m;
  }, [docs]);

  // name → latest run's status category, from the run store (active +
  // history). The newest run by startedAt wins, so a live run shows as
  // running even if older runs succeeded/failed. Drives the per-row dot and
  // the status filter; updates live as runs.history polls (see store).
  const runStatusByOrch = useMemo(() => {
    const cat = new Map<string, PipelineStatusCat>();
    const at = new Map<string, number>();
    const consider = (r: {
      orchestrationName?: string;
      status?: string;
      startedAt?: number;
    }) => {
      const name = r.orchestrationName;
      if (!name) return;
      const ts = r.startedAt ?? 0;
      if (at.has(name) && ts < (at.get(name) as number)) return;
      at.set(name, ts);
      cat.set(name, statusCategory(r.status));
    };
    for (const r of runs.history) consider(r);
    if (runs.active) consider(runs.active);
    return cat;
  }, [runs.history, runs.active]);

  const filteredDocs = useMemo(() => {
    const q = pipelineSearch.trim().toLowerCase();
    let out = docs;
    if (pipelineFilter === 'mine') out = out.filter(d => !isDefaultPipeline(d.name));
    else if (pipelineFilter === 'defaults')
      out = out.filter(d => isDefaultPipeline(d.name));
    if (nestedOnly) out = out.filter(d => nestedCounts.has(d.name));
    if (triggersOnly) out = out.filter(d => triggerCounts.has(d.name));
    if (tagFilter)
      out = out.filter(d => (d.lifecycle?.tags ?? []).includes(tagFilter));
    if (statusFilter !== 'all')
      out = out.filter(d => runStatusByOrch.get(d.name) === statusFilter);
    if (q)
      out = out.filter(
        d =>
          d.name.toLowerCase().includes(q) ||
          (d.lifecycle?.tags ?? []).some(t => t.toLowerCase().includes(q)),
      );
    return out;
  }, [
    docs,
    pipelineSearch,
    pipelineFilter,
    nestedOnly,
    nestedCounts,
    triggersOnly,
    triggerCounts,
    tagFilter,
    statusFilter,
    runStatusByOrch,
  ]);

  function changeFilter(next: PipelineFilter) {
    setPipelineFilterState(next);
    setPipelineFilter(next);
  }

  async function persist(next: Node) {
    setStatus('saving');
    try {
      const saved = await saveOrchestration(next);
      setStatus('idle');
      return saved;
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
      throw err;
    }
  }

  async function handleChange(next: Node) {
    if (!activeName) return;
    const prev = docs.find(d => d.name === activeName);
    if (prev) pushUndo(activeName, prev);
    setDocs(prev => prev.map(d => (d.name === activeName ? next : d)));
    if (next.name !== activeName) setActiveName(next.name);
    try {
      await persist(next);
    } catch {
      /* state already updated; error surfaced via status */
    }
  }

  async function performUndo() {
    if (!activeName) return;
    const stack = undoMap.current.get(activeName);
    if (!stack || stack.length === 0) return;
    const current = docs.find(d => d.name === activeName);
    const prev = stack.pop()!;
    undoMap.current.set(activeName, stack);
    // Push current onto redo so redo can restore.
    if (current) {
      const rstack = redoMap.current.get(activeName) ?? [];
      rstack.push(current);
      redoMap.current.set(activeName, rstack);
    }
    setUndoTick(t => t + 1);
    setDocs(curr => curr.map(d => (d.name === activeName ? prev : d)));
    try {
      await persist(prev);
    } catch {
      /* */
    }
  }

  async function performRedo() {
    if (!activeName) return;
    const stack = redoMap.current.get(activeName);
    if (!stack || stack.length === 0) return;
    const current = docs.find(d => d.name === activeName);
    const next = stack.pop()!;
    redoMap.current.set(activeName, stack);
    if (current) {
      const ustack = undoMap.current.get(activeName) ?? [];
      ustack.push(current);
      undoMap.current.set(activeName, ustack);
    }
    setUndoTick(t => t + 1);
    setDocs(curr => curr.map(d => (d.name === activeName ? next : d)));
    try {
      await persist(next);
    } catch {
      /* */
    }
  }

  // Cmd+Z / Cmd+Shift+Z (undo / redo) + Cmd+Enter (run active orch).
  // Listener is page-scoped: only attached while PipelinesPage is
  // mounted, so the Runs page etc. don't accidentally trigger Run.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) performRedo();
        else performUndo();
        return;
      }
      if (e.key === 'Enter' && active && !runs.active && !budget?.blocked) {
        e.preventDefault();
        // Orchestrations that declare `inputs` collect them in a form first.
        if (Array.isArray(active.inputs) && active.inputs.length > 0) {
          setPendingRun(active);
          return;
        }
        // Prefer server-owned runs when proxy auth is configured —
        // they survive tab close + support pause/resume on lock-gated
        // phases. Falls back to the in-browser executor for direct-API
        // users (server can't use a browser-side API key).
        const launcher = getAuthMode() === 'claude-code-proxy'
          ? runs.startServerRun
          : runs.startRun;
        if (launcher(active)) onNavigate?.('runs');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, docs, active, runs.active, budget?.blocked]);

  const undoCount = activeName ? undoMap.current.get(activeName)?.length ?? 0 : 0;
  const redoCount = activeName ? redoMap.current.get(activeName)?.length ?? 0 : 0;
  void undoTick; // referenced just to re-render when undo/redo stacks change

  async function handleCreate(
    name: string,
    description: string,
    template: Template | null,
  ) {
    // Start from the template body if one was chosen; otherwise blank.
    const base: Node = template
      ? structuredClone(template.body)
      : { name, phases: [] };
    base.name = name;
    if (description.trim()) base.description = description.trim();
    else if (!template) delete base.description;
    setDocs(prev => [...prev, base]);
    setActiveName(name);
    setCreateOpen(false);
    try {
      await persist(base);
    } catch {
      /* leave optimistic update */
    }
  }

  async function handleRename(newName: string) {
    if (!active || !activeName) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === activeName) {
      setRenameOpen(false);
      return;
    }
    if (docs.some(d => d.name === trimmed)) {
      // Modal already shows the conflict; just keep it open.
      return;
    }
    const renamed: Node = { ...active, name: trimmed };
    // Optimistic: swap in the renamed doc + flip activeName so the chip
    // strip lights up the new entry while persist runs.
    setDocs(prev => prev.map(d => (d.name === activeName ? renamed : d)));
    const oldName = activeName;
    setActiveName(trimmed);
    setRenameOpen(false);
    try {
      setStatus('saving');
      await renameOrchestration(oldName, renamed);
      setStatus('idle');
    } catch (err) {
      // Roll back the optimistic update.
      setDocs(prev => prev.map(d => (d.name === trimmed ? active : d)));
      setActiveName(oldName);
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
  }

  function exportOrchestrationAsJson(node: Node): void {
  const g = globalThis as unknown as {
    URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
    Blob?: new (parts: string[], opts?: { type: string }) => unknown;
    document?: {
      createElement(t: string): { href: string; download: string; click(): void };
    };
    setTimeout?: (fn: () => void, ms: number) => void;
  };
  if (!g.URL || !g.Blob || !g.document) return;
  const blob = new g.Blob([JSON.stringify(node, null, 2)], { type: 'application/json' });
  const url = g.URL.createObjectURL(blob);
  const a = g.document.createElement('a');
  a.href = url;
  a.download = `${node.name}.json`;
  a.click();
  g.setTimeout?.(() => g.URL!.revokeObjectURL(url), 1000);
}

function summarizeOrchestration(node: Node): string {
  // Walk the tree counting phases (any composite child or leaf), unique
  // agents referenced, and connector tools declared. Cheap; runs only
  // when the active orchestration changes (not per-event).
  let phases = 0;
  const agents = new Set<string>();
  const tools = new Set<string>();
  function visit(n: Node) {
    phases++;
    if (n.agent) agents.add(n.agent);
    for (const a of n.agents ?? []) agents.add(a);
    for (const t of n.tools ?? []) tools.add(t);
    for (const arr of [n.phases, n.parallel, n.converge] as (Node[] | undefined)[]) {
      if (Array.isArray(arr)) for (const c of arr) visit(c);
    }
    if (n.loop?.body) visit(n.loop.body);
    if (n.map?.body) visit(n.map.body);
    if (n.route?.branches) {
      for (const b of Object.values(n.route.branches)) if (b) visit(b);
      if (n.route.default) visit(n.route.default);
    }
  }
  visit(node);
  const parts: string[] = [];
  parts.push(`${phases}p`);
  if (agents.size > 0) parts.push(`${agents.size}a`);
  if (tools.size > 0) parts.push(`${tools.size}t`);
  if (node.subflow) parts.push('subflow');
  return parts.join(' · ');
}

async function handleDuplicate() {
    if (!active) return;
    const g = globalThis as unknown as {
      prompt?: (m: string, d?: string) => string | null;
    };
    const next = g.prompt?.('Name for the duplicate:', `${active.name}-copy`);
    if (!next) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(next)) {
      setErrorMsg('Name must be alphanumeric + dashes/underscores');
      return;
    }
    if (docs.find(d => d.name === next)) {
      setErrorMsg(`Pipeline "${next}" already exists`);
      return;
    }
    const copy: Node = {
      ...JSON.parse(JSON.stringify(active)),
      name: next,
    };
    try {
      const saved = await persist(copy);
      setDocs(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setActiveName(saved.name);
    } catch {
      /* persist surfaced the error already */
    }
  }

  async function handleDelete() {
    if (!activeName) return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setDeleteConfirm(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setDeleteConfirm(false);
    const nameToDelete = activeName;
    setDocs(prev => {
      const idx = prev.findIndex(d => d.name === nameToDelete);
      const next = prev.filter(d => d.name !== nameToDelete);
      const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
      setActiveName(fallback?.name ?? null);
      return next;
    });
    try {
      setStatus('saving');
      await deleteOrchestration(nameToDelete);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
  }

  const availablePhases = useMemo<Node[]>(() => {
    const out: Node[] = [];
    for (const o of docs) for (const p of o.phases ?? []) out.push(p);
    return out;
  }, [docs]);

  const [knownAgentPaths, setKnownAgentPaths] = useState<Set<string>>(new Set());
  const [knownCredentialNames, setKnownCredentialNames] = useState<Set<string>>(
    new Set(),
  );

  // Load the agent list once on mount so the validator can surface
  // "agent file not found" warnings at edit time (instead of waiting for
  // the executor to throw at run time).
  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then(list => {
        if (cancelled) return;
        setKnownAgentPaths(new Set(list.map(a => `agents/${a.name}.md`)));
      })
      .catch(err => {
        // Non-fatal — fall back to schema-only validation.
        console.warn('[pipelines] failed to load agents for validation:', err);
      });
    getCredentials()
      .then(cfg => {
        if (cancelled) return;
        setKnownCredentialNames(new Set(Object.keys(cfg)));
      })
      .catch(err => {
        // Non-fatal — falls back to schema-only validation; credential
        // refs simply won't be cross-checked against the registry.
        console.warn('[pipelines] failed to load credentials for validation:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const validationErrors = useMemo<ValidationError[]>(() => {
    if (!active) return [];
    const schemaErrors = validateOrchestration(active);
    const agentWarnings = knownAgentPaths.size > 0
      ? validateAgentExistence(active, knownAgentPaths)
      : [];
    // Credential-existence is checked even when the registry is empty —
    // a node referencing `credential: "x"` against an empty registry is
    // by definition unresolved, so the warning still applies.
    const credentialWarnings = validateCredentialExistence(
      active,
      knownCredentialNames,
    );
    // Pre-flight subflow-cycle detection: catches A→B→A at edit
    // time so the user sees it before clicking Run (vs the existing
    // runtime check that fails the run mid-flight).
    const orchByName = new Map(docs.map(d => [d.name, d]));
    const cycleErrors = detectSubflowCycles(active, orchByName);
    return [
      ...schemaErrors,
      ...agentWarnings,
      ...credentialWarnings,
      ...cycleErrors,
    ];
  }, [active, knownAgentPaths, knownCredentialNames, docs]);

  // Derived: the set of node names that have at least one hard error
  // (severity === 'error'), and a parallel map keyed by node name to
  // the first error's message (used for the inline tooltip on the
  // badge). Soft warnings don't trigger a card-level badge — they're
  // already visible in the banner and would otherwise generate noise
  // for every credential-missing / agent-not-found node.
  //
  // Surfaces this to all three views (Pipeline / Graph / Tree) so the
  // validation banner stops being the only locator for problems —
  // each offending phase card gets a red border + ⚠ marker too.
  const errorNodeNames = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const e of validationErrors) {
      if (e.severity !== 'error') continue;
      if (e.nodeName) out.add(e.nodeName);
    }
    return out;
  }, [validationErrors]);
  const errorMessageByNode = useMemo<Map<string, string>>(() => {
    const out = new Map<string, string>();
    for (const e of validationErrors) {
      if (e.severity !== 'error') continue;
      if (e.nodeName && !out.has(e.nodeName)) {
        out.set(e.nodeName, e.message);
      }
    }
    return out;
  }, [validationErrors]);

  const existingNames = useMemo(() => new Set(docs.map(d => d.name)), [docs]);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Loading orchestrations…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <PageHeader
        title="Pipelines"
        subtitle="orchestration editor"
        status={status}
        errorMsg={errorMsg}
      />

      <View style={styles.pageRow}>
        {sidebarCollapsed ? (
          // Minimized rail — a thin strip with an expand affordance, so the
          // canvas gets the full page width.
          <View style={styles.sidebarRail}>
            <Pressable
              onPress={toggleSidebar}
              style={styles.sidebarRailBtn}
              accessibilityLabel="Expand pipelines list">
              <Text style={styles.sidebarToggleText}>▶</Text>
            </Pressable>
          </View>
        ) : (
        <View style={[styles.sidebar, { width: sidebarWidth }]}>
          <View style={styles.sidebarHeaderRow}>
            <Text style={styles.sidebarHeaderText}>Pipelines</Text>
            <Pressable
              onPress={toggleSidebar}
              style={styles.sidebarCollapseBtn}
              accessibilityLabel="Collapse pipelines list">
              <Text style={styles.sidebarToggleText}>◀</Text>
            </Pressable>
          </View>
          <TextInput
            value={pipelineSearch}
            onChangeText={setPipelineSearch}
            placeholder="Search pipelines…"
            placeholderTextColor="#9ca3af"
            style={styles.sidebarSearch}
          />
          {defaultCount > 0 && (
            <View style={styles.pipelineFilterRow}>
              {(
                [
                  ['all', 'All', 'Show all pipelines'],
                  ['mine', 'Mine', 'Hide default pipelines'],
                  ['defaults', 'Defaults', 'Show only default pipelines'],
                ] as Array<[PipelineFilter, string, string]>
              ).map(([value, label, a11y]) => {
                const selected = pipelineFilter === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => changeFilter(value)}
                    style={[
                      styles.pipelineFilterSeg,
                      selected && styles.pipelineFilterSegActive,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={a11y}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.pipelineFilterSegText,
                        selected && styles.pipelineFilterSegTextActive,
                      ]}>
                      {label}
                      {value === 'defaults' ? ` ${defaultCount}` : ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {/* Attribute toggles (rounded) — Nested + run-status. Unlike the
              rectangular All/Mine/Defaults source segments above (pick one),
              these are on/off filters: none active = unfiltered, so there's no
              second confusing "All". Tap an active status pill again to clear. */}
          <View style={styles.attrFilterRow}>
            {nestedCounts.size > 0 && (
              <Pressable
                onPress={() => setNestedOnly(v => !v)}
                style={[styles.attrPill, nestedOnly && styles.attrPillNestedActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: nestedOnly }}
                accessibilityLabel={`Show only the ${nestedCounts.size} orchestrations that nest sub-orchestrations (${totalNestedCount} nested total)`}>
                <Text
                  numberOfLines={1}
                  style={[styles.attrPillText, nestedOnly && styles.attrPillNestedText]}>
                  🔗 Nested {nestedCounts.size}
                </Text>
              </Pressable>
            )}
            {triggerCounts.size > 0 && (
              <Pressable
                onPress={() => setTriggersOnly(v => !v)}
                style={[styles.attrPill, triggersOnly && styles.attrPillTriggersActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: triggersOnly }}
                accessibilityLabel={`Show only the ${triggerCounts.size} reactive orchestrations that declare a trigger (${totalTriggerCount} trigger${totalTriggerCount === 1 ? '' : 's'} total)`}>
                <Text
                  numberOfLines={1}
                  style={[styles.attrPillText, triggersOnly && styles.attrPillTriggersText]}>
                  ⚡ Triggers {triggerCounts.size}
                </Text>
              </Pressable>
            )}
            {(['running', 'paused', 'success', 'failed'] as const).map(value => {
              const selected = statusFilter === value;
              const label =
                value === 'running'
                  ? '● Running'
                  : value === 'paused'
                    ? '⏸ Needs approval'
                    : value === 'success'
                      ? '✓ Success'
                      : '✗ Failed';
              const activeBg =
                value === 'running'
                  ? styles.attrPillRunningActive
                  : value === 'paused'
                    ? styles.attrPillPausedActive
                    : value === 'success'
                      ? styles.attrPillSuccessActive
                      : styles.attrPillFailedActive;
              const activeText =
                value === 'running'
                  ? styles.attrPillRunningText
                  : value === 'paused'
                    ? styles.attrPillPausedText
                    : value === 'success'
                      ? styles.attrPillSuccessText
                      : styles.attrPillFailedText;
              return (
                <Pressable
                  key={value}
                  onPress={() => setStatusFilter(s => (s === value ? 'all' : value))}
                  style={[styles.attrPill, selected && activeBg]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Filter pipelines by ${value} run status; tap again to clear`}>
                  <Text
                    numberOfLines={1}
                    style={[styles.attrPillText, selected && activeText]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* Tag filter (from lifecycle.tags) — collapsed to ONE toggle pill
              by default so the chip cloud doesn't scrunch the pipeline list.
              The pill shows the active tag when one is set; expanding reveals
              the full single-select chip cloud (sorted by usage), and picking
              or clearing a tag re-collapses it. */}
          {tagCounts.size > 0 && (
            <View style={styles.attrFilterRow}>
              <Pressable
                onPress={() => setTagPickerOpen(v => !v)}
                style={[
                  styles.attrPill,
                  (tagPickerOpen || tagFilter !== null) && styles.attrPillTagActive,
                ]}
                accessibilityRole="button"
                accessibilityState={{ expanded: tagPickerOpen }}
                accessibilityLabel={
                  tagFilter
                    ? `Filtering by tag ${tagFilter}; tap to change`
                    : `Filter by tag (${tagCounts.size} tags); tap to ${tagPickerOpen ? 'collapse' : 'expand'}`
                }>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.attrPillText,
                    (tagPickerOpen || tagFilter !== null) && styles.attrPillTagText,
                  ]}>
                  {tagFilter
                    ? `#${tagFilter}`
                    : `# Tags ${tagCounts.size}`}{' '}
                  {tagPickerOpen ? '▴' : '▾'}
                </Text>
              </Pressable>
            </View>
          )}
          {tagPickerOpen && tagCounts.size > 0 && (
            <View style={styles.attrFilterRow}>
              {Array.from(tagCounts.entries())
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([tag, count]) => {
                  const selected = tagFilter === tag;
                  return (
                    <Pressable
                      key={tag}
                      onPress={() => {
                        setTagFilter(t => (t === tag ? null : tag));
                        setTagPickerOpen(false);
                      }}
                      style={[styles.attrPill, selected && styles.attrPillTagActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Show only the ${count} pipeline${count === 1 ? '' : 's'} tagged ${tag}; tap again to clear`}>
                      <Text
                        numberOfLines={1}
                        style={[styles.attrPillText, selected && styles.attrPillTagText]}>
                        #{tag} {count}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
          )}
          <ScrollView
            style={styles.sidebarListScroll}
            contentContainerStyle={styles.sidebarList}>
            {filteredDocs.length === 0 && (
              <Text style={styles.sidebarEmptyText}>
                {docs.length === 0
                  ? 'No pipelines yet.'
                  : pipelineSearch.trim()
                    ? `No match for "${pipelineSearch.trim()}".`
                    : statusFilter !== 'all'
                      ? `No pipelines with a ${statusFilter} run.`
                      : nestedOnly
                      ? 'No pipelines nest a sub-orchestration here.'
                      : triggersOnly
                      ? 'No reactive pipelines (none declare a trigger) here.'
                      : pipelineFilter === 'mine'
                        ? 'No pipelines of your own yet — all are defaults.'
                        : pipelineFilter === 'defaults'
                          ? 'No default pipelines here.'
                          : 'No pipelines.'}
              </Text>
            )}
            {filteredDocs.map(d => {
              const isActive = d.name === activeName;
              const isRunning = runs.active?.orchestrationName === d.name;
              return (
                <Pressable
                  key={d.name}
                  onPress={() => setActiveName(d.name)}
                  style={[styles.sidebarItem, isActive && styles.sidebarItemActive]}>
                  <View style={styles.sidebarItemRow}>
                    <View style={styles.sidebarItemLeft}>
                      {runStatusByOrch.has(d.name) && (
                        <PipelineStatusDot
                          category={runStatusByOrch.get(d.name) as PipelineStatusCat}
                        />
                      )}
                      <Text
                        style={[
                          styles.sidebarItemText,
                          isActive && styles.sidebarItemTextActive,
                        ]}
                        numberOfLines={1}>
                        {d.name}
                      </Text>
                    </View>
                    {isRunning && (
                      <SidebarRunningBadge
                        paused={runs.active?.status === 'paused'}
                      />
                    )}
                    {nestedCounts.has(d.name) && (
                      <View
                        style={[
                          styles.nestedPill,
                          isActive && styles.nestedPillActive,
                        ]}
                        accessibilityLabel={`Nests ${nestedCounts.get(d.name)} sub-orchestration(s)`}>
                        <Text
                          style={[
                            styles.nestedPillText,
                            isActive && styles.nestedPillTextActive,
                          ]}>
                          🔗 {nestedCounts.get(d.name)}
                        </Text>
                      </View>
                    )}
                    {triggerCounts.has(d.name) && (
                      <View
                        style={[
                          styles.triggerPill,
                          isActive && styles.triggerPillActive,
                        ]}
                        accessibilityLabel={`Declares ${triggerCounts.get(d.name)} trigger(s) — reactive`}>
                        <Text
                          style={[
                            styles.triggerPillText,
                            isActive && styles.triggerPillTextActive,
                          ]}>
                          ⚡ {triggerCounts.get(d.name)}
                        </Text>
                      </View>
                    )}
                    {complexityByOrch.has(d.name) && (
                      <ComplexityBadge
                        complexity={complexityByOrch.get(d.name) as Complexity}
                        compact
                        active={isActive}
                      />
                    )}
                    {isDefaultPipeline(d.name) && (
                      <View
                        style={[
                          styles.defaultPill,
                          isActive && styles.defaultPillActive,
                        ]}>
                        <Text
                          style={[
                            styles.defaultPillText,
                            isActive && styles.defaultPillTextActive,
                          ]}>
                          default
                        </Text>
                      </View>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.sidebarActions}>
            {/* Single "+ New" button — the 4 creation flows live in its
                popover so the sidebar footer stays compact. */}
            <View style={styles.newMenuAnchor}>
              <Pressable
                onPress={() => setNewMenuOpen(o => !o)}
                style={styles.newButton}
                accessibilityLabel="New pipeline">
                <Text style={styles.newButtonText}>+ New pipeline ▾</Text>
              </Pressable>
              {newMenuOpen && (
                <>
                  {/* Tap-outside dismisser, under the menu. */}
                  <Pressable
                    onPress={() => setNewMenuOpen(false)}
                    style={styles.newMenuBackdrop}
                  />
                  {/* Pops UPWARD (footer button) so it doesn't run off-screen. */}
                  <View style={styles.newMenu}>
                    <Pressable
                      onPress={() => {
                        setCreateOpen(true);
                        setNewMenuOpen(false);
                      }}
                      style={styles.newMenuItem}>
                      <Text style={styles.newMenuItemText}>+ Blank pipeline</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setPasteOpen(true);
                        setNewMenuOpen(false);
                      }}
                      style={styles.newMenuItem}>
                      <Text style={styles.newMenuItemText}>📋 Paste JSON</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setGenerateOpen(true);
                        setNewMenuOpen(false);
                      }}
                      style={styles.newMenuItem}>
                      <Text style={styles.newMenuItemText}>✨ Generate from spec</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setGenerateFromFileOpen(true);
                        setNewMenuOpen(false);
                      }}
                      style={styles.newMenuItem}>
                      <Text style={styles.newMenuItemText}>📥 Drop diagram / PRD</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </View>
        </View>
        )}
        {/* Drag handle — pull the divider to resize the pipelines list so
            long names fit. Uses window-level mouse tracking so the drag
            never drops mid-move and text can't select. Hidden while
            collapsed. */}
        {!sidebarCollapsed && (
          <View
            style={styles.sidebarResizer}
            accessibilityRole="adjustable"
            accessibilityLabel="Drag to resize the pipelines list"
            // @ts-expect-error RNW forwards DOM mouse events on View
            onMouseDown={(e: { clientX: number; preventDefault?: () => void }) => {
              e.preventDefault?.();
              startSidebarResize(e.clientX);
            }}
          />
        )}

        <View style={styles.pageMain}>
      {active ? (
        <>
          <View style={styles.activeMeta}>
            <View style={styles.activeMetaRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Text style={styles.activeName}>{active.name}</Text>
                <Text style={styles.activeStats}>{summarizeOrchestration(active)}</Text>
                {complexityByOrch.has(active.name) && (
                  <ComplexityBadge
                    complexity={complexityByOrch.get(active.name) as Complexity}
                  />
                )}
              </View>
              <View style={styles.actionsRow}>
                {/* Inline: high-frequency actions only. The 6
                    lower-frequency (and destructive) ones live in the
                    ⋮ overflow below so this row reads as 4 things
                    instead of 10. */}
                <Pressable
                  onPress={() => setRenameOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Rename pipeline"
                  style={styles.undoButton}>
                  <Text style={styles.undoButtonText}>Rename</Text>
                </Pressable>
                <Pressable
                  onPress={performUndo}
                  disabled={undoCount === 0}
                  style={[
                    styles.undoButton,
                    undoCount === 0 && styles.undoButtonDisabled,
                  ]}>
                  <Text style={styles.undoButtonText}>↶ Undo ({undoCount})</Text>
                </Pressable>
                <Pressable
                  onPress={performRedo}
                  disabled={redoCount === 0}
                  style={[
                    styles.undoButton,
                    redoCount === 0 && styles.undoButtonDisabled,
                  ]}>
                  <Text style={styles.undoButtonText}>↷ Redo ({redoCount})</Text>
                </Pressable>
                {/* Declare the inputs this pipeline asks for on Run (a ticket /
                    doc / URL). Opens the authoring popup right next to Run so
                    it's discoverable; the values themselves are entered in the
                    Run prompt. */}
                <Pressable
                  onPress={() => setInputsConfigOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Configure run inputs"
                  style={styles.undoButton}>
                  <Text style={styles.undoButtonText}>
                    ◇ Inputs
                    {active.inputs && active.inputs.length > 0
                      ? ` (${active.inputs.length})`
                      : ''}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (runs.active) return;
                    if (budget?.blocked) return;
                    // ALWAYS open the pre-run modal — even with no declared
                    // inputs, it offers the optional "Additional instructions"
                    // box (→ the run's initial input). The actual launch
                    // happens in the modal's onRun below.
                    setPendingRun(active);
                  }}
                  disabled={!!runs.active || !!budget?.blocked}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !!runs.active || !!budget?.blocked }}
                  accessibilityLabel={
                    runs.active && runs.active.orchestrationName !== active.name
                      ? `Run unavailable: ${runs.active.orchestrationName} is running`
                      : `Run ${active.name}`
                  }
                  style={[
                    styles.runButton,
                    (!!runs.active || !!budget?.blocked) &&
                      styles.runButtonDisabled,
                  ]}>
                  <Text style={styles.runButtonText}>
                    {runs.active?.orchestrationName === active.name
                      ? runs.active.status === 'paused'
                        ? '⏸ paused'
                        : '⟳ running…'
                      : runs.active
                        ? // One run at a time in this browser: say whose, so a
                          // greyed-out ▶ Run isn't a mystery during a long run.
                          `⏳ ${runs.active.orchestrationName} is running`
                        : budget?.blocked
                          ? '$✗ budget exceeded'
                          : '▶ Run'}
                  </Text>
                </Pressable>
                {/* Overflow trigger. Click toggles a popover that
                    holds History / Explain / Improve / Duplicate /
                    JSON / Delete. Click anywhere outside (the
                    backdrop Pressable below) dismisses. */}
                <View style={styles.overflowAnchor}>
                  <Pressable
                    onPress={() => setOverflowOpen(o => !o)}
                    style={[
                      styles.undoButton,
                      overflowOpen && styles.overflowButtonActive,
                    ]}
                    accessibilityLabel="More actions">
                    <Text style={styles.undoButtonText}>⋮</Text>
                  </Pressable>
                  {overflowOpen && (
                    <>
                      {/* Tap-outside dismisser. Sits underneath the
                          menu so menu clicks don't fall through. */}
                      <Pressable
                        onPress={() => setOverflowOpen(false)}
                        style={styles.overflowBackdrop}
                      />
                      <View style={styles.overflowMenu}>
                        <Pressable
                          onPress={() => {
                            setShowHistory(v => !v);
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>
                            {showHistory ? '× History' : '↻ History'}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setPreviewOpen(true);
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>🔍 Preview</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setExplainOpen(true);
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>🧠 Explain</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            // Start a background improve job for the active
                            // orchestration if there isn't one already (else
                            // reuse the existing running/done job), then open
                            // the modal as a VIEWER of that job. Closing the
                            // modal does NOT cancel the job — it runs in the
                            // app-root store.
                            if (active && !improveJobs.getJob(active.name)) {
                              improveJobs.startImproveJob(active);
                            }
                            setImproveOpen(true);
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>🛠 Improve</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            handleDuplicate();
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>↗ Duplicate</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            exportOrchestrationAsJson(active);
                            setOverflowOpen(false);
                          }}
                          style={styles.overflowItem}>
                          <Text style={styles.overflowItemText}>↓ Download JSON</Text>
                        </Pressable>
                        <View style={styles.overflowDivider} />
                        <Pressable
                          onPress={() => {
                            // Keep the existing tap-again-to-confirm
                            // pattern; the popover already adds one
                            // click of friction, so a wholesale change
                            // to confirm-dialog here would over-fire.
                            handleDelete();
                            // Don't close the menu after the first
                            // press — the user needs to see "Tap again
                            // to confirm" appear in this slot.
                            if (deleteConfirm) setOverflowOpen(false);
                          }}
                          style={[
                            styles.overflowItem,
                            styles.overflowItemDanger,
                            deleteConfirm && styles.overflowItemDangerActive,
                          ]}>
                          <Text
                            style={[
                              styles.overflowItemText,
                              styles.overflowItemDangerText,
                              deleteConfirm && styles.overflowItemDangerTextActive,
                            ]}>
                            {deleteConfirm ? 'Tap again to confirm' : 'Delete'}
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </View>
              </View>
            </View>
            {active.description && (
              <Pressable
                onPress={toggleDesc}
                style={styles.descRow}
                accessibilityLabel={
                  descExpanded ? 'Collapse description' : 'Expand description'
                }>
                <Text style={styles.descChevron}>{descExpanded ? '▾' : '▸'}</Text>
                <Text
                  style={[styles.activeDescription, { flex: 1, marginTop: 0 }]}
                  numberOfLines={descExpanded ? undefined : 1}>
                  {active.description}
                </Text>
              </Pressable>
            )}
            {runs.lastError && (
              <Text style={styles.runErrorText}>{runs.lastError}</Text>
            )}
            {validationErrors.length > 0 && (
              <ValidationBanner
                errors={validationErrors}
                onGenerateMissingAgent={path => setMissingAgentToFix(path)}
              />
            )}
            {missingAgentToFix && (
              <GenerateMissingAgentModal
                agentPath={missingAgentToFix}
                onClose={() => setMissingAgentToFix(null)}
                onSaved={() => {
                  setMissingAgentToFix(null);
                  // Re-fetch agents so the missing-agent warning clears — the
                  // newly-generated agent now exists, so refresh the known set
                  // (mirrors the boot effect above).
                  listAgents()
                    .then(list => {
                      setKnownAgentPaths(
                        new Set(list.map(a => `agents/${a.name}.md`)),
                      );
                    })
                    .catch(() => {});
                  // Trigger a re-validate by nudging the active doc state.
                  setDocs(prev => prev.slice());
                }}
              />
            )}
            {budget && (budget.warning || budget.blocked) && (
              <View
                style={[
                  styles.budgetBanner,
                  budget.blocked && styles.budgetBannerBlocked,
                ]}>
                <Text style={styles.budgetBannerText}>
                  {budget.blocked ? '$✗' : '$⚠'} Budget{' '}
                  {budget.blocked ? 'exceeded' : 'warning'}:{' '}
                  {budgetBannerText(budget)}
                </Text>
              </View>
            )}
            {showHistory && (
              <VersionHistoryPanel
                scope="examples"
                name={active.name}
                currentContent={JSON.stringify(active, null, 2)}
              />
            )}
          </View>

          <View style={styles.modeRow}>
            {/* Tiny glyphs prefix each label so first-time users have a
                visual cue for "this is the sequence view" vs "this is
                the canvas view" vs "this is the tree view" vs "this is
                the raw JSON". The labels alone read as four
                interchangeable choices but the views are not. */}
            <ModeButton
              label="⇨ Pipeline"
              active={mode === 'pipeline'}
              onPress={() => setMode('pipeline')}
            />
            <ModeButton
              label="⊞ Graph"
              active={mode === 'graph'}
              onPress={() => setMode('graph')}
            />
            <ModeButton
              label="⊿ Tree"
              active={mode === 'tree'}
              onPress={() => setMode('tree')}
            />
            {mode !== 'graph' && (
              <ModeButton
                label={showJson ? '✓ { } JSON' : '{ } JSON'}
                active={showJson}
                onPress={() => setShowJson(s => !s)}
              />
            )}
          </View>

          {/* The orchestration's entry point — shown above the flow in every
           *  view (Pipeline / Graph / Tree). Reads/writes orchestration.triggers.
           *  (Run inputs are authored from the ◇ Inputs button next to ▶ Run.) */}
          {active && (
            <View style={{ paddingHorizontal: 24, paddingTop: 10 }}>
              <TriggersHead
                triggers={active.triggers}
                onChange={next => handleChange({ ...active, triggers: next })}
              />
            </View>
          )}

          <View
            style={[
              styles.body,
              mode !== 'graph' && showJson && { flexDirection: 'row', gap: 12 },
            ]}>
            <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {mode === 'pipeline' && (
                <PipelineEditor
                  orchestration={active}
                  onChange={handleChange}
                  availablePhases={availablePhases}
                  errorNodeNames={errorNodeNames}
                  errorMessageByNode={errorMessageByNode}
                  selectedNodeName={selectedNodeName}
                  onSelectionChange={setSelectedNodeName}
                  live={{
                    statusByNode: live.info.statusByNode,
                    isLive: live.isLive,
                    loopIterByNode: live.info.loopIterByNode,
                    mapProgressByNode: live.info.mapProgressByNode,
                    routeDecisionByNode: live.info.routeDecisionByNode,
                    loopStopByNode: live.info.loopStopByNode,
                  }}
                />
              )}
              {mode === 'graph' && (
                <Suspense
                  fallback={
                    <View style={styles.center}>
                      <Text style={styles.dim}>Loading graph…</Text>
                    </View>
                  }>
                  <GraphEditor
                    orchestration={active}
                    onChange={handleChange}
                    availableOrchestrations={docs.map(d => d.name)}
                    selectedNodeName={selectedNodeName}
                    onSelectionChange={setSelectedNodeName}
                    errorNodeNames={errorNodeNames}
                    errorMessageByNode={errorMessageByNode}
                    runStatusByNode={live.info.statusByNode}
                    liveActivePhase={live.isLive ? live.info.activePhase : null}
                  />
                </Suspense>
              )}
              {mode === 'tree' && (
                <ScrollView contentContainerStyle={styles.treeScroll}>
                  <View style={styles.treeCard}>
                    <OrchestrationTree
                      node={active}
                      onChange={handleChange}
                      errorNodeNames={errorNodeNames}
                      errorMessageByNode={errorMessageByNode}
                      selectedNodeName={selectedNodeName}
                      onSelectionChange={setSelectedNodeName}
                      statusByNode={live.info.statusByNode}
                      isLive={live.isLive}
                    />
                  </View>
                </ScrollView>
              )}
            </View>
            {mode !== 'graph' && showJson && (
              <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <OrchestrationJsonPanel
                  orchestration={active}
                  onChange={handleChange}
                />
              </View>
            )}
          </View>
          {/* Talk to the running agent + approve lock gates without leaving
              the editor — shows only when the open orchestration has an
              active run. */}
          <RunDock orchestrationName={active.name} />
        </>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No pipelines</Text>
          <Text style={styles.emptyBody}>
            Tap <Text style={styles.code}>+ pipeline</Text> in the sidebar to create one.
          </Text>
        </View>
      )}
        </View>
      </View>

      <CreatePipelineModal
        visible={createOpen}
        existingNames={existingNames}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />

      <PasteJsonModal
        visible={pasteOpen}
        existingNames={existingNames}
        onClose={() => setPasteOpen(false)}
        onCreate={async parsed => {
          const validation = validateOrchestration(parsed);
          const errs = validation.filter(v => v.severity === 'error');
          if (errs.length > 0) {
            setErrorMsg(`Pasted JSON has ${errs.length} validation error(s) — open it in the editor to see them.`);
          }
          try {
            const saved = await persist(parsed);
            setDocs(prev =>
              [...prev.filter(d => d.name !== saved.name), saved].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            );
            setActiveName(saved.name);
            setPasteOpen(false);
          } catch (err) {
            setErrorMsg((err as Error).message);
          }
        }}
      />

      {explainOpen && active && (
        <ExplainOrchestrationModal
          orchestration={active}
          onClose={() => setExplainOpen(false)}
        />
      )}
      {previewOpen && active && (
        <PreviewOrchestrationModal
          orchestration={active}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {improveOpen && active && (
        <ImproveOrchestrationModal
          orchestration={active}
          existingNames={existingNames}
          availableOrchestrations={docs.map(d => d.name)}
          onClose={() => setImproveOpen(false)}
          onSaveAsNew={async revised => {
            // SAFE path: the modal has already set `revised.name` to a
            // de-duped "<orig> (improved)" name, so this never collides with
            // the original. Mirror the GenerateFromSpec create flow: persist,
            // add to the list, and land the user on the NEW copy so they can
            // Run it to validate before touching the original.
            try {
              const saved = await persist(revised);
              setDocs(prev =>
                [...prev.filter(d => d.name !== saved.name), saved].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setActiveName(saved.name);
            } catch (err) {
              setErrorMsg((err as Error).message);
              throw err;
            }
          }}
          onApply={async revised => {
            // DESTRUCTIVE path: mirror the GenerateFromSpec / PasteJson
            // save-then-select path: persist the revised doc, swap it into the
            // list by name (so a same-name revision overwrites the original),
            // and make it the active doc.
            try {
              const saved = await persist(revised);
              setDocs(prev =>
                [...prev.filter(d => d.name !== saved.name), saved].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setActiveName(saved.name);
            } catch (err) {
              setErrorMsg((err as Error).message);
              throw err;
            }
          }}
        />
      )}

      <GenerateFromSpecModal
        visible={generateOpen}
        existingNames={existingNames}
        onClose={() => setGenerateOpen(false)}
        onCreate={async parsed => {
          try {
            const saved = await persist(parsed);
            setDocs(prev =>
              [...prev.filter(d => d.name !== saved.name), saved].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            );
            setActiveName(saved.name);
            setGenerateOpen(false);
          } catch (err) {
            setErrorMsg((err as Error).message);
          }
        }}
      />

      <GenerateFromFileModal
        visible={generateFromFileOpen}
        existingNames={existingNames}
        onClose={() => setGenerateFromFileOpen(false)}
        onCreate={async parsed => {
          try {
            const saved = await persist(parsed);
            setDocs(prev =>
              [...prev.filter(d => d.name !== saved.name), saved].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            );
            setActiveName(saved.name);
            setGenerateFromFileOpen(false);
          } catch (err) {
            setErrorMsg((err as Error).message);
          }
        }}
      />

      <RenamePipelineModal
        visible={renameOpen}
        currentName={activeName ?? ''}
        existingNames={existingNames}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
      />
      <RunInputsModal
        orchestration={pendingRun}
        error={runStartFailed ? (runs.lastError ?? 'The run did not start.') : null}
        onClose={() => {
          setPendingRun(null);
          setRunStartFailed(false);
        }}
        onRun={(values, instructions) => {
          const orch = pendingRun;
          if (!orch) return;
          // The instructions box → the run's initial input.
          const initialInput = instructions || undefined;
          // Declared inputs resolve server-side, so they force the
          // server-owned path. With no declared inputs we honor the auth
          // mode just like a plain ▶ Run did (proxy → server, else browser).
          const hasDeclaredInputs = Object.keys(values).length > 0;
          const useServer =
            hasDeclaredInputs || getAuthMode() === 'claude-code-proxy';
          const ok = useServer
            ? runs.startServerRun(orch, initialInput, values)
            : runs.startRun(orch, initialInput);
          // A refused start (no API key, wrong auth mode, …) keeps the dialog
          // open with the reason; closing first left only a small red line
          // behind the dialog, so ▶ Run looked like it did nothing.
          if (ok) {
            setPendingRun(null);
            setRunStartFailed(false);
            onNavigate?.('runs');
          } else {
            setRunStartFailed(true);
          }
        }}
      />
      {/* Authoring popup for the ◇ Inputs button next to ▶ Run — declare the
          ticket / doc / URL this pipeline asks for. The values are entered in
          the Run prompt above; this just declares what to ask for. */}
      {inputsConfigOpen && active && (
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setInputsConfigOpen(false)}
          />
          <View style={styles.modalPanel}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>◇ Run inputs</Text>
              <Pressable onPress={() => setInputsConfigOpen(false)}>
                <Text style={styles.modalClose}>×</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>
              Declare what this pipeline should prompt for on ▶ Run — a ticket,
              a document, a URL, or freeform text. Leave it empty and Run starts
              immediately. You enter the actual values in the Run prompt.
            </Text>
            <InputsHead
              inputs={active.inputs}
              onChange={next =>
                handleChange({
                  ...active,
                  inputs: next.length > 0 ? next : undefined,
                })
              }
            />
          </View>
        </View>
      )}
    </View>
  );
}

/** AI-explain an orchestration: short modal that streams a plain-
 *  English summary from the orchestration-explainer agent. Useful
 *  for inherited / complex pipelines you didn't author. */
function ExplainOrchestrationModal({
  orchestration,
  onClose,
}: {
  orchestration: Node;
  onClose: () => void;
}) {
  const [explanation, setExplanation] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const authMode = getAuthMode();
      const apiKey = getApiKey() ?? '';
      if (authMode === 'direct-api-key' && !apiKey) {
        setError('No API key configured.');
        setStatus('error');
        return;
      }
      const model = getModel();
      const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
      try {
        const agents = await listAgents();
        const explainer = agents.find(a => a.name === 'orchestration-explainer');
        if (!explainer) {
          setError('Missing agents/orchestration-explainer.md');
          setStatus('error');
          return;
        }
        const m = explainer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
        const systemPrompt = (m ? m[1] : explainer.raw).trim();
        setStatus('running');
        let accum = '';
        for await (const ev of streamFn({
          apiKey,
          model,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: `# ORCHESTRATION\n\n\`\`\`json\n${JSON.stringify(orchestration, null, 2)}\n\`\`\`\n\nExplain it now.`,
            },
          ],
        })) {
          if (ev.type === 'text-delta') {
            accum += ev.text;
            setExplanation(accum);
          }
        }
        setStatus('done');
      } catch (err) {
        setError((err as Error).message);
        setStatus('error');
      }
    })();
  }, [orchestration]);

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { width: 660, maxHeight: 720 }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>🧠 What does "{orchestration.name}" do?</Text>
        </View>
        {error && <Text style={styles.runErrorText}>{error}</Text>}
        <ScrollView nestedScrollEnabled style={{ maxHeight: 540, marginTop: 4 }}>
          {explanation ? (
            <Text style={{ fontSize: 12, color: '#111827', lineHeight: 18 }} selectable>
              {explanation}
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: '#9ca3af' }}>
              {status === 'running'
                ? 'Generating…'
                : status === 'error'
                  ? '(see error above)'
                  : 'Loading…'}
            </Text>
          )}
        </ScrollView>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Symbolic dry-run of the active orchestration: POSTs /api/preview (the
 *  same walker `sammy-cli preview` uses — nothing is dispatched, no run is
 *  created) and shows the findings, severity-badged, above the rendered plan
 *  in a monospace block. Pure static analysis — needs no API key. */
function PreviewOrchestrationModal({
  orchestration,
  onClose,
}: {
  orchestration: Node;
  onClose: () => void;
}) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    previewOrchestration(orchestration.name)
      .then(r => {
        if (!stale) setResult(r);
      })
      .catch(err => {
        if (!stale) setError((err as Error).message);
      });
    return () => {
      stale = true;
    };
  }, [orchestration]);

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      {/* Wide enough for the ~780px plan table (the shared modalPanel caps
          at 480px, which clipped every line). */}
      <View style={[styles.modalPanel, styles.previewPanel]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            🔍 Preview — "{orchestration.name}"
          </Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>×</Text>
          </Pressable>
        </View>
        {error && <Text style={styles.runErrorText}>{error}</Text>}
        {result && result.findings.length > 0 && (
          <ScrollView nestedScrollEnabled style={{ maxHeight: 160, marginTop: 4 }}>
            {result.findings.map((f, i) => (
              <View key={i} style={[styles.validationRow, { marginBottom: 4 }]}>
                <Text
                  style={[
                    styles.validationSeverity,
                    f.severity === 'warning' && styles.validationSeverityWarn,
                    f.severity === 'info' && styles.previewSeverityInfo,
                  ]}>
                  {f.severity === 'error'
                    ? 'ERR'
                    : f.severity === 'warning'
                      ? 'WRN'
                      : 'INF'}
                </Text>
                <View style={styles.validationDetails}>
                  <Text style={styles.validationMsg}>{f.message}</Text>
                  <Text style={styles.validationPath}>
                    {f.phase ? `[${f.phase}] ` : ''}
                    {f.code}
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
        {result && result.findings.length === 0 && (
          <Text style={{ fontSize: 11, color: '#16a34a', marginTop: 4 }}>
            ✓ No findings — the plan resolves clean.
          </Text>
        )}
        <View
          style={{
            marginTop: 8,
            backgroundColor: '#020617',
            borderRadius: 6,
            padding: 8,
            flexShrink: 1,
          }}>
          {/* One vertical scroller; an over-long line WRAPS rather than
              hiding behind a horizontal scrollbar that sat below the fold
              of the nested vertical one. */}
          <ScrollView nestedScrollEnabled style={{ maxHeight: 520 }}>
            <Text
              style={{
                fontFamily: 'Menlo',
                fontSize: 11,
                color: '#e2e8f0',
                lineHeight: 15,
              }}
              selectable>
              {result
                ? result.rendered
                : error
                  ? '(see error above)'
                  : 'Resolving plan…'}
            </Text>
          </ScrollView>
        </View>
        <View
          style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Quick-fix for "agent file not found" validation warnings.
 *  Pre-fills the agent name from the missing path; user describes
 *  what the agent should do, generator runs, file is saved to disk.
 *  The orchestration's validation re-runs automatically when the
 *  agents list refreshes upstream. */
function GenerateMissingAgentModal({
  agentPath,
  onClose,
  onSaved,
}: {
  agentPath: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const name = agentPath.replace(/^agents\//, '').replace(/\.md$/, '');
  const [role, setRole] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setOutput('');
    if (!role.trim()) {
      setError('Describe what this agent should do.');
      return;
    }
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured.');
      return;
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const all = await listAgents();
    const designer = all.find(a => a.name === 'agent-designer');
    if (!designer) {
      setError('Missing agents/agent-designer.md');
      return;
    }
    const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : designer.raw).trim();
    setStatus('generating');
    let accum = '';
    try {
      for await (const ev of streamFn({
        apiKey,
        model,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `# ROLE\n\nThe agent's name MUST be exactly "${name}" (the orchestration already references it as agents/${name}.md). ${role.trim()}\n\nWrite the agent markdown now.`,
          },
        ],
      })) {
        if (ev.type === 'text-delta') {
          accum += ev.text;
          setOutput(accum);
        }
      }
      const cleaned = accum
        .trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      // Force the name field to match the missing path (don't trust the LLM
      // to honor the constraint perfectly).
      const normalized = cleaned.replace(/^(---\r?\n[\s\S]*?\bname:\s*)\S+/, `$1${name}`);
      await saveAgent(name, normalized);
      setStatus('done');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { width: 640, maxHeight: 720 }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>✨ Generate missing agent: {agentPath}</Text>
        </View>
        <Text style={{ fontSize: 11, color: '#6b7280' }}>
          Your orchestration references <Text style={{ fontFamily: 'Menlo' }}>{agentPath}</Text>{' '}
          but no such file exists. Describe what this agent should do and a draft
          will be generated + saved.
        </Text>
        <TextInput
          value={role}
          onChangeText={setRole}
          placeholder='Example: "Reviews draft PRs for merge readiness, blocks on missing tests or breaking API changes."'
          style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]}
          multiline
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <Pressable
            onPress={generate}
            disabled={status === 'generating'}
            style={[styles.runButton, status === 'generating' && { opacity: 0.5 }]}>
            <Text style={styles.runButtonText}>
              {status === 'generating' ? '⟳ Generating + saving…' : '✨ Generate + save'}
            </Text>
          </Pressable>
        </View>
        {error && <Text style={styles.runErrorText}>{error}</Text>}
        {(output || status === 'generating') && (
          <View style={{ marginTop: 8, backgroundColor: '#020617', borderRadius: 6, padding: 8, maxHeight: 280 }}>
            <Text style={{ fontSize: 9, color: '#94a3b8', fontWeight: '700', marginBottom: 4 }}>
              GENERATED MARKDOWN
            </Text>
            <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}>
              <Text style={{ fontFamily: 'Menlo', fontSize: 10, color: '#e2e8f0', lineHeight: 14 }} selectable>
                {output || '(waiting for first token…)'}
              </Text>
            </ScrollView>
          </View>
        )}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Minimal line-based markdown renderer for the critique.
 *
 *  The priority is bold `## subtitle` lines (the user's headline ask), so we
 *  don't pull in a full markdown lib — we just walk the lines:
 *    - `#` / `##` / `###` headings → bold Text, larger for higher levels.
 *    - `- ` / `* ` bullets        → •-prefixed, indented Text.
 *    - blank lines                → a small vertical spacer.
 *    - everything else            → a normal paragraph Text.
 *  Leading `**bold**` wrapper on a whole line is also rendered bold so a
 *  "**Risks**" style subheading still reads as one. */
function MarkdownText({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed === '') {
          return <View key={i} style={{ height: 6 }} />;
        }
        const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          const text = heading[2];
          const size = level <= 1 ? 16 : level === 2 ? 14 : 12.5;
          return (
            <Text
              key={i}
              selectable
              style={{
                fontSize: size,
                fontWeight: '700',
                color: '#111827',
                marginTop: level <= 2 ? 10 : 6,
                marginBottom: 2,
                lineHeight: size + 6,
              }}>
              {text}
            </Text>
          );
        }
        const bullet = trimmed.match(/^[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <Text
              key={i}
              selectable
              style={{
                fontSize: 12,
                color: '#111827',
                lineHeight: 18,
                marginLeft: 12,
              }}>
              {'• '}
              {bullet[1]}
            </Text>
          );
        }
        // A whole-line bold wrapper ("**Heading**") reads as a subheading too.
        const wholeBold = trimmed.match(/^\*\*(.+)\*\*:?$/);
        if (wholeBold) {
          return (
            <Text
              key={i}
              selectable
              style={{
                fontSize: 13,
                fontWeight: '700',
                color: '#111827',
                marginTop: 8,
                marginBottom: 2,
                lineHeight: 19,
              }}>
              {wholeBold[1]}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            selectable
            style={{ fontSize: 12, color: '#111827', lineHeight: 18 }}>
            {line}
          </Text>
        );
      })}
    </View>
  );
}

/** AI-improve VIEWER + approval surface. The critique generation runs as a
 *  background job in the ImproveJobs store (app root); this component is a
 *  viewer of that job that ALSO lets the user (1) approve which suggestions to
 *  apply via per-item checkboxes and (2) steer the reviewer via a chat line.
 *
 *  The critique markdown (prioritized risks / parallelization / cost /
 *  agent-fit / clarity sections) is parsed into discrete checkable items
 *  (parseCritiqueItems); when parsing finds nothing it falls back to the raw
 *  MarkdownText. "Save as new" / "Overwrite" run the designer (revise) pass ON
 *  DEMAND against ONLY the checked items (buildSelectedInstruction →
 *  reviseSelected), so apply reflects the user's selection rather than the
 *  whole critique. The steer chat line re-runs the critique with the user's
 *  guidance folded into the meta-agent prompt (reuses startImproveJob).
 *
 *  Closing this modal does NOT cancel the job — it keeps running in the store
 *  and pops a click-to-open toast when it finishes. */
function ImproveOrchestrationModal({
  orchestration,
  existingNames,
  availableOrchestrations,
  onClose,
  onSaveAsNew,
  onApply,
}: {
  orchestration: Node;
  /** All current orchestration names — used to de-dupe the "Save as new"
   *  name so we never collide with (and surprise-overwrite) an existing doc. */
  existingNames: Set<string>;
  /** Names of every orchestration (for the Graph preview's subflow picker —
   *  read-only here, but the prop is part of the editor's contract). */
  availableOrchestrations: string[];
  onClose: () => void;
  /** SAFE default: persist the revised orchestration as a NEW doc (named
   *  via uniqueName off "<orig> (improved)") WITHOUT touching the original,
   *  then make the new copy active so the user can Run it to validate. */
  onSaveAsNew: (next: Node) => Promise<void>;
  /** DESTRUCTIVE: replace the original orchestration with the revised one
   *  in place. Wired to the parent's save-then-select path. Gated behind a
   *  confirm in the UI. */
  onApply: (next: Node) => Promise<void> | void;
}) {
  const { startImproveJob, reviseSelected } = useImproveJobs();
  // Reactive read of THIS orchestration's job — the modal re-renders as the
  // critique streams + the revised pass lands. The job is created by the
  // "🛠 Improve" action (or the re-run button below) — never here, so reopening
  // a done job shows results immediately without regenerating.
  const job = useImproveJob(orchestration.name);
  const status: ImproveJob['status'] | 'idle' = job?.status ?? 'idle';
  const critique = job?.critique ?? '';
  const revised = job?.revised ?? null;
  const revErrors = job?.revErrors ?? [];
  const jobError = job?.error ?? null;
  const reviseStatus = job?.reviseStatus ?? 'idle';
  const reviseError = job?.reviseError ?? null;
  const steers = job?.steers ?? [];

  // Parse the critique markdown into discrete, checkable improvement items
  // (preserving section grouping). Memoized off the critique STRING so it only
  // re-parses when the critique changes — not on every keystroke/toggle.
  const parsedItems = useMemo(() => parseCritiqueItems(critique), [critique]);
  // Local selection state, seeded from the parse (all selected by default).
  // Held locally (not in the store) because it's pure view state tied to the
  // current critique; re-seeded whenever a fresh critique parses.
  const [items, setItems] = useState<ImproveItem[]>(parsedItems);
  useEffect(() => {
    setItems(parsedItems);
  }, [parsedItems]);
  // True once the critique is done AND we parsed at least one item — gates the
  // checkbox UI; when false (unparseable critique) we fall back to raw markdown.
  const hasItems = status === 'done' && items.length > 0;
  const selectedCount = items.filter(i => i.selected).length;

  function toggleItem(id: string) {
    setItems(prev =>
      prev.map(i => (i.id === id ? { ...i, selected: !i.selected } : i)),
    );
  }
  function setSection(section: string, selected: boolean) {
    setItems(prev =>
      prev.map(i => (i.section === section ? { ...i, selected } : i)),
    );
  }

  // Group items by section for rendering, preserving first-seen order.
  const sections = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, ImproveItem[]>();
    for (const it of items) {
      if (!map.has(it.section)) {
        map.set(it.section, []);
        order.push(it.section);
      }
      map.get(it.section)!.push(it);
    }
    return order.map(name => ({ name, items: map.get(name)! }));
  }, [items]);

  // Preview is collapsed by default — the critique is the headline; the
  // revised-pipeline visual is opt-in (toggle or scroll).
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState<'tree' | 'pipeline' | 'graph'>(
    'tree',
  );
  // `applying` tracks which destructive/save action is mid-flight (null when
  // idle) so both buttons can show a per-action in-flight label + disable.
  // 'preview' covers the on-demand revise behind the Preview toggle.
  const [applying, setApplying] = useState<
    null | 'saveAsNew' | 'overwrite' | 'preview'
  >(null);
  // Two-step inline confirm for the destructive Overwrite action — the first
  // press arms it, the second commits. Re-armed on every new revision.
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  // Local save errors (separate from the job's generation errors).
  const [saveError, setSaveError] = useState<string | null>(null);
  // The steer chat line's draft text.
  const [steerDraft, setSteerDraft] = useState('');

  const revHardErrors = revErrors.filter(v => v.severity === 'error');
  // Apply is enabled when the critique is done, at least one item is checked,
  // and nothing is mid-flight. (The revise pass + its validation run when the
  // user clicks Apply — see handleApply.)
  const canApply =
    status === 'done' && selectedCount > 0 && !applying && reviseStatus !== 'running';

  // The de-duped name for the safe "Save as new" copy. Reuses the same
  // counter-based collision helper (uniqueName), which now also slugifies
  // to a server-safe name — so "<orig> (improved)" becomes
  // "<orig>-improved" (and "…-2", "…-3" on repeat) rather than a name the
  // PUT endpoint rejects with 400 "Invalid name".
  const newName = useMemo(
    () => uniqueName(`${orchestration.name} (improved)`, existingNames),
    [orchestration.name, existingNames],
  );

  // Re-arm the destructive confirm + collapse the (now stale) preview whenever
  // a fresh revision lands, so a stale "Confirm overwrite?" can't apply a
  // different revision than the user saw.
  useEffect(() => {
    setConfirmOverwrite(false);
  }, [revised]);
  // Selection changes invalidate the last-generated revision — collapse the
  // preview + disarm overwrite so the user can't apply a revision built from a
  // different checkbox set than what's now checked.
  useEffect(() => {
    setShowPreview(false);
    setConfirmOverwrite(false);
  }, [items]);

  /**
   * Run the revise (designer) pass against ONLY the checked items, validate it,
   * and return the revised Node — or null (with a surfaced error) on failure.
   * Shared by Preview, Save-as-new, and Overwrite so the apply always reflects
   * the user's current checkbox selection.
   */
  async function generateRevision(): Promise<Node | null> {
    const instruction = buildSelectedInstruction(items);
    if (!instruction) {
      setSaveError('Select at least one improvement to apply.');
      return null;
    }
    const next = await reviseSelected(orchestration, instruction);
    if (!next) {
      // reviseSelected stores the reason on job.reviseError, shown below.
      return null;
    }
    const hard = validateOrchestration(next).filter(v => v.severity === 'error');
    if (hard.length > 0) {
      setSaveError(
        `Revised orchestration has ${hard.length} validation error(s) — see the preview.`,
      );
      setShowPreview(true);
      return null;
    }
    return next;
  }

  async function handlePreview() {
    // Toggle off if already shown.
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    if (!canApply) return;
    setSaveError(null);
    setApplying('preview');
    try {
      const next = await generateRevision();
      if (next) setShowPreview(true);
    } finally {
      setApplying(null);
    }
  }

  async function handleSaveAsNew() {
    if (!canApply) return;
    setSaveError(null);
    setApplying('saveAsNew');
    try {
      const next = await generateRevision();
      if (!next) return;
      // Clone + rename so the original Node is never mutated, then persist as
      // a brand-new doc and land the user on the copy.
      await onSaveAsNew({ ...next, name: newName });
      onClose();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setApplying(null);
    }
  }

  async function handleOverwrite() {
    if (!canApply) return;
    // First press just arms the inline confirm.
    if (!confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    setSaveError(null);
    setApplying('overwrite');
    try {
      const next = await generateRevision();
      if (!next) {
        setConfirmOverwrite(false);
        return;
      }
      await onApply(next);
      onClose();
    } catch (err) {
      setSaveError((err as Error).message);
      setConfirmOverwrite(false);
    } finally {
      setApplying(null);
    }
  }

  function handleSteer() {
    const text = steerDraft.trim();
    if (!text || status === 'running') return;
    // Re-run the critique pass with the steer folded in (re-propose model).
    // Reuses the existing Re-run code path via startImproveJob's steerText arg.
    setSaveError(null);
    setShowPreview(false);
    startImproveJob(orchestration, text);
    setSteerDraft('');
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { width: 1750, maxWidth: '95%', maxHeight: 720 }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>🛠 Improvements for "{orchestration.name}"</Text>
          {/* Re-run starts a FRESH job (replacing the current one) — e.g. after
              editing the orchestration since the last critique. */}
          {(status === 'done' || status === 'error') && (
            <Pressable
              onPress={() => {
                setSaveError(null);
                setShowPreview(false);
                startImproveJob(orchestration);
              }}
              style={styles.undoButton}>
              <Text style={styles.undoButtonText}>↻ Re-run improvements</Text>
            </Pressable>
          )}
        </View>
        {jobError && <Text style={styles.runErrorText}>{jobError}</Text>}
        {saveError && <Text style={styles.runErrorText}>{saveError}</Text>}
        {reviseError && <Text style={styles.runErrorText}>{reviseError}</Text>}
        <ScrollView nestedScrollEnabled style={{ maxHeight: 520, marginTop: 4 }}>
          {hasItems ? (
            // ── Checklist: one checkbox per parsed improvement, grouped by
            //    section, so the user approves WHICH suggestions to apply. ──
            <View>
              <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                Pick the improvements to apply. Apply revises the orchestration
                using only the checked items.
              </Text>
              {sections.map(sec => {
                const allOn = sec.items.every(i => i.selected);
                const noneOn = sec.items.every(i => !i.selected);
                return (
                  <View key={sec.name} style={{ marginBottom: 14 }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 4,
                      }}>
                      <Text
                        style={{
                          fontSize: 14,
                          fontWeight: '700',
                          color: '#111827',
                          flex: 1,
                        }}>
                        {sec.name}
                      </Text>
                      {/* Cheap per-section select-all / none. */}
                      <Pressable
                        onPress={() => setSection(sec.name, true)}
                        disabled={allOn}
                        style={[styles.undoButton, allOn && styles.undoButtonDisabled]}>
                        <Text style={styles.undoButtonText}>All</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setSection(sec.name, false)}
                        disabled={noneOn}
                        style={[styles.undoButton, noneOn && styles.undoButtonDisabled]}>
                        <Text style={styles.undoButtonText}>None</Text>
                      </Pressable>
                    </View>
                    {sec.items.map(it => (
                      <Pressable
                        key={it.id}
                        onPress={() => toggleItem(it.id)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'flex-start',
                          gap: 8,
                          paddingVertical: 5,
                          paddingHorizontal: 6,
                          borderRadius: 6,
                          backgroundColor: it.selected ? '#eff6ff' : 'transparent',
                        }}>
                        {/* Checkbox glyph — no extra deps, matches the modal's
                            text-driven styling. */}
                        <View
                          style={[
                            styles.improveCheckbox,
                            it.selected && styles.improveCheckboxOn,
                          ]}>
                          {it.selected && (
                            <Text style={styles.improveCheckboxTick}>✓</Text>
                          )}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text
                            selectable
                            style={{
                              fontSize: 12.5,
                              fontWeight: '600',
                              color: '#111827',
                              lineHeight: 18,
                            }}>
                            {it.title}
                          </Text>
                          {it.detail !== '' && (
                            <Text
                              selectable
                              style={{
                                fontSize: 12,
                                color: '#4b5563',
                                lineHeight: 17,
                                marginTop: 1,
                              }}>
                              {it.detail}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    ))}
                  </View>
                );
              })}
            </View>
          ) : critique ? (
            // Fall back to the raw critique when parsing found no items (or the
            // critique is still streaming).
            <MarkdownText source={critique} />
          ) : (
            <Text style={{ fontSize: 12, color: '#9ca3af' }}>
              {status === 'running'
                ? 'Reviewing the orchestration…'
                : status === 'error'
                  ? '(see error above)'
                  : status === 'idle'
                    ? 'No improvements yet — close and re-open from the ⋮ menu.'
                    : 'Loading…'}
            </Text>
          )}

          {/* ── Revised-pipeline preview (generated on demand from the checked
              items when the user clicks Preview below the items). Gated on
              `showPreview` so editing the selection — which collapses it —
              fully hides the now-stale revision instead of leaving a dangling
              validation banner. ── */}
          {(reviseStatus === 'running' || (status === 'done' && revised && showPreview)) && (
            <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 12 }}>
              {reviseStatus === 'running' && (
                <Text style={{ fontSize: 12, color: '#6b7280' }}>
                  Generating revised pipeline from the {selectedCount} selected
                  improvement{selectedCount === 1 ? '' : 's'}…
                </Text>
              )}
              {revised && (
                <View>
                  {revHardErrors.length > 0 && (
                    <Text style={{ fontSize: 11, color: '#dc2626', marginBottom: 6 }}>
                      {revHardErrors.length} validation error(s) — cannot apply
                    </Text>
                  )}
                  {showPreview && (
                    <View style={{ marginTop: 10 }}>
                      {revHardErrors.length > 0 ? (
                        <View>
                          {revErrors.map((v, i) => (
                            <Text
                              key={i}
                              style={{
                                fontSize: 11,
                                color: v.severity === 'error' ? '#dc2626' : '#b45309',
                                marginBottom: 2,
                              }}>
                              {v.severity === 'error' ? '⚠ ' : 'ⓘ '}
                              {v.path ? `${v.path}: ` : ''}
                              {v.message}
                            </Text>
                          ))}
                        </View>
                      ) : (
                        <View>
                          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                            <Pressable
                              onPress={() => setPreviewMode('tree')}
                              style={[
                                styles.undoButton,
                                previewMode === 'tree' && { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
                              ]}>
                              <Text style={styles.undoButtonText}>Tree</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => setPreviewMode('pipeline')}
                              style={[
                                styles.undoButton,
                                previewMode === 'pipeline' && { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
                              ]}>
                              <Text style={styles.undoButtonText}>Pipeline</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => setPreviewMode('graph')}
                              style={[
                                styles.undoButton,
                                previewMode === 'graph' && { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
                              ]}>
                              <Text style={styles.undoButtonText}>Graph</Text>
                            </Pressable>
                          </View>
                          <View
                            style={{
                              borderWidth: 1,
                              borderColor: '#e5e7eb',
                              borderRadius: 8,
                              padding: 8,
                              backgroundColor: '#fafafa',
                              // Graph needs a bounded height to render its canvas.
                              ...(previewMode === 'graph' ? { height: 420 } : null),
                            }}>
                            {previewMode === 'tree' ? (
                              <OrchestrationTree node={revised} onChange={() => {}} />
                            ) : previewMode === 'pipeline' ? (
                              <PipelineEditor orchestration={revised} onChange={() => {}} />
                            ) : (
                              <Suspense
                                fallback={
                                  <View style={styles.center}>
                                    <Text style={styles.dim}>Loading graph…</Text>
                                  </View>
                                }>
                                <GraphEditor
                                  orchestration={revised}
                                  onChange={() => {}}
                                  availableOrchestrations={availableOrchestrations}
                                />
                              </Suspense>
                            )}
                          </View>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* ── Steer chat: re-run the critique with extra guidance. ── */}
        <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 8 }}>
          {steers.length > 0 && (
            // History strip of submitted steers — small chips above the input.
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 6,
              }}>
              {steers.map((s, i) => (
                <View key={i} style={styles.steerChip}>
                  <Text style={styles.steerChipText} numberOfLines={1}>
                    💬 {s}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={steerDraft}
              onChangeText={setSteerDraft}
              onSubmitEditing={handleSteer}
              editable={status !== 'running'}
              placeholder="Steer the reviewer… e.g. focus on cost, or ignore parallelization"
              style={[
                styles.input,
                { flex: 1, fontSize: 12, paddingVertical: 6 },
                status === 'running' && styles.buttonDisabled,
              ]}
              autoCorrect={false}
            />
            <Pressable
              onPress={handleSteer}
              disabled={status === 'running' || steerDraft.trim() === ''}
              style={[
                styles.button,
                styles.primaryButton,
                (status === 'running' || steerDraft.trim() === '') &&
                  styles.buttonDisabled,
              ]}>
              <Text style={styles.primaryButtonText}>
                {status === 'running' ? 'Reviewing…' : 'Steer'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Close</Text>
          </Pressable>
          {status === 'running' && (
            <Text style={{ fontSize: 11, color: '#6b7280' }}>
              Running in the background — closing won't cancel it.
            </Text>
          )}
          {/* Running "N of M selected" count near the action buttons. */}
          {hasItems && (
            <Text style={{ fontSize: 11, color: '#6b7280' }}>
              {selectedCount} of {items.length} selected
            </Text>
          )}
          {/* Preview the revision built from the CURRENTLY checked items. */}
          {hasItems && (
            <Pressable
              onPress={handlePreview}
              disabled={!showPreview && !canApply}
              style={[
                styles.undoButton,
                !showPreview && !canApply && styles.undoButtonDisabled,
              ]}>
              <Text style={styles.undoButtonText}>
                {applying === 'preview'
                  ? 'Revising…'
                  : showPreview
                    ? '▾ Hide preview'
                    : '▸ Preview revision'}
              </Text>
            </Pressable>
          )}
          <View style={{ flex: 1 }} />
          {/* Destructive, secondary action — relabeled from "Apply" and gated
              behind a two-step inline confirm. */}
          {confirmOverwrite && (
            <Pressable
              onPress={() => setConfirmOverwrite(false)}
              disabled={!!applying}
              style={[styles.undoButton, !!applying && styles.buttonDisabled]}>
              <Text style={styles.undoButtonText}>Cancel</Text>
            </Pressable>
          )}
          <Pressable
            onPress={handleOverwrite}
            disabled={!canApply}
            style={[
              styles.dangerButton,
              confirmOverwrite && styles.dangerButtonArmed,
              !canApply && styles.buttonDisabled,
            ]}>
            <Text
              style={[
                styles.dangerButtonText,
                confirmOverwrite && styles.dangerButtonTextArmed,
              ]}>
              {applying === 'overwrite'
                ? 'Overwriting…'
                : confirmOverwrite
                  ? 'Confirm overwrite?'
                  : 'Overwrite original'}
            </Text>
          </Pressable>
          {/* SAFE primary/default action — persists a new copy + lands on it. */}
          <Pressable
            onPress={handleSaveAsNew}
            disabled={!canApply}
            style={[styles.button, styles.primaryButton, !canApply && styles.buttonDisabled]}>
            <Text style={styles.primaryButtonText}>
              {applying === 'saveAsNew' ? 'Saving…' : `Save as new`}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** AI-assist: paste a spec / PRD / requirements doc, have a designer
 *  agent emit a sammy-pack orchestration JSON. Streams the agent's
 *  output live; validates against the schema; lets the user accept
 *  + save or discard + retry.
 *
 *  The designer agent (agents/orchestration-designer.md, shipped in
 *  the repo) knows the schema + composite types + lists the
 *  available agents so the generated tree references real names. */
function GenerateFromSpecModal({
  visible,
  existingNames,
  onClose,
  onCreate,
}: {
  visible: boolean;
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (parsed: Node) => Promise<void>;
}) {
  const [spec, setSpec] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Node | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [availableAgents, setAvailableAgents] = useState<
    Array<{ name: string; description: string }>
  >([]);

  useEffect(() => {
    if (visible) {
      setSpec('');
      setOutput('');
      setStatus('idle');
      setError(null);
      setParsed(null);
      setValidationErrors([]);
      listAgents()
        .then(rows =>
          setAvailableAgents(
            rows.map(a => {
              const m = a.raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
              const fm = m ? m[1] : '';
              const desc =
                fm.match(/^description:\s*(.+?)$/m)?.[1]?.trim() ??
                a.raw.split('\n').find(l => l.trim() && !l.startsWith('---'))?.slice(0, 120) ??
                '';
              return { name: a.name, description: desc };
            }),
          ),
        )
        .catch(() => {
          /* non-fatal */
        });
    }
  }, [visible]);

  async function generate() {
    setError(null);
    setOutput('');
    setParsed(null);
    setValidationErrors([]);
    if (!spec.trim()) {
      setError('Paste a spec / PRD / requirements doc to generate from.');
      return;
    }
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured. Set one in Settings, or switch to Claude Code login mode.');
      return;
    }
    const model = getModel();
    const streamFn = authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;

    // Fetch the designer agent on demand — keeps this code path zero-cost
    // when the modal isn't open.
    let designerSystemPrompt: string;
    try {
      const agents = await listAgents();
      const designer = agents.find(a => a.name === 'orchestration-designer');
      if (!designer) {
        setError(
          'Missing agents/orchestration-designer.md — re-pull the workspace or create one manually.',
        );
        return;
      }
      const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
      const body = (m ? m[1] : designer.raw).trim();
      // Substitute the available-agents list into the prompt template.
      const agentList = availableAgents
        .filter(a => a.name !== 'orchestration-designer')
        .map(a => `- agents/${a.name}.md — ${a.description}`)
        .join('\n');
      designerSystemPrompt = body.replace('{{AVAILABLE_AGENTS}}', agentList || '(none)');
    } catch (err) {
      setError(`Failed to load designer agent: ${(err as Error).message}`);
      return;
    }

    setStatus('generating');
    let accum = '';
    try {
      for await (const ev of streamFn({
        apiKey,
        model,
        system: designerSystemPrompt,
        messages: [
          {
            role: 'user',
            content: `# SPEC\n\n${spec.trim()}\n\nEmit the orchestration JSON now.`,
          },
        ],
      })) {
        if (ev.type === 'text-delta') {
          accum += ev.text;
          setOutput(accum);
        }
      }
      // Try to parse — strip optional ```json fences the LLM sometimes
      // adds despite instructions.
      const cleaned = accum
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      try {
        const obj = JSON.parse(cleaned) as Node;
        // Refuse names that collide with existing pipelines so we don't
        // surprise-overwrite. The user can rename below.
        if (obj.name && existingNames.has(obj.name)) {
          obj.name = `${obj.name}-${Math.random().toString(36).slice(2, 6)}`;
        }
        setParsed(obj);
        setValidationErrors(validateOrchestration(obj));
        setStatus('done');
      } catch (err) {
        setError(
          `Output wasn't valid JSON (${(err as Error).message}). Adjust the spec or retry.`,
        );
        setStatus('error');
      }
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  if (!visible) return null;
  const hardErrors = validationErrors.filter(v => v.severity === 'error');
  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { maxHeight: 720, width: 700 }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>✨ Generate orchestration from spec</Text>
        </View>
        <Text style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
          Paste a spec, PRD, ticket, or requirements doc. The designer agent
          analyzes it and emits a sammy-pack orchestration that decomposes the
          work — using the agents already in your library.
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 4 }}>
          <Pressable
            onPress={() => {
              const g = globalThis as unknown as {
                document?: {
                  createElement(t: string): {
                    type: string;
                    accept: string;
                    onchange: ((e: unknown) => void) | null;
                    click(): void;
                  };
                };
              };
              if (!g.document) return;
              const input = g.document.createElement('input');
              input.type = 'file';
              input.accept = '.md,.txt,.json,text/plain,text/markdown,application/json';
              input.onchange = async ev => {
                const files = (ev as { target?: { files?: { 0?: { text(): Promise<string>; name?: string } } } })?.target?.files;
                const file = files?.[0];
                if (!file) return;
                try {
                  const text = await file.text();
                  setSpec(prev => (prev.trim() ? prev + '\n\n' : '') + text);
                } catch (err) {
                  setError(`Failed to read file: ${(err as Error).message}`);
                }
              };
              input.click();
            }}
            style={styles.undoButton}>
            <Text style={styles.undoButtonText}>📎 Upload spec file</Text>
          </Pressable>
        </View>
        <TextInput
          value={spec}
          onChangeText={setSpec}
          placeholder={
            'Example: "Build a flow that takes an inbound ticket → drafts a PR plan → human-gates it → implements + tests in a loop → final review." Or upload a .md / .txt / .json file above.'
          }
          style={[styles.input, { minHeight: 140, fontSize: 12, textAlignVertical: 'top' }]}
          multiline
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <Pressable
            onPress={generate}
            disabled={status === 'generating'}
            style={[styles.runButton, status === 'generating' && { opacity: 0.5 }]}>
            <Text style={styles.runButtonText}>
              {status === 'generating' ? '⟳ Generating…' : '✨ Generate'}
            </Text>
          </Pressable>
          {status === 'done' && hardErrors.length === 0 && parsed && (
            <Pressable
              onPress={() => onCreate(parsed)}
              style={[styles.runButton, { backgroundColor: '#059669' }]}>
              <Text style={styles.runButtonText}>+ Save as "{parsed.name}"</Text>
            </Pressable>
          )}
          <Text style={{ fontSize: 11, color: '#6b7280', flex: 1 }}>
            {availableAgents.length} agent{availableAgents.length === 1 ? '' : 's'} in library
          </Text>
        </View>
        {error && <Text style={styles.runErrorText}>{error}</Text>}
        {hardErrors.length > 0 && (
          <Text style={[styles.runErrorText, { color: '#92400e' }]}>
            Output parsed but has {hardErrors.length} validation error(s) — paste it into the JSON editor to fix.
          </Text>
        )}
        {(output || status === 'generating') && (
          <View
            style={{
              marginTop: 8,
              backgroundColor: '#020617',
              borderRadius: 6,
              padding: 8,
              maxHeight: 320,
            }}>
            <Text style={{ fontSize: 9, color: '#94a3b8', fontWeight: '700', marginBottom: 4 }}>
              GENERATED OUTPUT
            </Text>
            <ScrollView nestedScrollEnabled style={{ maxHeight: 280 }}>
              <Text
                style={{
                  fontFamily: 'Menlo',
                  fontSize: 10,
                  color: '#e2e8f0',
                  lineHeight: 14,
                }}
                selectable>
                {output || '(waiting for first token…)'}
              </Text>
            </ScrollView>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ─── GenerateFromFileModal ────────────────────────────────────────
//
// Drop a diagram (PNG / JPG / .drawio / .excalidraw / .pdf / .md /
// .txt) and the server's orchestration-designer agent extracts the
// agent flow into a sammy-pack orchestration. Per-phase agents are
// matched against the workspace agents/ directory; unmatched ones
// surface as red rows with a "✨ Generate the N missing agents"
// button that fans out to the existing per-agent generation flow.

type AgentMatchRow = {
  declared: string;
  phaseName: string;
  matched: string | null;
  matchSource: 'exact' | 'normalized' | 'substring' | 'levenshtein' | null;
  matchedName: string | null;
};

type FromFileResponse = {
  orchestration: Node;
  agentMatchReport: {
    matches: AgentMatchRow[];
    unmatched: AgentMatchRow[];
  };
  summary: string;
};

function GenerateFromFileModal({
  visible,
  existingNames,
  onClose,
  onCreate,
}: {
  visible: boolean;
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (parsed: Node) => Promise<void>;
}) {
  const [status, setStatus] = useState<
    'idle' | 'reading' | 'extracting' | 'preview' | 'generating-agents' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<FromFileResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [orchName, setOrchName] = useState('');
  // When a FOLDER was picked, the files actually sent + any skipped by
  // the client-side cap — surfaced so the user knows the count + names.
  const [folderPicked, setFolderPicked] = useState<{
    sent: string[];
    skipped: string[];
  } | null>(null);
  // Per-missing-agent generation status — keyed by phase name.
  const [agentGenStatus, setAgentGenStatus] = useState<
    Record<string, 'pending' | 'generating' | 'done' | 'error'>
  >({});
  // Live progress message during agent batch generation.
  const [agentGenMsg, setAgentGenMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (visible) {
      setStatus('idle');
      setError(null);
      setResponse(null);
      setOrchName('');
      setFolderPicked(null);
      setAgentGenStatus({});
      setAgentGenMsg(null);
    }
  }, [visible]);

  async function handleFile(file: File): Promise<void> {
    setStatus('reading');
    setError(null);
    setResponse(null);
    try {
      const data = await fileToBase64(file);
      setStatus('extracting');
      // Test hook: `?dryRun=1` in the URL skips the real SDK call on
      // the server. Returns a synthetic orchestration built from the
      // extracted graph structure so the UI + matcher can be
      // validated by Playwright without burning tokens.
      const dryRun =
        typeof globalThis !== 'undefined' &&
        (globalThis as { location?: { search?: string } }).location?.search?.includes(
          'dryRun=1',
        );
      const res = await fetch('/api/orchestrations/from-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mediaType: file.type,
          data,
          dryRun: !!dryRun,
        }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`Extraction failed (${res.status}): ${msg}`);
      }
      const parsed = (await res.json()) as FromFileResponse;
      setResponse(parsed);
      setOrchName(parsed.orchestration.name ?? '');
      setStatus('preview');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  // Folder upload. Each picked file carries a path relative to the
  // chosen folder (webkitRelativePath). We base64-encode every file,
  // apply a client-side file-count cap (matches the server's), and POST
  // the batch to /api/orchestrations/from-folder, which aggregates them
  // into ONE orchestration. Files beyond the cap are reported as
  // skipped — never silently dropped.
  async function handleFolder(files: File[]): Promise<void> {
    if (files.length === 0) {
      setError('No files found in that folder.');
      setStatus('error');
      return;
    }
    setStatus('reading');
    setError(null);
    setResponse(null);
    setFolderPicked(null);
    try {
      // Mirror the server cap so the user sees what was skipped before
      // we even send. Stable sort by relative path so the picked/skipped
      // split is deterministic.
      const CLIENT_MAX_FILES = 40;
      const sorted = [...files].sort((a, b) =>
        relPathOf(a).localeCompare(relPathOf(b)),
      );
      const kept = sorted.slice(0, CLIENT_MAX_FILES);
      const skipped = sorted.slice(CLIENT_MAX_FILES).map(relPathOf);
      const payloadFiles = await Promise.all(
        kept.map(async f => ({
          relPath: relPathOf(f),
          filename: f.name,
          mediaType: f.type,
          data: await fileToBase64(f),
        })),
      );
      setFolderPicked({ sent: kept.map(relPathOf), skipped });
      setStatus('extracting');
      const dryRun =
        typeof globalThis !== 'undefined' &&
        (globalThis as { location?: { search?: string } }).location?.search?.includes(
          'dryRun=1',
        );
      const res = await fetch('/api/orchestrations/from-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: payloadFiles, dryRun: !!dryRun }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`Extraction failed (${res.status}): ${msg}`);
      }
      const parsed = (await res.json()) as FromFileResponse;
      setResponse(parsed);
      setOrchName(parsed.orchestration.name ?? '');
      setStatus('preview');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function generateMissingAgents(): Promise<void> {
    if (!response) return;
    setStatus('generating-agents');
    setAgentGenMsg(null);
    const authMode = getAuthMode();
    const apiKey = getApiKey() ?? '';
    if (authMode === 'direct-api-key' && !apiKey) {
      setError('No API key configured.');
      setStatus('preview');
      return;
    }
    const model = getModel();
    const streamFn =
      authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
    const all = await listAgents();
    const designer = all.find(a => a.name === 'agent-designer');
    if (!designer) {
      setError('Missing agents/agent-designer.md');
      setStatus('preview');
      return;
    }
    const m = designer.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const systemPrompt = (m ? m[1] : designer.raw).trim();
    const toGenerate = response.agentMatchReport.unmatched;
    for (let i = 0; i < toGenerate.length; i++) {
      const entry = toGenerate[i];
      const name = entry.declared
        .replace(/^agents\//, '')
        .replace(/\.md$/, '');
      setAgentGenStatus(prev => ({ ...prev, [entry.phaseName]: 'generating' }));
      setAgentGenMsg(`(${i + 1}/${toGenerate.length}) ${name}…`);
      // Build a context-rich role description so the agent body
      // actually reflects what the phase is supposed to do.
      const role = describePhaseContext(response.orchestration, entry.phaseName);
      let accum = '';
      try {
        for await (const ev of streamFn({
          apiKey,
          model,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content:
                `# ROLE\n\n` +
                `The agent's name MUST be exactly "${name}" (an ` +
                `orchestration just generated from a diagram references ` +
                `it as agents/${name}.md). ${role}\n\n` +
                `Write the agent markdown now.`,
            },
          ],
        })) {
          if (ev.type === 'text-delta') accum += ev.text;
        }
        const cleaned = accum
          .trim()
          .replace(/^```(?:markdown|md)?\s*/i, '')
          .replace(/\s*```\s*$/i, '');
        const normalized = cleaned.replace(
          /^(---\r?\n[\s\S]*?\bname:\s*)\S+/,
          `$1${name}`,
        );
        await saveAgent(name, normalized);
        setAgentGenStatus(prev => ({ ...prev, [entry.phaseName]: 'done' }));
      } catch (err) {
        setAgentGenStatus(prev => ({ ...prev, [entry.phaseName]: 'error' }));
        setError(`Failed generating ${name}: ${(err as Error).message}`);
      }
    }
    setAgentGenMsg('All done.');
    setStatus('preview');
  }

  async function save(): Promise<void> {
    if (!response) return;
    const trimmed = orchName.trim();
    if (!trimmed) {
      setError('Orchestration name is required.');
      return;
    }
    if (existingNames.has(trimmed) && trimmed !== response.orchestration.name) {
      setError(`An orchestration named "${trimmed}" already exists.`);
      return;
    }
    const final = { ...response.orchestration, name: trimmed };
    await onCreate(final);
  }

  if (!visible) return null;

  const matched = response?.agentMatchReport.matches ?? [];
  const unmatched = response?.agentMatchReport.unmatched ?? [];
  const validationErrors = response
    ? validateOrchestration(response.orchestration)
    : [];

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, { width: 720, maxHeight: 760 }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>📥 Generate from diagram / PRD</Text>
        </View>

        {status === 'idle' && (
          <View>
            <Pressable
              onPress={() => fileInputRef.current?.click()}
              // The drag handlers attach via a hidden div below — RN-Web's
              // Pressable doesn't surface drag events natively. Dropping a
              // FOLDER (or multiple files) routes to the folder path.
              style={[
                styles.dropZone,
                dragOver && styles.dropZoneActive,
              ]}>
              <Text style={styles.dropZoneText}>
                {dragOver
                  ? '↓ release to upload'
                  : '↓ Drop a file or a whole folder'}
              </Text>
              <Text style={styles.dropZoneHint}>
                PNG · JPG · GIF · WebP · .drawio · .excalidraw · PDF · .md · .txt
              </Text>
              <Text style={styles.dropZoneHint}>
                click to pick a single file — or use the button below for a folder
              </Text>
              {/* Hidden native inputs own drag events + click-to-pick.
                  One picks a single file; the second uses webkitdirectory
                  to surface every file in a chosen folder (each with a
                  webkitRelativePath). */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,.gif,.webp,.drawio,.xml,.excalidraw,.pdf,.md,.txt,.mmd,image/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.currentTarget.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                // webkitdirectory turns this into a folder picker; the
                // resulting FileList carries every descendant file with a
                // webkitRelativePath. Non-standard attrs set via spread so
                // TS/JSX accept them.
                {...({
                  webkitdirectory: '',
                  directory: '',
                  multiple: true,
                } as Record<string, unknown>)}
                style={{ display: 'none' }}
                onChange={e => {
                  const fl = e.currentTarget.files;
                  if (fl && fl.length) void handleFolder(Array.from(fl));
                }}
              />
              <div
                onDragOver={e => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragOver(false);
                  // A dropped folder surfaces as DataTransferItem entries
                  // (webkitGetAsEntry → isDirectory). Walk those to collect
                  // every descendant file. A single file (no directory
                  // entry) takes the fast single-file path.
                  const dt = e.dataTransfer;
                  const items = dt?.items ? Array.from(dt.items) : [];
                  const hasDir = items.some(it => {
                    const entry = (
                      it as unknown as {
                        webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
                      }
                    ).webkitGetAsEntry?.();
                    return !!entry?.isDirectory;
                  });
                  if (hasDir || (dt?.files?.length ?? 0) > 1) {
                    void collectDroppedFiles(items, dt?.files ?? null).then(
                      files => {
                        if (files.length) void handleFolder(files);
                      },
                    );
                    return;
                  }
                  const f = dt?.files?.[0];
                  if (f) void handleFile(f);
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'auto',
                }}
              />
            </Pressable>
            <Pressable
              onPress={() => folderInputRef.current?.click()}
              style={[styles.modalCancel, { marginTop: 10, alignSelf: 'flex-start' }]}>
              <Text style={styles.modalCancelText}>📁 Upload folder</Text>
            </Pressable>
            <Text style={[styles.dropZoneHint, { marginTop: 4 }]}>
              A folder is walked into ONE orchestration (max 40 files / ~250 KB text;
              extras are listed, not silently dropped).
            </Text>
          </View>
        )}

        {(status === 'reading' || status === 'extracting') && (
          <Text style={styles.hint}>
            {status === 'reading'
              ? '⟳ Reading file…'
              : '⟳ Extracting structure via orchestration-designer (vision)…'}
          </Text>
        )}

        {status === 'error' && (
          <View>
            <Text style={[styles.hint, { color: '#dc2626' }]}>{error}</Text>
            <Pressable
              onPress={() => setStatus('idle')}
              style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>Try another file</Text>
            </Pressable>
          </View>
        )}

        {(status === 'preview' || status === 'generating-agents') &&
          response && (
            <ScrollView style={{ maxHeight: 540 }}>
              <Text style={[styles.hint, { marginBottom: 6 }]}>
                Extracted: {response.summary}
              </Text>

              {/* When a FOLDER was uploaded, show exactly which files were
               *  sent and which the client cap skipped — no silent drops. */}
              {folderPicked && (
                <View style={{ marginBottom: 8 }}>
                  <Text style={styles.fieldLabel}>
                    Folder · {folderPicked.sent.length} file
                    {folderPicked.sent.length === 1 ? '' : 's'} sent
                  </Text>
                  <View style={styles.structurePreview}>
                    {folderPicked.sent.slice(0, 20).map((p, i) => (
                      <Text key={i} style={styles.structureName}>
                        • {p}
                      </Text>
                    ))}
                    {folderPicked.sent.length > 20 && (
                      <Text style={styles.structureOverflow}>
                        … and {folderPicked.sent.length - 20} more
                      </Text>
                    )}
                  </View>
                  {folderPicked.skipped.length > 0 && (
                    <Text style={[styles.validationText, { color: '#b45309', marginTop: 4 }]}>
                      ⚠ {folderPicked.skipped.length} file
                      {folderPicked.skipped.length === 1 ? '' : 's'} skipped by the
                      40-file cap: {folderPicked.skipped.slice(0, 6).join(', ')}
                      {folderPicked.skipped.length > 6
                        ? `, … +${folderPicked.skipped.length - 6} more`
                        : ''}
                    </Text>
                  )}
                </View>
              )}

              <Text style={styles.fieldLabel}>Orchestration name</Text>
              <TextInput
                value={orchName}
                onChangeText={setOrchName}
                style={styles.input}
                autoCorrect={false}
                autoCapitalize="none"
              />

              {/* C.2 — Structure preview. Shows the phase tree of the
               *  imported orchestration so the user can sanity-check
               *  shape (parallel branches, loops, route fan-out, etc.)
               *  before saving. Capped at 30 rows + an overflow line. */}
              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>
                Structure preview
              </Text>
              <View style={styles.structurePreview}>
                {(() => {
                  const rows = buildImportStructureRows(response.orchestration);
                  const cap = 30;
                  const visible = rows.slice(0, cap);
                  const overflow = rows.length - visible.length;
                  return (
                    <>
                      {visible.map((r, i) => (
                        <View
                          key={i}
                          style={[
                            styles.structureRow,
                            { paddingLeft: 8 + r.depth * 14 },
                          ]}>
                          <Text style={styles.structurePrefix}>{r.prefix}</Text>
                          <Text style={styles.structureName}>{r.name}</Text>
                          {r.meta && (
                            <Text style={styles.structureMeta}>· {r.meta}</Text>
                          )}
                        </View>
                      ))}
                      {overflow > 0 && (
                        <Text style={styles.structureOverflow}>
                          … and {overflow} more (open the orchestration to view)
                        </Text>
                      )}
                    </>
                  );
                })()}
              </View>

              <Text style={[styles.fieldLabel, { marginTop: 12 }]}>
                Agent matching ({matched.length - unmatched.length}/
                {matched.length} resolved)
              </Text>
              <View style={styles.matchList}>
                {matched.map((m, i) => (
                  <View key={i} style={styles.matchRow}>
                    <Text
                      style={[
                        styles.matchDot,
                        {
                          color: m.matched
                            ? '#059669'
                            : '#dc2626',
                        },
                      ]}>
                      {m.matched ? '✓' : '✗'}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.matchPhase}>
                        {m.phaseName}{' '}
                        <Text style={styles.matchDeclared}>
                          ({m.declared})
                        </Text>
                      </Text>
                      {m.matched ? (
                        <Text style={styles.matchTarget}>
                          → {m.matched}{' '}
                          {m.matchSource !== 'exact' && (
                            <Text style={styles.matchSource}>
                              · {m.matchSource}
                            </Text>
                          )}
                        </Text>
                      ) : (
                        <Text style={styles.matchMissing}>
                          {agentGenStatus[m.phaseName] === 'done'
                            ? '→ ✓ generated'
                            : agentGenStatus[m.phaseName] === 'generating'
                              ? '→ ⟳ generating…'
                              : agentGenStatus[m.phaseName] === 'error'
                                ? '→ ✗ failed'
                                : 'needs generation'}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>

              {validationErrors.length > 0 && (
                <View style={styles.validationBanner}>
                  <Text style={styles.validationTitle}>
                    Schema warnings ({validationErrors.length})
                  </Text>
                  {validationErrors.slice(0, 4).map((v, i) => (
                    <Text key={i} style={styles.validationText}>
                      • {v.path}: {v.message}
                    </Text>
                  ))}
                  {validationErrors.length > 4 && (
                    <Text style={styles.validationText}>
                      … and {validationErrors.length - 4} more
                    </Text>
                  )}
                </View>
              )}

              {agentGenMsg && (
                <Text style={styles.hint}>{agentGenMsg}</Text>
              )}

              <View style={styles.modalActions}>
                {unmatched.length > 0 &&
                  status !== 'generating-agents' &&
                  unmatched.every(u => agentGenStatus[u.phaseName] !== 'done') && (
                    <Pressable
                      onPress={() => void generateMissingAgents()}
                      style={styles.modalPrimary}>
                      <Text style={styles.modalPrimaryText}>
                        ✨ Generate the {unmatched.length} missing agent
                        {unmatched.length === 1 ? '' : 's'}
                      </Text>
                    </Pressable>
                  )}
                <Pressable
                  onPress={() => void save()}
                  style={styles.modalPrimary}
                  disabled={status === 'generating-agents'}>
                  <Text style={styles.modalPrimaryText}>
                    Save orchestration
                  </Text>
                </Pressable>
                <Pressable onPress={onClose} style={styles.modalCancel}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
      </View>
    </View>
  );
}

/** Read a File into a base64 string (without the data:URL prefix).
 *  Browser-only — uses FileReader. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<...>"
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** The file's path relative to the picked folder. `webkitRelativePath`
 *  is set by a `webkitdirectory` input AND by the drag-drop entry walker
 *  below (we stamp it there). Falls back to the bare name. */
function relPathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.length ? rel : f.name;
}

/** Walk dropped DataTransfer items into a flat File[] with each file's
 *  path-relative-to-the-dropped-root stamped onto `webkitRelativePath`
 *  (so the folder + single-file paths look identical downstream).
 *  Recurses directory entries via the webkit FileSystem entry API; falls
 *  back to `dataTransfer.files` when entries aren't available. */
async function collectDroppedFiles(
  items: DataTransferItem[],
  fallback: FileList | null,
): Promise<File[]> {
  type FsEntry = {
    isFile?: boolean;
    isDirectory?: boolean;
    fullPath?: string;
    file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
    createReader?: () => {
      readEntries: (cb: (entries: FsEntry[]) => void, err?: (e: unknown) => void) => void;
    };
  };
  const entries: FsEntry[] = [];
  for (const it of items) {
    const entry = (
      it as unknown as { webkitGetAsEntry?: () => FsEntry | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  // No entry API → just return the flat FileList (no relative paths).
  if (entries.length === 0) {
    return fallback ? Array.from(fallback) : [];
  }
  const out: File[] = [];
  async function walk(entry: FsEntry): Promise<void> {
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) =>
        entry.file!(resolve, reject),
      );
      // Stamp the entry's fullPath (drops the leading "/") as the
      // relative path so it matches webkitdirectory semantics.
      const rel = (entry.fullPath ?? `/${file.name}`).replace(/^\//, '');
      try {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: rel,
          configurable: true,
        });
      } catch {
        /* read-only in some engines — relPathOf falls back to name */
      }
      out.push(file);
      return;
    }
    if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      // readEntries returns in batches; loop until it yields nothing.
      for (;;) {
        const batch = await new Promise<FsEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return out;
}

/** Walk an imported orchestration and flatten it into an indented
 *  list the import-preview UI can render. Each row carries a depth
 *  (for left indent), a glyph prefix to hint at body kind, the phase
 *  name, and optional meta (agent path / composite arity / subflow
 *  target). Limits recursion to 5 levels — anything deeper collapses
 *  to a single "…" row. */
type ImportStructureRow = {
  depth: number;
  prefix: string;
  name: string;
  meta?: string;
};
function buildImportStructureRows(root: Node): ImportStructureRow[] {
  const MAX_DEPTH = 5;
  const out: ImportStructureRow[] = [];
  function visit(n: Node, depth: number): void {
    if (depth > MAX_DEPTH) {
      out.push({ depth, prefix: '…', name: '(deeper subtree elided)' });
      return;
    }
    const c = compositeKey(n);
    if (n.agent) {
      out.push({
        depth,
        prefix: '🤖',
        name: n.name,
        meta: n.agent.split('/').pop()?.replace(/\.md$/, '') ?? n.agent,
      });
      return;
    }
    if (n.subflow) {
      out.push({ depth, prefix: '🔗', name: n.name, meta: `→ ${n.subflow}` });
      return;
    }
    if (!c) {
      out.push({ depth, prefix: '○', name: n.name });
      return;
    }
    if (c === 'agents') {
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: `agents·${n.agents?.length ?? 0}`,
      });
      (n.agents ?? []).forEach(a => {
        out.push({
          depth: depth + 1,
          prefix: '·',
          name: a.split('/').pop()?.replace(/\.md$/, '') ?? a,
        });
      });
      return;
    }
    if (c === 'phases' || c === 'parallel' || c === 'converge') {
      const children = (n[c] as Node[] | undefined) ?? [];
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: `${c}·${children.length}`,
      });
      children.forEach(child => visit(child, depth + 1));
      return;
    }
    if (c === 'loop' && n.loop) {
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: n.loop.maxIterations
          ? `loop·up to ${n.loop.maxIterations}×`
          : 'loop',
      });
      visit(n.loop.body, depth + 1);
      return;
    }
    if (c === 'map' && n.map) {
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: `map over ${n.map.over}`,
      });
      visit(n.map.body, depth + 1);
      return;
    }
    if (c === 'route' && n.route) {
      const branchCount = Object.keys(n.route.branches).length;
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: `route·${branchCount} branch${branchCount === 1 ? '' : 'es'}`,
      });
      for (const [k, b] of Object.entries(n.route.branches)) {
        out.push({
          depth: depth + 1,
          prefix: `"${k}"`,
          name: b.name,
        });
      }
      if (n.route.default) {
        out.push({
          depth: depth + 1,
          prefix: 'default',
          name: n.route.default.name,
        });
      }
      return;
    }
    if (c === 'conversation' && n.conversation) {
      const participants = n.conversation.participants ?? [];
      out.push({
        depth,
        prefix: '◆',
        name: n.name,
        meta: `conversation·${participants.length} participant${participants.length === 1 ? '' : 's'}`,
      });
      participants.forEach((p, i) => {
        out.push({
          depth: depth + 1,
          prefix: `T${i + 1}`,
          name: p.split('/').pop()?.replace(/\.md$/, '') ?? p,
        });
      });
      return;
    }
    out.push({ depth, prefix: '○', name: n.name });
  }
  // Render the root's children directly — the root itself is the
  // orchestration name shown above the preview, so showing it again
  // would be redundant. If root has no children (single-phase
  // orchestration), show the root as the only row.
  const rootChildren =
    root.phases ?? root.parallel ?? root.converge ?? null;
  if (rootChildren && rootChildren.length > 0) {
    rootChildren.forEach(c => visit(c, 0));
  } else {
    visit(root, 0);
  }
  return out;
}

/** Build a 1-2 sentence description of what a specific phase does,
 *  based on its position in the orchestration tree + its name +
 *  surrounding phase names. Fed into the agent generator so the
 *  produced agent body reflects the diagram's intent rather than a
 *  generic "an agent that does the thing". */
function describePhaseContext(orch: Node, phaseName: string): string {
  function findPath(node: Node, path: string[]): string[] | null {
    if (node.name === phaseName) return [...path, node.name];
    for (const key of ['phases', 'parallel', 'converge'] as const) {
      const arr = node[key];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const found = findPath(c, [...path, node.name]);
          if (found) return found;
        }
      }
    }
    if (node.loop?.body) {
      const f = findPath(node.loop.body, [...path, node.name]);
      if (f) return f;
    }
    if (node.map?.body) {
      const f = findPath(node.map.body, [...path, node.name]);
      if (f) return f;
    }
    return null;
  }
  const path = findPath(orch, []);
  const desc = path
    ? `It's phase "${phaseName}" inside the "${orch.name}" orchestration, at path: ${path.join(' › ')}.`
    : `It's phase "${phaseName}" inside the "${orch.name}" orchestration.`;
  return `${desc} The phase name is a strong hint about its responsibility — make the agent body match that intent and produce output the next phase in the chain can act on.`;
}

function PasteJsonModal({
  visible,
  existingNames,
  onClose,
  onCreate,
}: {
  visible: boolean;
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (parsed: Node) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setText('');
      setError(null);
    }
  }, [visible]);

  if (!visible) return null;
  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalPanel}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Paste orchestration JSON</Text>
        </View>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder='{ "name": "my-pipeline", "phases": [ ... ] }'
          style={[styles.input, { minHeight: 280, fontFamily: 'Menlo', fontSize: 11, textAlignVertical: 'top' }]}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        {error && <Text style={styles.runErrorText}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <Pressable onPress={onClose} style={styles.undoButton}>
            <Text style={styles.undoButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              setError(null);
              let parsed: Node;
              try {
                parsed = JSON.parse(text);
              } catch (err) {
                setError(`Invalid JSON: ${(err as Error).message}`);
                return;
              }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setError('Top-level must be a JSON object');
                return;
              }
              if (!parsed.name || typeof parsed.name !== 'string') {
                setError('Top-level "name" string is required');
                return;
              }
              if (existingNames.has(parsed.name)) {
                setError(`A pipeline named "${parsed.name}" already exists`);
                return;
              }
              await onCreate(parsed);
            }}
            style={styles.runButton}>
            <Text style={styles.runButtonText}>Create</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function RenamePipelineModal({
  visible,
  currentName,
  existingNames,
  onClose,
  onRename,
}: {
  visible: boolean;
  currentName: string;
  existingNames: Set<string>;
  onClose: () => void;
  onRename: (newName: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (visible) setName(currentName);
  }, [visible, currentName]);

  if (!visible) return null;
  const trimmed = name.trim();
  const conflict =
    trimmed.length > 0 && trimmed !== currentName && existingNames.has(trimmed);
  const canSubmit = trimmed.length > 0 && !conflict && trimmed !== currentName;

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalPanel}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Rename pipeline</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>×</Text>
          </Pressable>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>New name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            style={styles.input}
            autoCapitalize="none"
            autoFocus
            selectTextOnFocus
          />
          {conflict && (
            <Text style={styles.errorText}>
              A pipeline named "{trimmed}" already exists.
            </Text>
          )}
        </View>
        <View style={styles.modalButtonRow}>
          <Pressable
            onPress={() => canSubmit && onRename(trimmed)}
            disabled={!canSubmit}
            style={[
              styles.button,
              styles.primaryButton,
              !canSubmit && styles.buttonDisabled,
            ]}>
            <Text style={styles.primaryButtonText}>Rename</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function PageHeader({
  title,
  subtitle,
  status,
  errorMsg,
}: {
  title: string;
  subtitle: string;
  status: Status;
  errorMsg: string | null;
}) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      <View style={styles.statusRow}>
        {status === 'saving' && (
          <Text style={styles.statusSaving}>saving…</Text>
        )}
        {status === 'idle' && (
          <Text style={styles.statusIdle}>synced to disk</Text>
        )}
        {status === 'error' && (
          <Text style={styles.statusError}>
            error{errorMsg ? `: ${errorMsg}` : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

function ValidationBanner({
  errors,
  onGenerateMissingAgent,
}: {
  errors: ValidationError[];
  /** Quick-fix callback for "agent file not found" warnings. The
   *  banner detects them and renders a ✨ Generate button per missing
   *  agent that calls this with the agent path. */
  onGenerateMissingAgent?: (agentPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const errorCount = errors.filter(e => e.severity === 'error').length;
  const warnCount = errors.length - errorCount;
  function isMissingAgent(e: ValidationError): boolean {
    return /agent file not found/i.test(e.message);
  }
  const missingAgents = errors.filter(isMissingAgent);
  return (
    <View style={styles.validationBanner}>
      <Pressable
        onPress={() => setExpanded(v => !v)}
        style={styles.validationHeader}>
        <Text style={styles.validationTitle}>
          {errorCount > 0 ? '⚠' : 'ⓘ'} Validation:{' '}
          {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
          {warnCount > 0 ? `${errorCount > 0 ? ', ' : ''}${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''}
          {missingAgents.length > 0 && onGenerateMissingAgent
            ? ` · ✨ ${missingAgents.length} agent${missingAgents.length === 1 ? '' : 's'} generatable`
            : ''}
        </Text>
        <Text style={styles.validationToggle}>
          {expanded ? 'hide' : 'show'}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.validationList}>
          {errors.slice(0, 20).map((e, i) => {
            const missing = isMissingAgent(e);
            return (
              <View key={i} style={styles.validationRow}>
                <Text
                  style={[
                    styles.validationSeverity,
                    e.severity === 'warning' && styles.validationSeverityWarn,
                  ]}>
                  {e.severity === 'error' ? 'ERR' : 'WRN'}
                </Text>
                <View style={styles.validationDetails}>
                  <Text style={styles.validationMsg}>{e.message}</Text>
                  <Text style={styles.validationPath}>
                    {e.nodeName ? `[${e.nodeName}] ` : ''}{e.path}
                  </Text>
                </View>
                {missing && onGenerateMissingAgent && (
                  <Pressable
                    onPress={() => onGenerateMissingAgent(e.path)}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      backgroundColor: '#7c3aed',
                      borderRadius: 4,
                      alignSelf: 'flex-start',
                    }}>
                    <Text style={{ fontSize: 10, color: '#ffffff', fontWeight: '700' }}>
                      ✨ Generate
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
          {errors.length > 20 && (
            <Text style={styles.validationOverflow}>
              … and {errors.length - 20} more
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function ModeButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[styles.modeButton, active && styles.modeButtonActive]}>
      <Text
        style={[
          styles.modeButtonText,
          active && styles.modeButtonTextActive,
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

function CreatePipelineModal({
  visible,
  existingNames,
  onClose,
  onCreate,
}: {
  visible: boolean;
  existingNames: Set<string>;
  onClose: () => void;
  onCreate: (name: string, description: string, template: Template | null) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);
  // Type-ahead filter on the template grid — TEMPLATES has 20+ entries
  // and was rendering them all with no search. Filters on name +
  // category + description + tags so any reasonable mental hook
  // (e.g. "research" / "rag" / "review") narrows the list.
  const [templateFilter, setTemplateFilter] = useState('');

  useEffect(() => {
    if (visible) {
      setName('');
      setDescription('');
      setPickedTemplateId(null);
      setTemplateFilter('');
    }
  }, [visible]);

  if (!visible) return null;

  const trimmed = name.trim();
  const conflict = trimmed.length > 0 && existingNames.has(trimmed);
  const canSubmit = trimmed.length > 0 && !conflict;
  const picked = pickedTemplateId
    ? TEMPLATES.find(t => t.id === pickedTemplateId) ?? null
    : null;

  function applyTemplate(t: Template) {
    setPickedTemplateId(t.id);
    if (!name.trim()) setName(uniqueName(t.name, existingNames));
    if (!description.trim()) setDescription(t.description);
  }

  function clearTemplate() {
    setPickedTemplateId(null);
  }

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={[styles.modalPanel, styles.modalPanelWide]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Create pipeline</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.modalClose}>×</Text>
          </Pressable>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="my-flow"
            style={styles.input}
            autoCapitalize="none"
            autoFocus
          />
          {conflict && (
            <Text style={styles.errorText}>
              A pipeline named "{trimmed}" already exists.
            </Text>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What does this pipeline do?"
            style={[styles.input, styles.inputMultiline]}
            multiline
          />
        </View>

        <View style={styles.field}>
          <View style={styles.templateHeader}>
            <Text style={styles.label}>Start from a template</Text>
            {picked && (
              <Pressable onPress={clearTemplate}>
                <Text style={styles.templateClear}>× clear ({picked.name})</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.templateSubtle}>
            Templates ship working multi-phase orchestrations that showcase v2
            features. You can edit anything after creation.
          </Text>
          <TextInput
            value={templateFilter}
            onChangeText={setTemplateFilter}
            placeholder="Filter templates (name, category, tags)…"
            style={styles.templateFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.templateGrid}>
            {(() => {
              // Filter logic: split the query on whitespace into tokens
              // and require each token to appear in the haystack
              // (name + category + description + tags joined). Lets the
              // user combine cues like "support qa" or "rag prod".
              const q = templateFilter.trim().toLowerCase();
              const tokens = q.length > 0 ? q.split(/\s+/) : [];
              const filtered = TEMPLATES.filter(t => {
                if (tokens.length === 0) return true;
                const hay = [
                  t.name,
                  t.category,
                  t.description,
                  ...t.tags,
                ]
                  .join(' ')
                  .toLowerCase();
                return tokens.every(tok => hay.includes(tok));
              });
              if (filtered.length === 0) {
                return (
                  <Text style={styles.templateEmpty}>
                    No templates match "{templateFilter.trim()}". Try a different
                    keyword or clear the filter.
                  </Text>
                );
              }
              return filtered.map(t => (
                <Pressable
                  key={t.id}
                  onPress={() => applyTemplate(t)}
                  style={[
                    styles.templateCard,
                    picked?.id === t.id && styles.templateCardActive,
                  ]}>
                  <View style={styles.templateCardHeader}>
                    <Text style={styles.templateCardName}>{t.name}</Text>
                    <Text style={styles.templateCardCategory}>{t.category}</Text>
                  </View>
                  <Text style={styles.templateCardDesc}>{t.description}</Text>
                  <View style={styles.templateCardTags}>
                    {t.tags.map(tag => (
                      <Text key={tag} style={styles.templateCardTag}>
                        {tag}
                      </Text>
                    ))}
                  </View>
                </Pressable>
              ));
            })()}
          </View>
        </View>

        <View style={styles.modalButtonRow}>
          <Pressable
            onPress={() => canSubmit && onCreate(trimmed, description, picked)}
            disabled={!canSubmit}
            style={[
              styles.button,
              styles.primaryButton,
              !canSubmit && styles.buttonDisabled,
            ]}>
            <Text style={styles.primaryButtonText}>
              {picked ? `Create from "${picked.name}"` : 'Create blank'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function uniqueName(base: string, existing: Set<string>): string {
  // The server persists orchestrations as files and rejects any name
  // that isn't [A-Za-z0-9_-] (isSafeName → 400 "Invalid name"). Slugify
  // first so callers that build a human-ish base (e.g. "<orig>
  // (improved)") still produce a server-safe name. Spaces / parens /
  // other punctuation collapse to single dashes.
  const slug =
    base
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'orchestration';
  if (!existing.has(slug)) return slug;
  let i = 2;
  while (existing.has(`${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

const styles = StyleSheet.create({
  // minHeight:0 lets the inner scroll areas bound themselves to the viewport
  // instead of growing the whole document (which caused a blank scroll region
  // below the page when the pipeline canvas was tall).
  container: { flex: 1, minHeight: 0 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dim: { color: '#6b7280', fontSize: 13 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusSaving: { fontSize: 11, color: '#2563eb' },
  statusIdle: { fontSize: 11, color: '#059669' },
  statusError: { fontSize: 11, color: '#dc2626', maxWidth: 400 },

  chipStripScroll: { flexGrow: 0 },
  chipStrip: {
    paddingHorizontal: 24,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  chipActive: { backgroundColor: '#111827', borderColor: '#111827' },
  chipText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  chipTextActive: { color: '#ffffff' },
  chipAdd: {
    borderStyle: 'dashed',
    borderColor: '#9ca3af',
    backgroundColor: '#f3f4f6',
  },
  chipAddText: { fontSize: 12, color: '#6b7280', fontWeight: '600' },

  pageRow: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 0,
  },
  sidebar: {
    width: 240,
    borderRightWidth: 1,
    borderRightColor: '#e5e7eb',
    backgroundColor: '#fafafa',
    paddingTop: 12,
  },
  // Thin draggable divider sitting on the sidebar's right edge. 8px hit area
  // straddling the border; the col-resize cursor signals it's draggable.
  sidebarResizer: {
    width: 8,
    marginLeft: -4,
    backgroundColor: 'transparent',
    zIndex: 5,
    // RNW renders `cursor` from style onto the DOM node.
    cursor: 'col-resize',
  } as object,
  // Collapsed sidebar: a thin rail with just an expand button.
  sidebarRail: {
    width: 32,
    borderRightWidth: 1,
    borderRightColor: '#e5e7eb',
    backgroundColor: '#fafafa',
    paddingTop: 12,
    alignItems: 'center',
  },
  sidebarRailBtn: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  sidebarToggleText: { fontSize: 12, color: '#6b7280', fontWeight: '700' },
  sidebarHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginBottom: 8,
  },
  sidebarHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sidebarCollapseBtn: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  sidebarSearch: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    fontSize: 12,
    color: '#111827',
  },
  sidebarListScroll: { flex: 1 },
  sidebarList: {
    paddingHorizontal: 8,
    paddingBottom: 12,
    gap: 2,
  },
  sidebarEmptyText: {
    fontSize: 11,
    color: '#9ca3af',
    fontStyle: 'italic',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sidebarItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: 'transparent',
    // 3px transparent border on every row so selecting one (which adds a
    // blue border) doesn't shift the layout.
    borderWidth: 3,
    borderColor: 'transparent',
  },
  sidebarItemActive: { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
  sidebarItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  sidebarItemText: { fontSize: 13, color: '#374151', fontWeight: '500', flexShrink: 1 },
  sidebarItemTextActive: { color: '#1d4ed8', fontWeight: '700' },
  // "running" badge — a spinning ⟳ + word on the orchestration that's live.
  runningBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  runningSpinner: { fontSize: 11, color: '#2563eb', fontWeight: '700' },
  runningBadgeText: { fontSize: 10, color: '#2563eb', fontWeight: '600' },
  // "default" badge on shipped example pipelines. Muted grey on the
  // resting row; on the dark active row it flips to a lighter chip so it
  // stays legible against #111827.
  defaultPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: '#e5e7eb',
    flexShrink: 0,
  },
  defaultPillActive: { backgroundColor: '#dbeafe' },
  defaultPillText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  defaultPillTextActive: { color: '#1d4ed8' },
  // Structural-complexity badge — an outlined chip whose border + text take the
  // tier color (grey→green→cyan→amber→red). Outlined (not filled) so it reads
  // as a metric, not a status. Compact form sits on every sidebar row; the
  // full form sits on the detail line.
  // The Tooltip wrapper (Pressable) around the badge — purely a hover-target;
  // it must not change the badge's layout, so it stays out of the flex flow's
  // shrink the same way the badge does.
  complexityBadgeWrap: { flexShrink: 0 },
  complexityBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: 'transparent',
    flexShrink: 0,
  },
  complexityBadgeActive: { backgroundColor: '#ffffff' },
  complexityBadgeText: { fontSize: 9, fontWeight: '700' },
  // "🔗 N" badge on a row that nests N sub-orchestrations (subflow refs).
  // Indigo-tinted to read as a relationship marker, distinct from the grey
  // "default" chip; lifts to a lighter chip on the active row.
  nestedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: '#e0e7ff',
    flexShrink: 0,
  },
  nestedPillActive: { backgroundColor: '#dbeafe' },
  nestedPillText: { fontSize: 9, fontWeight: '700', color: '#4338ca' },
  nestedPillTextActive: { color: '#1d4ed8' },
  // "⚡ N" badge on a row that declares N triggers (reactive). Amber-tinted to
  // read as an "energized / event-driven" marker, distinct from the indigo
  // nested 🔗 and the grey default chip.
  triggerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: '#fef3c7',
    flexShrink: 0,
  },
  triggerPillActive: { backgroundColor: '#fde68a' },
  triggerPillText: { fontSize: 9, fontWeight: '700', color: '#b45309' },
  triggerPillTextActive: { color: '#92400e' },
  // Attribute filter toggles (rounded pills) — Nested + run-status — on one
  // row. Rounded = on/off toggle (none active = unfiltered), vs. the
  // rectangular All/Mine/Defaults source segments which pick exactly one. That
  // visual split is why there's no second "All" here.
  attrFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 10,
  },
  attrPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: '#f3f4f6',
  },
  attrPillText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  // Nested = indigo (matches the per-row 🔗 badge).
  attrPillNestedActive: { backgroundColor: '#eef2ff', borderColor: '#4f46e5' },
  attrPillNestedText: { color: '#4338ca', fontWeight: '700' },
  // Triggers = amber (matches the per-row ⚡ badge). The ⚡ icon + "Triggers"
  // label keep it distinct from the amber paused-status pill in the same row.
  attrPillTriggersActive: { backgroundColor: '#fffbeb', borderColor: '#f59e0b' },
  attrPillTriggersText: { color: '#b45309', fontWeight: '700' },
  // Tags = teal — distinct from the indigo Nested + amber Triggers pills.
  attrPillTagActive: { backgroundColor: '#f0fdfa', borderColor: '#0d9488' },
  attrPillTagText: { color: '#0f766e', fontWeight: '700' },
  // Status actives, colored by meaning so they read at a glance.
  attrPillRunningActive: { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
  attrPillRunningText: { color: '#1d4ed8', fontWeight: '700' },
  attrPillPausedActive: { backgroundColor: '#fffbeb', borderColor: '#f59e0b' },
  attrPillPausedText: { color: '#b45309', fontWeight: '700' },
  attrPillSuccessActive: { backgroundColor: '#ecfdf5', borderColor: '#059669' },
  attrPillSuccessText: { color: '#047857', fontWeight: '700' },
  attrPillFailedActive: { backgroundColor: '#fef2f2', borderColor: '#dc2626' },
  attrPillFailedText: { color: '#b91c1c', fontWeight: '700' },
  // Per-row run-status light + its left-group wrapper (dot sits left of the
  // name; badges stay pinned right via the row's space-between).
  pipelineStatusDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  sidebarItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  // All / Mine / Defaults segmented filter above the sidebar list.
  // Matches the sidebar's monochrome palette (dark active accent).
  pipelineFilterRow: {
    flexDirection: 'row',
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 10,
  },
  pipelineFilterSeg: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 6,
    // 3px transparent border on rest so the selected blue border doesn't
    // change the segment's size.
    borderWidth: 3,
    borderColor: 'transparent',
    backgroundColor: '#f3f4f6',
  },
  pipelineFilterSegActive: { backgroundColor: '#eff6ff', borderColor: '#2563eb' },
  pipelineFilterSegText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  pipelineFilterSegTextActive: { color: '#1d4ed8', fontWeight: '700' },
  sidebarActions: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
  },
  sidebarAction: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  sidebarActionText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  // "+ New" button + its upward popover (replaces the 4 stacked actions).
  newMenuAnchor: { position: 'relative' },
  newButton: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 6,
    backgroundColor: '#2563eb',
    alignItems: 'center',
  },
  newButtonText: { fontSize: 12, color: '#ffffff', fontWeight: '700' },
  newMenuBackdrop: {
    position: 'absolute',
    top: -2000,
    left: -2000,
    right: -2000,
    bottom: -2000,
    backgroundColor: 'transparent',
  },
  newMenu: {
    position: 'absolute',
    bottom: 42,
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 1000,
  },
  newMenuItem: { paddingHorizontal: 12, paddingVertical: 8 },
  newMenuItemText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  pageMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },

  // position+zIndex so the ⋮ overflow popover (absolutely positioned inside
  // this toolbar) paints ABOVE the pipeline/graph body, which is a later
  // sibling. Without this the menu rendered behind the canvas cards.
  activeMeta: {
    paddingHorizontal: 24,
    paddingTop: 8,
    position: 'relative',
    // Sit the whole header (and its ⋮ dropdown) above the editor canvas
    // that follows it in the layout.
    zIndex: 100,
  },
  activeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    // The ⋮ overflow menu is an absolutely-positioned child of this row and
    // drops down OVER the description / validation / budget banners that
    // follow it inside activeMeta. Make the row its own raised stacking
    // context so the menu paints above those later siblings instead of being
    // overlapped by them (the empty-gray-box / collision bug).
    position: 'relative',
    zIndex: 20,
  },
  activeName: { fontSize: 16, fontWeight: '600', color: '#111827', flex: 1 },
  activeDescription: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  // Collapsible description: a chevron toggles between full text and a single
  // truncated line so a long description doesn't dominate the header.
  descRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 2,
  },
  descChevron: { fontSize: 11, color: '#9ca3af', marginTop: 1, fontWeight: '700' },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  undoButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  undoButtonDisabled: {
    opacity: 0.45,
  },
  undoButtonText: {
    fontSize: 11,
    color: '#374151',
    fontWeight: '600',
  },
  // ─── Overflow menu (⋮) — collapses 6 of the 10 toolbar actions ───
  overflowAnchor: {
    position: 'relative',
  },
  overflowButtonActive: {
    backgroundColor: '#f3f4f6',
    borderColor: '#9ca3af',
  },
  overflowBackdrop: {
    // Covers the viewport so a click anywhere outside the menu
    // dismisses it. Z-order is below the menu itself.
    position: 'absolute',
    top: -1000,
    left: -2000,
    right: -2000,
    bottom: -1000,
    backgroundColor: 'transparent',
  },
  overflowMenu: {
    position: 'absolute',
    top: 28,
    right: 0,
    minWidth: 180,
    backgroundColor: '#ffffff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingVertical: 4,
    // Subtle drop shadow so the menu reads as elevated.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 1000,
  },
  overflowItem: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  overflowItemText: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '500',
  },
  overflowDivider: {
    height: 1,
    backgroundColor: '#e5e7eb',
    marginVertical: 4,
  },
  overflowItemDanger: {},
  overflowItemDangerText: { color: '#b91c1c' },
  overflowItemDangerActive: { backgroundColor: '#fef2f2' },
  overflowItemDangerTextActive: { color: '#991b1b', fontWeight: '700' },
  runButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#059669',
    borderWidth: 1,
    borderColor: '#059669',
  },
  runButtonDisabled: {
    backgroundColor: '#9ca3af',
    borderColor: '#9ca3af',
  },
  runButtonText: {
    fontSize: 12,
    color: '#ffffff',
    fontWeight: '700',
  },
  runErrorText: {
    fontSize: 11,
    color: '#dc2626',
    marginTop: 4,
  },
  validationBanner: {
    marginTop: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fbbf24',
    backgroundColor: '#fffbeb',
  },
  validationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  validationToggle: { fontSize: 11, color: '#92400e' },
  validationList: {
    borderTopWidth: 1,
    borderTopColor: '#fde68a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
  },
  validationRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  validationSeverity: {
    fontSize: 10,
    fontWeight: '700',
    color: '#b91c1c',
    backgroundColor: '#fee2e2',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    fontFamily: 'Menlo',
  },
  validationSeverityWarn: { color: '#92400e', backgroundColor: '#fef3c7' },
  previewSeverityInfo: { color: '#1e40af', backgroundColor: '#dbeafe' },
  validationDetails: { flex: 1 },
  validationMsg: { fontSize: 11, color: '#1f2937' },
  validationPath: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
  validationOverflow: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
  activeStats: { fontSize: 11, color: '#6b7280', fontFamily: 'Menlo' },
  budgetBanner: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 6,
  },
  budgetBannerBlocked: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  budgetBannerText: { fontSize: 12, color: '#92400e', fontWeight: '600' },
  deleteButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteButtonConfirm: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  deleteButtonText: { fontSize: 11, color: '#b91c1c', fontWeight: '600' },
  deleteButtonTextConfirm: { color: '#ffffff' },

  // Destructive/secondary footer action (e.g. "Overwrite original"): a warning
  // outline by default, solid red once armed for confirmation.
  dangerButton: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  dangerButtonArmed: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  dangerButtonText: { color: '#b91c1c', fontWeight: '600', fontSize: 14 },
  dangerButtonTextArmed: { color: '#ffffff' },

  modeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  modeButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  modeButtonActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  modeButtonText: { fontSize: 12, color: '#374151', fontWeight: '500' },
  modeButtonTextActive: { color: '#ffffff' },

  body: { flex: 1, minHeight: 0 },
  treeScroll: { padding: 24 },
  treeCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  code: {
    fontFamily: 'Menlo',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    borderRadius: 3,
  },

  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.5)',
  },
  modalPanel: {
    width: '90%',
    maxWidth: 480,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    overflow: 'hidden',
  },
  modalPanelWide: { maxWidth: 760, maxHeight: '90%' },
  previewPanel: { width: '92%', maxWidth: 1000, maxHeight: '92%' },
  dropZone: {
    position: 'relative',
    minHeight: 200,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    borderRadius: 12,
    backgroundColor: '#f8fafc',
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  dropZoneActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  dropZoneText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 6,
  },
  dropZoneHint: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
  },
  matchList: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    backgroundColor: '#f9fafb',
    marginTop: 4,
  },
  structurePreview: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    backgroundColor: '#f9fafb',
    marginTop: 4,
    paddingVertical: 6,
  },
  structureRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: 3,
    paddingRight: 8,
    gap: 6,
  },
  structurePrefix: {
    fontSize: 11,
    color: '#2563eb',
    fontFamily: 'Menlo',
    minWidth: 18,
    fontWeight: '600',
  },
  structureName: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '500',
  },
  structureMeta: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'Menlo',
  },
  structureOverflow: {
    fontSize: 11,
    color: '#9ca3af',
    fontStyle: 'italic',
    paddingHorizontal: 10,
    paddingTop: 4,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    gap: 8,
  },
  matchDot: {
    fontSize: 14,
    fontWeight: '700',
    minWidth: 14,
  },
  matchPhase: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '600',
  },
  matchDeclared: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'Menlo',
    fontWeight: '400',
  },
  matchTarget: {
    fontSize: 11,
    color: '#059669',
    fontFamily: 'Menlo',
    marginTop: 2,
  },
  matchSource: {
    fontSize: 10,
    color: '#6b7280',
    fontStyle: 'italic',
  },
  matchMissing: {
    fontSize: 11,
    color: '#dc2626',
    marginTop: 2,
    fontStyle: 'italic',
  },
  hint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
    marginBottom: 6,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  modalPrimary: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#2563eb',
  },
  modalPrimaryText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  modalCancel: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  modalCancelText: { color: '#374151', fontWeight: '500', fontSize: 13 },
  validationTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400e',
    marginBottom: 4,
  },
  validationText: {
    fontSize: 11,
    color: '#92400e',
    fontFamily: 'Menlo',
  },
  templateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  templateClear: { fontSize: 11, color: '#6b7280' },
  templateSubtle: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 8,
    marginTop: -2,
  },
  templateFilter: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
    marginBottom: 10,
  },
  templateEmpty: {
    fontSize: 12,
    color: '#6b7280',
    fontStyle: 'italic',
    padding: 16,
    width: '100%',
    textAlign: 'center',
  },
  templateGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  templateCard: {
    width: '48%',
    padding: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  templateCardActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  templateCardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  templateCardName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  templateCardCategory: {
    fontSize: 10,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  templateCardDesc: {
    fontSize: 11,
    color: '#374151',
    lineHeight: 15,
  },
  templateCardTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  templateCardTag: {
    fontSize: 9,
    fontFamily: 'Menlo',
    color: '#6b7280',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  modalClose: {
    fontSize: 24,
    color: '#6b7280',
    paddingHorizontal: 8,
    lineHeight: 24,
  },
  field: { gap: 4, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '600', color: '#374151' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  errorText: { fontSize: 11, color: '#dc2626', marginTop: 2 },
  modalButtonRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 6 },
  primaryButton: { backgroundColor: '#2563eb' },
  primaryButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
  buttonDisabled: { opacity: 0.5 },
  // ─── Improve modal: per-item checkbox + steer-history chips ───
  improveCheckbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#9ca3af',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  improveCheckboxOn: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  improveCheckboxTick: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  steerChip: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: 320,
  },
  steerChipText: { fontSize: 11, color: '#4b5563' },
});
