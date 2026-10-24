import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAuthoringGuide, listAgents, type AgentFile } from '../api';
import { streamAnthropic } from '../llm/anthropic';
import { streamClaudeCode } from '../llm/claude-code';
import { getApiKey, getAuthMode, getModel } from './apiKey';
import type { Node } from '../types';
import { validateOrchestration, type ValidationError } from '../validate';
import { useToast } from './toast';

/**
 * Client-side background "Improve orchestration" jobs.
 *
 * The critique + revised-orchestration generation lives HERE, at the app root,
 * rather than in the modal that shows it: streamed from the modal's own
 * useEffect, closing the modal would cancel the work. A job keeps running
 * after the modal closes, and the modal is a pure VIEWER of job state.
 *
 * CLIENT-SIDE v1: jobs live in React state on the app root. They survive
 * in-app navigation (the provider is mounted above the page router) but NOT a
 * full browser reload — there's no server persistence. That's the intended v1
 * scope; promoting these to server-owned jobs would mirror the run-store SSE
 * path and is out of scope here.
 */

export type ImproveStatus = 'running' | 'done' | 'error';

/** Status of the on-demand REVISE (second) pass — the designer turning the
 *  user-approved subset of suggestions into a revised orchestration. Separate
 *  from the critique `status` because the revise runs lazily (on Preview /
 *  Apply with the checked items) rather than eagerly after the critique. */
export type ReviseStatus = 'idle' | 'running' | 'done' | 'error';

/** One discrete, user-approvable improvement parsed out of the critique
 *  markdown — a single `- **title** — detail` bullet under a `## section`
 *  heading. The modal renders one checkbox per item and feeds the CHECKED
 *  subset to the revise pass. */
export type ImproveItem = {
  /** Stable within a single critique (section index + bullet index). */
  id: string;
  /** The `## ` heading the bullet lives under (e.g. "Cost / budget"). */
  section: string;
  /** The bullet's lead phrase — the bold `**…**` part, or the first
   *  sentence/clause when the bullet isn't bolded. */
  title: string;
  /** The remainder of the bullet after the title (the "why"); may be ''. */
  detail: string;
  /** Whether the user has this improvement checked. Defaults to true. */
  selected: boolean;
};

export type ImproveJob = {
  id: string;
  orchestrationName: string;
  status: ImproveStatus;
  /** The streamed critique markdown (grows while running). */
  critique: string;
  /** Status of the lazy revise (designer) pass — see ReviseStatus. */
  reviseStatus: ReviseStatus;
  /** The parsed revised orchestration, or null until a revise pass lands. */
  revised: Node | null;
  /** Schema-validation findings for `revised` (empty until parsed). */
  revErrors: ValidationError[];
  /** Terminal error message (critique pass), or null. */
  error: string | null;
  /** Terminal error message from the most recent revise pass, or null. */
  reviseError: string | null;
  /** Steer messages the user has submitted (oldest first) to re-run the
   *  critique with extra guidance — shown as a small history strip. */
  steers: string[];
  startedAt: number;
  finishedAt?: number;
};

/**
 * Parse the orchestration-improver's critique markdown into discrete,
 * user-approvable {@link ImproveItem}s — one per recommendation bullet,
 * preserving the `## section` grouping.
 *
 * The critique shape (see agents/orchestration-improver.md) is:
 *
 *   ## Risks / missing safety
 *   - **Add `lock: true` on `publish`** — it has an irreversible side effect
 *   - **Wrap `qa` with `retry: { times: 2 }`** — the sim drops connections
 *
 *   ## Cost / budget
 *   - **Add `budget` on the `explore` loop** — it can iterate unbounded
 *
 * Each `- ` / `* ` bullet under a heading becomes one item; the bold `**…**`
 * lead phrase is the `title` and the rest (after an optional `—`/`-`/`:`
 * separator) is the `detail`. Bullets that aren't bolded still parse — the
 * first clause becomes the title.
 *
 * Robust to the real markdown: tolerates `#`–`######` headings, `-`/`*`
 * bullets, CRLF, blank lines, and leading indentation. Bullets that appear
 * BEFORE any heading are grouped under a generic "Improvements" section so
 * nothing is dropped. Returns `[]` when no bullets are found, so the caller
 * can fall back to rendering the raw critique.
 */
