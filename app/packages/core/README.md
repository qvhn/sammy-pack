# sammy-pack

JSON-schema-driven multi-agent orchestration engine.

```bash
npm install sammy-pack
```

Walks a tree of composable phases — `agents`, `phases`, `parallel`,
`converge`, `loop`, `route`, `map`, `conversation`, `subflow`, `a2a` —
with per-node provider routing (Anthropic / OpenAI / Gemini), retries,
timeouts, budgets, sandbox policy, judges (with numeric thresholds),
and a pluggable durable run store (SQLite by default, Postgres via
`DATABASE_URL`).

## Quickstart — embed the engine

```ts
import {
  runOrchestration,
  streamFnFor,
  type Node,
} from 'sammy-pack';

const orchestration: Node = {
  name: 'pipeline',
  phases: [
    { name: 'plan',  agent: 'agents/planner.md' },
    { name: 'write', agent: 'agents/writer.md',
      provider: 'openai', model: 'gpt-4o-mini' },
  ],
};

for await (const ev of runOrchestration({
  orchestration,
  apiKey: '',
  model: 'claude-sonnet-4-6',
  streamFn: streamFnFor('anthropic', process.env.ANTHROPIC_API_KEY!)!,
  providerStreamFns: {
    openai: streamFnFor('openai', process.env.OPENAI_API_KEY!)!,
  },
  agentsOverride: [
    { name: 'planner', raw: '---\n---\nYou plan things.' },
    { name: 'writer',  raw: '---\n---\nYou write things.' },
  ],
  waitForApproval: async () => true,
  cancelled: { v: false },
})) {
  if (ev.type === 'phase-delta') process.stdout.write(ev.text);
}
```

`agentsOverride` is required when embedding — sammy-pack reads agent
markdown files from disk only in the bundled web app. Supply your own
list of `{ name, raw }` records.

## Per-node provider routing

Set `provider` on any node to route THAT phase to a specific LLM
provider; the rest of the orchestration keeps using the default.

```json
{ "name": "summarize", "agent": "agents/summarizer.md",
  "provider": "gemini", "model": "gemini-2.0-flash" }
```

Tool-use / subagents / MCP are Claude-specific features and silently
no-op on non-Anthropic providers in this first cut.

## Code-first authoring (TypeScript DSL)

