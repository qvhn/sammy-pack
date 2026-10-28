/**
 * The run trace treats phases that run no model (code / http / wait) as programs: their output keeps its line
 * breaks instead of being read as Markdown (a streamed one-line-per-item log collapsed into one paragraph), and
 * no "Chat with <phase>" box is offered while one runs (there is no agent to receive it).
 */
import type { RunEvent } from '../src/llm/executor';
import { isProgramPhase, phaseAgentPath } from '../src/pages/phaseKind';

describe('isProgramPhase', () => {
  it('is true for the executor kinds that run no model', () => {
    for (const k of ['code', 'http', 'wait']) expect(isProgramPhase(k)).toBe(true);
  });
  it('is false for an agent path and for an unknown / missing path', () => {
    expect(isProgramPhase('agents/reviewer.md')).toBe(false);
    expect(isProgramPhase(undefined)).toBe(false);
    expect(isProgramPhase(null)).toBe(false);
  });
});

describe('phaseAgentPath', () => {
  const ev = (e: Record<string, unknown>) => ({ ts: 0, ...e }) as unknown as RunEvent;
  const events = [
    ev({ type: 'phase-start', phaseName: 'build', agentPath: 'code' }),
    ev({ type: 'phase-end', phaseName: 'build', output: 'ok' }),
    ev({ type: 'phase-start', phaseName: 'review', agentPath: 'agents/reviewer.md' }),
  ];
  it('returns the agentPath of the phase-start for that name', () => {
    expect(phaseAgentPath(events, 'build')).toBe('code');
    expect(phaseAgentPath(events, 'review')).toBe('agents/reviewer.md');
  });
  it('returns null for a phase that has not started', () => {
    expect(phaseAgentPath(events, 'publish')).toBeNull();
  });
});
