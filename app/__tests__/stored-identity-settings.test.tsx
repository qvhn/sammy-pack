/**
 * The shipped UI can authenticate under a gated server without DevTools.
 *
 * `web/api-auth.ts` reads the bearer token from localStorage `sammy.apiToken`
 * and the run store's SSE URL appends it as `?token=` — but no page ever
 * WROTE that key (Settings wrote only `sammy.userId`), so the only way to
 * use the UI under SAMMY_API_TOKEN / SAMMY_REQUIRE_AUTH_READS=1 was to set
 * localStorage by hand. The key constants are now exported from the auth
 * module and the Settings identity panel writes them: this test drives
 * that panel and then checks the token through BOTH readers.
 *
 * Also covers the Settings budget form sending the per-owner caps, with an
 * explicit null for a blank field (the server keeps an OMITTED per-owner
 * field, so a blank must say so to clear it).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SettingsPage } from '../src/pages/SettingsPage';
import { serverRunEventsUrl } from '../src/store/runs';
import { TOKEN_KEY, USER_KEY, readStoredIdentity } from '../web/api-auth';

type Store = Record<string, string>;

/** A real-enough localStorage: the page reads section-open flags and prefs
 *  through getItem/setItem/removeItem, and the backup panel enumerates. */
function memStorage(seed: Store) {
  const data: Store = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v);
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}

type FetchCall = { url: string; init?: RequestInit };

function mockFetch() {
  const calls: FetchCall[] = [];
  const routes: Record<string, unknown> = {
    '/api/mcp-servers/status': [],
    '/api/mcp-servers': {},
    '/api/hooks': {},
    '/api/agent-slots': { limit: 4, inUse: 0, waiting: 0 },
    '/api/budget': {
      dailyUsd: 5,
      monthlyUsd: null,
      perOwnerDailyUsd: null,
      perOwnerMonthlyUsd: null,
    },
  };
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = url.split('?')[0];
      const body =
        init?.method === 'PUT' && typeof init.body === 'string'
          ? JSON.parse(init.body)
          : (routes[path] ?? {});
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
  );
  return calls;
}

/** The HOST node (type is a string) carrying this accessibilityLabel —
 *  findByProps would also match the composite wrapper. */
function hostByLabel(root: ReactTestRenderer.ReactTestInstance, label: string) {
  const hits = root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
  if (hits.length !== 1) {
    throw new Error(`expected one host node labelled "${label}", found ${hits.length}`);
  }
  return hits[0];
}

/** The Pressable carrying this accessibilityLabel — the one node with an
 *  `onPress` (the host View underneath gets responder handlers instead). */
function pressableByLabel(root: ReactTestRenderer.ReactTestInstance, label: string) {
  const hit = root.findAll(
    n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!hit) throw new Error(`no Pressable labelled "${label}"`);
  return hit;
}

const g = globalThis as { localStorage?: unknown; fetch?: unknown };
let prevStorage: unknown;
let prevFetch: unknown;
let storage: ReturnType<typeof memStorage>;
let calls: FetchCall[];

beforeEach(() => {
  prevStorage = g.localStorage;
  prevFetch = g.fetch;
  // The two sections under test are collapsed by default; open them the
  // way the page itself persists that choice.
  storage = memStorage({
    'sammy.settings.section.User identity': '1',
    'sammy.settings.section.Cost guardrails': '1',
  });
  g.localStorage = storage;
  calls = mockFetch();
});

afterEach(() => {
  g.localStorage = prevStorage;
  g.fetch = prevFetch;
});

async function renderSettings() {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SettingsPage />);
  });
  // Drain the mount-time fetches (budget config, agent slots, ...).
  await ReactTestRenderer.act(async () => {});
  return tree!;
}

describe('the auth module owns the storage keys', () => {
  it('exports the keys the fetch wrapper reads', () => {
    expect(TOKEN_KEY).toBe('sammy.apiToken');
    expect(USER_KEY).toBe('sammy.userId');
  });

  it('readStoredIdentity reads both and degrades to nulls when storage throws', () => {
    storage.setItem(TOKEN_KEY, 't-1');
    storage.setItem(USER_KEY, 'alice');
    expect(readStoredIdentity()).toEqual({ token: 't-1', userId: 'alice' });
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readStoredIdentity()).toEqual({ token: null, userId: null });
  });
});

describe('Settings → User identity', () => {
  it('writes the API token where the fetch wrapper and the SSE URL read it', async () => {
    const tree = await renderSettings();
    const tokenInput = hostByLabel(tree.root, 'API token');
    // A secret: masked on screen.
    expect(tokenInput.props.secureTextEntry).toBe(true);

    await ReactTestRenderer.act(async () => {
      tokenInput.props.onChangeText('tok-1');
    });
    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Save identity').props.onPress();
    });

    expect(storage.getItem(TOKEN_KEY)).toBe('tok-1');
    // The same token now reaches both auth channels.
    expect(readStoredIdentity().token).toBe('tok-1');
    expect(serverRunEventsUrl('r1')).toBe('/api/runs/r1/events?token=tok-1');
    // Never echoed back: the field is blank again, and says a token exists.
    expect(hostByLabel(tree.root, 'API token').props.value).toBe('');
    expect(hostByLabel(tree.root, 'API token').props.placeholder).toMatch(/stored/);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('a Save with the token field blank keeps the stored token; Clear removes it', async () => {
    storage.setItem(TOKEN_KEY, 'tok-keep');
    const tree = await renderSettings();

    await ReactTestRenderer.act(async () => {
      hostByLabel(tree.root, 'User id').props.onChangeText('alice');
    });
    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Save identity').props.onPress();
    });
    expect(storage.getItem(USER_KEY)).toBe('alice');
    expect(storage.getItem(TOKEN_KEY)).toBe('tok-keep');

    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Clear API token').props.onPress();
    });
    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});

