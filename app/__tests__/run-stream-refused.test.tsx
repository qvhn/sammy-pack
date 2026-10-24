/**
 * A refused run event stream is a visible error, not a run frozen as
 * 'running'.
 *
 * An EventSource cannot see HTTP status: a 401 (gated reads, no token) or a
 * 404 (a run this identity cannot see) arrives only as `onerror` with the
 * socket CLOSED and no event ever delivered. The run store's handler treated
 * every `onerror` as "the server closed the stream" and reported the last
 * status seen — 'running' — so the card sat there running forever with
 * nothing said. Now the store re-asks for the run through the
 * header-carrying fetch path, relays the server's status + text as
 * `lastError`, and ends the run locally as an error.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { RunsProvider, useRuns } from '../src/store/runs';
import type { Node } from '../src/types';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const REFUSAL = 'A bearer token is required for reads (SAMMY_REQUIRE_AUTH_READS=1)';

function mockFetch() {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const method = init?.method ?? 'GET';
      const reply = (status: number, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 401 ? 'Unauthorized' : 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      if (method === 'POST' && path === '/api/runs/start') return reply(200, { id: 'r1' });
      if (method === 'GET' && path === '/api/runs') return reply(200, []);
      if (method === 'GET' && path === '/api/runs/r1/summary') {
        return reply(401, { error: REFUSAL });
      }
      return reply(200, {});
    },
  );
}

type Ctx = ReturnType<typeof useRuns>;

function Probe({ onCtx }: { onCtx: (c: Ctx) => void }) {
  onCtx(useRuns());
  return null;
}

const g = globalThis as { localStorage?: unknown; fetch?: unknown; EventSource?: unknown };
let prev: { localStorage: unknown; fetch: unknown; EventSource: unknown };

beforeEach(() => {
  prev = { localStorage: g.localStorage, fetch: g.fetch, EventSource: g.EventSource };
  FakeEventSource.instances = [];
  g.EventSource = FakeEventSource;
  // Server-owned runs need the proxy auth mode.
  g.localStorage = {
    getItem: (k: string) => (k === 'sammy.authMode' ? 'claude-code-proxy' : null),
    setItem: () => {},
    removeItem: () => {},
  };
  mockFetch();
});

afterEach(() => {
  g.localStorage = prev.localStorage;
  g.fetch = prev.fetch;
  g.EventSource = prev.EventSource;
});

test('a stream refused before any event surfaces the server text and ends the run as an error', async () => {
  let ctx: Ctx | null = null;
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RunsProvider>
        <Probe onCtx={c => (ctx = c)} />
      </RunsProvider>,
    );
  });

  await ReactTestRenderer.act(async () => {
    expect(ctx!.startServerRun({ name: 'orch' } as Node)).toBe(true);
  });
  // POST /api/runs/start resolved → the EventSource is attached.
  await ReactTestRenderer.act(async () => {});
  expect(FakeEventSource.instances).toHaveLength(1);
  const es = FakeEventSource.instances[0];
  expect(es.url).toBe('/api/runs/r1/events');
  expect(ctx!.active?.status).toBe('running');

  // What a 401 looks like from inside the browser: the connection fails
  // for good, nothing was ever delivered.
  es.readyState = FakeEventSource.CLOSED;
  await ReactTestRenderer.act(async () => {
    es.onerror?.();
  });
  await ReactTestRenderer.act(async () => {});

  expect(ctx!.lastError).toContain('401');
  expect(ctx!.lastError).toContain(REFUSAL);
  expect(ctx!.lastError).toMatch(/Settings → User identity/);
  // Not parked as 'running': the active slot is cleared and the run is in
  // history as an error.
  expect(ctx!.active).toBeNull();
  expect(ctx!.history[0]?.id).toBe('r1');
  expect(ctx!.history[0]?.status).toBe('error');
  await ReactTestRenderer.act(async () => {
    tree!.unmount();
  });
});
