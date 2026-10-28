/** Workspace defaults for harness runs — the thin browser client for
 *  `GET` / `PUT /api/harness/settings`. The default strictness lives on the
 *  server (`harness.json`), so a harness run a trigger or the API starts
 *  follows the same default as one started from the Run dialog. */

import { requestFailure } from '../api';
import type { HarnessFollow } from '../types';

export type HarnessSettings = {
  /** null = the built-in default, strict. */
  follow: HarnessFollow | null;
};

export async function getHarnessSettings(): Promise<HarnessSettings> {
  const res = await fetch('/api/harness/settings');
  if (!res.ok) throw await requestFailure('GET /api/harness/settings', res);
  return (await res.json()) as HarnessSettings;
}

export async function saveHarnessSettings(settings: HarnessSettings): Promise<HarnessSettings> {
  const res = await fetch('/api/harness/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw await requestFailure('PUT /api/harness/settings', res);
  return (await res.json()) as HarnessSettings;
}

/** One line on what each strictness means — shared by the Run dialog and
 *  Settings so the two never describe it differently. */
export const FOLLOW_HELP: Record<HarnessFollow, string> = {
  strict: 'Does the steps in order; a step starts only when the one before it is done.',
  loose: 'Any order, and it may go back to a step — but every required step must be done.',
  advisory: 'The steps are a guide: it may skip one, saying why, and the run is marked degraded.',
};

/** Whether a terminal is driving a harness run, and the command that opens
 *  it (with the leg's one-time token) when one is. */
export async function getRunTerminal(runId: string): Promise<{ live: boolean; command: string | null }> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/terminal`);
  if (!res.ok) throw await requestFailure('GET /api/runs/:id/terminal', res);
  return (await res.json()) as { live: boolean; command: string | null };
}

/** Take a harness run over in a terminal. `open` also opens a terminal
 *  window on the server's machine (when the server is this machine). */
export async function takeOverInTerminal(
  runId: string,
  open: boolean,
): Promise<{ live: boolean; command: string; opened?: { opened: boolean; reason?: string } }> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/terminal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ open }),
  });
  if (!res.ok) throw await requestFailure('Taking the run over', res);
  return (await res.json()) as { live: boolean; command: string; opened?: { opened: boolean; reason?: string } };
}

/** End the terminal's leg; the server's agent continues the session. */
export async function handBackToServer(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/handback`, { method: 'POST' });
  if (!res.ok) throw await requestFailure('Handing the run back', res);
}
