/**
 * Merge N async iterables into one, yielding values in arrival order.
 *
 * Used to multiplex events from parallel/converge branch executions so the
 * UI sees streaming output from all branches interleaved as it arrives.
 *
 * If any source iterator throws, the merge throws (caller is responsible
 * for surfacing the error and shutting down siblings via the shared
 * cancellation flag).
 *
 * When the merge stops early (its consumer broke or threw out of its loop, or a
 * source threw), every source still open is closed with `.return()`. A source
 * can wrap a live agent session, and returning its stream is what stops the
 * session (see AgentTokenCeilingError in server/sdk-stream.ts); left open it
 * would keep running, and calling tools, with nobody reading it.
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

  try {
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
  } finally {
    for (let i = 0; i < its.length; i++) {
      const open = pending[i];
      if (!open) continue;
      // Nobody awaits these any more: a late rejection must not surface as unhandled.
      open.catch(() => {});
      try {
        // Not awaited: a source busy in a pending next() closes once that settles.
        Promise.resolve(its[i].return?.()).catch(() => {});
      } catch {
        // A source that can't be closed is left as it was.
      }
    }
  }
}
