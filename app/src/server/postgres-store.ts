import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  assertDeliveryStatus,
  assertStatus,
  countConsecutiveFailuresNewestFirst,
  DEFAULT_LEASE_TTL_MS,
  derivePreviewFromEvents,
  interruptedEvent,
  LeaseLostError,
  type DeliveryInput,
  type DeliveryPatch,
  type DeliveryRecord,
  type DeliveryStatus,
  type PendingFire,
  type PendingFireRecord,
  summarizeRun,
  type Run,
  type RunHeader,
  type RunStatus,
  type RunStore,
  type RunStoreLeaseOpts,
  type RunSummary,
  type StoredEvent,
  type UpdateRunPatch,
  type UpsertRunInput,
} from './run-store';
import type { DegradationReason } from './degradation';
import { envPositiveInt } from './env';

/**
 * PostgresRunStore — the opt-in RunStore backend, activated when
 * `DATABASE_URL` is set. The enterprise / shared-deployment path: many
 * server processes can point at one Postgres and share runs, which is
 * also the substrate a multi-tenant layer sits on.
 *
 * Same schema shape as the SQLite backend — `runs` + append-only
 * `events` — with JSONB for the structured columns. Schema setup runs
 * idempotently on `init()` (CREATE TABLE IF NOT EXISTS), so pointing a
 * fresh server at an empty database just works.
 *
 * Module is server-only and is loaded lazily (dynamic import in
 * `openRunStore`) — the SQLite path never pulls in `pg`.
 */

// BIGINT (oid 20) defaults to a string in node-pg to avoid precision
// loss. Our bigints are millisecond timestamps — safely within
// Number.MAX_SAFE_INTEGER — so parse them straight to numbers.
pg.types.setTypeParser(20, v => (v == null ? null : Number(v)));

/** Stringify a value for a JSONB parameter (node-pg would format a raw
 *  JS array as a Postgres array literal, not JSON — so be explicit). */
function toJsonb(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function rowToHeader(row: Record<string, unknown>): RunHeader {
  const completed = row.completed_leaves;
  return {
    id: row.id as string,
    orchestrationName: row.orchestration_name as string,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    status: row.status as RunHeader['status'],
    orchestrationSnapshot: row.orchestration_snapshot ?? null,
    initialInput: (row.initial_input as string | null) ?? null,
    currentPath: row.current_path ?? null,
    stateJson: row.state_json ?? null,
    lastOutput: (row.last_output as string | null) ?? null,
    pausedFor: (row.paused_for as string | null) ?? null,
    completedLeaves: Array.isArray(completed)
      ? (completed as string[])
      : null,
    updatedAt: Number(row.updated_at),
    ownerId: (row.owner_id as string | null) ?? 'system',
    concurrencyGroup: (row.concurrency_group as string | null) ?? null,
    degraded: row.degraded === true,
    degradationReasons: Array.isArray(row.degradation_reasons)
      ? (row.degradation_reasons as DegradationReason[])
      : [],
  };
}

function rowToDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: row.id as string,
    kind: row.kind as string,
    name: row.name as string,
    orchestrationName: row.orchestration_name as string,
    idempotencyKey: row.idempotency_key as string,
    keySource: row.key_source as 'header' | 'auto' | 'window',
    status: row.status as DeliveryStatus,
    runId: (row.run_id as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
    ownerId: (row.owner_id as string | null) ?? 'system',
    receivedAt: Number(row.received_at),
    firedAt: row.fired_at == null ? null : Number(row.fired_at),
    attempts: row.attempts == null ? 0 : Number(row.attempts),
    duplicateCount: row.duplicate_count == null ? 0 : Number(row.duplicate_count),
    claimToken: row.claim_token == null ? 0 : Number(row.claim_token),
    availableAt: row.available_at == null ? 0 : Number(row.available_at),
    claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
    lastError: (row.last_error as string | null) ?? null,
    chainDepth: row.chain_depth == null ? 0 : Number(row.chain_depth),
  };
}

/** Advisory-lock key serialising schema provisioning across processes. An
 *  arbitrary constant — it only has to be stable and not collide with another
 *  application's advisory locks on the same database. */
const SCHEMA_LOCK_KEY = 0x5a4d_4d59; // "SMMY"

export class PostgresRunStore implements RunStore {
  readonly backend = 'postgres' as const;
  private pool: pg.Pool;
  /** This process's lease identity — stamped on runs it executes so a peer's
   *  boot scan can tell a live run from an orphaned one. */
  private readonly instanceId: string;
  private readonly leaseTtlMs: number;