Orchestrations are plain JSON, and JSON stays the canonical format — but
you can also author them in TypeScript with the builder DSL and compile
to the exact same objects. Zero runtime deps, nothing new at run time:
`build()` emits the JSON you could have written by hand; `compile()`
additionally runs the repo validator and throws on error findings
(warnings don't throw — read them via `validate()`).

The same orchestration, side by side:

```json
{
  "name": "summarize-report",
  "vars": { "tone": "concise" },
  "state": { "summaries": { "reducer": "append" } },
  "triggers": [{ "kind": "cron", "expr": "0 9 * * *" }],
  "phases": [
    {
      "name": "split",
      "code": { "source": "return JSON.parse(input).sections;" },
      "as": "sections"
    },
    {
      "name": "per-section",
      "map": {
        "over": "${sections}",
        "concurrency": 3,
        "body": {
          "name": "summarize",
          "agent": "agents/summarizer.md",
          "prompt": "Summarize in a ${tone} style: ${item}",
          "as": "summaries",
          "retry": { "times": 2, "backoff": "exponential" }
        }
      }
    },
    {
      "name": "refine",
      "loop": {
        "body": { "name": "draft", "agent": "agents/writer.md" },
        "maxIterations": 3,
        "judge": "agents/judge.md",
        "stopAtScore": 0.9
      }
    }
  ]
}
```

```ts
import {
  orchestration, agentPhase, codePhase, mapOver, loop, cronTrigger,
} from 'sammy-pack';

const flow = orchestration('summarize-report', {
  vars: { tone: 'concise' },
  state: { summaries: { reducer: 'append' } },
  triggers: [cronTrigger('0 9 * * *')],
}).phases(
  codePhase('split', 'return JSON.parse(input).sections;', { as: 'sections' }),
  mapOver('per-section', '${sections}',
    agentPhase('summarize', 'agents/summarizer.md', {
      prompt: 'Summarize in a ${tone} style: ${item}',
      as: 'summaries',
      retry: { times: 2, backoff: 'exponential' },
    }),
    { concurrency: 3 }),
  loop('refine', agentPhase('draft', 'agents/writer.md'), {
    maxIterations: 3,
    judge: 'agents/judge.md',
    stopAtScore: 0.9,
  }),
);

const json = flow.compile(); // validated plain Node — save it, run it
```

One factory per body kind — `agentPhase`, `agents`, `phases`,
`parallelNodes`, `converge`, `subflow`, `loop`, `conversation`, `route`,
`switchOn`, `mapOver`, `a2a`, `codePhase` — each returning a plain
`Node`, so factories nest and mix freely with hand-written JSON nodes.
`orchestration(name, rootOpts)` fixes the root-only configuration
(`vars`, `inputs`, `state`, `defaults`, `triggers`, `notify`,
`lifecycle`, `concurrency`, `autoApproveLocks`) and one body method
(`.phases(…)`, `.parallel(…)`, `.loop(…)`, …) supplies the root body.
Typed trigger shorthands ship too: `cronTrigger`, `webhookTrigger`,
`eventTrigger`, `deploymentTrigger`, `pollingTrigger`, `queueTrigger`.

Every decorator in the schema is an option — `retry`, `timeout`,
`stallTimeout`, `onError`, `onStall`, `when`, `halt`, `as`, `lock`,
`budget`, `sandbox`, `prompt`, `provider` / `model` / `effort`,
`credential(s)`, `tools` / `mcp` / `autoApproveTools`, `maxTurns`,
`maxAgentTokens`, `continueOnError`, `finally`, `idempotencyKey`,
`input` / `output` — and the schema is `additionalProperties: false`, so
the builder copies options through an allowlist: an unknown or misplaced
key (a body kind as an option, `vars` on a child, `merger` off a
`converge`) throws at the call site instead of leaking into the JSON.

## Public API

The full export list is in `src/index.ts`. Highlights:

- **Runtime:** `runOrchestration` (stream a run inline), `startRun` (fire a
  durable background run — with `subscribe` / `resume` / `cancel` / `isActive`),
  `PhaseChatQueue`, `RunPauseRequested`; types: `Node`, `RunEvent`, `StreamFn`.
- **Providers:** `streamFnFor`, `buildProviderRegistry`,
  `streamAnthropic`, `streamOpenAI`, `streamGemini`.
- **A2A:** `callRemoteA2aAgent`, `buildOrchestrationCard`,
  `buildRootCard`, `runEventToA2aStreamEvent`, `buildTaskFromRun`.
- **Pricing:** `costUsd`, `knownModel`.
- **Authoring DSL:** `orchestration` + one factory per body kind
  (`agentPhase` … `codePhase`), trigger shorthands, `BuilderError` /
  `CompileError`; see "Code-first authoring" above.
- **Validation:** `validateOrchestration`, `checkContract`,
  `checkSchema`.
- **Persistence:** `openRunStore`, `RunStore`, `importLegacyRunFiles`
  (concrete `SqliteRunStore` / `PostgresRunStore` are loaded lazily;
  `better-sqlite3` and `pg` are optional peer deps).
- **Budget:** `loadBudgetState`, `checkGateBreach`.
- **Sandbox policy:** `mergeSandbox`, `applyToolPolicy`,
  `resolvePermissionMode`, `checkDeniedCommand`.
- **Observability:** `buildOtlpTrace`.

## Build

```bash
npm run build
```

The full schema reference lives at the repo root in
`schema/orchestration.schema.json`; common composite shapes are
catalogued in `docs/patterns.md`.

## Run it from Claude Code

[`@sammy-pack/cli`](https://www.npmjs.com/package/@sammy-pack/cli) bundles a
Claude Code plugin + an MCP server over this engine, so you can drive
orchestrations from a Claude session — `sammy claude` launches Claude with the
engine wired in as tools, and runs land in the same durable store. See that
package for details.

## Status

Alpha. The runtime, types, providers, A2A client, and durable run store are
stable, and the package builds to a flat ESM bundle (`dist/index.js` +
`index.d.ts`) verified to import cleanly from a standalone install. Pin the
`0.1.0-alpha.x` line and follow the changelog.
