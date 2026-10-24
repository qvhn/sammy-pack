/**
 * Tests for the lint EXTENSIONS added for preview (also strengthen load-time
 * validation): decorative-var, unconsumed-as (both in lintOrchestration), and
 * the unbound-exec-ref ERROR check (in preview's resolution-aware lint). The
 * existing unwired-ref / placeholder / code-run checks are covered by
 * lint-orchestration.test.ts; these cover only the new ones.
 */

import { lintOrchestration } from '../src/validate';
import type { Node } from '../src/types';
import { previewOrchestration } from '../src/llm/preview';

const decorative = (n: Node) =>
  lintOrchestration(n).filter(f => f.code === 'decorative-var');
const unconsumed = (n: Node) =>
  lintOrchestration(n).filter(f => f.code === 'unconsumed-as');

describe('decorative-var', () => {
  test('a var used only in a description is flagged', () => {
    const n: Node = {
      name: 'r',
      vars: { appEnv: 'dev', repo: '/x' },
      phases: [
        {
          name: 'build',
          description: 'Builds for ${appEnv}.',
          code: { run: 'build.sh ${repo}' },
        },
      ],
    } as Node;
    const f = decorative(n);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('appEnv');
    expect(f[0].level).toBe('warning');
  });

  test('a var used in an executable field is NOT decorative', () => {
    const n: Node = {
      name: 'r',
      vars: { appEnv: 'dev' },
      phases: [
        { name: 'build', description: 'for ${appEnv}', code: { run: 'b.sh ${appEnv}' } },
      ],
    } as Node;
    expect(decorative(n)).toHaveLength(0);
  });

  test('a var referenced NOWHERE is flagged (unused) — the headline appEnv case', () => {
    // Mirrors the real env-preflight pattern: appEnv declared in vars, threaded
    // into ZERO fields (not even a description). The old check only fired on
    // desc-only refs and silently missed this.
    const n: Node = {
      name: 'r',
      vars: { repo: '/x', appEnv: 'dev' },
      phases: [
        // build command uses ${repo} but NEVER ${appEnv}.
        { name: 'build', code: { run: 'build.sh ${repo}' } },
      ],
    } as Node;
    const f = decorative(n);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('appEnv');
    expect(f[0].message).toContain('referenced nowhere');
    // The threaded var is NOT flagged.
    expect(f.some(x => x.message.includes('"repo"'))).toBe(false);
  });

  test('a var read via state.X in a code body counts as used (not flagged)', () => {
    const n: Node = {
      name: 'r',
      vars: { appEnv: 'dev' },
      phases: [
        { name: 'use', code: { source: 'return state.appEnv === "dev" ? 1 : 0' } },
      ],
    } as Node;
    expect(decorative(n)).toHaveLength(0);
  });
});

describe('unconsumed-as', () => {
  test('an `as` no downstream field reads is flagged', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'mk', agent: 'agents/a.md', as: 'orphan' },
        { name: 'next', agent: 'agents/a.md', prompt: 'hi' },
      ],
    } as Node;
    const f = unconsumed(n);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('orphan');
  });

  test('a consumed `as` is NOT flagged', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'mk', agent: 'agents/a.md', as: 'plan' },
        { name: 'use', agent: 'agents/a.md', prompt: 'use ${plan}' },
      ],
    } as Node;
    expect(unconsumed(n)).toHaveLength(0);
  });

  test('an `as` read via state.X in a downstream code.source is NOT flagged', () => {
    // Mirrors env-preflight's gate: code.source reads state.build / state.login
    // as plain JS, never as ${...}. The old check missed this and false-flagged.
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'build', code: { run: 'b.sh' }, as: 'build' },
        { name: 'login', agent: 'agents/a.md', as: 'login' },
        {
          name: 'gate',
          code: {
            source:
              'const l = state.login; if(!l.ready) throw new Error("x"); return state.build.sha;',
          },
        },
      ],
    } as Node;
    const f = unconsumed(n);
    expect(f.some(x => x.message.includes('"build"'))).toBe(false);
    expect(f.some(x => x.message.includes('"login"'))).toBe(false);
  });

  test('bracket access state["x"] also counts, but a genuinely-unread `as` still flags', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'read', code: { run: 'r.sh' }, as: 'readme' },
        { name: 'unread', code: { run: 'u.sh' }, as: 'services' },
        { name: 'use', code: { source: 'return state["readme"].length;' } },
      ],
    } as Node;
    const f = unconsumed(n);
    // bracket-accessed `as` is consumed …
    expect(f.some(x => x.message.includes('"readme"'))).toBe(false);
    // … but the genuinely-unread one still flags (the env-preflight `services`).
    expect(f.some(x => x.message.includes('"services"'))).toBe(true);
  });

  test('an `as` read only in a description is still unconsumed (no exec reader)', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'mk', agent: 'agents/a.md', as: 'plan' },
        { name: 'use', agent: 'agents/a.md', description: 'about ${plan}', prompt: 'go' },
      ],
    } as Node;
    expect(unconsumed(n)).toHaveLength(1);
  });
});

