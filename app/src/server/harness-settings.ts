/**
 * Workspace defaults for harness runs, in `<root>/harness.json`.
 *
 * The default strictness, and which terminal app a takeover opens. It is SERVER-side on purpose:
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

/** Which app "open in a terminal" uses on macOS. */
export const TERMINAL_APPS = ['cmux', 'terminal'] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

export function isTerminalApp(v: unknown): v is TerminalApp {
  return typeof v === 'string' && (TERMINAL_APPS as readonly string[]).includes(v);
}

export type HarnessSettings = {
  /** Default strictness for harness runs; null = the built-in `strict`. */
  follow: HarnessFollow | null;
  /** The app a takeover opens; null = cmux when installed, else Terminal. */
  terminal: TerminalApp | null;
};

export function harnessSettingsFile(root: string): string {
  return path.join(root, HARNESS_SETTINGS_FILE);
}

/** Read the file; a missing or unreadable file is the built-in default. */
export function readHarnessSettingsSync(file: string): HarnessSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { follow?: unknown; terminal?: unknown };
    return {
      follow: isHarnessFollow(parsed?.follow) ? parsed.follow : null,
      terminal: isTerminalApp(parsed?.terminal) ? parsed.terminal : null,
    };
  } catch {
    return { follow: null, terminal: null };
  }
}

/** Write the keys `settings` names; the others keep what the file has. */
export async function writeHarnessSettings(
  file: string,
  settings: Partial<HarnessSettings>,
): Promise<HarnessSettings> {
  const current = readHarnessSettingsSync(file);
  const next: HarnessSettings = {
    follow:
      'follow' in settings ? (isHarnessFollow(settings.follow) ? settings.follow : null) : current.follow,
    terminal:
      'terminal' in settings ? (isTerminalApp(settings.terminal) ? settings.terminal : null) : current.terminal,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
  return next;
}
