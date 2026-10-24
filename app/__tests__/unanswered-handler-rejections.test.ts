/**
 * A mounted handler must ANSWER, even when something above its own `try`
 * throws.
 *
 * connect's `call()` wraps only the SYNCHRONOUS invocation in a try/catch, so
 * in an `async` handler anything that throws or rejects outside the handler's
 * own `try` becomes a rejected promise connect never sees: `next(err)` never
 * runs, nothing is written, and the socket plus its `ServerResponse` stay
 * pinned. `installProcessGuards()` logs `unhandledRejection` and deliberately
 * does not exit, so every status surface stays healthy while the caller hangs
 * — and `server.close()` never completes, which leaves SIGKILL as the only
 * exit and strands `running` rows until their lease expires.
 *
 * `/api/concurrency` has its own guard for the `decodeURIComponent` spelling
 * of this (see concurrency-malformed-path.test.ts) and is kept here as the
 * control. Three more sites carry the shape, and the agent-queue owner
 * scoping adds a fourth — a `store.getRunSummary` above the handler's only
 * `try`:
 *
 *   - `new URL(req.url, …)` on an absolute-form request target whose
 *     authority WHATWG rejects but connect's router accepts
 *     (`GET http://1.2.3.4.5/api/credentials`) — unauthenticated, free, and
 *     one pinned socket per hit;
 *   - `await store.getRunSummary(...)` as the owner gate of
 *     `/api/runs/:id/{events,cancel,stop,…}` — so the lever an operator
 *     reaches for to stop a wedged run HANGS under the SQLITE_BUSY or
 *     Postgres statement timeout a loaded store routinely produces, instead
 *     of answering 500;
 *   - the same read in `/api/agent-queue`, where it resolves each waiter's
 *     owning run (so it needs a waiter to be reached at all).
 *
 * The last case is pinned with store fault injection rather than fs fault
 * injection because the store is the injected dependency: `mount.store` IS
 * the object the mount closes over, so arming one method reproduces a store
 * that starts failing mid-life.
 *
 * The last test is the rule itself, kept as code: every async mounted handler
 * either keeps its risky work inside its `try`, or is registered through
 * `answered()`. That is what stops the class coming back.
 */

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import connect from 'connect';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import { agentSlots, type Release } from '../src/llm/concurrency';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  type Mount,
} from './lifecycle-harness.helpers';

jest.setTimeout(60_000);

/** One request down a fresh socket. Resolves `null` when no response head
 *  ever arrives inside the budget — a hang, not a status. Raw `http.request`,
 *  not `fetch`: `fetch` normalises an absolute-form target away. Local rather
 *  than raw-request.helpers.ts's `rawRequest`, which has no deadline — it
 *  never settles for the shape this file is about. */
function rawRequest(
  baseUrl: string,
  method: string,
  rawPath: string,
  budgetMs = 1_500,
): Promise<number | null> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise(resolve => {
    let settled = false;
    let budget: ReturnType<typeof setTimeout>;
    const done = (v: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      resolve(v);
    };
    const req = http.request(
      { host: hostname, port, method, path: rawPath, agent: false },
      res => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      },
    );
    req.on('error', () => done(null));
    // Cleared on the answer: an uncleared budget timer is an open handle
    // that outlives the test.
    budget = setTimeout(() => {
      req.destroy();
      done(null);
    }, budgetMs);
    req.end();
  });
}

