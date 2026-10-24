/**
 * `sammy-pack preview` — the symbolic walker.
 *
 * Traverses the parsed orchestration node tree the SAME way the executor does
 * (`executeNode` / `dispatchNode`), but performs traversal MINUS execution: it
 * resolves every statically-knowable value, marks every runtime-dependent value
 * symbolically, and renders side-effecting leaves as `would run` / `would
 * prompt` WITHOUT ever dispatching an agent, running code, or touching the
 * network. The product is a `PreviewPlan` — a tree of `PreviewNode`s carrying
 * `resolved` / `symbolic` / `wouldRun` fields plus inline findings — that the
 * renderer turns into a terminal plan or JSON.
 *
 * Faithfulness (the cardinal property): for everything statically knowable,
 * preview is IDENTICAL to execution, because both call the shared resolution
 * primitives in `resolution.ts` (interpolation, the `when` predicate, switch
 * selection) over the SAME lookup shape. Everything runtime-dependent (an agent
 * output, a `code` result, a `code.run` stdout bound via `as`, an array a `map`
 * fans out over) is shown symbolically and explicitly marked — no silent
 * guesses. The parity test (preview.parity.test.ts) keeps this true by diffing
 * preview's fully-resolved commands/prompts against what the executor builds in
 * a recording harness.
 *
 * Mirror discipline: the dispatch in `walkBody` is a deliberate structural
 * mirror of `dispatchNode` (same body-kind order, same control-flow shape). A
 * structural-parity test asserts the two enumerate the same body kinds so they
 * can't drift.
 */

import type { State } from './interpolate';
import { resolveOver } from './interpolate';
import {
  buildLookup,
  evalWhen,
  resolveAgentInput,
  resolveAgentPath,
  resolveCommand,
  resolveTemplate,
  classifyUnresolved,
  selectSwitchCase,
} from './resolution';
import type { Node } from '../types';
import { compositeKey, DEFAULT_NODE_TIMEOUT_SEC } from '../types';
import { lintOrchestration, type LintFinding } from '../validate';

// ── Public types ───────────────────────────────────────────────────────────

/** Severity of a preview finding. `error` fails the run (exit 1); `warning`
 *  and `info` are advisory. Mirrors the lint severities + the runtime-branch
 *  `info` notes preview adds. */
export type Severity = 'error' | 'warning' | 'info';

/** A structural finding attached to the phase that owns it. */
export type PreviewFinding = {
  severity: Severity;
  /** Stable machine code (e.g. 'unbound-exec-ref', 'decorative-var',
   *  'cyclic-subflow', 'runtime-branch'). */
  code: string;
  message: string;
};

/** How a node's primary "action line" resolved. */
export type PreviewKind =
  | 'agent' // leaf LLM dispatch
  | 'agents' // serial agent chain
  | 'a2a' // outbound remote agent
  | 'code' // inline JS transform
  | 'code.run' // external shell command
  | 'wait' // durable timer / external-signal park
  | 'http' // one HTTP request, no model
  | 'phases'
  | 'parallel'
  | 'converge'
  | 'subflow'
  | 'loop'
  | 'conversation'
  | 'route'
  | 'switch'
  | 'map'
  | 'empty'; // no executable body

/** One node in the preview plan tree. Carries the resolved/symbolic action plus
 *  any findings and child nodes. Render-agnostic — the renderer turns this into
 *  text or JSON. */
export type PreviewNode = {
  name: string;
  kind: PreviewKind;
  description?: string;

  /** The agent path a leaf (or chain link) would dispatch to, resolved. */
  agentPath?: string;
  /** `as:` output name this node binds (a symbolic value downstream). */
  as?: string;

  /** The resolved side-effecting action, if this node has one:
   *   - agent/agents/conversation/route-router/loop-judge → `would prompt`
   *   - code.run → `would run`
   *   - a2a → `would call`
   *  Mutually informative with `symbolic`: when the action string still
   *  contains `«…»` placeholders, `symbolic` is true. */
  action?: {
    verb:
      | 'would prompt'
      | 'would run'
      | 'would call'
      | 'would exec'
      | 'would wait'
      | 'would wait until'
      | 'would wait for signal'
      | 'would send';
    text: string;
  };

  /** True when this node's action / value depends on a runtime value (an
   *  unresolved `${ref}` bound to an `as` output, a runtime `map` array, a
   *  `route`, a runtime `when`). Drives the renderer's symbolic labeling. */
  symbolic: boolean;

  /** Whether this node WOULD run given the static resolution context:
   *   - true  — a static `when` was truthy / absent, or no `when`.
   *   - false — a static `when` was falsy (the executor would skip it).
   *   - 'conditional' — `when`/control depends on a runtime value, so preview
   *     can't decide; shown but labeled conditional. */
  wouldRun: boolean | 'conditional';

  /** For a `when`-guarded node: the resolved (or symbolic) predicate text, for
   *  the renderer to print as `when «…»`. */
  whenLabel?: string;

  /** A short label the renderer prints after the kind, e.g. a map's
   *  `[× 4]` / `[× «runtime»]`, a loop's `[× up to 5]`, a switch/route's
   *  chosen vs. all-branches note. */
  expansion?: string;

  /** Resolved key/value bindings to show under a composite (a subflow's seeded
   *  vars, a map item binding). */
  bindings?: { key: string; value: string }[];

  findings: PreviewFinding[];
  children: PreviewNode[];
};

/** The full plan: the root metadata + the phase tree + a roll-up summary. */
export type PreviewPlan = {
  orchestration: string;
  description?: string;
  /** Resolved top-level vars (after `--vars` overrides). */
  vars: { key: string; value: string }[];
  /** Trigger summaries ("cron `0 3 * * *`", "webhook `qa-handoff`"). */
  triggers: string[];
  /** Concurrency summary ("group=… policy=…") or undefined. */
  concurrency?: string;
  /** Findings owned by the root (e.g. decorative-var, unconsumed-as). */
  findings: PreviewFinding[];
  /** The phase tree (root's `phases`, or the root body as a single node). */
  phases: PreviewNode[];
  summary: {
    phases: number;
    subflows: number;
    agents: number;
    codeRun: number;
    errors: number;
    warnings: number;
  };
};

