import type { RunEvent } from '../llm/executor';

/** Phase kinds that run no model (the executor's phase-start `agentPath` for them). Their output is a
 *  program's, so the trace keeps its lines instead of reading it as Markdown, and there is no agent to
 *  chat with or tokens to report. */
const PROGRAM_PATHS = new Set(['code', 'http', 'wait']);

export function isProgramPhase(agentPath: string | null | undefined): boolean {
  return agentPath != null && PROGRAM_PATHS.has(agentPath);
}

/** The agentPath the most recent phase-start of `phaseName` carried, or null if it hasn't started. */
export function phaseAgentPath(events: readonly RunEvent[], phaseName: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'phase-start' && e.phaseName === phaseName) {
      return typeof e.agentPath === 'string' ? e.agentPath : null;
    }
  }
  return null;
}