describe('load-time lint stays clean on a valid orchestration (no regression)', () => {
  test('the canonical fully-valid shape yields zero findings', () => {
    const findings = lintOrchestration({
      name: 'root',
      state: { acc: { reducer: 'append' } },
      phases: [
        { name: 'plan', agent: 'agents/planner.md', as: 'plan' },
        { name: 'build', agent: 'agents/builder.md', prompt: 'build ${plan} into ${acc}; input was ${input}' },
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

describe('unbound-exec-ref (preview, resolution-aware)', () => {
  test('an unbound ref in code.run / prompt is an ERROR; a declared/supplied var is not', () => {
    const n: Node = {
      name: 'r',
      vars: { repo: '/x' },
      phases: [
        { name: 'build', code: { run: '${repo}/b.sh ${missing}' } },
        { name: 'note', agent: 'agents/a.md', prompt: 'see ${alsoMissing}' },
      ],
    } as Node;
    const plan = previewOrchestration(n);
    const errors = plan.phases
      .flatMap(p => p.findings)
      .filter(f => f.code === 'unbound-exec-ref');
    expect(errors.length).toBe(2);
    expect(plan.summary.errors).toBe(2);
  });

  test('supplying the missing var via --vars clears the error', () => {
    const n: Node = {
      name: 'r',
      phases: [{ name: 'build', code: { run: 'b.sh ${flag}' } }],
    } as Node;
    expect(previewOrchestration(n).summary.errors).toBe(1);
    expect(previewOrchestration(n, { vars: { flag: '--x' } }).summary.errors).toBe(0);
  });

  test('a ref bound to an upstream `as` is NOT an unbound error (it is runtime-symbolic)', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'mk', code: { source: 'return "v"' }, as: 'val' },
        { name: 'use', code: { run: 'echo ${val}' } },
      ],
    } as Node;
    const plan = previewOrchestration(n);
    expect(plan.phases.flatMap(p => p.findings).some(f => f.code === 'unbound-exec-ref')).toBe(false);
  });

  test('${worktrees.<name>.*} is bound by a declared root worktree, and only by one', () => {
    const n: Node = {
      name: 'r',
      worktrees: [{ name: 'repo', repo: '/x' }],
      phases: [
        { name: 'a', agent: 'agents/a.md', prompt: 'on ${worktrees.repo.branch} in ${worktrees.repo.path}' },
        { name: 'b', agent: 'agents/a.md', prompt: 'on ${worktrees.other.branch}' },
      ],
    } as Node;
    const errors = previewOrchestration(n)
      .phases.flatMap(p => p.findings)
      .filter(f => f.code === 'unbound-exec-ref');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('${worktrees.other.branch}');
  });

  test('--no-lint suppresses the structural findings', () => {
    const n: Node = {
      name: 'r',
      phases: [{ name: 'build', code: { run: 'b.sh ${missing}' } }],
    } as Node;
    // The walk still renders «missing: unbound» symbolically, but the lint
    // ERROR finding is suppressed, so there are no error-level findings.
    expect(previewOrchestration(n, { noLint: true }).summary.errors).toBe(0);
  });
});