/** Options seeding the walk's resolution context. */
export type PreviewOptions = {
  /** `--vars k=v` overrides / supplied vars, layered over the orchestration's
   *  own top-level `vars`. */
  vars?: Record<string, string>;
  /** `--input <json|text>` seeding `initialInput` / `${input}`. */
  initialInput?: string;
  /** Resolved typed inputs (name → text), seeded into state as `${name}` —
   *  the executor's `resolvedInputs`. */
  resolvedInputs?: Record<string, string>;
  /** `--depth N` — how deep to expand subflows / static maps (default: full). */
  maxDepth?: number;
  /** `--no-lint` — skip the structural lint findings (plan only). */
  noLint?: boolean;
  /** All orchestrations available for `subflow` lookup, keyed by name. When
   *  omitted, subflows render symbolically (name resolved, body not expanded).
   */
  orchestrationByName?: Map<string, Node>;
};

// ── Walk context (the pure mirror of ExecutorContext) ───────────────────────

type WalkContext = {
  /** Run-wide static state: vars + state-decl initials + resolved inputs.
   *  `as`-bound outputs are NOT placed here — they're runtime, tracked via
   *  `producers` and rendered symbolically. */
  state: State;
  /** Scope overlay: `item` / `index` inside a static map, `error` placeholder
   *  inside an `onError` branch. */
  scope: State;
  /** The reserved `input` value at this point in the walk. Resolved upstream
   *  outputs are runtime, so `input` is symbolic except at the very first phase
   *  (the seeded initialInput) — tracked as a string that may be a `«…»`. */
  input: string;
  /** as-name → producer descriptor, for rendering `«name ← phase (kind)»`. */
  producers: Map<string, { phase: string; kind: PreviewKind }>;
  /** Names a `${ref}` base can legitimately bind to WITHOUT being a runtime
   *  `as` (vars, state-decl keys, declared inputs, supplied `--vars`/input keys,
   *  reserved). Used by the unbound-exec-ref error check. */
  knownVars: Set<string>;
  /** Subflow call stack for cycle detection. */
  subflowStack: string[];
  orchestrationByName: Map<string, Node>;
  depth: number;
  maxDepth: number;
  /** The wallclock cap (seconds) a node with no explicit `timeout` inherits:
   *  the orchestration root's `defaults.timeout` if set, else the built-in
   *  `DEFAULT_NODE_TIMEOUT_SEC`. Drives the composite-no-timeout warning — a
   *  serial `phases` composite whose sub-phase timeouts SUM past this cap will
   *  be torn down mid-sequence. */
  defaultTimeoutSec: number;
};

const RESERVED_BASES = new Set([
  'input',
  'item',
  'index',
  'error',
  'vars',
  'secrets',
  'env',
  'state',
]);

const REF_RE = /\$\{([^}]+)\}/g;

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Produce a `PreviewPlan` for an orchestration. Pure + side-effect-free.
 */
export function previewOrchestration(
  orchestration: Node,
  opts: PreviewOptions = {},
): PreviewPlan {
  const maxDepth = opts.maxDepth ?? Infinity;
  const orchestrationByName =
    opts.orchestrationByName ?? new Map<string, Node>();
  // Self-register so a subflow ref to self is cycle-detected, mirroring the
  // executor's setOrchestrationWithPrecedence(root).
  if (!orchestrationByName.has(orchestration.name)) {
    orchestrationByName.set(orchestration.name, orchestration);
  }

  // Seed the static state exactly as runOrchestration does:
  //   { input, ...vars, ...stateInitials, ...resolvedInputs }, with --vars
  // overrides layered on the vars (a supplied value wins).
  const seedVars: State = {
    ...(orchestration.vars ?? {}),
    ...(opts.vars ?? {}),
  };
  const stateInitials = stateDeclInitials(orchestration);
  const initialInput = opts.initialInput ?? '';
  const state: State = {
    input: initialInput,
    ...seedVars,
    ...stateInitials,
    ...(opts.resolvedInputs ?? {}),
  };

  // The static known-name universe a `${ref}` base may bind to without being a
  // runtime `as`. Required-but-unset declared inputs are still "known" (they're
  // supplied at run time) — but we mark them so a ref renders `«var: required,
  // unset»` rather than as an error.
  const knownVars = new Set<string>(RESERVED_BASES);
  for (const k of Object.keys(seedVars)) knownVars.add(k);
  for (const k of Object.keys(stateInitials)) knownVars.add(k);
  for (const k of Object.keys(opts.resolvedInputs ?? {})) knownVars.add(k);
  for (const decl of orchestration.inputs ?? []) knownVars.add(decl.name);

  const producers = new Map<string, { phase: string; kind: PreviewKind }>();
  collectProducers(orchestration, producers);

  const ctx: WalkContext = {
    state,
    scope: {},
    input: initialInput,
    producers,
    knownVars,
    subflowStack: [orchestration.name],
    orchestrationByName,
    depth: 0,
    maxDepth,
    defaultTimeoutSec: orchestration.defaults?.timeout ?? DEFAULT_NODE_TIMEOUT_SEC,
  };

  // The root is a sequence (`phases`) like any nested one, OR a single-body
  // root (a bare `map` / `route` / `agent`). Mirror runOrchestration's choice.
  const phases: PreviewNode[] = [];
  const rootPhases = orchestration.phases;
  if (Array.isArray(rootPhases) && rootPhases.length > 0) {
    for (const phase of rootPhases) {
      phases.push(walkNode(phase, ctx));
    }
  } else {
    phases.push(walkNode(orchestration, ctx));
  }

  // Structural lint findings, attributed to their owning phase. Off with
  // --no-lint.
  const lintByNode = opts.noLint
    ? new Map<string, PreviewFinding[]>()
    : collectLintFindings(orchestration, knownVars, producers);
  const rootFindings = lintByNode.get(orchestration.name) ?? [];
  attachLintFindings(phases, lintByNode);

  // Default-timeout visibility (info): without it, authors learn that
  // unlisted agent phases inherit the built-in cap only when a healthy
  // evidence-heavy phase dies at it. ONE aggregate finding — not one per
  // phase — so a corpus of many bare leaves stays readable. Skipped when the root sets `defaults.timeout` (the author
  // chose a run-wide cap), and under --no-lint.
  if (!opts.noLint && orchestration.defaults?.timeout == null) {
    let bareAgentLeaves = 0;
    const visitTimeouts = (n: Node): void => {
      if (
        (n.agent || (Array.isArray(n.agents) && n.agents.length > 0)) &&
        n.timeout == null
      ) {
        bareAgentLeaves += 1;
      }
      for (const child of childNodesOf(n)) visitTimeouts(child);
    };
    visitTimeouts(orchestration);
    if (bareAgentLeaves > 0) {
      rootFindings.push({
        severity: 'info',
        code: 'default-timeout-inherited',
        message:
          `${bareAgentLeaves} agent phase(s) set no \`timeout\` and inherit ` +
          `the ${DEFAULT_NODE_TIMEOUT_SEC}s framework default — a long ` +
          `evidence-heavy phase dies there at a cap the author never chose. ` +
          `Set \`timeout\` per phase or \`defaults.timeout\` on the root.`,
      });
    }
  }

  const summary = rollUp(phases, rootFindings);

  return {
    orchestration: orchestration.name,
    description: orchestration.description,
    vars: Object.entries(seedVars).map(([key, value]) => ({
      key,
      value: String(value),
    })),
    triggers: summarizeTriggers(orchestration),
    concurrency: orchestration.concurrency
      ? `group=${orchestration.concurrency.group} policy=${orchestration.concurrency.policy ?? 'queue'}`
      : undefined,
    findings: rootFindings,
    phases,
    summary,
  };
}

