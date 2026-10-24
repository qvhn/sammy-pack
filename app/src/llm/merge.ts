/**
 * Merge N async iterables into one, yielding values in arrival order.
 *
 * Used to multiplex events from parallel/converge branch executions so the
 * UI sees streaming output from all branches interleaved as it arrives.
 *
 * If any source iterator throws, the merge throws (caller is responsible
 * for surfacing the error and shutting down siblings via the shared
 * cancellation flag).
 */
export async function* mergeIterators<T>(
  iters: AsyncIterable<T>[],
): AsyncIterable<T> {
  if (iters.length === 0) return;
  const its = iters.map(it => it[Symbol.asyncIterator]());

  type Pending = { idx: number; result: IteratorResult<T> };
  const pending: (Promise<Pending> | null)[] = its.map((it, i) =>
    it.next().then(result => ({ idx: i, result })),
  );

  while (true) {
    const candidates: Promise<Pending>[] = [];
    for (const p of pending) if (p) candidates.push(p);
    if (candidates.length === 0) return;
    const winner = await Promise.race(candidates);
    if (winner.result.done) {
      pending[winner.idx] = null;
    } else {
      yield winner.result.value;
      pending[winner.idx] = its[winner.idx]
        .next()
        .then(result => ({ idx: winner.idx, result }));
    }
  }
}
