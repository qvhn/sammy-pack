import pg from 'pg';
import { PostgresRunStore } from '../src/server/postgres-store';
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('concurrent init on a COLD schema', () => {
  it('N processes provisioning at once all succeed', async () => {
    // The race only exists when the objects do NOT yet exist — otherwise
    // `IF NOT EXISTS` short-circuits and nothing contends. Start cold, the
    // way a brand-new deployment does.
    const admin = new pg.Pool({ connectionString: url as string });
    await admin.query(`
      DROP TABLE IF EXISTS events, trigger_deliveries, pending_fires,
        concurrency_group_locks, runs CASCADE`);
    await admin.end();

    const stores = Array.from({ length: 8 }, () => new PostgresRunStore(url as string));
    const results = await Promise.allSettled(stores.map(s => s.init()));
    const failed = results.filter(r => r.status === 'rejected');
    for (const s of stores) await s.close().catch(() => {});
    expect(failed.map(f => String((f as PromiseRejectedResult).reason))).toEqual([]);
  }, 60_000);
});
