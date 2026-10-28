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

let mockAllowAgentTools = false;
jest.mock('../src/store/apiKey', () => ({
  ...jest.requireActual('../src/store/apiKey'),
  getAllowAgentTools: () => mockAllowAgentTools,
}));

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
  // Run as the orchestration says: no execution or strictness override.
  expect(onRun).toHaveBeenCalledWith({ repo: { value: '/tmp/project' } }, '', {});
});

describe('how to run', () => {
  const plain = { name: 'plain', phases: [] } as unknown as Node;
  const pressLabel = (t: ReactTestRenderer.ReactTestRenderer, label: string) =>
    ReactTestRenderer.act(() =>
      t.root
        .findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]
        .props.onPress(),
    );
  async function renderFor(o: Node) {
    const onRun = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<RunInputsModal orchestration={o} onClose={jest.fn()} onRun={onRun} />);
    });
    return { tree, onRun };
  }
  const submit = async (t: ReactTestRenderer.ReactTestRenderer) =>
    ReactTestRenderer.act(async () => runButton(t).props.onPress());

  test('Harness sends execution, and strictness only once the user picks one', async () => {
    const { tree, onRun } = await renderFor(plain);
    expect(text(tree)).not.toMatch(/How strictly/);
    pressLabel(tree, 'Harness');
    expect(text(tree)).toMatch(/How strictly/);
    expect(text(tree)).toMatch(/Set by the default/);
    await submit(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { execution: 'harness' });
    pressLabel(tree, 'Loose order');
    await submit(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { execution: 'harness', follow: 'loose' });
  });

  test('an orchestration that is already a harness needs no execution override', async () => {
    const { tree, onRun } = await renderFor({ ...plain, execution: 'harness', harness: { follow: 'loose' } } as Node);
    expect(text(tree)).toMatch(/Set by this orchestration/);
    await submit(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', {});
    pressLabel(tree, 'Pipeline');
    await submit(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { execution: 'pipeline' });
  });

  test('a locked orchestration only offers stricter choices', async () => {
    const { tree } = await renderFor({
      ...plain,
      execution: 'harness',
      harness: { follow: 'loose', lockFollow: true },
    } as Node);
    const pill = (label: string) =>
      tree.root.findAll(n => n.props.accessibilityLabel === label && n.props.accessibilityRole === 'radio')[0];
    expect(pill('Advisory').props.accessibilityState).toMatchObject({ disabled: true });
    expect(pill('Strict order').props.accessibilityState).toMatchObject({ disabled: false });
    expect(text(tree)).toMatch(/locked at Loose order or stricter/);
  });
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

describe('what the dialog says before and after ▶ Run', () => {
  const withTools = {
    name: 'tooled',
    phases: [
      { name: 'plan', code: { source: 'return 1' } },
      { name: 'grp', phases: [{ name: 'write', agent: 'agents/w.md', tools: ['Read', 'Bash'] }] },
    ],
  } as unknown as Node;
  const renderWith = (o: Node, error?: string | null) => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <RunInputsModal orchestration={o} onClose={jest.fn()} onRun={jest.fn()} error={error} />,
      );
    });
    return tree;
  };
  afterEach(() => {
    mockAllowAgentTools = false;
  });

  test('warns when agents declare tools but exposing them is off (they would run without them)', () => {
    mockAllowAgentTools = false;
    const t = text(renderWith(withTools));
    expect(t).toMatch(/declare tools \(Read, Bash\)/);
    expect(t).toMatch(/Settings → Agent tools/);
  });

  test('says nothing about tools when exposing them is on, or when none are declared', () => {
    mockAllowAgentTools = true;
    expect(text(renderWith(withTools))).not.toMatch(/declare tools/);
    mockAllowAgentTools = false;
    expect(text(renderWith(orch))).not.toMatch(/declare tools/);
  });

  test('shows why the last ▶ Run did not start', () => {
    expect(text(renderWith(orch, 'Server-owned runs require Claude Code login mode.'))).toMatch(
      /require Claude Code login mode/,
    );
    expect(text(renderWith(orch, null))).not.toMatch(/login mode/);
  });
});
