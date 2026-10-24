import {
  collectAllPhases,
  serializeGraph,
  type GraphEdgeInput,
  type GraphNodeInput,
} from '../src/graph-serialize';
import type { Node } from '../src/types';

// --- builders -------------------------------------------------------------

const node = (id: string, parentComposite?: string): GraphNodeInput => ({
  id,
  type: 'phase',
  data: parentComposite ? { parentComposite } : {},
});

const edge = (
  source: string,
  target: string,
  type: 'handoff' | 'parallel' | 'converge' | 'loop-back' = 'handoff',
  composite?: { name: string; lock?: boolean; merger?: string; description?: string },
): GraphEdgeInput => ({
  source,
  target,
  data: { type, ...(composite ? { composite } : {}) },
});

/** Orchestration whose `phases` array contains a Node for every name, so the
 *  serializer's phaseMap (built via collectAllPhases) resolves each graph id. */
const orch = (phases: Node[]): Node => ({ name: 'orch', phases });
const phase = (name: string): Node => ({ name, prompt: `do ${name}` });

const names = (phases: Node[]) => phases.map(p => p.name);

// --- happy paths ----------------------------------------------------------

test('empty graph serializes to an empty phase list', () => {
  const r = serializeGraph([], [], orch([]));
  expect(r).toEqual({ kind: 'ok', phases: [] });
});

test('single node serializes to one phase', () => {
  const r = serializeGraph([node('A')], [], orch([phase('A')]));
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') expect(names(r.phases)).toEqual(['A']);
});

test('linear handoff chain preserves order', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C')],
    [edge('A', 'B'), edge('B', 'C')],
    orch([phase('A'), phase('B'), phase('C')]),
  );
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') expect(names(r.phases)).toEqual(['A', 'B', 'C']);
});

test('a decorative loop-back edge is ignored (does not create a cycle)', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C')],
    [edge('A', 'B'), edge('B', 'C'), edge('C', 'A', 'loop-back')],
    orch([phase('A'), phase('B'), phase('C')]),
  );
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') expect(names(r.phases)).toEqual(['A', 'B', 'C']);
});

test('a parallel fork that rejoins becomes a composite', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C'), node('D')],
    [edge('A', 'B', 'parallel'), edge('A', 'C', 'parallel'), edge('B', 'D'), edge('C', 'D')],
    orch([phase('A'), phase('B'), phase('C'), phase('D')]),
  );
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') {
    expect(r.phases).toHaveLength(3); // A, <parallel composite>, D
    expect(r.phases[0].name).toBe('A');
    expect(r.phases[2].name).toBe('D');
    const composite = r.phases[1];
    expect(names(composite.parallel ?? [])).toEqual(['B', 'C']);
  }
});

test('converge fork preserves composite metadata (name / lock / merger)', () => {
  const meta = { name: 'mygroup', lock: true, merger: 'pickBest' };
  const r = serializeGraph(
    [node('A'), node('B'), node('C'), node('D')],
    [
      edge('A', 'B', 'converge', meta),
      edge('A', 'C', 'converge', meta),
      edge('B', 'D'),
      edge('C', 'D'),
    ],
    orch([phase('A'), phase('B'), phase('C'), phase('D')]),
  );
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') {
    const composite = r.phases[1];
    expect(composite.name).toBe('mygroup');
    expect(composite.lock).toBe(true);
    expect(composite.merger).toBe('pickBest');
    expect(names(composite.converge ?? [])).toEqual(['B', 'C']);
  }
});

test('consecutive children of a flattened phases composite are folded back', () => {
  const composite: Node = { name: 'P', phases: [phase('X'), phase('Y')] };
  const r = serializeGraph(
    [node('A'), node('X', 'P'), node('Y', 'P'), node('Z')],
    [edge('A', 'X'), edge('X', 'Y'), edge('Y', 'Z')],
    orch([phase('A'), composite, phase('Z')]),
  );
  expect(r.kind).toBe('ok');
  if (r.kind === 'ok') {
    expect(names(r.phases)).toEqual(['A', 'P', 'Z']);
    expect(names(r.phases[1].phases ?? [])).toEqual(['X', 'Y']);
  }
});

// --- error paths ----------------------------------------------------------

test('a two-node cycle (no root) is rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B')],
    [edge('A', 'B'), edge('B', 'A')],
    orch([phase('A'), phase('B')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/cycle \(no root/i);
});

test('two entry points (multiple roots) is rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C')],
    [edge('A', 'C'), edge('B', 'C')],
    orch([phase('A'), phase('B'), phase('C')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/2 root nodes/i);
});

test('a node disconnected from the chain is rejected', () => {
  // A→B is the live chain (root A); C→D is a detached cycle (both have
  // incoming, so neither is a root) — unreachable from A.
  const r = serializeGraph(
    [node('A'), node('B'), node('C'), node('D')],
    [edge('A', 'B'), edge('C', 'D'), edge('D', 'C')],
    orch([phase('A'), phase('B'), phase('C'), phase('D')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/disconnected from the chain/i);
});

test('a lone non-handoff outgoing edge is rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B')],
    [edge('A', 'B', 'parallel')],
    orch([phase('A'), phase('B')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/should be "handoff"/i);
});

test('mixed fork edge types are rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C'), node('D')],
    [edge('A', 'B', 'parallel'), edge('A', 'C', 'converge'), edge('B', 'D'), edge('C', 'D')],
    orch([phase('A'), phase('B'), phase('C'), phase('D')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/mixed types/i);
});

test('multiple handoff forks (no fork type) are rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C'), node('D')],
    [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
    orch([phase('A'), phase('B'), phase('C'), phase('D')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/outgoing "handoff" edges/i);
});

test('fork branches that never rejoin are rejected', () => {
  const r = serializeGraph(
    [node('A'), node('B'), node('C')],
    [edge('A', 'B', 'parallel'), edge('A', 'C', 'parallel')],
    orch([phase('A'), phase('B'), phase('C')]),
  );
  expect(r.kind).toBe('error');
  if (r.kind === 'error') expect(r.reason).toMatch(/don't rejoin/i);
});

// --- collectAllPhases -----------------------------------------------------

test('collectAllPhases recurses through composites, loop, map, and route', () => {
  const tree: Node = {
    name: 'root',
    phases: [
      { name: 'p1' },
      { name: 'par', parallel: [{ name: 'a' }, { name: 'b' }] },
      { name: 'looper', loop: { body: { name: 'body' }, maxIterations: 2 } },
      { name: 'mapper', map: { over: 'xs', body: { name: 'mapbody' } } },
      {
        name: 'router',
        route: {
          router: 'pick',
          branches: { yes: { name: 'br-yes' } },
          default: { name: 'br-def' },
        },
      },
    ],
  };
  const m = new Map<string, Node>();
  collectAllPhases(tree, m);
  expect([...m.keys()].sort()).toEqual(
    [
      'a',
      'b',
      'body',
      'br-def',
      'br-yes',
      'looper',
      'mapbody',
      'mapper',
      'p1',
      'par',
      'root',
      'router',
    ].sort(),
  );
});
