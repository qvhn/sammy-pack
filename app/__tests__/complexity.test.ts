/**
 * Unit tests for the orchestration complexity metric (src/lib/complexity.ts).
 *
 * The metric is a generic, structural score over the orchestration JSON shape.
 * These guard the signal extraction (counts every body kind + nesting), the
 * tiering thresholds, and the relative ordering (heavier trees score higher) —
 * the properties the UI badges depend on.
 */

import {
  complexityDescription,
  complexityLabel,
  computeComplexity,
  TIER_COLOR,
} from '../src/lib/complexity';
import type { Node } from '../src/types';

describe('computeComplexity', () => {
  test('a single bare phase is trivial', () => {
    const c = computeComplexity({ name: 'solo', agent: 'agents/a.md' });
    expect(c.signals.nodeCount).toBe(1);
    expect(c.signals.maxDepth).toBe(1);
    expect(c.signals.distinctAgents).toBe(1);
    expect(c.tier).toBe('trivial');
  });

  test('counts nodes, depth, agents, and tools across a flat phases list', () => {
    const orch: Node = {
      name: 'flat',
      phases: [
        { name: 'p1', agent: 'agents/a.md', tools: ['github'] },
        { name: 'p2', agent: 'agents/b.md', tools: ['github', 'slack'] },
        { name: 'p3', agent: 'agents/a.md' },
      ],
    };
    const c = computeComplexity(orch);
    expect(c.signals.nodeCount).toBe(4); // root + 3
    expect(c.signals.maxDepth).toBe(2); // root=1, children=2
    expect(c.signals.distinctAgents).toBe(2); // a, b (a dedup'd)
    expect(c.signals.distinctTools).toBe(2); // github, slack
  });

  test('parallel fan-out width is the widest concurrent branch set', () => {
    const orch: Node = {
      name: 'fan',
      phases: [
        {
          name: 'wide',
          parallel: [
            { name: 'b1', agent: 'agents/a.md' },
            { name: 'b2', agent: 'agents/b.md' },
            { name: 'b3', agent: 'agents/c.md' },
            { name: 'b4', agent: 'agents/d.md' },
          ],
        },
      ],
    };
    const c = computeComplexity(orch);
    expect(c.signals.maxFanout).toBe(4);
  });

  test('detects loops, maps, serial-maps, branches, and subflows', () => {
    const orch: Node = {
      name: 'composites',
      phases: [
        {
          name: 'refine',
          loop: { body: { name: 'work', agent: 'agents/a.md' }, maxIterations: 5 },
        },
        {
          name: 'fanout',
          map: { over: '${items}', body: { name: 'each', agent: 'agents/b.md' } },
        },
        {
          name: 'serial',
          map: {
            over: '${rows}',
            serial: true,
            body: { name: 'row', agent: 'agents/c.md' },
          },
        },
        {
          name: 'pick',
          switch: {
            on: '${verdict}',
            cases: {
              yes: { name: 'go', agent: 'agents/d.md' },
              no: { name: 'stop', agent: 'agents/e.md' },
            },
          },
        },
        { name: 'nested', subflow: 'other-orchestration' },
      ],
    };
    const c = computeComplexity(orch);
    expect(c.signals.loops).toBe(1);
    expect(c.signals.maps).toBe(2); // parallel map + serial map
    expect(c.signals.serialMaps).toBe(1);
    expect(c.signals.branches).toBe(1); // the switch
    expect(c.signals.subflows).toBe(1);
  });

  test('walks nested composites for depth', () => {
    const orch: Node = {
      name: 'deep',
      phases: [
        {
          name: 'l1',
          parallel: [
            {
              name: 'l2',
              loop: {
                maxIterations: 3,
                body: { name: 'l3', agent: 'agents/a.md' },
              },
            },
          ],
        },
      ],
    };
    const c = computeComplexity(orch);
    // root(1) -> l1(2) -> l2(3) -> loop body l3(4)
    expect(c.signals.maxDepth).toBe(4);
  });

  test('folds conversation participants, merger, judge, and router into agents', () => {
    const orch: Node = {
      name: 'agentsy',
      phases: [
        {
          name: 'chat',
          conversation: {
            participants: ['agents/a.md', 'agents/b.md'],
            rounds: 2,
          },
        },
        {
          name: 'merge',
          converge: [{ name: 'x', agent: 'agents/c.md' }],
          merger: 'agents/m.md',
        },
        {
          name: 'route',
          route: {
            router: 'agents/r.md',
            branches: { x: { name: 'bx', agent: 'agents/a.md' } },
          },
        },
      ],
    };
    const c = computeComplexity(orch);
    // a, b, c, m, r — a is reused, so 5 distinct.
    expect(c.signals.distinctAgents).toBe(5);
  });

  test('score increases monotonically as structure is added', () => {
    const small = computeComplexity({
      name: 's',
      phases: [{ name: 'p', agent: 'agents/a.md' }],
    });
    const bigger = computeComplexity({
      name: 'b',
      phases: [
        { name: 'p1', agent: 'agents/a.md' },
        {
          name: 'p2',
          parallel: [
            { name: 'x', agent: 'agents/b.md' },
            { name: 'y', agent: 'agents/c.md' },
          ],
        },
        {
          name: 'p3',
          loop: { maxIterations: 4, body: { name: 'w', agent: 'agents/d.md' } },
        },
      ],
    });
    expect(bigger.score).toBeGreaterThan(small.score);
  });

  test('tiers escalate from trivial to intricate', () => {
    const trivial = computeComplexity({ name: 't', agent: 'agents/a.md' });
    expect(trivial.tier).toBe('trivial');

    // Build a large, deep, wide, loop+subflow-heavy tree → intricate.
    const branches: Node[] = [];
    for (let i = 0; i < 8; i++) {
      branches.push({
        name: `b${i}`,
        loop: {
          maxIterations: 3,
          body: {
            name: `body${i}`,
            map: {
              over: '${items}',
              body: { name: `m${i}`, subflow: `sub-${i}` },
            },
          },
        },
        tools: [`tool${i}`],
        agent: undefined,
      });
    }
    const heavy = computeComplexity({
      name: 'heavy',
      phases: [{ name: 'fan', parallel: branches }],
    });
    expect(heavy.score).toBeGreaterThanOrEqual(100);
    expect(heavy.tier).toBe('intricate');
  });

  test('label and description are derived from the signals', () => {
    const c = computeComplexity({
      name: 'd',
      phases: [
        { name: 'p1', agent: 'agents/a.md' },
        {
          name: 'p2',
          loop: { maxIterations: 2, body: { name: 'w', agent: 'agents/b.md' } },
        },
      ],
    });
    expect(complexityLabel(c)).toBe(`${c.tier} · ${c.score}`);
    const desc = complexityDescription(c);
    expect(desc).toContain('Complexity');
    expect(desc).toContain('node');
    expect(desc).toContain('loop');
  });

  test('every tier has a color', () => {
    for (const tier of [
      'trivial',
      'simple',
      'moderate',
      'complex',
      'intricate',
    ] as const) {
      expect(TIER_COLOR[tier]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
