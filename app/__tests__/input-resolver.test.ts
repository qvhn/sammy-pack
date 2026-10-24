import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInputs } from '../src/server/input-resolver';

describe('input-resolver', () => {
  test('text passthrough', async () => {
    const out = await resolveInputs(
      [{ name: 'note', kind: 'text' }],
      { note: { value: 'hello' } },
    );
    expect(out.note).toBe('hello');
  });

  test('a missing required input is refused', async () => {
    await expect(
      resolveInputs([{ name: 'ticket', kind: 'jira', required: true }], {}),
    ).rejects.toThrow(/required input "ticket"/);
  });

  test('a missing OPTIONAL input is simply omitted', async () => {
    const out = await resolveInputs(
      [{ name: 'note', kind: 'text', required: false }],
      {},
    );
    expect(out.note).toBeUndefined();
  });

  test('url is fetched and its body is returned', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => 'PRD body text',
    })) as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'prd', kind: 'url' }],
      { prd: { value: 'https://example.com/prd' } },
      { fetchImpl },
    );
    expect(out.prd).toBe('PRD body text');
  });

  test('jira fetch formats summary + status from the issue payload', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        key: 'BUG-1',
        fields: {
          summary: 'login crashes',
          status: { name: 'Open' },
          issuetype: { name: 'Bug' },
          description: 'repro: tap login',
        },
      }),
    })) as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'https://x.atlassian.net/browse/BUG-1' } },
      { fetchImpl, atlassian: { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' } },
    );
    expect(out.ticket).toContain('BUG-1 — login crashes');
    expect(out.ticket).toContain('Bug');
    expect(out.ticket).toContain('Open');
    expect(out.ticket).toContain('repro: tap login');
  });

  test('jira attachments are downloaded and listed by local path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-att-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
      if (url.includes('/attachment/content/10483')) {
        return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) };
      }
      if (url.includes('/attachment/content/')) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          key: 'ABC-1',
          fields: {
            summary: 'Create a web page',
            attachment: [
              { id: '10483', filename: 'icon.png', mimeType: 'image/png', size: 4 },
              { id: '10484', filename: 'gone.txt', mimeType: 'text/plain', size: 10 },
              { id: '10485', filename: 'huge.mov', mimeType: 'video/quicktime', size: 50 * 1024 * 1024 },
            ],
          },
        }),
      };
    }) as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'ABC-1' } },
      { fetchImpl, atlassian: { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' }, attachmentsDir: dir },
    );
    const keyDir = (await fs.readdir(dir)).find(d => d.startsWith('ABC-1-'))!;
    const saved = path.join(dir, keyDir, 'icon.png');
    expect(await fs.readFile(saved)).toEqual(png);
    expect(out.ticket).toContain(`- ${saved} (image/png, 4 B)`);
    expect(out.ticket).toContain('gone.txt (text/plain, 10 B) — download failed: HTTP 404');
    expect(out.ticket).toContain('huge.mov (video/quicktime, 50.0 MB) — skipped');
    expect(calls.some(c => c.url.endsWith('/attachment/content/10485'))).toBe(false);
    expect(calls.every(c => c.auth?.startsWith('Basic '))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('jira key is matched case-insensitively and normalized to UPPERCASE', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (u: string) => {
      requestedUrl = u;
      return {
        ok: true,
        status: 200,
        json: async () => ({ key: 'PROJ-42', fields: { summary: 's' } }),
      };
    }) as unknown as typeof fetch;
    // Lowercase id pasted from a browse URL — used to fall through the
    // uppercase-only regex and hit the API with garbage.
    await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'https://x.atlassian.net/browse/proj-42?focusedId=9' } },
      { fetchImpl, atlassian: { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' } },
    );
    expect(requestedUrl).toContain('/issue/PROJ-42?');
  });

  // ─── github: the credential's destination ────────────────────────────────
  // The `github` branch attaches the STORED PAT to whatever URL the resolver
  // produced, so a value that fell through unchanged made the caller the
  // chooser of the destination.

  const githubFetch = (): {
    impl: typeof fetch;
    calls: Array<{ url: string; auth?: string }>;
  } => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const impl = (async (u: string, init?: RequestInit) => {
      calls.push({
        url: String(u),
        auth: (init?.headers as Record<string, string> | undefined)
          ?.Authorization,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ number: 5, title: 'crash', state: 'open', body: 'b' }),
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  test('a github.com issue URL resolves against api.github.com with the PAT', async () => {
    const { impl, calls } = githubFetch();
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'github' }],
      { ticket: { value: 'https://github.com/acme/widgets/issues/5' } },
      { fetchImpl: impl, github: { token: 'ghp_stored_pat_0123456789' } },
    );
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/acme/widgets/issues/5',
        auth: 'Bearer ghp_stored_pat_0123456789',
      },
    ]);
    expect(out.ticket).toContain('#5 crash (open)');
  });

  test('a pull URL maps to /pulls and an api.github.com URL passes through', async () => {
    const { impl, calls } = githubFetch();
    await resolveInputs(
      [
        { name: 'pr', kind: 'github' },
        { name: 'direct', kind: 'github' },
      ],
      {
        pr: { value: 'https://github.com/acme/widgets/pull/7' },
        direct: { value: 'https://api.github.com/repos/acme/widgets/issues/9' },
      },
      { fetchImpl: impl, github: { token: 'ghp_t' } },
    );
    expect(calls.map(c => c.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/pulls/7',
      'https://api.github.com/repos/acme/widgets/issues/9',
    ]);
  });

  test('a MIXED-CASE github.com URL resolves — a host is case-insensitive', async () => {
    // `new URL()` lowercases the host, so a case-SENSITIVE match refused a
    // legitimate pasted link with a message naming exactly what it was
    // given. Every gate in this repo classifies case-folded for this reason.
    const { impl, calls } = githubFetch();
    await resolveInputs(
      [
        { name: 'a', kind: 'github' },
        { name: 'b', kind: 'github' },
        { name: 'c', kind: 'github' },
      ],
      {
        a: { value: 'https://GitHub.com/acme/widgets/issues/7' },
        b: { value: 'HTTPS://GITHUB.COM/acme/widgets/PULL/8' },
        c: { value: 'https://github.com/acme/widgets/Issues/9' },
      },
      { fetchImpl: impl, github: { token: 'ghp_t' } },
    );
    expect(calls.map(c => c.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/7',
      // `PULL` must still map to /pulls, not fall through to /issues.
      'https://api.github.com/repos/acme/widgets/pulls/8',
      'https://api.github.com/repos/acme/widgets/issues/9',
    ]);
  });

  test.each([
    ['a caller-chosen host', 'http://127.0.0.1:9/exfil?x=1'],
    ['a github.com LOOKALIKE host', 'https://github.com.evil.example/a/b/issues/1'],
    ['a github.com SUBDOMAIN of another host', 'https://api.github.com.evil.example/x'],
    ['a non-URL', 'acme/widgets#4'],
    ['a relative owner segment', 'https://github.com/../..%2fuser/issues/1'],
    // The api.github.com passthrough granted outright what the
    // relative-segment guard above refuses: the caller choosing the endpoint
    // the stored PAT hits. And because the refusal reports the upstream
    // status (`→ HTTP 404`), that made the PAT an existence oracle for
    // private repos and org membership. It is bounded to the one shape a
    // `github` input needs — which is the shape the other branch builds.
    ['the PAT-scoped identity endpoint', 'https://api.github.com/user'],
    ['the email list behind the PAT', 'https://api.github.com/user/emails'],
    ['an org membership probe', 'https://api.github.com/orgs/acme/members/mallory'],
    ['a file in a private repo', 'https://api.github.com/repos/acme/private/contents/.env'],
    ['a repo listing rather than one issue', 'https://api.github.com/repos/acme/widgets/issues'],
    ['a comments sub-resource', 'https://api.github.com/repos/acme/widgets/issues/9/comments'],
  ])(
    'the stored PAT is never sent to %s — the input is refused with no request',
    async (_label, value) => {
      const { impl, calls } = githubFetch();
      await expect(
        resolveInputs(
          [{ name: 'ticket', kind: 'github', required: true }],
          { ticket: { value } },
          { fetchImpl: impl, github: { token: 'ghp_stored_pat_0123456789' } },
        ),
      ).rejects.toThrow(/input "ticket": not a GitHub issue\/PR reference/);
      // Asserting ZERO calls, not "no Authorization header": a refusal that
      // fired after the fetch would already have leaked.
      expect(calls).toEqual([]);
    },
  );

  test('an owner / repo with dots in it is still a normal reference', async () => {
    const { impl, calls } = githubFetch();
    await resolveInputs(
      [{ name: 'ticket', kind: 'github' }],
      { ticket: { value: 'https://github.com/acme-org/widgets.js/issues/12' } },
      { fetchImpl: impl, github: { token: 'ghp_t' } },
    );
    expect(calls[0].url).toBe(
      'https://api.github.com/repos/acme-org/widgets.js/issues/12',
    );
  });
});

