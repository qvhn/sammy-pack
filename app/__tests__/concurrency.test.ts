import { Semaphore } from '../src/llm/concurrency';

/** Resolve on the next macrotask so we can observe scheduling order. */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('Semaphore', () => {
  it('never lets more than `max` holders run at once', async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const work = async () => {
      const release = await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 20 }, work));
    expect(peak).toBe(3);
    expect(sem.inUse).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('grants slots FIFO', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = await sem.acquire(); // hold the only slot
    const queued = [1, 2, 3].map(async n => {
      const release = await sem.acquire();
      order.push(n);
      release();
    });
    await tick();
    expect(order).toEqual([]); // all still blocked behind `first`
    first(); // release → drains 1, then 2, then 3 in order
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent (safe to call from a finally twice)', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    expect(sem.inUse).toBe(1);
    release();
    release(); // must NOT drop the count below the real holders
    expect(sem.inUse).toBe(0);
    // A fresh acquire still works and isn't over-granted.
    const r2 = await sem.acquire();
    expect(sem.inUse).toBe(1);
    r2();
  });

  it('a holder waiting on its own follow-up acquire cannot deadlock (leaf-only invariant)', async () => {
    // Models the executor invariant: a slot-holder (a leaf) never blocks on a
    // SECOND slot while holding the first. Here each task acquires, does work,
    // releases, THEN acquires again — so the pool always drains.
    const sem = new Semaphore(2);
    let done = 0;
    const task = async () => {
      const a = await sem.acquire();
      await tick();
      a();
      const b = await sem.acquire();
      await tick();
      b();
      done += 1;
    };
    await Promise.all(Array.from({ length: 10 }, task));
    expect(done).toBe(10);
    expect(sem.inUse).toBe(0);
  });

  it('setLimit grows the pool and wakes queued waiters', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    let secondRan = false;
    const second = (async () => {
      const r = await sem.acquire();
      secondRan = true;
      r();
    })();
    await tick();
    expect(secondRan).toBe(false); // blocked at limit 1
    sem.setLimit(2); // grow → the queued waiter gets a slot without `held` releasing
    await second;
    expect(secondRan).toBe(true);
    held();
    expect(sem.inUse).toBe(0);
  });

  it('clamps a bogus limit to at least 1', () => {
    expect(new Semaphore(0).limit).toBe(1);
    expect(new Semaphore(-5).limit).toBe(1);
    const s = new Semaphore(4);
    s.setLimit(0);
    expect(s.limit).toBe(1);
  });
});

describe('Semaphore queue introspection + reorder', () => {
  it('snapshot exposes queued waiters with their metadata in grant order', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire({ runId: 'r0', phaseName: 'holder' });
    const queued = ['a', 'b', 'c'].map(p =>
      sem.acquire({ runId: `run-${p}`, orchestrationName: 'orch', phaseName: p }),
    );
    await tick();
    const snap = sem.snapshot();
    expect(snap.map(w => w.phaseName)).toEqual(['a', 'b', 'c']);
    expect(snap.map(w => w.position)).toEqual([0, 1, 2]);
    expect(snap[0].runId).toBe('run-a');
    expect(snap[0].orchestrationName).toBe('orch');
    expect(typeof snap[0].id).toBe('string');
    expect(snap[0].enqueuedAt).toBeGreaterThan(0);
    // The holder is in-flight, not queued — it must not appear.
    expect(snap.find(w => w.phaseName === 'holder')).toBeUndefined();
    held();
    for (const p of queued) (await p)();
    expect(sem.waiting).toBe(0);
  });

  it('moveWaiter reorders the grant order; drain honors the new order', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const held = await sem.acquire({ phaseName: 'holder' });
    const launch = (p: string) =>
      (async () => {
        const r = await sem.acquire({ phaseName: p });
        order.push(p);
        r();
      })();
    const all = [launch('a'), launch('b'), launch('c')];
    await tick();
    // Promote 'c' (last) to the front.
    const snap = sem.snapshot();
    const cId = snap.find(w => w.phaseName === 'c')!.id;
    expect(sem.moveWaiter(cId, 0)).toBe(true);
    expect(sem.snapshot().map(w => w.phaseName)).toEqual(['c', 'a', 'b']);
    held(); // drain in the NEW order
    await Promise.all(all);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('bumpWaiter moves one place up/down and clamps at the ends', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const held = await sem.acquire();
    const launch = (p: string) =>
      (async () => {
        const r = await sem.acquire({ phaseName: p });
        order.push(p);
        r();
      })();
    const all = [launch('a'), launch('b'), launch('c')];
    await tick();
    const idFor = (p: string) =>
      sem.snapshot().find(w => w.phaseName === p)!.id;
    sem.bumpWaiter(idFor('b'), 'up'); // b above a
    expect(sem.snapshot().map(w => w.phaseName)).toEqual(['b', 'a', 'c']);
    sem.bumpWaiter(idFor('b'), 'up'); // already first → clamp, no-op
    expect(sem.snapshot().map(w => w.phaseName)).toEqual(['b', 'a', 'c']);
    sem.bumpWaiter(idFor('c'), 'down'); // already last → clamp, no-op
    expect(sem.snapshot().map(w => w.phaseName)).toEqual(['b', 'a', 'c']);
    held(); // drains in the bumped order
    await Promise.all(all);
    expect(order).toEqual(['b', 'a', 'c']);
  });

  it('moveWaiter returns false for an unknown / already-drained id', async () => {
    const sem = new Semaphore(2);
    expect(sem.moveWaiter('w-does-not-exist', 0)).toBe(false);
    expect(sem.bumpWaiter('w-does-not-exist', 'up')).toBe(false);
    // No waiters at all (under the cap) → empty snapshot.
    const r = await sem.acquire({ phaseName: 'solo' });
    expect(sem.snapshot()).toEqual([]);
    r();
  });
});
