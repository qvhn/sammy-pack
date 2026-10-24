/**
 * Wall-clock bucketing for a cron fire's idempotency key.
 *
 * node-cron can deliver the same scheduled tick more than once — catch-up
 * after the event loop stalls, or a duplicate registration around the fire
 * window — so each tick carries a bucketed header idempotency key, and the
 * extra fires collapse onto it.
 *
 * The bucket used to be `Math.floor(Date.now() / 60_000)`: EPOCH-derived.
 * That is wrong for the one case it most needed to be right. A cron
 * expression matches WALL-CLOCK fields, and on a DST fall-back the local hour
 * occurs twice — so `30 1 * * *` matches in both passes, an hour apart in
 * epoch terms, landing in two different buckets with two different keys and
 * producing TWO runs of a job scheduled once a day. (Spring-forward is the
 * mirror image: the hour never exists, so the fire is silently skipped. That
 * one is node-cron's behaviour and matches conventional cron; it is
 * documented rather than worked around.)
 *
 * Bucketing on the wall-clock slot instead makes the repeated hour collapse
 * to one fire, which is both the fix and what Vixie-style cron does.
 *
 * Pure and dependency-free so the DST cases are unit-testable without
 * waiting for October.
 */

/** Cron field counts: 5 = minute granularity, 6 = leading seconds field. */
export function cronBucketGranularity(expr: string): 'minute' | 'second' {
  return expr.trim().split(/\s+/).length >= 6 ? 'second' : 'minute';
}

/**
 * The wall-clock slot a fire belongs to, as a stable string.
 *
 * `timeZone` is an IANA name (the trigger's `timezone`, or undefined for
 * server-local, which is what `cron.schedule` itself defaults to). Both must
 * read the same zone or the key would not describe the slot that actually
 * matched.
 *
 * Falls back to the epoch bucket if the zone is unusable — a bad key is
 * better than a throwing cron tick, and author-time validation rejects an
 * invalid zone long before this.
 */
export function cronWallClockBucket(
  expr: string,
  now: Date,
  timeZone?: string,
): string {
  const granularity = cronBucketGranularity(expr);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find(p => p.type === type)?.value ?? '00';
    // `hour12: false` can render midnight as "24" in some ICU versions.
    const hour = get('hour') === '24' ? '00' : get('hour');
    const slot =
      `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}` +
      (granularity === 'second' ? `:${get('second')}` : '');
    return slot;
  } catch {
    const bucketMs = granularity === 'second' ? 1_000 : 60_000;
    return String(Math.floor(now.getTime() / bucketMs));
  }
}

/** True when `tz` is an IANA zone this runtime can resolve. Used by the
 *  author-time validator so a typo is a lint error rather than a cron that
 *  throws on every tick. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
