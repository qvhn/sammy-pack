/**
 * Code-first authoring DSL for sammy-pack orchestrations.
 *
 * Factory functions + a fluent root builder that COMPILE TO the existing
 * JSON format — plain objects satisfying the `Node` type and validating
 * against `schema/orchestration.schema.json`. Nothing here is a new
 * runtime: `build()` emits exactly the JSON you could have written by
 * hand, and `compile()` additionally runs the repo's own
 * `validateOrchestration` and throws on error-severity findings.
 *
 *   import { orchestration, agentPhase, codePhase, mapOver } from 'sammy-pack';
 *
 *   const flow = orchestration('summarize-report', {
 *     vars: { tone: 'concise' },
 *     state: { summaries: { reducer: 'append' } },
 *   }).phases(
 *     codePhase('split', "return JSON.parse(input).sections;", { as: 'sections' }),
 *     mapOver('per-section', '${sections}', agentPhase('summarize', 'agents/summarizer.md', {
 *       prompt: 'Summarize this section in a ${tone} style: ${item}',
 *       as: 'summaries',
 *     }), { concurrency: 3 }),
 *     agentPhase('collate', 'agents/editor.md'),
 *   );
 *
 *   const json = flow.compile();   // validated plain Node — ready to save/run
 *
 * Design rules:
 *  - Zero runtime deps; zero I/O. Pure object assembly.
 *  - The schema is `additionalProperties: false`, so every option is
 *    copied through an explicit allowlist — an unknown key THROWS
 *    instead of leaking into the emitted JSON.
 *  - Exactly one body kind per node is guaranteed by construction (each
 *    factory sets its own body) and re-checked by `compile()` for any
 *    hand-written raw child nodes mixed into the tree.
 *
 * ── Adding a body kind (e.g. a future `wait`) ─────────────────────────
 * Three small additions, nothing else:
 *   1. add the key to `BODY_KINDS` below;
 *   2. add a `wait(name, …, opts?)` factory following the pattern here;
 *   3. add the mirroring one-line `OrchestrationBuilder.wait(…)` method.
 * (Then export both from the package index.)
 */

import type {
  A2aBody,
  CodeBody,
  ConversationBody,
  CronTrigger,
  DeploymentTrigger,
  EventsTrigger,
  LoopBody,
  MapBody,
  Node,
  WaitBody,
  PollingTrigger,
  QueueTrigger,
  RouteBody,
  SwitchBody,
  WebhookTrigger,
} from '../../../src/types';
import {
  validateOrchestration,
  type ValidationError,
} from '../../../src/validate';

// ── Errors ───────────────────────────────────────────────────────────────

/** Thrown synchronously on builder misuse — an unknown option key, a body
 *  kind passed as an option, a missing/empty name. Fails at authoring time,
 *  before any JSON exists. */
export class BuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderError';
  }
}

/** Thrown by `compile()` when the built orchestration has error-severity
 *  findings from the repo validator (`validateOrchestration`). Warnings
 *  (e.g. a route without a default) do NOT throw — read them via
 *  `validate()`. */
export class CompileError extends Error {
  readonly findings: ValidationError[];
  constructor(findings: ValidationError[]) {
    const lines = findings.map(f => `  - ${f.path}: ${f.message}`);
    super(`orchestration failed to compile:\n${lines.join('\n')}`);
    this.name = 'CompileError';
    this.findings = findings;
  }
}

// ── Key allowlists (mirror schema/orchestration.schema.json exactly) ─────

/** The mutually-exclusive node body kinds. ONE per node. */
const BODY_KINDS = [
  'agent',
  'agents',
  'phases',
  'parallel',
  'converge',
  'subflow',
  'loop',
  'conversation',
  'route',
  'switch',
  'map',
  'a2a',
  'code',
  'wait',
] as const;

