/**
 * Tests for the structured run-NOTES summary (the human-readable run-end note).
 *
 * computeRunNotes derives, purely from the durable event stream: per-item
 * {id, status, retriesUsed, pr, cause, signals} + run totals (succeeded /
 * failed / incomplete / promoted) + health flags (RETRY STORM, DEGRADED,
 * exhausted). formatRunNotes renders it as a compact plain-text block for the
 * notify webhook. Future event types ("promoted", "stage-validated", "figma…")
 * are picked up automatically into per-item signals.
 *
 * Layers exercised:
 *   1. computeRunNotes — the pure event→notes core (items, verdicts, retries,
 *      pr/promoted, fan-out grouping, forward-compat signal capture).
 *   2. formatRunNotes — clean plain-text rendering.
 *   3. buildTerminalNotifyPayload — notes + divergence folded into the webhook.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRunNotes, formatRunNotes } from '../src/server/run-notes';
import { buildTerminalNotifyPayload } from '../src/server/notify';
import { SqliteRunStore } from '../src/server/db';
import {
  _resetForTests as _resetController,
  isActive,
  startRun,
  type TerminalInfo,
} from '../src/server/run-controller';
import type { StoredEvent } from '../src/server/run-store';

function end(
  phaseName: string,
  replayKey: string,
  ts: number,
  output = 'ok',
): StoredEvent {
  return { type: 'phase-end', phaseName, replayKey, output, ts };
}

// ──────────────────────────────────────────────────────────────────────────
// 1 — pure core
// ──────────────────────────────────────────────────────────────────────────
describe('computeRunNotes', () => {
  it('a flat clean run → one (run) item, succeeded, no retries', () => {
    const events: StoredEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts: 1 },
      { type: 'phase-start', phaseName: 'a', ts: 2 },
      end('a', 'a', 3),
      { type: 'run-end', status: 'done', ts: 4 },
    ];
    const notes = computeRunNotes(events, { runId: 'r1', status: 'done' });
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0].id).toBe('(run)');
    expect(notes.items[0].status).toBe('succeeded');
    expect(notes.items[0].retriesUsed).toBe(0);
    expect(notes.totals.succeeded).toBe(1);
    expect(notes.totals.failed).toBe(0);
    expect(notes.totals.health).toEqual([]);
  });

  it('groups a map fan-out into per-item rows by scope (distinct items per index)', () => {
    const events: StoredEvent[] = [
      { type: 'map-iteration', phaseName: 'fan', iteration: 1, total: 3, ts: 1 },
      end('work', 'fan[0]/work', 2),
      { type: 'map-iteration', phaseName: 'fan', iteration: 2, total: 3, ts: 3 },
      end('work', 'fan[1]/work', 4),
      { type: 'map-iteration', phaseName: 'fan', iteration: 3, total: 3, ts: 5 },
      end('work', 'fan[2]/work', 6),
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    expect(notes.items).toHaveLength(3);
    expect(notes.items.map(i => i.id).sort()).toEqual(['fan[0]', 'fan[1]', 'fan[2]']);
    expect(notes.totals.succeeded).toBe(3);
  });

  it('a loop collapses all its iterations into ONE item (refinement of the same work)', () => {
    const events: StoredEvent[] = [
      { type: 'loop-iteration', phaseName: 'refine', iteration: 1, ts: 1 },
      end('edit', 'refine@1/edit', 2),
      { type: 'loop-iteration', phaseName: 'refine', iteration: 2, ts: 3 },
      end('edit', 'refine@2/edit', 4),
      { type: 'loop-iteration', phaseName: 'refine', iteration: 3, ts: 5 },
      end('edit', 'refine@3/edit', 6),
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    expect(notes.items).toHaveLength(1); // ONE item, not three
    expect(notes.items[0].id).toBe('refine');
    // Each iteration's `edit` is a separate phase-end of the SAME item, so the
    // 2 re-iterations count as retries on that one item.
    expect(notes.items[0].retriesUsed).toBe(2);
  });

  it('counts retries from repeated phase-end of the same (flat) phase + node-retried', () => {
    const events: StoredEvent[] = [
      end('validate', 'validate', 1), // 1st
      end('validate', 'validate', 2), // repeat → +1 retry
      end('validate', 'validate', 3), // repeat → +1 retry
      { type: 'node-retried', phaseName: 'validate', attempt: 1, maxAttempts: 3, error: 'x', delayMs: 0, ts: 4 },
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    const item = notes.items.find(i => i.id === '(run)');
    expect(item?.retriesUsed).toBe(3); // 2 phase-end repeats + 1 node-retried
  });

  it('a terminal failure marks the item failed with the reason as cause', () => {
    const events: StoredEvent[] = [
      { type: 'phase-start', phaseName: 'validate', ts: 1 },
      { type: 'phase-terminal', phaseName: 'validate', reason: 'validator offline', retriesSuppressed: 2, ts: 2 },
    ];
    const notes = computeRunNotes(events, { status: 'error' });
    const item = notes.items[0];
    expect(item.status).toBe('failed');
    expect(item.cause).toContain('validator offline');
    expect(notes.totals.failed).toBe(1);
  });

  it('a swallowed phase-error followed by a clean end flips the item back to succeeded (continueOnError)', () => {
    const events: StoredEvent[] = [
      { type: 'phase-error', phaseName: 'a', error: 'blip', ts: 1 },
      end('a', 'a', 2),
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    expect(notes.items[0].status).toBe('succeeded');
  });

  it('a started-but-never-finished item is incomplete', () => {
    const events: StoredEvent[] = [
      { type: 'map-iteration', phaseName: 'fan', iteration: 1, total: 2, ts: 1 },
      end('work', 'fan[0]/work', 2),
      { type: 'map-iteration', phaseName: 'fan', iteration: 2, total: 2, ts: 3 },
      // item fan[1] started but never produced a phase-end (cut short)
    ];
    const notes = computeRunNotes(events, { status: 'error' });
    const item1 = notes.items.find(i => i.id === 'fan[1]');
    expect(item1?.status).toBe('incomplete');
    expect(notes.totals.incomplete).toBe(1);
  });

  it('surfaces a PR URL and counts it as promoted', () => {
    const events: StoredEvent[] = [
      end('open-pr', 'open-pr', 1, 'Opened https://example.test/pulls/42'),
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    expect(notes.items[0].pr).toBe('https://example.test/pulls/42');
    expect(notes.totals.promoted).toBe(1);
  });

  it('folds divergence + degraded verdicts into health flags', () => {
    const notes = computeRunNotes([end('a', 'a', 1)], {
      status: 'done',
      degradation: { degraded: true, reasons: [{ phase: 'x', reason: 'swallowed' }] },
      divergence: {
        diverged: true,
        threshold: 6,
        maxRepeats: 9,
        hotspots: [{ phase: 'validate', key: 'fix[0]/validate', repeats: 9 }],
      },
    });
    expect(notes.totals.health.some(h => h.startsWith('RETRY STORM'))).toBe(true);
    expect(notes.totals.health.some(h => h.startsWith('DEGRADED'))).toBe(true);
  });

  it('loop-exhausted is a failed item flagged "exhausted"', () => {
    const events: StoredEvent[] = [
      { type: 'loop-iteration', phaseName: 'refine', iteration: 1, ts: 1 },
      { type: 'loop-exhausted', phaseName: 'refine', iteration: 3, failures: 3, maxFailures: 3, ts: 2 },
    ];
    const notes = computeRunNotes(events, { status: 'error' });
    expect(notes.items[0].status).toBe('failed');
    expect(notes.items[0].cause).toContain('exhausted');
    expect(notes.totals.health.some(h => h.includes('exhausted'))).toBe(true);
  });

  it('FORWARD-COMPAT: an unknown milestone event lands in per-item signals automatically', () => {
    // A future event type the code has never seen — picked up because its type
    // matches the milestone vocabulary and it carries a phase scope + a value.
    const events: StoredEvent[] = [
      end('ship', 'ship[0]/ship', 1),
      { type: 'promoted-to-stage', phaseName: 'ship', replayKey: 'ship[0]/ship', url: 'https://stage.test/build/9', ts: 2 },
    ];
    const notes = computeRunNotes(events, { status: 'done' });
    const item = notes.items.find(i => i.id === 'ship[0]');
    expect(item?.signals?.['promoted-to-stage']).toBe('https://stage.test/build/9');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2 — plain-text rendering
// ──────────────────────────────────────────────────────────────────────────
describe('formatRunNotes', () => {
  it('renders a clean plain-text block: totals line + per-item lines', () => {
    const notes = computeRunNotes(
      [
        end('a', 'fan[0]/a', 1),
        { type: 'phase-terminal', phaseName: 'b', replayKey: 'fan[1]/b', reason: 'infra down', retriesSuppressed: 1, ts: 2 },
      ],
      { status: 'error' },
    );
    const text = formatRunNotes(notes);
    expect(text).toContain('Run summary:');
    expect(text).toContain('1 ok');
    expect(text).toContain('1 failed');
    expect(text).toContain('fan[0]: succeeded');
    expect(text).toContain('fan[1]: failed');
    expect(text).toContain('infra down');
    // No markdown table pipes — plain text.
    expect(text).not.toContain('|');
  });

  it('shows retries and pr per item', () => {
    const notes = computeRunNotes(
      [
        end('v', 'fix[0]/v', 1),
        end('v', 'fix[0]/v', 2), // a retry
        end('pr', 'fix[0]/pr', 3, 'https://example.test/p/1'),
      ],
      { status: 'done' },
    );
    const text = formatRunNotes(notes);
    expect(text).toMatch(/retr(y|ies)/);
    expect(text).toContain('pr https://example.test/p/1');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3 — notify folds notes + divergence into the webhook
// ──────────────────────────────────────────────────────────────────────────
describe('buildTerminalNotifyPayload — notes + divergence folding', () => {
  it('prepends the RETRY STORM banner and appends the notes block', () => {
    const notes = computeRunNotes([end('a', 'a', 1)], { status: 'done' });
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'r1',
      orchestration: 'sweep',
      status: 'done',
      lastOutput: 'final output tail',
      divergence: {
        diverged: true,
        threshold: 6,
        maxRepeats: 12,
        hotspots: [{ phase: 'validate', key: 'fix[0]/validate', repeats: 12 }],
      },
      notes,
    });
    expect(payload.summary?.startsWith('RETRY STORM')).toBe(true);
    expect(payload.summary).toContain('Run summary:');
    expect(payload.summary).toContain('final output tail');
    expect(payload.divergence?.diverged).toBe(true);
    expect(payload.notes).toBeDefined();
    expect(payload.notes?.totals.items).toBe(1);
  });

  it('a clean run omits divergence/notes-driven banners but still attaches notes', () => {
    const notes = computeRunNotes([end('a', 'a', 1)], { status: 'done' });
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'r2',
      orchestration: 'o',
      status: 'done',
      lastOutput: 'all green',
      notes,
    });
    // No RETRY STORM / DEGRADED banner; the notes block + tail are present.
    expect(payload.summary).not.toContain('RETRY STORM');
    expect(payload.summary).toContain('Run summary:');
    expect(payload.summary).toContain('all green');
    expect('divergence' in payload).toBe(false);
    expect(payload.notes).toBeDefined();
  });

  it('backward-compat: omitting notes + divergence reproduces the prior envelope exactly', () => {
    const payload = buildTerminalNotifyPayload({
      notify: { onTerminal: 'http://hook.test/x' },
      runId: 'r3',
      orchestration: 'o',
      status: 'done',
      lastOutput: 'just the tail',
    });
    expect(payload.summary).toBe('just the tail');
    expect('divergence' in payload).toBe(false);
    expect('notes' in payload).toBe(false);
    expect('degraded' in payload).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4 — run-controller hands the notes to onTerminal (the production wiring)
// ──────────────────────────────────────────────────────────────────────────
describe('run-controller — run-notes at terminal', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    _resetController();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-notes-'));
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

  it('a fan-out run produces per-item notes on the onTerminal hook', async () => {
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'run-start', orchestrationName: 'flow', ts: 1 };
      // item [0] succeeds, item [1] fails terminally.
      yield { type: 'map-iteration', phaseName: 'fan', iteration: 1, total: 2, ts: 2 };
      yield {
        type: 'phase-start', phaseName: 'work', agentPath: 'a.md', ts: 3,
      };
      yield {
        type: 'phase-end', phaseName: 'work', replayKey: 'fan[0]/work',
        output: 'ok', inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1, model: 'm', ts: 4,
      };
      yield { type: 'map-iteration', phaseName: 'fan', iteration: 2, total: 2, ts: 5 };
      yield {
        type: 'phase-terminal', phaseName: 'work', replayKey: 'fan[1]/work',
        reason: 'validator offline', retriesSuppressed: 0, ts: 6,
      };
      yield { type: 'run-end', status: 'done', ts: 7 };
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

    const t = terminal as unknown as TerminalInfo;
    expect(t.notes).toBeDefined();
    expect(t.notes.totals.items).toBe(2);
    expect(t.notes.totals.succeeded).toBe(1);
    expect(t.notes.totals.failed).toBe(1);
    const failed = t.notes.items.find(i => i.status === 'failed');
    expect(failed?.cause).toContain('validator offline');
    // The compact text renders cleanly.
    expect(formatRunNotes(t.notes)).toContain('Run summary:');
  });
});