// ── The node walk (mirror of executeNode's decorators) ──────────────────────

function walkNode(node: Node, ctx: WalkContext): PreviewNode {
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);

  // 1. `when` — decide static / runtime. The executor evaluates
  //    evalWhen(node.when, lookup). If the predicate has unbound refs it's
  //    runtime → show conditionally; otherwise resolve and decide.
  //
  //    Unresolved-ref parity: the EXECUTOR now fail-safe SKIPS a node whose
  //    `when` contains a `${ref}` that doesn't resolve at run time (via
  //    evalWhen's onUnresolved hook — an unresolved ref used to render as a
  //    truthy literal and silently always-run). Preview needs no hook here:
  //    `hasRuntimeRef` already classifies ANY ref outside the static
  //    known-name universe — including a genuinely unbound one — as runtime,
  //    so such a branch renders 'conditional' (never a definite always-run),
  //    which remains consistent with the executor's skip. The evalWhen call
  //    below only runs on predicates whose refs all resolved statically.
  let wouldRun: boolean | 'conditional' = true;
  let whenLabel: string | undefined;
  const whenFindings: PreviewFinding[] = [];
  if (node.when !== undefined) {
    const unresolved = new Set<string>();
    const resolvedWhen = resolveTemplate(node.when, lookup, r =>
      unresolved.add(r),
    );
    if (hasRuntimeRef(node.when, ctx)) {
      wouldRun = 'conditional';
      whenLabel = symbolizeRefs(node.when, ctx);
      whenFindings.push({
        severity: 'info',
        code: 'runtime-branch',
        message: `\`when\` depends on a runtime value (${whenLabel}); shown conditionally — preview can't resolve it.`,
      });
    } else {
      // Statically knowable predicate → resolve it exactly as the executor.
      wouldRun = evalWhen(node.when, lookup);
      whenLabel = resolvedWhen;
      // An always-literal `when` (no `${...}` at all) is the unset-renders-truthy
      // trap the doc flags as a warning.
      if (!node.when.includes('${')) {
        whenFindings.push({
          severity: 'warning',
          code: 'static-when',
          message: `\`when: "${node.when}"\` is a constant (no \${...}) — it always evaluates the same way; likely a mistake.`,
        });
      }
    }
  }

  // 2. Dispatch by body kind (mirror of dispatchNode). The walk continues into
  //    children even when wouldRun === false so the reader sees the whole plan;
  //    the renderer greys a statically-skipped node.
  const pv = walkBody(node, ctx);
  // Compose the `when`-derived run state with the body's own (a route / runtime
  // switch sets its body `wouldRun` to 'conditional'). Don't let the `when`
  // decorator CLOBBER an inherently-conditional body: a statically-false `when`
  // still wins (the executor would skip the whole node), but otherwise the more-
  // uncertain of the two is kept.
  pv.wouldRun = composeRunState(wouldRun, pv.wouldRun);
  pv.whenLabel = whenLabel;
  pv.findings.unshift(...whenFindings);

  // 3. `as` — record the binding (its VALUE is runtime, tracked in producers).
  if (node.as) pv.as = node.as;

  return pv;
}

// ── Body dispatch — the deliberate mirror of dispatchNode ────────────────────
//
// The ORDER of these branches matches dispatchNode exactly (subflow, agent,
// a2a, code, wait, agents, phases, parallel, converge, loop, conversation,
// route, switch, map, then the empty fallback). preview.structure.test.ts asserts
// this enumeration matches the executor's so the two can't silently diverge.

/** The body kinds this walker handles, in dispatchNode order. Exported for the
 *  structural-parity test. */
export const PREVIEW_BODY_KINDS = [
  'subflow',
  'agent',
  'a2a',
  'code',
  'wait',
  'http',
  'agents',
  'phases',
  'parallel',
  'converge',
  'loop',
  'conversation',
  'route',
  'switch',
  'map',
] as const;

