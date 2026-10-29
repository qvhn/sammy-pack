/**
 * Harness mode — the pure half.
 *
 * In harness mode ONE agent works through an orchestration as a list of steps
 * and does each step itself (with the skill the step names, or by doing the
 * step's task), instead of the engine giving every agent step its own agent.
 * The engine stays the referee: it runs the script / HTTP / wait steps exactly
 * as written, holds the gates, checkpoints every finished step, and decides
 * whether the run is complete.
 *
 * This module has no I/O and no SDK dependency (it is in the browser bundle's
 * import graph through the executor): it turns a tree into steps, resolves
 * how strictly they must be followed, and tracks each step's status. The
 * executor wires it to the agent (runHarness in executor.ts).
 */

import type { HarnessFollow, Node } from '../types';

/** What a step asks of the harness.
 *   - `task`   — an agent step: the harness does it itself, guided by the
 *                step's agent file and prompt.
 *   - `skill`  — the harness runs the named skill to do it.
 *   - `engine` — the engine runs it exactly as written (code / http / wait /
 *                a2a leaves, and composites the harness can't flatten: loop,
 *                map, route, switch, conversation, converge, subflow, agents). */
export type HarnessStepKind = 'task' | 'skill' | 'engine';

export type HarnessStep = {
  /** Unique within the run: the node name, `#2`, `#3`… for a repeated name.
   *  The checkpoint key is `harness/<key>`. */
  key: string;
  name: string;
  kind: HarnessStepKind;
  description?: string;
  /** Task steps: the agent file whose guidelines apply (`agents/x.md`). */
  agentPath?: string;
  skill?: string;
  /** Names of the `lock` nodes guarding this step, outermost first: every
   *  enclosing section / parallel / loop that is locked, then the step's own.
   *  A section's gate guards ALL its steps, so no order (loose, advisory, a
   *  parallel group, a skipped first step) reaches one unapproved. */
  gates: string[];
  /** Position in the declared order. Steps of one `parallel` share a rank:
   *  under `strict` they may go in any order among themselves. */
  rank: number;
  /** Name of the `parallel` this step belongs to, if any. */
  group?: string;
  /** Name of the enclosing `phases` section, for display. */
  section?: string;
  /** False for a `continueOnError` step: its failure doesn't stop the run. */
  required: boolean;
  /** A `finally` step: runs after the others, even when one of them failed. */
  finally: boolean;
  /** Engine steps: which body runs (`code`, `http`, `loop`, `map`, …). */
  engineKind?: string;
  /** A step inside a `loop` the harness repeats itself: the loop's name and
   *  how it decides to go round again (the engine applies it after each
   *  pass, exactly as a pipeline run would). */
  loop?: HarnessLoop;
  node: Node;
};

export type HarnessLoop = {
  name: string;
  max: number;
  until?: string;
  whileOutput?: string;
  /** Frame a later pass's input as a refinement of the work so far
   *  (`loop.carryContext`, default on). */
  carryContext: boolean;
  /** The loop node itself (its `as`, `description`). */
  node: Node;
};

const COMPOSITE_ENGINE_KEYS = [
  'loop',
  'map',
  'route',
  'switch',
  'conversation',
  'converge',
  'subflow',
  'agents',
] as const;

function engineKindOf(node: Node): string | undefined {
  for (const k of COMPOSITE_ENGINE_KEYS) {
    const v = (node as Record<string, unknown>)[k];
    if (k === 'agents' ? Array.isArray(v) && v.length > 0 : v !== undefined && v !== null) return k;
  }
  if (node.code) return 'code';
  if (node.http) return 'http';
  if (node.wait) return 'wait';
  if (node.a2a) return 'a2a';
  return undefined;
}

/** A node the harness can do as ONE step of its own (not a section). */
function leafKind(node: Node): HarnessStepKind | null {
  if (Array.isArray(node.phases) || Array.isArray(node.parallel)) return null;
  if (repeatableLoop(node)) return null;
  if (engineKindOf(node)) return 'engine';
  if (node.skill) return 'skill';
  if (node.agent) return 'task';
  return null;
}

