import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { DEFAULT_LEASE_TTL_MS, LeaseLostError } from '../src/server/run-store';
import { RunPauseRequested } from '../src/llm/executor';
import { runEventToA2aStreamEvent } from '../src/server/a2a-inbound';
import * as divergenceModule from '../src/server/divergence';
import {
  _resetForTests as _resetController,
  cancel,
  isActive,
  resume,
  startRun,
  subscribe,
} from '../src/server/run-controller';

let tmpRoot: string;
let store: SqliteRunStore;

async function freshStore(): Promise<void> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
}

beforeEach(async () => {
  _resetController();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-rc-'));
  await freshStore();
});

afterEach(async () => {
  _resetController();
  await store.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Wait for a run to finish — polls isActive on the microtask loop. */
async function waitForFinish(id: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (isActive(id)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for run ${id} to finish`);
    }
    await new Promise(r => setImmediate(r));
  }
}

describe('startRun + lifecycle', () => {
  it('persists events as they arrive and writes a sentinel on completion', async () => {
    async function* source(): AsyncIterable<
      Record<string, unknown> & { type: string }
    > {
      yield { type: 'run-start', orchestrationName: 'two-phases', ts: 0 };
      yield { type: 'phase-start', phaseName: 'a', ts: 1 };
      yield { type: 'phase-end', phaseName: 'a', ts: 2 };
      yield { type: 'phase-start', phaseName: 'b', ts: 3 };
      yield { type: 'phase-end', phaseName: 'b', ts: 4 };
    }

    const { id } = await startRun({
      store,
      orchestrationName: 'two-phases',
      buildEventSource: () => source(),
    });
    expect(id).toMatch(/^run-\d+-/);

    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.endedAt).toBeGreaterThan(0);
    const types = run?.events.map(e => e.type) ?? [];
    expect(types[0]).toBe('run-start');
    expect(types.slice(1, -1)).toEqual([
      'phase-start',
      'phase-end',
      'phase-start',
      'phase-end',
    ]);
    expect(types[types.length - 1]).toBe('run-end');
  });

  it('subscriber gets full history then live tail without dropping events', async () => {
    const pending: Array<Record<string, unknown> & { type: string }> = [];
    let done = false;
    let wakeup: (() => void) | null = null;

    async function* source() {
      while (true) {
        while (pending.length > 0) {
          yield pending.shift()!;
        }
        if (done) return;
        await new Promise<void>(r => {
          wakeup = r;
        });
      }
    }

    function push(ev: Record<string, unknown> & { type: string }): void {
      pending.push(ev);
      const w = wakeup;
      wakeup = null;
      w?.();
    }
    async function flush(): Promise<void> {
      for (let i = 0; i < 50 && (pending.length > 0 || !wakeup); i++) {
        await new Promise(r => setImmediate(r));
      }
    }
    function end(): void {
      done = true;
      const w = wakeup;
      wakeup = null;
      w?.();
    }

    const { id } = await startRun({
      store,
      orchestrationName: 'live',
      buildEventSource: () => source(),
    });

    push({ type: 'run-start', orchestrationName: 'live', ts: 0 });
    push({ type: 'before-1', ts: 1 });
    push({ type: 'before-2', ts: 2 });
    await flush();

    const received: string[] = [];
    const sub = await subscribe(store, id, ev => {
      received.push(ev.type as string);
    });
    expect(sub.finished).toBe(false);
    expect(received).toEqual(['run-start', 'before-1', 'before-2']);

    push({ type: 'after-1', ts: 3 });
    push({ type: 'after-2', ts: 4 });
    await flush();
    end();
    await waitForFinish(id);

    expect(received).toEqual([
      'run-start',
      'before-1',
      'before-2',
      'after-1',
      'after-2',
      'run-end',
    ]);
  });

  it('cancel() aborts the executor and marks status cancelled', async () => {
    async function* source(signal: AbortSignal) {
      yield { type: 'phase-start', phaseName: 'long', ts: 1 };
      await new Promise<void>((_, reject) => {
        const fail = () => {
          signal.removeEventListener('abort', fail);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', fail);
      });
    }

    const { id } = await startRun({
      store,
      orchestrationName: 'long',
      buildEventSource: source,
    });
    await new Promise(r => setImmediate(r));
    expect(isActive(id)).toBe(true);
    expect(cancel(id)).toBe(true);
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('cancelled');
    // The CANCEL sentinel, not a `run-end` carrying status 'cancelled': the
    // A2A mapper reads the event TYPE, so a `run-end` is reported to
    // subscribers as a completed, final task, and the cancel seam's
    // suppression probe looks for `run-cancelled` too.
    const last = run?.events[run.events.length - 1];
    expect(last?.type).toBe('run-cancelled');
    expect(run?.events.filter(e => e.type === 'run-end')).toEqual([]);
  });

  it('thrown executor errors mark status error + emit run-error sentinel', async () => {
    async function* source() {
      yield { type: 'phase-start', phaseName: 'bad', ts: 1 };
      throw new Error('kaboom');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'bad',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);
    const run = await store.getRun(id);
    expect(run?.status).toBe('error');
    const last = run?.events[run.events.length - 1];
    expect(last?.type).toBe('run-error');
    expect((last as { error?: string }).error).toContain('kaboom');
  });

  it('subscribing to an already-finished run replays history + ends', async () => {
    async function* source() {
      yield { type: 'run-start', orchestrationName: 'short', ts: 0 };
      yield { type: 'phase-start', phaseName: 'p', ts: 1 };
      yield { type: 'phase-end', phaseName: 'p', ts: 2 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'short',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    const received: string[] = [];
    const sub = await subscribe(store, id, ev =>
      received.push(ev.type as string),
    );
    expect(sub.finished).toBe(true);
    expect(received).toEqual([
      'run-start',
      'phase-start',
      'phase-end',
      'run-end',
    ]);
  });

  it('subscribing to an unknown id sends a clear error sentinel', async () => {
    const received: Array<{ type: string; error?: string }> = [];
    const sub = await subscribe(store, 'no-such-run', ev =>
      received.push(ev as { type: string; error?: string }),
    );
    expect(sub.finished).toBe(true);
    expect(received[0]?.type).toBe('run-error');
    expect(received[0]?.error).toContain('Unknown run id');
  });

  it('checkpoints completedLeaves + lastOutput as leaf phases finish', async () => {
    async function* source(): AsyncIterable<
      Record<string, unknown> & { type: string }
    > {
      yield { type: 'phase-start', phaseName: 'wrapper', ts: 1 };
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 2,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec output', ts: 3 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/dev-lead.md',
        ts: 4,
      };
      yield { type: 'phase-end', phaseName: 'plan', output: 'plan output', ts: 5 };
      yield { type: 'phase-end', phaseName: 'wrapper', output: 'agg', ts: 6 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'two-leaves',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.completedLeaves).toEqual(['spec', 'plan']);
    expect(run?.lastOutput).toBe('plan output');
    expect(run?.status).toBe('done');
  });

  it('catches RunPauseRequested and flips status to paused (no endedAt)', async () => {
    async function* source() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 1,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 2 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 3,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'paused-flow',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('paused');
    expect(run?.pausedFor).toBe('plan');
    expect(run?.endedAt).toBeNull();
    const last = run?.events[run.events.length - 1];
    expect(last?.type).toBe('run-paused');
    expect((last as { pausedFor?: string }).pausedFor).toBe('plan');
    expect(run?.completedLeaves).toEqual(['spec']);
    expect(run?.stateJson).toEqual({ leafOutputs: { spec: 'spec out' } });
  });

  it('resume() rejects when run is not paused', async () => {
    async function* source() {
      yield { type: 'phase-end', phaseName: 'x', output: 'y', ts: 1 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'done',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);
    const result = await resume({
      store,
      id,
      buildEventSource: () =>
        (async function* () {
          yield { type: 'never', ts: 0 };
        })(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not paused/);
  });

  it('resume() picks up a paused run and reaches done', async () => {
    async function* firstPass() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 1,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 2 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 3,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'pause-resume',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);
    expect((await store.getRun(id))?.status).toBe('paused');

    let seenReplay: Record<string, string> | null = null;
    let seenApproved: string[] | null = null;
    async function* secondPass() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 10,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 11 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 12,
      };
      yield { type: 'phase-end', phaseName: 'plan', output: 'plan out', ts: 13 };
    }
    const result = await resume({
      store,
      id,
      buildEventSource: (_signal, replayOutputs, autoApproveLocks) => {
        seenReplay = replayOutputs;
        seenApproved = autoApproveLocks;
        return secondPass();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);

    expect(seenReplay).toEqual({ spec: 'spec out' });
    expect(seenApproved).toEqual(['plan']);

    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.pausedFor).toBeNull();
    expect(run?.completedLeaves).toEqual(['spec', 'plan']);
    const types = run?.events.map(e => e.type) ?? [];
    expect(types).toContain('run-resumed');
    expect(types[types.length - 1]).toBe('run-end');
  });

  it('resume() threads gateMessages through to buildEventSource', async () => {
    async function* firstPass() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 1,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 2 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 3,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'gate-msg',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);
    expect((await store.getRun(id))?.status).toBe('paused');

    let seenGate: Record<string, string> | null = null;
    let seenApproved: string[] | null = null;
    async function* secondPass() {
      yield { type: 'phase-end', phaseName: 'plan', output: 'plan out', ts: 13 };
    }
    const result = await resume({
      store,
      id,
      gateMessages: { plan: 'Be terse.' },
      buildEventSource: (_signal, _replay, autoApproveLocks, gateMessages) => {
        seenApproved = autoApproveLocks;
        seenGate = gateMessages;
        return secondPass();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);

    expect(seenApproved).toEqual(['plan']);
    expect(seenGate).toEqual({ plan: 'Be terse.' });
  });

  it('resume() passes an empty gateMessages map when none supplied', async () => {
    async function* firstPass() {
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 1,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'no-gate-msg',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);

    let seenGate: Record<string, string> | null = null;
    const result = await resume({
      store,
      id,
      buildEventSource: (_signal, _replay, _approved, gateMessages) => {
        seenGate = gateMessages;
        return (async function* () {
          yield { type: 'phase-end', phaseName: 'plan', output: 'o', ts: 2 };
        })();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);
    expect(seenGate).toEqual({});
  });

  it('resume() re-keys an approve-path gate message onto the paused gate\'s SCOPED key', async () => {
    // The run paused at a gate INSIDE a map iteration: pausedFor is the bare
    // display name ('plan'), but the gate's lock-gate event recorded its
    // iteration-scoped identity ('fan[1]/plan'). An approve-with-message is
    // keyed by the bare name (all the API knows) — resume must move it onto
    // the scoped key so the executor delivers it to exactly THAT iteration
    // (the executor consumes scoped-key-first; a bare entry could be eaten by
    // a same-named phase from a different iteration).
    async function* firstPass() {
      yield {
        type: 'lock-gate',
        phaseName: 'plan',
        replayKey: 'fan[1]/plan',
        ts: 1,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'scoped-gate-msg',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);

    let seenGate: Record<string, string> | null = null;
    let seenApproved: string[] | null = null;
    const result = await resume({
      store,
      id,
      gateMessages: { plan: 'Only touch iteration one.' },
      buildEventSource: (_signal, _replay, autoApproveLocks, gateMessages) => {
        seenApproved = autoApproveLocks;
        seenGate = gateMessages;
        return (async function* () {
          yield { type: 'phase-end', phaseName: 'plan', output: 'o', ts: 2 };
        })();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);

    // The auto-approve already keyed on the scoped gate (existing behavior);
    // the message now travels under the SAME identity — and the bare entry is
    // gone, so no other same-named phase can consume it.
    expect(seenApproved).toEqual(['fan[1]/plan']);
    expect(seenGate).toEqual({ 'fan[1]/plan': 'Only touch iteration one.' });
  });

  it('resume() leaves a request-changes (reArmLock) message keyed as supplied', async () => {
    // Request-changes targets the FEEDBACK phase (often a different node than
    // the gate) by display name and relies on the executor's bare-name
    // fallback — re-keying it onto the gate's scoped identity would deliver
    // the human's feedback to the wrong phase. reArmLock marks that path.
    async function* firstPass() {
      yield {
        type: 'phase-start',
        phaseName: 'implement',
        agentPath: 'agents/dev.md',
        ts: 1,
      };
      yield {
        type: 'phase-end',
        phaseName: 'implement',
        output: 'v1',
        ts: 2,
      };
      yield {
        type: 'lock-gate',
        phaseName: 'ship',
        replayKey: 'fan[1]/ship',
        ts: 3,
      };
      throw new RunPauseRequested('ship');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'request-changes-msg',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);

    let seenGate: Record<string, string> | null = null;
    const result = await resume({
      store,
      id,
      gateMessages: { implement: 'Rework the error handling.' },
      invalidateLeaves: ['implement'],
      reArmLock: true,
      buildEventSource: (_signal, _replay, _approved, gateMessages) => {
        seenGate = gateMessages;
        return (async function* () {
          yield { type: 'phase-end', phaseName: 'implement', output: 'v2', ts: 4 };
        })();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);
    expect(seenGate).toEqual({ implement: 'Rework the error handling.' });
  });

  it('resume() with invalidateLeaves drops that leaf from the replay set so it re-runs', async () => {
    // First pass completes spec + design, then pauses at the gate before
    // plan — mirrors a run paused for review of design's output.
    async function* firstPass() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 1,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 2 };
      yield {
        type: 'phase-start',
        phaseName: 'design',
        agentPath: 'agents/uxui.md',
        ts: 3,
      };
      yield {
        type: 'phase-end',
        phaseName: 'design',
        output: 'design v1',
        ts: 4,
      };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 5,
      };
      throw new RunPauseRequested('plan');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'request-changes',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);
    const paused = await store.getRun(id);
    expect(paused?.status).toBe('paused');
    expect(paused?.completedLeaves).toEqual(['spec', 'design']);

    // request-changes: invalidate `design` (the reviewed leaf), re-arm the
    // lock so it re-pauses, and feed the reviewed phase the correction.
    let seenReplay: Record<string, string> | null = null;
    let seenApproved: string[] | null = null;
    let seenGate: Record<string, string> | null = null;
    async function* secondPass() {
      // spec replays from cache (still in replayOutputs); design re-runs
      // because it was invalidated; then we re-pause at the gate.
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 10 };
      yield {
        type: 'phase-start',
        phaseName: 'design',
        agentPath: 'agents/uxui.md',
        ts: 11,
      };
      yield {
        type: 'phase-end',
        phaseName: 'design',
        output: 'design v2',
        ts: 12,
      };
      throw new RunPauseRequested('plan');
    }
    const result = await resume({
      store,
      id,
      gateMessages: { design: 'Make it bolder.' },
      invalidateLeaves: ['design'],
      reArmLock: true,
      buildEventSource: (_signal, replayOutputs, autoApproveLocks, gateMessages) => {
        seenReplay = replayOutputs;
        seenApproved = autoApproveLocks;
        seenGate = gateMessages;
        return secondPass();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);

    // The invalidated leaf is GONE from the replay set (so it re-ran);
    // every other completed leaf still replays from cache.
    expect(seenReplay).toEqual({ spec: 'spec out' });
    // reArmLock → the gated lock is NOT auto-approved, so it fires again.
    expect(seenApproved).toEqual([]);
    expect(seenGate).toEqual({ design: 'Make it bolder.' });

    const run = await store.getRun(id);
    // Re-paused at the same gate with the revision as the fresh output.
    expect(run?.status).toBe('paused');
    expect(run?.pausedFor).toBe('plan');
    expect(run?.lastOutput).toBe('design v2');
    expect(run?.completedLeaves).toEqual(['spec', 'design']);
    const leafOutputs = (run?.stateJson as { leafOutputs?: Record<string, string> })
      ?.leafOutputs;
    expect(leafOutputs?.design).toBe('design v2');
  });

  it('resume() auto-approves a PRIOR gate so a multi-gate run does not re-pause at the first gate', async () => {
    // The ticket-to-PR shape has TWO gates: implement-and-qa (plan) and
    // open-pr (ship). A run paused at the SHIP gate must, on resume, auto-cross
    // the already-approved PLAN gate — otherwise the re-walk re-pauses there
    // and the run bounces between gates forever (the live "never reached
    // open-pr" symptom). The earlier gate is derived from the lock-gate events.
    async function* firstPass() {
      // plan gate crossed (already approved in an earlier pass)…
      yield { type: 'lock-gate', phaseName: 'implement-and-qa', ts: 1 };
      yield {
        type: 'phase-end',
        phaseName: 'implement',
        replayKey: 'implement-and-qa@1/implement',
        output: 'impl',
        ts: 2,
      };
      yield { type: 'phase-end', phaseName: 'review', output: 'LGTM', ts: 3 };
      // …now paused at the ship gate.
      yield { type: 'lock-gate', phaseName: 'open-pr', ts: 4 };
      throw new RunPauseRequested('open-pr');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'two-gate',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);
    expect((await store.getRun(id))?.pausedFor).toBe('open-pr');

    // Plain approve at the ship gate.
    let seenApproved: string[] | null = null;
    async function* secondPass() {
      yield { type: 'phase-end', phaseName: 'open-pr', output: 'PR', ts: 10 };
    }
    const result = await resume({
      store,
      id,
      buildEventSource: (_signal, _replay, autoApproveLocks) => {
        seenApproved = autoApproveLocks;
        return secondPass();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);
    // Both the prior plan gate AND the current ship gate are auto-approved
    // (plain approve → pausedFor included).
    expect(new Set(seenApproved ?? [])).toEqual(
      new Set(['implement-and-qa', 'open-pr']),
    );
  });

  it('resume() past a serial-map per-iteration gate executes the SECOND iteration (no resume-loop)', async () => {
    // Live regression: a serial `map` over two items whose body holds a human
    // GATE (lock). The body gate's display name (`implement-and-qa`) is
    // IDENTICAL across iterations, but each iteration's lock is a distinct
    // instance — keyed by the iteration-scoped replay key (`<map>[<idx>]/...`).
    //
    // The bug: the resume auto-approve set carried only the BARE gate name, so
    // the plain-approve entry got consumed by iteration 0's gate on the re-walk
    // and iteration 1's gate (same bare name, already consumed) re-paused — a
    // resume→pause loop the 2nd item could never escape. The fix keys the
    // auto-approve set by the scoped replayKey the `lock-gate` events carry, so
    // each iteration's gate is a distinct, separately-consumed entry.
    //
    // This stub faithfully simulates the executor's lock decorator: on each
    // re-walk it crosses a gate ONLY if that gate's scoped key is in the
    // autoApproveLocks set resume handed it (consuming the match); otherwise it
    // re-pauses. So the test exercises the real resume↔executor contract.
    const MAP = 'per-item';
    const GATE = 'implement-and-qa';
    const scoped = (idx: number) => `${MAP}[${idx}]/${GATE}`;

    // First pass: iteration 0 crosses its gate + does work (a PR), then
    // iteration 1 pauses at ITS gate. lock-gate events carry the scoped key.
    async function* firstPass() {
      yield { type: 'composite-start', phaseName: MAP, kind: 'map', ts: 1 };
      // iteration 0 — gate approved interactively in the prior session
      yield { type: 'map-iteration', phaseName: MAP, iteration: 1, total: 2, ts: 2 };
      yield { type: 'lock-gate', phaseName: GATE, replayKey: scoped(0), ts: 3 };
      yield {
        type: 'phase-end',
        phaseName: GATE,
        replayKey: scoped(0),
        output: 'PR #1 opened',
        ts: 4,
      };
      // iteration 1 — pauses at its gate. `pausedFor` keeps the bare display
      // name; the gate's per-iteration identity rides on the lock-gate event's
      // scoped replayKey, which resume reads to build its auto-approve set.
      yield { type: 'map-iteration', phaseName: MAP, iteration: 2, total: 2, ts: 5 };
      yield { type: 'lock-gate', phaseName: GATE, replayKey: scoped(1), ts: 6 };
      throw new RunPauseRequested(GATE);
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'serial-map-gate',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);
    expect((await store.getRun(id))?.pausedFor).toBe(GATE);

    // Plain approve + resume. The second pass models the executor re-walking
    // from the top: each gate is crossed iff its scoped key is auto-approved.
    let secondPassReachedPostGate = false;
    let seenApproved: string[] | null = null;
    const secondPass = (autoApproveLocks: string[]) =>
      (async function* () {
        const remaining = new Set(autoApproveLocks);
        const crossGate = (idx: number): boolean => {
          // executor matches scoped key first, then bare name (consumed once).
          if (remaining.has(scoped(idx))) {
            remaining.delete(scoped(idx));
            return true;
          }
          if (remaining.has(GATE)) {
            remaining.delete(GATE);
            return true;
          }
          return false;
        };
        yield { type: 'composite-start', phaseName: MAP, kind: 'map', ts: 10 };
        // iteration 0: gate + replay its captured PR output
        yield { type: 'map-iteration', phaseName: MAP, iteration: 1, total: 2, ts: 11 };
        yield { type: 'lock-gate', phaseName: GATE, replayKey: scoped(0), ts: 12 };
        if (!crossGate(0)) throw new RunPauseRequested(GATE);
        yield {
          type: 'phase-end',
          phaseName: GATE,
          replayKey: scoped(0),
          output: 'PR #1 opened',
          ts: 13,
        };
        // iteration 1: gate — must cross THIS time (the whole point)
        yield { type: 'map-iteration', phaseName: MAP, iteration: 2, total: 2, ts: 14 };
        yield { type: 'lock-gate', phaseName: GATE, replayKey: scoped(1), ts: 15 };
        if (!crossGate(1)) throw new RunPauseRequested(GATE);
        // …past the gate: iteration 1 does its work and the run completes.
        secondPassReachedPostGate = true;
        yield {
          type: 'phase-end',
          phaseName: GATE,
          replayKey: scoped(1),
          output: 'PR #2 opened',
          ts: 16,
        };
        yield { type: 'composite-end', phaseName: MAP, kind: 'map', ts: 17 };
      })();

    const result = await resume({
      store,
      id,
      buildEventSource: (_signal, _replay, autoApproveLocks) => {
        seenApproved = autoApproveLocks;
        return secondPass(autoApproveLocks);
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);

    // The resume set must auto-approve BOTH iteration 0's already-crossed gate
    // AND iteration 1's paused gate — as DISTINCT scoped entries.
    expect(new Set(seenApproved ?? [])).toEqual(
      new Set([scoped(0), scoped(1)]),
    );
    // The proof: the run executed PAST iteration 1's gate and finished — not a
    // resume→pause loop stuck re-pausing at the 2nd iteration's gate.
    expect(secondPassReachedPostGate).toBe(true);
    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.pausedFor).toBeNull();
    expect(run?.lastOutput).toBe('PR #2 opened');
    const types = run?.events.map(e => e.type) ?? [];
    expect(types[types.length - 1]).toBe('run-end');
  });

  it('resume() with reArmLock auto-approves the prior gate but leaves the current gate armed', async () => {
    // request-changes at the ship gate: cross the prior plan gate, but keep
    // the ship gate armed so the run re-pauses there after the revision.
    async function* firstPass() {
      yield { type: 'lock-gate', phaseName: 'plan-gate', ts: 1 };
      yield {
        type: 'phase-end',
        phaseName: 'implement',
        replayKey: 'loop@1/implement',
        output: 'impl',
        ts: 2,
      };
      yield { type: 'phase-end', phaseName: 'review', output: 'LGTM', ts: 3 };
      yield { type: 'lock-gate', phaseName: 'ship-gate', ts: 4 };
      throw new RunPauseRequested('ship-gate');
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'two-gate-rc',
      buildEventSource: () => firstPass(),
    });
    await waitForFinish(id);

    let seenApproved: string[] | null = null;
    async function* secondPass() {
      throw new RunPauseRequested('ship-gate'); // re-pause at the armed gate
    }
    const result = await resume({
      store,
      id,
      reArmLock: true,
      invalidateLeaves: ['loop@1/implement', 'review'],
      gateMessages: { implement: 'revise' },
      buildEventSource: (_signal, _replay, autoApproveLocks) => {
        seenApproved = autoApproveLocks;
        return secondPass();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish(id);
    // Prior gate auto-approved; current (ship) gate NOT — it stays armed.
    expect(seenApproved).toEqual(['plan-gate']);
    expect((await store.getRun(id))?.pausedFor).toBe('ship-gate');
  });

  it('resume() also picks up an interrupted run (crash-resume)', async () => {
    // Simulate an interrupted run — same checkpoint shape a previous
    // process would have left behind for a crash. No pausedFor: the
    // executor wasn't waiting on a lock, it just got killed.
    await store.upsertRun({
      id: 'crashed-run',
      orchestrationName: 'x',
      startedAt: 1,
      status: 'interrupted',
      events: [
        { type: 'run-start', ts: 0 },
        { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 1 },
        { type: 'run-interrupted', reason: 'process restart', ts: 2 },
      ],
    });
    await store.updateRunStatus('crashed-run', {
      completedLeaves: ['spec'],
      lastOutput: 'spec out',
      stateJson: { leafOutputs: { spec: 'spec out' } },
    });

    let seenReplay: Record<string, string> | null = null;
    let seenApproved: string[] | null = null;
    async function* recover() {
      yield {
        type: 'phase-start',
        phaseName: 'spec',
        agentPath: 'agents/pm.md',
        ts: 10,
      };
      yield { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 11 };
      yield {
        type: 'phase-start',
        phaseName: 'plan',
        agentPath: 'agents/lead.md',
        ts: 12,
      };
      yield { type: 'phase-end', phaseName: 'plan', output: 'plan out', ts: 13 };
    }
    const result = await resume({
      store,
      id: 'crashed-run',
      buildEventSource: (_signal, replayOutputs, autoApproveLocks) => {
        seenReplay = replayOutputs;
        seenApproved = autoApproveLocks;
        return recover();
      },
    });
    expect(result.ok).toBe(true);
    await waitForFinish('crashed-run');

    // Checkpoint reused; no pausedFor → empty auto-approve set.
    expect(seenReplay).toEqual({ spec: 'spec out' });
    expect(seenApproved).toEqual([]);

    const run = await store.getRun('crashed-run');
    expect(run?.status).toBe('done');
  });

  it('cancel() returns false when the run does not exist or finished', async () => {
    expect(cancel('nope')).toBe(false);
    async function* source() {
      yield { type: 'done', ts: 1 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'q',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);
    expect(cancel(id)).toBe(false);
  });
});

describe('server-side budget gate', () => {
  it('halts a run mid-flight once its cost crosses the daily cap', async () => {
    // Each phase costs $1. The source watches the abort signal so it
    // stops once the controller halts the run (mirrors the executor).
    async function* source(signal: AbortSignal) {
      yield { type: 'run-start', orchestrationName: 'pricey', ts: 0 };
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) {
          yield { type: 'run-error', error: 'aborted', ts: i };
          return;
        }
        yield {
          type: 'phase-start',
          phaseName: `p${i}`,
          agentPath: 'agents/x.md',
          ts: i,
        };
        yield {
          type: 'phase-end',
          phaseName: `p${i}`,
          output: 'o',
          costUsd: 1,
          ts: i,
        };
      }
    }

    const { id } = await startRun({
      store,
      orchestrationName: 'pricey',
      buildEventSource: signal => source(signal),
      budgetGate: {
        dailyLimitUsd: 2.5,
        monthlyLimitUsd: null,
        daySpentBeforeUsd: 0,
        monthSpentBeforeUsd: 0,
      },
    });

    await waitForFinish(id);

    const run = await store.getRun(id);
    // 3 phases × $1 crosses the $2.50 cap → run halts as 'error'.
    expect(run?.status).toBe('error');
    const halted = run?.events.find(e => e.type === 'budget-halted');
    expect(halted).toBeTruthy();
    expect((halted as { reason?: string } | undefined)?.reason).toMatch(
      /daily budget/,
    );
  });

  it("counts a failed attempt's phase-error cost — a retry storm cannot burn under the cap", async () => {
    // Every spend reader folded phase-ends only. A leaf that fails before
    // its phase-end (contract violation, failed turn) and is re-dispatched by
    // `retry` paid for each attempt while the gate saw $0 of it.
    async function* source(signal: AbortSignal) {
      yield { type: 'run-start', orchestrationName: 'storm', ts: 0 };
      yield { type: 'phase-start', phaseName: 'p', agentPath: 'agents/x.md', ts: 1 };
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) {
          yield { type: 'run-error', error: 'aborted', ts: i };
          return;
        }
        yield { type: 'phase-error', phaseName: 'p', error: 'bad', costUsd: 1, ts: i };
        yield { type: 'node-retried', phaseName: 'p', attempt: i + 1, maxAttempts: 10, error: 'bad', delayMs: 0, ts: i };
      }
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'storm',
      buildEventSource: signal => source(signal),
      budgetGate: {
        dailyLimitUsd: 2.5,
        monthlyLimitUsd: null,
        daySpentBeforeUsd: 0,
        monthSpentBeforeUsd: 0,
      },
    });
    await waitForFinish(id);
    const run = await store.getRun(id);
    expect(run?.status).toBe('error');
    expect(run?.events.some(e => e.type === 'budget-halted')).toBe(true);
    // Halted at the third failed attempt, not after all ten.
    expect(run?.events.filter(e => e.type === 'phase-error').length).toBe(3);
  });

  it('runs unimpeded when no budget gate is set', async () => {
    async function* source() {
      yield { type: 'run-start', orchestrationName: 'free', ts: 0 };
      yield {
        type: 'phase-start',
        phaseName: 'p',
        agentPath: 'agents/x.md',
        ts: 1,
      };
      yield {
        type: 'phase-end',
        phaseName: 'p',
        output: 'o',
        costUsd: 999,
        ts: 2,
      };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'free',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);
    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.events.some(e => e.type === 'budget-halted')).toBe(false);
  });
});

describe('lease lost mid-run', () => {
  it('yields without a terminal write when appendEvent throws LeaseLostError', async () => {
    // Proxy the real store so the 2nd appendEvent throws LeaseLostError —
    // simulating a peer that reclaimed this run while we were executing.
    let appends = 0;
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'appendEvent') {
          return async (id: string, event: Record<string, unknown>) => {
            appends += 1;
            if (appends === 2) throw new LeaseLostError(id, 'me', 'peer');
            return (target as SqliteRunStore).appendEvent(id, event as never);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;

    async function* source(): AsyncIterable<
      Record<string, unknown> & { type: string }
    > {
      yield { type: 'run-start', orchestrationName: 'x', ts: 0 };
      yield { type: 'phase-start', phaseName: 'a', ts: 1 }; // 2nd append -> throws
      yield { type: 'phase-end', phaseName: 'a', ts: 2 }; // never reached
    }

    const { id } = await startRun({
      store: proxy,
      orchestrationName: 'x',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    // We must NOT have stomped the run: no error/done status flip, no terminal
    // sentinel written by us. The peer that took over owns the terminal write.
    const run = await store.getRun(id);
    expect(run?.status).toBe('running');
    expect(
      run?.events.some(
        e => e.type === 'run-error' || e.type === 'run-end' || e.type === 'run-cancelled',
      ),
    ).toBe(false);
    expect(isActive(id)).toBe(false); // local teardown still happened
  });
});

describe('the terminal write never leaves a zombie', () => {
  /** The real store, with the STATUS write (the terminal) failing the way a
   *  busy SQLite file / dropped connection / statement timeout does. */
  function failingTerminal(times: number): {
    proxy: SqliteRunStore;
    counts: { statusWrites: number; renews: number };
  } {
    const counts = { statusWrites: 0, renews: 0 };
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'updateRunStatus') {
          return async (
            id: string,
            patch: { status?: string },
            o?: unknown,
          ) => {
            if (patch.status) {
              counts.statusWrites += 1;
              if (counts.statusWrites <= times) {
                throw new Error('SQLITE_BUSY: database is locked');
              }
            }
            return (target as SqliteRunStore).updateRunStatus(id, patch as never, o as never);
          };
        }
        if (prop === 'renewLease') {
          return async (id: string) => {
            counts.renews += 1;
            return (target as SqliteRunStore).renewLease(id);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    return { proxy, counts };
  }

  async function* clean(): AsyncIterable<Record<string, unknown> & { type: string }> {
    yield { type: 'run-start', orchestrationName: 'x', ts: 0 };
    yield { type: 'phase-start', phaseName: 'a', agentPath: 'code', ts: 1 };
    yield { type: 'phase-end', phaseName: 'a', replayKey: 'a', output: 'A', ts: 2 };
  }

  it('a transient failure on the LAST write is retried: the run still ends done and leaves the active map', async () => {
    // runInBackground is fire-and-forget. This used to rethrow from the
    // terminal block before stopRenew / finished / active.delete / onTerminal,
    // so one SQLITE_BUSY on the final write left a lease-renewing zombie: row
    // `running` forever, isActive true, cancel() a no-op, the group held.
    const { proxy, counts } = failingTerminal(1);
    const hook = jest.fn();
    const { id } = await startRun({
      store: proxy,
      orchestrationName: 'x',
      onTerminal: hook,
      buildEventSource: () => clean(),
    });
    await waitForFinish(id, 5_000);
    expect(counts.statusWrites).toBe(2); // failed once, then landed
    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.events.filter(e => e.type === 'run-end').length).toBe(1); // no duplicate sentinel from the retry
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({ id, status: 'done' });
    expect(hook.mock.calls[0][0].terminalWriteError).toBeUndefined();
  });

  it('a terminal write that keeps failing still tears the leg down: heartbeat stopped (reclaimable), active map cleared, hook told', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { proxy, counts } = failingTerminal(Infinity);
      const hook = jest.fn();
      const { id } = await startRun({
        store: proxy,
        orchestrationName: 'x',
        onTerminal: hook,
        buildEventSource: () => clean(),
      });
      // Drive the retry backoff timers until the leg gives up.
      for (let i = 0; i < 500 && isActive(id); i++) {
        jest.advanceTimersByTime(100);
        await new Promise(r => setImmediate(r));
      }
      expect(isActive(id)).toBe(false);
      expect(counts.statusWrites).toBe(3); // bounded, not forever
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toMatchObject({
        id,
        status: 'done',
        terminalWriteError: expect.stringMatching(/SQLITE_BUSY/),
      });
      // The row could not be written — but this leg's heartbeat is OFF, so
      // the lease lapses and a peer can reclaim it (resumable), instead of a
      // `running` row renewed forever by a process that has finished with it.
      expect((await store.getRun(id))?.status).toBe('running');
      const renewsAfter = counts.renews;
      jest.advanceTimersByTime(DEFAULT_LEASE_TTL_MS * 2);
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      expect(counts.renews).toBe(renewsAfter);
      const peer = new SqliteRunStore(tmpRoot, { instanceId: 'peer' });
      await peer.init();
      try {
        expect(
          (await peer.markOrphanedRunsAsInterrupted(Date.now() + 10 * 60_000)).ids,
        ).toContain(id);
      } finally {
        await peer.close();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('the SAME process reclaims the abandoned row: the sweep spares an own row only while a controller still drives it', async () => {
    // A single-process deployment has no peer. The leg above gave up with
    // the row still `running` under THIS instance's lease, and the sweep's
    // own-row exclusion — right for a live run with a blocked event loop —
    // protected it forever: findActiveRunsInGroup counted it, so its group
    // refused or parked every later fire until a restart.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const { proxy } = failingTerminal(Infinity);
      const { id } = await startRun({
        store: proxy,
        orchestrationName: 'x',
        concurrencyGroup: 'grp',
        buildEventSource: () => clean(),
      });
      for (let i = 0; i < 500 && isActive(id); i++) {
        jest.advanceTimersByTime(100);
        await new Promise(r => setImmediate(r));
      }
      expect(isActive(id)).toBe(false);
      expect((await store.getRun(id))?.status).toBe('running');
      expect((await store.findActiveRunsInGroup('grp')).map(r => r.id)).toEqual([id]);

      const afterLease = Date.now() + DEFAULT_LEASE_TTL_MS + 1;
      // The bare exclusion still stands — a blocked event loop must never
      // reclaim its own live run. Vouching that no controller drives the row
      // any more is what unlocks it, on the same store.
      expect((await store.markOrphanedRunsAsInterrupted(afterLease)).ids).not.toContain(id);
      expect(
        (await store.markOrphanedRunsAsInterrupted(afterLease, { isLocallyActive: isActive }))
          .ids,
      ).toContain(id);
      const run = await store.getRun(id);
      expect(run?.status).toBe('interrupted');
      expect(run?.events[run.events.length - 1]?.type).toBe('run-interrupted');
      // The group is released: the next fire for it is no longer refused.
      expect(await store.findActiveRunsInGroup('grp')).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a terminal VERDICT that throws tears the leg down too — the derivations are inside the same guard as the write', async () => {
    // The verdicts are derived from `ctrl.events`, a log this leg did not
    // fully produce (a resumed leg seeds it from the store; POST /api/runs
    // accepts caller-supplied events). Outside the guard, one throw there
    // rejected the fire-and-forget promise above stopRenew / active.delete —
    // the same zombie the retry teardown exists to prevent.
    const spy = jest
      .spyOn(divergenceModule, 'computeDivergence')
      .mockImplementation(() => {
        throw new Error('derivation boom');
      });
    try {
      const hook = jest.fn();
      const { id } = await startRun({
        store,
        orchestrationName: 'x',
        concurrencyGroup: 'grp-deriv',
        onTerminal: hook,
        buildEventSource: () => clean(),
      });
      await waitForFinish(id);
      expect(isActive(id)).toBe(false);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0].terminalWriteError).toMatch(/derivation boom/);
      // No terminal was recorded, so the row reads `running` — and with the
      // heartbeat stopped and the map entry gone, the own sweep reclaims it.
      expect((await store.getRun(id))?.status).toBe('running');
      const afterLease = Date.now() + DEFAULT_LEASE_TTL_MS + 1;
      expect(
        (
          await store.markOrphanedRunsAsInterrupted(afterLease, {
            isLocallyActive: isActive,
          })
        ).ids,
      ).toContain(id);
      expect(await store.findActiveRunsInGroup('grp-deriv')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a resume whose post-claim re-read throws leaves no controller behind, so the own sweep can still reclaim the row', async () => {
    // The re-read is the only await between resume's registration and
    // `void runInBackground`, and runInBackground owns the teardown. A leaked
    // entry is exactly what makes `isLocallyActive` vouch for a row no
    // executor was ever built for — so the sweep above would spare it for the
    // life of the process, in the single-process topology it exists for.
    await store.upsertRun({
      id: 'r-reread',
      orchestrationName: 'x',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [{ type: 'run-start', orchestrationName: 'x', ts: 0 }],
      concurrencyGroup: 'grp-reread',
    });
    await store.updateRunStatus('r-reread', { status: 'paused', pausedFor: 'gate' });
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'getRunSummary') {
          return async () => {
            throw new Error('ECONNRESET');
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    const { seen, build } = (() => {
      const s = { built: false };
      return {
        seen: s,
        build: () => {
          s.built = true;
          return (async function* () {})();
        },
      };
    })();

    await expect(
      resume({ store: proxy, id: 'r-reread', buildEventSource: build }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(seen.built).toBe(false);
    expect(isActive('r-reread')).toBe(false);
    // The claim already published the row `running` under this instance's
    // lease. Nothing flips it back — the sweep is the recovery, and it is only
    // reachable because the map entry is gone.
    expect((await store.getRun('r-reread'))?.status).toBe('running');
    const afterLease = Date.now() + DEFAULT_LEASE_TTL_MS + 1;
    expect(
      (
        await store.markOrphanedRunsAsInterrupted(afterLease, {
          isLocallyActive: isActive,
        })
      ).ids,
    ).toContain('r-reread');
    expect((await store.getRun('r-reread'))?.status).toBe('interrupted');
    expect(await store.findActiveRunsInGroup('grp-reread')).toEqual([]);
  });
});

describe('a cancel landing between the status flip and the controller registration', () => {
  /** An event source shaped like the run-runner's: it attaches its abort
   *  listener when BUILT, so an abort that fired earlier is never seen — and
   *  it records whether it was built, and whether it ran, at all. */
  function recordingSource() {
    const seen = { built: false, ran: false };
    const build = (signal: AbortSignal) => {
      seen.built = true;
      let stop = false;
      signal.addEventListener('abort', () => {
        stop = true;
      });
      return (async function* () {
        if (stop) return;
        seen.ran = true;
        yield { type: 'phase-start', phaseName: 'a', agentPath: 'code', ts: 1 };
        yield { type: 'phase-end', phaseName: 'a', replayKey: 'a', output: 'A', ts: 2 };
      })();
    };
    return { seen, build };
  }

  async function seedErrorRun(id: string): Promise<void> {
    await store.upsertRun({
      id,
      orchestrationName: 'x',
      startedAt: Date.now() - 1_000,
      status: 'running',
      events: [{ type: 'run-start', orchestrationName: 'x', ts: 0 }],
    });
    await store.updateRunStatus(id, { status: 'error', endedAt: Date.now() });
  }

  /** The store-path cancel seam's steps, as cancelStoredRunAndDrain takes
   *  them: a status-fenced flip, abort a LOCAL controller if there is one,
   *  then the sentinel (and, in the API, the group drain). */
  async function seamCancel(id: string): Promise<{ flipped: boolean; local: boolean }> {
    const flipped = await store.updateRunStatus(
      id,
      { status: 'cancelled', endedAt: Date.now() },
      { onlyIfStatus: ['running'] },
    );
    const local = isActive(id) ? cancel(id) : false;
    await store.appendEvent(id, { type: 'run-cancelled', ts: Date.now() });
    return { flipped, local };
  }

  it('resume(): flipped after the claim but before registration → the resume sees the flip and never starts', async () => {
    await seedErrorRun('r-gap');
    // Park resume() between its claim (the row now reads `running`) and its
    // registration — the gap the seam's `isActive` check could not see into.
    let parked!: () => void;
    const parkedAt = new Promise<void>(r => (parked = r));
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'appendEvent') {
          return async (id: string, ev: { type: string }) => {
            if (ev.type === 'run-resumed') {
              parked();
              await gate;
            }
            return target.appendEvent(id, ev as never);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    const { seen, build } = recordingSource();
    const resumed = resume({ store: proxy, id: 'r-gap', buildEventSource: build });
    await parkedAt;
    expect((await store.getRunSummary('r-gap'))?.status).toBe('running');
    // Nothing local to abort yet: the seam flips, appends and moves on.
    expect(await seamCancel('r-gap')).toEqual({ flipped: true, local: false });
    release();
    const result = await resumed;
    // Pre-fix: { ok: true }, and the source ran — un-aborted, on the
    // cancelled row, alongside whatever the seam's drain had started.
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/was cancelled while resuming/),
    });
    expect(seen.built).toBe(false);
    expect(isActive('r-gap')).toBe(false);
    const run = await store.getRun('r-gap');
    expect(run?.status).toBe('cancelled');
    expect(run?.events.some(e => e.type === 'phase-start')).toBe(false);
  });

  it('resume(): flipped after registration but before the executor was built → the leg unwinds without running it', async () => {
    await seedErrorRun('r-late');
    // The re-read's snapshot predates the flip (a store round trip); the seam
    // lands while it is in flight — flips, finds the controller, aborts.
    let once = false;
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'getRunSummary') {
          return async (id: string, owner?: string) => {
            const row = await target.getRunSummary(id, owner);
            if (id === 'r-late' && row?.status === 'running' && !once) {
              once = true;
              expect(await seamCancel('r-late')).toEqual({ flipped: true, local: true });
            }
            return row; // stale: still says `running`
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    const { seen, build } = recordingSource();
    expect(await resume({ store: proxy, id: 'r-late', buildEventSource: build })).toEqual({
      ok: true,
    });
    await waitForFinish('r-late');
    // Pre-fix: the source was built with an already-aborted signal its
    // listener never saw, and ran the phase on the cancelled row.
    expect(seen.ran).toBe(false);
    const run = await store.getRun('r-late');
    expect(run?.status).toBe('cancelled');
    expect(run?.events.some(e => e.type === 'phase-start')).toBe(false);
    // The unwind records the CANCEL sentinel. A `run-end` carrying
    // status:'cancelled' is reported to an A2A subscriber as a COMPLETED task
    // — and as FINAL, so a conformant client stops there and never sees the
    // seam's own `canceled` update.
    const types = (run?.events ?? []).map(e => e.type);
    expect(types).toContain('run-cancelled');
    expect(types).not.toContain('run-end');
    const sentinel = (run?.events ?? []).find(e => e.type === 'run-cancelled');
    expect(
      runEventToA2aStreamEvent(sentinel as never, 'r-late'),
    ).toMatchObject({ status: { state: 'canceled' }, final: true });
  });

  it('startRun(): a cancel landing between the insert and the executor finds the controller and stops it', async () => {
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'upsertRun') {
          return async (run: { id: string }) => {
            await target.upsertRun(run as never);
            // The row is public now. Pre-fix the controller was registered
            // only after this returned, so the seam found nothing to abort.
            expect(await seamCancel(run.id)).toEqual({ flipped: true, local: true });
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as SqliteRunStore;
    const { seen, build } = recordingSource();
    const { id } = await startRun({ store: proxy, orchestrationName: 'x', buildEventSource: build });
    await waitForFinish(id);
    expect(seen.ran).toBe(false);
    const run = await store.getRun(id);
    expect(run?.status).toBe('cancelled');
    expect(run?.events.some(e => e.type === 'phase-start')).toBe(false);
  });
});