function walkBody(node: Node, ctx: WalkContext): PreviewNode {
  const base = (kind: PreviewKind): PreviewNode => ({
    name: node.name,
    kind,
    description: node.description,
    symbolic: false,
    wouldRun: true,
    findings: [],
    children: [],
  });

  // Subflow: inline another orchestration by name (cycle-safe).
  if (node.subflow) {
    return walkSubflow(node, ctx, base('subflow'));
  }

  // Leaf agent — a side-effecting LLM dispatch. Resolve the prompt; never call.
  if (node.agent) {
    return walkAgentLeaf(node, node.agent, ctx, base('agent'));
  }

  // Leaf: outbound A2A call to a remote agent.
  if (node.a2a) {
    const pv = base('a2a');
    const { text, symbolic } = renderField(node.a2a.agentCard, ctx);
    pv.action = { verb: 'would call', text: text + (node.a2a.skill ? ` · skill=${node.a2a.skill}` : '') };
    pv.symbolic = symbolic;
    return pv;
  }

  // Leaf: inline code — `source` (JS) or `run` (external shell).
  if (node.code) {
    return walkCodeLeaf(node, ctx, base(node.code.run ? 'code.run' : 'code'));
  }

  // Leaf: durable timer / external-signal wait. Zero cost; the interesting
  // preview facts are WHAT it waits for and whether that's symbolic.
  if (node.wait) {
    const pv = base('wait');
    const w = node.wait;
    if (typeof w.signal === 'string') {
      const { text, symbolic } = renderField(w.signal, ctx);
      pv.action = {
        verb: 'would wait for signal',
        text:
          `"${text}"` +
          (typeof w.timeoutSeconds === 'number'
            ? ` (timeout ${w.timeoutSeconds}s)`
            : ' (no timeout — parks until delivered)'),
      };
      pv.symbolic = symbolic;
    } else if (typeof w.until === 'string') {
      const { text, symbolic } = renderField(w.until, ctx);
      pv.action = { verb: 'would wait until', text };
      pv.symbolic = symbolic;
    } else {
      pv.action = {
        verb: 'would wait',
        text: `${typeof w.seconds === 'number' ? w.seconds : 0}s (durable timer)`,
      };
    }
    return pv;
  }

  // Leaf: one HTTP request. Side-effecting (a write-back, a chat post) — the
  // preview names the method + resolved URL and never sends it.
  if (node.http) {
    const pv = base('http');
    const { text, symbolic } = renderField(node.http.url, ctx);
    pv.action = { verb: 'would send', text: `${(node.http.method ?? 'GET').toUpperCase()} ${text}` };
    pv.symbolic = symbolic;
    return pv;
  }

  // Serial agent chain inside one phase.
  if (Array.isArray(node.agents) && node.agents.length > 0) {
    const pv = base('agents');
    let cursor = ctx;
    for (const agentPath of node.agents) {
      const name = agentPath.split('/').pop()?.replace(/\.md$/, '') ?? agentPath;
      const childNode: Node = { name: `${node.name}/${name}`, agent: agentPath };
      const child = walkAgentLeaf(
        childNode,
        agentPath,
        cursor,
        {
          name: childNode.name,
          kind: 'agent',
          symbolic: false,
          wouldRun: true,
          findings: [],
          children: [],
        },
      );
      pv.children.push(child);
      // Each link's output feeds the next as a runtime `input`.
      cursor = withSymbolicInput(cursor, `«output ← ${childNode.name} (agent)»`);
    }
    pv.symbolic = pv.children.some(c => c.symbolic);
    return pv;
  }

  // Nested phases (serial). Outputs pipe forward as runtime inputs.
  if (Array.isArray(node.phases) && node.phases.length > 0) {
    const pv = base('phases');
    walkSequence(node.phases, ctx, pv);
    checkCompositeTimeout(node, node.phases, ctx, pv);
    return pv;
  }

  // Parallel / converge — independent branches over the SAME input.
  if (Array.isArray(node.parallel) && node.parallel.length > 0) {
    const pv = base('parallel');
    for (const branch of node.parallel) pv.children.push(walkNode(branch, ctx));
    pv.symbolic = pv.children.some(c => c.symbolic);
    return pv;
  }
  if (Array.isArray(node.converge) && node.converge.length > 0) {
    const pv = base('converge');
    for (const branch of node.converge) pv.children.push(walkNode(branch, ctx));
    if (node.merger) {
      const mergerNode: Node = { name: `${node.name}/merger`, agent: node.merger };
      pv.children.push(
        walkAgentLeaf(mergerNode, node.merger, ctx, {
          name: mergerNode.name,
          kind: 'agent',
          symbolic: false,
          wouldRun: true,
          findings: [],
          children: [],
        }),
      );
    }
    pv.symbolic = pv.children.some(c => c.symbolic);
    return pv;
  }

  // Loop — body runs up to maxIterations. Show the body ONCE, labeled.
  if (node.loop) {
    const pv = base('loop');
    pv.expansion = `[× up to ${Math.max(1, node.loop.maxIterations ?? 3)}]`;
    pv.children.push(walkNode(node.loop.body, ctx));
    if (node.loop.judge) {
      const judgeNode: Node = { name: `${node.name}/judge`, agent: node.loop.judge };
      pv.children.push(
        walkAgentLeaf(judgeNode, node.loop.judge, ctx, {
          name: judgeNode.name,
          kind: 'agent',
          symbolic: false,
          wouldRun: true,
          findings: [],
          children: [],
        }),
      );
    }
    pv.symbolic = pv.children.some(c => c.symbolic);
    return pv;
  }

  // Conversation — cycle participants for `rounds` turns. Runtime by nature.
  if (node.conversation) {
    const pv = base('conversation');
    const rounds = Math.max(1, node.conversation.rounds ?? 4);
    pv.expansion = `[${node.conversation.participants.length} participants × ${rounds} rounds]`;
    for (const agentPath of node.conversation.participants) {
      const name = agentPath.split('/').pop()?.replace(/\.md$/, '') ?? agentPath;
      const resolvedPath = resolveAgentPath(
        agentPath,
        buildLookup(ctx.state, ctx.scope, ctx.input),
      );
      pv.children.push({
        name: `${node.name}/${name}`,
        kind: 'agent',
        agentPath: resolvedPath,
        symbolic: true, // transcript is runtime
        wouldRun: true,
        findings: [],
        children: [],
      });
    }
    pv.symbolic = true;
    return pv;
  }

  // Route — router agent or substring match on the input. ALWAYS runtime: the
  // chosen branch depends on a value preview can't resolve. Show ALL branches,
  // labeled conditional.
  if (node.route) {
    return walkRoute(node, ctx, base('route'));
  }

  // Switch — deterministic value-based selection. On a STATIC `on` value (or
  // static upstream input) it resolves to the taken case; on a runtime value it
  // shows all cases labeled.
  if (node.switch) {
    return walkSwitch(node, ctx, base('switch'));
  }

  // Map — fan out over an array. Static array → expand each item with `${item}`
  // resolved; runtime array → one symbolic iteration `[× «runtime»]`.
  if (node.map) {
    return walkMap(node, ctx, base('map'));
  }

  // No executable body.
  return base('empty');
}

// ── Leaf walkers ────────────────────────────────────────────────────────────

function walkAgentLeaf(
  node: Node,
  agentPath: string,
  ctx: WalkContext,
  pv: PreviewNode,
): PreviewNode {
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);
  // Resolve the agent path (may itself be `${...}`).
  pv.agentPath = resolveAgentPath(agentPath, lookup);
  pv.kind = 'agent';
  // Resolve the prompt EXACTLY as runAgentPhase (resolveAgentInput) — the
  // byte-identical surface the parity test diffs.
  const unresolved = new Set<string>();
  const raw = node.prompt ?? ctx.input;
  resolveAgentInput(node, ctx.input, lookup, r => unresolved.add(r));
  const symbolizedText = symbolizeRefs(raw, ctx);
  const symbolic = unresolved.size > 0 || pv.agentPath.includes('${');
  pv.action = { verb: 'would prompt', text: symbolizedText };
  pv.symbolic = symbolic;
  if (node.as) pv.as = node.as;
  return pv;
}

