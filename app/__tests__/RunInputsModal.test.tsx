/**
 * The Run dialog as a prompt box: one prompt (Enter runs, Shift+Enter is a
 * new line), attached files, the repo the run works in (remembered per
 * pipeline, picked up from the prompt, changed by hand), Pipeline / Harness,
 * and what it says when something required is missing.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TextInput } from 'react-native';
import { RunInputsModal, detectRepo, runInputPlaceholder } from '../src/RunInputsModal';
import type { Node } from '../src/types';

let mockAllowAgentTools = false;
jest.mock('../src/store/apiKey', () => ({
  ...jest.requireActual('../src/store/apiKey'),
  getAllowAgentTools: () => mockAllowAgentTools,
}));

// A ticket-to-PR shape: a required ticket, and a repo the worktree reads.
const ship = {
  name: 'ship',
  inputs: [
    { name: 'ticket', kind: 'jira', required: true },
    { name: 'repo', kind: 'text', required: true },
  ],
  worktrees: [{ name: 'repo', repo: '${repo}' }],
  phases: [],
} as unknown as Node;
const plain = { name: 'plain', phases: [] } as unknown as Node;

const store = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
let savedStorage: unknown;
beforeEach(() => {
  store.clear();
  savedStorage = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
});
afterEach(() => {
  g.localStorage = savedStorage;
  mockAllowAgentTools = false;
});

function open(o: Node, props: { defaultInstructions?: string; error?: string | null } = {}) {
  const onRun = jest.fn();
  const onClose = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <RunInputsModal orchestration={o} onClose={onClose} onRun={onRun} {...props} />,
    );
  });
  return { tree, onRun, onClose };
}

const text = (t: ReactTestRenderer.ReactTestRenderer) => JSON.stringify(t.toJSON());
const byLabel = (t: ReactTestRenderer.ReactTestRenderer, label: string) =>
  t.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const press = (t: ReactTestRenderer.ReactTestRenderer, label: string) =>
  ReactTestRenderer.act(() => byLabel(t, label)[0].props.onPress());
const prompt = (t: ReactTestRenderer.ReactTestRenderer) =>
  t.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === 'Prompt')!;
const type = (t: ReactTestRenderer.ReactTestRenderer, value: string) =>
  ReactTestRenderer.act(() => prompt(t).props.onChangeText(value));
const run = async (t: ReactTestRenderer.ReactTestRenderer) =>
  ReactTestRenderer.act(async () => byLabel(t, 'Run with inputs')[0].props.onPress());
const key = async (t: ReactTestRenderer.ReactTestRenderer, k: string, shiftKey = false) => {
  const preventDefault = jest.fn();
  await ReactTestRenderer.act(async () => prompt(t).props.onKeyPress({ nativeEvent: { key: k, shiftKey }, preventDefault }));
  return preventDefault;
};

describe('the prompt', () => {
  test('is the whole input: no field per declared input', () => {
    const { tree } = open(ship);
    // Just the prompt (the repo starts empty, so its field shows too).
    const fields = tree.root.findAllByType(TextInput).map(n => n.props.accessibilityLabel);
    expect(fields).toEqual(['Prompt', 'Repo path or URL']);
    expect(text(tree)).not.toMatch(/ticket \* · jira/);
  });

  test('Enter runs, Shift+Enter does not', async () => {
    const { tree, onRun } = open(plain);
    type(tree, 'summarize the release notes');
    const shifted = await key(tree, 'Enter', true);
    expect(shifted).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
    const plainEnter = await key(tree, 'Enter');
    expect(plainEnter).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledWith({}, 'summarize the release notes', { prompt: true });
  });

  test('a pipeline with no inputs runs with an empty prompt', async () => {
    const { tree, onRun } = open(plain);
    await run(tree);
    expect(onRun).toHaveBeenCalledWith({}, '', { prompt: true });
  });

  test('says what is missing only after a run attempt', async () => {
    const { tree, onRun } = open(ship);
    expect(text(tree)).not.toMatch(/To run,/);
    await run(tree);
    expect(text(tree)).toMatch(/To run, say what to work on and choose the repo it works in\./);
    expect(onRun).not.toHaveBeenCalled();
  });

  test('replay pre-fills the prompt', () => {
    const { tree } = open(plain, { defaultInstructions: 'look at PROJ-12' });
    expect(prompt(tree).props.value).toBe('look at PROJ-12');
  });
});

describe('the repo', () => {
  test('a repo named in the prompt is picked up, and runs with it', async () => {
    const { tree, onRun } = open(ship);
    type(tree, 'Fix the login redirect in ~/git/web please');
    expect(text(tree)).toContain('from your message');
    expect(text(tree)).toContain('~/git/web');
    await run(tree);
    expect(onRun).toHaveBeenCalledWith({}, 'Fix the login redirect in ~/git/web please', {
      prompt: true,
      repo: '~/git/web',
    });
  });

  test('removing it from the prompt drops it again; a repo picked by hand stays', () => {
    const { tree } = open(ship);
    type(tree, 'work in ~/git/web');
    type(tree, 'work in the web app');
    expect(text(tree)).not.toContain('~/git/web');
    ReactTestRenderer.act(() =>
      tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === 'Repo path or URL')!.props.onChangeText('/srv/api'),
    );
    type(tree, 'work in ~/git/web');
    expect(text(tree)).toContain('/srv/api');
  });

  test('the next run opens on the last repo this pipeline used, as a chip', async () => {
    const first = open(ship);
    type(first.tree, 'T-1 in ~/git/web');
    await run(first.tree);
    const next = open(ship);
    expect(text(next.tree)).toContain('last used');
    expect(next.tree.root.findAllByType(TextInput).map(n => n.props.accessibilityLabel)).toEqual(['Prompt']);
    type(next.tree, 'T-2');
    await run(next.tree);
    expect(next.onRun).toHaveBeenCalledWith({}, 'T-2', { prompt: true, repo: '~/git/web' });
  });

  test('Change offers the field and recent repos; picking one is kept', async () => {
    const a = open(ship);
    type(a.tree, 'one in ~/git/api');
    await run(a.tree);
    const b = open(ship);
    type(b.tree, 'two in ~/git/web');
    await run(b.tree);
    const { tree, onRun } = open(ship);
    press(tree, 'Change the repo');
    expect(byLabel(tree, 'Use ~/git/web')).toHaveLength(0); // already in the field
    press(tree, 'Use ~/git/api');
    type(tree, 'three');
    await run(tree);
    expect(onRun).toHaveBeenCalledWith({}, 'three', { prompt: true, repo: '~/git/api' });
  });

  test('is optional for a pipeline that declares no worktrees', async () => {
    const { tree, onRun } = open(plain);
    expect(text(tree)).toMatch(/without one the run works in an empty folder/);
    type(tree, 'tidy the README in ~/git/docs');
    await run(tree);
    expect(onRun).toHaveBeenCalledWith({}, 'tidy the README in ~/git/docs', { prompt: true, repo: '~/git/docs' });
  });

  test('is not asked for when the worktrees name their own repos', () => {
    const fixed = { ...plain, worktrees: [{ name: 'app', repo: '../app' }] } as unknown as Node;
    expect(open(fixed).tree.root.findAllByType(TextInput).map(n => n.props.accessibilityLabel)).toEqual(['Prompt']);
  });

  test('without storage the dialog still works', async () => {
    g.localStorage = undefined;
    const { tree, onRun } = open(ship);
    type(tree, 'T-1 in ~/git/web');
    await run(tree);
    expect(onRun).toHaveBeenCalledWith({}, 'T-1 in ~/git/web', { prompt: true, repo: '~/git/web' });
  });
});

describe('detectRepo', () => {
  test.each([
    ['fix it in ~/git/web', '~/git/web'],
    ['fix it in ~/git/web/.', '~/git/web'],
    ['see /Users/me/code/api for the service', '/Users/me/code/api'],
    ['repo: https://github.com/acme/web.git', 'https://github.com/acme/web'],
    ['https://github.com/acme/web/ has the bug', 'https://github.com/acme/web'],
    ['use git@github.com:acme/web.git', 'git@github.com:acme/web.git'],
    ['https://github.com/acme/web/issues/42', 'https://github.com/acme/web'],
    ['C:\\work\\web is the repo', 'C:\\work\\web'],
  ])('%s → %s', (input, repo) => {
    expect(detectRepo(input)).toBe(repo);
  });

  test.each([['the /login page redirects twice'], ['PROJ-123'], ['https://example.com/docs/page'], ['']])(
    'nothing in %p',
    input => {
      expect(detectRepo(input)).toBeUndefined();
    },
  );

  test('a repo the prompt names wins over the repo of an issue it links', () => {
    expect(detectRepo('https://github.com/acme/tracker/issues/9 — the code is in ~/git/web')).toBe('~/git/web');
  });
});

describe('how to run', () => {
  const pressRadio = (t: ReactTestRenderer.ReactTestRenderer, label: string) =>
    ReactTestRenderer.act(() =>
      t.root
        .findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]
        .props.onPress(),
    );

  test('Harness sends execution, and strictness only once the user picks one', async () => {
    const { tree, onRun } = open(plain);
    expect(text(tree)).not.toMatch(/How strictly/);
    pressRadio(tree, 'Harness');
    expect(text(tree)).toMatch(/How strictly/);
    await run(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { prompt: true, execution: 'harness' });
    pressRadio(tree, 'Loose order');
    await run(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { prompt: true, execution: 'harness', follow: 'loose' });
  });

  test('an orchestration that is already a harness needs no execution override', async () => {
    const { tree, onRun } = open({ ...plain, execution: 'harness', harness: { follow: 'loose' } } as Node);
    expect(text(tree)).toMatch(/Set by this orchestration/);
    await run(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { prompt: true });
    pressRadio(tree, 'Pipeline');
    await run(tree);
    expect(onRun).toHaveBeenLastCalledWith({}, '', { prompt: true, execution: 'pipeline' });
  });

  test('a locked orchestration only offers stricter choices', () => {
    const { tree } = open({ ...plain, execution: 'harness', harness: { follow: 'loose', lockFollow: true } } as Node);
    const pill = (label: string) =>
      tree.root.findAll(n => n.props.accessibilityLabel === label && n.props.accessibilityRole === 'radio')[0];
    expect(pill('Advisory').props.accessibilityState).toMatchObject({ disabled: true });
    expect(pill('Strict order').props.accessibilityState).toMatchObject({ disabled: false });
  });
});

test('Escape closes the dialog', () => {
  const gl = globalThis as unknown as Record<string, unknown>;
  const listeners: Array<(e: { key: string }) => void> = [];
  gl.addEventListener = (_t: string, fn: (e: { key: string }) => void) => listeners.push(fn);
  gl.removeEventListener = (_t: string, fn: (e: { key: string }) => void) => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  try {
    const { onClose } = open(plain);
    listeners.forEach(l => l({ key: 'Enter' }));
    expect(onClose).not.toHaveBeenCalled();
    listeners.forEach(l => l({ key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    delete gl.addEventListener;
    delete gl.removeEventListener;
  }
});

describe('what else the dialog says', () => {
  const withTools = {
    name: 'tooled',
    phases: [{ name: 'write', agent: 'agents/w.md', tools: ['Read', 'Bash'] }],
  } as unknown as Node;

  test('warns when agents declare tools but exposing them is off', () => {
    expect(text(open(withTools).tree)).toMatch(/declare tools \(Read, Bash\)/);
    mockAllowAgentTools = true;
    expect(text(open(withTools).tree)).not.toMatch(/declare tools/);
  });

  test('shows why the last ▶ Run did not start', () => {
    expect(text(open(plain, { error: 'Server-owned runs require Claude Code login mode.' }).tree)).toMatch(
      /require Claude Code login mode/,
    );
  });
});

test('placeholder names the input instead of the bare kind', () => {
  expect(runInputPlaceholder({ name: 'repo', kind: 'text', description: 'a local path or URL' })).toBe(
    'a local path or URL',
  );
  expect(runInputPlaceholder({ name: 'notes', kind: 'text' })).toBe('notes');
});

test('typing a repo keeps the field open until Enter', () => {
  const { tree } = open(plain);
  const field = () => tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === 'Repo path or URL');
  ReactTestRenderer.act(() => field()!.props.onChangeText('/'));
  ReactTestRenderer.act(() => field()!.props.onChangeText('/srv'));
  expect(field()).toBeDefined();
  ReactTestRenderer.act(() => field()!.props.onSubmitEditing());
  expect(field()).toBeUndefined();
  expect(text(tree)).toContain('/srv');
});
