/**
 * Unit tests for the symbolic walker (preview.ts): static resolution, runtime
 * symbolic placeholders, control-flow labeling (static vs runtime when / switch
 * / route), map expansion (static array vs runtime), subflow expansion + cycle
 * detection, and depth capping.
 */

import { previewOrchestration, type PreviewNode } from '../src/llm/preview';
import type { Node } from '../src/types';

/** Find the first node (DFS) whose name matches. */
function find(nodes: PreviewNode[], name: string): PreviewNode | undefined {
  for (const n of nodes) {
    if (n.name === name) return n;
    const inner = find(n.children, name);
    if (inner) return inner;
  }
  return undefined;
}

describe('static resolution', () => {
  test('a prompt over vars + input resolves fully (not symbolic)', () => {
    const orch: Node = {
      name: 'r',
      vars: { env: 'stg' },
      phases: [
        { name: 'p', agent: 'agents/a.md', prompt: 'deploy to ${env}, payload ${input}' },
      ],
    };
    const plan = previewOrchestration(orch, { initialInput: 'PKG' });
    const p = find(plan.phases, 'p')!;
    expect(p.symbolic).toBe(false);
    expect(p.action?.verb).toBe('would prompt');
    expect(p.action?.text).toBe('deploy to stg, payload PKG');
  });

  test('--vars override beats the orchestration vars', () => {
    const orch: Node = {
      name: 'r',
      vars: { env: 'dev' },
      phases: [{ name: 'p', code: { run: 'build.sh ${env}' } }],
    };
    const plan = previewOrchestration(orch, { vars: { env: 'stg' } });
    expect(find(plan.phases, 'p')!.action?.text).toBe('build.sh stg');
  });
});

describe('runtime symbolic placeholders', () => {
  test('a ref bound to an upstream `as` renders «name ← producer (kind)»', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        { name: 'mk', code: { source: 'return "ref"' }, as: 'buildRef' },
        { name: 'use', agent: 'agents/a.md', prompt: 'checkout ${buildRef} now' },
      ],
    };
    const plan = previewOrchestration(orch);
    const use = find(plan.phases, 'use')!;
    expect(use.symbolic).toBe(true);
    expect(use.action?.text).toBe('checkout «buildRef ← mk (code)» now');
  });

  test('a genuinely unbound ref in a prompt renders «name: unbound» and errors', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'p', agent: 'agents/a.md', prompt: 'send to ${nowhere}' }],
    };
    const plan = previewOrchestration(orch);
    const p = find(plan.phases, 'p')!;
    expect(p.action?.text).toBe('send to «nowhere: unbound»');
    expect(p.findings.some(f => f.code === 'unbound-exec-ref' && f.severity === 'error')).toBe(true);
    expect(plan.summary.errors).toBeGreaterThan(0);
  });

  test('a required-but-unset declared input renders «name: required, unset»', () => {
    const orch: Node = {
      name: 'r',
      inputs: [{ name: 'ticket', kind: 'jira', required: true }],
      phases: [{ name: 'p', agent: 'agents/a.md', prompt: 'work ${ticket}' }],
    };
    const plan = previewOrchestration(orch);
    const p = find(plan.phases, 'p')!;
    expect(p.action?.text).toBe('work «ticket: required, unset»');
    // A declared input is NOT an unbound-exec-ref error.
    expect(p.findings.some(f => f.code === 'unbound-exec-ref')).toBe(false);
  });
});

