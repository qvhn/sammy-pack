/** A harness run's checklist, derived from its events — what the run page
 *  shows: the steps, each one's status, how strictly they are followed and
 *  where that came from, and the session a terminal can resume. Pure. */

import type { RunEvent } from '../llm/executor';
import type { FollowSource, HarnessStepKind } from '../llm/harness';
import type { HarnessFollow } from '../types';

export type HarnessStepView = {
  key: string;
  name: string;
  kind: HarnessStepKind;
  skill?: string;
  engineKind?: string;
  gate?: string;
  group?: string;
  section?: string;
  /** The loop the harness repeats this step in, and the pass it is on. */
  loop?: string;
  loopMax?: number;
  pass?: number;
  required: boolean;
  finally: boolean;
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed';
  /** Why a step was skipped or failed, and who decided. */
  reason?: string;
  by?: 'harness' | 'engine' | 'when';
};

export type HarnessView = {
  follow: HarnessFollow;
  followSource: FollowSource;
  followRefused?: HarnessFollow;
  sessionId: string;
  cwd?: string;
  model: string;
  legs: number;
  /** Who drives the latest leg. */
  driver: 'server' | 'terminal';
  steps: HarnessStepView[];
  notices: string[];
};

/** Null for a run that isn't a harness run. */
export function deriveHarnessView(events: readonly RunEvent[]): HarnessView | null {
  let first: Extract<RunEvent, { type: 'harness-start' }> | null = null;
  let latest: Extract<RunEvent, { type: 'harness-start' }> | null = null;
  for (const e of events) {
    if (e.type === 'harness-start') {
      if (!first) first = e;
      latest = e;
    }
  }
  if (!first || !latest) return null;
  const status = new Map<string, Pick<HarnessStepView, 'status' | 'reason' | 'by'>>();
  const passes = new Map<string, number>();
  const notices: string[] = [];
  const loopOf = new Map(latest.steps.flatMap(s => (s.loop ? [[s.key, s.loop] as const] : [])));
  for (const e of events) {
    if (e.type === 'loop-iteration' && [...loopOf.values()].includes(e.phaseName)) {
      // A repeated loop opened its next pass: its steps start over.
      passes.set(e.phaseName, e.iteration);
      for (const [key, loop] of loopOf) if (loop === e.phaseName) status.delete(key);
    } else if (e.type === 'harness-step' && e.key !== '__session') {
      status.set(e.key, {
        status: e.status === 'started' ? 'active' : e.status,
        ...(e.reason ? { reason: e.reason } : {}),
        by: e.by,
      });
    } else if (e.type === 'harness-notice') {
      notices.push(e.message);
    }
  }
  return {
    // The FIRST leg holds what the run asked for; a resumed leg reads the
    // value back from the snapshot, which no longer knows its source.
    follow: first.follow,
    followSource: first.followSource,
    ...(first.followRefused ? { followRefused: first.followRefused } : {}),
    sessionId: latest.sessionId,
    ...(latest.cwd ? { cwd: latest.cwd } : {}),
    model: latest.model,
    legs: latest.leg,
    driver: latest.driver ?? 'server',
    steps: latest.steps.map(s => ({
      ...s,
      ...(s.loop ? { pass: passes.get(s.loop) ?? s.pass ?? 1 } : {}),
      ...(status.get(s.key) ?? { status: 'pending' as const }),
    })),
    notices,
  };
}

/** The command that opens a finished harness run's agent session in a
 *  terminal. Claude Code finds a session by the folder it ran in, and a
 *  finished run's worktree is usually removed — so the folder is recreated
 *  (empty) for the lookup. Quoted for a POSIX shell. */
export function harnessResumeCommand(view: Pick<HarnessView, 'sessionId' | 'cwd'>): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${view.cwd ? `mkdir -p ${q(view.cwd)} && cd ${q(view.cwd)} && ` : ''}claude --resume ${view.sessionId}`;
}

export function followSourceLabel(source: FollowSource): string {
  return source === 'run'
    ? 'chosen for this run'
    : source === 'orchestration'
      ? 'set by the orchestration'
      : source === 'settings'
        ? 'workspace default'
        : 'default';
}
