/**
 * LIFECYCLE CASE — A RESUME RUNS THE DEFINITION IT STARTED UNDER.
 *
 * `types.ts` promised this in writing: "the full orchestrationSnapshot is the
 * byte-level pin … in-flight/paused runs always resume against their snapshot,
 * never a newer definition." Nothing implemented it. Every resume path called
 * `loadRunContext(stored.orchestrationName)`, which re-reads
 * `examples/<name>.json` from disk, and the snapshot — written on every single
 * run — was read only to recover `notify` config.
 *
 * Why it matters rather than being tidiness: replay keys are
 * `scope + phase name`. Between pause and resume,
 *
 *   - renaming a phase makes its recorded output unreachable, so the phase
 *     silently RE-EXECUTES at full cost (and repeats its side effects);
 *   - renaming a different phase INTO the old name makes it replay the first
 *     one's output — silently wrong data, no error, no warning;
 *   - inserting or reordering diverges the walk from the recorded history with
 *     nothing comparing the two.
 *
 * With a 24h default gate TTL and multi-day durable waits, "someone edited the
 * orchestration while a run was paused" is the ordinary case, not an edge one.
 *
 * These tests mutate the orchestration FILE while a run is parked — the thing
 * that actually happens in a workspace — and assert the resumed leg ignores it.
 *
 * The second half covers what pinning the TREE alone left open: the subflows
 * the tree names and the agent bodies its leaves dispatch to were still read
 * from today's disk on every resume, so every failure above was intact for
 * every phase inside a subflow, and a resumed leg ran agent prompts the run
 * had never run under. The loader now pins that closure (`__pinned`) into the
 * same snapshot; the cases mutate the SUBFLOW file and the AGENT file
 * mid-pause. Then the seventh resume path (the MCP `resume_run` tool) and the
 * trust boundary the pin moved (a client-supplied snapshot on the run-mirror
 * endpoint, which /resume would now execute).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  eventsOfType,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  resumeRun,
  startRun,
  approveGate,
  waitFor,
  waitForRun,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { makeLoadRunContext } from '../src/server/run-context';
import { SqliteRunStore } from '../src/server/db';
import { buildMcpServer } from '../packages/cli/src/mcp';
import * as sdkStreamModule from '../src/server/sdk-stream';
import type { Node } from '../src/types';

// The agent-prompt case needs to see the system prompt the resumed leg
// dispatched with. The real stack is kept end to end (mount, store, executor,
// run-runner's buildServerStreamFn); only the Claude Agent SDK call at the
// very bottom is replaced by a recorder that answers like a one-turn agent.
// Every other case here is code.source-only and never reaches it.
// (Written without spread / async syntax: Babel would inject helpers the
// hoisted factory is not allowed to reference.)
jest.mock('../src/server/sdk-stream', () => {
  const actual = jest.requireActual('../src/server/sdk-stream');
  const systemPrompts: string[] = [];
  const streamSdk = (params: { systemPrompt?: string }) => {
    systemPrompts.push(params.systemPrompt ?? '');
    const chunks: unknown[] = [
      { type: 'text-delta', text: 'agent-said' },
      { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    let i = 0;
    const iterator = {
      next: () =>
        Promise.resolve(
          i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true },
        ),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  };
  return Object.assign({}, actual, { __systemPrompts: systemPrompts, streamSdk });
});
const recordedSystemPrompts = (
  sdkStreamModule as unknown as { __systemPrompts: string[] }
).__systemPrompts;

// `openRunStore` opens its backend through a dynamic import the jest runtime
// can't resolve (the same reason the lifecycle harness injects a
// directly-constructed store into mountSammyApi). The MCP server has no
// injection seam, so give it the same store the harness uses; everything
// else in the module stays real.
jest.mock('../src/server/run-store', () => {
  const actual = jest.requireActual('../src/server/run-store');
  const Sqlite = jest.requireActual('../src/server/db').SqliteRunStore;
  const openRunStore = (root: string) => {
    const store = new Sqlite(root);
    return store.init().then(() => store);
  };
  return Object.assign({}, actual, { openRunStore });
});

jest.setTimeout(60_000);

const ORCH = 'snapshot-pin';

/** Rewrite the orchestration on disk, the way an author or a git pull would. */
async function rewrite(
  tmpRoot: string,
  node: Record<string, unknown> & { name: string },
): Promise<void> {
  await fs.writeFile(
    path.join(tmpRoot, 'examples', `${node.name}.json`),
    JSON.stringify(node, null, 2) + '\n',
    'utf8',
  );
}