describe('a jira input takes what people paste', () => {
  const atlassian = { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' };
  const issue = (key: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ key, fields: { summary: 'from jira' } }),
  });

  test('plain text is the work itself — no Jira call, no credential needed', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'Add a dark mode toggle to the header' } },
      { fetchImpl },
    );
    expect(out.ticket).toContain('Add a dark mode toggle to the header');
    expect(out.ticket).toContain('there is no tracker issue');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a board link resolves the selected issue', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return issue('ABC-1');
    }) as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'https://x.atlassian.net/jira/software/projects/ABC/boards/6?selectedIssue=ABC-1' } },
      { fetchImpl, atlassian },
    );
    expect(urls[0]).toContain('/rest/api/3/issue/ABC-1?');
    expect(out.ticket).toContain('ABC-1 — from jira');
  });

  test('a GitHub issue link resolves through GitHub', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ number: 7, title: 'gh issue', body: 'details' }) };
    }) as unknown as typeof fetch;
    const out = await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'https://github.com/acme/web/issues/7' } },
      { fetchImpl },
    );
    expect(urls[0]).toBe('https://api.github.com/repos/acme/web/issues/7');
    expect(out.ticket).toContain('gh issue');
  });

  test('a missing Jira issue names the key and the account', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(
      resolveInputs([{ name: 'ticket', kind: 'jira' }], { ticket: { value: 'ABC-999' } }, { fetchImpl, atlassian }),
    ).rejects.toThrow('Jira has no issue ABC-999 that a@b.com can see');
  });
});

