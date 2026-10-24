/**
 * The Connections editor's side of the masked round trip.
 *
 * GET /api/credentials masks every secret; PUT restores a mask (or '' while
 * a value is stored) from disk and REFUSES to move an entry whose secret it
 * had to restore. The editor pre-fills from the masked GET, so a url /
 * fields change with the secret untouched is exactly the save the server
 * rejects — and the store client used to throw `PUT /api/credentials
 * failed: 400`, so the toast never carried the server's "Re-enter the
 * secret" explanation.
 *
 * Three guarantees, each a pure function the page calls:
 *   - `maskedSecretBlocks` says which of the entry's secrets the server
 *     would restore — i.e. which the caller has NOT re-entered — block by
 *     block, the way the server walks them (value, env, cache, headers, and
 *     the secret-looking `fields` keys, which the server decides per key);
 *   - `secretReentryRequired` mirrors the server rule before Save;
 *   - the store clients throw the server's own words.
 */

import { readErrorBody, requestFailure } from '../src/api';
import {
  SHORT_VALUE_MASK,
  getCredentials,
  maskedFieldKeys,
  maskedSecretBlocks,
  saveCredentials,
  secretReentryRequired,
  type Credential,
} from '../src/store/credentials';

const MASK = 'ghp_01…89';

const masked: Credential = {
  kind: 'a2a',
  value: MASK,
  url: 'https://agents.example.test/a2a',
  fields: { email: 'ops@example.test', site: 'https://site.example.test' },
  owners: ['alice', 'bob'],
  orchestrations: ['nightly'],
};

describe('maskedSecretBlocks', () => {
  // Every secret-bearing block, as GET sends it: a long secret as its
  // prefix mask, a short one as SHORT_VALUE_MASK, an empty one as ''.
  const everyBlock = {
    kind: 'a2a',
    value: MASK,
    url: 'https://agents.example.test/a2a',
    env: { API_KEY: SHORT_VALUE_MASK, TOKEN: 'ghp_01…89', EMPTY: '' },
    cache: { accessToken: 'eyJ0eX…ab', expiresAt: '2030-01-01T00:00:00Z' },
    headers: { Authorization: 'Bearer…xy' },
  } as Credential;

  it('names every block the draft still echoes as sent', () => {
    expect(
      maskedSecretBlocks(
        {
          value: everyBlock.value,
          env: everyBlock.env,
          cache: everyBlock.cache,
          headers: (everyBlock as { headers?: Record<string, unknown> }).headers,
        },
        everyBlock,
      ),
    ).toEqual(['value', 'env', 'cache', 'headers']);
  });

  it('drops a block once every secret in it is re-typed; a block the draft does not send is not restored', () => {
    expect(
      maskedSecretBlocks(
        {
          value: 'ghp_a-brand-new-token-0123456789',
          env: { API_KEY: 'new-key', TOKEN: 'ghp_new-token-0123456789', EMPTY: '' },
          cache: { accessToken: 'a-fresh-token' },
        },
        everyBlock,
      ),
    ).toEqual([]);
    // The server only restores what comes back; cache / headers left out of
    // the PUT are dropped, not restored.
    expect(maskedSecretBlocks({ value: MASK }, everyBlock)).toEqual(['value']);
  });

  it('a cleared or partly re-typed block is still restored', () => {
    expect(
      maskedSecretBlocks(
        {
          value: '',
          env: { API_KEY: 'new-key', TOKEN: '' },
        },
        everyBlock,
      ),
    ).toEqual(['value', 'env']);
  });

  it('names `fields` for a masked fields leaf, and does NOT name it for the readable ones', () => {
    // `fields` is the one block the server decides PER KEY, on the stored
    // value — so a secret-looking `fields.apiToken` comes back masked while
    // `email` / `site` stay readable. Leaving `fields` off the block list
    // meant Save was enabled and the server answered 400 with no hint; a
    // naive `restoredFrom` over the whole block would instead report the
    // untouched readable keys and disable Save for every move there is.
    const fieldsSecret = {
      kind: 'atlassian',
      value: MASK,
      fields: {
        email: 'ops@example.test',
        site: 'https://team.atlassian.test',
        apiToken: 'ATATT3…22',
      },
    } as Credential;
    expect(
      maskedSecretBlocks({ value: MASK, fields: fieldsSecret.fields }, fieldsSecret),
    ).toEqual(['value', 'fields']);
    // Re-typing the top-level token does not free the entry while the
    // fields secret is still the mask — which is the save the server refused.
    expect(
      maskedSecretBlocks(
        { value: 'ATATT3-brandnew-token-0123456789', fields: fieldsSecret.fields },
        fieldsSecret,
      ),
    ).toEqual(['fields']);
    // Re-typed frees it.
    expect(
      maskedSecretBlocks(
        {
          value: 'ATATT3-brandnew-token-0123456789',
          fields: { ...fieldsSecret.fields, apiToken: 'ATATT3-brandnew-second-0123456' },
        },
        fieldsSecret,
      ),
    ).toEqual([]);
    // So does CLEARING it, because the save drops a blank `fields` key from
    // the PUT body (`handleSave`: `if (v?.trim())`) and the server restores
    // only the keys it receives — a cleared key is a deletion it accepts,
    // 200. Counting it disabled Save behind "re-enter every masked secret in
    // `fields`", a hint the form cannot satisfy: typing the mask back
    // restores the key, typing a value keeps it, and only the raw JSON
    // editor can delete it.
    expect(
      maskedSecretBlocks(
        {
          value: 'ATATT3-brandnew-token-0123456789',
          fields: { ...fieldsSecret.fields, apiToken: '' },
        },
        fieldsSecret,
      ),
    ).toEqual([]);
    expect(
      maskedFieldKeys(
        { value: MASK, fields: { ...fieldsSecret.fields, apiToken: '   ' } },
        fieldsSecret,
      ),
    ).toEqual([]);
    // The untouched `value` is still masked, so THAT still holds Save.
    expect(
      maskedSecretBlocks(
        { value: MASK, fields: { ...fieldsSecret.fields, apiToken: '' } },
        fieldsSecret,
      ),
    ).toEqual(['value']);
    // An entry whose ONLY secret lives in `fields` — no `value` for the
    // editor's value-clearing heuristic to catch.
    const fieldsOnly = {
      kind: 'atlassian',
      value: '',
      fields: { siteUrl: 'https://old.example.test', apiToken: 'ATATT3…28' },
    } as Credential;
    expect(
      maskedSecretBlocks({ value: '', fields: fieldsOnly.fields }, fieldsOnly),
    ).toEqual(['fields']);
    expect(
      secretReentryRequired(
        {
          value: '',
          fields: { siteUrl: 'https://new.example.test', apiToken: 'ATATT3…28' },
        },
        fieldsOnly,
      ),
    ).toBe('fields');
    // Readable fields alone never flag the block, however the entry moves.
    const readable = {
      kind: 'atlassian',
      value: MASK,
      url: 'https://a.example.test',
      fields: { email: 'ops@example.test', site: 'https://team.atlassian.test' },
    } as Credential;
    expect(maskedSecretBlocks({ value: 'retyped-0123456789', fields: readable.fields }, readable))
      .toEqual([]);
    expect(
      secretReentryRequired(
        { value: 'retyped-0123456789', url: 'https://b.example.test', fields: readable.fields },
        readable,
      ),
    ).toBeNull();
  });

  it("'' from GET is no secret — the server masks every stored value to a non-empty token", () => {
    const none = { kind: 'a2a', value: '', url: 'https://a.example.test', env: { EMPTY: '' } } as Credential;
    expect(maskedSecretBlocks({ value: '', env: { EMPTY: '' } }, none)).toEqual([]);
    expect(maskedSecretBlocks({ value: '' }, undefined)).toEqual([]);
  });
});

