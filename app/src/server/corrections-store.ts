/**
 * The calibration flywheel — turn a human's override of a judge decision into a
 * labeled correction that GROWS the calibration corpus, so re-running the eval
 * measures (and the rubric is tuned against) real misroutes instead of a frozen
 * seed set.
 *
 * The loop:
 *   1. a judge routes a signal (predicted branch)
 *   2. a human overrides it at a gate (the correct branch)
 *   3. recordCorrection() appends/updates a row in the calibration dataset
 *      (input = the signal, expectedOutput = the human's label, tagged
 *      `correction` with the predicted value kept in metadata)
 *   4. re-run the eval → accuracy is now measured against the grown corpus
 *
 * This is what makes the system compound: it gets more calibrated the more it
 * runs, because every disagreement becomes training signal. Persistence reuses
 * the file-backed dataset format (datasets/<name>.json) — no new store.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export type Correction = {
  /** The signal that was classified (the dataset row's input). */
  input: string;
  /** The human's correct label — becomes the row's expectedOutput. */
  corrected: string;
  /** What the judge predicted (kept in metadata for drift analysis). */
  predicted?: string;
  /** Provenance: 'human-override', a reviewer id, a runId, etc. */
  source?: string;
};

export type CorrectionResult = {
  dataset: string;
  rows: number;
  action: 'added' | 'updated';
  rowId: string;
};

type DatasetRow = {
  id: string;
  input: string;
  expectedOutput?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};
type Dataset = {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  rows: DatasetRow[];
};

export function isSafeDatasetName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Append (or update) a labeled correction in a calibration dataset. Dedupes by
 * input — a re-correction of the same signal updates the existing row rather
 * than piling up duplicates, so the corpus stays a clean set of ground-truth
 * labels. Creates the dataset if it doesn't exist yet.
 */
export async function recordCorrection(
  datasetsDir: string,
  datasetName: string,
  c: Correction,
  now: number,
): Promise<CorrectionResult> {
  if (!isSafeDatasetName(datasetName)) {
    throw new Error(`invalid dataset name: ${datasetName}`);
  }
  if (!c.input?.trim()) throw new Error('correction.input is required');
  if (!c.corrected?.trim()) throw new Error('correction.corrected is required');

  const file = path.join(datasetsDir, `${datasetName}.json`);
  let ds: Dataset;
  try {
    ds = JSON.parse(await fs.readFile(file, 'utf8')) as Dataset;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    ds = {
      name: datasetName,
      description: 'Calibration corpus grown from human corrections.',
      createdAt: now,
      updatedAt: now,
      rows: [],
    };
  }
  ds.rows = Array.isArray(ds.rows) ? ds.rows : [];

  const meta = { predicted: c.predicted ?? null, source: c.source ?? 'human-override', correctedAt: now };
  const existing = ds.rows.find(r => (r.input ?? '').trim() === c.input.trim());
  let action: 'added' | 'updated';
  let rowId: string;
  if (existing) {
    existing.expectedOutput = c.corrected;
    existing.metadata = { ...(existing.metadata ?? {}), ...meta };
    existing.tags = Array.from(new Set([...(existing.tags ?? []), 'correction']));
    action = 'updated';
    rowId = existing.id;
  } else {
    rowId = `corr-${now}-${ds.rows.length + 1}`;
    ds.rows.push({
      id: rowId,
      input: c.input,
      expectedOutput: c.corrected,
      tags: ['correction'],
      metadata: meta,
    });
    action = 'added';
  }
  ds.updatedAt = now;

  await fs.mkdir(datasetsDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(ds, null, 2) + '\n', 'utf8');
  return { dataset: datasetName, rows: ds.rows.length, action, rowId };
}

/**
 * Derive the (input, predicted-branch) pair from a finished run, so a caller
 * only has to supply the human's corrected label. The predicted branch is the
 * last `route-decision` in the run; the input is the run's initial input.
 */
export function deriveDecision(run: {
  initialInput?: string | null;
  events?: Array<{ type: string; branch?: string }>;
}): { input: string; predicted: string | null } {
  let predicted: string | null = null;
  for (const e of run.events ?? []) {
    if (e.type === 'route-decision' && e.branch) predicted = e.branch;
  }
  return { input: (run.initialInput ?? '').toString(), predicted };
}
