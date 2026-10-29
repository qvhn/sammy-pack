/**
 * mergeIterators closes the sources it was reading when it stops early: its
 * consumer broke out (or threw out) of the loop, or a source threw. A source
 * can wrap a live agent session (an SDK stream), and returning that stream is
 * what stops the session; left open, it would keep running with nobody
 * reading it.
 */

import { mergeIterators } from '../src/llm/merge';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A source that yields `n` values, a few ms apart, and records when it is closed. */
function source(name: string, n: number, closed: string[], opts: { throwAt?: number } = {}) {
  return (async function* () {
    try {
      for (let i = 0; i < n; i++) {
        await tick(3);
        if (opts.throwAt === i) throw new Error(`${name} broke`);
        yield `${name}${i}`;
      }
    } finally {
      closed.push(name);
    }
  })();
}

describe('mergeIterators', () => {
  it('a consumer that stops early closes every source still open', async () => {
    const closed: string[] = [];
    for await (const v of mergeIterators([source('a', 100, closed), source('b', 100, closed)])) {
      expect(v).toMatch(/^[ab]0$/);
      break;
    }
    await tick(30);
    expect(closed.sort()).toEqual(['a', 'b']);
  });

  it('a consumer that throws out of the loop closes the sources too', async () => {
    const closed: string[] = [];
    await expect(
      (async () => {
        for await (const _ of mergeIterators([source('a', 100, closed), source('b', 100, closed)])) {
          throw new Error('consumer stopped');
        }
      })(),
    ).rejects.toThrow('consumer stopped');
    await tick(30);
    expect(closed.sort()).toEqual(['a', 'b']);
  });

  it('a source that throws closes the others, and the merge throws', async () => {
    const closed: string[] = [];
    await expect(
      (async () => {
        for await (const _ of mergeIterators([source('a', 100, closed, { throwAt: 2 }), source('b', 100, closed)])) {
          // read on
        }
      })(),
    ).rejects.toThrow('a broke');
    await tick(30);
    expect(closed.sort()).toEqual(['a', 'b']);
  });

  it('sources that run to the end are read in full and closed once', async () => {
    const closed: string[] = [];
    const seen: string[] = [];
    for await (const v of mergeIterators([source('a', 2, closed), source('b', 3, closed)])) seen.push(v);
    await tick(10);
    expect(seen.sort()).toEqual(['a0', 'a1', 'b0', 'b1', 'b2']);
    expect(closed.sort()).toEqual(['a', 'b']);
  });
});
