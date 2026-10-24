/**
 * Smoke + integration test for DatasetsPage. Mocks the /api/datasets
 * endpoint so the page renders empty + populated states without
 * hitting the network.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { DatasetsPage } from '../src/pages/DatasetsPage';

function mockFetch(responses: Record<string, unknown>) {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
    const key = Object.keys(responses).find(k => url.includes(k));
    if (!key) {
      return {
        ok: false,
        status: 404,
        statusText: 'not found',
        text: async (): Promise<string> => '',
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async (): Promise<unknown> => responses[key],
      text: async (): Promise<string> => JSON.stringify(responses[key]),
    };
  });
}

test('renders the empty state', async () => {
  mockFetch({ '/api/datasets': [] });
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<DatasetsPage />);
  });
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toMatch(/Datasets/);
  expect(text).toMatch(/\+ New dataset/);
});

test('renders a dataset from the list endpoint', async () => {
  mockFetch({
    '/api/datasets': [
      {
        name: 'fixtures',
        description: 'smoke',
        rows: [
          { id: 'r1', input: 'hello', expectedOutput: 'world', tags: ['train'] },
        ],
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  });
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<DatasetsPage />);
  });
  // Drain pending microtasks so the loaded list lands.
  await ReactTestRenderer.act(async () => {});
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toMatch(/fixtures/);
});
