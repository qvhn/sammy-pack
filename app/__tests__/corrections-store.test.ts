/**
 * The calibration flywheel — corrections grow the corpus. Uses a real temp dir
 * so the file-backed dataset mutation is what's under test.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordCorrection,
  deriveDecision,
  isSafeDatasetName,
} from '../src/server/corrections-store';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-corr-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function loadRows(name: string) {
  const ds = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8'));
  return ds.rows as Array<{ id: string; input: string; expectedOutput: string; tags?: string[]; metadata?: Record<string, unknown> }>;
}

describe('corrections-store (the flywheel)', () => {
  test('a correction on a fresh dataset creates it and adds a labeled row', async () => {
    const res = await recordCorrection(dir, 'sev-cal', {
      input: 'DB down, all users 500',
      corrected: 'critical',
      predicted: 'high',
      source: 'human-override',
    }, 1000);
    expect(res).toMatchObject({ dataset: 'sev-cal', rows: 1, action: 'added' });
    const rows = await loadRows('sev-cal');
    expect(rows[0]).toMatchObject({
      input: 'DB down, all users 500',
      expectedOutput: 'critical',
      tags: ['correction'],
    });
    expect(rows[0].metadata).toMatchObject({ predicted: 'high', source: 'human-override' });
  });

  test('the corpus GROWS — each distinct correction is a new labeled row', async () => {
    await recordCorrection(dir, 'c', { input: 'a', corrected: 'high' }, 1);
    await recordCorrection(dir, 'c', { input: 'b', corrected: 'low' }, 2);
    await recordCorrection(dir, 'c', { input: 'c', corrected: 'medium' }, 3);
    expect((await loadRows('c')).length).toBe(3);
  });

  test('re-correcting the same input UPDATES the label (dedupe), not duplicates', async () => {
    await recordCorrection(dir, 'c', { input: 'same signal', corrected: 'high', predicted: 'medium' }, 1);
    const res = await recordCorrection(dir, 'c', { input: 'same signal', corrected: 'critical', predicted: 'high' }, 2);
    expect(res.action).toBe('updated');
    const rows = await loadRows('c');
    expect(rows.length).toBe(1);
    expect(rows[0].expectedOutput).toBe('critical');
    expect(rows[0].metadata).toMatchObject({ predicted: 'high', correctedAt: 2 });
  });

  test('appends to an EXISTING seed dataset without clobbering its rows', async () => {
    await fs.writeFile(path.join(dir, 'seed.json'), JSON.stringify({
      name: 'seed', createdAt: 1, updatedAt: 1,
      rows: [{ id: 'seed-1', input: 'orig', expectedOutput: 'low' }],
    }) + '\n');
    await recordCorrection(dir, 'seed', { input: 'new signal', corrected: 'high' }, 5);
    const rows = await loadRows('seed');
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.id)).toEqual(['seed-1', expect.stringContaining('corr-')]);
  });

  test('rejects empty input/label and unsafe dataset names', async () => {
    await expect(recordCorrection(dir, 'c', { input: '', corrected: 'x' }, 1)).rejects.toThrow();
    await expect(recordCorrection(dir, 'c', { input: 'x', corrected: '' }, 1)).rejects.toThrow();
    await expect(recordCorrection(dir, '../evil', { input: 'x', corrected: 'y' }, 1)).rejects.toThrow();
    expect(isSafeDatasetName('severity-calibration')).toBe(true);
    expect(isSafeDatasetName('../x')).toBe(false);
  });

  test('deriveDecision pulls input + last route-decision branch from a run', () => {
    const d = deriveDecision({
      initialInput: 'some incident',
      events: [
        { type: 'phase-start' },
        { type: 'route-decision', branch: 'high' },
        { type: 'phase-end' },
      ],
    });
    expect(d).toEqual({ input: 'some incident', predicted: 'high' });
  });

  test('deriveDecision handles a run with no routing (predicted null)', () => {
    expect(deriveDecision({ initialInput: 'x', events: [{ type: 'phase-end' }] }))
      .toEqual({ input: 'x', predicted: null });
  });
});
