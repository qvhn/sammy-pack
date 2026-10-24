/**
 * The UI's SSE URL carries the same identity + token the fetch wrapper sends.
 *
 * An EventSource cannot send headers, so the run store's one `new
 * EventSource(...)` used to open the bare `/api/runs/:id/events` — which the
 * server resolved as owner `system`, so a run started under any other
 * identity (Settings → User identity) streamed nothing and the Stop button
 * 404'd. The URL builder appends `?owner=` / `?token=` from the SAME
 * localStorage keys `web/api-auth.ts` reads for the headers.
 */

import { serverRunEventsUrl } from '../src/store/runs';

type Store = Record<string, string | null>;

function withLocalStorage<T>(values: Store | 'throw', fn: () => T): T {
  const g = globalThis as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage =
    values === 'throw'
      ? {
          getItem: () => {
            throw new Error('SecurityError');
          },
        }
      : { getItem: (k: string) => values[k] ?? null };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  }
}

describe('serverRunEventsUrl', () => {
  it('is the bare path for the single-user default (nothing stored)', () => {
    expect(withLocalStorage({}, () => serverRunEventsUrl('run-1'))).toBe(
      '/api/runs/run-1/events',
    );
  });

  it('appends the stored user id as ?owner= (the X-Sammy-User twin)', () => {
    expect(
      withLocalStorage({ 'sammy.userId': 'alice' }, () =>
        serverRunEventsUrl('run-1'),
      ),
    ).toBe('/api/runs/run-1/events?owner=alice');
  });

  it('appends the stored bearer as ?token= (the Authorization twin)', () => {
    expect(
      withLocalStorage(
        { 'sammy.userId': 'alice', 'sammy.apiToken': 'secret-123' },
        () => serverRunEventsUrl('run-1'),
      ),
    ).toBe('/api/runs/run-1/events?owner=alice&token=secret-123');
  });

  it('encodes the run id and the values', () => {
    expect(
      withLocalStorage({ 'sammy.userId': 'team a/b' }, () =>
        serverRunEventsUrl('r 1'),
      ),
    ).toBe('/api/runs/r%201/events?owner=team+a%2Fb');
  });

  it('degrades to the bare path when localStorage throws (private mode)', () => {
    expect(withLocalStorage('throw', () => serverRunEventsUrl('run-1'))).toBe(
      '/api/runs/run-1/events',
    );
  });
});