function walkCodeLeaf(node: Node, ctx: WalkContext, pv: PreviewNode): PreviewNode {
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);
  if (node.code!.run) {
    const unresolved = new Set<string>();
    resolveCommand(node.code!.run, lookup, r => unresolved.add(r));
    pv.action = { verb: 'would run', text: symbolizeRefs(node.code!.run, ctx) };
    pv.symbolic = unresolved.size > 0;
    // Preflight gate: an orchestration containing ANY `code.run` node is HALTED
    // at run start (in ~0.1s) unless SAMMY_ALLOW_CODE_RUN=1 — the run never
    // reaches this phase. That's a harder failure than the generic "runs
    // outside the vm sandbox" lint suggests, so call it out explicitly. Preview
    // stays deterministic (it does not condition on the ambient env — the flag
    // is a run-time/server concern), so state the requirement unconditionally.
    pv.findings.push({
      severity: 'warning',
      code: 'code-run-preflight',
      message:
        `\`code.run\` (external shell) is gated: unless SAMMY_ALLOW_CODE_RUN=1 is ` +
        `set for the run, the executor HALTS at preflight in ~0.1s with "code.run ` +
        `is disabled" — the run never starts. Set the flag to enable it, or ` +
        `replace this node with an agent using the Bash tool (governed by the ` +
        `sandbox policy).`,
    });
  } else {
    // Inline JS — runs in a vm with no `${...}` interpolation of the source
    // body; its RETURN is runtime. Show a one-line note, no resolution.
    const src = (node.code!.source ?? '').replace(/\s+/g, ' ').trim();
    pv.action = {
      verb: 'would exec',
      text: src.length > 80 ? src.slice(0, 79) + '…' : src || '(inline JS)',
    };
    pv.symbolic = true; // the value it produces is runtime
  }
  if (node.as) pv.as = node.as;
  return pv;
}

// ── Composite walkers with control flow ─────────────────────────────────────

function walkSequence(phases: Node[], ctx: WalkContext, pv: PreviewNode): void {
  let cursor = ctx;
  for (const phase of phases) {
    const child = walkNode(phase, cursor);
    pv.children.push(child);
    // The phase's output becomes the next phase's runtime input — UNLESS this
    // phase produced no value preview could resolve, in which case downstream
    // `${input}` is symbolic. We model every upstream output as runtime
    // (matches the executor: an agent/code output is only known at run time).
    cursor = withSymbolicInput(
      cursor,
      `«output ← ${phase.name} (${child.kind})»`,
    );
  }
  pv.symbolic = pv.children.some(c => c.symbolic);
}

/**
 * Warn when a serial `phases` composite sets NO explicit `timeout` yet its
 * sub-phases' timeouts SUM past the wallclock cap it silently inherits (the
 * orchestration's `defaults.timeout`, else `DEFAULT_NODE_TIMEOUT_SEC` ~1800s).
 * The executor wraps the WHOLE composite in one `withTimeout(cap)`, so a long
 * serial sequence is torn down mid-run once the total exceeds that single cap:
 * an 11-sub-phase sequence dies around its fifth with "node timed out after
 * 1800s", having set no timeout anywhere. Only fires when the sum overruns the
 * cap (≥2 sub-phases): a composite whose sub-phase timeouts fit under the cap is
 * safe and stays quiet. Each sub-phase contributes its own `timeout` or, unset,
 * the same inherited cap (it would inherit the default too). */
function checkCompositeTimeout(
  node: Node,
  subPhases: Node[],
  ctx: WalkContext,
  pv: PreviewNode,
): void {
  if (node.timeout != null) return; // author set an explicit cap — their call
  if (subPhases.length < 2) return; // a single sub-phase isn't the serial pileup
  const cap = ctx.defaultTimeoutSec;
  const sum = subPhases.reduce(
    (acc, p) => acc + (typeof p.timeout === 'number' ? p.timeout : cap),
    0,
  );
  if (sum <= cap) return; // fits under the inherited cap — no pileup
  pv.findings.push({
    severity: 'warning',
    code: 'composite-no-timeout',
    message:
      `composite '${node.name}' has ${subPhases.length} serial sub-phases but no ` +
      `explicit \`timeout\` → the whole sequence inherits the ~${cap}s default cap; ` +
      `the sub-phase timeouts sum to ~${sum}s, so the composite will be torn down ` +
      `mid-sequence once the total passes ~${cap}s. Set an explicit \`timeout\` on ` +
      `'${node.name}' (≥ the expected total) or split the sequence.`,
  });
}

function walkSubflow(node: Node, ctx: WalkContext, pv: PreviewNode): PreviewNode {
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);
  // Resolve the (possibly parameterized) subflow name.
  const subName = resolveTemplate(node.subflow!, lookup);
  pv.action = { verb: 'would call', text: subName };

  if (node.subflow!.includes('${') && subName.includes('${')) {
    // Name references a runtime value → can't resolve which orchestration.
    pv.symbolic = true;
    pv.expansion = '(runtime name — not expanded)';
    pv.findings.push({
      severity: 'info',
      code: 'runtime-subflow',
      message: `subflow name "${node.subflow}" depends on a runtime value; the target can't be resolved at preview time.`,
    });
    return pv;
  }

  // Cycle detection — mirror dispatchNode's subflowStack check.
  if (ctx.subflowStack.includes(subName)) {
    const chain = [...ctx.subflowStack, subName].join(' → ');
    pv.findings.push({
      severity: 'error',
      code: 'cyclic-subflow',
      message: `circular subflow reference: ${chain}`,
    });
    pv.symbolic = true;
    return pv;
  }

  const sub = ctx.orchestrationByName.get(subName);
  if (!sub) {
    pv.findings.push({
      severity: 'error',
      code: 'missing-subflow',
      message: `subflow "${subName}" not found in the orchestration set.`,
    });
    pv.symbolic = true;
    return pv;
  }

  // Depth cap — show the node but don't expand the body.
  if (ctx.depth >= ctx.maxDepth) {
    pv.expansion = `(depth ${ctx.maxDepth} reached — not expanded)`;
    return pv;
  }

  // Seed the subflow's own vars as DEFAULTS (parent wins), mirroring
  // dispatchNode. Record the seeded bindings for the renderer.
  const subSeed: State = { ...(sub.vars ?? {}), ...stateDeclInitials(sub) };
  const childState: State = { ...ctx.state };
  const bindings: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(subSeed)) {
    if (!(k in childState)) {
      childState[k] = v;
      bindings.push({ key: k, value: String(v) });
    }
  }
  if (bindings.length > 0) pv.bindings = bindings;

  const childKnown = new Set(ctx.knownVars);
  for (const k of Object.keys(subSeed)) childKnown.add(k);

  const childCtx: WalkContext = {
    ...ctx,
    state: childState,
    knownVars: childKnown,
    subflowStack: [...ctx.subflowStack, subName],
    depth: ctx.depth + 1,
  };

  const subPhases = sub.phases;
  if (Array.isArray(subPhases) && subPhases.length > 0) {
    walkSequence(subPhases, childCtx, pv);
  } else {
    pv.children.push(walkNode(sub, childCtx));
    pv.symbolic = pv.children.some(c => c.symbolic);
  }
  return pv;
}