/** Decorator properties valid on ANY node (schema `$defs.node.properties`
 *  minus the body kinds, minus the allOf-restricted `tools`/`merger`, minus
 *  the root-only-by-convention block, minus the runtime-only `__origin`). */
const NODE_OPT_KEYS = [
  'description',
  'lock',
  'input',
  'output',
  'as',
  'when',
  'halt',
  'idempotencyKey',
  'onError',
  'timeout',
  'stallTimeout',
  'retry',
  'onStall',
  'budget',
  'mcp',
  'autoApproveTools',
  'subagents',
  'hooks',
  'maxThinkingTokens',
  'permissionMode',
  'prompt',
  'maxTurns',
  'maxAgentTokens',
  'continueOnError',
  'finally',
  'provider',
  'model',
  'effort',
  'credential',
  'credentials',
  'sandbox',
  '_layout',
] as const;

/** Root-only properties (read only off the orchestration root by the
 *  runtime), plus the allOf-restricted `tools` (requires `agent`) and
 *  `merger` (requires `converge`) so a root leaf/converge can use them. */
const ROOT_ONLY_KEYS = [
  'version',
  'vars',
  'inputs',
  'state',
  'defaults',
  'autoApproveLocks',
  'concurrency',
  'triggers',
  'notify',
  'lifecycle',
  'tools',
  'merger',
] as const;

const NODE_OPT_SET: ReadonlySet<string> = new Set(NODE_OPT_KEYS);
const AGENT_OPT_SET: ReadonlySet<string> = new Set([...NODE_OPT_KEYS, 'tools']);
const CONVERGE_OPT_SET: ReadonlySet<string> = new Set([
  ...NODE_OPT_KEYS,
  'merger',
]);
const ROOT_OPT_SET: ReadonlySet<string> = new Set([
  ...NODE_OPT_KEYS,
  ...ROOT_ONLY_KEYS,
]);
const BODY_KIND_SET: ReadonlySet<string> = new Set(BODY_KINDS);

// ── Option types (compile-time mirrors of the allowlists above) ──────────

/** Decorators accepted by every factory. */
export type NodeOpts = Pick<Node, (typeof NODE_OPT_KEYS)[number]>;

/** `agentPhase` additionally accepts `tools` (schema: tools ⇒ agent). */
export type AgentOpts = NodeOpts & Pick<Node, 'tools'>;

/** `converge` additionally accepts `merger` (schema: merger ⇒ converge). */
export type ConvergeOpts = NodeOpts & Pick<Node, 'merger'>;

/** Options accepted by `orchestration(name, opts)` — every decorator plus
 *  the root-only block (vars / inputs / state / defaults / autoApproveLocks /
 *  concurrency / triggers / notify / lifecycle) plus tools / merger for a
 *  root whose body is an agent leaf / converge. */
export type RootOpts = NodeOpts & Pick<Node, (typeof ROOT_ONLY_KEYS)[number]>;

/** Loop controls — everything on `LoopBody` except the body node itself
 *  (which is the factory's positional argument). */
export type LoopOpts = Omit<LoopBody, 'body'>;

/** Map controls, flattened into the options bag alongside decorators. */
export type MapOpts = Pick<MapBody, 'serial' | 'concurrency'>;

/** Route controls, flattened alongside decorators. */
export type RouteOpts = Pick<RouteBody, 'router' | 'default'>;

/** Switch controls, flattened alongside decorators. */
export type SwitchOpts = Pick<SwitchBody, 'on' | 'default'>;

/** A2A controls, flattened alongside decorators. */
export type A2aOpts = Pick<A2aBody, 'skill'>;

const LOOP_KEYS = [
  'maxIterations',
  'until',
  'whileOutput',
  'judge',
  'stopAtScore',
  'retryOnFailure',
  'maxFailures',
  'carryContext',
  'warmSession',
] as const;
const MAP_KEYS = ['serial', 'concurrency'] as const;
const ROUTE_KEYS = ['router', 'default'] as const;
const SWITCH_KEYS = ['on', 'default'] as const;
const A2A_KEYS = ['skill'] as const;