test('an attachment larger than its listed size is cut off at the cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-att-cap-'));
  const big = new Uint8Array(21 * 1024 * 1024);
  const fetchImpl = (async (url: string) => {
    if (url.includes('/attachment/content/')) {
      return { ok: true, status: 200, body: new Response(big).body, arrayBuffer: async () => big.buffer };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ key: 'ABC-9', fields: { summary: 's', attachment: [{ id: '1', filename: 'lies.bin', mimeType: 'application/octet-stream', size: 10 }] } }),
    };
  }) as unknown as typeof fetch;
  const out = await resolveInputs(
    [{ name: 'ticket', kind: 'jira' }],
    { ticket: { value: 'ABC-9' } },
    { fetchImpl, atlassian: { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' }, attachmentsDir: dir },
  );
  expect(out.ticket).toMatch(/lies\.bin .* download failed: over the \d+-byte limit/);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a jira input refuses what is neither a key, a link nor prose', () => {
  const atlassian = { site: 'https://jira.corp.example', email: 'a@b.com', token: 't' };
  const never = jest.fn() as unknown as typeof fetch;
  it.each(['PROJ123', 'PROJ 123', 'fix-it', 'header'])('"%s" is refused with the expected form', async raw => {
    await expect(
      resolveInputs([{ name: 'ticket', kind: 'jira' }], { ticket: { value: raw } }, { fetchImpl: never, atlassian }),
    ).rejects.toThrow(/is not a Jira key \(like ABC-123\)/);
  });

  it('a key with an underscore project is a key', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ key: 'MY_PROJ-12', fields: { summary: 's' } }) };
    }) as unknown as typeof fetch;
    await resolveInputs([{ name: 'ticket', kind: 'jira' }], { ticket: { value: 'MY_PROJ-12' } }, { fetchImpl, atlassian });
    expect(urls[0]).toContain('/rest/api/3/issue/MY_PROJ-12?');
  });

  it("a link on the connection's own Jira host is Jira, even without /browse/", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ key: 'ABC-1', fields: { summary: 's' } }) };
    }) as unknown as typeof fetch;
    await resolveInputs(
      [{ name: 'ticket', kind: 'jira' }],
      { ticket: { value: 'https://jira.corp.example/projects/ABC/issues/ABC-1' } },
      { fetchImpl, atlassian },
    );
    expect(urls[0]).toBe('https://jira.corp.example/rest/api/3/issue/ABC-1?fields=summary,description,status,issuetype,attachment');
  });
});

test('attachment folders older than a week are pruned on the next download', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-att-prune-'));
  const old = path.join(dir, 'OLD-1-x');
  const fresh = path.join(dir, 'NEW-1-y');
  await fs.mkdir(old);
  await fs.mkdir(fresh);
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  await fs.utimes(old, tenDaysAgo, tenDaysAgo);
  const fetchImpl = (async (url: string) =>
    url.includes('/attachment/content/')
      ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer }
      : {
          ok: true,
          status: 200,
          json: async () => ({ key: 'ABC-2', fields: { summary: 's', attachment: [{ id: '7', filename: 'a.txt', size: 1 }] } }),
        }) as unknown as typeof fetch;
  await resolveInputs(
    [{ name: 'ticket', kind: 'jira' }],
    { ticket: { value: 'ABC-2' } },
    { fetchImpl, atlassian: { site: 'https://x.atlassian.net', email: 'a@b.com', token: 't' }, attachmentsDir: dir },
  );
  const left = await fs.readdir(dir);
  expect(left).not.toContain('OLD-1-x');
  expect(left).toContain('NEW-1-y');
  await fs.rm(dir, { recursive: true, force: true });
});
