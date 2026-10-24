import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  hostAllowed,
  performHttpRequest,
  prepareHttpRequest,
  statusOk,
  validateHttpBody,
} from '../src/llm/http-node';

const conns = {
  tracker: { kind: 'generic', value: 'sekret-token-123', fields: { base: 'https://api.example.com' } },
} as never;

describe('prepareHttpRequest', () => {
  it('interpolates state, resolves connection refs, and JSON-encodes an object body', () => {
    const r = prepareHttpRequest(
      {
        url: 'https://api.example.com/groups/${input.id}',
        method: 'PATCH',
        headers: { authorization: 'Bearer ${connections:tracker.value}' },
        body: { status: 'ticketed', key: '${ticket}', count: '${n}', note: 'ok ${ticket}' },
        allowHosts: ['api.example.com'],
      },
      { input: '{"id":42}', ticket: 'ABC-1', n: 7 },
      conns,
      [],
    );
    expect(r.url).toBe('https://api.example.com/groups/42');
    expect(r.headers.authorization).toBe('Bearer sekret-token-123');
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body!)).toEqual({ status: 'ticketed', key: 'ABC-1', count: 7, note: 'ok ABC-1' });
    expect(r.secrets).toEqual(['sekret-token-123']);
  });

  it('resolves a connection ref inside a JSON body leaf from the template', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.example.com/x', method: 'POST', body: { token: '${connections:tracker.value}' }, allowHosts: ['api.example.com'] },
      {},
      conns,
      [],
    );
    expect(JSON.parse(r.body!)).toEqual({ token: 'sekret-token-123' });
    expect(r.secrets).toEqual(['sekret-token-123']);
  });

  it('never resolves a connection ref embedded in run DATA, in url, header or body', () => {
    const data = { input: 'x ${connections:tracker.value} y' };
    const r = prepareHttpRequest(
      {
        url: 'https://api.example.com/q?v=${input}',
        method: 'POST',
        headers: { 'x-note': 'n ${input}' },
        body: { a: 'pre ${input}', b: '${input}' },
        allowHosts: ['api.example.com'],
      },
      data,
      conns,
      [],
    );
    expect(JSON.stringify(r)).not.toContain('sekret');
  });

  it('never resolves a connection ref that arrives in run DATA', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.example.com/x', method: 'POST', body: { title: '${input}' }, allowHosts: ['api.example.com'] },
      { input: '${connections:tracker.value}' },
      conns,
      [],
    );
    expect(r.body).toContain('${connections:tracker.value}');
    expect(r.body).not.toContain('sekret');
    expect(r.secrets).toEqual([]);
  });

  it('refuses hosts that are not allowlisted, and requires an allowlist', () => {
    const spec = { url: 'https://${input}/x' };
    expect(() => prepareHttpRequest(spec, { input: 'evil.example.net' }, conns, ['api.example.com'])).toThrow(
      /host "evil.example.net" is not allowed/,
    );
    expect(() => prepareHttpRequest(spec, { input: 'api.example.com' }, conns, [])).toThrow(/no allowed hosts/);
  });

  it('refuses non-http schemes and userinfo', () => {
    expect(() =>
      prepareHttpRequest({ url: 'file:///etc/passwd', allowHosts: [''] as string[] }, {}, conns, ['x']),
    ).toThrow(/only http\(s\)/);
    expect(() =>
      prepareHttpRequest({ url: 'https://u:p@api.example.com/' }, {}, conns, ['api.example.com']),
    ).toThrow(/credentials in the URL/);
  });

  it('never echoes a resolved credential in a refusal message', () => {
    let caught: { message: string; secrets?: string[] } | undefined;
    try {
      prepareHttpRequest(
        { url: 'https://${input}.example.com/v1?key=${connections:tracker.value}' },
        { input: 'a b' },
        conns,
        ['api.example.com'],
      );
    } catch (e) {
      caught = e as { message: string; secrets?: string[] };
    }
    expect(caught?.message).toMatch(/not an absolute URL/);
    expect(caught?.message).not.toContain('sekret');
    expect(caught?.secrets).toEqual(['sekret-token-123']);
  });

  it('refuses to send a request with an unresolved reference', () => {
    expect(() =>
      prepareHttpRequest({ url: 'https://api.example.com/${missing}' }, {}, conns, ['api.example.com']),
    ).toThrow(/unresolved reference\(s\) \$\{missing\}/);
    expect(() =>
      prepareHttpRequest(
        { url: 'https://api.example.com/x', method: 'POST', body: { k: 'v ${nope}' } },
        {},
        conns,
        ['api.example.com'],
      ),
    ).toThrow(/unresolved/);
  });

  it('encodes values in the path and query so a payload cannot rewrite the path', () => {
    const r = prepareHttpRequest(
      { url: '${base}/groups/${id}?q=${input}' },
      { base: 'https://api.example.com', id: 'a b/c', input: '../../admin?x=1&y' },
      conns,
      ['api.example.com'],
    );
    expect(r.url).toBe('https://api.example.com/groups/a%20b/c?q=..%2F..%2Fadmin%3Fx%3D1%26y');
    expect(() =>
      prepareHttpRequest(
        { url: 'https://api.example.com/groups/${input}' },
        { input: '../../admin' },
        conns,
        ['api.example.com'],
      ),
    ).toThrow(/"\.\." segment/);
  });
});

