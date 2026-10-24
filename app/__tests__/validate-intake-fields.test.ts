import { validateOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const issues = (n: Record<string, unknown>) =>
  validateOrchestration(n as unknown as Node).map(e => `${e.severity}: ${e.message}`);

describe('validator: intake-era fields', () => {
  it('warns when code.cwd is built from the run input', () => {
    const out = issues({ name: 'o', phases: [{ name: 'p', code: { run: 'ls', cwd: '${input.dir}' } }] });
    expect(out.join('\n')).toMatch(/warning: code.cwd is built from the run input/);
    expect(issues({ name: 'o', phases: [{ name: 'p', code: { run: 'ls', cwd: '${worktrees.a.path}/x' } }] })).toEqual([]);
  });

  it('flags code.cwd / code.artifact without run', () => {
    const out = issues({ name: 'o', phases: [{ name: 'p', code: { source: 'return 1', cwd: '/x', artifact: 'a' } }] });
    expect(out.join('\n')).toMatch(/code.cwd sets where a command runs/);
    expect(out.join('\n')).toMatch(/code.artifact captures a command log/);
  });

  it('rejects bad limits, worktrees and http blocks; warns on child-level root fields', () => {
    const out = issues({
      name: 'o',
      limits: { maxRunsPerDay: -1 },
      worktrees: [{ name: '1bad', repo: '' }],
      phases: [
        { name: 'h', http: { url: 'https://x/', auth: { basic: { username: 'u' } } } },
        { name: 'c', limits: { maxRunsPerDay: 1 }, code: { source: 'return 1' } },
      ],
    }).join('\n');
    expect(out).toMatch(/error: limits.maxRunsPerDay must be a non-negative integer/);
    expect(out).toMatch(/error: worktrees\[0\].name must start with a letter/);
    expect(out).toMatch(/error: http.auth must be/);
    expect(out).toMatch(/warning: limits is read only off the orchestration root/);
  });
});
