import { childNodesOf } from '../src/lib/node-walk';
import {
  acceptsChildren,
  addChildPhase,
  addOrPromoteChild,
  childNodes,
  deleteNodeByName,
  duplicateNode,
  findNodeByName,
  insertPhaseAfter,
  insertSiblingAfter,
  insertSiblingBefore,
  moveNode,
  uniqueName,
  updateNodeByName,
  wrapInComposite,
} from '../src/lib/orchestrationMutate';
import { collectNodeNames } from '../src/lib/runStatus';
import type { Node } from '../src/types';

const tree = (): Node => ({
  name: 'root',
  phases: [
    { name: 'a', agent: 'agents/a.md' },
    {
      name: 'grp',
      parallel: [
        { name: 'b', agent: 'agents/b.md' },
        { name: 'c', agent: 'agents/c.md' },
      ],
    },
    {
      name: 'lp',
      loop: { body: { name: 'lb', agent: 'agents/lb.md' }, maxIterations: 3 },
    },
    {
      name: 'rt',
      route: {
        branches: { x: { name: 'bx', agent: 'agents/bx.md' } },
        default: { name: 'bd', agent: 'agents/bd.md' },
      },
    },
  ],
});

describe('orchestrationMutate', () => {
  it('childNodes covers array/loop/map/route composites', () => {
    const t = tree();
    expect(childNodes(t).map(n => n.name)).toEqual(['a', 'grp', 'lp', 'rt']);
    expect(childNodes(t.phases![1]).map(n => n.name)).toEqual(['b', 'c']);
    expect(childNodes(t.phases![2]).map(n => n.name)).toEqual(['lb']);
    expect(childNodes(t.phases![3]).map(n => n.name).sort()).toEqual(['bd', 'bx']);
  });

  it('findNodeByName finds nested nodes', () => {
    expect(findNodeByName(tree(), 'c')?.agent).toBe('agents/c.md');
    expect(findNodeByName(tree(), 'lb')?.name).toBe('lb');
    expect(findNodeByName(tree(), 'bx')?.name).toBe('bx');
    expect(findNodeByName(tree(), 'nope')).toBeNull();
  });

  it('updateNodeByName replaces a nested node immutably', () => {
    const t = tree();
    const next = updateNodeByName(t, 'c', n => ({ ...n, agent: 'agents/c2.md' }));
    expect(findNodeByName(next, 'c')?.agent).toBe('agents/c2.md');
    expect(findNodeByName(t, 'c')?.agent).toBe('agents/c.md'); // original untouched
  });

  it('updateNodeByName can rename a nested node', () => {
    const next = updateNodeByName(tree(), 'b', n => ({ ...n, name: 'b-renamed' }));
    expect(findNodeByName(next, 'b')).toBeNull();
    expect(findNodeByName(next, 'b-renamed')?.agent).toBe('agents/b.md');
  });

  it('addChildPhase appends into array composites only', () => {
    const next = addChildPhase(tree(), 'grp', { name: 'd', agent: 'agents/d.md' });
    expect(childNodes(findNodeByName(next, 'grp')!).map(n => n.name)).toEqual([
      'b',
      'c',
      'd',
    ]);
    // loop is not an array composite — unchanged
    const lp = addChildPhase(tree(), 'lp', { name: 'z', agent: '' });
    expect(childNodes(findNodeByName(lp, 'lp')!).map(n => n.name)).toEqual(['lb']);
  });

  it('addOrPromoteChild appends into composites, promotes leaves', () => {
    // array composite → append
    const a = addOrPromoteChild(tree(), 'grp', { name: 'd', agent: 'agents/d.md' });
    expect(childNodes(findNodeByName(a, 'grp')!).map(n => n.name)).toEqual([
      'b',
      'c',
      'd',
    ]);
    // leaf → promote to a phases group; original kept as first child
    const p = addOrPromoteChild(tree(), 'a', { name: 'a-new', agent: 'agents/x.md' });
    const promoted = findNodeByName(p, 'a')!;
    expect(promoted.phases).toBeDefined();
    expect(childNodes(promoted).map(n => n.name)).toEqual(['a-1', 'a-new']);
    // the original agent is preserved on the first child
    expect(findNodeByName(p, 'a-1')?.agent).toBe('agents/a.md');
  });

  it('acceptsChildren only for array composites', () => {
    const t = tree();
    expect(acceptsChildren(t.phases![1])).toBe(true); // parallel
    expect(acceptsChildren(t.phases![2])).toBe(false); // loop
    expect(acceptsChildren(t.phases![0])).toBe(false); // leaf agent
  });

  it('deleteNodeByName removes nested children', () => {
    const next = deleteNodeByName(tree(), 'b');
    expect(childNodes(findNodeByName(next, 'grp')!).map(n => n.name)).toEqual(['c']);
    expect(findNodeByName(deleteNodeByName(tree(), 'a'), 'a')).toBeNull();
    // route branch deletion
    expect(findNodeByName(deleteNodeByName(tree(), 'bx'), 'bx')).toBeNull();
  });

  it('insertSiblingBefore/After splice within the containing array', () => {
    const after = insertSiblingAfter(tree(), 'b', { name: 'b2', agent: '' });
    expect(childNodes(findNodeByName(after, 'grp')!).map(n => n.name)).toEqual([
      'b',
      'b2',
      'c',
    ]);
    const before = insertSiblingBefore(tree(), 'c', { name: 'c0', agent: '' });
    expect(childNodes(findNodeByName(before, 'grp')!).map(n => n.name)).toEqual([
      'b',
      'c0',
      'c',
    ]);
  });

  it('uniqueName avoids collisions across the whole tree', () => {
    expect(uniqueName(tree(), 'fresh')).toBe('fresh');
    expect(uniqueName(tree(), 'a')).toBe('a-2');
    const t = tree();
    t.phases!.push({ name: 'a-2', agent: '' });
    expect(uniqueName(t, 'a')).toBe('a-3');
  });

  it('moveNode relocates a node into another array composite at an index', () => {
    const moved = moveNode(tree(), 'a', 'grp', 0);
    expect(findNodeByName(moved, 'root')!.phases!.map(n => n.name)).toEqual([
      'grp',
      'lp',
      'rt',
    ]);
    expect(childNodes(findNodeByName(moved, 'grp')!).map(n => n.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('moveNode no-ops into a non-array target, itself, or a descendant', () => {
    expect(moveNode(tree(), 'a', 'lp', 0)).toEqual(tree()); // loop isn't an array
    expect(moveNode(tree(), 'grp', 'grp', 0)).toEqual(tree()); // into itself
    expect(moveNode(tree(), 'grp', 'b', 0)).toEqual(tree()); // into its own descendant
  });

  it('duplicateNode deep-copies after the original with unique names', () => {
    const dup = duplicateNode(tree(), 'grp');
    expect(childNodes(findNodeByName(dup, 'root')!).map(n => n.name)).toEqual([
      'a',
      'grp',
      'grp-2',
      'lp',
      'rt',
    ]);
    expect(childNodes(findNodeByName(dup, 'grp-2')!).map(n => n.name)).toEqual([
      'b-2',
      'c-2',
    ]);
  });

  it('wrapInComposite wraps a node, keeping it as the child/body', () => {
    const wrapped = wrapInComposite(tree(), 'a', 'loop');
    expect(findNodeByName(wrapped, 'root')!.phases!.map(n => n.name)).toEqual([
      'a-loop',
      'grp',
      'lp',
      'rt',
    ]);
    const wrapper = findNodeByName(wrapped, 'a-loop')!;
    expect(wrapper.loop?.body?.name).toBe('a');
    expect(wrapper.loop?.maxIterations).toBe(3);
  });
});

/**
 * The child slots this module's walkers used to miss: `switch.cases` /
 * `switch.default`, `onError`, `onStall.recover`. The walkers kept their own
 * list of child paths (phases / parallel / converge / loop / map / route) and
 * it drifted from `childNodesOf`, the schema-parity-tested source of truth —
 * so a switch node rendered cases that could not be selected, renamed,
 * deleted or duplicated, and `duplicateNode` left duplicate names inside
 * them although the executor requires unique names.
 */
const switchTree = (): Node => ({
  name: 'root',
  phases: [
    { name: 'pick', agent: 'agents/p.md' },
    {
      name: 'sw',
      switch: {
        on: '${verdict}',
        cases: {
          yes: {
            name: 'cy',
            phases: [
              { name: 'cy1', agent: 'agents/y1.md' },
              { name: 'cy2', agent: 'agents/y2.md' },
            ],
          },
          no: { name: 'cn', agent: 'agents/n.md' },
        },
        default: { name: 'cd', agent: 'agents/d.md' },
      },
      onError: { name: 'oe', agent: 'agents/oe.md' },
      onStall: { recover: { name: 'os', code: { run: 'echo fix' } } },
    },
  ],
});

describe('orchestrationMutate reaches every child slot childNodesOf knows', () => {
  it('childNodes agrees with childNodesOf on a switch node with onError + onStall', () => {
    const sw = switchTree().phases![1];
    expect(childNodes(sw).map(n => n.name)).toEqual(
      childNodesOf(sw).map(n => n.name),
    );
    expect(childNodes(sw).map(n => n.name).sort()).toEqual(
      ['cd', 'cn', 'cy', 'oe', 'os'].sort(),
    );
  });

  it('finds and renames a node inside a switch case (the case key is kept)', () => {
    expect(findNodeByName(switchTree(), 'cy2')?.agent).toBe('agents/y2.md');
    expect(findNodeByName(switchTree(), 'os')?.code?.run).toBe('echo fix');
    const next = updateNodeByName(switchTree(), 'cn', n => ({ ...n, name: 'cn-renamed' }));
    expect(findNodeByName(next, 'cn')).toBeNull();
    expect(findNodeByName(next, 'sw')!.switch!.cases.no.name).toBe('cn-renamed');
  });

  it('deletes a switch case (its key goes), an onError and a node inside a case', () => {
    const noCase = deleteNodeByName(switchTree(), 'cn');
    expect(Object.keys(findNodeByName(noCase, 'sw')!.switch!.cases)).toEqual(['yes']);
    expect(findNodeByName(noCase, 'cd')).not.toBeNull(); // default untouched
    const noErr = deleteNodeByName(switchTree(), 'oe');
    expect(findNodeByName(noErr, 'sw')!.onError).toBeUndefined();
    expect(findNodeByName(noErr, 'os')).not.toBeNull();
    const inner = deleteNodeByName(switchTree(), 'cy1');
    expect(findNodeByName(inner, 'cy')!.phases!.map(n => n.name)).toEqual(['cy2']);
  });

  it('insertPhaseAfter lands inside a switch case instead of falling back to root', () => {
    const next = insertPhaseAfter(switchTree(), 'cy1', { name: 'NEW', agent: '' });
    expect(findNodeByName(next, 'cy')!.phases!.map(n => n.name)).toEqual([
      'cy1',
      'NEW',
      'cy2',
    ]);
    // Not the stale-selection fallback: root is untouched.
    expect(next.phases!.map(n => n.name)).toEqual(['pick', 'sw']);
    // The same through an onError subtree and insertSiblingAfter.
    const withErr: Node = {
      name: 'root',
      phases: [
        {
          name: 'work',
          agent: 'agents/w.md',
          onError: { name: 'fix', phases: [{ name: 'f1' }, { name: 'f2' }] },
        },
      ],
    };
    expect(
      findNodeByName(insertPhaseAfter(withErr, 'f1', { name: 'NEW' }), 'fix')!.phases!.map(n => n.name),
    ).toEqual(['f1', 'NEW', 'f2']);
    expect(
      findNodeByName(insertSiblingAfter(switchTree(), 'cy1', { name: 'NEW' }), 'cy')!.phases!.map(n => n.name),
    ).toEqual(['cy1', 'NEW', 'cy2']);
  });

  it('duplicateNode dedupes names inside switch cases, onError and onStall.recover', () => {
    const dup = duplicateNode(switchTree(), 'sw');
    const names = collectNodeNames(dup);
    // Unique everywhere — the executor requires it.
    expect(new Set(names).size).toBe(names.length);
    const copy = findNodeByName(dup, 'sw-2')!;
    expect(copy.switch!.cases.yes.name).toBe('cy-2');
    expect(copy.switch!.cases.yes.phases!.map(n => n.name)).toEqual(['cy1-2', 'cy2-2']);
    expect(copy.switch!.cases.no.name).toBe('cn-2');
    expect(copy.switch!.default!.name).toBe('cd-2');
    expect(copy.onError!.name).toBe('oe-2');
    expect(copy.onStall!.recover.name).toBe('os-2');
    // The original is intact.
    expect(findNodeByName(dup, 'sw')!.switch!.cases.yes.name).toBe('cy');
  });

  it('moveNode can target an array composite that lives inside a switch case', () => {
    const moved = moveNode(switchTree(), 'pick', 'cy', 0);
    expect(moved.phases!.map(n => n.name)).toEqual(['sw']);
    expect(findNodeByName(moved, 'cy')!.phases!.map(n => n.name)).toEqual([
      'pick',
      'cy1',
      'cy2',
    ]);
  });

  it('a no-op walk returns the same tree reference (nothing cloned for nothing)', () => {
    const t = switchTree();
    expect(deleteNodeByName(t, 'does-not-exist')).toBe(t);
    expect(updateNodeByName(t, 'does-not-exist', n => n)).toBe(t);
  });
});
