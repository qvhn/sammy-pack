import { promises as fs } from 'node:fs';
import {
  cronWallClockBucket,
  isValidTimeZone,
} from '../src/server/cron-bucket';
import os from 'node:os';
import path from 'node:path';
import { SqliteRunStore } from '../src/server/db';
import {
  checkConsecutiveFailures,
  countConsecutiveFailuresNewestFirst,
  cronFailureThreshold,
  DEFAULT_CRON_FAILURE_THRESHOLD,
} from '../src/server/run-store';

let tmpRoot: string;
let store: SqliteRunStore | null = null;

async function freshStore(): Promise<SqliteRunStore> {
  store = new SqliteRunStore(tmpRoot);
  await store.init();
  return store;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-cron-'));
});

afterEach(async () => {
  await store?.close();
  store = null;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('trigger-fire outcomes (cron circuit-breaker store layer)', () => {
  it('counts the trailing run of consecutive failures, reset by a done', async () => {
    const s = await freshStore();
    const key = 'cron:nightly-eval:0 3 * * *';

    // The required scenario: done, error, error, error → 3 consecutive.
    await s.recordTriggerOutcome(key, 'run-1', 'done');
    await s.recordTriggerOutcome(key, 'run-2', 'error');
    await s.recordTriggerOutcome(key, 'run-3', 'error');
    await s.recordTriggerOutcome(key, 'run-4', 'error');
    expect(await s.getConsecutiveFailures(key)).toBe(3);

    // A subsequent success resets the streak to 0.
    await s.recordTriggerOutcome(key, 'run-5', 'done');
    expect(await s.getConsecutiveFailures(key)).toBe(0);
  });

  it('counts error + cancelled, but NOT a server-restart interruption', async () => {
    // Counting ANY non-done status would fire the breaker on things that
    // are not the orchestration failing:
    // `interrupted` means the SERVER restarted mid-run, and `paused` means a
    // run is waiting on a human at an approval gate. Three deploys, or three
    // nights of an unapproved gate, would disable the schedule.
    const s = await freshStore();
    const key = 'cron:flaky:* * * * *';
    await s.recordTriggerOutcome(key, 'r1', 'error');
    await s.recordTriggerOutcome(key, 'r2', 'cancelled');
    await s.recordTriggerOutcome(key, 'r3', 'interrupted');
    expect(await s.getConsecutiveFailures(key)).toBe(2);
  });

  it('a streak of gate-paused fires does not trip the breaker', async () => {
    const s = await freshStore();
    const key = 'cron:needs-approval:0 2 * * *';
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      await s.recordTriggerOutcome(key, id, 'paused');
    }
    expect(await s.getConsecutiveFailures(key)).toBe(0);
  });

  it('returns 0 for a trigger with no fires, and isolates by trigger key', async () => {
    const s = await freshStore();
    expect(await s.getConsecutiveFailures('cron:unknown:0 0 * * *')).toBe(0);

    await s.recordTriggerOutcome('cron:a:* * * * *', 'a1', 'error');
    await s.recordTriggerOutcome('cron:a:* * * * *', 'a2', 'error');
    await s.recordTriggerOutcome('cron:b:* * * * *', 'b1', 'done');
    expect(await s.getConsecutiveFailures('cron:a:* * * * *')).toBe(2);
    expect(await s.getConsecutiveFailures('cron:b:* * * * *')).toBe(0);
  });

  it('orders newest-first by insertion even when timestamps collide', async () => {
    const s = await freshStore();
    const key = 'cron:samems:* * * * *';
    // All four land within the same ms in CI; the AUTOINCREMENT id (not ts)
    // must define newest-first so the streak is still 2 (the trailing errors).
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      await s.recordTriggerOutcome(key, 'r1', 'error');
      await s.recordTriggerOutcome(key, 'r2', 'done');
      await s.recordTriggerOutcome(key, 'r3', 'error');
      await s.recordTriggerOutcome(key, 'r4', 'error');
    } finally {
      Date.now = realNow;
    }
    expect(await s.getConsecutiveFailures(key)).toBe(2);
  });
});