// ── Internals ────────────────────────────────────────────────────────────

function requireName(name: unknown, ctx: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BuilderError(`${ctx}: name must be a non-empty string`);
  }
  return name;
}

/** Copy `opts` onto `target`, allowing only `allowed` keys and dropping
 *  `undefined` values, so no extra key can ever leak into the emitted JSON
 *  (the schema is `additionalProperties: false`). Unknown keys THROW with a
 *  targeted message when the key is a body kind (two-bodies misuse). */
function assignOpts(
  target: Node,
  opts: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  ctx: string,
): void {
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      if (BODY_KIND_SET.has(key)) {
        throw new BuilderError(
          `${ctx}: "${key}" is a node body kind — a node has exactly one ` +
            `body, and this factory already set it. Build the ${key} node ` +
            `with its own factory instead.`,
        );
      }
      throw new BuilderError(
        `${ctx}: unknown option "${key}" (the schema is ` +
          `additionalProperties:false — it would be rejected). ` +
          `Valid options: ${[...allowed].sort().join(', ')}.`,
      );
    }
    (target as Record<string, unknown>)[key] = value;
  }
}

/** Split an options bag into kind-specific keys and the rest, dropping
 *  `undefined` values on both sides. */
function partition(
  opts: Record<string, unknown>,
  kindKeys: readonly string[],
): { picked: Record<string, unknown>; rest: Record<string, unknown> } {
  const kindSet = new Set<string>(kindKeys);
  const picked: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    if (kindSet.has(key)) picked[key] = value;
    else rest[key] = value;
  }
  return { picked, rest };
}

/** Deep-clone into a fresh plain-JSON object, so the emitted tree shares no
 *  references with builder inputs (mutating one never corrupts the other).
 *  Orchestrations are plain JSON by definition, so JSON cloning is exact. */
function toPlainJson(node: Node): Node {
  return JSON.parse(JSON.stringify(node)) as Node;
}

// ── Node factories (one per body kind) ───────────────────────────────────

/** Leaf agent phase: `{ name, agent, ...opts }`. */
export function agentPhase(
  name: string,
  agent: string,
  opts: AgentOpts = {},
): Node {
  const node: Node = { name: requireName(name, 'agentPhase'), agent };
  assignOpts(node, opts, AGENT_OPT_SET, `agentPhase("${name}")`);
  return node;
}

/** Sequential multi-agent leaf: `{ name, agents: [...] }`. */
export function agents(
  name: string,
  agentPaths: string[],
  opts: NodeOpts = {},
): Node {
  const node: Node = { name: requireName(name, 'agents'), agents: agentPaths };
  assignOpts(node, opts, NODE_OPT_SET, `agents("${name}")`);
  return node;
}

/** Sequential composite: `{ name, phases: [...] }`. */
export function phases(
  name: string,
  children: Node[],
  opts: NodeOpts = {},
): Node {
  const node: Node = { name: requireName(name, 'phases'), phases: children };
  assignOpts(node, opts, NODE_OPT_SET, `phases("${name}")`);
  return node;
}

/** Concurrent branches: `{ name, parallel: [...] }`. */
export function parallelNodes(
  name: string,
  branches: Node[],
  opts: NodeOpts = {},
): Node {
  const node: Node = {
    name: requireName(name, 'parallelNodes'),
    parallel: branches,
  };
  assignOpts(node, opts, NODE_OPT_SET, `parallelNodes("${name}")`);
  return node;
}

/** Concurrent branches whose outputs are merged (optionally by a `merger`
 *  agent): `{ name, converge: [...], merger? }`. */
export function converge(
  name: string,
  branches: Node[],
  opts: ConvergeOpts = {},
): Node {
  const node: Node = {
    name: requireName(name, 'converge'),
    converge: branches,
  };
  assignOpts(node, opts, CONVERGE_OPT_SET, `converge("${name}")`);
  return node;
}

