/**
 * `composite-contract` lint — an `input` / `output` contract declared on a
 * node whose kind never evaluates one.
 *
 * `input` and `output` live on the flat Node type for every kind, but the
 * executor's checkContract call sites are exactly the four leaf runners
 * (agent / code / wait / a2a). A contract on `phases`, `map`, `parallel`,
 * `loop`, `route`, `switch`, … is accepted by the schema, passes
 * `validateOrchestration`, previews clean, and is then silently ignored at
 * run time. Same shape as the unwired-ref lint: advisory, names the node,
 * never blocks a save.
 */

import { lintOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const contractWarnings = (n: Node) =>
  lintOrchestration(n).filter(f => f.code === 'composite-contract');

const OUT = { type: 'object', properties: { ok: { type: 'boolean' } } };

describe('lintOrchestration: composite-contract', () => {
  test('flags an output contract on a `phases` composite and names the node', () => {
    const w = contractWarnings({
      name: 'pipeline',
      output: OUT,
      phases: [{ name: 'only', agent: 'a' }],
    } as unknown as Node);
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe('warning');
    expect(w[0].node).toBe('pipeline');
    expect(w[0].message).toMatch(/enforced on leaves \(agent\/code\/wait\/a2a\/http\) only; this one is ignored/);
    expect(w[0].message).toMatch(/"pipeline"/);
    expect(w[0].message).toMatch(/\boutput contract\b/);
  });

  test('flags an input contract on a nested `map` body composite, not its leaf', () => {
    const w = contractWarnings({
      name: 'root',
      phases: [
        {
          name: 'fan',
          input: { type: 'array' },
          map: { over: '${items}', body: { name: 'each', agent: 'a', input: { type: 'string' } } },
        },
      ],
      as: 'items',
    } as unknown as Node);
    expect(w.map(f => f.node)).toEqual(['fan']);
    expect(w[0].message).toMatch(/\binput contract\b/);
  });

  test('names both sides when both are declared on a composite', () => {
    const w = contractWarnings({
      name: 'both',
      input: { type: 'string' },
      output: OUT,
      parallel: [
        { name: 'a1', agent: 'a' },
        { name: 'a2', agent: 'b' },
      ],
    } as unknown as Node);
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/input \+ output contract/);
  });

  test('does NOT flag a contract on any enforced leaf kind', () => {
    const leaves: Node[] = [
      { name: 'ag', agent: 'a', input: { type: 'string' }, output: OUT },
      { name: 'cd', code: { source: 'return input;' }, output: OUT },
      { name: 'wt', wait: { signal: 'go' }, input: { type: 'string' } },
      { name: 'a2', a2a: { agentCard: 'https://agent.example.test/card.json' }, output: OUT },
    ] as unknown as Node[];
    for (const leaf of leaves) {
      expect(contractWarnings({ name: 'root', phases: [leaf] })).toHaveLength(0);
    }
  });

  test('does NOT flag a composite with no contract at all', () => {
    expect(
      contractWarnings({
        name: 'root',
        phases: [{ name: 'a', agent: 'a' }, { name: 'b', code: { source: 'return 1;' } }],
      } as unknown as Node),
    ).toHaveLength(0);
  });
});