  constructor(connectionString: string, opts?: RunStoreLeaseOpts) {
    this.pool = new pg.Pool({
      connectionString,
      // Every appendEvent takes a dedicated client for a multi-statement
      // transaction, so the pool size is the ceiling on concurrent event
      // persistence AND on API reads. node-pg's default of 10 is low for a
      // server that is also serving the UI; make it tunable.
      max: envPositiveInt('SAMMY_PG_POOL_MAX', 10),
      // Unset by default in node-pg, which means `pool.connect()` waits
      // FOREVER once the pool is saturated — a write that hangs with no
      // timeout at any layer, which the stall watchdogs cannot see because
      // the controller is blocked before it ever pulls from the generator.
      connectionTimeoutMillis: envPositiveInt('SAMMY_PG_CONNECT_TIMEOUT_MS', 10_000),
      idleTimeoutMillis: envPositiveInt('SAMMY_PG_IDLE_TIMEOUT_MS', 10_000),
      // Server-side cap so a pathological query cannot pin a client
      // indefinitely (the unbounded cost summary was one; there will be
      // others).
      statement_timeout: envPositiveInt('SAMMY_PG_STATEMENT_TIMEOUT_MS', 60_000),
    });
    // IDLE-CLIENT FAILURES MUST NOT KILL THE PROCESS.
    //
    // pg-pool emits 'error' on the POOL when an idle client dies — a
    // Postgres failover, an RDS maintenance window, an admin
    // `pg_terminate_backend`, a 57P01 admin shutdown. With no listener,
    // Node promotes that to an uncaughtException, and the process guard
    // exits(1): a routine failover became a hard crash that abandoned every
    // in-flight run. ECONNRESET/EPIPE were already swallowed by the guard;
    // these are not those.
    //
    // A dead idle client is not a fatal condition — the pool discards it and
    // the next acquire reconnects. Log it so the event is visible (it is
    // otherwise silent), and let the pool recover.
    this.pool.on('error', err => {
      console.error(
        '[postgres-store] idle client error (pool will reconnect):',
        err instanceof Error ? err.message : err,
      );
    });
    this.instanceId = opts?.instanceId ?? randomUUID();
    this.leaseTtlMs = opts?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /**
   * Connect + provision the schema. Idempotent, and safe to run CONCURRENTLY.
   *
   * Postgres' `CREATE TABLE/INDEX IF NOT EXISTS` is not atomic against another
   * session creating the same object: the loser gets a duplicate-object error.
   * node-pg wraps a multi-statement string in one implicit transaction, so
   * that error aborts the WHOLE bootstrap and `init()` throws — i.e. two
   * processes cold-starting together (exactly what `docker compose up` and a
   * rolling deploy do) could fail to boot. Self-healing under
   * `restart: unless-stopped`, a crashloop under Kubernetes.
   *
   * A session-level advisory lock serialises provisioning across processes.
   * The key is an arbitrary constant unique to this schema; it is released in
   * `finally` and, being session-scoped, is dropped automatically if the
   * connection dies mid-migration.
   */
  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
      await this.provisionSchema();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY])
        .catch(() => {});
      client.release();
    }
  }

  private async provisionSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        orchestration_name TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        status TEXT NOT NULL,
        orchestration_snapshot JSONB,
        initial_input TEXT,
        current_path JSONB,
        state_json JSONB,
        last_output TEXT,
        paused_for TEXT,
        completed_leaves JSONB,
        owner_id TEXT NOT NULL DEFAULT 'system',
        lease_owner TEXT,
        lease_expires_at BIGINT,
        concurrency_group TEXT,
        degraded BOOLEAN NOT NULL DEFAULT FALSE,
        degradation_reasons JSONB,
        updated_at BIGINT NOT NULL
      );
      -- Add owner_id to an older schema if missing (idempotent).
      ALTER TABLE runs
        ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'system';
      -- Run-lease columns (multi-process safety): who's executing a run + when
      -- the lease expires, so a peer's boot scan won't reclaim a live run.
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;
      -- Concurrency group (mutual exclusion for shared-resource runs).
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS concurrency_group TEXT;
      -- done-but-degraded signal (swallowed error / partial finalize /
      -- fallback on an otherwise-done run). Computed from the event stream.
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS degradation_reasons JSONB;
      CREATE INDEX IF NOT EXISTS idx_runs_status_started
        ON runs(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_started
        ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_owner_started
        ON runs(owner_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_lease
        ON runs(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_json JSONB NOT NULL,
        ts BIGINT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      -- NOTE: no separate index on (run_id, seq) — the PRIMARY KEY above IS
      -- that index. A duplicate cost a second B-tree write on every
      -- appendEvent and, at 100M events, multiple GB of redundant index.
      -- An existing database keeps its copy (dropping it needs a migration
      -- step and the win is space, not correctness); new ones never make it.

      -- Trigger deliveries — durable, idempotent ingress (P0) + durable
      -- work queue (P1/P2) + event-chain depth (P3). Every trigger fire is
      -- persisted here before its run is created.
      CREATE TABLE IF NOT EXISTS trigger_deliveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        orchestration_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        key_source TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        body TEXT,
        detail TEXT,
        owner_id TEXT NOT NULL DEFAULT 'system',
        received_at BIGINT NOT NULL,
        fired_at BIGINT,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at BIGINT NOT NULL DEFAULT 0,
        claimed_at BIGINT,
        last_error TEXT,
        chain_depth INTEGER NOT NULL DEFAULT 0
      );
      -- Idempotent upgrades for a P0-era table.
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS available_at BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS last_error TEXT;
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS chain_depth INTEGER NOT NULL DEFAULT 0;
      -- Monotonic claim counter, bumped on every claim and NEVER reset: the
      -- fence a worker presents to settle a delivery. The attempts column
      -- cannot serve (replayDelivery resets it to 0, and a reusable fence is
      -- no fence). Without it a worker that stalled past the reclaim window
      -- could stamp its result over the delivery another worker had already
      -- re-claimed and run -- two live runs from one accepted fire.
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS claim_token BIGINT NOT NULL DEFAULT 0;
      -- How many times a fire has been SUPPRESSED onto this row. A row per
      -- suppressed fire would be unbounded writes driven by whoever is
      -- retrying; a counter on the row that won the key is bounded and
      -- answers the question that matters.
      ALTER TABLE trigger_deliveries
        ADD COLUMN IF NOT EXISTS duplicate_count INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_deliveries_key
        ON trigger_deliveries(idempotency_key, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_received
        ON trigger_deliveries(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_orch
        ON trigger_deliveries(orchestration_name, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_claimable
        ON trigger_deliveries(status, available_at);

      -- Trigger fires — cron circuit-breaker. One row per terminal trigger
      -- fire, keyed by a STABLE trigger key (e.g. cron:<orch>:<expr>). The API
      -- appends each terminal run's outcome and reads the trailing run of
      -- consecutive non-'done' outcomes to detect a silently-failing cron.
      CREATE TABLE IF NOT EXISTS trigger_fires (
        id BIGSERIAL PRIMARY KEY,
        trigger_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        ts BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_fires_key
        ON trigger_fires(trigger_key, id DESC);

      -- Concurrency-group lookup (active runs in a group) + the durable FIFO
      -- of fires parked behind a busy group under the 'queue' policy.
      CREATE INDEX IF NOT EXISTS idx_runs_group_status
        ON runs(concurrency_group, status);
      CREATE TABLE IF NOT EXISTS pending_fires (
        id BIGSERIAL PRIMARY KEY,
        group_key TEXT NOT NULL,
        orch_name TEXT NOT NULL,
        initial_input TEXT,
        owner_id TEXT NOT NULL,
        ts BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_fires_group
        ON pending_fires(group_key, id);
      -- A parked fire's resolved declared inputs (a ticket's text, …).
      ALTER TABLE pending_fires ADD COLUMN IF NOT EXISTS resolved_inputs JSONB;

      -- Durable concurrency-group locks, for CROSS-PROCESS exclusion. The
      -- start-gate's atomicity otherwise came from an in-memory mutex, so two
      -- processes sharing this store could both pass the "no active run in
      -- this group" check at the same instant. Acquiring is a single atomic
      -- upsert that only succeeds against an absent or EXPIRED row; the TTL is
      -- what keeps a holder that dies from wedging its group forever.
      CREATE TABLE IF NOT EXISTS concurrency_group_locks (
        group_key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_locks_expiry
        ON concurrency_group_locks(expires_at);
    `);

    // Header-key uniqueness, in its OWN statement so a failure cannot abort
    // the bootstrap above.
    //
    // A header Idempotency-Key is unique forever, and the dedupe was
    // check-then-insert with no constraint behind it — so two simultaneous
    // posts of one key both saw zero priors and both inserted. PARTIAL
    // (header keys only) because auto keys are windowed and are *supposed*
    // to repeat outside the window; per orchestration because one fire
    // legitimately fans out to a row per subscriber, all sharing the key.
    // Predicate narrowed to NON-REFUSED statuses: a `rejected` / `failed` row
    // must not consume its idempotency key, or a sender retrying after the
    // cause was fixed gets a 200/duplicate and its event never runs. The
    // protection that matters is unchanged — at most one live-or-fired row
    // per key per orchestration.
    //
    // ── Why this is not an unconditional DROP + CREATE ────────────────────
    // It used to be exactly that, on EVERY `init()` — i.e. every boot of
    // every server and every worker. Three consequences, all bad in the
    // multi-process topology the deployment docs recommend:
    //   1. A window on every boot where header-key dedupe is silently OFF,
    //      so two concurrent posts of one key both insert — re-opening the
    //      exact race this index exists to close. A rolling deploy of N
    //      replicas is N such windows.
    //   2. The non-concurrent CREATE takes a SHARE lock on
    //      trigger_deliveries, blocking all ingress for the build.
    //   3. The DROP takes ACCESS EXCLUSIVE.
    // The SQLite twin is version-gated and runs once; this is one of the
    // places the two backends diverged precisely where reliability lives.
    //
    // The DROP existed only to replace an index created by an earlier,
    // BROADER definition. So check the definition instead and rebuild only
    // when it is actually stale.
    const wanted = {
      table: 'trigger_deliveries',
      predicate: "key_source = 'header'",
      excluded: ["'rejected'", "'failed'"],
    };
    const existing = await this.pool
      .query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_deliveries_header_key'`,
      )
      .catch(() => ({ rows: [] as Array<{ indexdef: string }> }));
    const def = existing.rows[0]?.indexdef ?? '';
    const isCurrent =
      def.includes(wanted.predicate) &&
      wanted.excluded.every(v => def.includes(v));
    if (def && !isCurrent) {
      // Genuinely stale — replace it, once, and say so.
      console.warn(
        '[sammy-pack-pg] replacing an outdated uq_deliveries_header_key ' +
          '(predicate changed); ingress dedupe is briefly unprotected during ' +
          'the rebuild.',
      );
      await this.pool
        .query(`DROP INDEX IF EXISTS uq_deliveries_header_key`)
        .catch(() => {});
    }
    try {
      // `IF NOT EXISTS` makes the common path (index already correct) a no-op
      // rather than a rebuild.
      await this.pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_header_key
           ON trigger_deliveries(idempotency_key, orchestration_name)
           WHERE key_source = 'header'
             AND status NOT IN ('rejected', 'failed')`,
      );
    } catch (err) {
      // An existing database may already hold duplicates produced by the very
      // race this index prevents. Refusing to boot over historical data would
      // be worse, so fall back to a non-unique index: dedupe stays
      // best-effort here (as it has been all along) while every clean
      // database gets the guarantee.
      // eslint-disable-next-line no-console
      console.warn(
        '[sammy-pack-pg] could not add the unique index on header idempotency ' +
          `keys (${(err as Error)?.message ?? err}). This database already ` +
          'contains duplicate (idempotency_key, orchestration_name) rows, so ' +
          'concurrent double-fires of one key cannot be prevented at the ' +
          'storage layer here. Find them with:\n' +
          '  SELECT idempotency_key, orchestration_name, COUNT(*) c FROM trigger_deliveries\n' +
          "   WHERE key_source='header' GROUP BY 1,2 HAVING COUNT(*) > 1;",
      );
      await this.pool
        .query(
          `CREATE INDEX IF NOT EXISTS idx_deliveries_header_key
             ON trigger_deliveries(idempotency_key, orchestration_name)`,
        )
        .catch(() => {});
    }
  }

  /** Run `fn` inside a transaction on a dedicated client. */
  private async withTx<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async listRuns(limit = 500, ownerId?: string): Promise<RunHeader[]> {
    if (ownerId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM runs WHERE owner_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [ownerId, limit],
      );
      return rows.map(rowToHeader);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM runs ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToHeader);
  }

  async listPausedRuns(): Promise<RunHeader[]> {
    // Unbounded on purpose — sweeper visibility (see the SQLite twin):
    // every paused run must be seen regardless of how many newer runs
    // exist. Paused runs are inherently few.
    const { rows } = await this.pool.query(
      `SELECT * FROM runs WHERE status = 'paused' ORDER BY started_at DESC`,
    );
    return rows.map(rowToHeader);
  }

  async getRun(id: string, ownerId?: string): Promise<Run | null> {
    const headerRes = await this.pool.query(
      `SELECT * FROM runs WHERE id = $1`,
      [id],
    );
    if (headerRes.rows.length === 0) return null;
    const header = rowToHeader(headerRes.rows[0]);
    // Owner scope = authorization. A mismatch reads as MISSING, not
    // forbidden, so the response cannot be used to enumerate run ids.
    if (ownerId !== undefined && header.ownerId !== ownerId) return null;
    const eventsRes = await this.pool.query(
      `SELECT event_json FROM events WHERE run_id = $1 ORDER BY seq ASC`,
      [id],
    );
    // JSONB comes back already parsed.
    const events: StoredEvent[] = eventsRes.rows.map(r => r.event_json);
    return { ...header, events, eventVersion: events.length };
  }

  async getRunSummary(id: string, ownerId?: string): Promise<RunSummary | null> {
    const headerRes = await this.pool.query(
      `SELECT * FROM runs WHERE id = $1`,
      [id],
    );
    if (headerRes.rows.length === 0) return null;
    const header = rowToHeader(headerRes.rows[0]);
    if (ownerId !== undefined && header.ownerId !== ownerId) return null;
    // Read just enough to tally — bodies parsed but never returned (the point
    // is to NOT ship events[]). Ordered by seq so the last row is the latest.
    const eventsRes = await this.pool.query(
      `SELECT event_json FROM events WHERE run_id = $1 ORDER BY seq ASC`,
      [id],
    );
    const events: StoredEvent[] = eventsRes.rows.map(r => r.event_json);
    return summarizeRun(header, events);
  }

  async eventCounts(runIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (runIds.length === 0) return out;
    // One grouped count using ANY($1) — no event bodies read.
    const { rows } = await this.pool.query(
      `SELECT run_id, COUNT(*)::int AS n FROM events
         WHERE run_id = ANY($1) GROUP BY run_id`,
      [runIds],
    );
    for (const r of rows) out.set(r.run_id as string, Number(r.n));
    return out;
  }

  async upsertRun(run: UpsertRunInput): Promise<void> {
    assertStatus(run.status);
    const now = Date.now();
    // A run created/upserted as `running` is owned by this process from the
    // outset — claim the lease so a peer's boot scan can't reclaim it in the
    // window before the first event lands.
    const leaseOwner = run.status === 'running' ? this.instanceId : null;
    const leaseExpiresAt =
      run.status === 'running' ? now + this.leaseTtlMs : null;
    // Denormalize the recent-output preview so the LIST endpoint can ship a
    // snippet without loading events (the OOM fix). Mirrors the SQLite store.
    const lastOutput = derivePreviewFromEvents(run.events);
    await this.withTx(async client => {
      await client.query(
        `INSERT INTO runs (
           id, orchestration_name, started_at, ended_at, status,
           orchestration_snapshot, initial_input, owner_id,
           last_output, lease_owner, lease_expires_at, concurrency_group,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           orchestration_name = EXCLUDED.orchestration_name,
           started_at = EXCLUDED.started_at,
           ended_at = EXCLUDED.ended_at,
           status = EXCLUDED.status,
           orchestration_snapshot = EXCLUDED.orchestration_snapshot,
           initial_input = EXCLUDED.initial_input,
           owner_id = EXCLUDED.owner_id,
           last_output = EXCLUDED.last_output,
           lease_owner = EXCLUDED.lease_owner,
           lease_expires_at = EXCLUDED.lease_expires_at,
           concurrency_group = EXCLUDED.concurrency_group,
           updated_at = EXCLUDED.updated_at`,
        [
          run.id,
          run.orchestrationName,
          run.startedAt,
          run.endedAt ?? null,
          run.status,
          toJsonb(run.orchestrationSnapshot),
          run.initialInput ?? null,
          run.ownerId ?? 'system',
          lastOutput,
          leaseOwner,
          leaseExpiresAt,
          run.concurrencyGroup ?? null,
          now,
        ],
      );
      await client.query(`DELETE FROM events WHERE run_id = $1`, [run.id]);
      let seq = 0;
      for (const ev of run.events) {
        const ts =
          typeof ev.ts === 'number' && Number.isFinite(ev.ts) ? ev.ts : now;
        await client.query(
          `INSERT INTO events (run_id, seq, event_json, ts)
           VALUES ($1, $2, $3, $4)`,
          [run.id, seq, toJsonb(ev), ts],
        );
        seq += 1;
      }
    });
  }

  async appendEvent(runId: string, event: StoredEvent): Promise<void> {
    const ts =
      typeof event.ts === 'number' && Number.isFinite(event.ts)
        ? event.ts
        : Date.now();
    await this.withTx(async client => {
      // Fence: while a run is RUNNING, only its lease owner may write events.
      // `FOR UPDATE` locks the row so the ownership check + write are atomic
      // against a concurrent reclaim. A peer that took over (we stalled past
      // the TTL) is the single writer; our stale write throws + rolls back
      // instead of colliding. Scoped to running runs — writes to a paused /
      // interrupted run (e.g. an A2A follow-up before resume) are legitimately
      // cross-process and stay allowed.
      const ownerRes = await client.query(
        `SELECT status, lease_owner FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (ownerRes.rows.length === 0) {
        throw new LeaseLostError(runId, this.instanceId, null);
      }
      const { status, lease_owner } = ownerRes.rows[0] as {
        status: string;
        lease_owner: string | null;
      };
      if (status === 'running' && lease_owner !== this.instanceId) {
        throw new LeaseLostError(runId, this.instanceId, lease_owner);
      }
      const seqRes = await client.query(
        `SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE run_id = $1`,
        [runId],
      );
      const next = Number(seqRes.rows[0].next);
      await client.query(
        `INSERT INTO events (run_id, seq, event_json, ts)
         VALUES ($1, $2, $3, $4)`,
        [runId, next, toJsonb(event), ts],
      );
      // Heartbeat: every event this process writes pushes the lease forward,
      // so an actively-executing run is never seen as orphaned by a peer boot.
      const heartbeat = Date.now();
      await client.query(
        `UPDATE runs
           SET updated_at = $1, lease_owner = $2, lease_expires_at = $3
         WHERE id = $4`,
        [heartbeat, this.instanceId, heartbeat + this.leaseTtlMs, runId],
      );
    });
  }

  async deleteRun(id: string, ownerId?: string): Promise<boolean> {
    return this.withTx(async client => {
      // Owner predicate IN the DELETE, not a preceding SELECT — a
      // check-then-act would leave a window where the row's owner changed
      // between the two statements.
      if (ownerId !== undefined) {
        const res = await client.query(
          `DELETE FROM runs WHERE id = $1 AND owner_id = $2`,
          [id, ownerId],
        );
        if ((res.rowCount ?? 0) === 0) return false;
        await client.query(`DELETE FROM events WHERE run_id = $1`, [id]);
        return true;
      }
      await client.query(`DELETE FROM events WHERE run_id = $1`, [id]);
      const res = await client.query(`DELETE FROM runs WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async updateRunStatus(
    id: string,
    patch: UpdateRunPatch,
    opts?: { requireLease?: boolean; onlyIfStatus?: RunStatus[] },
  ): Promise<boolean> {
    if (patch.status !== undefined) assertStatus(patch.status);
    for (const s of opts?.onlyIfStatus ?? []) assertStatus(s);
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, value: unknown) => {
      args.push(value);
      sets.push(`${col} = $${args.length}`);
    };
    const now = Date.now();
    add('updated_at', now);
    if (patch.status !== undefined) add('status', patch.status);
    // Resuming a run (-> running) claims the lease for this process.
    if (patch.status === 'running') {
      add('lease_owner', this.instanceId);
      add('lease_expires_at', now + this.leaseTtlMs);
    }
    if (patch.endedAt !== undefined) add('ended_at', patch.endedAt);
    if (patch.currentPath !== undefined)
      add('current_path', toJsonb(patch.currentPath));
    if (patch.stateJson !== undefined)
      add('state_json', toJsonb(patch.stateJson));
    if (patch.lastOutput !== undefined) add('last_output', patch.lastOutput);
    if (patch.pausedFor !== undefined) add('paused_for', patch.pausedFor);
    if (patch.completedLeaves !== undefined)
      add('completed_leaves', toJsonb(patch.completedLeaves));
    if (patch.degraded !== undefined) add('degraded', patch.degraded);
    if (patch.degradationReasons !== undefined)
      add('degradation_reasons', toJsonb(patch.degradationReasons));
    args.push(id);
    const where: string[] = [`id = $${args.length}`];
    // Preconditions live IN the UPDATE (see the RunStore doc). The lease
    // fence is renewLease's own predicate — owner AND still running — rather
    // than the looser `owner OR not running` appendEvent uses: a checkpoint
    // is a wholesale overwrite, and the looser form would let a de-leased
    // owner stomp a run its peer had already resumed and re-paused.
    if (opts?.requireLease) {
      args.push(this.instanceId);
      where.push(`lease_owner = $${args.length} AND status = 'running'`);
    }
    if (opts?.onlyIfStatus && opts.onlyIfStatus.length > 0) {
      args.push(opts.onlyIfStatus);
      where.push(`status = ANY($${args.length})`);
    }
    const res = await this.pool.query(
      `UPDATE runs SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`,
      args,
    );
    if ((res.rowCount ?? 0) > 0) return true;
    if (opts?.requireLease) {
      const { rows } = await this.pool.query(
        `SELECT lease_owner FROM runs WHERE id = $1`,
        [id],
      );
      throw new LeaseLostError(
        id,
        this.instanceId,
        (rows[0]?.lease_owner as string | null | undefined) ?? null,
      );
    }
    return false;
  }

  async markOrphanedRunsAsInterrupted(
    now: number = Date.now(),
    opts?: { isLocallyActive?: (id: string) => boolean },
  ): Promise<{ count: number; ids: string[] }> {
    return this.withTx(async client => {
      // Only reclaim runs whose lease has expired (owner died). A run a live
      // peer is executing keeps its lease ahead of `now` and is left alone —
      // and so is a run THIS process owns, however stale its lease: a blocked
      // event loop is not a dead process, and its next renew recovers the
      // lease (see the RunStore doc). At boot the exclusion is a no-op.
      //
      // The own-row exclusion protects a LIVE run. When the caller can say
      // which of its rows it still drives (`isLocallyActive`), own rows are
      // fetched too and judged here, per row: one it has let go of — a leg
      // whose terminal write failed every retry, heartbeat stopped — is an
      // orphan like a dead peer's, and without a peer nothing else would ever
      // free it. Without a predicate the SQL excludes them outright.
      const ownRowIsOrphan = (id: string): boolean =>
        opts?.isLocallyActive !== undefined && !opts.isLocallyActive(id);
      const fetchOwn = opts?.isLocallyActive !== undefined ? 1 : 0;
      const orphans = await client.query(
        `SELECT id, lease_owner, lease_expires_at FROM runs
           WHERE status = 'running'
             AND (lease_expires_at IS NULL OR lease_expires_at < $1)
             AND (lease_owner IS NULL OR lease_owner <> $2 OR $3 = 1)`,
        [now, this.instanceId, fetchOwn],
      );
      const rows = (
        orphans.rows as Array<{
          id: string;
          lease_owner: string | null;
          lease_expires_at: number | null;
        }>
      ).filter(r => r.lease_owner !== this.instanceId || ownRowIsOrphan(r.id));
      if (rows.length === 0) return { count: 0, ids: [] };
      const reclaimed: string[] = [];
      for (const r of rows) {
        // Atomic reclaim: re-check the lease IN the UPDATE so a heartbeat that
        // landed between the SELECT and here makes it a no-op (rowCount 0) — we
        // don't steal a run that just came back to life — and re-check the
        // owner the SELECT saw (null-safe), so a re-lease in that gap cannot
        // outrun the exclusion above. Clearing lease_owner fences out the old
        // owner: its next appendEvent yields immediately.
        const res = await client.query(
          `UPDATE runs
             SET status = 'interrupted', ended_at = $1, updated_at = $1,
                 lease_owner = NULL
           WHERE id = $2
             AND status = 'running'
             AND (lease_expires_at IS NULL OR lease_expires_at < $1)
             AND lease_owner IS NOT DISTINCT FROM $3`,
          [now, r.id, r.lease_owner],
        );
        if ((res.rowCount ?? 0) === 0) continue; // came back to life — leave it
        reclaimed.push(r.id);
        const seqRes = await client.query(
          `SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE run_id = $1`,
          [r.id],
        );
        await client.query(
          `INSERT INTO events (run_id, seq, event_json, ts)
           VALUES ($1, $2, $3, $4)`,
          [
            r.id,
            Number(seqRes.rows[0].next),
            toJsonb(
              interruptedEvent(
                r.lease_owner,
                r.lease_expires_at == null ? null : Number(r.lease_expires_at),
                this.instanceId,
                now,
              ),
            ),
            now,
          ],
        );
      }
      return { count: reclaimed.length, ids: reclaimed };
    });
  }

  async renewLease(id: string): Promise<boolean> {
    // Fenced: only renew if we still own it AND it's still running.
    const now = Date.now();
    const res = await this.pool.query(
      `UPDATE runs SET lease_expires_at = $1
         WHERE id = $2 AND lease_owner = $3 AND status = 'running'`,
      [now + this.leaseTtlMs, id, this.instanceId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordDelivery(input: DeliveryInput): Promise<boolean> {
    const status = input.status ?? 'accepted';
    assertDeliveryStatus(status);
    try {
      await this.insertDelivery(input, status);
      return true;
    } catch (err) {
      // 23505 = unique_violation: the partial index on (idempotency_key,
      // orchestration_name) rejected a duplicate header key. That is the
      // dedupe working, not an error — a concurrent double-post of one key
      // now loses the race here instead of both inserting.
      if ((err as { code?: string })?.code === '23505') return false;
      throw err;
    }
  }

  private async insertDelivery(
    input: DeliveryInput,
    status: DeliveryStatus,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO trigger_deliveries (
         id, kind, name, orchestration_name, idempotency_key, key_source,
         status, run_id, body, detail, owner_id, received_at, fired_at,
         attempts, available_at, claimed_at, last_error, chain_depth
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18)`,
      [
        input.id,
        input.kind,
        input.name,
        input.orchestrationName,
        input.idempotencyKey,
        input.keySource,
        status,
        input.runId ?? null,
        input.body ?? null,
        input.detail ?? null,
        input.ownerId ?? 'system',
        input.receivedAt,
        null,
        0,
        input.availableAt ?? input.receivedAt,
        null,
        null,
        input.chainDepth ?? 0,
      ],
    );
  }

  async findDeliveriesByKey(
    key: string,
    opts?: { sinceMs?: number; excludeRefused?: boolean; now?: number },
  ): Promise<DeliveryRecord[]> {
    const where = ['idempotency_key = $1'];
    const args: unknown[] = [key];
    if (opts?.sinceMs != null) {
      args.push((opts.now ?? Date.now()) - opts.sinceMs);
      where.push(`received_at >= $${args.length}`);
    }
    if (opts?.excludeRefused) {
      // Matches the partial unique index's predicate, so the dedupe READ and
      // the storage CONSTRAINT agree about which rows own a key.
      where.push(`status NOT IN ('rejected', 'failed')`);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM trigger_deliveries
        WHERE ${where.join(' AND ')}
        ORDER BY received_at DESC`,
      args,
    );
    return rows.map(rowToDelivery);
  }

  async updateDelivery(id: string, patch: DeliveryPatch): Promise<void> {
    if (patch.status !== undefined) assertDeliveryStatus(patch.status);
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, value: unknown) => {
      args.push(value);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.runId !== undefined) add('run_id', patch.runId);
    if (patch.detail !== undefined) add('detail', patch.detail);
    if (patch.firedAt !== undefined) add('fired_at', patch.firedAt);
    if (sets.length === 0) return;
    args.push(id);
    await this.pool.query(
      `UPDATE trigger_deliveries SET ${sets.join(', ')} WHERE id = $${args.length}`,
      args,
    );
  }

  async findLastPollingDelivery(
    source: string,
    orchestrationName: string,
  ): Promise<DeliveryRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM trigger_deliveries
        WHERE kind = 'polling' AND name = $1 AND orchestration_name = $2
        ORDER BY received_at DESC LIMIT 1`,
      [source, orchestrationName],
    );
    return rows.length ? rowToDelivery(rows[0]) : null;
  }

  async listDeliveries(
    limit = 200,
    ownerId?: string,
    status?: DeliveryStatus,
  ): Promise<DeliveryRecord[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (ownerId) {
      args.push(ownerId);
      where.push(`owner_id = $${args.length}`);
    }
    if (status) {
      assertDeliveryStatus(status);
      args.push(status);
      where.push(`status = $${args.length}`);
    }
    args.push(limit);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT * FROM trigger_deliveries ${clause} ORDER BY received_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map(rowToDelivery);
  }

  async claimNextDelivery(
    now: number,
    opts?: { maxInFlightPerOrch?: number },
  ): Promise<DeliveryRecord | null> {
    // FOR UPDATE SKIP LOCKED → many workers / processes can drain the same
    // queue without double-claiming. Atomic claim + bump in one statement.
    // With a per-orch cap, a correlated subquery skips orchestrations that
    // already have `cap` claimed deliveries in flight.
    const cap = opts?.maxInFlightPerOrch;
    const inner =
      cap != null
        ? `SELECT d.id FROM trigger_deliveries d
             WHERE d.status = 'pending' AND d.available_at <= $1
               AND (
                 SELECT COUNT(*) FROM trigger_deliveries c
                  WHERE c.orchestration_name = d.orchestration_name
                    AND c.status = 'claimed'
               ) < $2
             ORDER BY d.received_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`
        : `SELECT id FROM trigger_deliveries
             WHERE status = 'pending' AND available_at <= $1
             ORDER BY received_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`;
    const args = cap != null ? [now, cap] : [now];
    const { rows } = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'claimed', claimed_at = $1, attempts = attempts + 1,
              claim_token = claim_token + 1
        WHERE id = (${inner})
        RETURNING *`,
      args,
    );
    return rows.length ? rowToDelivery(rows[0]) : null;
  }

  async completeDelivery(
    id: string,
    runId: string,
    now: number,
    claimToken: number,
  ): Promise<boolean> {
    // FENCED on (still claimed, same token) — see the schema comment.
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'fired', run_id = $1, fired_at = $2, claimed_at = NULL,
              last_error = NULL
        WHERE id = $3 AND status = 'claimed' AND claim_token = $4`,
      [runId, now, id, claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deferDelivery(
    id: string,
    detail: string,
    _now: number,
    claimToken: number,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'deferred', detail = $1, claimed_at = NULL
        WHERE id = $2 AND status = 'claimed' AND claim_token = $3`,
      [detail, id, claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async rejectDelivery(
    id: string,
    reason: string,
    _now: number,
    claimToken: number,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'rejected', last_error = $1, claimed_at = NULL
        WHERE id = $2 AND status = 'claimed' AND claim_token = $3`,
      [reason, id, claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async failDelivery(
    id: string,
    opts: {
      error: string;
      now: number;
      retryAt?: number | null;
      claimToken: number;
    },
  ): Promise<boolean> {
    if (opts.retryAt != null) {
      const res = await this.pool.query(
        `UPDATE trigger_deliveries
            SET status = 'pending', available_at = $1, last_error = $2,
                claimed_at = NULL
          WHERE id = $3 AND status = 'claimed' AND claim_token = $4`,
        [opts.retryAt, opts.error, id, opts.claimToken],
      );
      return (res.rowCount ?? 0) > 0;
    }
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'failed', last_error = $1, claimed_at = NULL
        WHERE id = $2 AND status = 'claimed' AND claim_token = $3`,
      [opts.error, id, opts.claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseDeliveries(orchestrationName: string, now: number): Promise<number> {
    const res = await this.pool.query(
      `UPDATE trigger_deliveries SET available_at = $1
        WHERE orchestration_name = $2 AND status = 'pending' AND available_at > $1`,
      [now, orchestrationName],
    );
    return res.rowCount ?? 0;
  }

  async holdDelivery(
    id: string,
    opts: { until: number; detail: string; claimToken: number },
  ): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'pending', available_at = $1, detail = $2,
              attempts = GREATEST(attempts - 1, 0), claimed_at = NULL, last_error = NULL
        WHERE id = $3 AND status = 'claimed' AND claim_token = $4`,
      [opts.until, opts.detail, id, opts.claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async reclaimStaleDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; ids: string[] }> {
    const cutoff = now - olderThanMs;
    const { rows } = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'pending', claimed_at = NULL
        WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < $1
        RETURNING id`,
      [cutoff],
    );
    return { count: rows.length, ids: rows.map(r => r.id as string) };
  }

  async replayDelivery(id: string, now: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE trigger_deliveries
          SET status = 'pending', available_at = $1, claimed_at = NULL,
              attempts = 0, last_error = NULL
        WHERE id = $2 AND status IN ('failed', 'rejected')`,
      [now, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async countDeliveries(filter?: {
    status?: DeliveryStatus;
    orchestrationName?: string;
    ownerId?: string;
    /** Only rows claimable at or before this epoch ms. */
    availableBefore?: number;
    /** Due, or backing off after a failed attempt — not held. */
    dueOrRetrying?: number;
  }): Promise<number> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.status) {
      assertDeliveryStatus(filter.status);
      args.push(filter.status);
      where.push(`status = $${args.length}`);
    }
    if (filter?.orchestrationName) {
      args.push(filter.orchestrationName);
      where.push(`orchestration_name = $${args.length}`);
    }
    if (filter?.ownerId) {
      args.push(filter.ownerId);
      where.push(`owner_id = $${args.length}`);
    }
    if (filter?.availableBefore !== undefined) {
      args.push(filter.availableBefore);
      where.push(`available_at <= $${args.length}`);
    }
    if (filter?.dueOrRetrying !== undefined) {
      args.push(filter.dueOrRetrying);
      where.push(`(available_at <= $${args.length} OR last_error IS NOT NULL)`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM trigger_deliveries ${clause}`,
      args,
    );
    return Number(rows[0].n);
  }

  async findDeliveryByRunId(runId: string): Promise<DeliveryRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM trigger_deliveries WHERE run_id = $1 LIMIT 1`,
      [runId],
    );
    return rows.length ? rowToDelivery(rows[0]) : null;
  }

  async recordTriggerOutcome(
    triggerKey: string,
    runId: string,
    status: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO trigger_fires (trigger_key, run_id, status, ts)
         VALUES ($1, $2, $3, $4)`,
      [triggerKey, runId, status, Date.now()],
    );
  }

  async getConsecutiveFailures(triggerKey: string): Promise<number> {
    // Newest-first by the BIGSERIAL id (insertion order, monotonic even when
    // two fires share a ms `ts`). Stop at the first 'done'.
    const { rows } = await this.pool.query(
      `SELECT status FROM trigger_fires
        WHERE trigger_key = $1
        ORDER BY id DESC`,
      [triggerKey],
    );
    return countConsecutiveFailuresNewestFirst(
      rows as Array<{ status: string }>,
    );
  }

  async findActiveRunsInGroup(
    group: string,
    excludeRunId?: string,
  ): Promise<RunHeader[]> {
    if (excludeRunId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM runs
          WHERE concurrency_group = $1
            AND status IN ('running', 'paused')
            AND id != $2
          ORDER BY started_at ASC`,
        [group, excludeRunId],
      );
      return rows.map(rowToHeader);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM runs
        WHERE concurrency_group = $1
          AND status IN ('running', 'paused')
        ORDER BY started_at ASC`,
      [group],
    );
    return rows.map(rowToHeader);
  }

  async noteDuplicateSuppressed(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE trigger_deliveries
          SET duplicate_count = duplicate_count + 1
        WHERE id = $1`,
      [id],
    );
  }

  async sumDuplicatesSuppressed(ownerId?: string): Promise<number> {
    const { rows } = ownerId
      ? await this.pool.query(
          `SELECT COALESCE(SUM(duplicate_count), 0) AS n FROM trigger_deliveries WHERE owner_id = $1`,
          [ownerId],
        )
      : await this.pool.query(
          `SELECT COALESCE(SUM(duplicate_count), 0) AS n FROM trigger_deliveries`,
        );
    return Number(rows[0]?.n ?? 0);
  }

  async acquireGroupLock(
    group: string,
    holder: string,
    ttlMs: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO concurrency_group_locks AS l
         (group_key, holder, acquired_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_key) DO UPDATE SET
         holder = $2, acquired_at = $3, expires_at = $4
       WHERE l.expires_at <= $5`,
      [group, holder, now, now + ttlMs, now],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseGroupLock(group: string, holder: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM concurrency_group_locks WHERE group_key = $1 AND holder = $2`,
      [group, holder],
    );
  }

  async enqueuePendingFire(group: string, fire: PendingFire): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_fires (group_key, orch_name, initial_input, owner_id, ts, resolved_inputs)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        group,
        fire.orchName,
        fire.initialInput ?? null,
        fire.ownerId,
        Date.now(),
        fire.resolvedInputs ? JSON.stringify(fire.resolvedInputs) : null,
      ],
    );
  }

  async dequeueNextPendingFire(group: string): Promise<PendingFire | null> {
    // FIFO: oldest row by the BIGSERIAL id. DELETE the row a SELECT ... FOR
    // UPDATE SKIP LOCKED picked, in one statement, so many workers / processes
    // can drain without two of them claiming the same parked fire.
    const { rows } = await this.pool.query(
      `DELETE FROM pending_fires
        WHERE id = (
          SELECT id FROM pending_fires
            WHERE group_key = $1
            ORDER BY id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING orch_name, initial_input, owner_id, resolved_inputs`,
      [group],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as {
      orch_name: string;
      initial_input: string | null;
      owner_id: string;
      resolved_inputs: Record<string, string> | null;
    };
    return {
      orchName: row.orch_name,
      initialInput: row.initial_input ?? null,
      ownerId: row.owner_id,
      ...(row.resolved_inputs ? { resolvedInputs: row.resolved_inputs } : {}),
    };
  }

  async countPendingFires(group: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM pending_fires WHERE group_key = $1`,
      [group],
    );
    return Number(rows[0].n);
  }

  async listPendingFires(group?: string): Promise<PendingFireRecord[]> {
    // Oldest-first by the BIGSERIAL id — the exact FIFO order the dequeue
    // drains in. Read-only: the visibility endpoint never mutates the queue.
    const { rows } = group
      ? await this.pool.query(
          `SELECT id, group_key, orch_name, initial_input, owner_id, ts
             FROM pending_fires WHERE group_key = $1 ORDER BY id ASC`,
          [group],
        )
      : await this.pool.query(
          `SELECT id, group_key, orch_name, initial_input, owner_id, ts
             FROM pending_fires ORDER BY id ASC`,
        );
    return (rows as Array<Record<string, unknown>>).map(r => ({
      id: Number(r.id),
      group: r.group_key as string,
      orchName: r.orch_name as string,
      initialInput: (r.initial_input as string | null) ?? null,
      ownerId: r.owner_id as string,
      queuedAt: Number(r.ts),
    }));
  }

  async withdrawPendingFire(
    id: number,
    group?: string,
  ): Promise<PendingFireRecord | null> {
    // Remove ONE parked fire by id WITHOUT starting it. Single conditional
    // DELETE ... RETURNING — atomic against a concurrent drain (postgres row
    // locking: exactly one statement gets the row); group-conditional in the
    // same statement so an id/group mismatch removes nothing.
    const { rows } =
      group !== undefined
        ? await this.pool.query(
            `DELETE FROM pending_fires WHERE id = $1 AND group_key = $2
               RETURNING id, group_key, orch_name, initial_input, owner_id, ts`,
            [id, group],
          )
        : await this.pool.query(
            `DELETE FROM pending_fires WHERE id = $1
               RETURNING id, group_key, orch_name, initial_input, owner_id, ts`,
            [id],
          );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      id: Number(r.id),
      group: r.group_key as string,
      orchName: r.orch_name as string,
      initialInput: (r.initial_input as string | null) ?? null,
      ownerId: r.owner_id as string,
      queuedAt: Number(r.ts),
    };
  }

  async pruneTerminalDeliveries(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number }> {
    const cutoff = now - olderThanMs;
    const res = await this.pool.query(
      `DELETE FROM trigger_deliveries
        WHERE status IN ('fired','rejected','deferred','duplicate','failed','accepted')
          AND received_at < $1`,
      [cutoff],
    );
    return { count: res.rowCount ?? 0 };
  }

  async pruneTerminalRuns(
    olderThanMs: number,
    now: number,
  ): Promise<{ count: number; reclaimedBytes: number | null }> {
    const cutoff = now - olderThanMs;
    // Same contract as the SQLite backend: only TERMINAL rows (done / error /
    // cancelled) old enough by COALESCE(ended_at, updated_at); paused /
    // interrupted / running rows are resumable (or alive) and never match.
    //
    // ── BATCHED, like the SQLite twin, for a different reason ─────────────
    //
    // This was one `DELETE … WHERE run_id IN (SELECT …)` in one transaction.
    // The pool sets `statement_timeout` (60s by default), so past some store
    // size that single statement is cancelled EVERY day, forever: nothing is
    // ever pruned, the table keeps growing, the next attempt is slower still,
    // and the only signal is a console.error from the sweep. Each batch is a
    // bounded statement that fits well inside the timeout, so a backlog of
    // any size drains across iterations instead of failing as a unit. The
    // SELECT is in the same transaction as its DELETEs; a second pruner
    // picking the same ids simply deletes zero rows (READ COMMITTED), which
    // is why the count comes from rowCount and the loop is driven by the
    // SELECT's size. Yield between batches as the SQLite twin does, so a
    // long prune never monopolises the loop that renews this process's leases.
    const batch = envPositiveInt('SAMMY_RETENTION_BATCH', 500);
    let count = 0;
    for (;;) {
      const picked = await this.withTx(async client => {
        const sel = await client.query(
          `SELECT id FROM runs
            WHERE status IN ('done', 'error', 'cancelled')
              AND COALESCE(ended_at, updated_at) < $1
            LIMIT $2`,
          [cutoff, batch],
        );
        const ids: string[] = sel.rows.map(r => r.id as string);
        if (ids.length === 0) return { selected: 0, deleted: 0 };
        // The status predicate is REPEATED on the delete, not trusted from
        // the select: a resume's CAS can commit `error → running` on a
        // selected row between the two statements (READ COMMITTED sees it),
        // and an unconditional delete-by-id would then erase a live run.
        // Events go only for the rows the delete actually removed.
        const res = await client.query(
          `DELETE FROM runs
            WHERE id = ANY($1) AND status IN ('done', 'error', 'cancelled')
            RETURNING id`,
          [ids],
        );
        const gone: string[] = res.rows.map(r => r.id as string);
        if (gone.length > 0) {
          await client.query(`DELETE FROM events WHERE run_id = ANY($1)`, [gone]);
        }
        return { selected: ids.length, deleted: gone.length };
      });
      count += picked.deleted;
      // A short batch means that was the last one — stop BEFORE yielding, so
      // a prune that fits in one batch (the common case) never defers.
      if (picked.selected < batch) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    // No cheap synchronous "bytes reclaimed" for Postgres — dead tuples are
    // reclaimed by autovacuum on its own schedule. The caller notes that.
    return { count, reclaimedBytes: null };
  }

  async costSummary(ownerId?: string): Promise<{ todayUsd: number; monthUsd: number }> {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).getTime();
    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN r.started_at >= $1 THEN c.cost ELSE 0 END), 0) AS today,
         COALESCE(SUM(c.cost), 0) AS month
       FROM runs r
       JOIN (
         -- Bounded by the SAME month-to-date window as the outer join. It
         -- previously had no WHERE at all, so this aggregated the entire
         -- events table on every run start and on every Pipelines page load.
         -- PHASE-END + PHASE-ERROR ONLY: the executor's 'cost' event carries
         -- the run's CUMULATIVE total, so summing costUsd over every type
         -- counted a 3-phase $3 run as $9; a leaf's phase-error carries its
         -- FAILED attempt's own delta, which a retry otherwise hid from the
         -- cap (see the SQLite twin).
         SELECT e.run_id,
                SUM(COALESCE((e.event_json->>'costUsd')::numeric, 0)) AS cost
         FROM events e
         WHERE e.run_id IN (SELECT id FROM runs WHERE started_at >= $2)
           AND e.event_json->>'type' IN ('phase-end', 'phase-error')
         GROUP BY e.run_id
       ) c ON c.run_id = r.id
       WHERE r.started_at >= $2${ownerId !== undefined ? ' AND r.owner_id = $3' : ''}`,
      ownerId !== undefined
        ? [startOfDay, startOfMonth, ownerId]
        : [startOfDay, startOfMonth],
    );
    return {
      todayUsd: Number(rows[0].today ?? 0),
      monthUsd: Number(rows[0].month ?? 0),
    };
  }

  async orchestrationUsage(
    orchestrationName: string,
    window: { dayStart: number; monthStart: number },
  ): Promise<{ runsToday: number; todayUsd: number; monthUsd: number }> {
    const from = Math.min(window.dayStart, window.monthStart);
    const runs = await this.pool.query(
      `SELECT COUNT(*)::bigint AS n FROM runs
        WHERE orchestration_name = $1 AND started_at >= $2`,
      [orchestrationName, window.dayStart],
    );
    const cost = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN r.started_at >= $1 THEN c.cost ELSE 0 END), 0) AS today,
         COALESCE(SUM(CASE WHEN r.started_at >= $2 THEN c.cost ELSE 0 END), 0) AS month
       FROM runs r
       JOIN (
         SELECT e.run_id,
                SUM(COALESCE((e.event_json->>'costUsd')::numeric, 0)) AS cost
         FROM events e
         WHERE e.run_id IN (
                 SELECT id FROM runs
                  WHERE orchestration_name = $3 AND started_at >= $4)
           AND e.event_json->>'type' IN ('phase-end', 'phase-error')
         GROUP BY e.run_id
       ) c ON c.run_id = r.id
       WHERE r.orchestration_name = $3 AND r.started_at >= $4`,
      [window.dayStart, window.monthStart, orchestrationName, from],
    );
    return {
      runsToday: Number(runs.rows[0]?.n ?? 0),
      todayUsd: Number(cost.rows[0]?.today ?? 0),
      monthUsd: Number(cost.rows[0]?.month ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
