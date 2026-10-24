/**
 * The shipped server answers a request target connect cannot parse.
 *
 * `GET http://[/api/credentials` never reaches a middleware: connect's own
 * `next()` calls `parseurl`, which calls node:url's legacy `parse`, which
 * raises ERR_INVALID_URL synchronously out of the server's request listener.
 * Node does not catch that — nothing is written, and the socket plus its
 * `ServerResponse` leak for the process lifetime. One unauthenticated
 * request, one permanently held handle, on EVERY path including `/`.
 *
 * So this cannot be a mount-level test: `unanswered-handler-rejections`
 * covers the targets that DO reach a handler, and a `mountSammyApi` harness
 * reproduces the hang no matter what the API's own gates do. The guard lives
 * in serve.ts above connect, and serve.ts runs `main()` at import — so the
 * only honest way to test it is to run the real entry point as a subprocess
 * and speak HTTP to it, which is also exactly what the image does
 * (`node --import tsx serve.ts`).
 *
 * Skipped unless web-dist exists, because serve.ts serves the built SPA:
 * run `npm run build:web` first (CI's `check` job builds it in the same job
 * that runs the suite).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeWorkspace, waitFor } from './lifecycle-harness.helpers';

jest.setTimeout(120_000);

const APP_DIR = path.resolve(__dirname, '..');
const suite = existsSync(path.join(APP_DIR, 'web-dist')) ? describe : describe.skip;

/** Send a request target VERBATIM. `fetch` and even `http.request`'s own
 *  path handling normalise most odd spellings away, so the malformed target
 *  goes onto the socket by hand. Resolves null when nothing answers — which
 *  is the defect, not a test failure to be retried. */
function rawTarget(
  port: number,
  target: string,
  budgetMs = 5_000,
): Promise<{ status: number | null; body: string }> {
  return new Promise(resolve => {
    let settled = false;
    let acc = '';
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ status, body: acc });
    };
    const timer = setTimeout(() => done(null), budgetMs);
    sock.on('connect', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (b: Buffer) => {
      acc += b.toString('utf8');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(acc);
      if (m) done(Number(m[1]));
    });
    sock.on('error', () => done(null));
    sock.on('end', () => done(/^HTTP\/1\.1 (\d{3})/.test(acc) ? Number(/^HTTP\/1\.1 (\d{3})/.exec(acc)![1]) : null));
  });
}

suite('serve.ts answers a malformed request target', () => {
  let child: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    const workspace = await makeWorkspace('serve-malformed');
    // Port 0 is not an option (serve.ts reads PORT), so take a free one from
    // the OS and hand it over.
    port = await new Promise<number>(resolve => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    child = spawn('node', ['--import', 'tsx', 'serve.ts'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PORT: String(port),
        SAMMY_REPO_ROOT: workspace,
        SAMMY_BIND_HOST: '127.0.0.1',
        SAMMY_DISABLE_INPROCESS_WORKER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout?.on('data', (b: Buffer) => { log += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { log += b.toString('utf8'); });
    await waitFor(
      async () => {
        const r = await rawTarget(port, '/api/livez', 1_000);
        return r.status === 200 ? r : null;
      },
      'serve.ts listening',
      { timeoutMs: 90_000, intervalMs: 300 },
    ).catch(e => {
      throw new Error(`${String(e)}\n--- serve.ts output ---\n${log}`);
    });
  });

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
    });
  });

  it('refuses a target connect\'s own parser cannot read, instead of never answering', async () => {
    for (const target of [
      'http://[/api/credentials',
      'http://[/api/livez',
      'http://[/metrics',
      'http://[/',
    ]) {
      const r = await rawTarget(port, target);
      // `null` is the regression: no response at all, socket held forever.
      expect([target, r.status]).toEqual([target, 400]);
    }
  });

  it('makes the page revalidate and lets hashed assets cache for good', async () => {
    // index.html names the current build's bundle: cached, it keeps an
    // upgraded server's users on the old app. (Skips without a web build.)
    const page = await fetch(`http://127.0.0.1:${port}/`);
    if (page.status !== 200) return;
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const html = await page.text();
    const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
    if (!asset) return;
    const res = await fetch(`http://127.0.0.1:${port}${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('still serves the canonical paths, and the process is alive afterwards', async () => {
    // The guard must not have eaten ordinary traffic — and the four refusals
    // above must not have killed the server, which is the other half of the
    // defect (an uncaught throw in the request listener).
    expect((await rawTarget(port, '/api/livez')).status).toBe(200);
    expect((await rawTarget(port, '/api/readyz')).status).toBe(200);
    expect(child.exitCode).toBeNull();
  });
});
