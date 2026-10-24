import { prepareHttpRequest } from '../src/llm/http-node';
import { scrubPayload } from '../src/server/payload-scrub';

describe('http url: values in the host position keep host:port and base+path working', () => {
  it('http://${host}/x with host "localhost:8080" (port in a host var)', () => {
    const r = prepareHttpRequest(
      { url: 'http://${input.host}/api/x', allowHosts: ['localhost'] },
      { input: '{"host":"localhost:8080"}' },
      {} as never,
      [],
    );
    expect(r.url).toBe('http://localhost:8080/api/x');
  });
  it('${base}${path} where base has no path', () => {
    const r = prepareHttpRequest(
      { url: '${input.base}${input.path}', allowHosts: ['api.example.com'] },
      { input: '{"base":"https://api.example.com","path":"/v1/users"}' },
      {} as never,
      [],
    );
    expect(r.url).toBe('https://api.example.com/v1/users');
  });
});

describe('form detection: percent-encoded and +-encoded keys are still forms', () => {
  it('bracket-encoded key (jQuery $.param / Rails) hides an email from the detector', () => {
    const body = 'user%5Bemail%5D=jane%40example.com&user%5Bname%5D=Jane';
    const out = scrubPayload(body, {}).body;
    expect(out).not.toMatch(/jane(%40|@)example\.com/i);
  });
  it('a key with an encoded space (first+name) does the same', () => {
    const body = 'first+name=Jane&email=jane%40example.com';
    const out = scrubPayload(body, {}).body;
    expect(out).not.toMatch(/jane(%40|@)example\.com/i);
  });
  it('control: plain keys are still decoded and scrubbed', () => {
    const out = scrubPayload('email=jane%40example.com', {}).body;
    expect(out).not.toMatch(/jane(%40|@)example\.com/i);
  });
});
