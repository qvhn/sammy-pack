/**
 * Tests for the RUN-LEVEL divergence (retry-storm) watchdog.
 *
 * A run can be locally healthy (every phase ends "ok") yet globally pathological
 * — the same per-item phase re-running far past a healthy refinement. The
 * watchdog flags that thrash from the durable event stream.
 *
 * Layers exercised:
 *   1. computeDivergence / formatDivergenceSummary — the pure event→verdict core,
 *      including the KEY distinction: a `map` over N items (N distinct replay
 *      keys, each once) is NOT thrash, while one item's phase 12× IS.
 *   2. run-controller — the verdict computed at terminal from the durable event
 *      mirror, the warn-path `run-divergence` event emitted, and the opt-in
 *      mid-run ABORT path (a real run cut short by the watchdog).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeDivergence,
  formatDivergenceSummary,
  DEFAULT_DIVERGENCE_THRESHOLD,
} from '../src/server/divergence';
import { SqliteRunStore } from '../src/server/db';
import {
  _resetForTests as _resetController,
  isActive,
  startRun,
  type TerminalInfo,
} from '../src/server/run-controller';
import type { StoredEvent } from '../src/server/run-store';

// helper: build a phase-end with a scoped replay key.
function end(phaseName: string, replayKey: string, ts: number): StoredEvent {
  return { type: 'phase-end', phaseName, replayKey, output: 'ok', ts };
}

// ──────────────────────────────────────────────────────────────────────────
// 1 — pure core
// ──────────────────────────────────────────────────────────────────────────
describe('computeDivergence', () => {
  it('a clean run (every phase once) is not diverged', () => {
    const events: StoredEvent[] = [
      end('a', 'a', 1),
      end('b', 'b', 2),
      end('c', 'c', 3),
    ];
    const r = computeDivergence(events);
    expect(r.diverged).toBe(false);
    expect(r.maxRepeats).toBe(1);
    expect(r.hotspots).toEqual([]);
    expect(formatDivergenceSummary(r)).toBe('');
  });

  it('flags one phase instance that ran past the threshold (the storm)', () => {
    // Same replayKey 7× = one item's phase re-ran 7 times.
    const events: StoredEvent[] = Array.from({ length: 7 }, (_, i) =>
      end('validate', 'fix[0]/validate', i + 1),
    );
    const r = computeDivergence(events);
    expect(r.diverged).toBe(true);
    expect(r.maxRepeats).toBe(7);
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].phase).toBe('validate');
    expect(r.hotspots[0].repeats).toBe(7);
    const line = formatDivergenceSummary(r);
    expect(line).toContain('RETRY STORM');
    expect(line).toContain('validate ×7');
  });

  it('KEY DISTINCTION: a map over 100 items (100 distinct keys, each once) is NOT thrash', () => {
    const events: StoredEvent[] = Array.from({ length: 100 }, (_, i) =>
      end('body', `fan[${i}]/body`, i + 1),
    );
    const r = computeDivergence(events);
    expect(r.diverged).toBe(false);
    expect(r.maxRepeats).toBe(1);
  });

  it('counts node-retried toward the same instance (an unscoped storming phase)', () => {
    const events: StoredEvent[] = [
      { type: 'node-retried', phaseName: 'p', attempt: 1, maxAttempts: 9, error: 'x', delayMs: 0, ts: 1 },
      { type: 'node-retried', phaseName: 'p', attempt: 2, maxAttempts: 9, error: 'x', delayMs: 0, ts: 2 },
      { type: 'node-retried', phaseName: 'p', attempt: 3, maxAttempts: 9, error: 'x', delayMs: 0, ts: 3 },
      { type: 'node-retried', phaseName: 'p', attempt: 4, maxAttempts: 9, error: 'x', delayMs: 0, ts: 4 },
      { type: 'node-retried', phaseName: 'p', attempt: 5, maxAttempts: 9, error: 'x', delayMs: 0, ts: 5 },
      { type: 'node-retried', phaseName: 'p', attempt: 6, maxAttempts: 9, error: 'x', delayMs: 0, ts: 6 },
    ];
    const r = computeDivergence(events);
    expect(r.diverged).toBe(true);
    expect(r.hotspots[0].phase).toBe('p');
    expect(r.hotspots[0].repeats).toBe(6);
  });

  it('honors a custom repeatThreshold (and clamps below 2)', () => {
    const events: StoredEvent[] = Array.from({ length: 3 }, (_, i) =>
      end('x', 'x', i + 1),
    );
    expect(computeDivergence(events, { repeatThreshold: 3 }).diverged).toBe(true);
    expect(computeDivergence(events, { repeatThreshold: 4 }).diverged).toBe(false);
    // threshold < 2 clamps to 2 (a single run is never thrash).
    const single = computeDivergence([end('x', 'x', 1)], { repeatThreshold: 1 });
    expect(single.diverged).toBe(false);
    expect(single.threshold).toBe(2);
  });

  it('uses the default threshold when unset', () => {
    const below: StoredEvent[] = Array.from(
      { length: DEFAULT_DIVERGENCE_THRESHOLD - 1 },
      (_, i) => end('x', 'x', i + 1),
    );
    const at: StoredEvent[] = Array.from(
      { length: DEFAULT_DIVERGENCE_THRESHOLD },
      (_, i) => end('x', 'x', i + 1),
    );
    expect(computeDivergence(below).diverged).toBe(false);
    expect(computeDivergence(at).diverged).toBe(true);
  });

  it('reports multiple hotspots worst-first', () => {
    const events: StoredEvent[] = [
      ...Array.from({ length: 8 }, (_, i) => end('validate', 'i[0]/validate', i + 1)),
      ...Array.from({ length: 6 }, (_, i) => end('implement', 'i[0]/implement', i + 100)),
    ];
    const r = computeDivergence(events);
    expect(r.hotspots).toHaveLength(2);
    expect(r.hotspots[0].phase).toBe('validate'); // worst first
    expect(r.hotspots[0].repeats).toBe(8);
    expect(r.hotspots[1].phase).toBe('implement');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2 — run-controller: warn-path event + abort path
// ──────────────────────────────────────────────────────────────────────────
describe('run-controller — divergence watchdog', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    _resetController();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-diverge-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
  });
  afterEach(async () => {
    _resetController();
    await store.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function waitForFinish(id: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (isActive(id)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${id}`);
      await new Promise(r => setImmediate(r));
    }
  }

  it('WARN (default): a thrashing run ends with a run-divergence event + verdict, but is NOT aborted', async () => {
    // 6 repeats of one phase instance → diverged at the default threshold. The
    // run reaches its own clean run-end (not aborted).
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      for (let i = 0; i < 6; i++) {
        yield { type: 'phase-start', phaseName: 'validate', agentPath: 'a.md', ts: 10 + i };
        yield end('validate', 'fix[0]/validate', 20 + i);
      }
      yield { type: 'run-end', status: 'done', ts: 100 };
    }
    let terminal: TerminalInfo | null = null;
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      buildEventSource: () => source(),
      onTerminal: info => {
        terminal = info;
      },
      // no divergence config → warn-only default
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('done'); // NOT aborted
    const divEvents = (run?.events ?? []).filter(e => e.type === 'run-divergence');
    expect(divEvents).toHaveLength(1);
    expect((divEvents[0] as { aborted?: boolean }).aborted).toBe(false);
    expect((divEvents[0] as { repeats?: number }).repeats).toBe(6);
    // The onTerminal hook saw the verdict.
    const t = terminal as unknown as TerminalInfo;
    expect(t.divergence.diverged).toBe(true);
    expect(t.divergence.hotspots[0].phase).toBe('validate');
  });

  it('ABORT (opt-in): a thrashing run is cut short mid-flight with abort:true', async () => {
    // An "infinite" storm: keeps emitting the same phase instance. With
    // abort:true + threshold 4, the controller aborts at the 4th repeat — so the
    // later events never get appended.
    let emitted = 0;
    async function* source(signal: AbortSignal): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      for (let i = 0; i < 50; i++) {
        if (signal.aborted) return;
        emitted = i + 1;
        yield { type: 'phase-start', phaseName: 'validate', agentPath: 'a.md', ts: 10 + i };
        yield end('validate', 'fix[0]/validate', 200 + i);
        // Yield to the event loop so the controller can process + abort.
        await new Promise(r => setImmediate(r));
      }
      yield { type: 'run-end', status: 'done', ts: 9999 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      buildEventSource: (signal: AbortSignal) => source(signal),
      divergence: { repeatThreshold: 4, abort: true },
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    // The watchdog aborted it → terminal error (not a clean done).
    expect(run?.status).toBe('error');
    const divEvents = (run?.events ?? []).filter(e => e.type === 'run-divergence');
    expect(divEvents).toHaveLength(1);
    expect((divEvents[0] as { aborted?: boolean }).aborted).toBe(true);
    expect((divEvents[0] as { repeats?: number }).repeats).toBe(4);
    // It stopped early — far fewer than 50 iterations emitted.
    expect(emitted).toBeLessThan(20);
    // No clean run-end (it was cut short).
    expect((run?.events ?? []).some(e => e.type === 'run-end')).toBe(false);
  });

  it('a healthy run emits no run-divergence event and reports diverged:false', async () => {
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      yield { type: 'phase-start', phaseName: 'a', agentPath: 'a.md', ts: 2 };
      yield end('a', 'a', 3);
      yield { type: 'run-end', status: 'done', ts: 4 };
    }
    let terminal: TerminalInfo | null = null;
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      buildEventSource: () => source(),
      onTerminal: info => {
        terminal = info;
      },
    });
    await waitForFinish(id);
    const run = await store.getRun(id);
    expect((run?.events ?? []).some(e => e.type === 'run-divergence')).toBe(false);
    expect((terminal as unknown as TerminalInfo).divergence.diverged).toBe(false);
  });
});