function walkRoute(node: Node, ctx: WalkContext, pv: PreviewNode): PreviewNode {
  pv.symbolic = true;
  pv.wouldRun = 'conditional';
  const branchKeys = Object.keys(node.route!.branches);
  pv.expansion = node.route!.router
    ? `router=${node.route!.router.split('/').pop()?.replace(/\.md$/, '')} → 1 of {${branchKeys.join(', ')}}`
    : `substring-match → 1 of {${branchKeys.join(', ')}}`;
  pv.findings.push({
    severity: 'info',
    code: 'runtime-branch',
    message: node.route!.router
      ? `route taken depends on the router agent's runtime verdict; all branches shown conditionally.`
      : `route taken depends on a runtime substring match; all branches shown conditionally.`,
  });
  for (const [key, branch] of Object.entries(node.route!.branches)) {
    const child = walkNode(branch, ctx);
    child.expansion = prefixExpansion(`[case ${key}]`, child.expansion);
    child.wouldRun = 'conditional';
    pv.children.push(child);
  }
  if (node.route!.default) {
    const child = walkNode(node.route!.default, ctx);
    child.expansion = prefixExpansion('[default]', child.expansion);
    child.wouldRun = 'conditional';
    pv.children.push(child);
  }
  return pv;
}

function walkSwitch(node: Node, ctx: WalkContext, pv: PreviewNode): PreviewNode {
  const sw = node.switch!;
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);
  // Is the switched-on value static? `on` resolves with no runtime ref, or `on`
  // is unset AND the upstream input is static (rare — usually runtime).
  const onIsRuntime =
    sw.on != null
      ? hasRuntimeRef(sw.on, ctx)
      : ctx.input.includes('«'); // upstream output is runtime

  if (!onIsRuntime) {
    // Resolve exactly as the executor (selectSwitchCase) and take the case.
    const unresolved: string[] = [];
    const { value, matched } = selectSwitchCase(sw, ctx.input, lookup, r => unresolved.push(r));
    // Same rule as the executor: an `on` base that names nothing fails the
    // run; a missing field falls to default (reported).
    const { missingBase, missingField } = classifyUnresolved(unresolved, lookup);
    if (missingBase.length > 0) {
      pv.findings.push({
        severity: 'error',
        code: 'switch-unresolved-base',
        message:
          `switch \`on\` reference(s) ${missingBase.map(r => '${' + r + '}').join(', ')} name nothing — ` +
          'the run would fail here instead of picking a case.',
      });
    } else if (missingField.length > 0) {
      pv.findings.push({
        severity: 'warning',
        code: 'switch-unresolved-field',
        message:
          `switch \`on\` field(s) ${missingField.map(r => '${' + r + '}').join(', ')} are missing — ` +
          'the run takes default.',
      });
    }
    const takenKey = missingBase.length > 0 ? null : (matched ?? (sw.default ? 'default' : null));
    pv.expansion = `on="${truncate(value, 40)}" → ${takenKey ?? '(no match!)'}`;
    if (takenKey === null && missingBase.length === 0) {
      pv.findings.push({
        severity: 'error',
        code: 'switch-no-match',
        message: `switch value "${truncate(value, 60)}" matches no case and there is no default — the run would error here.`,
      });
    }
    // Only the taken branch runs — show it resolved; show the others greyed
    // (wouldRun:false) so the reader sees what was NOT taken.
    for (const [key, branch] of Object.entries(sw.cases)) {
      const child = walkNode(branch, ctx);
      const taken = key === matched;
      child.wouldRun = taken ? child.wouldRun : false;
      child.expansion = prefixExpansion(
        taken ? `[case ${key} ✓]` : `[case ${key}]`,
        child.expansion,
      );
      pv.children.push(child);
    }
    if (sw.default) {
      const child = walkNode(sw.default, ctx);
      const taken = matched === null && takenKey === 'default';
      child.wouldRun = taken ? child.wouldRun : false;
      child.expansion = prefixExpansion(
        taken ? '[default ✓]' : '[default]',
        child.expansion,
      );
      pv.children.push(child);
    }
    pv.symbolic = pv.children.some(c => c.symbolic && c.wouldRun !== false);
    return pv;
  }

  // Runtime value → show all cases conditionally.
  pv.symbolic = true;
  pv.wouldRun = 'conditional';
  const onLabel = sw.on != null ? symbolizeRefs(sw.on, ctx) : '«upstream output»';
  pv.expansion = `on=${onLabel} → 1 of {${Object.keys(sw.cases).join(', ')}}`;
  pv.findings.push({
    severity: 'info',
    code: 'runtime-branch',
    message: `switch value (${onLabel}) is runtime; all cases shown conditionally.`,
  });
  for (const [key, branch] of Object.entries(sw.cases)) {
    const child = walkNode(branch, ctx);
    child.expansion = prefixExpansion(`[case ${key}]`, child.expansion);
    child.wouldRun = 'conditional';
    pv.children.push(child);
  }
  if (sw.default) {
    const child = walkNode(sw.default, ctx);
    child.expansion = prefixExpansion('[default]', child.expansion);
    child.wouldRun = 'conditional';
    pv.children.push(child);
  }
  return pv;
}

