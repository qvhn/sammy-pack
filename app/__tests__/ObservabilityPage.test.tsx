/**
 * Smoke test for ObservabilityPage. Mocks /api/observability and
 * verifies the digest renders top-line stats + per-orchestration rows.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ObservabilityPage, finishedSuccessRate } from '../src/pages/ObservabilityPage';

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

test('renders observability digest', async () => {
  mockFetch({
    '/api/observability': {
      totals: {
        runs: 12,
        done: 1,
        error: 9,
        cancelled: 2,
        inputTokens: 26,
        outputTokens: 4956,
        costUsd: 0.074,
      },
      perOrchestration: [
        {
          name: 'refinement-loop',
          runCount: 1,
          doneCount: 1,
          errorCount: 0,
          cancelledCount: 0,
          avgDurationMs: 21200,
          inputTokens: 6,
          outputTokens: 208,
          costUsd: 0.0031,
          lastRanAt: Date.now(),
        },
      ],
      daily: [],
      recent: [
        {
          id: 'run-x',
          orchestrationName: 'refinement-loop',
          status: 'done',
          startedAt: Date.now(),
          durationMs: 21200,
        },
      ],
    },
  });
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ObservabilityPage />);
  });
  await ReactTestRenderer.act(async () => {});
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toMatch(/Observability/);
  expect(text).toMatch(/refinement-loop/);
  // 12 total runs should land in some stat tile
  expect(text).toMatch(/12/);
});

test('success rate counts finished runs only (paused/running are not failures)', () => {
  // 1 done + 1 paused, 0 errors — used to read "50%" in red.
  expect(finishedSuccessRate({ runs: 2, done: 1, error: 0, cancelled: 0 })).toEqual({
    rate: 1,
    finished: 1,
    inFlight: 1,
  });
  // Cancels are neither successes nor failures.
  expect(finishedSuccessRate({ runs: 5, done: 3, error: 1, cancelled: 1 }).rate).toBe(0.75);
  // Nothing finished yet → no rate rather than 0%.
  expect(finishedSuccessRate({ runs: 1, done: 0, error: 0, cancelled: 0 }).rate).toBeNull();
});
