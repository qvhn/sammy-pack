/**
 * Workspace defaults for harness runs, in `<root>/harness.json`.
 *
 * Only the default strictness lives here today. It is SERVER-side on purpose:
 * a harness run started by a cron, a webhook or the API has no browser, and
 * must follow the same default as one started from the Run dialog.
 *
 * Precedence, highest first (resolveFollow): the run's own choice (Run dialog
 * / start API) → the orchestration's `harness.follow` → this file → `strict`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isHarnessFollow } from '../llm/harness';
import type { HarnessFollow } from '../types';

export const HARNESS_SETTINGS_FILE = 'harness.json';

export type HarnessSettings = {
  /** Default strictness for harness runs; null = the built-in `strict`. */
  follow: HarnessFollow | null;
};

export function harnessSettingsFile(root: string): string {
  return path.join(root, HARNESS_SETTINGS_FILE);
}

/** Read the file; a missing or unreadable file is the built-in default. */
export function readHarnessSettingsSync(file: string): HarnessSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { follow?: unknown };
    return { follow: isHarnessFollow(parsed?.follow) ? parsed.follow : null };
  } catch {
    return { follow: null };
  }
}

export async function writeHarnessSettings(
  file: string,
  settings: HarnessSettings,
): Promise<HarnessSettings> {
  const next: HarnessSettings = { follow: isHarnessFollow(settings.follow) ? settings.follow : null };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
  return next;
}
