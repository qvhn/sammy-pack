/**
 * Tests for the register-time LINT pass (`lintOrchestration`) — advisory,
 * non-blocking warnings that catch the class of silent authoring mistakes a
 * schema-valid orchestration still ships with:
 *   - an unwired `${ref}` that's a TYPO of a produced (`as`-bound) name
 *   - a leftover placeholder marker (TODO / FIXME / XXX / PLACEHOLDER) in a
 *     value — a `TODO(live-wiring)…` query string reaches the model as a
 *     literal, which it reads as an instruction and improvises around rather
 *     than failing on.
 *   - a `code.run` external-shell heads-up.
 *
 * These are WARNINGS, never errors: lint must never reject an existing-valid
 * orchestration. The unwired-ref check deliberately does NOT flag a plain
 * unbound base (that's the valid run-input pattern — `${ticket}` passed as
 * `initialInput`); it only fires when the unbound ref is a near-typo of a name
 * the orchestration actually produces. The examples-valid regression test
 * guards false positives on the real shipped corpus; here we pin unit behavior.
 */

import { lintOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const refWarnings = (n: Node) =>
  lintOrchestration(n).filter(f => f.code === 'unwired-ref');
const placeholderWarnings = (n: Node) =>
  lintOrchestration(n).filter(f => f.code === 'placeholder-marker');

describe('lintOrchestration: unwired ${ref} (typo of a produced name)', () => {
  test('flags ${paln} when "plan" is `as`-bound, and names "plan"', () => {
    const w = refWarnings({
      name: 'root',
      phases: [
        { name: 'make', agent: 'a', as: 'plan' },
        { name: 'use', agent: 'b', prompt: 'execute ${paln} now' },
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe('warning');
    expect(w[0].message).toMatch(/plan/);
    expect(w[0].node).toBe('use');
  });

  test('does NOT flag a plain unbound base — that is the run-input pattern', () => {
    // No `as` write resembles `ticket`; it is supplied as initialInput. Valid.
    expect(
      refWarnings({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', prompt: 'resolve ${ticket}' }],
      }),
    ).toHaveLength(0);
  });

  test('does NOT flag reserved scope vars (${input} / ${item} / ${index} / ${error.message})', () => {
    expect(
      refWarnings({
        name: 'root',
        map: {
          over: '${ids}',
          body: {
            name: 'b',
            agent: 'a',
            prompt: 'item ${item} at ${index} from ${input}',
            onError: { name: 'rec', agent: 'a', prompt: 'failed: ${error.message}' },
          },
        },
        as: 'ids',
      } as unknown as Node),
    ).toHaveLength(0);
  });

  test('does NOT flag the ${vars.*} reserved namespace', () => {
    expect(
      refWarnings({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', prompt: 'threshold ${vars.threshold}' }],
      } as unknown as Node),
    ).toHaveLength(0);
  });

  test('does NOT flag an `as`-bound name referenced downstream (correct spelling)', () => {
    expect(
      refWarnings({
        name: 'root',
        phases: [
          { name: 'make', agent: 'a', as: 'plan' },
          { name: 'use', agent: 'b', prompt: 'execute ${plan}' },
        ],
      }),
    ).toHaveLength(0);
  });

  test('does NOT flag a top-level `state:` reducer-slot key', () => {
    expect(
      refWarnings({
        name: 'root',
        state: { findings: { reducer: 'append' } },
        phases: [{ name: 'p', agent: 'a', prompt: 'so far: ${findings}' }],
      } as unknown as Node),
    ).toHaveLength(0);
  });

  test('does NOT flag ${connections:...} (different mechanism)', () => {
    expect(
      refWarnings({
        name: 'root',
        phases: [
          {
            name: 'p',
            a2a: { agentCard: '${connections:remote.url}' },
            idempotencyKey: '${connections:remote.value}',
          },
        ],
      } as unknown as Node),
    ).toHaveLength(0);
  });

  test('a dotted typo is checked on its BASE (${plam.step} ~ as:plan)', () => {
    const w = refWarnings({
      name: 'root',
      phases: [
        { name: 'make', agent: 'a', as: 'plan' },
        { name: 'use', agent: 'b', prompt: 'do ${plam.step}' },
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/plan/);
  });

  test('a dotted ref on a correctly-spelled BOUND base is fine (${plan.step})', () => {
    expect(
      refWarnings({
        name: 'root',
        phases: [
          { name: 'make', agent: 'a', as: 'plan' },
          { name: 'use', agent: 'b', prompt: 'do ${plan.step}' },
        ],
      }),
    ).toHaveLength(0);
  });
});

describe('lintOrchestration: placeholder markers', () => {
  test('flags a TODO(...) left in a value (the live-wiring failure)', () => {
    const w = placeholderWarnings({
      name: 'root',
      phases: [
        {
          name: 'fetch',
          code: { source: 'return "TODO(live-wiring): real JQL here"' },
        },
      ],
    } as unknown as Node);
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe('warning');
    expect(w[0].message).toMatch(/TODO/);
    expect(w[0].node).toBe('fetch');
  });

  test.each(['FIXME:', 'XXX', '<PLACEHOLDER>'])(
    'flags the %s marker in a placeholder shape',
    token => {
      const w = placeholderWarnings({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', prompt: `the value is ${token}` }],
      });
      expect(w).toHaveLength(1);
    },
  );

  test('no placeholder warning for a clean value', () => {
    expect(
      placeholderWarnings({
        name: 'root',
        phases: [{ name: 'p', agent: 'a', prompt: 'a perfectly normal prompt' }],
      }),
    ).toHaveLength(0);
  });

  test('does NOT flag the marker used as ordinary prose ("planned TODO tickets")', () => {
    // The corpus false positive: a TODO that is a common noun, not a sentinel.
    expect(
      placeholderWarnings({
        name: 'root',
        phases: [
          { name: 'p', agent: 'a', prompt: 'Combine the planned TODO tickets into a worklist' },
        ],
      }),
    ).toHaveLength(0);
  });
});

describe('lintOrchestration: code.run heads-up', () => {
  test('warns when a node uses code.run', () => {
    const w = lintOrchestration({
      name: 'root',
      phases: [{ name: 'p', code: { run: 'npm run env:stg' } }],
    } as unknown as Node).filter(f => f.code === 'code-run');
    expect(w).toHaveLength(1);
    expect(w[0].node).toBe('p');
  });

  test('no code-run warning for code.source', () => {
    const w = lintOrchestration({
      name: 'root',
      phases: [{ name: 'p', code: { source: 'return input' } }],
    } as unknown as Node).filter(f => f.code === 'code-run');
    expect(w).toHaveLength(0);
  });
});

describe('lintOrchestration: a fully-valid orchestration is clean', () => {
  test('zero findings — refs bound, no placeholders, no code.run', () => {
    const findings = lintOrchestration({
      name: 'root',
      state: { acc: { reducer: 'append' } },
      phases: [
        { name: 'plan', agent: 'agents/planner.md', as: 'plan' },
        {
          name: 'build',
          agent: 'agents/builder.md',
          prompt: 'build ${plan} into ${acc}; input was ${input}',
        },
        {
          name: 'fan',
          map: {
            over: '${plan}',
            body: { name: 'one', agent: 'agents/w.md', prompt: 'do ${item} (#${index})' },
          },
        },
      ],
    } as unknown as Node);
    expect(findings).toHaveLength(0);
  });
});

describe('nondeterministic-code lint', () => {
  const { lintOrchestration } = require('../src/validate');
  const codes = (orch: unknown) =>
    lintOrchestration(orch as never).map((f: { code: string }) => f.code);

  it('flags a code phase that reads the clock or the RNG', () => {
    // A code leaf's output is CHECKPOINTED and replayed verbatim, so a real
    // re-execution (resume / fork / composite retry) disagrees with the
    // replay — silently.
    for (const source of [
      'return Math.random()',
      'return Date.now()',
      'return new Date().toISOString()',
      'return performance.now()',
      'return Math . random ()',
    ]) {
      const findings = lintOrchestration({
        name: 'f',
        phases: [{ name: 'c', code: { source } }],
      } as never);
      expect(findings.map((x: { code: string }) => x.code)).toContain(
        'nondeterministic-code',
      );
      const msg = findings.find(
        (x: { code: string }) => x.code === 'nondeterministic-code',
      )!.message;
      expect(msg).toMatch(/replay|checkpoint/i);
    }
  });

  it('does NOT flag deterministic code, or a date passed in as a var', () => {
    expect(
      codes({
        name: 'f',
        vars: { now: '2026-10-04' },
        phases: [
          { name: 'a', code: { source: "return 'stamped ' + vars.now" } },
          { name: 'b', code: { source: 'return new Date(vars.now).getFullYear()' } },
        ],
      }),
    ).not.toContain('nondeterministic-code');
  });
});
