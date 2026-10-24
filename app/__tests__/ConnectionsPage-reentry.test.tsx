/**
 * The Connections editor against the masked registry.
 *
 * GET /api/credentials masks every secret; the editor pre-fills from that
 * and PUTs the whole map back. The server refuses to move an entry (url /
 * fields / owners / orchestrations) while its secret is the restored mask.
 * Before: the editor let the user move the url and press Save, the server
 * answered 400 with "Re-enter the secret …", and the toast read
 * `PUT /api/credentials failed: 400`. Now the editor applies the rule up
 * front (clears the value, marks it required, explains why, disables Save)
 * and a server refusal reaches the toast in the server's words. The rule
 * covers every secret the server restores, not just `value`: an entry
 * whose secret lives in `env` / `headers` / `cache` / a secret-looking
 * `fields` key is held the same way, and those blocks ride along unchanged
 * on save so the server restores rather than drops them. `fields` is the
 * one block the server decides PER KEY, so the editor marks the offending
 * input when the kind declares one and points at the raw JSON editor when
 * it does not. Env values show exactly as GET sent them (a short
 * secret as the server's SHORT_VALUE_MASK, an empty value as '') and go
 * back as they came.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ConnectionsPage } from '../src/pages/ConnectionsPage';
import { SHORT_VALUE_MASK } from '../src/store/credentials';
import { ToastProvider } from '../src/store/toast';

type Store = Record<string, string>;

function memStorage(seed: Store = {}) {
  const data: Store = { ...seed };
  return {
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
  };
}

type FetchCall = { url: string; init?: RequestInit };

const REENTER =
  'Connection "svc-prod": cannot change `url` while its secret is masked. ' +
  'Re-enter the secret to change where it is sent or who may use it.';

function mockFetch(registry: Record<string, unknown>, putStatus = 200) {
  const calls: FetchCall[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(
    async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = url.split('?')[0];
      const method = init?.method ?? 'GET';
      const reply = (status: number, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 400 ? 'Bad Request' : 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      if (path === '/api/credentials' && method === 'GET') return reply(200, registry);
      if (path === '/api/credentials' && method === 'PUT') {
        if (putStatus !== 200) return reply(putStatus, { error: REENTER });
        return reply(200, JSON.parse(String(init?.body)));
      }
      if (path === '/api/credentials/usage') return reply(200, {});
      if (path === '/api/mcp-servers') return reply(200, {});
      return reply(200, {});
    },
  );
  return calls;
}

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

/** The card's Edit button: the pressable whose text is exactly "Edit". */
function editButton(root: ReactTestRenderer.ReactTestInstance) {
  const hit = root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.props.children === 'Edit').length > 0,
  )[0];
  if (!hit) throw new Error('no Edit button');
  return hit;
}

const g = globalThis as { localStorage?: unknown; fetch?: unknown };
let prev: { localStorage: unknown; fetch: unknown };

beforeEach(() => {
  prev = { localStorage: g.localStorage, fetch: g.fetch };
  g.localStorage = memStorage();
});

afterEach(() => {
  g.localStorage = prev.localStorage;
  g.fetch = prev.fetch;
});

async function renderPage() {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ToastProvider>
        <ConnectionsPage />
      </ToastProvider>,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree!;
}

const act = ReactTestRenderer.act;

const maskedA2a = {
  'svc-prod': {
    kind: 'a2a',
    value: 'tok-12…89',
    url: 'https://agents.example.test/a2a',
    owners: ['alice'],
  },
};

