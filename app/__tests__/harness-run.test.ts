/**
 * Harness mode, end to end through runOrchestration with a scripted agent:
 * the stream adapter hands the agent the step tools, and each "leg" of the
 * fake agent calls them the way the real one would (an SDK in-process tool
 * call is a direct call of the handler).
 *
 * What it pins: the order rules, engine steps run by run_step, checkpoints
 * (`harness/<key>` + the session), gates ending a leg and resuming the SAME
 * session, a server-style pause + resume from the checkpoints, the per-step
 * tool gate, advisory skips as degradation, and the preflights.
 */

import { RunPauseRequested, runOrchestration, type RunEvent, type StreamFn } from '../src/llm/executor';
import type { HarnessToolSpec } from '../src/llm/harness';
import { computeDegradation } from '../src/server/degradation';
import type { Node } from '../src/types';

type Tools = Record<string, (args: Record<string, string>) => Promise<{ text: string; isError?: boolean }>>;
type Params = Parameters<StreamFn>[0];
type Leg = (tools: Tools, params: Params) => AsyncGenerator<{ type: 'text-delta'; text: string }, void, unknown>;

/** A stream adapter whose agent is a list of scripted legs. */
function scriptedAgent(legs: Leg[]) {
  const calls: Params[] = [];
  const streamFn: StreamFn = params => {
    calls.push(params);
    const leg = legs[calls.length - 1];
    if (!leg) throw new Error(`no scripted leg ${calls.length}`);
    const tools: Tools = Object.fromEntries(
      (params.harness?.tools ?? []).map((t: HarnessToolSpec) => [t.name, (a: Record<string, string>) => t.handler(a)]),
    );
    return (async function* () {
      yield* leg(tools, params);
      yield { type: 'done' as const, usage: { inputTokens: 10, outputTokens: 5 } };
    })();
  };
  return { streamFn, calls };
}

const agents = [
  { name: 'planner', raw: '---\nname: planner\n---\nYou plan the work for ${input}.' },
  { name: 'builder', raw: '---\nname: builder\n---\nBuild what the plan says.' },
];

async function run(
  orchestration: Node,
  streamFn: StreamFn,
  extra: Partial<Parameters<typeof runOrchestration>[0]> = {},
): Promise<{ events: RunEvent[]; thrown: unknown }> {
  const events: RunEvent[] = [];
  let thrown: unknown = null;
  try {
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: '',
      model: 'claude-sonnet-4-6',
      streamFn,
      initialInput: 'TICKET-1',
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
  } catch (e) {
    thrown = e;
  }
  return { events, thrown };
}

const of = <T extends RunEvent['type']>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

const tree: Node = {
  name: 'ship-it',
  execution: 'harness',
  phases: [
    { name: 'plan', agent: 'agents/planner.md', as: 'plan' },
    { name: 'shout', code: { source: 'return String(state.plan).toUpperCase()' } },
    { name: 'build', agent: 'agents/builder.md', prompt: 'Build: ${plan}', tools: ['Bash'] },
  ],
};

