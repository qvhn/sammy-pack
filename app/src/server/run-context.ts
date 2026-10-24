/**
 * run-context — load an orchestration + its agents + sibling orchestrations
 * from the workspace filesystem. Extracted from the Vite plugin (the first
 * step of executor-in-worker) so the standalone
 * worker can load the same context the server does, without HTTP.
 *
 * Factory form: bind the workspace dirs once, get back a `loadRunContext`
 * with the plugin's original signature so existing call sites are unchanged.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Node } from '../types';
import { collectAgentPaths } from '../validate';
import { childNodesOf } from '../lib/node-walk';

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type RunContext = {
  orchestration: Node;
  agents: Array<{ name: string; raw: string }>;
  orchestrations: Node[];
};

/** What a snapshot pins beyond its own tree — the `Node.__pinned` shape. */
export type PinnedClosure = NonNullable<Node['__pinned']>;

export type LoadRunContextOpts = {
  /**
   * Use THIS tree instead of the one on disk — the run's own
   * `orchestrationSnapshot`.
   *
   * Every resume path used to re-read `examples/<name>.json`, so a run
   * resumed against whatever the definition says TODAY, not the definition it
   * started under. `types.ts` promised the opposite in writing ("in-flight /
   * paused runs always resume against their snapshot, never a newer
   * definition") and nothing implemented it: the snapshot was written on
   * every run and read only to recover `notify` config.
   *
   * That is not a cosmetic gap. Replay keys are `scope + phase name`, so
   * between pause and resume: renaming a phase makes its recorded output
   * unreachable and silently re-executes it at full cost; renaming a
   * DIFFERENT phase into the old name makes it replay the first one's output;
   * inserting or reordering diverges the walk from the recorded history with
   * nothing comparing the two. With a 24h default gate TTL and multi-day
   * durable waits, "the definition changed while a run was paused" is the
   * normal case.
   *
   * When this is supplied, a MISSING file is also no longer fatal — which
   * additionally un-strands a run whose orchestration was renamed or deleted
   * while it was parked (previously the wait sweeper retried it forever and
   * no surface reported it stuck).
   *
   * The tree alone is not the whole definition. A run also executes the
   * subflows its tree names and the agent bodies its leaves dispatch to, and
   * both used to come from TODAY's disk on a resume even with the tree
   * pinned — so every failure mode above was fully intact for every phase
   * inside a subflow (the primary shape: router → per-component subflow),
   * and a resumed leg ran agent prompts the run had never run under. A fresh
   * load therefore attaches the reachable closure to the tree as `__pinned`
   * (see `Node.__pinned`); because every call site already persists
   * `orchestrationSnapshot: ctx.orchestration`, the closure rides along with
   * no call-site change. An override load reads it back and uses it IN PLACE
   * of disk for the names it holds, falling back to disk only for names it
   * does not (a `${dynamic}` subflow name, or a snapshot written before the
   * closure existed).
   */
  orchestrationOverride?: Node | null;
};

/**
 * The only thing `loadRunContext` may read by name is
 * `<examplesDir>/<name>.json`. A name is therefore a plain file basename —
 * never a path. Not every caller validates it: `/api/runs/start` runs
 * `isSafeName`, but the run-mirror endpoint stores a client-supplied
 * `orchestrationName` verbatim and every resume/fork path then hands the
 * stored name here, and the fork path persists whatever this returns as a
 * NEW run's snapshot (readable through GET /api/runs/:id). A name of
 * `../credentials` would have read the workspace credentials file as an
 * orchestration. Refuse separators and NUL at the loader — the one seam all
 * seven resume paths share — instead of trusting each caller to remember.
 * Spaces and the like are fine (the file just won't exist).
 */
export function isPlainName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/** Every orchestration a static `subflow:` in this tree names, transitively
 *  through the shared walker (so `switch` cases / `onStall.recover` count).
 *  `${dynamic}` names resolve from run state at dispatch and are skipped —
 *  the same test the executor's stall-window walk applies. */
