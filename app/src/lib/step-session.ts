/**
 * The Claude Code sessions a pipeline run's agent steps ran in, read from the
 * run's `phase-session` events — what "Continue in terminal" reopens.
 */

import type { RunEvent } from '../llm/executor';

export type StepSession = { phaseName: string; sessionId: string; cwd: string };

/** Every agent step's session, in the order the steps started. A step that
 *  ran more than once (a retry, a loop pass, a map item) keeps its latest. */
export function stepSessions(events: readonly RunEvent[]): StepSession[] {
  const byPhase = new Map<string, StepSession>();
  for (const e of events) {
    if (e.type !== 'phase-session') continue;
    byPhase.delete(e.phaseName);
    byPhase.set(e.phaseName, { phaseName: e.phaseName, sessionId: e.sessionId, cwd: e.cwd });
  }
  return [...byPhase.values()];
}

/** The session to open: the named step's, or else the most recent one. */
export function pickStepSession(events: readonly RunEvent[], phaseName?: string): StepSession | null {
  const all = stepSessions(events);
  if (phaseName) return all.find(s => s.phaseName === phaseName) ?? null;
  return all.at(-1) ?? null;
}

/** The command that continues a step's conversation in a terminal. It
 *  forks the session — the run's record of what the step did stays as it
 *  was, and a step still running isn't written to from two places. Claude
 *  Code finds a session by the folder it ran in, and a finished run's
 *  worktree is usually removed, so the folder is recreated (empty) for the
 *  lookup. Quoted for a POSIX shell. */
export function stepResumeCommand(s: Pick<StepSession, 'sessionId' | 'cwd'>): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return `${s.cwd ? `mkdir -p ${q(s.cwd)} && cd ${q(s.cwd)} && ` : ''}claude --resume ${q(s.sessionId)} --fork-session`;
}