/** Invoke another orchestration by name: `{ name, subflow: "other" }`. */
export function subflow(
  name: string,
  target: string,
  opts: NodeOpts = {},
): Node {
  const node: Node = { name: requireName(name, 'subflow'), subflow: target };
  assignOpts(node, opts, NODE_OPT_SET, `subflow("${name}")`);
  return node;
}

/** Refinement loop. Loop controls (`maxIterations`, `until`, `judge`,
 *  `retryOnFailure`, …) sit flat in the options bag next to decorators:
 *  `loop('refine', draft, { maxIterations: 5, until: 'APPROVED' })`. */
export function loop(
  name: string,
  body: Node,
  opts: LoopOpts & NodeOpts,
): Node {
  const { picked, rest } = partition(opts, LOOP_KEYS);
  const node: Node = {
    name: requireName(name, 'loop'),
    loop: { body, ...picked } as LoopBody,
  };
  assignOpts(node, rest, NODE_OPT_SET, `loop("${name}")`);
  return node;
}

/** Alternating-turn dialogue between agents. */
export function conversation(
  name: string,
  participants: string[],
  rounds: number,
  opts: NodeOpts = {},
): Node {
  const body: ConversationBody = { participants, rounds };
  const node: Node = {
    name: requireName(name, 'conversation'),
    conversation: body,
  };
  assignOpts(node, opts, NODE_OPT_SET, `conversation("${name}")`);
  return node;
}

/** LLM-classified (or substring-matched) branching:
 *  `route('triage', { bug: fix, feature: build }, { router: 'agents/triage.md', default: ask })`. */
export function route(
  name: string,
  branches: Record<string, Node>,
  opts: RouteOpts & NodeOpts = {},
): Node {
  const { picked, rest } = partition(opts, ROUTE_KEYS);
  const node: Node = {
    name: requireName(name, 'route'),
    route: { branches, ...picked } as RouteBody,
  };
  assignOpts(node, rest, NODE_OPT_SET, `route("${name}")`);
  return node;
}

/** Deterministic value switch:
 *  `switchOn('verdict', { pass: ship, fail: report }, { on: '${verdict}', default: report })`. */
export function switchOn(
  name: string,
  cases: Record<string, Node>,
  opts: SwitchOpts & NodeOpts = {},
): Node {
  const { picked, rest } = partition(opts, SWITCH_KEYS);
  const node: Node = {
    name: requireName(name, 'switchOn'),
    switch: { cases, ...picked } as SwitchBody,
  };
  assignOpts(node, rest, NODE_OPT_SET, `switchOn("${name}")`);
  return node;
}

/** Fan-out over an array:
 *  `mapOver('each-item', '${items}', worker, { concurrency: 3 })`. */
export function mapOver(
  name: string,
  over: string,
  body: Node,
  opts: MapOpts & NodeOpts = {},
): Node {
  const { picked, rest } = partition(opts, MAP_KEYS);
  const node: Node = {
    name: requireName(name, 'mapOver'),
    map: { over, body, ...picked } as MapBody,
  };
  assignOpts(node, rest, NODE_OPT_SET, `mapOver("${name}")`);
  return node;
}

/** Outbound call to a remote A2A agent by agent-card URL. */
export function a2a(
  name: string,
  agentCard: string,
  opts: A2aOpts & NodeOpts = {},
): Node {
  const { picked, rest } = partition(opts, A2A_KEYS);
  const node: Node = {
    name: requireName(name, 'a2a'),
    a2a: { agentCard, ...picked } as A2aBody,
  };
  assignOpts(node, rest, NODE_OPT_SET, `a2a("${name}")`);
  return node;
}

/** Deterministic non-LLM transform. A string is inline JS (`code.source`,
 *  vm-sandboxed); pass `{ run: '…' }` explicitly for the opt-in external
 *  shell form. */
