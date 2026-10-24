/**
 * A run's resolved inputs are in its row from the moment it is created — not
 * only at the first checkpoint. A run interrupted during its first step (a
 * restart mid-plan) used to resume with no `${ticket}` at all.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import { _resetForTests as _resetController, cancel, startRun } from '../src/server/run-controller';
import type { StoredEvent } from '../src/server/run-store';

describe('resolved inputs at run start', () => {
  let tmpRoot: string;
  let store: SqliteRunStore;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-inputs-start-'));
    store = new SqliteRunStore(tmpRoot);
    await store.init();
  });
  afterEach(async () => {
    _resetController();
    await store.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('are stored before the first step finishes', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    // A first step that never completes until released — no checkpoint yet.
    async function* source(): AsyncIterable<StoredEvent> {
      yield { type: 'phase-start', phaseName: 'plan', ts: Date.now() } as StoredEvent;
      await held;
    }
    const { id } = await startRun({
      store,
      orchestrationName: 'flow',
      resolvedInputs: { ticket: 'ABC-2 — wrong average' },
      buildEventSource: () => source(),
    });
    const row = await store.getRun(id);
    expect((row?.stateJson as { resolvedInputs?: unknown } | null)?.resolvedInputs).toEqual({
      ticket: 'ABC-2 — wrong average',
    });
    cancel(id);
    release();
  });
});
