import { prepareHttpRequest } from '../src/llm/http-node';
import { scrubPayload } from '../src/server/payload-scrub';

describe('http url rendering — path, query and host positions', () => {
  it('a slash-bearing path value (owner/repo) must stay a path, not %2F', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.github.com/repos/${input.repo}/issues', allowHosts: ['api.github.com'] },
      { input: '{"repo":"acme/widgets"}' },
      {} as never,
      [],
    );
    expect(r.url).toBe('https://api.github.com/repos/acme/widgets/issues');
  });

  it('a value in a query with no path before it is still encoded', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.example.com?q=${input.q}', allowHosts: ['api.example.com'] },
      { input: '{"q":"x&admin=true"}' },
      {} as never,
      [],
    );
    expect(new URL(r.url).searchParams.get('admin')).toBeNull();
  });

  it('a value appended right after the host cannot add a query, userinfo or ..', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.example.com${input.p}', allowHosts: ['api.example.com'] },
      { input: '{"p":"/admin/delete?all=1"}' },
      {} as never,
      [],
    );
    const u = new URL(r.url);
    expect(u.search).toBe('');
    expect(u.pathname).toBe('/admin/delete%3Fall%3D1');
    // `@` cannot turn the allowed host into userinfo for another host.
    expect(() =>
      prepareHttpRequest(
        { url: 'https://api.example.com${input.p}', allowHosts: ['api.example.com'] },
        { input: '{"p":"@evil.example.net/x"}' },
        {} as never,
        [],
      ),
    ).toThrow(/not (allowed|an absolute URL)/);
  });

  it('a path value cannot start a query or fragment', () => {
    const r = prepareHttpRequest(
      { url: 'https://api.example.com/groups/${input.id}/status', allowHosts: ['api.example.com'] },
      { input: '{"id":"7?admin=true#x"}' },
      {} as never,
      [],
    );
    const u = new URL(r.url);
    expect(u.search).toBe('');
    expect(u.hash).toBe('');
    expect(u.pathname).toBe('/groups/7%3Fadmin%3Dtrue%23x/status');
  });

  it('a path value may not climb with ..', () => {
    expect(() =>
      prepareHttpRequest(
        { url: 'https://api.example.com/repos/${input.repo}/issues', allowHosts: ['api.example.com'] },
        { input: '{"repo":"../../admin"}' },
        {} as never,
        [],
      ),
    ).toThrow(/\.\./);
  });
});

describe('form-body detection does not misread plain text', () => {
  it('a base64 text body survives scrub byte-for-byte', () => {
    const b64 = 'ab+c/dEF==';
    expect(scrubPayload(b64, {}).body).toBe(b64);
  });
  it('an unchanged form body is returned exactly as received', () => {
    const f = 'a=1&b=two%20words';
    expect(scrubPayload(f, {}).body).toBe(f);
  });
  it('a bare URL text body survives scrub', () => {
    const u = 'https://example.com/cb?a=1&b=2';
    expect(scrubPayload(u, {}).body).toBe(u);
  });
});