export function codePhase(
  name: string,
  code: string | CodeBody,
  opts: NodeOpts = {},
): Node {
  const body: CodeBody = typeof code === 'string' ? { source: code } : code;
  const node: Node = { name: requireName(name, 'codePhase'), code: body };
  assignOpts(node, opts, NODE_OPT_SET, `codePhase("${name}")`);
  return node;
}

/** Durable timer / external-signal park (zero cost while parked). Exactly
 *  one of `seconds` / `until` / `signal`; `timeoutSeconds` only with
 *  `signal`. On the server an unelapsed wait snapshot-pauses like a lock
 *  gate and is resumed by the wait sweeper / POST /api/runs/:id/signal. */
export function waitPhase(
  name: string,
  wait: WaitBody,
  opts: NodeOpts = {},
): Node {
  const keys = ['seconds', 'until', 'signal'].filter(
    k => (wait as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length !== 1) {
    throw new BuilderError(
      `waitPhase("${name}"): exactly one of seconds / until / signal is ` +
        `required (got ${keys.length === 0 ? 'none' : keys.join(' + ')})`,
    );
  }
  if (wait.timeoutSeconds !== undefined && wait.signal === undefined) {
    throw new BuilderError(
      `waitPhase("${name}"): timeoutSeconds is only valid with a signal wait`,
    );
  }
  const allowed = new Set(['seconds', 'until', 'signal', 'timeoutSeconds']);
  for (const k of Object.keys(wait)) {
    if (!allowed.has(k)) {
      throw new BuilderError(`waitPhase("${name}"): unknown wait key "${k}"`);
    }
  }
  const node: Node = { name: requireName(name, 'waitPhase'), wait: { ...wait } };
  assignOpts(node, opts, NODE_OPT_SET, `waitPhase("${name}")`);
  return node;
}

// ── Trigger helpers (typed shorthands for the root `triggers` array) ─────

export function cronTrigger(expr: string): CronTrigger {
  return { kind: 'cron', expr };
}

export function webhookTrigger(
  path: string,
  opts: { method?: 'GET' | 'POST'; signed?: boolean } = {},
): WebhookTrigger {
  const t: WebhookTrigger = { kind: 'webhook', path };
  if (opts.method !== undefined) t.method = opts.method;
  if (opts.signed !== undefined) t.signed = opts.signed;
  return t;
}

export function eventTrigger(
  event: string,
  opts: { signed?: boolean } = {},
): EventsTrigger {
  const t: EventsTrigger = { kind: 'events', event };
  if (opts.signed !== undefined) t.signed = opts.signed;
  return t;
}

export function deploymentTrigger(
  environment: string,
  opts: { signed?: boolean } = {},
): DeploymentTrigger {
  const t: DeploymentTrigger = { kind: 'deployment', environment };
  if (opts.signed !== undefined) t.signed = opts.signed;
  return t;
}

export function pollingTrigger(
  source: string,
  intervalSeconds: number,
): PollingTrigger {
  return { kind: 'polling', source, intervalSeconds };
}

export function queueTrigger(
  queue: string,
  opts: { signed?: boolean } = {},
): QueueTrigger {
  const t: QueueTrigger = { kind: 'queue', queue };
  if (opts.signed !== undefined) t.signed = opts.signed;
  return t;
}

// ── Root builder ─────────────────────────────────────────────────────────

/** The finished handle a body method returns. `build()` / `toJSON()` emit
 *  the plain orchestration object (a fresh deep clone each call);
 *  `validate()` returns the repo validator's raw findings; `compile()`
 *  emits AND throws `CompileError` on error-severity findings. */
export type CompiledOrchestration = {
  build(): Node;
  toJSON(): Node;
  validate(): ValidationError[];
  compile(): Node;
};

function makeCompiled(node: Node): CompiledOrchestration {
  const build = () => toPlainJson(node);
  return {
    build,
    toJSON: build,
    validate: () => validateOrchestration(build()),
    compile: () => {
      const out = build();
      const errors = validateOrchestration(out).filter(
        f => f.severity === 'error',
      );
      if (errors.length > 0) throw new CompileError(errors);
      return out;
    },
  };
}

/** Fluent root builder. `orchestration(name, rootOpts)` fixes the root's
 *  name + root-only configuration; calling exactly one body method (one per
 *  body kind) supplies the root body and returns the finished
 *  {@link CompiledOrchestration}. */
export class OrchestrationBuilder {
  private readonly rootName: string;
  private readonly rootOpts: Record<string, unknown>;

  constructor(name: string, opts: RootOpts = {}) {
    this.rootName = requireName(name, 'orchestration');
    // Validate the root options EAGERLY so a bad key fails at the
    // `orchestration(...)` call site, not later at the body method.
    const probe: Node = { name: this.rootName };
    assignOpts(
      probe,
      opts as Record<string, unknown>,
      ROOT_OPT_SET,
      `orchestration("${name}")`,
    );
    this.rootOpts = opts as Record<string, unknown>;
  }

  private finish(node: Node): CompiledOrchestration {
    assignOpts(
      node,
      this.rootOpts,
      ROOT_OPT_SET,
      `orchestration("${this.rootName}")`,
    );
    return makeCompiled(node);
  }

  agent(path: string): CompiledOrchestration {
    return this.finish(agentPhase(this.rootName, path));
  }
  agents(agentPaths: string[]): CompiledOrchestration {
    return this.finish(agents(this.rootName, agentPaths));
  }
  phases(...children: Node[]): CompiledOrchestration {
    return this.finish(phases(this.rootName, children));
  }
  parallel(...branches: Node[]): CompiledOrchestration {
    return this.finish(parallelNodes(this.rootName, branches));
  }
  converge(...branches: Node[]): CompiledOrchestration {
    return this.finish(converge(this.rootName, branches));
  }
  subflow(target: string): CompiledOrchestration {
    return this.finish(subflow(this.rootName, target));
  }
  loop(body: Node, opts: LoopOpts): CompiledOrchestration {
    return this.finish(loop(this.rootName, body, opts));
  }
  conversation(participants: string[], rounds: number): CompiledOrchestration {
    return this.finish(conversation(this.rootName, participants, rounds));
  }
  route(
    branches: Record<string, Node>,
    opts: RouteOpts = {},
  ): CompiledOrchestration {
    return this.finish(route(this.rootName, branches, opts));
  }
  switch(
    cases: Record<string, Node>,
    opts: SwitchOpts = {},
  ): CompiledOrchestration {
    return this.finish(switchOn(this.rootName, cases, opts));
  }
  map(over: string, body: Node, opts: MapOpts = {}): CompiledOrchestration {
    return this.finish(mapOver(this.rootName, over, body, opts));
  }
  a2a(agentCard: string, opts: A2aOpts = {}): CompiledOrchestration {
    return this.finish(a2a(this.rootName, agentCard, opts));
  }
  code(code: string | CodeBody): CompiledOrchestration {
    return this.finish(codePhase(this.rootName, code));
  }
  wait(wait: WaitBody): CompiledOrchestration {
    return this.finish(waitPhase(this.rootName, wait));
  }
}

/** Entry point: start an orchestration. Root-only configuration (vars /
 *  state / inputs / defaults / triggers / notify / lifecycle / concurrency /
 *  autoApproveLocks) goes in `opts`; then call exactly one body method:
 *
 *    orchestration('summarize-report', { vars: { tone: 'concise' } })
 *      .phases(stepA, stepB)
 *      .compile();
 */
export function orchestration(
  name: string,
  opts: RootOpts = {},
): OrchestrationBuilder {
  return new OrchestrationBuilder(name, opts);
}