describe('when control flow', () => {
  test('static truthy when → runs; static falsy when → skipped', () => {
    const orch: Node = {
      name: 'r',
      vars: { on: 'true', off: 'false' },
      phases: [
        { name: 'yes', agent: 'agents/a.md', when: '${on}' },
        { name: 'no', agent: 'agents/a.md', when: '${off}' },
      ],
    };
    const plan = previewOrchestration(orch);
    expect(find(plan.phases, 'yes')!.wouldRun).toBe(true);
    expect(find(plan.phases, 'no')!.wouldRun).toBe(false);
  });

  test('runtime when → conditional + info finding', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        { name: 'gate', code: { source: 'return "1"' }, as: 'doIt' },
        { name: 'maybe', agent: 'agents/a.md', when: '${doIt}' },
      ],
    };
    const plan = previewOrchestration(orch);
    const m = find(plan.phases, 'maybe')!;
    expect(m.wouldRun).toBe('conditional');
    expect(m.whenLabel).toContain('«doIt');
    expect(m.findings.some(f => f.code === 'runtime-branch')).toBe(true);
  });
});

describe('switch control flow', () => {
  test('static `on` value resolves the taken case; others greyed', () => {
    const orch: Node = {
      name: 'r',
      vars: { verdict: 'pass' },
      phases: [
        {
          name: 'sw',
          switch: {
            on: '${verdict}',
            cases: {
              pass: { name: 'shipit', agent: 'agents/a.md' },
              fail: { name: 'holdit', agent: 'agents/a.md' },
            },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const sw = find(plan.phases, 'sw')!;
    expect(sw.symbolic).toBe(false);
    expect(sw.expansion).toContain('pass');
    expect(find(plan.phases, 'shipit')!.wouldRun).not.toBe(false); // taken
    expect(find(plan.phases, 'holdit')!.wouldRun).toBe(false); // not taken
  });

  test('runtime `on` value → all cases conditional', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        { name: 'v', code: { source: 'return "x"' }, as: 'verdict' },
        {
          name: 'sw',
          switch: {
            on: '${verdict}',
            cases: { a: { name: 'A', agent: 'agents/a.md' }, b: { name: 'B', agent: 'agents/a.md' } },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const sw = find(plan.phases, 'sw')!;
    expect(sw.symbolic).toBe(true);
    expect(sw.wouldRun).toBe('conditional');
    expect(find(plan.phases, 'A')!.wouldRun).toBe('conditional');
  });
});

describe('route control flow', () => {
  test('route is always runtime — all branches conditional + info', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        {
          name: 'rt',
          route: {
            router: 'agents/router.md',
            branches: { x: { name: 'X', agent: 'agents/a.md' }, y: { name: 'Y', agent: 'agents/a.md' } },
            default: { name: 'D', agent: 'agents/a.md' },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const rt = find(plan.phases, 'rt')!;
    expect(rt.symbolic).toBe(true);
    expect(rt.wouldRun).toBe('conditional');
    expect(rt.findings.some(f => f.code === 'runtime-branch')).toBe(true);
    expect(find(plan.phases, 'X')!.wouldRun).toBe('conditional');
    expect(find(plan.phases, 'D')!.wouldRun).toBe('conditional');
  });
});

describe('map expansion', () => {
  test('static inline array → one child per item with ${item}/${index} resolved', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        {
          name: 'm',
          map: {
            over: '["a","b","c"]',
            body: { name: 'body', agent: 'agents/a.md', prompt: 'do ${item} #${index}' },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const m = find(plan.phases, 'm')!;
    expect(m.children).toHaveLength(3);
    expect(m.expansion).toContain('× 3');
    expect(m.children[0].action?.text).toBe('do a #0');
    expect(m.children[2].action?.text).toBe('do c #2');
    expect(m.children.every(c => c.symbolic === false)).toBe(true);
  });

  test('runtime array → one symbolic iteration marked [× «runtime»]', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        { name: 'gen', code: { source: 'return []' }, as: 'items' },
        {
          name: 'm',
          map: {
            over: '${items}',
            body: { name: 'body', agent: 'agents/a.md', prompt: 'do ${item}' },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const m = find(plan.phases, 'm')!;
    expect(m.symbolic).toBe(true);
    expect(m.expansion).toContain('«');
    expect(m.children).toHaveLength(1); // one symbolic iteration
    expect(m.findings.some(f => f.code === 'runtime-branch')).toBe(true);
  });

  test('--depth collapses a wide static map to one iteration', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        {
          name: 'm',
          map: {
            over: '["a","b","c","d","e"]',
            body: { name: 'body', agent: 'agents/a.md', prompt: '${item}' },
          },
        },
      ],
    };
    const plan = previewOrchestration(orch, { maxDepth: 0 });
    const m = find(plan.phases, 'm')!;
    expect(m.children).toHaveLength(1);
    expect(m.findings.some(f => f.code === 'depth-collapsed')).toBe(true);
  });
});

describe('subflow', () => {
  const child: Node = {
    name: 'child-flow',
    vars: { who: 'world' },
    phases: [{ name: 'inner', agent: 'agents/a.md', prompt: 'hi ${who}' }],
  };

  test('static subflow name → expands the child body, seeds its vars', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'call', subflow: 'child-flow' }],
    };
    const byName = new Map<string, Node>([['child-flow', child]]);
    const plan = previewOrchestration(orch, { orchestrationByName: byName });
    const call = find(plan.phases, 'call')!;
    expect(call.kind).toBe('subflow');
    const inner = find(call.children, 'inner')!;
    expect(inner.action?.text).toBe('hi world'); // child var seeded
    expect(plan.summary.subflows).toBe(1);
  });

  test('a direct cycle is detected + errors, not infinitely expanded', () => {
    const recursive: Node = {
      name: 'loopy',
      phases: [{ name: 'again', subflow: 'loopy' }],
    };
    const byName = new Map<string, Node>([['loopy', recursive]]);
    const plan = previewOrchestration(recursive, { orchestrationByName: byName });
    const again = find(plan.phases, 'again')!;
    expect(again.findings.some(f => f.code === 'cyclic-subflow' && f.severity === 'error')).toBe(true);
    expect(plan.summary.errors).toBeGreaterThan(0);
  });

  test('a missing subflow target errors', () => {
    const orch: Node = { name: 'r', phases: [{ name: 'call', subflow: 'nope' }] };
    const plan = previewOrchestration(orch);
    const call = find(plan.phases, 'call')!;
    expect(call.findings.some(f => f.code === 'missing-subflow' && f.severity === 'error')).toBe(true);
  });

  test('a runtime subflow name is not expanded (info)', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        { name: 'pick', code: { source: 'return "x"' }, as: 'comp' },
        { name: 'call', subflow: '${comp}-flow' },
      ],
    };
    const plan = previewOrchestration(orch);
    const call = find(plan.phases, 'call')!;
    expect(call.symbolic).toBe(true);
    expect(call.findings.some(f => f.code === 'runtime-subflow')).toBe(true);
  });
});

