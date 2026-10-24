/**
 * The standalone server's SPA handler answers a malformed request path.
 *
 * `decodeURIComponent('/%')` throws `URIError`, and the decode ran at the top
 * of the middleware — above the `serve().catch(...)` that handles everything
 * else — so connect turned a client-side error into a 500. One `async`
 * keyword away from the unanswered-request shape the /api routes had.
 *
 * The traversal guard is pinned here too: it is the other refusal the same
 * decision makes, and it had no test.
 */

import path from 'node:path';
import { resolveStaticFile } from '../src/server/static-spa';

const WEB_DIST = path.join('/srv', 'app', 'web-dist');

describe('resolveStaticFile', () => {
  it('a malformed escape is a 400, not a throw', () => {
    for (const url of ['/%', '/%zz', '/assets/%E0%A4%A', '/%?x=1']) {
      expect(`${url} → ${JSON.stringify(resolveStaticFile(url, WEB_DIST))}`).toBe(
        `${url} → {"refuse":400}`,
      );
    }
  });

  it('refuses a path that escapes the root with 403', () => {
    for (const url of ['/../secrets.env', '/assets/../../etc/passwd', '/%2e%2e/%2e%2e/x']) {
      expect(`${url} → ${JSON.stringify(resolveStaticFile(url, WEB_DIST))}`).toBe(
        `${url} → {"refuse":403}`,
      );
    }
  });

  it('resolves a real asset, the SPA root and a decoded name', () => {
    expect(resolveStaticFile('/assets/app.js', WEB_DIST)).toEqual({
      file: path.join(WEB_DIST, 'assets', 'app.js'),
    });
    expect(resolveStaticFile('/', WEB_DIST)).toEqual({
      file: path.join(WEB_DIST, 'index.html'),
    });
    expect(resolveStaticFile('/runs/123?tab=events', WEB_DIST)).toEqual({
      file: path.join(WEB_DIST, 'runs', '123'),
    });
    expect(resolveStaticFile('/assets/a%20b.css', WEB_DIST)).toEqual({
      file: path.join(WEB_DIST, 'assets', 'a b.css'),
    });
  });
});