describe('a handler rejection above the try still answers', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    mount = await mountServer(await makeWorkspace('unanswered'));
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('CONTROL: the healthy shapes answer', async () => {
    expect(await rawRequest(mount.baseUrl, 'GET', '/api/credentials')).toBe(200);
    expect(await rawRequest(mount.baseUrl, 'POST', '/api/runs/nope/cancel')).toBe(404);
    expect(await rawRequest(mount.baseUrl, 'GET', '/api/runs/nope/events')).toBe(404);
    expect(await rawRequest(mount.baseUrl, 'GET', '/api/agent-queue')).toBe(200);
  });

  it('an absolute-form target whose authority is not a URL is answered, not hung', async () => {
    // `GET http://1.2.3.4.5/api/credentials`: connect's router reads the
    // pathname with the legacy parser (which accepts it) and hands the
    // handler `http://1.2.3.4.5`, which `new URL` refuses.
    //
    // What matters here is "answered at all" — an unanswered request leaks
    // the socket and its ServerResponse for the process lifetime. The code
    // is 400: the canonical-path guard refuses a target no parser in the
    // chain can read, ahead of the handler whose `new URL` would throw. A
    // malformed request target is the client's error, not the server's, and
    // refusing it early means no handler has to carry the case.
    for (const target of [
      'http://1.2.3.4.5/api/credentials',
      'http://h:99999/api/credentials',
    ]) {
      const status = await rawRequest(mount.baseUrl, 'GET', target);
      expect(`${target} → ${status}`).toBe(`${target} → 400`);
    }
  });

  it('a store that starts rejecting answers 500 on the cancel lever, the SSE stream and the queue', async () => {
    const real = mount.store.getRunSummary.bind(mount.store);
    (mount.store as unknown as { getRunSummary: unknown }).getRunSummary = () =>
      Promise.reject(new Error('SQLITE_BUSY: database is locked'));
    try {
      // These reach the owner gate (the first statement of the handler) and
      // never get as far as any `try` of their own.
      expect(
        await rawRequest(mount.baseUrl, 'POST', '/api/runs/wedged/cancel'),
      ).toBe(500);
      expect(
        await rawRequest(mount.baseUrl, 'POST', '/api/runs/wedged/stop'),
      ).toBe(500);
      expect(
        await rawRequest(mount.baseUrl, 'GET', '/api/runs/wedged/events'),
      ).toBe(500);
      // No drift: the route that was already fixed keeps answering, and so
      // do the surfaces that do not take this read.
      expect(await rawRequest(mount.baseUrl, 'GET', '/api/concurrency/%')).toBe(200);
      expect(await rawRequest(mount.baseUrl, 'GET', '/api/health')).toBe(200);
    } finally {
      (mount.store as unknown as { getRunSummary: unknown }).getRunSummary = real;
    }
  });

  // Weaker than it looks, and kept as a no-drift check rather than a pin:
  // the client above gives up and destroys its socket at the budget, which
  // releases the request either way. concurrency-malformed-path.test.ts owns
  // the shutdown assertion for a request that is never answered at all.
  it('and the server can still shut down gracefully afterwards', async () => {
    const closed = await Promise.race([
      new Promise<boolean>(resolve => mount.server.close(() => resolve(true))),
      new Promise<boolean>(resolve => {
        setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    expect(closed).toBe(true);
  });
});

// The agent-queue read only reaches the store when the queue is NOT empty —
// it resolves the owning run of each waiter — so this case needs the global
// agent cap saturated with a waiter that names a run.
describe('/api/agent-queue with a waiter answers when the store rejects', () => {
  let server: http.Server;
  let store: SqliteRunStore;
  let baseUrl: string;
  let tmpRoot: string;
  let restoreEnv: () => void;
  let prevLimit: number;
  let queued: Promise<Release>;
  const released: Release[] = [];

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('unanswered-queue');
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    await store.upsertRun({
      id: 'queued-run',
      orchestrationName: 'some-orch',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      ownerId: 'alice',
    });
    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        config: { root: path.join(tmpRoot, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    prevLimit = agentSlots.limit;
    agentSlots.setLimit(1);
    released.push(await agentSlots.acquire({ runId: 'holder' }));
    queued = agentSlots.acquire({
      runId: 'queued-run',
      orchestrationName: 'some-orch',
      phaseName: 'p',
    });
  });

  afterAll(async () => {
    agentSlots.setLimit(prevLimit);
    for (const r of released) r();
    // The waiter's acquire only resolves once the holder above lets go, so
    // release it here rather than leaving a pending grant past teardown.
    (await queued)();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    restoreEnv?.();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('CONTROL: the queue read answers, and the waiter is there', async () => {
    expect(await rawRequest(baseUrl, 'GET', '/api/agent-queue')).toBe(200);
    const body = (await (
      await fetch(`${baseUrl}/api/agent-queue`)
    ).json()) as { waiting: number };
    expect(body.waiting).toBeGreaterThan(0);
  });

  it('answers the GET and the reorder POST when the owner read rejects', async () => {
    const real = store.getRunSummary.bind(store);
    (store as unknown as { getRunSummary: unknown }).getRunSummary = () =>
      Promise.reject(new Error('SQLITE_BUSY: database is locked'));
    try {
      expect(await rawRequest(baseUrl, 'GET', '/api/agent-queue')).toBe(500);
      expect(await rawRequest(baseUrl, 'POST', '/api/agent-queue/reorder')).toBe(500);
    } finally {
      (store as unknown as { getRunSummary: unknown }).getRunSummary = real;
    }
  });
});

// ── The rule, as code ────────────────────────────────────────────────────────
describe('no mounted handler can reject unanswered', () => {
  /** Every `middlewares.use(..., async (…) => {` in the API file, with the
   *  line of its first `try` and of anything that can throw above it. Brace
   *  depth over the handler body, strings and comments blanked first. */
  function riskyAboveTry(): string[] {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'sammy-pack-api.ts'),
      'utf8',
    );
    const lines = src.split('\n');
    const RISK: Array<[RegExp, string]> = [
      [/\bawait\b/, 'await'],
      [/decodeURIComponent\s*\(/, 'decodeURIComponent'],
      [/JSON\.parse\s*\(/, 'JSON.parse'],
      [/new URL\s*\(/, 'new URL'],
    ];
    const blank = (l: string): string =>
      l
        .replace(/\/\/.*$/, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const found: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('middlewares.use(')) continue;
      const head = lines.slice(i, i + 4).join('\n');
      if (!/async\s*\(/.test(head)) continue;
      // Registered through the wrapper ⇒ answered by construction.
      if (/answered\(\s*async/.test(head)) continue;
      const mount = /middlewares\.use\(\s*'([^']*)'/.exec(head)?.[1] ?? '?';
      let depth = 0;
      let started = false;
      let sawTry = false;
      for (let j = i; j < lines.length; j++) {
        const code = blank(lines[j]);
        if (!started) {
          if (code.includes('{')) started = true;
          else continue;
        }
        depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
        if (j > i && !sawTry) {
          if (/(^|[\s)])try\s*\{/.test(code)) sawTry = true;
          else {
            for (const [re, label] of RISK) {
              if (re.test(code)) {
                found.push(`${mount} (mount@${i + 1}): ${label} at line ${j + 1}`);
              }
            }
          }
        }
        if (started && depth <= 0 && j > i) break;
      }
    }
    return found;
  }

  it('every async mounted handler is either try-covered or answered()-wrapped', () => {
    // A failure here is not style: whatever is listed can reject into a
    // pinned socket. Either move it inside the handler's `try`, or register
    // the handler through `answered()`.
    expect(riskyAboveTry()).toEqual([]);
  });
});