describe('countConsecutiveFailuresNewestFirst (pure)', () => {
  it('stops at the first done', () => {
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'error' },
        { status: 'error' },
        { status: 'done' },
        { status: 'error' },
      ]),
    ).toBe(2);
  });

  it('counts all when there is no done', () => {
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'error' },
        { status: 'cancelled' },
      ]),
    ).toBe(2);
  });

  it('is 0 on empty / leading done', () => {
    expect(countConsecutiveFailuresNewestFirst([])).toBe(0);
    expect(countConsecutiveFailuresNewestFirst([{ status: 'done' }])).toBe(0);
  });

  // These pin the fix for a breaker that treated "anything but done" as a
  // failure. `finalStatus` is legitimately 'paused' when a run parks at a
  // human approval gate and 'interrupted' when the SERVER restarts mid-run —
  // so a nightly cron with a gate accrued a failure every night and, with
  // SAMMY_CRON_AUTO_PAUSE=1, had its schedule disabled although nothing had
  // failed. Three deploys did the same thing.
  it('does NOT count a run parked at a human gate', () => {
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'paused' },
        { status: 'paused' },
        { status: 'paused' },
      ]),
    ).toBe(0);
  });

  it('does NOT count a server-restart interruption, or a run still going', () => {
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'running' },
        { status: 'interrupted' },
        { status: 'interrupted' },
      ]),
    ).toBe(0);
  });

  it('still counts REAL failures either side of a paused run', () => {
    // Skipped, not treated as a reset: genuine errors around a gate still
    // accumulate, so the breaker keeps working.
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'error' },
        { status: 'paused' },
        { status: 'error' },
        { status: 'cancelled' },
      ]),
    ).toBe(3);
  });

  it('a done still ends the streak even past a paused run', () => {
    expect(
      countConsecutiveFailuresNewestFirst([
        { status: 'error' },
        { status: 'paused' },
        { status: 'done' },
        { status: 'error' },
      ]),
    ).toBe(1);
  });
});

describe('cronFailureThreshold (env parse)', () => {
  it('falls back to the default for unset / invalid values', () => {
    expect(cronFailureThreshold({})).toBe(DEFAULT_CRON_FAILURE_THRESHOLD);
    expect(cronFailureThreshold({ SAMMY_CRON_FAILURE_THRESHOLD: 'nope' })).toBe(
      DEFAULT_CRON_FAILURE_THRESHOLD,
    );
    expect(cronFailureThreshold({ SAMMY_CRON_FAILURE_THRESHOLD: '0' })).toBe(
      DEFAULT_CRON_FAILURE_THRESHOLD,
    );
  });

  it('honors a positive override (floored)', () => {
    expect(cronFailureThreshold({ SAMMY_CRON_FAILURE_THRESHOLD: '5' })).toBe(5);
    expect(cronFailureThreshold({ SAMMY_CRON_FAILURE_THRESHOLD: '2.9' })).toBe(2);
  });
});

describe('checkConsecutiveFailures (breaker decision)', () => {
  it('records the outcome and trips at the threshold', async () => {
    const s = await freshStore();
    const key = 'cron:nightly:0 2 * * *';

    let res = await checkConsecutiveFailures(s, key, 'r1', 'error', 3);
    expect(res).toEqual({ failures: 1, threshold: 3, tripped: false });

    res = await checkConsecutiveFailures(s, key, 'r2', 'error', 3);
    expect(res.tripped).toBe(false);

    res = await checkConsecutiveFailures(s, key, 'r3', 'error', 3);
    expect(res).toEqual({ failures: 3, threshold: 3, tripped: true });

    // A success recorded through the helper resets + un-trips.
    res = await checkConsecutiveFailures(s, key, 'r4', 'done', 3);
    expect(res).toEqual({ failures: 0, threshold: 3, tripped: false });
  });
});

