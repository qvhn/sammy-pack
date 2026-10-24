/**
 * Preview catches the real-world class of bug it exists for.
 *
 * The fixture __tests__/fixtures/footguns.json deliberately carries the three
 * foot-guns preview was built for:
 *   1. a DECORATIVE var (`appEnv`) referenced only in a description, never
 *      threaded into the build command — the "stage build that's really dev".
 *   2. an UNBOUND `${ref}` in a `code.run` command (`${buildFlags}`) — the
 *      literal-passthrough into a shell command.
 *   3. an UNBOUND `${ref}` in a `prompt` (`${releaseReport}`) — the
 *      literal-passthrough into an agent prompt (the QA-report bug).
 *
 * Preview must flag all three; the CLI must exit non-zero (error findings).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Node } from '../src/types';
import { previewOrchestration, planHasErrors } from '../src/llm/preview';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'footguns.json'), 'utf8'),
) as Node;

describe('preview flags all three foot-guns in the fixture', () => {
  const plan = previewOrchestration(fixture);
  const allFindings = [
    ...plan.findings,
    ...plan.phases.flatMap(p => [...p.findings, ...p.children.flatMap(c => c.findings)]),
  ];

  test('(1) decorative-var: appEnv appears only in a description', () => {
    const f = allFindings.find(x => x.code === 'decorative-var');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('appEnv');
  });

  test('(2) unbound-exec-ref in code.run: ${buildFlags} binds to nothing (error)', () => {
    const f = allFindings.find(
      x => x.code === 'unbound-exec-ref' && x.message.includes('buildFlags'),
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });

  test('(3) unbound-exec-ref in prompt: ${releaseReport} binds to nothing (error)', () => {
    const f = allFindings.find(
      x => x.code === 'unbound-exec-ref' && x.message.includes('releaseReport'),
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });

  test('the plan has errors → CLI would exit 1', () => {
    expect(planHasErrors(plan)).toBe(true);
    expect(plan.summary.errors).toBe(2);
    expect(plan.summary.warnings).toBeGreaterThanOrEqual(1);
  });

  test('the resolved build command shows the unbound ref symbolically, not silently', () => {
    const build = plan.phases.find(p => p.name === 'build')!;
    // ${repo} resolves; ${buildFlags} is shown as a symbolic placeholder so the
    // gap is visible in the command preview, not a stray literal.
    expect(build.action?.text).toContain('/work/repo/scripts/build-install.sh');
    expect(build.action?.text).toContain('«buildFlags');
  });
});
