/**
 * Harness mode, pure half: the tree → step list compile, how strictness is
 * resolved, and the follow rules HarnessProgress enforces.
 */

import {
  compileRoadmap,
  decodeStepRecord,
  encodeStepRecord,
  HarnessEventQueue,
  HarnessProgress,
  resolveFollow,
} from '../src/llm/harness';
import type { Node } from '../src/types';

const agent = (name: string, extra: Partial<Node> = {}): Node => ({ name, agent: `agents/${name}.md`, ...extra });

describe('compileRoadmap', () => {
  it('flattens phases sections in order, naming the section', () => {
    const steps = compileRoadmap({
      name: 'o',
      phases: [agent('a'), { name: 'build', phases: [agent('b'), agent('c')] }, agent('d')],
    });
    expect(steps.map(s => s.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(steps.map(s => s.rank)).toEqual([0, 1, 2, 3]);
    expect(steps[1].section).toBe('build');
    expect(steps.every(s => s.kind === 'task')).toBe(true);
  });

  it('a parallel of single steps shares one rank; a parallel with a sequence branch stays one engine step', () => {
    const flat = compileRoadmap({ name: 'o', phases: [agent('a'), { name: 'p', parallel: [agent('x'), agent('y')] }, agent('z')] });
    expect(flat.map(s => [s.key, s.rank, s.group ?? null])).toEqual([
      ['a', 0, null],
      ['x', 1, 'p'],
      ['y', 1, 'p'],
      ['z', 2, null],
    ]);
    const nested = compileRoadmap({
      name: 'o',
      phases: [{ name: 'p', parallel: [agent('x'), { name: 'seq', phases: [agent('y1'), agent('y2')] }] }],
    });
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ key: 'p', kind: 'engine', engineKind: 'parallel' });
  });

  it('engine steps: leaves the engine runs and composites the harness can\'t flatten', () => {
    const steps = compileRoadmap({
      name: 'o',
      phases: [
        { name: 'script', code: { source: 'return 1' } },
        { name: 'fetch', http: { url: 'https://example.test' } },
        { name: 'refine', loop: { body: agent('w'), maxIterations: 3, retryOnFailure: true } },
        { name: 'each', map: { over: '${items}', body: agent('w') } },
      ],
    });
    expect(steps.map(s => [s.key, s.kind, s.engineKind])).toEqual([
      ['script', 'engine', 'code'],
      ['fetch', 'engine', 'http'],
      ['refine', 'engine', 'loop'],
      ['each', 'engine', 'map'],
    ]);
  });

  it('a skill step, with or without an agent', () => {
    const steps = compileRoadmap({ name: 'o', phases: [{ name: 's', skill: 'triage' }, agent('t', { skill: 'plan' })] });
    expect(steps.map(s => [s.kind, s.skill])).toEqual([
      ['skill', 'triage'],
      ['skill', 'plan'],
    ]);
  });

  it('finalizers go last; a section lock gates all of its steps', () => {
    const steps = compileRoadmap({
      name: 'o',
      phases: [
        agent('report', { finally: true }),
        { name: 'ship', lock: true, phases: [agent('deploy'), agent('verify')] },
        agent('own', { lock: true }),
      ],
    });
    expect(steps.map(s => s.key)).toEqual(['deploy', 'verify', 'own', 'report']);
    // A section's lock guards every step in it, not only the first.
    expect(steps.map(s => s.gates)).toEqual([['ship'], ['ship'], ['own'], []]);
    expect(steps[3].finally).toBe(true);
  });

  it('repeated names get distinct keys; continueOnError makes a step optional', () => {
    const steps = compileRoadmap({ name: 'o', phases: [agent('review'), agent('review', { continueOnError: true })] });
    expect(steps.map(s => s.key)).toEqual(['review', 'review#2']);
    expect(steps.map(s => s.required)).toEqual([true, false]);
  });

  it('a loop with a plain body repeats as steps; a judge or retrying loop stays one engine step', () => {
    const body: Node = {
      name: 'pass',
      phases: [agent('implement'), { name: 'checks', parallel: [agent('review'), agent('qa')] }, agent('decide')],
    };
    const steps = compileRoadmap({
      name: 'o',
      phases: [
        agent('plan'),
        { name: 'build', loop: { body, maxIterations: 3, until: 'DECISION: SHIP' } },
        agent('open-pr', { lock: true }),
        { name: 'judged', loop: { body: agent('w'), maxIterations: 2, judge: 'agents/judge.md' } },
      ],
    });
    expect(steps.map(s => [s.key, s.rank, s.loop?.name ?? null, s.group ?? null])).toEqual([
      ['plan', 0, null, null],
      ['implement', 1, 'build', null],
      ['review', 2, 'build', 'checks'],
      ['qa', 2, 'build', 'checks'],
      ['decide', 3, 'build', null],
      ['open-pr', 4, null, null],
      ['judged', 5, null, null],
    ]);
    expect(steps[1].loop).toMatchObject({ max: 3, until: 'DECISION: SHIP', carryContext: true });
    expect(steps[6]).toMatchObject({ kind: 'engine', engineKind: 'loop' });
  });

  it('a root that is itself a body is one step', () => {
    expect(compileRoadmap({ name: 'solo', agent: 'agents/solo.md' }).map(s => s.key)).toEqual(['solo']);
  });
});