describe('cron wall-clock bucketing (DST correctness)', () => {
  /**
   * THE BUG THIS PINS: the dedupe bucket was `Date.now() / 60_000` — EPOCH
   * derived. A cron expression matches WALL-CLOCK fields, and on a DST
   * fall-back the local hour occurs twice, an hour apart in epoch terms. So
   * `30 1 * * *` matched in both passes, landed in two different buckets with
   * two different idempotency keys, and ran a once-daily job TWICE.
   *
   * These use real DST instants in real zones, so they verify the behaviour
   * rather than restating the implementation.
   */
  // US eastern fall-back 2026: 02:00 EDT → 01:00 EST on Nov 1.
  // 05:30 UTC = 01:30 EDT (first pass); 06:30 UTC = 01:30 EST (second).
  const firstPass = new Date('2026-11-01T05:30:00Z');
  const secondPass = new Date('2026-11-01T06:30:00Z');

  it('the two fall-back passes of one local time share a bucket', () => {
    const a = cronWallClockBucket('30 1 * * *', firstPass, 'America/New_York');
    const b = cronWallClockBucket('30 1 * * *', secondPass, 'America/New_York');
    expect(a).toBe(b);
    expect(a).toBe('2026-11-01T01:30');
  });

  it('…whereas the old epoch bucket put them an hour apart', () => {
    // Demonstrates the defect directly: same expression, same local time,
    // two different keys.
    const epochBucket = (d: Date) => Math.floor(d.getTime() / 60_000);
    expect(epochBucket(firstPass)).not.toBe(epochBucket(secondPass));
  });

  it('distinct wall-clock minutes still get distinct buckets', () => {
    // The dedupe must not over-collapse: consecutive ticks are separate work.
    const a = cronWallClockBucket('* * * * *', new Date('2026-06-01T10:00:00Z'), 'UTC');
    const b = cronWallClockBucket('* * * * *', new Date('2026-06-01T10:01:00Z'), 'UTC');
    expect(a).toBe('2026-06-01T10:00');
    expect(b).toBe('2026-06-01T10:01');
  });

  it('a 6-field expression buckets by SECOND, not minute', () => {
    // A legitimate sub-minute schedule must not collapse to one fire/minute.
    const a = cronWallClockBucket('*/5 * * * * *', new Date('2026-06-01T10:00:00Z'), 'UTC');
    const b = cronWallClockBucket('*/5 * * * * *', new Date('2026-06-01T10:00:05Z'), 'UTC');
    expect(a).toBe('2026-06-01T10:00:00');
    expect(b).toBe('2026-06-01T10:00:05');
  });

  it('the bucket is zone-scoped — the same instant differs across zones', () => {
    const utc = cronWallClockBucket('0 * * * *', new Date('2026-06-01T10:00:00Z'), 'UTC');
    const tokyo = cronWallClockBucket(
      '0 * * * *',
      new Date('2026-06-01T10:00:00Z'),
      'Asia/Tokyo',
    );
    expect(utc).not.toBe(tokyo);
  });

  it('midnight renders as 00, not 24', () => {
    // hour12:false renders midnight as "24" in some ICU builds, which would
    // make the midnight slot sort and compare oddly.
    expect(cronWallClockBucket('0 0 * * *', new Date('2026-06-01T00:00:00Z'), 'UTC')).toBe(
      '2026-06-01T00:00',
    );
  });

  it('an unusable zone degrades to the epoch bucket instead of throwing', () => {
    // A throwing tick would stop the schedule; author-time validation
    // rejects a bad zone long before this, so this is pure belt-and-braces.
    const d = new Date('2026-06-01T10:00:00Z');
    expect(() => cronWallClockBucket('* * * * *', d, 'Not/AZone')).not.toThrow();
    expect(cronWallClockBucket('* * * * *', d, 'Not/AZone')).toBe(
      String(Math.floor(d.getTime() / 60_000)),
    );
  });

  it('validates a timezone at author time', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