function collectStaticSubflowNames(node: Node, into: Set<string>): void {
  if (typeof node.subflow === 'string' && !node.subflow.includes('${')) {
    into.add(node.subflow);
  }
  for (const child of childNodesOf(node)) collectStaticSubflowNames(child, into);
}

/** A copy fit for persisting inside a snapshot: the authored tree without
 *  the loader's own runtime keys. `__origin` is documented as never
 *  persisted (it is re-derived from the filesystem on every load), and a
 *  nested `__pinned` would be a stale closure inside a closure. */
function pinnableCopy(node: Node): Node {
  const copy: Node = { ...node };
  delete copy.__origin;
  delete copy.__pinned;
  return copy;
}

/**
 * The reachable closure of `root`: every agent body it (or any subflow it
 * reaches) dispatches to, and every subflow reachable by static name,
 * transitively. Bounded by construction — it is what THIS run can execute,
 * not the workspace — so the snapshot row stays proportional to the run.
 *
 * Subflow names resolve with the executor's precedence (an `imported`
 * orchestration shadows a `shipped` one of the same name; a same-tier
 * collision keeps the last read), so the closure pins exactly the tree a
 * fresh run would have resolved. A name with nothing on disk pins nothing:
 * dispatch fails for it the same way it would today.
 */
function pinClosure(
  root: Node,
  allOrch: Node[],
  allAgents: Array<{ name: string; raw: string }>,
): PinnedClosure {
  const byName = new Map<string, Node>();
  for (const o of allOrch) {
    const existing = byName.get(o.name);
    if (existing?.__origin === 'imported' && o.__origin !== 'imported') continue;
    byName.set(o.name, o);
  }
  const rawByAgent = new Map(allAgents.map(a => [a.name, a.raw]));
  const agents: Record<string, string> = {};
  const orchestrations: Record<string, Node> = {};
  // The root registers itself in the executor's by-name map, so a reference
  // back to it is a cycle the executor refuses at dispatch — not a pin.
  const seen = new Set<string>([root.name]);
  const queue: Node[] = [root];
  for (let tree = queue.pop(); tree; tree = queue.pop()) {
    for (const ref of collectAgentPaths(tree)) {
      // Parameterized paths resolve from run state at dispatch — unpinnable.
      if (ref.includes('${')) continue;
      // Agents are keyed `agents/<name>.md` on both sides (the executor's
      // agentByPath); anything else can never resolve, so there is nothing
      // to pin for it.
      const m = /^agents\/(.+)\.md$/.exec(ref);
      if (!m) continue;
      const raw = rawByAgent.get(m[1]);
      if (raw !== undefined) agents[m[1]] = raw;
    }
    const subNames = new Set<string>();
    collectStaticSubflowNames(tree, subNames);
    for (const name of subNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const sub = byName.get(name);
      if (!sub) continue;
      orchestrations[name] = pinnableCopy(sub);
      queue.push(sub);
    }
  }
  return { agents, orchestrations };
}

/** Read a snapshot's closure back, shape-checked: the row came from the
 *  store (and, before the mirror endpoint stopped accepting client
 *  snapshots, possibly from a client), so a malformed entry is dropped
 *  rather than handed to the executor. `null` ⇒ no closure (a snapshot
 *  written before closures existed) — disk for everything, as before. */
function readPinnedClosure(orch: Node): PinnedClosure | null {
  const p = orch.__pinned;
  if (!p || typeof p !== 'object') return null;
  const agents: Record<string, string> = {};
  if (p.agents && typeof p.agents === 'object') {
    for (const [name, raw] of Object.entries(p.agents)) {
      if (typeof raw === 'string') agents[name] = raw;
    }
  }
  const orchestrations: Record<string, Node> = {};
  if (p.orchestrations && typeof p.orchestrations === 'object') {
    for (const [name, node] of Object.entries(p.orchestrations)) {
      if (node && typeof node === 'object' && typeof node.name === 'string') {
        orchestrations[name] = node;
      }
    }
  }
  return { agents, orchestrations };
}