describe('side-effecting leaves are never executed, only described', () => {
  test('code.run renders `would run` with the resolved command', () => {
    const orch: Node = {
      name: 'r',
      vars: { dir: '/x' },
      phases: [{ name: 'c', code: { run: '${dir}/go.sh --flag' } }],
    };
    const plan = previewOrchestration(orch);
    const c = find(plan.phases, 'c')!;
    expect(c.kind).toBe('code.run');
    expect(c.action).toEqual({ verb: 'would run', text: '/x/go.sh --flag' });
  });

  test('a2a renders `would call` the agent card', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'remote', a2a: { agentCard: 'https://x/card.json', skill: 'do-thing' } }],
    };
    const plan = previewOrchestration(orch);
    const r = find(plan.phases, 'remote')!;
    expect(r.action?.verb).toBe('would call');
    expect(r.action?.text).toContain('https://x/card.json');
    expect(r.action?.text).toContain('do-thing');
  });
});

describe('lint: composite with no explicit timeout (item 1)', () => {
  const bigComposite: Node = {
    name: 'r',
    phases: [
      {
        name: 'crawlers',
        // 3 sub-phases, none with an explicit timeout → each inherits ~1800s,
        // summing to ~5400s past the composite's own inherited ~1800s cap.
        phases: [
          { name: 'c1', agent: 'agents/a.md' },
          { name: 'c2', agent: 'agents/a.md' },
          { name: 'c3', agent: 'agents/a.md' },
        ],
      },
    ],
  };

  test('warns with the count, the inherited cap, and the summed timeout', () => {
    const plan = previewOrchestration(bigComposite);
    const c = find(plan.phases, 'crawlers')!;
    const f = c.findings.find(x => x.code === 'composite-no-timeout');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('3 serial sub-phases');
    expect(f!.message).toContain('1800s'); // the inherited default cap
    expect(f!.message).toContain('5400s'); // 3 × 1800
    // Rolls up into the plan summary + would NOT fail the CLI (warning only).
    expect(plan.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(plan.summary.errors).toBe(0);
  });

  test('an explicit `timeout` on the composite silences it', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ ...bigComposite.phases![0], timeout: 9000 }],
    };
    const plan = previewOrchestration(orch);
    const c = find(plan.phases, 'crawlers')!;
    expect(c.findings.find(x => x.code === 'composite-no-timeout')).toBeUndefined();
  });

  test('sub-phase timeouts that fit under the inherited cap stay quiet', () => {
    const orch: Node = {
      name: 'r',
      phases: [
        {
          name: 'quick',
          phases: [
            { name: 'q1', agent: 'agents/a.md', timeout: 300 },
            { name: 'q2', agent: 'agents/a.md', timeout: 300 },
          ],
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const q = find(plan.phases, 'quick')!;
    expect(q.findings.find(x => x.code === 'composite-no-timeout')).toBeUndefined();
  });

  test('a single sub-phase is not a serial pileup (no warning)', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'solo', phases: [{ name: 's1', agent: 'agents/a.md' }] }],
    };
    const plan = previewOrchestration(orch);
    const s = find(plan.phases, 'solo')!;
    expect(s.findings.find(x => x.code === 'composite-no-timeout')).toBeUndefined();
  });

  test('an orchestration `defaults.timeout` becomes the inherited cap in the message', () => {
    const orch: Node = {
      name: 'r',
      defaults: { timeout: 600 },
      phases: [
        {
          name: 'seq',
          // Two 500s sub-phases sum to 1000s, past the 600s inherited cap.
          phases: [
            { name: 'a1', agent: 'agents/a.md', timeout: 500 },
            { name: 'a2', agent: 'agents/a.md', timeout: 500 },
          ],
        },
      ],
    };
    const plan = previewOrchestration(orch);
    const seq = find(plan.phases, 'seq')!;
    const f = seq.findings.find(x => x.code === 'composite-no-timeout');
    expect(f).toBeDefined();
    expect(f!.message).toContain('600s'); // the defaults.timeout cap, not 1800
    expect(f!.message).toContain('1000s'); // 2 × 500
  });
});

describe('lint: code.run preflight gate (item 2)', () => {
  test('a code.run node warns the run hard-fails at preflight without the flag', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'shell', code: { run: 'echo hi' } }],
    };
    const plan = previewOrchestration(orch);
    const shell = find(plan.phases, 'shell')!;
    const f = shell.findings.find(x => x.code === 'code-run-preflight');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('SAMMY_ALLOW_CODE_RUN=1');
    expect(f!.message).toContain('preflight');
  });

  test('an inline `code.source` (vm-sandboxed) does NOT get the preflight warning', () => {
    const orch: Node = {
      name: 'r',
      phases: [{ name: 'js', code: { source: 'return 1 + 1' } }],
    };
    const plan = previewOrchestration(orch);
    const js = find(plan.phases, 'js')!;
    expect(js.findings.find(x => x.code === 'code-run-preflight')).toBeUndefined();
  });
});