describe('prepareHttpRequest — auth.basic and files', () => {
  const jira = {
    jira: { kind: 'jira', value: 'tök-123', fields: { email: 'bot@example.test' } },
  } as never;

  it('builds a Basic header from template credentials and treats it as a secret', () => {
    const r = prepareHttpRequest(
      {
        url: 'https://site.example.test/rest',
        auth: { basic: { username: '${connections:jira.fields.email}', password: '${connections:jira.value}' } },
        allowHosts: ['site.example.test'],
      },
      {},
      jira,
      [],
    );
    const expected = Buffer.from('bot@example.test:tök-123', 'utf8').toString('base64');
    expect(r.headers.Authorization).toBe(`Basic ${expected}`);
    expect(r.secrets).toEqual(expect.arrayContaining(['tök-123', expected]));
  });

  it('refuses auth.basic together with an Authorization header', () => {
    expect(() =>
      prepareHttpRequest(
        { url: 'https://x.example.test/', headers: { authorization: 'Bearer y' }, auth: { basic: { username: 'a', password: 'b' } } },
        {},
        jira,
        ['x.example.test'],
      ),
    ).toThrow(/not both/);
  });

  it('turns files + an object body into a multipart form spec', () => {
    const r = prepareHttpRequest(
      {
        url: 'https://x.example.test/upload',
        method: 'POST',
        body: { comment: 'from ${who}' },
        files: [{ artifact: 'repro-log' }, { artifact: 'map[1]/x', field: 'extra', filename: '${who}.log' }],
      },
      { who: 'run-7' },
      jira,
      ['x.example.test'],
    );
    expect(r.body).toBeUndefined();
    expect(r.form).toEqual({
      fields: { comment: 'from run-7' },
      files: [
        { field: 'file', artifact: 'repro-log', filename: 'repro-log.txt' },
        { field: 'extra', artifact: 'map[1]/x', filename: 'run-7.log' },
      ],
    });
  });

  it('refuses files on GET, with a string body, or with a hand-set content-type', () => {
    const base = { url: 'https://x.example.test/u', files: [{ artifact: 'a' }] };
    expect(() => prepareHttpRequest({ ...base }, {}, jira, ['x.example.test'])).toThrow(/non-GET/);
    expect(() =>
      prepareHttpRequest({ ...base, method: 'POST', body: 'raw' }, {}, jira, ['x.example.test']),
    ).toThrow(/body must be an object/);
    expect(() =>
      prepareHttpRequest({ ...base, method: 'POST', headers: { 'Content-Type': 'text/plain' } }, {}, jira, ['x.example.test']),
    ).toThrow(/content-type/);
  });
});

describe('hostAllowed / statusOk', () => {
  it('matches exact hosts and *.subdomain wildcards (not the apex)', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('API.Example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('badexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('api.example.com.evil.net', ['api.example.com'])).toBe(false);
  });
  it('defaults to 2xx, or exactly the listed codes', () => {
    expect(statusOk(204)).toBe(true);
    expect(statusOk(302)).toBe(false);
    expect(statusOk(404, [404, 200])).toBe(true);
    expect(statusOk(200, [201])).toBe(false);
  });
});

describe('performHttpRequest', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' });
        return res.end();
      }
      if (req.url === '/big') return res.end('x'.repeat(10_000));
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2_000);
        return;
      }
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization })));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>(r => server.close(() => r()));
  });

  const prep = (path: string, extra: object = {}) =>
    prepareHttpRequest({ url: `${base}${path}`, ...extra }, {}, conns, ['127.0.0.1']);

  it('sends the request and returns status + body', async () => {
    const r = await performHttpRequest(prep('/echo', { method: 'POST', body: 'hello' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ method: 'POST', body: 'hello' });
  });

  it('sends files as multipart parts with their content', async () => {
    const req = prepareHttpRequest(
      { url: `${base}/echo`, method: 'POST', body: { note: 'hi' }, files: [{ artifact: 'log', filename: 'r.txt' }] },
      {},
      conns,
      ['127.0.0.1'],
    );
    const r = await performHttpRequest(req, {
      fileContent: name => (name === 'log' ? { text: 'LINE ONE\nLINE TWO', mediaType: 'text/plain' } : undefined),
    });
    const got = JSON.parse(r.body) as { body: string };
    expect(got.body).toContain('name="note"');
    expect(got.body).toContain('filename="r.txt"');
    expect(got.body).toContain('LINE ONE\nLINE TWO');
    await expect(performHttpRequest(req, { fileContent: () => undefined })).rejects.toThrow(/no artifact named "log"/);
  });

  it('does not follow redirects', async () => {
    const r = await performHttpRequest(prep('/redirect'));
    expect(r.status).toBe(302);
  });

  it('caps the response size', async () => {
    const r = await performHttpRequest(prep('/big'), { maxResponseBytes: 100 });
    expect(r.body).toHaveLength(100);
    expect(r.truncated).toBe(true);
  });

  it('times out', async () => {
    await expect(performHttpRequest(prep('/slow'), { timeoutSeconds: 0.2 })).rejects.toThrow(/timed out/);
  });

  it('aborts on the caller signal', async () => {
    const ac = new AbortController();
    const p = performHttpRequest(prep('/slow'), { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('run cancelled')), 50);
    await expect(p).rejects.toThrow(/run cancelled/);
  });
});

describe('validateHttpBody', () => {
  it('accepts a full spec and names bad fields', () => {
    expect(
      validateHttpBody({
        url: 'https://x/y',
        method: 'POST',
        headers: { a: 'b' },
        body: { k: 1 },
        allowHosts: ['x'],
        expectStatus: [200, 409],
        timeoutSeconds: 5,
        maxResponseBytes: 100,
      }),
    ).toEqual([]);
    const p = validateHttpBody({ method: 'TRACE', headers: { a: 1 }, expectStatus: [99], extra: 1 }).join('\n');
    expect(p).toMatch(/http.url is required/);
    expect(p).toMatch(/http.method must be/);
    expect(p).toMatch(/headers must be an object of string/);
    expect(p).toMatch(/expectStatus/);
    expect(p).toMatch(/http.extra is not a known option/);
  });
});
