/**
 * The web shell's hash router: page ids + the selected pipeline round-trip
 * through `location.hash`, page changes push history (so Back works), and
 * in-page pipeline selection replaces it (no extra Back step).
 */
import {
  DEFAULT_PAGE,
  PAGE_IDS,
  currentRoute,
  formatHash,
  navigateTo,
  onRouteChange,
  parseHash,
  replaceRoute,
} from '../src/lib/hashRoute';

describe('parseHash / formatHash', () => {
  test('empty / unknown hashes land on the default page', () => {
    expect(parseHash('')).toEqual({ page: DEFAULT_PAGE });
    expect(parseHash(undefined)).toEqual({ page: DEFAULT_PAGE });
    expect(parseHash('#/nope')).toEqual({ page: DEFAULT_PAGE });
  });

  test('every page id round-trips', () => {
    for (const page of PAGE_IDS) {
      expect(parseHash(formatHash({ page }))).toEqual({ page });
    }
  });

  test('the selected pipeline round-trips, including awkward names', () => {
    for (const name of ['template', 'my pipeline', 'a/b', 'ünï #1?']) {
      const hash = formatHash({ page: 'pipelines', pipeline: name });
      expect(parseHash(hash)).toEqual({ page: 'pipelines', pipeline: name });
    }
  });

  test('a pipeline segment on another page is ignored', () => {
    expect(formatHash({ page: 'runs', pipeline: 'x' })).toBe('#/runs');
    expect(parseHash('#/runs/x')).toEqual({ page: 'runs' });
  });

  test('tolerates a hash without the leading slash and bad escapes', () => {
    expect(parseHash('#approvals')).toEqual({ page: 'approvals' });
    expect(parseHash('#/pipelines/%E0%A4%A')).toEqual({
      page: 'pipelines',
      pipeline: '%E0%A4%A',
    });
  });
});

describe('navigation against a fake location', () => {
  type Listener = () => void;
  const g = globalThis as unknown as Record<string, unknown>;
  let listeners: Listener[];
  let pushes: number;
  let replaces: string[];

  beforeEach(() => {
    listeners = [];
    pushes = 0;
    replaces = [];
    let hash = '';
    g.location = {
      pathname: '/',
      search: '',
      get hash() {
        return hash;
      },
      set hash(v: string) {
        hash = v;
        pushes++;
        listeners.forEach(l => l());
      },
    };
    g.history = {
      replaceState: (_d: unknown, _t: string, url: string) => {
        replaces.push(url);
        hash = url.slice(url.indexOf('#'));
      },
    };
    g.addEventListener = (_t: string, fn: Listener) => listeners.push(fn);
    g.removeEventListener = (_t: string, fn: Listener) => {
      listeners = listeners.filter(l => l !== fn);
    };
  });

  afterEach(() => {
    delete g.location;
    delete g.history;
    delete g.addEventListener;
    delete g.removeEventListener;
  });

  test('navigateTo pushes a history entry and notifies subscribers', () => {
    const seen: string[] = [];
    const off = onRouteChange(r => seen.push(r.page));
    expect(navigateTo({ page: 'runs' })).toBe(true);
    expect(currentRoute()).toEqual({ page: 'runs' });
    expect(pushes).toBe(1);
    expect(seen).toEqual(['runs']);
    // Same route again is not a new history entry.
    navigateTo({ page: 'runs' });
    expect(pushes).toBe(1);
    off();
    navigateTo({ page: 'settings' });
    expect(seen).toEqual(['runs']);
  });

  test('replaceRoute rewrites the hash without a push or a hashchange', () => {
    const seen: string[] = [];
    onRouteChange(r => seen.push(r.page));
    replaceRoute({ page: 'pipelines', pipeline: 'demo flow' });
    expect(pushes).toBe(0);
    expect(seen).toEqual([]);
    expect(replaces).toEqual(['/#/pipelines/demo%20flow']);
    expect(currentRoute()).toEqual({ page: 'pipelines', pipeline: 'demo flow' });
  });
});

test('without a location (native) navigation is a no-op', () => {
  expect(navigateTo({ page: 'runs' })).toBe(false);
  expect(currentRoute()).toEqual({ page: DEFAULT_PAGE });
  expect(() => replaceRoute({ page: 'runs' })).not.toThrow();
});
