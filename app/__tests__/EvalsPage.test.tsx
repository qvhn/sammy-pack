/**
 * Smoke test for EvalsPage. Mocks listEvals + listOrchestrations +
 * listDatasets + listAgents so the page can render its empty state
 * without network calls.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { EvalsPage } from '../src/pages/EvalsPage';

function mockFetch(responses: Record<string, unknown>) {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
    const key = Object.keys(responses).find(k => url.includes(k));
    return {
      ok: !!key,
      status: key ? 200 : 404,
      statusText: 'OK',
      json: async () => responses[key ?? ''],
      text: async () => JSON.stringify(responses[key ?? '']),
    };
  });
}

test('renders empty state with creation hint', async () => {
  mockFetch({
    '/api/evals': [],
    '/api/orchestrations': [],
    '/api/datasets': [],
    '/api/agents': [],
  });
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EvalsPage />);
  });
  await ReactTestRenderer.act(async () => {});
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toMatch(/Evals/);
  expect(text).toMatch(/\+ New eval/);
});

test('renders a configured eval from the list endpoint', async () => {
  mockFetch({
    '/api/evals': [
      {
        name: 'smoke-eval',
        orchestrationName: 'refinement-loop',
        datasetName: 'fixtures',
        scorers: [{ type: 'exact' }],
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    '/api/orchestrations': [{ name: 'refinement-loop' }],
    '/api/datasets': [
      { name: 'fixtures', rows: [], createdAt: 0, updatedAt: 0 },
    ],
    '/api/agents': [],
  });
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EvalsPage />);
  });
  await ReactTestRenderer.act(async () => {});
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toMatch(/smoke-eval/);
});