/** Whether every node under a body flattens to single steps (no nested
 *  section of its own kind that would need its own order). */
function flattensToSteps(node: Node): boolean {
  if (Array.isArray(node.phases)) return node.phases.every(flattensToSteps);
  if (Array.isArray(node.parallel)) return node.parallel.every(m => leafKind(m) !== null);
  return leafKind(node) !== null;
}

/** A `loop` the harness can repeat itself: its stop rule is the engine's to
 *  apply after each pass (`until` / `whileOutput` / `maxIterations`), and its
 *  body is a plain sequence of steps. A `judge` (another agent decides) or
 *  `retryOnFailure` loop runs as one engine step instead. */
function repeatableLoop(node: Node): boolean {
  const l = node.loop;
  return !!l && !l.judge && !l.retryOnFailure && !!l.body && flattensToSteps(l.body);
}

/** Turn an orchestration into the ordered list of steps a harness follows.
 *  `phases` sections flatten (their `finally` children last, as the engine
 *  runs them); a `parallel` of single steps flattens into one rank; every
 *  other composite stays one engine step. A node with no body is dropped —
 *  the validator reports those. */
export function compileRoadmap(root: Node): HarnessStep[] {
  const steps: HarnessStep[] = [];
  const seen = new Map<string, number>();
  let rank = 0;
  const keyFor = (name: string): string => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  };
  type Ctx = {
    section?: string;
    group?: string;
    required: boolean;
    isFinally: boolean;
    loop?: HarnessLoop;
    /** Locks of the enclosing nodes, outermost first. */
    gates: string[];
  };
  const lockedBy = (node: Node, ctx: Ctx): string[] => (node.lock ? [...ctx.gates, node.name] : ctx.gates);

  const push = (node: Node, kind: HarnessStepKind, ctx: Ctx, stepRank: number) => {
    steps.push({
      key: keyFor(node.name),
      name: node.name,
      kind,
      ...(node.description ? { description: node.description } : {}),
      ...(kind === 'task' && node.agent ? { agentPath: node.agent } : {}),
      ...(node.skill ? { skill: node.skill } : {}),
      gates: lockedBy(node, ctx),
      rank: stepRank,
      ...(ctx.group ? { group: ctx.group } : {}),
      ...(ctx.section ? { section: ctx.section } : {}),
      required: ctx.required && node.continueOnError !== true,
      finally: ctx.isFinally || node.finally === true,
      ...(kind === 'engine' ? { engineKind: engineKindOf(node) } : {}),
      ...(ctx.loop ? { loop: ctx.loop } : {}),
      node,
    });
  };

  const visit = (node: Node, ctx: Ctx): void => {
    const kind = leafKind(node);
    if (kind) {
      push(node, kind, ctx, rank++);
      return;
    }
    if (repeatableLoop(node) && !ctx.loop) {
      const l = node.loop!;
      visit(l.body, {
        ...ctx,
        gates: lockedBy(node, ctx),
        section: ctx.section ? `${ctx.section} › ${node.name}` : node.name,
        required: ctx.required && node.continueOnError !== true,
        isFinally: ctx.isFinally || node.finally === true,
        loop: {
          name: node.name,
          max: Math.max(1, l.maxIterations ?? 3),
          ...(l.until ? { until: l.until } : {}),
          ...(l.whileOutput ? { whileOutput: l.whileOutput } : {}),
          carryContext: l.carryContext !== false,
          node,
        },
      });
      return;
    }
    if (Array.isArray(node.phases)) {
      const section = ctx.section ? `${ctx.section} › ${node.name}` : node.name;
      const inner: Ctx = {
        section,
        required: ctx.required && node.continueOnError !== true,
        isFinally: ctx.isFinally || node.finally === true,
        ...(ctx.loop ? { loop: ctx.loop } : {}),
        gates: lockedBy(node, ctx),
      };
      const regular = node.phases.filter(p => p.finally !== true);
      const finals = node.phases.filter(p => p.finally === true);
      for (const p of regular) visit(p, inner);
      for (const p of finals) visit(p, { ...inner, isFinally: true });
      return;
    }
    if (Array.isArray(node.parallel)) {
      const members = node.parallel;
      // Flatten only when every branch is a single step; a branch that is
      // itself a sequence keeps the whole parallel as one engine step, so
      // "any order among themselves" never splits a branch's own order.
      if (members.length > 0 && members.every(m => leafKind(m) !== null)) {
        const groupRank = rank++;
        const inner: Ctx = {
          ...ctx,
          gates: lockedBy(node, ctx),
          group: node.name,
          required: ctx.required && node.continueOnError !== true,
          isFinally: ctx.isFinally || node.finally === true,
        };
        for (const m of members) push(m, leafKind(m)!, inner, groupRank);
        return;
      }
      push(node, 'engine', ctx, rank++);
      steps[steps.length - 1].engineKind = 'parallel';
      return;
    }
    // A loop inside a loop the harness repeats, or one it can't: the engine
    // runs it as written.
    if (node.loop) {
      push(node, 'engine', ctx, rank++);
      return;
    }
    // No body we know — nothing to do as a step.
  };

  if (Array.isArray(root.phases)) {
    const regular = root.phases.filter(p => p.finally !== true);
    const finals = root.phases.filter(p => p.finally === true);
    for (const p of regular) visit(p, { required: true, isFinally: false, gates: [] });
    for (const p of finals) visit(p, { required: true, isFinally: true, gates: [] });
  } else {
    visit(root, { required: true, isFinally: false, gates: [] });
  }
  return steps;
}