describe('resolveFollow', () => {
  it('run > orchestration > settings > strict', () => {
    expect(resolveFollow({})).toEqual({ follow: 'strict', source: 'default' });
    expect(resolveFollow({ workspaceDefault: 'loose' })).toEqual({ follow: 'loose', source: 'settings' });
    expect(resolveFollow({ declared: 'advisory', workspaceDefault: 'loose' })).toEqual({ follow: 'advisory', source: 'orchestration' });
    expect(resolveFollow({ requested: 'loose', declared: 'advisory' })).toEqual({ follow: 'loose', source: 'run' });
  });

  it('a locked orchestration only lets a run tighten it, and records what was refused', () => {
    expect(resolveFollow({ requested: 'advisory', declared: 'loose', locked: true })).toEqual({
      follow: 'loose',
      source: 'orchestration',
      refused: 'advisory',
    });
    expect(resolveFollow({ requested: 'strict', declared: 'loose', locked: true })).toEqual({ follow: 'strict', source: 'run' });
    // Locked with no declared value locks the default, strict.
    expect(resolveFollow({ requested: 'loose', locked: true })).toMatchObject({ follow: 'strict', refused: 'loose' });
  });
});

describe('HarnessProgress', () => {
  const tree: Node = {
    name: 'o',
    phases: [agent('a'), { name: 'p', parallel: [agent('x'), agent('y')] }, agent('z'), agent('fin', { finally: true })],
  };

  it('strict: one rank at a time, a parallel group in any order, the finalizer last', () => {
    const p = new HarnessProgress(compileRoadmap(tree), 'strict');
    const step = (k: string) => p.get(k)!;
    expect(p.available().map(s => s.key)).toEqual(['a']);
    expect(p.canStart(step('z'))).toMatchObject({ ok: false });
    p.start(step('a'));
    expect(p.canStart(step('x'))).toMatchObject({ ok: false, reason: expect.stringContaining('still in progress') });
    p.finish(step('a'), { status: 'done', output: 'A' });
    expect(p.available().map(s => s.key)).toEqual(['x', 'y']);
    p.start(step('y'));
    p.finish(step('y'), { status: 'done' });
    expect(p.available().map(s => s.key)).toEqual(['x']);
    p.start(step('x'));
    p.finish(step('x'), { status: 'done' });
    expect(p.canStart(step('fin'))).toMatchObject({ ok: false, reason: expect.stringContaining('finalizer') });
    expect(p.canStart(step('a'))).toMatchObject({ ok: false, reason: expect.stringContaining('already done') });
    p.start(step('z'));
    p.finish(step('z'), { status: 'done' });
    expect(p.available().map(s => s.key)).toEqual(['fin']);
    p.start(step('fin'));
    p.finish(step('fin'), { status: 'done' });
    expect(p.unfinished()).toEqual([]);
  });

  it('loose: any regular step, a finished one can be redone, the finalizer still waits', () => {
    const p = new HarnessProgress(compileRoadmap(tree), 'loose');
    expect(p.available().map(s => s.key)).toEqual(['a', 'x', 'y', 'z']);
    p.start(p.get('z')!);
    p.finish(p.get('z')!, { status: 'done' });
    expect(p.canStart(p.get('z')!)).toEqual({ ok: true });
    expect(p.canStart(p.get('fin')!)).toMatchObject({ ok: false });
  });

  it('a failed required step stays unfinished; a failed optional one settles', () => {
    const steps = compileRoadmap({ name: 'o', phases: [agent('must'), agent('may', { continueOnError: true })] });
    const p = new HarnessProgress(steps, 'loose');
    p.start(p.get('must')!);
    p.finish(p.get('must')!, { status: 'failed', reason: 'x' });
    p.start(p.get('may')!);
    p.finish(p.get('may')!, { status: 'failed', reason: 'y' });
    expect(p.unfinished().map(s => s.key)).toEqual(['must']);
    expect(p.canStart(p.get('must')!)).toEqual({ ok: true });
  });

  it('restores finished steps from checkpoint records', () => {
    const steps = compileRoadmap(tree);
    const p = new HarnessProgress(steps, 'strict', new Map([['a', { status: 'done', output: 'A' }]]));
    expect(p.statusOf('a')).toBe('done');
    expect(p.available().map(s => s.key)).toEqual(['x', 'y']);
    expect(p.checklist()).toContain('[x] 1. a');
  });
});