describe('secretReentryRequired', () => {
  it('lets an untouched entry be re-saved (the mask round-trips)', () => {
    expect(
      secretReentryRequired(
        {
          value: MASK,
          url: masked.url,
          fields: masked.fields,
          owners: masked.owners,
          orchestrations: masked.orchestrations,
        },
        masked,
      ),
    ).toBeNull();
  });

  it('names `url` when the url moves while the value is still the mask', () => {
    expect(
      secretReentryRequired(
        { value: MASK, url: 'https://elsewhere.example.test/a2a', fields: masked.fields },
        masked,
      ),
    ).toBe('url');
  });

  it('still requires the secret after the editor has cleared the value field', () => {
    // '' is what the server restores from disk too — clearing the field is
    // not re-entering the secret.
    expect(
      secretReentryRequired(
        { value: '', url: 'https://elsewhere.example.test/a2a', fields: masked.fields },
        masked,
      ),
    ).toBe('url');
  });

  it('is satisfied once the secret is re-typed', () => {
    expect(
      secretReentryRequired(
        { value: 'ghp_a-brand-new-token-0123456789', url: 'https://elsewhere.example.test/a2a' },
        masked,
      ),
    ).toBeNull();
  });

  it('names `fields` for a changed field, but not for whitespace or order', () => {
    const audience = { owners: masked.owners, orchestrations: masked.orchestrations };
    expect(
      secretReentryRequired(
        {
          value: MASK,
          url: masked.url,
          fields: { ...masked.fields, site: 'https://other.example.test' },
          ...audience,
        },
        masked,
      ),
    ).toBe('fields');
    expect(
      secretReentryRequired(
        {
          value: MASK,
          url: masked.url,
          fields: { site: ' https://site.example.test ', email: 'ops@example.test', blank: '  ' },
          ...audience,
        },
        masked,
      ),
    ).toBeNull();
  });

  it('names the audience lists, order-insensitively', () => {
    const base = { value: MASK, url: masked.url, fields: masked.fields };
    expect(
      secretReentryRequired({ ...base, owners: ['bob', 'alice'], orchestrations: ['nightly'] }, masked),
    ).toBeNull();
    expect(
      secretReentryRequired({ ...base, owners: ['alice'], orchestrations: ['nightly'] }, masked),
    ).toBe('owners');
    expect(
      secretReentryRequired({ ...base, owners: masked.owners, orchestrations: [] }, masked),
    ).toBe('orchestrations');
  });

  it('applies to a secret outside `value`: a masked env / headers / cache secret blocks the move, and a re-typed value does not free it', () => {
    // The server refuses while it had to restore ANY secret. These entries
    // have no bearer token at all — their secret lives in env / headers /
    // cache — and used to pass the editor's rule on `value` alone.
    const url = 'https://agents.example.test/a2a';
    const moved = 'https://elsewhere.example.test/a2a';
    const envOnly = { kind: 'a2a', value: '', url, env: { API_KEY: SHORT_VALUE_MASK } } as Credential;
    expect(
      secretReentryRequired({ value: '', url: moved, env: { API_KEY: SHORT_VALUE_MASK } }, envOnly),
    ).toBe('url');
    expect(
      secretReentryRequired({ value: 'brand-new-bearer-0123456789', url: moved, env: { API_KEY: SHORT_VALUE_MASK } }, envOnly),
    ).toBe('url');
    expect(
      secretReentryRequired({ value: '', url: moved, env: { API_KEY: 'retyped' } }, envOnly),
    ).toBeNull();

    const headersOnly = { kind: 'a2a', value: '', url, headers: { Authorization: 'Bearer…xy' } } as Credential;
    expect(
      secretReentryRequired({ value: '', url: moved, headers: { Authorization: 'Bearer…xy' } }, headersOnly),
    ).toBe('url');

    const cached = { kind: 'a2a', value: '', url, cache: { accessToken: 'eyJ0eX…ab' } } as Credential;
    expect(
      secretReentryRequired({ value: '', url: moved, cache: { accessToken: 'eyJ0eX…ab' } }, cached),
    ).toBe('url');
  });

  it("'' from GET means no stored secret, so the entry may move freely", () => {
    // The server masks every stored value to a non-empty token (a short one
    // to SHORT_VALUE_MASK); '' only ever means "nothing stored".
    const none: Credential = { kind: 'github', value: '', url: 'https://a.example.test' };
    expect(secretReentryRequired({ value: '', url: 'https://b.example.test' }, none)).toBeNull();
    const short: Credential = { kind: 'github', value: SHORT_VALUE_MASK, url: 'https://a.example.test' };
    expect(secretReentryRequired({ value: '', url: 'https://b.example.test' }, short)).toBe('url');
    expect(secretReentryRequired({ value: SHORT_VALUE_MASK, url: 'https://b.example.test' }, short)).toBe('url');
  });

  it('never applies to a new entry', () => {
    expect(secretReentryRequired({ value: '', url: 'https://x.example.test' }, undefined)).toBeNull();
  });
});

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(status: number, body: unknown, statusText = 'Bad Request') {
  const calls: FetchCall[] = [];
  const g = globalThis as { fetch?: unknown };
  const prev = g.fetch;
  g.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
  return {
    calls,
    restore: () => {
      g.fetch = prev;
    },
  };
}