// ── How strictly ────────────────────────────────────────────────────────────

export const HARNESS_FOLLOWS: readonly HarnessFollow[] = ['strict', 'loose', 'advisory'];

const FOLLOW_RANK: Record<HarnessFollow, number> = { advisory: 0, loose: 1, strict: 2 };

export function isHarnessFollow(v: unknown): v is HarnessFollow {
  return typeof v === 'string' && (HARNESS_FOLLOWS as readonly string[]).includes(v);
}

/** Where the effective strictness came from — recorded on the run so it is
 *  never a mystery afterwards. */
export type FollowSource = 'run' | 'orchestration' | 'settings' | 'default';

export type ResolvedFollow = {
  follow: HarnessFollow;
  source: FollowSource;
  /** Set when a run asked for something looser than a locked orchestration
   *  allows: what it asked for, so the record says it was refused. */
  refused?: HarnessFollow;
};

/** Precedence: the run's own choice (Run dialog / start API) > the
 *  orchestration's `harness.follow` > the workspace default (Settings) >
 *  `strict`. A `lockFollow` orchestration only lets a run TIGHTEN it. */
export function resolveFollow(opts: {
  requested?: HarnessFollow;
  declared?: HarnessFollow;
  locked?: boolean;
  workspaceDefault?: HarnessFollow;
}): ResolvedFollow {
  const declared = opts.declared ?? (opts.locked ? 'strict' : undefined);
  if (opts.requested) {
    if (opts.locked && declared && FOLLOW_RANK[opts.requested] < FOLLOW_RANK[declared]) {
      return { follow: declared, source: 'orchestration', refused: opts.requested };
    }
    return { follow: opts.requested, source: 'run' };
  }
  if (declared) return { follow: declared, source: 'orchestration' };
  if (opts.workspaceDefault) return { follow: opts.workspaceDefault, source: 'settings' };
  return { follow: 'strict', source: 'default' };
}

export function followLabel(f: HarnessFollow): string {
  return f === 'strict' ? 'Strict order' : f === 'loose' ? 'Loose order' : 'Advisory';
}

// ── Progress ────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

