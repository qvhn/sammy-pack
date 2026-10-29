/** The editor's "Runs as" control writes execution / harness.follow, and removes them when back at the default. */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { RunsAsHead } from '../src/RunsAsHead';
import type { Node } from '../src/types';

function render(orchestration: Node) {
  const onChange = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<RunsAsHead orchestration={orchestration} onChange={onChange} />);
  });
  const press = (label: string) =>
    ReactTestRenderer.act(() => {
      tree.root.find(n => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === label).props.onPress();
    });
  return { tree, onChange, press };
}

describe('RunsAsHead', () => {
  it('Harness sets execution; Pipeline removes it', () => {
    const { onChange, press } = render({ name: 'o', phases: [] });
    press('Harness');
    expect(onChange).toHaveBeenLastCalledWith({ name: 'o', phases: [], execution: 'harness' });
    const second = render({ name: 'o', phases: [], execution: 'harness' });
    second.press('Pipeline');
    expect(second.onChange).toHaveBeenLastCalledWith({ name: 'o', phases: [] });
  });

  it('strictness writes harness.follow; Settings default removes it and keeps other harness settings', () => {
    const { onChange, press } = render({ name: 'o', phases: [], execution: 'harness', harness: { lockFollow: true } });
    press('Advisory');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ harness: { lockFollow: true, follow: 'advisory' } }));
    const bare = render({ name: 'o', phases: [], execution: 'harness', harness: { follow: 'loose' } });
    bare.press('Settings default');
    expect(bare.onChange.mock.calls[0][0]).not.toHaveProperty('harness');
  });

  it('a pipeline shows no strictness choice', () => {
    const { tree } = render({ name: 'o', phases: [] });
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'How strictly')).toHaveLength(0);
  });
});