export function parseCritiqueItems(critique: string): ImproveItem[] {
  if (!critique) return [];
  const lines = critique.replace(/\r\n/g, '\n').split('\n');
  const items: ImproveItem[] = [];
  let section = 'Improvements';
  let sectionIdx = -1; // -1 until the first heading; bumps the id namespace
  let bulletIdx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = heading[1].replace(/\*\*/g, '').trim() || section;
      sectionIdx += 1;
      bulletIdx = 0;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) continue; // ignore prose / code-fence lines between bullets
    const body = bullet[1].trim();
    if (!body) continue;
    let title = body;
    let detail = '';
    const bold = body.match(/^\*\*(.+?)\*\*(.*)$/);
    if (bold) {
      title = bold[1].trim();
      // Strip a leading em-dash / hyphen / colon separator off the "why".
      detail = bold[2].replace(/^\s*[—–:-]\s*/, '').trim();
    } else {
      // Unbolded bullet: split on the first em-dash / " - " / ": " separator
      // so we still get a title + detail; otherwise the whole line is title.
      const sep = body.match(/^(.+?)\s*(?:—|–|:|\s-\s)\s*(.*)$/);
      if (sep && sep[2].trim()) {
        title = sep[1].trim();
        detail = sep[2].trim();
      }
    }
    items.push({
      id: `${sectionIdx < 0 ? 'pre' : sectionIdx}-${bulletIdx}`,
      section,
      title,
      detail,
      selected: true,
    });
    bulletIdx += 1;
  }
  return items;
}

/**
 * Build the instruction set the designer (revise) pass receives, from ONLY the
 * items the user checked. Replaces feeding the whole critique to the second
 * meta-agent — so "Overwrite" / "Save as new" apply exactly the approved
 * subset, not every suggestion the critique raised.
 *
 * Output is grouped markdown (section headings + the checked bullets under
 * each) so it reads to the designer like a focused, pre-filtered critique.
 * Returns `''` when nothing is selected (callers must gate apply on that).
 */
export function buildSelectedInstruction(items: ImproveItem[]): string {
  const selected = items.filter(i => i.selected);
  if (selected.length === 0) return '';
  const bySection = new Map<string, ImproveItem[]>();
  for (const it of selected) {
    const arr = bySection.get(it.section) ?? [];
    arr.push(it);
    bySection.set(it.section, arr);
  }
  const blocks: string[] = [];
  for (const [section, group] of bySection) {
    const bullets = group
      .map(it => `- **${it.title}**${it.detail ? ` — ${it.detail}` : ''}`)
      .join('\n');
    blocks.push(`## ${section}\n${bullets}`);
  }
  return blocks.join('\n\n');
}

type Ctx = {
  /** All jobs, newest first. */
  jobs: ImproveJob[];
  /** Start (or restart) an improve job for an orchestration. Runs the critique
   *  pass ASYNC inside the store so it survives modal close. The revise
   *  (designer) pass is NOT run here — it runs on demand via `reviseSelected`
   *  with the user-checked subset. Pass `steerText` to fold extra guidance
   *  into the critique meta-agent prompt (used by the steer chat line + the
   *  re-run button). Returns the new job id. */
  startImproveJob: (orchestration: Node, steerText?: string) => string;
  /** Run the REVISE (designer) pass for an orchestration's current critique,
   *  applying ONLY the supplied (already-filtered to selected) instruction
   *  set. Stores the parsed `revised` + `revErrors` on the job and resolves to
   *  the revised Node (or null on failure — see the job's `reviseError`).
   *  No-ops to null when there's no done critique job to revise. */
  reviseSelected: (
    orchestration: Node,
    instruction: string,
  ) => Promise<Node | null>;
  /** Imperative lookup of the latest job for a name (non-reactive). For the
   *  reactive form use the `useImproveJob` hook exported below. */
  getJob: (orchestrationName: string) => ImproveJob | null;
};

const ImproveJobsContext = createContext<Ctx | null>(null);

