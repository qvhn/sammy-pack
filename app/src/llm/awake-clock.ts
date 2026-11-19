/**
 * Time the machine was awake — the clock step timeouts, stall windows and
 * group deadlines count on, so a laptop that sleeps mid-run doesn't wake to a
 * pile of "timed out" steps. Like Claude Code in a terminal: the work pauses
 * with the machine and carries on when it wakes.
 *
 * How sleep is seen. The wall clock (`Date.now()`) keeps counting through
 * sleep; the monotonic clock (`performance.now()`) doesn't on macOS and Linux.
 * Every reading compares how far each moved since the last one, and the
 * difference is time asleep. On Windows the monotonic clock may count through
 * sleep too, so there a gap of more than SLEEP_GAP_MS between readings that
 * the ticker below should have filled is also taken as sleep. (Elsewhere a gap
 * like that is a blocked event loop, which is real time and still counts.)
 *
 * A reading happens on every call, and an unref'd ticker keeps readings
 * frequent, so the first call after waking already knows about the sleep and
 * `onWake` listeners hear of it within a tick.
 */

/** How often the ticker takes a reading. */
const TICK_MS = 1_000;
/** A gap this long between readings is a sleep, not clock jitter. */
const SLEEP_GAP_MS = 15_000;

type Clocks = { wall: () => number; mono: () => number; platform: string };

const realClocks: Clocks = {
  wall: () => Date.now(),
  mono: () => performance.now(),
  platform: process.platform,
};

let clocks: Clocks = realClocks;
let lastWall = clocks.wall();
let lastMono = clocks.mono();
let sleptMs = 0;
const listeners = new Set<(sleptMs: number) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function read(): void {
  const wall = clocks.wall();
  const mono = clocks.mono();
  const wallGap = wall - lastWall;
  const monoGap = mono - lastMono;
  lastWall = wall;
  lastMono = mono;
  let slept = wallGap - monoGap;
  if (clocks.platform === 'win32' && slept < SLEEP_GAP_MS && monoGap > SLEEP_GAP_MS) {
    slept = monoGap - TICK_MS;
  }
  if (slept < SLEEP_GAP_MS) return;
  sleptMs += slept;
  for (const fn of [...listeners]) {
    try {
      fn(slept);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(read, TICK_MS);
  (ticker as unknown as { unref?: () => void }).unref?.();
}

/** Milliseconds on a clock that stops while the machine sleeps. Only
 *  differences between two readings mean anything. */
export function awakeNow(): number {
  ensureTicker();
  read();
  return clocks.wall() - sleptMs;
}

/** Hear about each sleep once the machine wakes, with how long it slept.
 *  Returns the unsubscribe. */
export function onWake(fn: (sleptMs: number) => void): () => void {
  ensureTicker();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: drive the clocks by hand. `null` restores the real ones. */
export function setClocksForTests(next: Clocks | null): void {
  clocks = next ?? realClocks;
  lastWall = clocks.wall();
  lastMono = clocks.mono();
  sleptMs = 0;
}

/** Test seam: take a reading now, as the ticker would. */
export function tickForTests(): void {
  read();
}