/** A finished step as checkpointed (`harness/<key>` in the run's leaf
 *  outputs): JSON so a skip keeps its reason. */
export type StepRecord = {
  status: 'done' | 'skipped' | 'failed';
  output?: string;
  reason?: string;
  /** Who decided: the harness agent, the engine, or a falsy `when`. */
  by?: 'harness' | 'engine' | 'when';
};

export const HARNESS_CHECKPOINT_PREFIX = 'harness/';
/** Checkpoint key holding the harness agent's session id. */
export const HARNESS_SESSION_KEY = `${HARNESS_CHECKPOINT_PREFIX}__session`;

export function encodeStepRecord(r: StepRecord): string {
  return JSON.stringify(r);
}

export function decodeStepRecord(raw: string): StepRecord | null {
  try {
    const v = JSON.parse(raw) as StepRecord;
    if (v && (v.status === 'done' || v.status === 'skipped' || v.status === 'failed')) return v;
  } catch {
    // not a record
  }
  return null;
}

export type StartVerdict = { ok: true } | { ok: false; reason: string };

/** Each step's status and the follow rules. One step is active at a time —
 *  there is one agent. */
export class HarnessProgress {
  readonly steps: HarnessStep[];
  readonly follow: HarnessFollow;
  private readonly status = new Map<string, StepStatus>();
  private readonly records = new Map<string, StepRecord>();
  /** Current pass of each repeated loop (1-based). */
  private readonly passes = new Map<string, number>();
  private activeKey: string | null = null;

  constructor(
    steps: HarnessStep[],
    follow: HarnessFollow,
    restored?: Map<string, StepRecord>,
    restoredPasses?: Map<string, number>,
  ) {
    this.steps = steps;
    this.follow = follow;
    for (const [loop, n] of restoredPasses ?? []) this.passes.set(loop, n);
    for (const s of steps) {
      const r = restored?.get(s.key);
      this.status.set(s.key, r ? r.status : 'pending');
      if (r) this.records.set(s.key, r);
    }
  }

  /** The pass a repeated loop is on (1 for the first). */
  passOf(loopName: string): number {
    return this.passes.get(loopName) ?? 1;
  }

  /** Where a step's end is checkpointed: `harness/<key>`, or for a step a
   *  loop repeats `harness/<loop>@<pass>/<key>` — each pass its own. */
  checkpointKey(s: HarnessStep): string {
    return HARNESS_CHECKPOINT_PREFIX + (s.loop ? `${s.loop.name}@${this.passOf(s.loop.name)}/${s.key}` : s.key);
  }

  /** The steps of one repeated loop. */
  loopSteps(loopName: string): HarnessStep[] {
    return this.steps.filter(s => s.loop?.name === loopName);
  }

  /** Every step of this loop's current pass is settled. */
  passComplete(loopName: string): boolean {
    return this.loopSteps(loopName).every(s => this.settled(s));
  }

  /** Start the loop's next pass: its steps are open again. */
  nextPass(loopName: string): number {
    const n = this.passOf(loopName) + 1;
    this.passes.set(loopName, n);
    for (const s of this.loopSteps(loopName)) {
      this.status.set(s.key, 'pending');
      this.records.delete(s.key);
    }
    return n;
  }

  get(key: string): HarnessStep | undefined {
    return this.steps.find(s => s.key === key);
  }

  /** Accepts a step's key or its name (the agent may use either). */
  find(keyOrName: string): HarnessStep | undefined {
    return this.get(keyOrName) ?? this.steps.find(s => s.name === keyOrName);
  }

  statusOf(key: string): StepStatus {
    return this.status.get(key) ?? 'pending';
  }

  recordOf(key: string): StepRecord | undefined {
    return this.records.get(key);
  }

  get active(): HarnessStep | undefined {
    return this.activeKey ? this.get(this.activeKey) : undefined;
  }

  settled(s: HarnessStep): boolean {
    const st = this.statusOf(s.key);
    return st === 'done' || st === 'skipped' || (st === 'failed' && !s.required);
  }