describe('store clients surface the server text', () => {
  const REENTER =
    'Connection "svc": cannot change `url` while its secret is masked. ' +
    'Re-enter the secret to change where it is sent or who may use it.';

  it('saveCredentials throws the 400 body, not a bare status', async () => {
    const { restore } = stubFetch(400, { error: REENTER });
    try {
      await expect(saveCredentials({})).rejects.toThrow(
        `PUT /api/credentials failed: 400 — ${REENTER}`,
      );
    } finally {
      restore();
    }
  });

  it('getCredentials does the same for a gated read', async () => {
    const { restore } = stubFetch(401, { error: 'A bearer token is required' }, 'Unauthorized');
    try {
      await expect(getCredentials()).rejects.toThrow(
        'GET /api/credentials failed: 401 — A bearer token is required',
      );
    } finally {
      restore();
    }
  });

  it('readErrorBody takes `error` from JSON, the raw text otherwise, "" when unreadable', async () => {
    const res = (text: string | null) =>
      ({
        text: async () => {
          if (text === null) throw new Error('aborted');
          return text;
        },
      }) as unknown as Response;
    expect(await readErrorBody(res(JSON.stringify({ error: 'nope' })))).toBe('nope');
    expect(await readErrorBody(res('  plain text  '))).toBe('plain text');
    expect(await readErrorBody(res(JSON.stringify({ message: 'x' })))).toBe('{"message":"x"}');
    expect(await readErrorBody(res(null))).toBe('');
  });

  it('requestFailure omits the dash when the body is empty', async () => {
    const res = { status: 500, text: async () => '' } as unknown as Response;
    expect((await requestFailure('GET /api/x', res)).message).toBe('GET /api/x failed: 500');
  });
});