/** Write an agent markdown into the workspace's agents/ dir (the directory
 *  loadRunContext reads; referenced from a leaf as `agents/<name>.md`). */
async function writeAgent(
  tmpRoot: string,
  name: string,
  body: string,
): Promise<void> {
  const dir = path.join(tmpRoot, 'agents');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), body, 'utf8');
}

const original = {
  name: ORCH,
  phases: [
    { name: 'first', code: { source: "return 'ORIGINAL-first';" } },
    { name: 'gate', code: { source: "return 'gated';" }, lock: true },
    { name: 'last', code: { source: "return 'ORIGINAL-last';" } },
  ],
};

describe('lifecycle: resume is pinned to the run’s own snapshot', () => {
  let restoreEnv: () => void;
  let tmpRoot: string;
  let mount: Mount;

  beforeEach(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('snapshot-pin');
    await writeOrchestration(tmpRoot, original);
    mount = await mountServer(tmpRoot);
  });

  afterEach(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('a phase renamed mid-pause does NOT re-execute the completed one', async () => {
    const started = await startRun(mount.baseUrl, ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    // The edit: rename the COMPLETED phase. Against today's file its recorded
    // output is unreachable by replay key, so an unpinned resume re-runs it.
    await rewrite(tmpRoot, {
      name: ORCH,
      phases: [
        { name: 'first-renamed', code: { source: "return 'EDITED-first';" } },
        { name: 'gate', code: { source: "return 'gated';" }, lock: true },
        { name: 'last', code: { source: "return 'ORIGINAL-last';" } },
      ],
    });

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);

    const ends = eventsOfType(done, 'phase-end').map(e => ({
      phase: String(e.phaseName),
      output: String(e.output ?? ''),
    }));
    // NOTE: `first` appears twice by design — the resumed leg re-walks the
    // tree and REPLAYS the completed leaf from its checkpoint, which emits a
    // phase-end carrying the cached output. The question this test answers is
    // whether that second one is a cheap replay of the original or a
    // re-execution of the edited file.
    expect([...new Set(ends.map(e => e.phase))]).toEqual([
      'first',
      'gate',
      'last',
    ]);
    // The pin: the edited file never ran, and every `first` carries the
    // ORIGINAL output rather than the rewritten one.
    expect(JSON.stringify(ends)).not.toContain('EDITED');
    for (const e of ends.filter(x => x.phase === 'first')) {
      expect(e.output).toBe('ORIGINAL-first');
    }
    // The renamed phase from the edited file is absent entirely.
    expect(ends.map(e => e.phase)).not.toContain('first-renamed');
  });

  it('a phase renamed INTO the completed one’s name cannot inherit its output', async () => {
    const started = await startRun(mount.baseUrl, ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    // The nastiest edit: `last` takes over the name `first`. Unpinned, the
    // replay table is keyed by name, so the NEW phase would hand back the OLD
    // phase's output — wrong data, silently, with no error anywhere.
    await rewrite(tmpRoot, {
      name: ORCH,
      phases: [
        { name: 'gate', code: { source: "return 'gated';" }, lock: true },
        { name: 'first', code: { source: "return 'EDITED-impostor';" } },
      ],
    });

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);

    const ends = eventsOfType(done, 'phase-end').map(e => String(e.output ?? ''));
    expect(ends).toContain('ORIGINAL-first');
    expect(ends).toContain('ORIGINAL-last');
    expect(JSON.stringify(ends)).not.toContain('impostor');
  });

  it('resumes a run whose orchestration was DELETED while it was paused', async () => {
    // Previously terminal: `loadRunContext` returned null, resume answered
    // "orchestration not found", and a parked run was stranded permanently
    // while still holding its concurrency group. The snapshot is sufficient
    // to finish it.
    const started = await startRun(mount.baseUrl, ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    await fs.rm(path.join(tmpRoot, 'examples', `${ORCH}.json`));

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);
    expect([
      ...new Set(eventsOfType(done, 'phase-end').map(e => String(e.phaseName))),
    ]).toEqual(['first', 'gate', 'last']);
    expect(String(done.lastOutput)).toContain('ORIGINAL-last');
  });

  it('a FRESH start still reads the current file, not any snapshot', async () => {
    // The pin must not freeze authoring: editing an orchestration and starting
    // a NEW run has to pick up the edit.
    await rewrite(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'only', code: { source: "return 'EDITED-fresh';" } }],
    });
    const started = await startRun(mount.baseUrl, ORCH);
    const done = await waitForRun(mount.baseUrl, started.id!, ['done']);
    expect(done.lastOutput).toContain('EDITED-fresh');
  });

  // ─── The closure: subflows + agent bodies ────────────────────────────────
  // The pin stopped at the subflow boundary. `loadRunContext` pinned the tree
  // but built the subflow set and the agent list from TODAY's disk, and
  // run-runner wired both straight into the executor — so everything the
  // tree pin fixed was fully intact one level down, where the project's
  // primary shape (router → per-component subflow) does its work.

  const SUB_ORCH = 'snapshot-pin-sub';
  const LEG = 'pinned-leg'; // runs BEFORE the gate → replayed on resume
  const TAIL = 'pinned-tail'; // runs AFTER the gate → executed on resume

  async function writeSubflowShape(): Promise<void> {
    await writeOrchestration(tmpRoot, {
      name: SUB_ORCH,
      phases: [
        { name: 'inner', subflow: LEG },
        { name: 'gate', code: { source: "return 'gated';" }, lock: true },
        { name: 'outer', subflow: TAIL },
      ],
    });
    await writeOrchestration(tmpRoot, {
      name: LEG,
      phases: [{ name: 's1', code: { source: "return 'ORIGINAL-s1';" } }],
    });
    await writeOrchestration(tmpRoot, {
      name: TAIL,
      phases: [{ name: 't1', code: { source: "return 'ORIGINAL-t1';" } }],
    });
  }

  it('a phase renamed inside a SUBFLOW mid-pause is replayed from the original, and an edited not-yet-run subflow runs as pinned', async () => {
    await writeSubflowShape();
    const started = await startRun(mount.baseUrl, SUB_ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    // Both edits land in SUBFLOW files; the root tree is untouched, so the
    // tree pin alone sees nothing to protect.
    await rewrite(tmpRoot, {
      name: LEG,
      phases: [
        { name: 's1-renamed', code: { source: "return 'EDITED-s1';" } },
      ],
    });
    await rewrite(tmpRoot, {
      name: TAIL,
      phases: [{ name: 't1', code: { source: "return 'EDITED-t1';" } }],
    });

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);

    const ends = eventsOfType(done, 'phase-end').map(e => ({
      phase: String(e.phaseName),
      output: String(e.output ?? ''),
    }));
    // The completed subflow leaf is REPLAYED from its checkpoint under its
    // original name; the renamed one from today's file never exists.
    expect(ends.map(e => e.phase)).toContain('s1');
    expect(ends.map(e => e.phase)).not.toContain('s1-renamed');
    for (const e of ends.filter(x => x.phase === 's1')) {
      expect(e.output).toBe('ORIGINAL-s1');
    }
    // The subflow the resumed leg EXECUTES runs the body the run started
    // under, not the edit.
    expect(ends.find(e => e.phase === 't1')?.output).toBe('ORIGINAL-t1');
    expect(JSON.stringify(ends)).not.toContain('EDITED');
  });

  it('a SUBFLOW file deleted mid-pause still completes', async () => {
    // Proven before the closure: a pinned run whose subflow file was deleted
    // now LOADED (un-stranded by the tree pin) and then died at its first
    // subflow with "not found". The closure carries the subflow bodies.
    await writeSubflowShape();
    const started = await startRun(mount.baseUrl, SUB_ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    await fs.rm(path.join(tmpRoot, 'examples', `${LEG}.json`));
    await fs.rm(path.join(tmpRoot, 'examples', `${TAIL}.json`));

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);
    expect(done.status).toBe('done');
    const outputs = eventsOfType(done, 'phase-end').map(e => String(e.output ?? ''));
    expect(outputs).toContain('ORIGINAL-s1');
    expect(outputs).toContain('ORIGINAL-t1');
    expect(eventsOfType(done, 'phase-error')).toHaveLength(0);
  });

  it('an AGENT prompt edited mid-pause: the resumed leg dispatches the ORIGINAL prompt', async () => {
    const AGENT_ORCH = 'snapshot-pin-agent';
    await writeAgent(tmpRoot, 'pinned-voice', 'You are ORIGINAL-voice.');
    await writeOrchestration(tmpRoot, {
      name: AGENT_ORCH,
      phases: [
        { name: 'first', code: { source: "return 'ORIGINAL-first';" } },
        { name: 'gate', code: { source: "return 'gated';" }, lock: true },
        { name: 'speak', agent: 'agents/pinned-voice.md' },
      ],
    });
    const before = recordedSystemPrompts.length;
    const started = await startRun(mount.baseUrl, AGENT_ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);

    // The edit: the agent file, not the orchestration. The tree pin is
    // byte-identical before and after; only the closure sees this.
    await writeAgent(tmpRoot, 'pinned-voice', 'You are EDITED-voice.');

    await approveGate(mount.baseUrl, id);
    const done = await waitForRun(mount.baseUrl, id, ['done']);
    expect(String(done.lastOutput)).toContain('agent-said');

    const dispatched = recordedSystemPrompts.slice(before);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('ORIGINAL-voice');
    expect(dispatched[0]).not.toContain('EDITED-voice');
  });

  // ─── The trust boundary the pin moved ────────────────────────────────────

  it('POST /api/runs (the run mirror) stores NO client-supplied snapshot, and /resume runs the workspace file', async () => {
    // Previously inert: the mirror accepted any `orchestrationSnapshot` and
    // allowed status `paused`. With resume pinned to the snapshot — and the
    // snapshot now carrying the agent bodies and subflow trees it executes —
    // that body became a complete execution bundle /resume would run with
    // this server's credentials, for an orchestration that need not exist.
    const forged = {
      name: 'forged',
      phases: [{ name: 'pwn', code: { source: "return 'FORGED';" } }],
    };
    const { status, body } = await postJson<Record<string, unknown>>(
      `${mount.baseUrl}/api/runs`,
      {
        id: 'mirrored-1',
        orchestrationName: ORCH,
        status: 'paused',
        events: [],
        orchestrationSnapshot: forged,
      },
    );
    expect(status).toBe(200);
    // The echo reports what was stored, not what was sent.
    expect(body.orchestrationSnapshot).toBeUndefined();
    // Stored: the SERVER's own copy of the named orchestration (so Replay /
    // Rerun still light up for a mirrored run), never the client's.
    const stored = await mount.store.getRun('mirrored-1');
    expect((stored?.orchestrationSnapshot as { name?: string })?.name).toBe(ORCH);
    expect(JSON.stringify(stored?.orchestrationSnapshot)).not.toContain('FORGED');

    // And the threat is closed end to end: resuming the mirrored row runs
    // the WORKSPACE definition by name (it parks at that file's gate), never
    // the forged tree.
    await resumeRun(mount.baseUrl, 'mirrored-1');
    const after = await waitForRun(
      mount.baseUrl,
      'mirrored-1',
      ['paused', 'done', 'error'],
      r => eventsOfType(r, 'run-resumed').length === 1,
    );
    expect(after.status).toBe('paused');
    expect(after.pausedFor).toBe('gate');
    expect(JSON.stringify(after.events)).not.toContain('FORGED');
  });

  // ─── The seventh resume path ─────────────────────────────────────────────

  it('MCP resume_run is pinned too: finishes a parked run whose file was deleted', async () => {
    // Park a run through the real HTTP stack, then "restart" into the MCP
    // server (its own process in production — here the same jest process,
    // the harness's kill() having dropped the controller state exactly like
    // a process death) and resume it from there with the file gone.
    const started = await startRun(mount.baseUrl, ORCH);
    const id = started.id!;
    await waitForRun(mount.baseUrl, id, ['paused']);
    await mount.kill();
    await fs.rm(path.join(tmpRoot, 'examples', `${ORCH}.json`));

    const savedEnv = {
      SAMMY_REPO_ROOT: process.env.SAMMY_REPO_ROOT,
      SAMMY_RUN_DB: process.env.SAMMY_RUN_DB,
      SAMMY_ORCH_DIR: process.env.SAMMY_ORCH_DIR,
    };
    process.env.SAMMY_REPO_ROOT = tmpRoot;
    process.env.SAMMY_RUN_DB = path.join(tmpRoot, 'runs.db');
    delete process.env.SAMMY_ORCH_DIR;
    const server = await buildMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'snapshot-pin-test', version: '0' });
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: 'resume_run',
        arguments: { id },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      // Unpinned, this is the "not found — cannot resume" refusal.
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('"resumed": true');

      // The MCP server resumes in the background against the shared runs.db;
      // read the outcome through a second handle on the same file.
      const probe = new SqliteRunStore(tmpRoot);
      await probe.init();
      try {
        const done = await waitFor(async () => {
          const run = await probe.getRun(id);
          return run?.status === 'done' ? run : null;
        }, 'mcp-resumed run → done');
        expect(String(done.lastOutput)).toContain('ORIGINAL-last');
        const names = [
          ...new Set(
            done.events
              .filter(e => e.type === 'phase-end')
              .map(e => String(e.phaseName)),
          ),
        ];
        expect(names).toEqual(['first', 'gate', 'last']);
      } finally {
        await probe.close();
      }
    } finally {
      await client.close();
      await server.close();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ─── The loader itself ─────────────────────────────────────────────────────
// Production-path companion to the lifecycle cases above: what a fresh load
// pins, what an override load reads back, and the one input every call site
// hands the loader unvalidated.

describe('run-context: the closure a fresh load pins and an override load honors', () => {
  let tmpRoot: string;
  let examplesDir: string;
  let agentsDir: string;

  const write = (dir: string, file: string, content: unknown) =>
    fs.writeFile(
      path.join(dir, file),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf8',
    );

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-pin-closure-'));
    examplesDir = path.join(tmpRoot, 'examples');
    agentsDir = path.join(tmpRoot, 'agents');
    await fs.mkdir(examplesDir, { recursive: true });
    await fs.mkdir(agentsDir, { recursive: true });
    // root → leaf-a → leaf-b, plus a dynamic reference and an unrelated file.
    await write(examplesDir, 'root.json', {
      name: 'root',
      phases: [
        { name: 'a', subflow: 'leaf-a' },
        { name: 'dyn', subflow: '${component}-crawler' },
        { name: 'x', agent: 'agents/x.md' },
        { name: 'param', agent: 'agents/${component}-dev.md' },
      ],
    });
    await write(examplesDir, 'leaf-a.json', {
      name: 'leaf-a',
      phases: [
        { name: 'b', subflow: 'leaf-b' },
        // a cycle back to the root — refused at dispatch, never a pin
        { name: 'back', subflow: 'root' },
      ],
    });
    await write(examplesDir, 'leaf-b.json', {
      name: 'leaf-b',
      switch: {
        on: '${k}',
        cases: { one: { name: 'y', agent: 'agents/y.md' } },
      },
    });
    await write(examplesDir, 'unrelated.json', {
      name: 'unrelated',
      phases: [{ name: 'z', agent: 'agents/z.md' }],
    });
    await write(agentsDir, 'x.md', 'X-DISK');
    await write(agentsDir, 'y.md', 'Y-DISK');
    await write(agentsDir, 'z.md', 'Z-DISK');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('a fresh load pins ONLY the reachable closure, transitively, without runtime keys', async () => {
    const load = makeLoadRunContext({ examplesDir, agentsDir });
    const ctx = await load('root');
    expect(ctx).not.toBeNull();
    const pinned = ctx!.orchestration.__pinned!;
    expect(Object.keys(pinned.orchestrations).sort()).toEqual(['leaf-a', 'leaf-b']);
    // `y` is reachable only through leaf-b's `switch` case (the shared walker
    // sees it); `z` is on disk but unreachable; `${component}-dev` can't be.
    expect(pinned.agents).toEqual({ x: 'X-DISK', y: 'Y-DISK' });
    // Persisted copies carry the authored tree, not the loader's markers.
    expect(pinned.orchestrations['leaf-a']).not.toHaveProperty('__origin');
    expect(pinned.orchestrations['leaf-a']).not.toHaveProperty('__pinned');
    expect(pinned.orchestrations['leaf-a'].name).toBe('leaf-a');
    // The returned disk set is still the whole workspace (a fresh run can
    // reach a `${dynamic}` name only through it).
    expect(ctx!.orchestrations.map(o => o.name).sort()).toEqual([
      'leaf-a',
      'leaf-b',
      'root',
      'unrelated',
    ]);
  });

  it('an override load uses the closure IN PLACE of disk for the names it holds, disk for the rest', async () => {
    const snapshot: Node = {
      name: 'root',
      phases: [{ name: 'a', subflow: 'leaf-a' }],
      __pinned: {
        agents: { x: 'X-PINNED' },
        orchestrations: {
          'leaf-a': {
            name: 'leaf-a',
            phases: [{ name: 'pinned-body', code: { source: 'return 1' } }],
          },
        },
      },
    };
    const load = makeLoadRunContext({ examplesDir, agentsDir });
    const ctx = await load('root', { orchestrationOverride: snapshot });
    expect(ctx).not.toBeNull();
    expect(ctx!.orchestration).toBe(snapshot);
    // Agents: the pinned body for x; today's y and z fill in (a dynamic
    // subflow the closure couldn't see may need them).
    const agents = Object.fromEntries(ctx!.agents.map(a => [a.name, a.raw]));
    expect(agents).toEqual({ x: 'X-PINNED', y: 'Y-DISK', z: 'Z-DISK' });
    // Orchestrations: exactly one `leaf-a`, and it is the pinned one — today's
    // copy is excluded outright, not merely out-precedenced.
    const leafAs = ctx!.orchestrations.filter(o => o.name === 'leaf-a');
    expect(leafAs).toHaveLength(1);
    expect(leafAs[0].phases?.[0].name).toBe('pinned-body');
    expect(ctx!.orchestrations.map(o => o.name).sort()).toEqual([
      'leaf-a',
      'leaf-b',
      'root',
      'unrelated',
    ]);
  });

  it('a snapshot written before closures existed falls back to disk for everything', async () => {
    const load = makeLoadRunContext({ examplesDir, agentsDir });
    const ctx = await load('root', {
      orchestrationOverride: { name: 'root', phases: [{ name: 'a', subflow: 'leaf-a' }] },
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.agents.map(a => a.name).sort()).toEqual(['x', 'y', 'z']);
    expect(ctx!.orchestrations).toHaveLength(4);
  });

  it('refuses a name that is not a plain file basename — with or without a snapshot', async () => {
    // The mirror endpoint stores `orchestrationName` verbatim and every
    // resume / fork path hands it here; the fork path then persists whatever
    // this returns as a NEW run's snapshot, readable via GET /api/runs/:id.
    await write(tmpRoot, 'outside.json', {
      name: 'outside',
      phases: [{ name: 'leak', code: { source: 'return 1' } }],
    });
    const load = makeLoadRunContext({ examplesDir, agentsDir });
    expect(await load('../outside')).toBeNull();
    expect(await load('..\\outside')).toBeNull();
    expect(
      await load('../outside', {
        orchestrationOverride: { name: 'any', phases: [{ name: 'p', code: { source: 'return 1' } }] },
      }),
    ).toBeNull();
    // A plain basename that merely doesn't exist is still a clean miss.
    expect(await load('outside')).toBeNull();
    // Names with other characters are not the concern of this guard.
    await write(examplesDir, 'has space.json', { name: 'has space', code: { source: 'return 1' } });
    expect((await load('has space'))?.orchestration.name).toBe('has space');
  });
});