/** Event name + tiny bus so the completion toast (fired from the store, which
 *  has no UI handle) can ask PipelinesPage to open the Improve modal for an
 *  orchestration. Web-only DOM CustomEvent; no-op where `window` is absent
 *  (native), which is fine — the toast just won't deep-link there. */
export const OPEN_IMPROVE_EVENT = 'sammy:open-improve';

export function emitOpenImprove(orchestrationName: string): void {
  const w = globalThis as {
    dispatchEvent?: (e: Event) => boolean;
    CustomEvent?: typeof CustomEvent;
  };
  if (w.dispatchEvent && w.CustomEvent) {
    w.dispatchEvent(new w.CustomEvent(OPEN_IMPROVE_EVENT, { detail: orchestrationName }));
  }
}

/** Subscribe to open-improve requests. Returns an unsubscribe fn. */
export function onOpenImprove(cb: (orchestrationName: string) => void): () => void {
  const w = globalThis as {
    addEventListener?: (t: string, l: (e: Event) => void) => void;
    removeEventListener?: (t: string, l: (e: Event) => void) => void;
  };
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const handler = (e: Event) => {
    const name = (e as CustomEvent<string>).detail;
    if (typeof name === 'string') cb(name);
  };
  w.addEventListener(OPEN_IMPROVE_EVENT, handler);
  return () => w.removeEventListener!(OPEN_IMPROVE_EVENT, handler);
}

/** Strip the agent's YAML frontmatter, returning the prompt body. */
function agentBody(agent: AgentFile): string {
  const m = agent.raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : agent.raw).trim();
}

/** Append the framework's orchestration-authoring guide to a meta-agent's
 *  system prompt as an authoritative reference, so the critique it produces
 *  (and the revision the designer derives from it) follow our conventions —
 *  the token economy, failure semantics, determinism-over-model, concurrency,
 *  resumability, and governance principles in docs/AUTHORING_ORCHESTRATIONS.md.
 *  No-ops (returns the prompt unchanged) when the guide couldn't be fetched, so
 *  Improve still works without it — the guide enriches, it isn't required. */
function withAuthoringGuide(system: string, guide: string | null): string {
  if (!guide) return system;
  return (
    `${system}\n\n` +
    `# Authoring guidelines (apply these)\n\n` +
    `The following is the project's orchestration-authoring guide. Treat its\n` +
    `design & reliability principles as the conventions your output MUST\n` +
    `follow — prefer its recommended patterns (decompose long agents, bound\n` +
    `loops, deterministic \`code\`/\`switch\` over model-in-the-loop where the\n` +
    `path is known, fail soft per-leaf, preflight external deps, idempotent\n` +
    `side effects, isolate parallel blast radius). When a suggestion or a\n` +
    `revision conflicts with this guide, defer to the guide.\n\n` +
    `---\n\n${guide}`
  );
}

/** Build the "- agents/x.md — <description>" list the designer/improver
 *  prompts expect for {{AVAILABLE_AGENTS}}, excluding the meta-agents. */
function agentListing(agents: AgentFile[], exclude: Set<string>): string {
  return agents
    .filter(a => !exclude.has(a.name))
    .map(a => {
      const fm = a.raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const desc = fm?.[1].match(/^description:\s*(.+?)$/m)?.[1]?.trim() ?? '';
      return `- agents/${a.name}.md — ${desc}`;
    })
    .join('\n');
}