  /** The steps that may start now under the follow rules. */
  available(): HarnessStep[] {
    if (this.activeKey) return [];
    const open = this.steps.filter(s => !this.settled(s));
    if (open.length === 0) return [];
    const regularOpen = open.filter(s => !s.finally);
    if (this.follow !== 'strict') {
      // A finalizer waits for the regular steps in every mode — it is a
      // `finally`, not just another step.
      return regularOpen.length > 0 ? regularOpen : open;
    }
    const pool = regularOpen.length > 0 ? regularOpen : open;
    const lowest = Math.min(...pool.map(s => s.rank));
    return pool.filter(s => s.rank === lowest);
  }

  canStart(step: HarnessStep): StartVerdict {
    if (this.activeKey === step.key) return { ok: true };
    if (this.activeKey) {
      return { ok: false, reason: `"${this.active!.name}" is still in progress — finish it (complete_step), or fail_step it, first.` };
    }
    const st = this.statusOf(step.key);
    if ((st === 'done' || st === 'skipped') && this.follow === 'strict') {
      return { ok: false, reason: `"${step.name}" is already ${st}; strict order doesn't go back to a finished step.` };
    }
    if (st === 'done' || st === 'skipped') return { ok: true }; // loose / advisory: re-open
    if (this.available().some(s => s.key === step.key)) return { ok: true };
    const next = this.available().map(s => `"${s.name}"`).join(', ');
    return {
      ok: false,
      reason:
        step.finally
          ? `"${step.name}" is a finalizer — it runs after the other steps are done. Next: ${next}.`
          : `Strict order: "${step.name}" can't start yet. Next: ${next}.`,
    };
  }

  start(step: HarnessStep): void {
    this.activeKey = step.key;
    this.status.set(step.key, 'active');
  }

  finish(step: HarnessStep, record: StepRecord): void {
    if (this.activeKey === step.key) this.activeKey = null;
    this.status.set(step.key, record.status);
    this.records.set(step.key, record);
  }

  /** Release the active step without finishing it (its leg ended mid-step). */
  release(): void {
    if (this.activeKey) this.status.set(this.activeKey, 'pending');
    this.activeKey = null;
  }

  /** Required steps that aren't done — what stops the run finishing. */
  unfinished(): HarnessStep[] {
    return this.steps.filter(s => !this.settled(s));
  }

  /** Steps the harness agent chose to skip (advisory only) — a degradation. */
  skippedByHarness(): HarnessStep[] {
    return this.steps.filter(s => this.records.get(s.key)?.status === 'skipped' && this.records.get(s.key)?.by === 'harness');
  }

  /** The checklist the agent reads (list_steps, and its first message).
   *  `approved`: gates already approved, which no longer stop anything. */
  checklist(approved?: ReadonlySet<string>): string {
    const mark: Record<StepStatus, string> = {
      pending: '[ ]',
      active: '[>]',
      done: '[x]',
      skipped: '[-]',
      failed: '[!]',
    };
    const next = new Set(this.available().map(s => s.key));
    return this.steps
      .map((s, i) => {
        const st = this.statusOf(s.key);
        const bits = [
          `${mark[st]} ${i + 1}. ${s.name}`,
          s.key !== s.name ? `(id "${s.key}")` : '',
          `— ${kindLabel(s)}`,
          s.gates.length === 0 ? '' : s.gates.every(g => approved?.has(g)) ? '· approved' : '· needs approval first',
          s.group ? `· with the other "${s.group}" steps, in any order` : '',
          s.loop ? `· in "${s.loop.name}", pass ${this.passOf(s.loop.name)} of at most ${s.loop.max}` : '',
          s.finally ? '· finalizer' : '',
          !s.required ? '· optional (may fail)' : '',
          next.has(s.key) ? '← next' : '',
        ];
        return bits.filter(Boolean).join(' ');
      })
      .join('\n');
  }
}