function walkMap(node: Node, ctx: WalkContext, pv: PreviewNode): PreviewNode {
  const cfg = node.map!;
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);

  // Try to resolve the array statically — exactly as the executor (resolveOver).
  // A runtime ref (bound to an `as`) throws / can't resolve → symbolic.
  let items: unknown[] | null = null;
  if (!hasRuntimeRef(cfg.over, ctx)) {
    try {
      items = resolveOver(cfg.over, lookup);
    } catch {
      items = null;
    }
  }

  if (items === null) {
    // Runtime array → one symbolic iteration.
    pv.symbolic = true;
    pv.expansion = `[× «${symbolizeRefs(cfg.over, ctx)}»]`;
    pv.findings.push({
      severity: 'info',
      code: 'runtime-branch',
      message: `\`map over\` ${symbolizeRefs(cfg.over, ctx)} is a runtime array; one symbolic iteration shown.`,
    });
    const itemCtx: WalkContext = {
      ...ctx,
      scope: { ...ctx.scope, item: '«item»', index: '«index»' },
      input: '«item»',
    };
    pv.children.push(walkNode(cfg.body, itemCtx));
    return pv;
  }

  // Static array → expand each item (respecting --depth for very wide maps).
  pv.expansion = `[× ${items.length}${cfg.serial ? ' serial' : cfg.concurrency ? ` ·≤${cfg.concurrency}` : ''}]`;
  const collapse = ctx.depth >= ctx.maxDepth && items.length > 1;
  const shown = collapse ? items.slice(0, 1) : items;
  for (let i = 0; i < shown.length; i++) {
    const item = items[i];
    const itemCtx: WalkContext = {
      ...ctx,
      scope: { ...ctx.scope, item, index: i },
      input: typeof item === 'string' ? item : JSON.stringify(item),
      depth: ctx.depth + 1,
    };
    const child = walkNode(cfg.body, itemCtx);
    child.expansion = prefixExpansion(
      `[${i}] item=${truncate(typeof item === 'string' ? item : JSON.stringify(item), 30)}`,
      child.expansion,
    );
    pv.children.push(child);
  }
  if (collapse) {
    pv.findings.push({
      severity: 'info',
      code: 'depth-collapsed',
      message: `${items.length} static iterations collapsed to 1 (depth ${ctx.maxDepth}); raise --depth to expand.`,
    });
  }
  pv.symbolic = pv.children.some(c => c.symbolic);
  return pv;
}

// ── Symbolic reference rendering ─────────────────────────────────────────────

/** True when `template` contains a `${ref}` whose base is NOT in the static
 *  known-name universe — i.e. it depends on a runtime `as` output (or is
 *  genuinely unbound). These are the refs preview can't resolve. */
function hasRuntimeRef(template: string, ctx: WalkContext): boolean {
  if (!template.includes('${')) return false;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(template)) !== null) {
    const ref = m[1].trim();
    if (ref.startsWith('connections:')) continue;
    const base = ref.split('.')[0].trim();
    if (!ctx.knownVars.has(base)) return true;
  }
  return false;
}

/**
 * Replace every `${ref}` in a template with either its resolved static value or
 * a symbolic placeholder, leaving prose intact. The result is the human-readable
 * action text:
 *   - a base bound to a runtime `as` → `«name ← producer-phase (kind)»`
 *   - a required-but-unset declared input → `«name: required, unset»`
 *   - a genuinely unbound base → `«name: unbound»`
 *   - a statically-known base → its concrete value (via the shared interpolate).
 */
function symbolizeRefs(template: string, ctx: WalkContext): string {
  if (!template.includes('${')) return template;
  const lookup = buildLookup(ctx.state, ctx.scope, ctx.input);
  return template.replace(REF_RE, (whole, exprRaw) => {
    const ref = String(exprRaw).trim();
    if (ref.startsWith('connections:')) return whole;
    const base = ref.split('.')[0].trim();
    // Statically resolvable (in state with a defined value) → resolve it.
    const resolved = resolveTemplate(`\${${ref}}`, lookup);
    if (resolved !== whole) return resolved;
    // Unresolved: classify.
    const producer = ctx.producers.get(base);
    if (producer) {
      return `«${ref} ← ${producer.phase} (${producer.kind})»`;
    }
    if (base === 'input') return '«input»';
    if (base === 'item' || base === 'index') return `«${ref}»`;
    if (ctx.knownVars.has(base)) {
      // A declared input / var that's known-but-unset at preview time.
      return `«${ref}: required, unset»`;
    }
    return `«${ref}: unbound»`;
  });
}

/** Render a single field (e.g. an a2a agentCard) to text + a symbolic flag. */
function renderField(
  template: string,
  ctx: WalkContext,
): { text: string; symbolic: boolean } {
  return {
    text: symbolizeRefs(template, ctx),
    symbolic: hasRuntimeRef(template, ctx),
  };
}

// ── Findings: static lint, surfaced inline ──────────────────────────────────

/**
 * Compute the structural findings preview surfaces inline, keyed by owning
 * phase name. Reuses `lintOrchestration` (the same checks that strengthen
 * load-time validation) for the warning-level structural lints, and adds the
 * unbound-exec-ref ERROR check that needs the resolution context (vars/inputs
 * supplied to THIS preview).
 */
function collectLintFindings(
  root: Node,
  knownVars: Set<string>,
  producers: Map<string, { phase: string; kind: PreviewKind }>,
): Map<string, PreviewFinding[]> {
  const byNode = new Map<string, PreviewFinding[]>();
  const add = (node: string | undefined, f: PreviewFinding) => {
    const key = node ?? root.name;
    const arr = byNode.get(key) ?? [];
    arr.push(f);
    byNode.set(key, arr);
  };

  // (a) + (c) + the decorative/unconsumed warnings come from lintOrchestration,
  // which now also runs them at load time. Map LintFinding → PreviewFinding.
  const lint: LintFinding[] = lintOrchestration(root);
  for (const f of lint) {
    add(f.node, { severity: f.level, code: f.code, message: f.message });
  }

  // (b) unbound-exec-ref (ERROR) — a `${ref}` in an EXECUTABLE field
  // (code.run / prompt) whose base binds to nothing GIVEN this preview's
  // resolution context: not reserved, not a known var/input, and not produced
  // by any `as` (so not even a runtime value). This is the literal-passthrough
  // gotcha — the ref would render as a stray `${...}` literal in something that
  // actually executes. (A base produced by an `as` is runtime, NOT an error —
  // it's shown symbolically.)
  walkForExecRefs(root, root.name, (owner, field, fieldKind) => {
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const reported = new Set<string>();
    while ((m = REF_RE.exec(field)) !== null) {
      const ref = m[1].trim();
      if (ref.startsWith('connections:')) continue;
      const base = ref.split('.')[0].trim();
      if (!base || reported.has(base)) continue;
      if (knownVars.has(base)) continue; // a var / input / reserved → fine
      if (producers.has(base)) continue; // a runtime `as` value → symbolic, not an error
      // Root `worktrees` bind `${worktrees.<name>.path|branch|base|repo}` at run start.
      if (
        base === 'worktrees' &&
        Array.isArray(root.worktrees) &&
        root.worktrees.some(w => w.name === ref.split('.')[1]?.trim())
      ) {
        continue;
      }
      reported.add(base);
      add(owner, {
        severity: 'error',
        code: 'unbound-exec-ref',
        message:
          `\${${ref}} in ${fieldKind} binds to nothing — no var, input, or \`as\` ` +
          `produces "${base}". It would render as the literal \`\${${ref}}\` in the ` +
          `${fieldKind === 'code.run' ? 'command' : 'prompt'} (the literal-passthrough gotcha). ` +
          `Supply it via --vars/--input, declare it in \`inputs\`, or bind it with an upstream \`as\`.`,
      });
    }
  });

  return byNode;
}

