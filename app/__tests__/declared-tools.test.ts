import { declaredAgentTools } from '../src/declaredTools';
import type { Node } from '../src/types';

describe('declaredAgentTools', () => {
  it('collects the tools agent phases declare, nested ones included, once each', () => {
    const orch = {
      name: 'o',
      phases: [
        { name: 'a', agent: 'agents/a.md', tools: ['Read', 'Write'] },
        { name: 'g', phases: [{ name: 'b', agent: 'agents/b.md', tools: ['Bash', 'Read'] }] },
        { name: 'l', loop: { body: { name: 'c', agent: 'agents/c.md', tools: ['Grep'] }, maxIterations: 2 } },
      ],
    } as unknown as Node;
    expect(declaredAgentTools(orch)).toEqual(['Read', 'Write', 'Bash', 'Grep']);
  });

  it('is empty for a pipeline whose phases declare none, and for no pipeline', () => {
    expect(declaredAgentTools({ name: 'o', phases: [{ name: 'x', code: { source: '1' } }] } as unknown as Node)).toEqual([]);
    expect(declaredAgentTools(null)).toEqual([]);
  });
});
