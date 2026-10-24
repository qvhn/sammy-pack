/**
 * Unit tests for the shared resolution primitives (resolution.ts) — the module
 * BOTH the executor and the preview walker delegate to. These pin the behavior
 * the refactor must preserve (so the executor and preview can't drift), in
 * isolation from the executor's machinery.
 */

import {
  buildLookup,
  evalWhen,
  resolveTemplate,
  resolveAgentInput,
  resolveAgentPath,
  resolveCommand,
  selectSwitchCase,
} from '../src/llm/resolution';
import type { SwitchBody } from '../src/types';

describe('buildLookup — interpolation lookup shape', () => {
  test('state + scope + reserved input, later spreads win', () => {
    const lk = buildLookup({ a: '1', input: 'old' }, { item: 'x' }, 'new');
    expect(lk).toEqual({ a: '1', item: 'x', input: 'new' });
  });
  test('scope overrides state on key collision', () => {
    const lk = buildLookup({ k: 'state' }, { k: 'scope' }, '');
    expect(lk.k).toBe('scope');
  });
});

describe('resolveTemplate — single interpolation chokepoint', () => {
  test('resolves bound refs, calls onUnresolved for unbound', () => {
    const unresolved: string[] = [];
    const out = resolveTemplate('${a}/${b}', { a: 'A' }, r => unresolved.push(r));
    expect(out).toBe('A/${b}');
    expect(unresolved).toEqual(['b']);
  });
  test('dotted path into a JSON-encoded string value', () => {
    const out = resolveTemplate('${login.ready}', { login: '{"ready":true}' });
    expect(out).toBe('true');
  });
});

describe('evalWhen — when predicate (true = run)', () => {
  test('absent when always runs', () => {
    expect(evalWhen(undefined, {})).toBe(true);
  });
  test('truthy / falsy strings', () => {
    expect(evalWhen('${flag}', { flag: 'yes' })).toBe(true);
    expect(evalWhen('${flag}', { flag: 'false' })).toBe(false);
    expect(evalWhen('${flag}', { flag: '0' })).toBe(false);
    expect(evalWhen('${flag}', {})).toBe(true); // unresolved ${flag} → literal "${flag}" → truthy
  });
});

describe('selectSwitchCase — value + chosen case', () => {
  const sw: SwitchBody = {
    on: '${verdict}',
    cases: { pass: { name: 'p' }, fail: { name: 'f' } },
  };
  test('resolves on, selects exact case', () => {
    const sel = selectSwitchCase(sw, 'ignored-input', { verdict: 'pass' });
    expect(sel).toEqual({ value: 'pass', matched: 'pass' });
  });
  test('no match → matched null', () => {
    const sel = selectSwitchCase(sw, '', { verdict: 'other' });
    expect(sel.matched).toBeNull();
  });
  test('on unset → switches on the upstream input', () => {
    const noOn: SwitchBody = { cases: { x: { name: 'x' } } };
    expect(selectSwitchCase(noOn, 'x', {}).matched).toBe('x');
  });
  test('unresolved on ref surfaces via onUnresolved', () => {
    const unresolved: string[] = [];
    selectSwitchCase(sw, '', {}, r => unresolved.push(r));
    expect(unresolved).toEqual(['verdict']);
  });
});

describe('resolveAgentInput — prompt override or input, interpolated', () => {
  test('prompt override wins, interpolated', () => {
    const out = resolveAgentInput({ prompt: 'do ${x}' }, 'upstream', { x: 'it' });
    expect(out).toBe('do it');
  });
  test('no prompt → the (interpolated) upstream input', () => {
    const out = resolveAgentInput({}, 'echo ${x}', { x: 'Y' });
    expect(out).toBe('echo Y');
  });
});

describe('resolveAgentPath / resolveCommand — interpolated', () => {
  test('parameterized agent path', () => {
    expect(resolveAgentPath('agents/${c}-qa.md', { c: 'auth' })).toBe(
      'agents/auth-qa.md',
    );
  });
  test('literal path is a no-op', () => {
    expect(resolveAgentPath('agents/x.md', {})).toBe('agents/x.md');
  });
  test('command interpolates over state', () => {
    expect(resolveCommand('${dir}/build.sh ${env}', { dir: '/r', env: 'stg' })).toBe(
      '/r/build.sh stg',
    );
  });
});
