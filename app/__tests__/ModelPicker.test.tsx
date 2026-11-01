/**
 * The model pickers: Default writes '', a listed model writes its id, Other
 * takes any id; each model shows its price per million tokens. The web build's
 * dropdown and the native build's chips share the props.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ModelPicker as WebPicker } from '../src/ModelPicker.web';
import { ModelPicker as NativePicker } from '../src/ModelPicker';

function renderWeb(value: string) {
  const onChange = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <WebPicker value={value} onChange={onChange} defaultModel="claude-sonnet-4-6" defaultSource="from Settings" />,
    );
  });
  const select = () => tree.root.findByType('select');
  const pick = (v: string) => ReactTestRenderer.act(() => select().props.onChange({ target: { value: v } }));
  const text = () =>
    tree.root
      .findAll(n => typeof n.type === 'string')
      .flatMap(n => n.children.filter((c): c is string => typeof c === 'string'))
      .join('');
  return { tree, onChange, select, pick, text };
}

describe('ModelPicker (web dropdown)', () => {
  it('lists Default (what it resolves to) and each model with its price; picking one writes its id', () => {
    const { select, pick, onChange, text } = renderWeb('');
    expect(select().props.value).toBe('__default');
    const options = select().findAllByType('option').map(o => [o.props.value, [o.props.children].flat().join('')]);
    expect(options[0]).toEqual(['__default', 'Default — Sonnet 4.6 (from Settings)']);
    expect(options).toContainEqual(['claude-opus-5-5', 'Opus 5.5 — $4 in / $20 out per 1M tokens']);
    expect(options).toContainEqual(['claude-haiku-5-5', 'Haiku 5.5 — $0.10 in / $0.50 out per 1M tokens']);
    expect(text()).toContain('Runs on claude-sonnet-4-6 · $3 in / $15 out per 1M tokens');
    pick('claude-opus-5-5');
    expect(onChange).toHaveBeenLastCalledWith('claude-opus-5-5');
  });

  it('an unlisted id shows under Other…, in a text field; Default clears it', () => {
    const { tree, select, pick, onChange } = renderWeb('claude-opus-4-1');
    expect(select().props.value).toBe('__other');
    expect(tree.root.findByType('input').props.value).toBe('claude-opus-4-1');
    pick('__default');
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

describe('ModelPicker (native)', () => {
  it('picks a listed model and shows the price of the model it runs on', () => {
    const onChange = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <NativePicker value="claude-haiku-4-5" onChange={onChange} defaultModel="claude-sonnet-4-6" defaultSource="from Settings" />,
      );
    });
    ReactTestRenderer.act(() => {
      tree.root.find(n => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === 'Opus 5.5').props.onPress();
    });
    expect(onChange).toHaveBeenLastCalledWith('claude-opus-5-5');
    expect(JSON.stringify(tree.toJSON())).toContain('$1 in / $5 out per 1M tokens');
  });
});