export function ImproveJobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ImproveJob[]>([]);
  const toast = useToast();
  // Latest toast fn in a ref so the async runner closure (created once per
  // startImproveJob) always notifies via the current provider value.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // Latest jobs in a ref so the action callbacks (memoized once) can read the
  // current job list — to carry steer history forward across re-runs and to
  // find the critique a revise pass should apply against — without making
  // those callbacks depend on `jobs` (which would re-create them each render).
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const patchJob = useCallback((id: string, patch: Partial<ImproveJob>) => {
    setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const startImproveJob = useCallback(
    (orchestration: Node, steerText?: string): string => {
      const id = `improve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const steer = steerText?.trim() ?? '';
      // Preserve the steer history across re-runs so the modal's history strip
      // accumulates: carry the PRIOR job's steers, then append this one.
      const prior = jobsRef.current.find(
        j => j.orchestrationName === orchestration.name,
      );
      const steers = steer
        ? [...(prior?.steers ?? []), steer]
        : prior?.steers ?? [];
      const job: ImproveJob = {
        id,
        orchestrationName: orchestration.name,
        status: 'running',
        critique: '',
        reviseStatus: 'idle',
        revised: null,
        revErrors: [],
        error: null,
        reviseError: null,
        steers,
        startedAt: Date.now(),
      };
      // Drop any prior job for this orchestration so `useImproveJob` always
      // resolves to the freshest one (and the list doesn't accrete dupes).
      setJobs(prev => [job, ...prev.filter(j => j.orchestrationName !== orchestration.name)]);

      const fail = (msg: string) => {
        patchJob(id, { status: 'error', error: msg, finishedAt: Date.now() });
      };

      (async () => {
        const authMode = getAuthMode();
        const apiKey = getApiKey() ?? '';
        if (authMode === 'direct-api-key' && !apiKey) {
          fail('No API key configured.');
          return;
        }
        const model = getModel();
        const streamFn =
          authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
        try {
          // Fetch the agent registry + the authoring guide together. The guide
          // is injected into BOTH meta-agent prompts so the critique and the
          // revision it drives follow the framework's conventions. A failed
          // guide fetch resolves to null (getAuthoringGuide swallows errors) —
          // Improve degrades to the un-guided behavior rather than failing.
          const [agents, authoringGuide] = await Promise.all([
            listAgents(),
            getAuthoringGuide(),
          ]);

          // ── First pass: the critique. ──
          const improver = agents.find(a => a.name === 'orchestration-improver');
          if (!improver) {
            fail('Missing agents/orchestration-improver.md');
            return;
          }
          const improverExclude = new Set([
            'orchestration-improver',
            'orchestration-explainer',
            'orchestration-designer',
            'agent-designer',
            'dataset-row-designer',
          ]);
          const improverSystem = withAuthoringGuide(
            agentBody(improver).replace(
              '{{AVAILABLE_AGENTS}}',
              agentListing(agents, improverExclude) || '(none)',
            ),
            authoringGuide,
          );
          // Fold the user's steer (if any) into the critique prompt so the
          // re-proposal is guided by what they asked for. We pass the WHOLE
          // accumulated steer history so a follow-up steer builds on prior
          // ones rather than dropping them.
          const steerBlock = steers.length
            ? `\n\n# REVIEWER GUIDANCE (from the user — prioritize these)\n\n${steers
                .map(s => `- ${s}`)
                .join('\n')}\n`
            : '';
          let critique = '';
          for await (const ev of streamFn({
            apiKey,
            model,
            system: improverSystem,
            messages: [
              {
                role: 'user',
                content: `# ORCHESTRATION\n\n\`\`\`json\n${JSON.stringify(orchestration, null, 2)}\n\`\`\`\n${steerBlock}\nReview it now.`,
              },
            ],
          })) {
            if (ev.type === 'text-delta') {
              critique += ev.text;
              patchJob(id, { critique });
            }
          }

          // The critique IS the deliverable now. The REVISE (designer) pass no
          // longer runs eagerly here — it runs on demand via `reviseSelected`
          // with only the items the user checks, so "Apply" reflects their
          // approved subset rather than the whole critique. Mark done.
          patchJob(id, { status: 'done', critique, finishedAt: Date.now() });
          // Completion notification — clicking it opens the Improve modal for
          // this orchestration. The store has no access to the page's
          // modal-open state, so the click dispatches a global event that
          // PipelinesPage listens for (see OPEN_IMPROVE_EVENT below).
          toastRef.current.show(
            `🛠 Improvements ready for "${orchestration.name}"`,
            'success',
            { onPress: () => emitOpenImprove(orchestration.name) },
          );
        } catch (err) {
          fail((err as Error).message);
        }
      })();

      return id;
    },
    [patchJob],
  );

  /**
   * Run the designer (revise) pass on demand for the orchestration's current
   * critique, applying ONLY the supplied instruction set (the checked subset,
   * already formatted by {@link buildSelectedInstruction}). Same JSON-output
   * discipline as the critique pass, but (a) lazy and (b) scoped to the
   * user-approved items. Persists `revised` + `revErrors`
   * (and `reviseStatus` / `reviseError`) on the live job and returns the node.
   */
  const reviseSelected = useCallback(
    async (orchestration: Node, instruction: string): Promise<Node | null> => {
      const target = jobsRef.current.find(
        j => j.orchestrationName === orchestration.name,
      );
      if (!target) return null;
      const id = target.id;
      const failRevise = (msg: string): null => {
        patchJob(id, { reviseStatus: 'error', reviseError: msg });
        return null;
      };
      if (!instruction.trim()) {
        return failRevise('No improvements selected to apply.');
      }
      const authMode = getAuthMode();
      const apiKey = getApiKey() ?? '';
      if (authMode === 'direct-api-key' && !apiKey) {
        return failRevise('No API key configured.');
      }
      const model = getModel();
      const streamFn =
        authMode === 'claude-code-proxy' ? streamClaudeCode : streamAnthropic;
      patchJob(id, { reviseStatus: 'running', reviseError: null });
      try {
        const [agents, authoringGuide] = await Promise.all([
          listAgents(),
          getAuthoringGuide(),
        ]);
        const designer = agents.find(a => a.name === 'orchestration-designer');
        if (!designer) {
          return failRevise('Missing agents/orchestration-designer.md');
        }
        const designerSystem = withAuthoringGuide(
          agentBody(designer).replace(
            '{{AVAILABLE_AGENTS}}',
            agentListing(agents, new Set(['orchestration-designer'])) || '(none)',
          ),
          authoringGuide,
        );
        let raw = '';
        for await (const ev of streamFn({
          apiKey,
          model,
          system: designerSystem,
          messages: [
            {
              role: 'user',
              // Feed ONLY the approved suggestions (as "# IMPROVEMENTS TO
              // APPLY"), and tell the designer to apply EXACTLY those and
              // leave everything else unchanged — so unchecked suggestions
              // don't leak into the revision.
              content: `# CURRENT ORCHESTRATION\n\n\`\`\`json\n${JSON.stringify(orchestration, null, 2)}\n\`\`\`\n\n# IMPROVEMENTS TO APPLY\n\n${instruction}\n\nApply EXACTLY the improvements listed above and nothing else — leave all other aspects of the orchestration unchanged. Output the REVISED orchestration JSON only.`,
            },
          ],
        })) {
          if (ev.type === 'text-delta') raw += ev.text;
        }
        const cleaned = raw
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/i, '');
        let revised: Node;
        try {
          revised = JSON.parse(cleaned) as Node;
        } catch (err) {
          return failRevise(
            `Revised output wasn't valid JSON (${(err as Error).message}).`,
          );
        }
        const revErrors = validateOrchestration(revised);
        patchJob(id, { reviseStatus: 'done', revised, revErrors, reviseError: null });
        return revised;
      } catch (err) {
        return failRevise((err as Error).message);
      }
    },
    [patchJob],
  );

  const getJob = useCallback(
    (orchestrationName: string): ImproveJob | null =>
      jobs.find(j => j.orchestrationName === orchestrationName) ?? null,
    [jobs],
  );

  const value = useMemo<Ctx>(
    () => ({ jobs, startImproveJob, reviseSelected, getJob }),
    [jobs, startImproveJob, reviseSelected, getJob],
  );

  return (
    <ImproveJobsContext.Provider value={value}>
      {children}
    </ImproveJobsContext.Provider>
  );
}

export function useImproveJobs(): Ctx {
  const ctx = useContext(ImproveJobsContext);
  if (!ctx)
    throw new Error('useImproveJobs must be used within ImproveJobsProvider');
  return ctx;
}

/** Reactive single-job lookup by orchestration name. Thin wrapper over the
 *  context's `jobs` so the modal re-renders as its job streams. */
export function useImproveJob(
  orchestrationName: string | null | undefined,
): ImproveJob | null {
  const { jobs } = useImproveJobs();
  return useMemo(
    () =>
      orchestrationName
        ? jobs.find(j => j.orchestrationName === orchestrationName) ?? null
        : null,
    [jobs, orchestrationName],
  );
}