describe('Settings → Cost guardrails', () => {
  it('sends the per-owner caps, with an explicit null for a blank field', async () => {
    const tree = await renderSettings();
    expect(hostByLabel(tree.root, 'Daily cap').props.value).toBe('5');

    await ReactTestRenderer.act(async () => {
      hostByLabel(tree.root, 'Per-owner daily cap').props.onChangeText('1.5');
    });
    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Save budget caps').props.onPress();
    });
    await ReactTestRenderer.act(async () => {});

    const put = calls.find(c => c.url === '/api/budget' && c.init?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(String(put!.init!.body))).toEqual({
      dailyUsd: 5,
      monthlyUsd: null,
      perOwnerDailyUsd: 1.5,
      perOwnerMonthlyUsd: null,
    });
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('refuses a cap that does not parse instead of sending it as "no cap"', async () => {
    // `parseFloat('$1')` is NaN, which `JSON.stringify` puts on the wire as
    // `null` — the deliberate "clear this cap". The route answered 200 with
    // the cap gone and the panel rendered "Saved." with the typo still on
    // screen: a spend ceiling that quietly stopped existing.
    const tree = await renderSettings();
    for (const [label, typo] of [
      ['Per-owner daily cap', '$1'],
      ['Daily cap', 'five'],
      ['Monthly cap', '-5'],
      ['Per-owner monthly cap', '10 dollars'],
    ] as const) {
      await ReactTestRenderer.act(async () => {
        hostByLabel(tree.root, label).props.onChangeText(typo);
      });
      await ReactTestRenderer.act(async () => {
        pressableByLabel(tree.root, 'Save budget caps').props.onPress();
      });
      await ReactTestRenderer.act(async () => {});

      expect(calls.filter(c => c.url === '/api/budget' && c.init?.method === 'PUT')).toEqual([]);
      const text = JSON.stringify(tree.toJSON());
      expect(text).toContain('enter a number greater than 0');
      expect(text).not.toContain('Saved.');
      // The typo stays put so it can be corrected.
      expect(hostByLabel(tree.root, label).props.value).toBe(typo);
      await ReactTestRenderer.act(async () => {
        hostByLabel(tree.root, label).props.onChangeText('');
      });
    }
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('refuses to save when the mount-time READ failed — a blank form is not "no caps"', async () => {
    // The panel starts blank and `save()` sends every blank as the
    // deliberate `null` clear, so a GET that failed turned the next Save
    // into "remove all four ceilings" — with nothing on screen to
    // distinguish it from an unconfigured workspace. Same rule as the typo
    // path: a cost ceiling that quietly stops existing is the one failure a
    // guardrail may not have.
    (g as { fetch?: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.split('?')[0] === '/api/budget' && init?.method !== 'PUT') {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => ({ error: 'store unavailable' }),
            text: async () => '{"error":"store unavailable"}',
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
          text: async () => '{}',
        };
      },
    );
    const tree = await renderSettings();
    // Blank, because the read failed — and it SAYS so.
    expect(hostByLabel(tree.root, 'Daily cap').props.value).toBe('');
    expect(JSON.stringify(tree.toJSON())).toContain('could not read the current caps');

    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Save budget caps').props.onPress();
    });
    await ReactTestRenderer.act(async () => {});

    // Nothing was sent: no PUT at all, so no cap was cleared.
    expect(calls.filter(c => c.url === '/api/budget' && c.init?.method === 'PUT')).toEqual([]);
    expect(JSON.stringify(tree.toJSON())).not.toContain('Saved.');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('shows what was STORED, so a cap the server cleared cannot hide behind "Saved."', async () => {
    const tree = await renderSettings();
    // The route is the last word on what a cap is; whatever it answers with
    // is what the fields must read.
    (g as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        dailyUsd: 5,
        monthlyUsd: null,
        perOwnerDailyUsd: null,
        perOwnerMonthlyUsd: null,
      }),
      text: async () => '',
    }));
    await ReactTestRenderer.act(async () => {
      hostByLabel(tree.root, 'Per-owner daily cap').props.onChangeText('1.5');
    });
    await ReactTestRenderer.act(async () => {
      pressableByLabel(tree.root, 'Save budget caps').props.onPress();
    });
    await ReactTestRenderer.act(async () => {});

    expect(hostByLabel(tree.root, 'Per-owner daily cap').props.value).toBe('');
    expect(hostByLabel(tree.root, 'Daily cap').props.value).toBe('5');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});