describe('editing an entry whose secret is masked', () => {
  it('moving the url clears the value, requires it, explains why, and disables Save', async () => {
    mockFetch(maskedA2a);
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    // Pre-filled from the masked GET.
    expect(hostByLabel(tree.root, 'Bearer token (optional)').props.value).toBe('tok-12…89');
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);

    await act(async () => {
      hostByLabel(tree.root, 'Agent-card URL').props.onChangeText(
        'https://elsewhere.example.test/a2a',
      );
    });

    expect(hostByLabel(tree.root, 'Bearer token (optional)').props.value).toBe('');
    // Interpolated JSX text serialises as split children.
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Re-enter the secret to change `","url","`/);
    expect(text).toMatch(/Bearer token \(optional\)"," \*"/);
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('re-typing the secret enables Save and the PUT carries it, with the audience lists intact', async () => {
    const calls = mockFetch(maskedA2a);
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    await act(async () => {
      hostByLabel(tree.root, 'Agent-card URL').props.onChangeText(
        'https://elsewhere.example.test/a2a',
      );
    });
    await act(async () => {
      hostByLabel(tree.root, 'Bearer token (optional)').props.onChangeText(
        'new-bearer-token-0123456789',
      );
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);
    await act(async () => {
      pressableByLabel(tree.root, 'Save changes').props.onPress();
    });
    await act(async () => {});

    const put = calls.find(c => c.url === '/api/credentials' && c.init?.method === 'PUT');
    expect(put).toBeDefined();
    const sent = JSON.parse(String(put!.init!.body))['svc-prod'];
    expect(sent.value).toBe('new-bearer-token-0123456789');
    expect(sent.url).toBe('https://elsewhere.example.test/a2a');
    // The form has no owners control; an edit must not read as a move of
    // `owners` (refused while masked, silently de-scoped once re-typed).
    expect(sent.owners).toEqual(['alice']);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('a server refusal reaches the toast in the server\'s words', async () => {
    mockFetch(maskedA2a, 400);
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    // Only the description changes — the editor allows the save; the
    // (mocked) server refuses anyway, and its reason must be what shows.
    const description = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.placeholder === 'What this connection is for',
    )[0];
    await act(async () => {
      description.props.onChangeText('moved');
    });
    await act(async () => {
      pressableByLabel(tree.root, 'Save changes').props.onPress();
    });
    await act(async () => {});

    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('Re-enter the secret to change where it is sent');
    expect(text).not.toMatch(/failed: 400"/);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});

describe('env values as the server masks them', () => {
  it('show exactly as sent — a short secret as SHORT_VALUE_MASK, an empty value as "" — and round-trip unchanged', async () => {
    // The wire shape: ≤ 8-char values become the server's fixed mask, a
    // longer one its prefix mask, and '' only for a value that IS empty.
    const sent = { AWS_REGION: SHORT_VALUE_MASK, TOKEN: 'ghp_01…89', EMPTY_ON_PURPOSE: '' };
    const calls = mockFetch({
      'mcp-cred': { kind: 'mcp-server', value: '', ref: 'atlassian', env: sent },
    });
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    const env = hostByLabel(tree.root, 'Env block (JSON)');
    expect(JSON.parse(env.props.value)).toEqual(sent);
    expect(env.props.value).toContain(SHORT_VALUE_MASK);
    // Nothing moved — masked env secrets alone never block a save.
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);

    await act(async () => {
      pressableByLabel(tree.root, 'Save changes').props.onPress();
    });
    await act(async () => {});
    const put = calls.find(c => c.url === '/api/credentials' && c.init?.method === 'PUT');
    expect(JSON.parse(String(put!.init!.body))['mcp-cred'].env).toEqual(sent);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});

describe('an entry whose secret lives outside `value`', () => {
  const url = 'https://agents.example.test/a2a';
  const moved = 'https://elsewhere.example.test/a2a';

  it('a masked env secret holds a url move as the server would, and says so', async () => {
    // No bearer token at all: the secret is in `env`. The server restores
    // it from disk on save and refuses to move the url; the editor used to
    // look at `value` only and leave Save enabled → 400, with no field to
    // re-enter.
    mockFetch({
      'svc-env': { kind: 'a2a', value: '', url, env: { API_KEY: SHORT_VALUE_MASK } },
    });
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);
    await act(async () => {
      hostByLabel(tree.root, 'Agent-card URL').props.onChangeText(moved);
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(true);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Re-enter every masked secret in `","env","`/);
    expect(text).toContain('This form has no field for `env`');
    // The bearer-token field is NOT the secret being protected here.
    expect(text).not.toMatch(/Bearer token \(optional\)"," \*"/);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('hand-written headers and an SSO cache ride along unchanged on save, and hold a move too', async () => {
    const headers = { Authorization: 'Bearer…xy' };
    const cache = { accessToken: 'eyJ0eX…ab', expiresAt: '2030-01-01T00:00:00Z' };
    const calls = mockFetch({
      'svc-hdr': { kind: 'a2a', value: '', url, headers, cache },
    });
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    // Only the description changes: allowed, and the blocks the form has no
    // controls for are sent back so the server restores (not drops) them.
    const description = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.placeholder === 'What this connection is for',
    )[0];
    await act(async () => {
      description.props.onChangeText('renamed');
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);
    await act(async () => {
      pressableByLabel(tree.root, 'Save changes').props.onPress();
    });
    await act(async () => {});
    const put = calls.find(c => c.url === '/api/credentials' && c.init?.method === 'PUT');
    const sent = JSON.parse(String(put!.init!.body))['svc-hdr'];
    expect(sent.headers).toEqual(headers);
    expect(sent.cache).toEqual(cache);

    // Re-open and move the url: held, naming both blocks.
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    await act(async () => {
      hostByLabel(tree.root, 'Agent-card URL').props.onChangeText(moved);
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toMatch(
      /Re-enter every masked secret in `","cache`, `headers","`/,
    );
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('a masked `fields` secret holds a fields move, and the note points at the raw JSON editor', async () => {
    // A hand-written `fields.apiToken` — the shape the server masks per key.
    // The editor knew about value / env / cache / headers only, so Save was
    // enabled and the server answered 400 "cannot change `fields` while its
    // secret is masked" AFTER the secret had been re-entered, with no field
    // to re-enter it in: the kind declares no control for that key.
    mockFetch({
      'jira-prod': {
        kind: 'jira',
        value: 'ATATT3…11',
        fields: {
          email: 'ops@example.test',
          siteUrl: 'https://team.atlassian.test',
          apiToken: 'ATATT3…22',
        },
      },
    });
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(false);
    await act(async () => {
      hostByLabel(tree.root, 'Account email').props.onChangeText('new@example.test');
    });
    // Re-type the real top-level token, as the hint asks. The `fields`
    // secret is still the mask, so the move is still refused — and now the
    // editor says so instead of the server.
    await act(async () => {
      hostByLabel(tree.root, 'API token').props.onChangeText('ATATT3-brandnew-token-0123456789');
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(true);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Re-enter every masked secret in `","fields","`/);
    expect(text).toContain('This form has no field for `fields`');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  it('an over-masked `fields` leaf the kind DOES declare gets the hint on its own input', async () => {
    // The by-shape rule masks a long base-URL path too, so the key can be
    // one the form renders. Then the note must not send the operator to the
    // raw JSON editor — the input is right there and needs marking.
    mockFetch({
      'jira-prod': {
        kind: 'jira',
        value: 'ATATT3…11',
        fields: { email: 'ops@example.test', siteUrl: 'https:…es' },
      },
    });
    const tree = await renderPage();
    await act(async () => {
      editButton(tree.root).props.onPress();
    });
    await act(async () => {
      hostByLabel(tree.root, 'Account email').props.onChangeText('new@example.test');
    });
    await act(async () => {
      hostByLabel(tree.root, 'API token').props.onChangeText('ATATT3-brandnew-token-0123456789');
    });
    expect(pressableByLabel(tree.root, 'Save changes').props.disabled).toBe(true);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toMatch(/Site URL"," \*"/);
    expect(text).toMatch(/Re-enter the secret to change `","fields","`/);
    expect(text).not.toContain('This form has no field for');
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});
