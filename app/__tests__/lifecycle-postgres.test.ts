/**
 * THE FULL TRIGGER PATH, ON POSTGRES.
 *
 * Skipped unless TEST_DATABASE_URL points at a throwaway Postgres:
 *
 *   docker compose -f docker-compose.test.yml up -d --wait postgres
 *   cd app && npm run test:postgres
 *
 * WHY THIS EXISTS SEPARATELY: every other lifecycle suite runs on SQLite and
 * always will — `pinTestEnv` clears DATABASE_URL and the harness's
 * `mountServer` constructs a `SqliteRunStore` directly. So nothing exercised
 * ingress → durable delivery → worker → run against Postgres, even though
 * the two backends' SQL is written twice and diverges exactly where it
 * matters (a partial unique index with a status predicate, an upsert whose DO
 * UPDATE carries a WHERE, `rowCount` from a fenced UPDATE). All of it
 * typechecks identically against either store, so a Postgres-only mistake is
 * invisible until it runs there.
 *
 * `postgres-store.test.ts` covers the store contract method by method; this
 * covers the whole path through a real mounted server.
 *
 * ISOLATION NOTE, learned the hard way: this database PERSISTS across tests
 * and runs, unlike the fresh-file SQLite suites. A header idempotency key
 * dedupes forever, so a fixed key makes the "first" fire of the second run a
 * duplicate of the first run's; `/api/runs` will hand back a completed run
 * from an earlier invocation; and whole-table sums do not start at zero.
 * Every assertion below is therefore keyed to this invocation or measured as
 * a delta.
 */

import connect from 'connect';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { mountSammyApi } from '../sammy-pack-api';
import { PostgresRunStore } from '../src/server/postgres-store';

jest.setTimeout(90_000);

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('lifecycle on Postgres: ingress → delivery → worker → run', () => {
  let store: PostgresRunStore;
  let server: http.Server;
  let baseUrl: string;
  let root: string;
  const ORCH = 'pg-lifecycle-hook';

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-pg-lifecycle-'));
    await fs.mkdir(path.join(root, 'examples'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'examples', `${ORCH}.json`),
      JSON.stringify({
        name: ORCH,
        triggers: [{ kind: 'webhook', path: ORCH, method: 'POST' }],
        phases: [{ name: 'echo', code: { source: "return 'ran:' + (input || '');" } }],
      }),
    );

    store = new PostgresRunStore(url as string);
    await store.init();
    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        config: { root: path.join(root, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(r => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(r => server?.close(() => r()));
    await store?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const getJson = async <T>(p: string): Promise<T> =>
    (await (await fetch(`${baseUrl}${p}`)).json()) as T;

  it('uses the Postgres backend (not a silent SQLite fallback)', () => {
    // Without this the whole suite could pass against SQLite and prove
    // nothing about the backend it claims to cover.
    expect(store.backend).toBe('postgres');
  });

  it('registers the trigger from the workspace', async () => {
    const rows = await getJson<Array<{ orchestration: string }>>('/api/triggers');
    expect(rows.some(r => r.orchestration === ORCH)).toBe(true);
  });

  it('a fire reaches a completed run, and a repeat of the key dedupes', async () => {
    // Unique per invocation — a header key dedupes forever, and this database
    // still holds the previous run's rows.
    const key = `pg-life-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const preexisting = new Set(
      (await getJson<Array<{ id: string }>>('/api/runs')).map(r => r.id),
    );
    const dupBaseline = await store.sumDuplicatesSuppressed();

    const fire = () =>
      fetch(`${baseUrl}/api/triggers/${ORCH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ hello: 'postgres' }),
      });

    const first = await fire();
    expect([200, 202]).toContain(first.status);
    const repeat = await fire();
    expect(await repeat.json()).toMatchObject({ duplicate: true });

    // Wait for a run THIS invocation created.
    const deadline = Date.now() + 60_000;
    let run: { id: string; status: string; initialInput?: string } | undefined;
    while (Date.now() < deadline) {
      run = (
        await getJson<
          Array<{
            id: string;
            orchestrationName: string;
            status: string;
            initialInput?: string;
          }>
        >('/api/runs')
      ).find(
        r =>
          r.orchestrationName === ORCH &&
          r.status === 'done' &&
          !preexisting.has(r.id),
      );
      if (run) break;
      await new Promise(r => setTimeout(r, 150));
    }
    expect(run).toBeDefined();
    expect(run!.initialInput ?? '').toContain('postgres');

    // The delivery: fired, linked, fenced, and counting the suppressed repeat.
    const delivery = (await store.listDeliveries(500)).find(d => d.runId === run!.id);
    expect(delivery?.status).toBe('fired');
    // claimToken > 0 proves the claim went through the fenced path.
    expect(delivery?.claimToken).toBeGreaterThan(0);
    expect(delivery?.duplicateCount).toBe(1);

    const stats = await getJson<{ duplicatesSuppressed: number }>(
      '/api/deliveries/stats',
    );
    expect(stats.duplicatesSuppressed - dupBaseline).toBe(1);
  });

  it('a 404 for an unregistered trigger name, not a silent accept', async () => {
    const res = await fetch(`${baseUrl}/api/triggers/not-a-real-trigger`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });
});