export function kindLabel(s: HarnessStep): string {
  if (s.kind === 'skill') return `run the skill "${s.skill}"`;
  if (s.kind === 'task') return 'do it yourself';
  return `the engine runs it (${s.engineKind ?? 'step'}) — call run_step`;
}

// ── What the agent reads ────────────────────────────────────────────────────

const FOLLOW_RULES: Record<HarnessFollow, string> = {
  strict:
    'STRICT ORDER: do the steps in the order listed. A step can only start once the step before it is done. ' +
    'Steps marked "in any order" with each other may go in any order among themselves.',
  loose:
    'LOOSE ORDER: you may do the steps in any order, and go back to a finished step (start_step it again) — ' +
    'but every required step must be done before the run can finish.',
  advisory:
    'ADVISORY: the steps are a guide. You may skip a step with skip_step, saying why; a skipped step ' +
    'is recorded and the run is marked degraded, naming it.',
};

/** The harness agent's system prompt. */
export function buildHarnessSystemPrompt(opts: {
  orchestration: Node;
  progress: HarnessProgress;
  extra?: string;
  approvedGates?: ReadonlySet<string>;
}): string {
  const { orchestration: o, progress } = opts;
  return [
    `You are running the orchestration "${o.name}" as its harness: you work through its steps yourself, one at a time, using the step tools.`,
    o.description ? `What it is for: ${o.description}` : '',
    '',
    FOLLOW_RULES[progress.follow],
    '',
    'Steps marked "in <loop>, pass N" repeat: when their pass is done the engine decides, by the loop\'s own rule, whether to go round again — then they open up for the next pass.',
    '',
    'How each step works:',
    '1. start_step(step) — the engine checks the order and gives you the step\'s instructions, its input and the tools it allows.',
    '2. Do the step: "do it yourself" steps by doing the task as instructed; "run the skill" steps by running that skill with the Skill tool; "engine" steps by calling run_step(step), which runs it exactly as written and returns its output.',
    '3. complete_step(step, output) — hand in the step\'s result. Write the output the way the step asks; the next step receives it. If the step declares an output format, the engine checks it.',
    'If you cannot do a step, call fail_step(step, reason). Never claim a step is done when it isn\'t.',
    '',
    'Only the current step\'s tools work while it is active. Between steps you can read files and call the step tools.',
    'A step marked "needs approval first" stops the run until a person approves it: when start_step says so, end your turn with a one-line status. You will be resumed at that step.',
    'When every step is done, end your turn with a short summary of the run.',
    '',
    'The steps:',
    progress.checklist(opts.approvedGates),
    opts.extra ? `\nGuidance for this orchestration:\n${opts.extra}` : '',
  ]
    .filter(line => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Truncate long text the agent reads (a step's input, an engine step's
 *  output), keeping the head and the tail. */
export function clipForAgent(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters omitted …]\n\n${text.slice(-tail)}`;
}

/** Names of the tools the engine gives the harness agent. */
export const HARNESS_TOOL_SERVER = 'sammy';
export const HARNESS_TOOL_NAMES = [
  'list_steps',
  'start_step',
  'complete_step',
  'fail_step',
  'skip_step',
  'run_step',
] as const;
export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];

/** `mcp__sammy__start_step` — the id the SDK gives an in-process tool. */
export function harnessToolId(name: HarnessToolName): string {
  return `mcp__${HARNESS_TOOL_SERVER}__${name}`;
}

/** Tools any step may use while it is active, and between steps: reading,
 *  and ToolSearch — Claude Code loads MCP tools (the step tools among them)
 *  on demand, so without it the agent can't reach start_step at all. */
export const HARNESS_ALWAYS_ALLOWED = ['Read', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch'];

/** One engine tool the harness agent can call. Every parameter is a string;
 *  a name ending in `?` is optional. */
export type HarnessToolSpec = {
  name: HarnessToolName;
  description: string;
  params: Record<string, string>;
  handler: (args: Record<string, string | undefined>) => Promise<{ text: string; isError?: boolean }>;
};

/** What a stream adapter needs to host a harness session. Only the server's
 *  SDK path honors it (in-process tools, sessions and skills are SDK
 *  features); every other adapter ignores it, so runHarness refuses to start
 *  unless the caller says the adapter supports it. */
export type HarnessStreamOptions = {
  tools: HarnessToolSpec[];
  /** Start a new session with this id (a UUID). */
  sessionId?: string;
  /** Continue this session. */
  resume?: string;
  /** The skills the steps name — the only ones the session may run. */
  skills?: string[];
  /** Asked before every tool call: a reason to refuse it, or null to allow. */
  toolGate?: (toolName: string, input: unknown) => string | null;
};

/** Where a terminal-driven leg's step tools are served, and how to reach
 *  them. Carries the leg's token — never written to the event log. */
export type HarnessTerminalLeg = {
  url: string;
  token: string;
  sessionId: string;
  cwd?: string;
};

/** How a host lets a person drive a harness run from a terminal: one object
 *  per run, shared by the host's API and the run's executor. Only one driver
 *  at a time — the server's agent OR a terminal. */
export type HarnessControl = {
  /** The host asked for the next leg to be driven from a terminal. */
  wantTerminal: boolean;
  /** Executor-set while the server's agent drives: end its leg so a terminal
   *  can take over (deferred while an engine step is running). */
  interruptLeg: (() => void) | null;
  /** Executor-set while a terminal drives: end that leg — the person handed
   *  the run back to the server's agent. */
  endTerminalLeg: ((why: 'handback') => void) | null;
  /** Host-provided: serve the step tools to a terminal session. */
  serveTools: ((tools: HarnessToolSpec[]) => Promise<{ url: string; token: string; close(): void }>) | null;
  /** Executor-set while a terminal drives: where its tools are. */
  terminal: HarnessTerminalLeg | null;
};

export function newHarnessControl(serveTools: HarnessControl['serveTools'] = null): HarnessControl {
  return { wantTerminal: false, interruptLeg: null, endTerminalLeg: null, serveTools, terminal: null };
}

/** The shell command that resumes the harness agent's session in a terminal
 *  — with the run's step tools when a terminal leg is live. POSIX-quoted. */
export function harnessTerminalCommand(opts: {
  sessionId: string;
  cwd?: string;
  runId?: string;
  tools?: { url: string; token: string };
}): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`claude --resume ${opts.sessionId}`];
  if (opts.tools) {
    const config = {
      mcpServers: {
        [HARNESS_TOOL_SERVER]: {
          type: 'http',
          url: opts.tools.url,
          headers: { Authorization: `Bearer ${opts.tools.token}` },
        },
      },
    };
    parts.push(
      `--mcp-config ${q(JSON.stringify(config))}`,
      `--allowedTools ${q(`mcp__${HARNESS_TOOL_SERVER}`)}`,
      `--append-system-prompt ${q(
        `You are driving the sammy-pack run${opts.runId ? ` ${opts.runId}` : ''} as its harness. ` +
          `Use the mcp__${HARNESS_TOOL_SERVER} step tools — list_steps first, then start_step / complete_step / run_step. ` +
          'The engine still checks the order and holds the gates; the run page follows along.',
      )}`,
    );
  }
  return `${opts.cwd ? `cd ${q(opts.cwd)} && ` : ''}${parts.join(' ')}`;
}

/** A FIFO of events produced outside the agent's stream (by the step tools,
 *  while the agent waits on them), read alongside it. */
export class HarnessEventQueue<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /** Items leave the queue only once the reader asks for the NEXT one: a
   *  reader that is abandoned holding an item it never passed on (a merge
   *  that read ahead when its leg was cut short) leaves it for the next
   *  drain instead of losing it. */
  async *drain(): AsyncIterable<T> {
    while (true) {
      while (this.items.length > 0) {
        yield this.items[0];
        this.items.shift();
      }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}
