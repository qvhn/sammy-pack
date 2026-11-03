/**
 * A page that throws while rendering shows what broke instead of blanking the
 * whole app, and "Try again" renders it afresh.
 */
import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { PageErrorBoundary } from '../src/PageErrorBoundary';

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('rows is undefined');
  return <Text>page content</Text>;
}

const textOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(t => [t.props.children].flat().join('')).join(' | ');

describe('PageErrorBoundary', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('shows the error in place of the page, and Try again re-renders it', () => {
    shouldThrow = true;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <PageErrorBoundary page="runs">
          <Flaky />
        </PageErrorBoundary>,
      );
    });
    expect(textOf(tree)).toContain('This page hit an error');
    expect(textOf(tree)).toContain('rows is undefined');

    shouldThrow = false;
    const tryAgain = tree.root.findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
    ReactTestRenderer.act(() => tryAgain.props.onPress());
    expect(textOf(tree)).toBe('page content');
  });
});
