/**
 * Raw-request-target helper.
 *
 * `fetch` cannot express the two path spellings the gates have to agree with
 * the handlers about: it normalises an absolute-form request target
 * (`GET http://host/api/... HTTP/1.1`) down to its path, and it will not emit
 * one at all. `node:http` writes the request line from the `path` option
 * verbatim, so these cases reach the wire exactly as a hand-crafted client
 * (or `curl --request-target`) would send them.
 *
 * Lives beside lifecycle-harness.helpers.ts, and like it carries a self-test
 * at the bottom — the jest preset's testMatch picks up every .ts file in this
 * directory and fails a suite that contains no test.
 */

import http from 'node:http';

export type RawResponse = { status: number; body: string };

/** Issue `method target` against `baseUrl` with the target used VERBATIM as
 *  the request line's path. */
export function rawRequest(
  baseUrl: string,
  target: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        host: hostname,
        port: Number(port),
        method: opts?.method ?? 'GET',
        path: target,
        headers: opts?.headers,
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    if (opts?.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** The absolute-form spelling of `path` for a server reachable at `baseUrl` —
 *  the request target connect strips its mount from by LENGTH, so the
 *  protohost survives into the `req.url` every gate reads. */
export function absoluteForm(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

describe('raw-request helpers', () => {
  it('sends the request target verbatim — fetch normalises both spellings away', async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      expect((await rawRequest(baseUrl, '/a//b/c')).status).toBe(204);
      expect((await rawRequest(baseUrl, absoluteForm(baseUrl, '/a/b'))).status).toBe(204);
      await fetch(`${baseUrl}/a/b`);
      expect(seen).toEqual(['/a//b/c', `${baseUrl}/a/b`, '/a/b']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
