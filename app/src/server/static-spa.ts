/**
 * static-spa — the request-path → file-path decision the standalone server's
 * SPA handler makes, and the two reasons it refuses outright.
 *
 * Pure (a url + a root in, a decision out) so it is unit-testable without
 * binding a socket — `serve.ts` runs `main()` at import and cannot be loaded
 * by a test, the same reason `bind-host.ts` exists.
 */

import path from 'node:path';

/** Either the file to attempt, or the status to refuse with: 400 for a
 *  request path that is not decodable, 403 for one that escapes the root. */
export type StaticTarget = { file: string } | { refuse: 400 | 403 };

/**
 * Resolve a request url to a file inside `webDist`.
 *
 * The decode is INSIDE the error handling. `decodeURIComponent('/%')` throws
 * `URIError`, and the decode used to sit above the handler's own rejection
 * handling, so a malformed escape — the client's error — came back as
 * connect's 500 and read as a server fault in the log.
 */
export function resolveStaticFile(url: string, webDist: string): StaticTarget {
  let rel: string;
  try {
    rel = decodeURIComponent(url.split('?')[0]);
  } catch {
    return { refuse: 400 };
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(webDist, rel);
  // Path-traversal guard: the resolved path must stay inside web-dist.
  if (file !== webDist && !file.startsWith(webDist + path.sep)) {
    return { refuse: 403 };
  }
  return { file };
}
