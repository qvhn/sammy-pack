/**
 * Run dialog keyboard + validation behaviour: no "required" nag on open, it
 * appears on a run attempt; Enter in a single-line field runs a valid form;
 * Escape closes; a plain `text` input's placeholder names what it wants.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TextInput } from 'react-native';
import { RunInputsModal, runInputPlaceholder } from '../src/RunInputsModal';
import type { Node } from '../src/types';

const orch = {
  name: 'demo',
  inputs: [
    { name: 'repo', kind: 'text', required: true, description: 'a local path or URL' },
    { name: 'notes', kind: 'text' },
  ],
  phases: [],
} as unknown as Node;

const NAG = /Provide every required/;

function render(props: { onRun?: jest.Mock; onClose?: jest.Mock } = {}) {
  const onRun = props.onRun ?? jest.fn();
  const onClose = props.onClose ?? jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <RunInputsModal orchestration={orch} onClose={onClose} onRun={onRun} />,
    );
  });
  return { tree, onRun, onClose };
}

const text = (t: ReactTestRenderer.ReactTestRenderer) => JSON.stringify(t.toJSON());
const runButton = (t: ReactTestRenderer.ReactTestRenderer) =>
  t.root.findAll(
    n => n.props.accessibilityLabel === 'Run with inputs' && typeof n.props.onPress === 'function',
  )[0];

test('placeholder names the input instead of the bare kind', () => {
  expect(runInputPlaceholder({ name: 'repo', kind: 'text', description: 'a local path or URL' })).toBe(
    'a local path or URL',
  );
  // Only the first clause of a long description — the label shows the rest.
  expect(
    runInputPlaceholder({
      name: 'repo',
      kind: 'text',
      description: 'The repository: a local path, or its URL. The run works in its own worktree.',
    }),
  ).toBe('The repository');
  expect(runInputPlaceholder({ name: 'notes', kind: 'text' })).toBe('notes');
  expect(runInputPlaceholder({ name: 'u', kind: 'url' })).toBe('https://…');
});

test('the required-input hint waits for a run attempt', () => {
  const { tree, onRun } = render();
  expect(text(tree)).not.toMatch(NAG);
  ReactTestRenderer.act(() => runButton(tree).props.onPress());
  expect(text(tree)).toMatch(NAG);
  expect(onRun).not.toHaveBeenCalled();
});

test('leaving a required field empty also reveals the hint', () => {
  const { tree } = render();
  const [repo] = tree.root.findAllByType(TextInput);
  ReactTestRenderer.act(() => repo.props.onBlur());
  expect(text(tree)).toMatch(NAG);
});

test('Enter in a single-line field runs only when the form is valid', async () => {
  const { tree, onRun } = render();
  const [repo] = tree.root.findAllByType(TextInput);
  ReactTestRenderer.act(() => repo.props.onSubmitEditing());
  expect(onRun).not.toHaveBeenCalled();
  ReactTestRenderer.act(() => repo.props.onChangeText('/tmp/project'));
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0].props.onSubmitEditing();
  });
  expect(onRun).toHaveBeenCalledWith({ repo: { value: '/tmp/project' } }, '');
});

test('Escape closes the dialog', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const listeners: Array<(e: { key: string }) => void> = [];
  g.addEventListener = (_t: string, fn: (e: { key: string }) => void) => listeners.push(fn);
  g.removeEventListener = (_t: string, fn: (e: { key: string }) => void) => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  try {
    const { onClose } = render();
    listeners.forEach(l => l({ key: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
    listeners.forEach(l => l({ key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    delete g.addEventListener;
    delete g.removeEventListener;
  }
});
