/**
 * Small display helpers behind the pre-demo UI sweep: map `over` labels,
 * delivery reasons + empty-filter copy, trigger orchestration names and the
 * no-default test-trigger selection, and the SearchablePills selection
 * staying visible under a no-match filter.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TextInput } from 'react-native';
import { formatMapOver } from '../src/lib/mapOver';
import { deliveriesEmptyText, deliveryReason } from '../src/pages/DeliveriesPage';
import { displayOrchName, keepSelection } from '../src/pages/TriggersPage';
import { SearchablePills } from '../src/pages/SearchablePills';

test('formatMapOver wraps a bare expression once, never twice', () => {
  expect(formatMapOver('state.items')).toBe('${state.items}');
  expect(formatMapOver('${results}')).toBe('${results}');
  expect(formatMapOver('${a}-${b}')).toBe('${a}-${b}');
});

test('deliveryReason surfaces lastError and the intake detail', () => {
  expect(
    deliveryReason({
      lastError: 'concurrency: group busy, fire skipped by policy',
      detail: 'scrubbed: 2 value(s) redacted',
    }),
  ).toEqual({
    error: 'concurrency: group busy, fire skipped by policy',
    detail: 'scrubbed: 2 value(s) redacted',
  });
  expect(deliveryReason({ lastError: null, detail: '' })).toEqual({
    error: null,
    detail: null,
  });
});

test('an empty filter is not an empty queue', () => {
  expect(deliveriesEmptyText('failed', 7)).toBe('No deliveries match this filter.');
  expect(deliveriesEmptyText('all', 0)).toMatch(/^No deliveries yet/);
  expect(deliveriesEmptyText('failed', 0)).toMatch(/^No deliveries yet/);
});

test('displayOrchName prefers the declared name over a case-variant file key', () => {
  const known = ['template', 'intake-demo'];
  expect(displayOrchName('TEMPLATE', known)).toBe('template');
  expect(displayOrchName('intake-demo', known)).toBe('intake-demo');
  expect(displayOrchName('unknown', known)).toBe('unknown');
  // Ambiguous case-insensitive match → leave it as reported.
  expect(displayOrchName('Foo', ['foo', 'FOO'])).toBe('Foo');
});

test('the test-trigger target is never auto-picked', () => {
  expect(keepSelection('', ['a', 'b'])).toBe('');
  expect(keepSelection('b', ['a', 'b'])).toBe('b');
  expect(keepSelection('gone', ['a', 'b'])).toBe('');
});

test('SearchablePills keeps the selected pill visible under a no-match filter', () => {
  const options = Array.from({ length: 15 }, (_, i) => ({
    value: `orch-${i}`,
    label: `orch-${i}`,
  }));
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SearchablePills options={options} value="orch-3" onChange={() => {}} />,
    );
  });
  ReactTestRenderer.act(() => {
    tree.root.findByType(TextInput).props.onChangeText('zzz-no-match');
  });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toMatch(/orch-3/);
  expect(text).not.toMatch(/orch-4/);
  expect(text).toMatch(/No match for/);
});
