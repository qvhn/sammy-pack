import {
  applyMatchesToOrchestration,
  matchAgents,
} from '../src/server/agent-matcher';
import type { Node } from '../src/types';

const AGENTS = [
  'pm',
  'dev-lead',
  'dev',
  'ui-qa',
  'unit-qa',
  'review',
  'checkout-host-qa',
  'search-guest-qa',
  'billing-host-qa',
  'billing-guest-qa',
  'summarizer',
];

describe('matchAgents', () => {
  it('marks exact matches with source=exact', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/pm.md' }],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]).toMatchObject({
      matched: 'agents/pm.md',
      matchSource: 'exact',
      matchedName: 'pm',
    });
    expect(report.unmatched).toHaveLength(0);
  });

  it('matches via -qa suffix strip', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/billing-host.md' }],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches[0]).toMatchObject({
      matched: 'agents/billing-host-qa.md',
      matchSource: 'normalized',
    });
  });

  it('matches via casing + separator normalization', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/BillingHost.md' }],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches[0].matched).toBe('agents/billing-host-qa.md');
  });

  it('matches substrings (declared shorter than candidate)', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/search-guest.md' }],
    };
    const report = matchAgents(orch, AGENTS);
    // normalized: "searchguest" — `agents/search-guest-qa` normalizes to
    // `searchguestqa` and after -qa strip becomes `searchguest`. Hits
    // the normalized index before substring even runs.
    expect(report.matches[0].matched).toBe('agents/search-guest-qa.md');
  });

  it('matches near-misses via Levenshtein', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'p', agent: 'agents/devleed.md' }], // typo
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches[0]).toMatchObject({
      matched: 'agents/dev-lead.md',
      matchSource: 'levenshtein',
    });
  });

  it('returns null for genuinely unknown agents', () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        { name: 'a', agent: 'agents/pm.md' },
        { name: 'b', agent: 'agents/answer-quiz.md' },
        { name: 'c', agent: 'agents/judge-correctness.md' },
      ],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches.map(m => m.matched)).toEqual([
      'agents/pm.md',
      null,
      null,
    ]);
    expect(report.unmatched.map(m => m.declared)).toEqual([
      'agents/answer-quiz.md',
      'agents/judge-correctness.md',
    ]);
  });

  it('does not Levenshtein-match short generic labels (the diagram-import case)', () => {
    // The draw.io → sammy diagram-import roundtrip: a diagram with
    // single-letter node labels (A, B, C) imported,
    // suggesting agent paths `agents/a.md` / `agents/b.md` / etc.
    // The matcher previously snapped all three to whichever agent
    // had the shortest name (pm.md) via Levenshtein. This test
    // pins the new behavior: short labels stay unmatched so the
    // user picks the right agent themselves.
    const orch: Node = {
      name: 'flow',
      phases: [
        { name: 'A', agent: 'agents/a.md' },
        { name: 'B', agent: 'agents/b.md' },
        { name: 'C', agent: 'agents/c.md' },
      ],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches.map(m => m.matched)).toEqual([null, null, null]);
    expect(report.unmatched.length).toBe(3);
  });

  it('recurses into every composite kind', () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        { name: 'spec', agent: 'agents/pm.md' },
        {
          name: 'build-parallel',
          parallel: [
            { name: 'unit', agent: 'agents/unit-qa.md' },
            { name: 'ui', agent: 'agents/ui-qa.md' },
          ],
        },
        {
          name: 'iterate',
          loop: {
            body: { name: 'impl', agent: 'agents/dev.md' },
            maxIterations: 3,
          },
        },
        {
          name: 'each',
          map: {
            over: '["a","b"]',
            body: { name: 'leaf', agent: 'agents/review.md' },
          },
        },
        {
          name: 'route-it',
          route: {
            branches: {
              foo: { name: 'foo', agent: 'agents/summarizer.md' },
            },
            default: { name: 'def', agent: 'agents/dev.md' },
          },
        },
      ],
    };
    const report = matchAgents(orch, AGENTS);
    // 1 (spec) + 2 (parallel) + 1 (loop body) + 1 (map body) + 2 (route) = 7
    expect(report.matches).toHaveLength(7);
    expect(report.unmatched).toHaveLength(0);
  });

  it('handles the `agents` array composite', () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        {
          name: 'chain',
          agents: ['agents/pm.md', 'agents/dev-lead.md'],
        },
      ],
    };
    const report = matchAgents(orch, AGENTS);
    expect(report.matches.map(m => m.matched)).toEqual([
      'agents/pm.md',
      'agents/dev-lead.md',
    ]);
  });
});

describe('applyMatchesToOrchestration', () => {
  it('rewrites near-miss paths to canonical ones', () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        { name: 'a', agent: 'agents/devleed.md' },
        { name: 'b', agent: 'agents/pm.md' }, // exact — untouched
      ],
    };
    const report = matchAgents(orch, AGENTS);
    const fixed = applyMatchesToOrchestration(orch, report);
    expect(fixed.phases![0].agent).toBe('agents/dev-lead.md');
    expect(fixed.phases![1].agent).toBe('agents/pm.md');
  });

  it('leaves unmatched phases unchanged so the user sees the original', () => {
    const orch: Node = {
      name: 'flow',
      phases: [{ name: 'a', agent: 'agents/totally-fake.md' }],
    };
    const report = matchAgents(orch, AGENTS);
    const fixed = applyMatchesToOrchestration(orch, report);
    expect(fixed.phases![0].agent).toBe('agents/totally-fake.md');
  });

  it('walks composites for rewrites too', () => {
    const orch: Node = {
      name: 'flow',
      phases: [
        {
          name: 'parallel-build',
          parallel: [
            { name: 'unit', agent: 'agents/uneetqa.md' }, // near-miss → unit-qa
            { name: 'ui', agent: 'agents/ui-qa.md' },
          ],
        },
      ],
    };
    const report = matchAgents(orch, AGENTS);
    const fixed = applyMatchesToOrchestration(orch, report);
    expect(fixed.phases![0].parallel![0].agent).toBe('agents/unit-qa.md');
    expect(fixed.phases![0].parallel![1].agent).toBe('agents/ui-qa.md');
  });
});
