/**
 * Renderer tests: the terminal string + JSON renderers, and the --diff renderer.
 * Kept separate from the walk — these assert formatting only, over a plan the
 * walker produced.
 */

import {
  renderPlanText,
  renderPlanJson,
  renderDiffText,
} from '../src/llm/preview-render';
import { previewOrchestration } from '../src/llm/preview';
import type { Node } from '../src/types';

const orch: Node = {
  name: 'demo',
  vars: { env: 'stg' },
  concurrency: { group: 'g1', policy: 'queue' },
  phases: [
    { name: 'build', code: { run: 'build.sh ${env}' } },
    { name: 'note', agent: 'agents/a.md', prompt: 'shipped to ${env}' },
  ],
};

describe('renderPlanText', () => {
  const text = renderPlanText(previewOrchestration(orch));

  test('header, vars, concurrency, phases, summary all present', () => {
    expect(text).toContain('preview  demo');
    expect(text).toContain('vars');
    expect(text).toContain('env=stg');
    expect(text).toContain('concurrency  group=g1 policy=queue');
    expect(text).toContain('phases');
    expect(text).toContain('build');
    expect(text).toContain('run   build.sh stg');
    expect(text).toContain('prompt  shipped to stg'); // 'prompt' column, resolved
    expect(text).toContain('summary');
    expect(text).toContain('findings');
  });

  test('numbers top-level phases', () => {
    expect(text).toMatch(/\n\s+1\s+build/);
    expect(text).toMatch(/\n\s+2\s+note/);
  });

  test('renders an error finding with the ✗ glyph', () => {
    const bad: Node = {
      name: 'b',
      phases: [{ name: 'p', code: { run: 'x ${missing}' } }],
    };
    const t = renderPlanText(previewOrchestration(bad));
    expect(t).toContain('✗');
    expect(t).toContain('1 error');
  });
});

describe('renderPlanJson', () => {
  test('round-trips to the plan object', () => {
    const plan = previewOrchestration(orch);
    const parsed = JSON.parse(renderPlanJson(plan));
    expect(parsed.orchestration).toBe('demo');
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.summary).toBeDefined();
  });
});

describe('renderDiffText', () => {
  test('reports a changed var that changes no resolved action (the decorative trap)', () => {
    // env is decorative-ish here: only `build` uses it. Change a var that is
    // NOT used anywhere → vars differ but actions are identical.
    const a = previewOrchestration(orch, { vars: { unusedVar: 'A' } });
    const b = previewOrchestration(orch, { vars: { unusedVar: 'B' } });
    const diff = renderDiffText(a, b, 'unusedVar=A', 'unusedVar=B');
    expect(diff).toContain('preview-diff  demo');
    expect(diff).toContain('unusedVar:  A  →  B');
    expect(diff).toContain('no resolved-action differences');
  });

  test('reports a phase whose resolved command actually differs', () => {
    const a = previewOrchestration(orch, { vars: { env: 'dev' } });
    const b = previewOrchestration(orch, { vars: { env: 'stg' } });
    const diff = renderDiffText(a, b, 'env=dev', 'env=stg');
    expect(diff).toContain('resolve DIFFERENTLY');
    expect(diff).toContain('build.sh dev');
    expect(diff).toContain('build.sh stg');
  });
});
