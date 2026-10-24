/**
 * Standalone production server (the serving tier).
 *
 * Mounts the IDENTICAL API surface the Vite dev plugin serves — REST, triggers,
 * webhooks, SSE run streams, A2A — onto a plain Node `http.Server` + connect
 * stack via `mountSammyApi`, and serves the built SPA from `web-dist`. This is
 * what closes the "ingress is dev-server-only" gap: a real server you can run in
 * production without `vite dev`.
 *
 *   npm run build:web                 # produce web-dist/
 *   DATABASE_URL=postgres://…  PORT=8080  npm run serve
 *
 * Pairs with the standalone worker (worker.ts): run several of each against one
 * Postgres for horizontal scale; the run lease (+ fencing) keeps execution
 * single-writer per run. Env: PORT / SAMMY_PORT, SAMMY_REPO_ROOT, plus
 * everything mountSammyApi honors (DATABASE_URL, SAMMY_JWT_*, SAMMY_API_TOKEN,
 * SAMMY_DISABLE_INPROCESS_WORKER, …).
 */

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, parse as legacyUrlParse } from 'node:url';
import connect from 'connect';
import { mountSammyApi } from './sammy-pack-api';
import { describeBind, readPostureFromEnv } from './src/server/bind-host';
import { resolveStaticFile } from './src/server/static-spa';
import { installProcessGuards } from './src/server/process-guards';

const here = path.dirname(fileURLToPath(import.meta.url)); // …/app
const repoRootDir = process.env.SAMMY_REPO_ROOT
  ? path.resolve(process.env.SAMMY_REPO_ROOT)
  : path.resolve(here, '..'); // app -> repo root
const webDist = path.join(here, 'web-dist');
const port = Number(process.env.PORT || process.env.SAMMY_PORT || 5173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};
const mimeFor = (f: string): string =>
  MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