/** Visit every executable field (`code.run`, `prompt`) in the tree, with its
 *  owning node name + a field-kind label. */
function walkForExecRefs(
  node: Node,
  owner: string | undefined,
  visit: (owner: string | undefined, field: string, kind: 'code.run' | 'prompt') => void,
): void {
  const ctxName = node.name ?? owner;
  if (typeof node.prompt === 'string' && node.prompt.length > 0) {
    visit(ctxName, node.prompt, 'prompt');
  }
  if (node.code && typeof node.code.run === 'string' && node.code.run.length > 0) {
    visit(ctxName, node.code.run, 'code.run');
  }
  for (const child of childNodesOf(node)) walkForExecRefs(child, ctxName, visit);
}

// ── Producer collection (for symbolic `as` placeholders) ────────────────────

/** Map every `as`-bound name to the phase + kind that produces it, tree-wide.
 *  Mirrors how the executor's state is a flat run-wide namespace. */
function collectProducers(
  node: Node,
  into: Map<string, { phase: string; kind: PreviewKind }>,
): void {
  if (node.as && !into.has(node.as)) {
    into.set(node.as, { phase: node.name, kind: bodyKindOf(node) });
  }
  for (const child of childNodesOf(node)) collectProducers(child, into);
}

/** The body kind of a node, for the producer label / preview kind. */
function bodyKindOf(node: Node): PreviewKind {
  if (node.subflow) return 'subflow';
  if (node.agent) return 'agent';
  if (node.a2a) return 'a2a';
  if (node.code) return node.code.run ? 'code.run' : 'code';
  if (node.wait) return 'wait';
  if (node.http) return 'http';
  const ck = compositeKey(node);
  if (ck) return ck as PreviewKind;
  return 'empty';
}

/** Every child Node reachable through any composite kind — the same traversal
 *  the executor / validate use (excludes string-ref bodies). */
function childNodesOf(node: Node): Node[] {
  const out: Node[] = [];
  for (const arr of [node.phases, node.parallel, node.converge] as (Node[] | undefined)[]) {
    if (Array.isArray(arr)) for (const c of arr) out.push(c);
  }
  if (node.loop?.body) out.push(node.loop.body);
  if (node.map?.body) out.push(node.map.body);
  if (node.route?.branches) {
    for (const b of Object.values(node.route.branches)) out.push(b);
    if (node.route.default) out.push(node.route.default);
  }
  if (node.switch?.cases) {
    for (const b of Object.values(node.switch.cases)) out.push(b);
    if (node.switch.default) out.push(node.switch.default);
  }
  if (node.onError) out.push(node.onError);
  return out;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function stateDeclInitials(node: Node): State {
  const out: State = {};
  for (const [key, decl] of Object.entries(node.state ?? {})) {
    if (decl.initial !== undefined) out[key] = decl.initial;
    else if (decl.reducer === 'append') out[key] = [];
    else if (decl.reducer === 'merge') out[key] = {};
    else if (decl.reducer === 'increment') out[key] = 0;
  }
  return out;
}

function withSymbolicInput(ctx: WalkContext, input: string): WalkContext {
  return { ...ctx, input };
}

/** Compose the `when`-derived run state with the body's own. A statically-false
 *  `when` always wins (the executor skips the node outright). Otherwise the more
 *  uncertain of the two is kept, so an inherently-conditional body (route /
 *  runtime switch) stays conditional even under an absent / truthy `when`. */
function composeRunState(
  whenState: boolean | 'conditional',
  bodyState: boolean | 'conditional',
): boolean | 'conditional' {
  if (whenState === false) return false;
  if (whenState === 'conditional' || bodyState === 'conditional') return 'conditional';
  return bodyState;
}

function summarizeTriggers(node: Node): string[] {
  const out: string[] = [];
  for (const t of node.triggers ?? []) {
    const rec = t as unknown as Record<string, unknown>;
    const kind = String(rec.kind ?? 'trigger');
    if (kind === 'cron' && typeof rec.schedule === 'string') {
      out.push(`cron \`${rec.schedule}\``);
    } else if (kind === 'webhook' && typeof rec.path === 'string') {
      out.push(`webhook \`${rec.path}\``);
    } else {
      out.push(kind);
    }
  }
  return out;
}

function prefixExpansion(prefix: string, existing?: string): string {
  return existing ? `${prefix} ${existing}` : prefix;
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// ── Findings attachment + roll-up ───────────────────────────────────────────

function attachLintFindings(
  nodes: PreviewNode[],
  byNode: Map<string, PreviewFinding[]>,
): void {
  for (const n of nodes) {
    const extra = byNode.get(n.name);
    if (extra) {
      // De-dupe against findings the walk itself attached (same code+message).
      const seen = new Set(n.findings.map(f => `${f.code}:${f.message}`));
      for (const f of extra) {
        if (!seen.has(`${f.code}:${f.message}`)) n.findings.push(f);
      }
    }
    attachLintFindings(n.children, byNode);
  }
}

function rollUp(
  phases: PreviewNode[],
  rootFindings: PreviewFinding[],
): PreviewPlan['summary'] {
  let nPhases = 0;
  let subflows = 0;
  let agents = 0;
  let codeRun = 0;
  let errors = 0;
  let warnings = 0;

  const visit = (n: PreviewNode): void => {
    nPhases++;
    if (n.kind === 'subflow') subflows++;
    if (n.kind === 'agent') agents++;
    if (n.kind === 'code.run') codeRun++;
    for (const f of n.findings) {
      if (f.severity === 'error') errors++;
      else if (f.severity === 'warning') warnings++;
    }
    for (const c of n.children) visit(c);
  };
  for (const p of phases) visit(p);
  for (const f of rootFindings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
  }

  return { phases: nPhases, subflows, agents, codeRun, errors, warnings };
}

/** Does this plan have any error-level finding? Drives the CLI exit code. */
export function planHasErrors(plan: PreviewPlan): boolean {
  return plan.summary.errors > 0;
}
