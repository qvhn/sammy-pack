# Context engineering

The single biggest lever on agent output quality isn't the model or the prompt
wording — it's **what goes into the context window at each step**: the right
facts, scoped tightly, in the right order, and nothing else. Too much context is
as harmful as too little; it buries the signal, wastes the window, and invites the
model to fixate on noise.

sammy-pack is, in large part, a **context-engineering tool already** — every node
boundary is a decision about what the next agent sees. This doc names the
primitives that make that explicit, and the toolkit (agents + example patterns)
that ship for the three moves beyond the basics: **scope, compress, retrieve, and
remember.**

## The primitives you already have

| Primitive | What it does for context |
| --- | --- |
| **`prompt`** | The scoping primitive. A literal user-message override (interpolated) — set exactly what an agent receives instead of the raw predecessor output. `"prompt": "Decide from this brief alone:\n${brief}"` gives the agent the digest and *withholds* everything else. |
| **`as` + `${name}`** | Named state. Capture a node's output (`as: "spec"`) and hand-pick it downstream (`${spec}`) — curated handoffs instead of a growing transcript. |
| **declared `inputs`** | Pull external context in at the front: a ticket / doc / URL / file resolved to text and readable as `${name}` (incl. a memory store — see below). |
| **source adapters** (`jira-adapter`, `github-adapter`, MCP `tools`) | Pull structured context from live sources — the "small approach to context engineering" most flows need. |
| **`code`** | Deterministic context shaping (assemble/trim/format) at zero token cost — its vm sees `input`, `state`, `item`, `index`, `vars`. |

> Note: there is deliberately **no `context` decorator** — `prompt` + `as` already
> scope what an agent sees. Adding one would be redundant schema surface.

## The four moves (toolkit shipped)

### 1. Scope — give the agent the right context, not all of it
Use `prompt` to curate. As a flow grows past a handful of nodes, agents start
seeing accumulated upstream output they don't need. Scope each prompt to the few
`${vars}` that matter. This is the cheapest, highest-leverage move and needs no
new machinery.

### 2. Compress — `context-compactor`
Long orchestrations accumulate context. Capture the verbose phases with `as`, run
a **`context-compactor`** node to distill them into a tight, decision-ready brief
(load-bearing facts kept, verbosity dropped), then scope downstream prompts to
`${brief}` instead of the raw history. See **`examples/context-compaction.json`**.

### 3. Retrieve — `retriever`
Pull only the passages relevant to the task from a corpus / search results /
fetched docs / a source adapter — with citations — instead of passing the whole
haystack. The **`retriever`** agent does scoped selection; downstream agents (and
human gates) get focused, traceable context. See
**`examples/context-aware-triage.json`**, where retrieval is what makes a
duplicate-detection branch actually work: *a triage judge can't call something a
duplicate it was never shown.*

To retrieve from a **live source** rather than a pasted corpus, give the retriever
node `tools` (a Jira/GitHub search adapter, a docs/vector-search MCP, etc.) — same
mechanism as any source adapter. The orchestration is unchanged; only where the
corpus comes from differs. That keeps retrieval pluggable: a vector store is *one*
possible source you can wire in, never a dependency the engine forces on you.

### 4. Remember — `memory-reader` / `memory-writer`
Cross-run memory, modeled the sammy-pack way: **memory is a source you read at the
start of a run and write at the end.** `memory-reader` surfaces only the prior
learnings relevant to *this* task (scoped recall); `memory-writer` emits the
updated store (append the durable lesson, dedupe, prune). See
**`examples/memory-augmented-run.json`**.

A durable, file-backed store ships behind this: **`/api/memory/:key`**
(`src/server/memory-store.ts`) — `GET` returns `{ key, content, updatedAt }`
(empty content on a cold start, never a 404, so first runs just work), `PUT`
writes the updated store, `DELETE` clears it. The wiring is deliberately
caller-driven so the backing store stays pluggable (the file store is the
default; swap a DB/Notion/adapter without touching the orchestration):
`GET /api/memory/<key>` → pass `content` as the run's `memory` input → run →
`PUT /api/memory/<key>` with the final output. Each key is one namespace
(a component, a customer, a triage queue). This is what makes a system *compound*
instead of starting cold — and it's the durable home for the
calibration/override feedback that reactive pipelines generate (see
[`calibration.md`](./calibration.md)).

## Principles

- **Relevance over volume.** A handful of on-target passages beats a wall of text.
- **Preserve load-bearing values verbatim** — numbers, ids, quotes, criteria.
  Compress prose, never data.
- **Cite / attribute** retrieved and recalled context so a run is traceable to its
  sources (fits sammy-pack's git-auditable ethos).
- **Bound memory.** It's a curated set of lessons, not an append-only log — prune
  stale/superseded entries, and treat recalled memory as "true when written," not
  necessarily now.
- **An empty retrieval / cold start is honest.** Don't pad context to look thorough.

## What this deliberately is NOT

- **Not a heavyweight RAG / vector core.** Retrieval is a *pluggable node* (an
  agent that can read a source, including a vector store *if you configure one*) —
  never a dependency the engine forces on you.
- **Not a new schema layer.** Everything here composes from the primitives above.
  The toolkit is **agents + patterns**, not engine surgery.

## Toolkit reference

Agents (`agents/*.md`): `retriever` (scoped retrieval + citation),
`context-compactor` (lossless-where-it-matters compression), `memory-reader`
(scoped cross-run recall), `memory-writer` (bounded, deduped persistence).

Examples (`examples/*.json`): `context-aware-triage` (retrieval-augmented dedup),
`context-compaction` (compress mid-flow, scope downstream), `memory-augmented-run`
(read memory → work → write memory).