describe('harness run', () => {
  it('follows the steps in strict order; engine steps run through run_step; the run ends done', async () => {
    const seen: Record<string, string> = {};
    const { streamFn, calls } = scriptedAgent([
      async function* (t) {
        // Out of order is refused.
        const early = await t.start_step({ step: 'build' });
        seen.early = early.text;
        seen.planBrief = (await t.start_step({ step: 'plan' })).text;
        yield { type: 'text-delta', text: 'planning' };
        await t.complete_step({ step: 'plan', output: 'two files' });
        await t.start_step({ step: 'shout' });
        seen.shout = (await t.run_step({ step: 'shout' })).text;
        seen.buildBrief = (await t.start_step({ step: 'build' })).text;
        await t.complete_step({ step: 'build', output: 'built' });
        yield { type: 'text-delta', text: 'all done' };
      },
    ]);
    const { events, thrown } = await run(tree, streamFn);
    expect(thrown).toBeNull();
    expect(seen.early).toMatch(/Strict order: "build" can't start yet/);
    expect(seen.planBrief).toContain('You plan the work for TICKET-1.');
    expect(seen.shout).toContain('TWO FILES');
    // The prompt is interpolated against the state the earlier steps left.
    expect(seen.buildBrief).toContain('Build: two files');
    expect(seen.buildBrief).toContain('### Tools for this step\nBash');

    const done = of(events, 'harness-step').filter(e => e.status === 'done');
    expect(done.map(e => e.replayKey)).toEqual([
      'harness/__session',
      'harness/plan',
      'harness/shout',
      'harness/build',
    ]);
    expect(of(events, 'run-end')).toHaveLength(1);
    expect(of(events, 'harness-start')[0]).toMatchObject({ follow: 'strict', followSource: 'default', leg: 1 });
    // One session, started with a fresh id; the agent's spend is charged once.
    expect(calls).toHaveLength(1);
    expect(calls[0].harness?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(of(events, 'phase-end').find(e => e.phaseName === 'harness')).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(computeDegradation(events as never).degraded).toBe(false);
  });

  it('the tool gate allows only the active step\'s tools', async () => {
    const verdicts: Array<string | null> = [];
    const { streamFn } = scriptedAgent([
      async function* (t, p) {
        const gate = p.harness!.toolGate!;
        verdicts.push(gate('Bash', { command: 'ls' })); // no step active
        verdicts.push(gate('Read', {})); // reading always works
        await t.start_step({ step: 'plan' });
        verdicts.push(gate('Bash', { command: 'ls' })); // plan declares no tools
        await t.complete_step({ step: 'plan', output: 'p' });
        await t.start_step({ step: 'shout' });
        verdicts.push(gate('Edit', {})); // engine step: run_step only
        await t.run_step({ step: 'shout' });
        await t.start_step({ step: 'build' });
        verdicts.push(gate('Bash', { command: 'ls' })); // build declares Bash
        verdicts.push(gate('mcp__sammy__complete_step', {}));
        await t.complete_step({ step: 'build', output: 'b' });
      },
    ]);
    await run(tree, streamFn);
    expect(verdicts[0]).toMatch(/No step is in progress/);
    expect(verdicts[1]).toBeNull();
    expect(verdicts[2]).toMatch(/doesn't allow Bash/);
    expect(verdicts[3]).toMatch(/engine step: call run_step/);
    expect(verdicts[4]).toBeNull();
    expect(verdicts[5]).toBeNull();
  });

  it('a gate ends the leg; once approved the next leg resumes the same session', async () => {
    const gated: Node = { ...tree, phases: [tree.phases![0], { ...tree.phases![1], lock: true }, tree.phases![2]] };
    const asked: string[] = [];
    let stopText = '';
    const { streamFn, calls } = scriptedAgent([
      async function* (t) {
        await t.start_step({ step: 'plan' });
        await t.complete_step({ step: 'plan', output: 'p' });
        stopText = (await t.start_step({ step: 'shout' })).text;
      },
      async function* (t) {
        await t.start_step({ step: 'shout' });
        await t.run_step({ step: 'shout' });
        await t.start_step({ step: 'build' });
        await t.complete_step({ step: 'build', output: 'b' });
      },
    ]);
    const { events, thrown } = await run(gated, streamFn, {
      waitForApproval: async name => {
        asked.push(name);
        return true;
      },
    });
    expect(thrown).toBeNull();
    expect(stopText).toMatch(/needs a person's approval/);
    expect(asked).toEqual(['shout']);
    expect(of(events, 'lock-gate').map(e => e.phaseName)).toEqual(['shout']);
    expect(calls).toHaveLength(2);
    expect(calls[1].harness?.resume).toBe(calls[0].harness?.sessionId);
    expect(calls[1].messages[0].content).toMatch(/"shout" was approved/);
    expect(of(events, 'run-end')).toHaveLength(1);
  });

  it('a server-style pause, then a resume from the checkpoints, continues where it stopped', async () => {
    const gated: Node = { ...tree, phases: [tree.phases![0], { ...tree.phases![1], lock: true }, tree.phases![2]] };
    const first = scriptedAgent([
      async function* (t) {
        await t.start_step({ step: 'plan' });
        await t.complete_step({ step: 'plan', output: 'two files' });
        await t.start_step({ step: 'shout' });
      },
    ]);
    const leg1 = await run(gated, first.streamFn, {
      waitForApproval: async name => {
        throw new RunPauseRequested(name);
      },
    });
    expect(leg1.thrown).toBeInstanceOf(RunPauseRequested);

    // What the run-controller would hand the resumed leg: every checkpoint.
    const replayOutputs = Object.fromEntries(
      of(leg1.events, 'harness-step')
        .filter(e => e.replayKey && e.record)
        .map(e => [e.replayKey!, e.record!]),
    );
    let resumedBrief = '';
    const second = scriptedAgent([
      async function* (t) {
        // plan is already done: strict order won't redo it.
        expect((await t.start_step({ step: 'plan' })).text).toMatch(/already done/);
        await t.start_step({ step: 'shout' });
        await t.run_step({ step: 'shout' });
        resumedBrief = (await t.start_step({ step: 'build' })).text;
        await t.complete_step({ step: 'build', output: 'b' });
      },
    ]);
    const leg2 = await run(gated, second.streamFn, { replayOutputs, autoApproveLocks: ['shout'] });
    expect(leg2.thrown).toBeNull();
    expect(second.calls[0].harness?.resume).toBe(first.calls[0].harness?.sessionId);
    expect(second.calls[0].messages[0].content).toMatch(/"shout" was approved/);
    // State the first leg built (`as: plan`) is back.
    expect(resumedBrief).toContain('Build: two files');
    expect(of(leg2.events, 'run-end')).toHaveLength(1);
  });

  it('advisory lets the agent skip a step, and the run is degraded naming it; strict refuses', async () => {
    const script = (results: string[]): Leg =>
      async function* (t) {
        await t.start_step({ step: 'plan' });
        await t.complete_step({ step: 'plan', output: 'p' });
        results.push((await t.skip_step({ step: 'shout', reason: 'nothing to shout' })).text);
        await t.start_step({ step: 'build' });
        await t.complete_step({ step: 'build', output: 'b' });
      };
    const advisoryOut: string[] = [];
    const advisory = await run({ ...tree, harness: { follow: 'advisory' } }, scriptedAgent([script(advisoryOut)]).streamFn);
    expect(advisory.thrown).toBeNull();
    expect(advisoryOut[0]).toMatch(/Skipped "shout"/);
    const verdict = computeDegradation(advisory.events as never);
    expect(verdict.reasons).toEqual([{ phase: 'shout', reason: 'skipped by the harness: nothing to shout' }]);

    const strictOut: string[] = [];
    const strict = await run(tree, scriptedAgent([script(strictOut), async function* () {}, async function* () {}]).streamFn);
    expect(strictOut[0]).toMatch(/Skipping isn't allowed: this run follows strict order/);
    // build couldn't start either (shout isn't done) — the run fails naming them.
    expect(of(strict.events, 'run-error')[0]?.error).toMatch(/stopped with steps not done: "shout", "build"/);
  });

  it('an agent that stops early is told to continue, then the run fails naming the steps', async () => {
    const { streamFn, calls } = scriptedAgent([async function* () {}, async function* () {}, async function* () {}]);
    const { events } = await run(tree, streamFn);
    expect(calls).toHaveLength(3);
    expect(calls[1].messages[0].content).toMatch(/the run isn't finished/);
    expect(of(events, 'harness-notice').length).toBeGreaterThanOrEqual(2);
    expect(of(events, 'run-error')[0].error).toMatch(/stopped with steps not done: "plan", "shout", "build"/);
  });

  it('a falsy `when` skips the step without the agent; an output contract is checked', async () => {
    const o: Node = {
      name: 'o',
      execution: 'harness',
      phases: [
        { name: 'maybe', agent: 'agents/builder.md', when: '${flag}' },
        {
          name: 'shape',
          agent: 'agents/builder.md',
          output: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        },
      ],
      vars: { flag: '' },
    };
    const out: string[] = [];
    const { streamFn } = scriptedAgent([
      async function* (t) {
        out.push((await t.start_step({ step: 'maybe' })).text);
        await t.start_step({ step: 'shape' });
        out.push((await t.complete_step({ step: 'shape', output: 'not json' })).text);
        out.push((await t.complete_step({ step: 'shape', output: '{"ok":true}' })).text);
      },
    ]);
    const { events, thrown } = await run(o, streamFn);
    expect(thrown).toBeNull();
    expect(out[0]).toMatch(/The engine skipped "maybe": its condition "\$\{flag\}" is false/);
    expect(out[1]).toMatch(/Fix it and call complete_step again/);
    expect(out[2]).toMatch(/Recorded "shape" as done/);
    expect(of(events, 'run-end')).toHaveLength(1);
    expect(computeDegradation(events as never).degraded).toBe(false);
  });

  it('refuses to start without a harness-capable adapter, or with a skill that is not installed', async () => {
    const noAdapter = await run(tree, scriptedAgent([]).streamFn, { harnessSupported: false });
    expect(of(noAdapter.events, 'run-error')[0].error).toMatch(/needs a server-owned run/);
    const skilled: Node = { ...tree, phases: [{ name: 'triage', skill: 'triage-ticket' }] };
    const missing = await run(skilled, scriptedAgent([]).streamFn, { skillExists: () => false });
    expect(of(missing.events, 'run-error')[0].error).toMatch(
      /step "triage" names the skill "triage-ticket", which isn't installed/,
    );
  });

  it('a pipeline run refuses steps that only name a skill', async () => {
    const skillOnly: Node = { name: 'o', phases: [{ name: 'triage', skill: 'triage-ticket' }] };
    const { events } = await run(skillOnly, scriptedAgent([]).streamFn);
    expect(of(events, 'run-error')[0].error).toMatch(/"triage" only name a skill, which only a harness can run/);
  });

  it('a skill step tells the agent which skill to run, and the session may run only those skills', async () => {
    const skilled: Node = { name: 'o', execution: 'harness', phases: [{ name: 'triage', skill: 'triage-ticket' }] };
    let brief = '';
    const verdicts: Array<string | null> = [];
    const { streamFn, calls } = scriptedAgent([
      async function* (t, p) {
        brief = (await t.start_step({ step: 'triage' })).text;
        verdicts.push(p.harness!.toolGate!('Skill', { skill: 'other' }));
        verdicts.push(p.harness!.toolGate!('Skill', { skill: 'triage-ticket' }));
        await t.complete_step({ step: 'triage', output: 'P2' });
      },
    ]);
    const { thrown } = await run(skilled, streamFn, { skillExists: () => true });
    expect(thrown).toBeNull();
    expect(brief).toContain('Run the skill "triage-ticket" with the Skill tool');
    expect(calls[0].harness?.skills).toEqual(['triage-ticket']);
    expect(verdicts).toEqual([expect.stringMatching(/runs the skill "triage-ticket", not "other"/), null]);
  });
});
