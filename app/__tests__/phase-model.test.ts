/**
 * Which model a phase runs on: the phase's own `model` → its agent file's
 * `model:` (Claude-routed phases only) → the run's. A harness run switches its
 * session to a step's model for that step and back after it, and prices what
 * the session spends at the model it is on.
 */

import { runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { HarnessSession, HarnessToolSpec } from '../src/llm/harness';
import { agentFileModel, phaseModel, resolveModelName, withAgentFileModel } from '../src/llm/models';
import { costUsd } from '../src/llm/pricing';
import type { Node } from '../src/types';

const agents = [
  { name: 'deep', raw: '---\nname: deep\nmodel: opus\n---\nThink hard.' },
  { name: 'plain', raw: '---\nname: plain\n---\nDo it.' },
  { name: 'inherits', raw: '---\nname: inherits\nmodel: inherit\n---\nDo it.' },
];

async function run(orchestration: Node, streamFn: StreamFn, extra: Partial<Parameters<typeof runOrchestration>[0]> = {}) {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: '',
    model: 'claude-sonnet-4-6',
    streamFn,
    initialInput: 'go',
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: agents,
    orchestrationsOverride: [],
    harnessSupported: true,
    allowAgentTools: true,
    ...extra,
  })) {
    events.push(ev);
  }
  return events;
}

const ends = (events: RunEvent[]) =>
  Object.fromEntries(
    events.flatMap(e => (e.type === 'phase-end' ? [[e.phaseName, e.model] as const] : [])),
  );

describe('models', () => {
  it('reads, resolves and writes an agent file\'s model', () => {
    expect(agentFileModel(agents[0].raw)).toBe('opus');
    expect(agentFileModel('---\nmodel: "claude-opus-4-1"\n---\nx')).toBe('claude-opus-4-1');
    expect(agentFileModel('no frontmatter\nmodel: x')).toBeUndefined();
    expect(resolveModelName('opus')).toBe('claude-opus-5-5');
    expect(resolveModelName('inherit')).toBeUndefined();
    expect(resolveModelName(' claude-haiku-4-5 ')).toBe('claude-haiku-4-5');

    const set = withAgentFileModel(agents[1].raw, 'claude-haiku-4-5');
    expect(set).toBe('---\nname: plain\nmodel: claude-haiku-4-5\n---\nDo it.');
    expect(withAgentFileModel(set, 'opus')).toBe('---\nname: plain\nmodel: opus\n---\nDo it.');
    expect(withAgentFileModel(set, null)).toBe(agents[1].raw);
    expect(withAgentFileModel('Just a body.', 'opus')).toBe('---\nmodel: opus\n---\n\nJust a body.');
  });

  it('phase > agent file > run; an agent file only steers a Claude-routed phase', () => {
    const base = { agentRaw: agents[0].raw, runModel: 'claude-sonnet-4-6' };
    expect(phaseModel({ ...base, phaseModel: 'claude-haiku-4-5' })).toEqual({ model: 'claude-haiku-4-5', source: 'phase' });
    expect(phaseModel(base)).toEqual({ model: 'claude-opus-5-5', source: 'agent' });
    expect(phaseModel({ ...base, claude: false })).toEqual({ model: 'claude-sonnet-4-6', source: 'run' });
    expect(phaseModel({ ...base, agentRaw: agents[2].raw })).toEqual({ model: 'claude-sonnet-4-6', source: 'run' });
  });
});

describe('a pipeline phase\'s model', () => {
  it('runs each phase on its own model, its agent file\'s, or the run\'s', async () => {
    const asked: Record<string, string> = {};
    const streamFn: StreamFn = params => {
      asked[params.system?.includes('Think hard') ? (params.messages[0].content.includes('pinned') ? 'pinned' : 'deep') : 'plain'] =
        params.model;
      return (async function* () {
        yield { type: 'text-delta' as const, text: 'ok' };
        yield { type: 'done' as const, usage: { inputTokens: 1, outputTokens: 1 } };
      })();
    };
    const events = await run(
      {
        name: 'o',
        phases: [
          { name: 'deep', agent: 'agents/deep.md' },
          { name: 'pinned', agent: 'agents/deep.md', model: 'claude-haiku-4-5', prompt: 'pinned' },
          { name: 'plain', agent: 'agents/plain.md' },
        ],
      },
      streamFn,
    );
    expect(asked).toEqual({ deep: 'claude-opus-5-5', pinned: 'claude-haiku-4-5', plain: 'claude-sonnet-4-6' });
    expect(ends(events)).toEqual({ deep: 'claude-opus-5-5', pinned: 'claude-haiku-4-5', plain: 'claude-sonnet-4-6' });
  });

  it('a phase on another provider keeps the run\'s model despite its agent file', async () => {
    let asked = '';
    const openai: StreamFn = params => {
      asked = params.model;
      return (async function* () {
        yield { type: 'text-delta' as const, text: 'ok' };
        yield { type: 'done' as const, usage: { inputTokens: 1, outputTokens: 1 } };
      })();
    };
    await run({ name: 'o', phases: [{ name: 'p', agent: 'agents/deep.md', provider: 'openai' }] }, openai, {
      providerStreamFns: { openai },
    });
    expect(asked).toBe('claude-sonnet-4-6');
  });
});

describe('a harness step\'s model', () => {
  it('switches the session for the step and back after it; spend is priced at the model in use', async () => {
    const switches: string[] = [];
    let brief = '';
    const streamFn: StreamFn = params => {
      const session: HarnessSession = {
        setModel: async m => {
          switches.push(m);
        },
      };
      params.harness?.onSession?.(session);
      const t = Object.fromEntries(
        (params.harness?.tools ?? []).map((x: HarnessToolSpec) => [x.name, (a: Record<string, string>) => x.handler(a)]),
      );
      return (async function* () {
        await t.start_step({ step: 'plan' });
        await t.complete_step({ step: 'plan', output: 'p' });
        brief = (await t.start_step({ step: 'think' })).text;
        expect(switches).toEqual(['claude-opus-5-5']);
        yield { type: 'usage' as const, usage: { inputTokens: 1000, outputTokens: 0 } };
        await t.complete_step({ step: 'think', output: 't' });
        yield { type: 'done' as const, usage: { inputTokens: 1000, outputTokens: 0 } };
      })();
    };
    const events = await run(
      {
        name: 'o',
        execution: 'harness',
        phases: [
          { name: 'plan', agent: 'agents/plain.md' },
          { name: 'think', agent: 'agents/deep.md' },
        ],
      },
      streamFn,
    );
    expect(switches).toEqual(['claude-opus-5-5', 'claude-sonnet-4-6']);
    expect(brief).toContain('### Model\nThis step runs on claude-opus-5-5');
    const start = events.find(e => e.type === 'harness-start');
    expect(start?.type === 'harness-start' && start.steps.map(s => s.model ?? null)).toEqual([null, 'claude-opus-5-5']);
    expect(ends(events)).toMatchObject({ plan: 'claude-sonnet-4-6', think: 'claude-opus-5-5' });
    const think = events.find(e => e.type === 'phase-end' && e.phaseName === 'think');
    expect(think?.type === 'phase-end' && think.costUsd).toBeCloseTo(costUsd('claude-opus-5-5', 1000, 0), 10);
  });
});