describe('HarnessProgress passes', () => {
  it('a finished pass can open the next; each pass checkpoints under its own key', () => {
    const steps = compileRoadmap({
      name: 'o',
      phases: [{ name: 'build', loop: { body: { name: 'b', phases: [agent('impl'), agent('decide')] }, maxIterations: 3 } }, agent('ship')],
    });
    const p = new HarnessProgress(steps, 'strict');
    const step = (k: string) => p.get(k)!;
    expect(p.checkpointKey(step('impl'))).toBe('harness/build@1/impl');
    expect(p.checkpointKey(step('ship'))).toBe('harness/ship');
    p.start(step('impl'));
    p.finish(step('impl'), { status: 'done' });
    expect(p.passComplete('build')).toBe(false);
    p.start(step('decide'));
    p.finish(step('decide'), { status: 'done' });
    expect(p.passComplete('build')).toBe(true);
    expect(p.nextPass('build')).toBe(2);
    expect(p.available().map(s => s.key)).toEqual(['impl']);
    expect(p.checkpointKey(step('impl'))).toBe('harness/build@2/impl');
    expect(p.checklist()).toContain('pass 2 of at most 3');
  });
});

describe('checkpoint records', () => {
  it('round-trip, and anything else decodes to null', () => {
    const r = { status: 'skipped' as const, reason: 'not needed', by: 'harness' as const };
    expect(decodeStepRecord(encodeStepRecord(r))).toEqual(r);
    expect(decodeStepRecord('plain output')).toBeNull();
    expect(decodeStepRecord('{"status":"weird"}')).toBeNull();
  });
});

describe('HarnessEventQueue', () => {
  it('an item a reader took but never passed on stays for the next reader', async () => {
    const q = new HarnessEventQueue<number>();
    q.push(1);
    q.push(2);
    const first = q.drain()[Symbol.asyncIterator]();
    expect((await first.next()).value).toBe(1);
    expect((await first.next()).value).toBe(2); // read ahead, then abandoned
    q.close();
    const rest: number[] = [];
    for await (const n of q.drain()) rest.push(n);
    expect(rest).toEqual([2]);
  });

  it('delivers what was pushed before and after a reader waits, then ends on close', async () => {
    const q = new HarnessEventQueue<number>();
    q.push(1);
    const got: number[] = [];
    const reader = (async () => {
      for await (const n of q.drain()) got.push(n);
    })();
    await new Promise(r => setTimeout(r, 5));
    q.push(2);
    q.push(3);
    q.close();
    await reader;
    expect(got).toEqual([1, 2, 3]);
  });
});
