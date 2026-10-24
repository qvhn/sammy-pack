/**
 * Tests for the "done-but-degraded" run signal.
 *
 * A run that reaches `done` can still have swallowed an error (continueOnError /
 * finalizer / onError), finalized a fan-out with partials, been
 * stall-aborted on a node and carried on, or taken a documented fallback —
 * `status: done` masks all of it. The degraded signal makes that a first-class,
 * persisted, queryable property.
 *
 * Layers exercised here:
 *   1. computeDegradation / formatDegradationSummary — the pure event→verdict
 *      core (the single source of truth).
 *   2. buildTerminalNotifyPayload — the verdict folded into the notify text +
 *      structured fields.
 *   3. run-controller — the verdict computed at terminal from the durable event
 *      stream, persisted on the run record, and handed to the onTerminal hook
 *      (the production wiring).
 *   4. A REAL executor run with continueOnError — proving the executor actually
 *      emits the events the verdict keys on (not just a hand-built stream).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeDegradation,
  formatDegradationSummary,
} from '../src/server/degradation';
import { buildTerminalNotifyPayload } from '../src/server/notify';
import { SqliteRunStore } from '../src/server/db';
import {
  _resetForTests as _resetController,
  isActive,
  startRun,
  type TerminalInfo,
} from '../src/server/run-controller';
import { runOrchestration, type RunEvent } from '../src/llm/executor';
import type { Node } from '../src/types';
import type { StoredEvent } from '../src/server/run-store';

// ──────────────────────────────────────────────────────────────────────────
// 1 — computeDegradation / formatDegradationSummary (pure core)
// ──────────────────────────────────────────────────────────────────────────
describe('computeDegradation', () => {
  it('a clean run is not degraded (no reasons)', () => {
    const events: StoredEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts: 1 },
      { type: 'phase-start', phaseName: 'a', ts: 2 },
      { type: 'phase-end', phaseName: 'a', output: 'ok', ts: 3 },
      { type: 'run-end', status: 'done', ts: 4 },
    ];
    const result = computeDegradation(events);
    expect(result.degraded).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(formatDegradationSummary(result)).toBe('');
  });

  it('a swallowed phase-error is a degradation', () => {
    const events: StoredEvent[] = [
      { type: 'phase-start', phaseName: 'work', ts: 1 },
      { type: 'phase-error', phaseName: 'work', error: 'boom went the thing', ts: 2 },
      { type: 'phase-start', phaseName: 'next', ts: 3 },
      { type: 'phase-end', phaseName: 'next', output: 'fine', ts: 4 },
    ];
    const result = computeDegradation(events);
    expect(result.degraded).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].phase).toBe('work');
    expect(result.reasons[0].reason).toContain('swallowed phase error');
    expect(result.reasons[0].reason).toContain('boom went the thing');
  });

  it('a composite-partial (partial finalize) is a degradation', () => {
    const events: StoredEvent[] = [
      { type: 'composite-start', phaseName: 'fan', kind: 'parallel', ts: 1 },
      {
        type: 'composite-partial',
        phaseName: 'fan',
        kind: 'parallel',
        completed: 1,
        total: 3,
        ts: 2,
      },
      { type: 'composite-end', phaseName: 'fan', kind: 'parallel', ts: 3 },
    ];
    const result = computeDegradation(events);
    expect(result.degraded).toBe(true);
    expect(result.reasons[0].phase).toBe('fan');
    expect(result.reasons[0].reason).toContain('partial parallel finalize');
    expect(result.reasons[0].reason).toContain('1/3');
  });

  it('a node-stalled (aborted but continued) is a degradation', () => {
    const result = computeDegradation([
      { type: 'node-stalled', phaseName: 'wedged', stallSeconds: 30, ts: 1 },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.reasons[0].reason).toContain('stall-aborted');
    expect(result.reasons[0].reason).toContain('30s');
  });

  it('a node-recovered (onError fallback) is a degradation', () => {
    const result = computeDegradation([
      { type: 'node-recovered', phaseName: 'risky', error: 'primary failed', ts: 1 },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.reasons[0].reason).toContain('onError fallback');
    expect(result.reasons[0].reason).toContain('primary failed');
  });

  it('unresolved interpolation refs are a degradation', () => {
    const result = computeDegradation([
      {
        type: 'interpolation-unresolved',
        phaseName: 'report',
        refs: ['releaseNotes', 'qaSummary'],
        ts: 1,
      },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.reasons[0].reason).toContain('unresolved interpolation refs');
    expect(result.reasons[0].reason).toContain('releaseNotes');
  });

  it('an empty upstream binding (binding-empty) is a degradation', () => {
    const result = computeDegradation([
      {
        type: 'binding-empty',
        phaseName: 'publish',
        bindings: ['crawlerSummary'],
        ts: 1,
      },
    ]);
    expect(result.degraded).toBe(true);
    expect(result.reasons[0].phase).toBe('publish');
    expect(result.reasons[0].reason).toContain('empty upstream binding');
    expect(result.reasons[0].reason).toContain('crawlerSummary');
  });

  it('node-retried alone (a transient blip that recovered) is NOT a degradation', () => {
    const result = computeDegradation([
      {
        type: 'node-retried',
        phaseName: 'flaky',
        attempt: 1,
        maxAttempts: 3,
        error: 'transient',
        delayMs: 10,
        ts: 1,
      },
      { type: 'phase-end', phaseName: 'flaky', output: 'ok', ts: 2 },
    ]);
    expect(result.degraded).toBe(false);
  });

  it('tools-warning (an author/config concern) is NOT a degradation', () => {
    const result = computeDegradation([
      { type: 'tools-warning', phaseName: 'agent', missing: ['Bash'], ts: 1 },
    ]);
    expect(result.degraded).toBe(false);
  });

  it('collects multiple reasons in chronological order', () => {
    const result = computeDegradation([
      { type: 'phase-error', phaseName: 'a', error: 'first', ts: 1 },
      {
        type: 'composite-partial',
        phaseName: 'fan',
        kind: 'map',
        completed: 2,
        total: 5,
        ts: 2,
      },
    ]);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0].phase).toBe('a');
    expect(result.reasons[1].phase).toBe('fan');
  });
});

describe('formatDegradationSummary', () => {
  it('renders a DEGRADED (N): … one-liner', () => {
    const line = formatDegradationSummary({
      degraded: true,
      reasons: [
        { phase: 'work', reason: 'swallowed phase error: boom' },
        { phase: 'fan', reason: 'partial map finalize — 1/3 items completed before the deadline' },
      ],
    });
    expect(line.startsWith('DEGRADED (2): ')).toBe(true);
    expect(line).toContain('work: swallowed phase error: boom');
    expect(line).toContain(' ; ');
    expect(line).toContain('fan: partial map finalize');
  });

  it('is empty for a clean verdict', () => {
    expect(formatDegradationSummary({ degraded: false, reasons: [] })).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2 — notify payload folds in the degraded verdict
// ──────────────────────────────────────────────────────────────────────────
describe('buildTerminalNotifyPayload — degraded folding', () => {
  it('prepends the DEGRADED banner to the summary and sets the structured fields', () => {
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'run-d1',
      orchestration: 'nightly-sweep',
      status: 'done',
      lastOutput: 'final report body',
      degraded: true,
      degradationReasons: [{ phase: 'sweep', reason: 'swallowed phase error: timeout' }],
    });
    expect(payload.status).toBe('done');
    expect(payload.degraded).toBe(true);
    expect(payload.degradationReasons).toEqual([
      { phase: 'sweep', reason: 'swallowed phase error: timeout' },
    ]);
    // Banner first, then the output tail.
    expect(payload.summary?.startsWith('DEGRADED (1): ')).toBe(true);
    expect(payload.summary).toContain('final report body');
  });

  it('a clean run omits degraded fields entirely (byte-identical to before)', () => {
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'run-clean',
      orchestration: 'o',
      status: 'done',
      lastOutput: 'all green',
      degraded: false,
      degradationReasons: [],
    });
    expect('degraded' in payload).toBe(false);
    expect('degradationReasons' in payload).toBe(false);
    expect(payload.summary).toBe('all green');
  });

  it('the degraded banner is emitted even with no output tail', () => {
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'run-d2',
      orchestration: 'o',
      status: 'done',
      lastOutput: null,
      degraded: true,
      degradationReasons: [{ phase: 'p', reason: 'partial parallel finalize — 0/2' }],
    });
    expect(payload.summary).toBe('DEGRADED (1): p: partial parallel finalize — 0/2');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3 — run-controller persists the verdict + hands it to onTerminal
// ──────────────────────────────────────────────────────────────────────────
describe('run-controller — done-but-degraded persistence', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    _resetController();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-degraded-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
  });
  afterEach(async () => {
    _resetController();
    await store.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function waitForFinish(id: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (isActive(id)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for run ${id}`);
      }
      await new Promise(r => setImmediate(r));
    }
  }

  it('a continueOnError-style swallowed error → done + degraded:true + reason persisted', async () => {
    // Mirrors what the executor emits for a continueOnError sibling: a
    // phase-error, then the sequence continues, then a clean run-end.
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      yield { type: 'phase-start', phaseName: 'work', agentPath: 'agents/a.md', ts: 2 };
      yield { type: 'phase-error', phaseName: 'work', error: 'agent exploded', ts: 3 };
      yield { type: 'phase-start', phaseName: 'cleanup', agentPath: 'agents/b.md', ts: 4 };
      yield {
        type: 'phase-end',
        phaseName: 'cleanup',
        output: 'cleaned',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1,
        model: 'm',
        ts: 5,
      };
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
    expect(run?.status).toBe('done');
    expect(run?.degraded).toBe(true);
    expect(run?.degradationReasons).toHaveLength(1);
    expect(run?.degradationReasons[0].phase).toBe('work');
    expect(run?.degradationReasons[0].reason).toContain('agent exploded');

    // The onTerminal hook saw the verdict too (this is what feeds the notify).
    expect(terminal).not.toBeNull();
    const t = terminal as unknown as TerminalInfo;
    expect(t.status).toBe('done');
    expect(t.degraded).toBe(true);
    expect(t.degradationReasons[0].phase).toBe('work');

    // The summary endpoint surfaces it without loading events.
    const summary = await store.getRunSummary(id);
    expect(summary?.degraded).toBe(true);
    expect(summary?.degradationReasons).toHaveLength(1);
  });

  it('a partial finalize (composite-partial) → done + degraded:true', async () => {
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      yield { type: 'composite-start', phaseName: 'fan', kind: 'map', ts: 2 };
      yield {
        type: 'composite-partial',
        phaseName: 'fan',
        kind: 'map',
        completed: 2,
        total: 4,
        ts: 3,
      };
      yield { type: 'composite-end', phaseName: 'fan', kind: 'map', ts: 4 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('done');
    expect(run?.degraded).toBe(true);
    expect(run?.degradationReasons[0].phase).toBe('fan');
    expect(run?.degradationReasons[0].reason).toContain('2/4');
  });

  it('a fully clean run → done + degraded:false + []', async () => {
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      yield { type: 'phase-start', phaseName: 'a', agentPath: 'agents/a.md', ts: 2 };
      yield {
        type: 'phase-end',
        phaseName: 'a',
        output: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1,
        model: 'm',
        ts: 3,
      };
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
    expect(run?.status).toBe('done');
    expect(run?.degraded).toBe(false);
    expect(run?.degradationReasons).toEqual([]);
    const t = terminal as unknown as TerminalInfo;
    expect(t.degraded).toBe(false);
  });

  it('an ERRORED run is not flagged degraded (status already signals it)', async () => {
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      // A phase-error THEN a terminal run-error (the error became terminal —
      // it was NOT swallowed, so this is a plain failure, not a degraded done).
      yield { type: 'phase-error', phaseName: 'work', error: 'fatal', ts: 2 };
      yield { type: 'run-error', error: 'fatal', ts: 3 };
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      buildEventSource: () => source(),
    });
    await waitForFinish(id);

    const run = await store.getRun(id);
    expect(run?.status).toBe('error');
    expect(run?.degraded).toBe(false);
    expect(run?.degradationReasons).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4 — REAL executor: continueOnError emits the events the verdict keys on
// ──────────────────────────────────────────────────────────────────────────
jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: {
    system?: string;
    messages: { role: string; content: string }[];
  }) {
    const sys = params.system ?? '';
    // The phase whose agent text contains "Exploder" throws; everything else
    // returns a trivial completion.
    let stage = 0;
    const willThrow = sys.includes('Exploder');
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (stage === 0) {
              stage = 1;
              if (willThrow) throw new Error('exploder phase failed');
              return { value: { type: 'text-delta', text: 'fine' }, done: false };
            }
            if (stage === 1) {
              stage = 2;
              return {
                value: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
}));

jest.mock('../src/api', () => ({
  listAgents: async () => [
    { name: 'boom', raw: '---\nname: boom\n---\nExploder agent.' },
    { name: 'ok', raw: '---\nname: ok\n---\nFine agent.' },
  ],
  listOrchestrations: async () => [],
}));

describe('real executor + computeDegradation (continueOnError)', () => {
  it('a continueOnError phase that throws → run ends done, verdict is degraded', async () => {
    const orchestration: Node = {
      name: 'flow',
      phases: [
        { name: 'explode', agent: 'agents/boom.md', continueOnError: true },
        { name: 'carry-on', agent: 'agents/ok.md' },
      ],
    };
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      waitForApproval: async () => true,
      cancelled: { v: false },
    })) {
      events.push(ev);
    }

    // The run completed (the error was swallowed by continueOnError).
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    expect(events.some(e => e.type === 'run-error')).toBe(false);
    // …and the same events the controller persists make the verdict degraded.
    const verdict = computeDegradation(events as unknown as StoredEvent[]);
    expect(verdict.degraded).toBe(true);
    expect(verdict.reasons.some(r => r.phase === 'explode')).toBe(true);
    expect(verdict.reasons[0].reason).toContain('exploder phase failed');
  });
});