export function makeLoadRunContext(deps: {
  examplesDir: string;
  agentsDir: string;
}): (name: string, opts?: LoadRunContextOpts) => Promise<RunContext | null> {
  const { examplesDir, agentsDir } = deps;
  return async function loadRunContext(
    name: string,
    opts?: LoadRunContextOpts,
  ): Promise<RunContext | null> {
    // A server-created run always has a basename-safe name; one that is not
    // was forged through the mirror endpoint, so its pin is not trusted
    // either.
    if (!isPlainName(name)) return null;
    const pinned =
      opts?.orchestrationOverride &&
      typeof opts.orchestrationOverride === 'object'
        ? (opts.orchestrationOverride as Node)
        : null;
    const onDisk = (await readJsonFile(
      path.join(examplesDir, `${name}.json`),
    )) as Node | null;
    // The pin wins when present; the file is the fallback for runs recorded
    // before snapshots, and the only source for a fresh start.
    const orch = pinned ?? onDisk;
    if (!orch) return null;
    const allOrch: Node[] = [];
    const orchEntries = await fs
      .readdir(examplesDir)
      .catch(() => [] as string[]);
    for (const f of orchEntries) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(examplesDir, f);
      const parsed = (await readJsonFile(full)) as Node | null;
      if (!parsed) continue;
      // Tag provenance for subflow name-resolution precedence: a domain
      // orchestration is imported as a SYMLINK into examples/ (see the
      // workspace import endpoint's linkOrCopy), while a shipped example is a
      // real in-repo file. lstat (does NOT follow the link) distinguishes them
      // so an imported router deterministically shadows a same-named example.
      // Best-effort: a stat failure leaves origin unset (treated as shipped).
      const isLink = await fs
        .lstat(full)
        .then(s => s.isSymbolicLink())
        .catch(() => false);
      parsed.__origin = isLink ? 'imported' : 'shipped';
      allOrch.push(parsed);
    }
    const agentEntries = await fs
      .readdir(agentsDir)
      .catch(() => [] as string[]);
    const allAgents: Array<{ name: string; raw: string }> = [];
    for (const f of agentEntries) {
      if (!f.endsWith('.md')) continue;
      if (f.toLowerCase() === 'readme.md') continue;
      const raw = await fs
        .readFile(path.join(agentsDir, f), 'utf8')
        .catch(() => null);
      if (raw !== null) allAgents.push({ name: f.replace(/\.md$/, ''), raw });
    }
    if (!pinned) {
      // Fresh start: pin the closure onto the tree the caller is about to
      // persist as the run's snapshot. Always attached, even when empty, so
      // an override load can tell "nothing reachable" from "written before
      // closures existed".
      orch.__pinned = pinClosure(orch, allOrch, allAgents);
      return { orchestration: orch, agents: allAgents, orchestrations: allOrch };
    }
    const closure = readPinnedClosure(orch);
    if (!closure) {
      return { orchestration: orch, agents: allAgents, orchestrations: allOrch };
    }
    // Resume: the closure replaces disk for every name it holds. Today's copy
    // of a pinned name is EXCLUDED (not merely out-precedenced) so it can
    // never shadow the pin; disk fills in only what the closure could not
    // see — a `${dynamic}` subflow name, or an agent a dynamic subflow needs.
    const pinnedAgentNames = new Set(Object.keys(closure.agents));
    const pinnedOrchNames = new Set(Object.keys(closure.orchestrations));
    return {
      orchestration: orch,
      agents: [
        ...Object.entries(closure.agents).map(([n, raw]) => ({ name: n, raw })),
        ...allAgents.filter(a => !pinnedAgentNames.has(a.name)),
      ],
      orchestrations: [
        ...Object.values(closure.orchestrations),
        ...allOrch.filter(o => !pinnedOrchNames.has(o.name)),
      ],
    };
  };
}
