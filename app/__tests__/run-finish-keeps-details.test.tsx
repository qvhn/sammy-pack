/**
 * A run that finishes in this tab keeps its details on the Result card.
 *
 * The tab merges streamed text deltas, so it holds fewer events than the
 * server counts. The first poll after the finish therefore swaps the tab's
 * copy for the server's event-less summary, and the card asks the store to
 * load the full run. That request read a copy of the history one render
 * old — the one still holding the streamed events — took the run as already
 * loaded and fetched nothing: the card fell back to a bare "Finished" with
 * no branch, steps or output, for good.
 */

import React, { useEffect } from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { RunsProvider, useRuns } from '../src/store/runs';
import type { Node } from '../src/types';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const SERVER_EVENTS = [
  { type: 'run-start', ts: 1 },
  { type: 'phase-start', phaseName: 'plan', ts: 2 },
  { type: 'phase-delta', phaseName: 'plan', text: 'a', ts: 3 },
  { type: 'phase-delta', phaseName: 'plan', text: 'b', ts: 4 },
  { type: 'phase-end', phaseName: 'plan', output: 'ab', ts: 5 },
  { type: 'run-end', status: 'done', ts: 6 },
];
const SUMMARY = {
  id: 'r1',
  orchestrationName: 'orch',
  startedAt: 1,
  endedAt: 6,
  status: 'done',
  eventVersion: SERVER_EVENTS.length,
};

const fetched: string[] = [];
let finished = false;

function mockFetch() {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const method = init?.method ?? 'GET';
    fetched.push(`${method} ${path}`);
    const reply = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method === 'POST' && path === '/api/runs/start') return reply({ id: 'r1' });
    if (method === 'GET' && path === '/api/runs') return reply(finished ? [SUMMARY] : []);
    if (method === 'GET' && path === '/api/runs/r1') return reply({ ...SUMMARY, events: SERVER_EVENTS });
    return reply({});
  });
}

type Ctx = ReturnType<typeof useRuns>;

/** What the Result card does: load a settled run that arrived without events. */
function Card({ onCtx }: { onCtx: (c: Ctx) => void }) {
  const ctx = useRuns();
  onCtx(ctx);
  const run = ctx.active ?? ctx.history.find(r => r.orchestrationName === 'orch') ?? null;
  const runId = run?.id ?? null;
  const needsEvents = !!run && run.events.length === 0 && run.status !== 'running';
  useEffect(() => {
    if (runId && needsEvents) ctx.hydrateRun(runId);
  }, [runId, needsEvents, ctx]);
  return null;
}

const g = globalThis as { localStorage?: unknown; fetch?: unknown; EventSource?: unknown };
let prev: { localStorage: unknown; fetch: unknown; EventSource: unknown };

beforeEach(() => {
  jest.useFakeTimers();
  prev = { localStorage: g.localStorage, fetch: g.fetch, EventSource: g.EventSource };
  FakeEventSource.instances = [];
  fetched.length = 0;
  finished = false;
  g.EventSource = FakeEventSource;
  g.localStorage = {
    getItem: (k: string) => (k === 'sammy.authMode' ? 'claude-code-proxy' : null),
    setItem: () => {},
    removeItem: () => {},
  };
  mockFetch();
});

afterEach(() => {
  jest.useRealTimers();
  g.localStorage = prev.localStorage;
  g.fetch = prev.fetch;
  g.EventSource = prev.EventSource;
});

test('the finished run is loaded in full after the poll swaps in its summary', async () => {
  let ctx: Ctx | null = null;
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RunsProvider>
        <Card onCtx={c => (ctx = c)} />
      </RunsProvider>,
    );
  });
  await ReactTestRenderer.act(async () => {
    ctx!.startServerRun({ name: 'orch' } as Node);
  });
  await ReactTestRenderer.act(async () => {});
  const es = FakeEventSource.instances[0];
  await ReactTestRenderer.act(async () => {
    for (const e of SERVER_EVENTS) es.onmessage?.({ data: JSON.stringify(e) });
  });
  finished = true;
  // The run is in history with the streamed events (deltas merged: fewer
  // than the server's count).
  expect(ctx!.active).toBeNull();
  expect(ctx!.history[0].events.length).toBeLessThan(SERVER_EVENTS.length);

  // The next poll lists the server's summary; then let everything settle.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(4000);
  });
  for (let i = 0; i < 5; i++) await ReactTestRenderer.act(async () => {});

  expect(fetched).toContain('GET /api/runs/r1');
  expect(ctx!.history[0].events).toHaveLength(SERVER_EVENTS.length);

  // And it stays loaded across later polls.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(4000);
  });
  for (let i = 0; i < 5; i++) await ReactTestRenderer.act(async () => {});
  expect(ctx!.history[0].events).toHaveLength(SERVER_EVENTS.length);
  await ReactTestRenderer.act(async () => {
    tree!.unmount();
  });
});