async function main(): Promise<void> {
  // Resilience: ignore client-disconnect socket errors (EPIPE / ECONNRESET) so
  // a client aborting mid-response can't crash the process and kill in-flight
  // runs. Installed here too (not only via mountSammyApi) so the guard is up
  // before anything starts serving. Idempotent — the mount's call is a no-op.
  installProcessGuards();

  const app = connect();
  // CONNECT ITSELF THROWS ON A MALFORMED REQUEST TARGET, before any
  // middleware runs — so no gate inside `mountSammyApi` can answer it.
  // `GET http://[/api/credentials` reaches `parseurl` (connect/index.js
  // `next()` → parseurl → the legacy `url.parse`), which raises
  // ERR_INVALID_URL synchronously out of the server's request listener.
  // Node does not catch that: nothing is written, and the socket plus its
  // ServerResponse leak for the process lifetime — an unauthenticated
  // request that costs the server a handle, on EVERY path including `/`.
  //
  // This is the one seam above connect that the repo owns, so the guard
  // lives here: answer 400 and do not dispatch. Kept to exactly what
  // connect cannot survive (a target its own parser refuses) — every other
  // non-canonical spelling is the /api guard's business, where it is
  // testable. The vite dev plugin shares `mountSammyApi` but not this file;
  // that path only ever serves a developer's own machine.
  const httpServer = http.createServer((req, res) => {
    try {
      // The same call connect reaches, made directly: `parseurl` is only a
      // transitive dependency, but what it runs is node:url's legacy
      // `parse` — so this probes the exact parser that throws, without
      // depending on connect's dep tree. Deprecated by Node, and
      // deliberately so: the WHATWG `URL` accepts and rejects a different
      // set, and the set that matters here is the one connect cannot
      // survive.
      legacyUrlParse(req.url ?? '/');
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/plain');
      res.end('Bad Request — malformed request target\n');
      return;
    }
    app(req, res);
  });

  // Mount the full API first so /api/* matches before the static fallback.
  // repoRoot() derives the repo root two levels above the Vite-style root
  // (app/web), so hand it back a path that resolves to the same place.
  await mountSammyApi({
    middlewares: app,
    config: { root: path.join(repoRootDir, 'app', 'web') },
    httpServer,
  });

  // Static SPA. GET/HEAD only; serve a built file when it exists, else fall
  // back to index.html so client-side routes resolve. Everything else falls
  // through to connect's default 404.
  app.use((req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();

    // Decoding and the traversal guard live in src/server/static-spa.ts: the
    // decode throws on a malformed escape (`GET /%`), and it used to run here
    // ABOVE the `serve().catch(...)` below, so a client-side error surfaced
    // as a 500.
    const target = resolveStaticFile(req.url ?? '/', webDist);
    if ('refuse' in target) {
      res.statusCode = target.refuse;
      return res.end(target.refuse === 400 ? 'Bad Request' : 'Forbidden');
    }
    const filePath = target.file;

    const send = (p: string): Promise<boolean> =>
      fs.readFile(p).then(
        buf => {
          res.statusCode = 200;
          res.setHeader('content-type', mimeFor(p));
          // index.html must always be revalidated — it names the current
          // build's hashed bundle, and a cached copy keeps running the OLD
          // app after an upgrade (no validators were sent, so browsers
          // cached it heuristically). The hashed files under /assets never
          // change content under one name, so they can be cached for good.
          res.setHeader(
            'cache-control',
            /[\\/]assets[\\/]/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
          res.end(method === 'HEAD' ? undefined : buf);
          return true;
        },
        () => false,
      );

    const serve = async () => {
      if (await send(filePath)) return;
      // SPA fallback to index.html for client-side routes.
      if (await send(path.join(webDist, 'index.html'))) return;
      res.statusCode = 404;
      res.end('Not found');
    };
    serve().catch(() => {
      res.statusCode = 500;
      res.end('Internal Server Error');
    });
  });

  // BIND ADDRESS — loopback by default.
  //
  // This was `listen(port, cb)` with no host, which binds 0.0.0.0 (every
  // interface) while the log line below said `localhost`, and SECURITY.md
  // said "the dev server binds locally". An operator who read either and
  // believed it published an API whose GET routes are unauthenticated by
  // design onto their network. Three surfaces agreed with each other and
  // disagreed with the code.
  //
  // Loopback is the safe default for the single-node posture this project
  // actually supports. A container MUST bind 0.0.0.0 or the published port
  // never reaches it, so the image sets SAMMY_BIND_HOST=0.0.0.0 explicitly —
  // which makes exposure a deliberate, greppable decision instead of the
  // silent default.
  const bindHost = process.env.SAMMY_BIND_HOST?.trim() || '127.0.0.1';
  httpServer.listen(port, bindHost, () => {
    // Print the REAL host and warn for ANY non-loopback bind — not only
    // 0.0.0.0 / ::. A specific interface (192.168.1.10) is just as reachable
    // from its network, and the old log line called it `localhost`.
    // The posture comes from the same variables the mount builds its gates
    // from — the flag ALONE used to be passed, so the warning claimed reads
    // were gated on a boot whose banner said "GATED IN NAME ONLY".
    const { url, warning } = describeBind(bindHost, port, readPostureFromEnv());
    console.log(`[serve] sammy-pack listening on ${url} (SPA: ${webDist})`);
    if (warning) console.warn(`[serve] ${warning}`);
  });

  // Graceful shutdown — closing the server fires the worker/store cleanup that
  // mountSammyApi registered on httpServer 'close'.
  const shutdown = (sig: string) => {
    console.log(`[serve] ${sig} — shutting down`);
    httpServer.close(() => process.exit(0));
    // Don't wait forever on lingering keep-alive sockets.
    const t = setTimeout(() => process.exit(0), 5_000);
    (t as unknown as { unref?: () => void }).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[serve] fatal:', err);
  process.exit(1);
});
