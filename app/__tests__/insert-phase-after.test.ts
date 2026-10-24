/**
 * Unit tests for `insertPhaseAfter` — selection drives where an insertion
 * lands, rather than everything appending to the root.
 *
 * ── Why the import matters ───────────────────────────────────────────────
 * While the helper was component-internal to `GraphEditor.web.tsx` a test
 * could not reach it, and a test over a COPY of the logic proves nothing
 * about the shipped code: replace the real `insertPhaseAfter` with
 * `return orchestration` — deleting the feature outright — and every case
 * over the copy stays green. A test that reports coverage it does not have is
 * worse than no test, because it tells the next engineer they are covered.
 *
 * The helper lives in `src/lib/orchestrationMutate.ts` alongside the other
 * tree mutations, and this file imports the REAL implementation — so deleting
 * or breaking it turns these red.
 */

import { insertPhaseAfter } from '../src/lib/orchestrationMutate';
import type { Node } from '../src/types';

// ─── Test fixtures ───
const newPhase = (name: string): Node => ({ name, agent: 'agents/x.md' });

describe('insertPhaseAfter — selection drives insertion', () => {
  it('falls back to root append when no selection', () => {
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    };
    const next = insertPhaseAfter(orch, null, newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual(['A', 'B', 'C', 'NEW']);
  });

  it('inserts after a leaf at root level (the user\'s catch)', () => {
    // Reproduces the exact scenario the user reported: select B, add a
    // new phase — it should land at index 2, not at the end.
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    };
    const next = insertPhaseAfter(orch, 'B', newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual(['A', 'B', 'NEW', 'C', 'D']);
  });

  it('inserts after the first node when first is selected', () => {
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    };
    const next = insertPhaseAfter(orch, 'A', newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual(['A', 'NEW', 'B', 'C']);
  });

  it('inserts after the last node when last is selected', () => {
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    };
    const next = insertPhaseAfter(orch, 'C', newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual(['A', 'B', 'C', 'NEW']);
  });

  it('inserts inside a parallel group when a child is selected', () => {
    // Mirrors the architect-engineers-reviewer fixture: engineers is a
    // parallel with track-a/b/c. Selecting track-b and adding should
    // produce track-a, track-b, NEW, track-c.
    const orch: Node = {
      name: 'arc',
      phases: [
        { name: 'architect' },
        {
          name: 'engineers',
          parallel: [
            { name: 'track-a' },
            { name: 'track-b' },
            { name: 'track-c' },
          ],
        },
        { name: 'reviewer' },
      ],
    };
    const next = insertPhaseAfter(orch, 'track-b', newPhase('NEW'));
    const engineers = next.phases?.find(p => p.name === 'engineers');
    expect(engineers?.parallel?.map(p => p.name)).toEqual([
      'track-a',
      'track-b',
      'NEW',
      'track-c',
    ]);
    // Root level untouched
    expect(next.phases?.map(p => p.name)).toEqual([
      'architect',
      'engineers',
      'reviewer',
    ]);
  });

  it('inserts inside a converge group when a child is selected', () => {
    const orch: Node = {
      name: 'root',
      phases: [
        {
          name: 'merge',
          converge: [{ name: 'x' }, { name: 'y' }],
        },
      ],
    };
    const next = insertPhaseAfter(orch, 'x', newPhase('NEW'));
    const merge = next.phases?.[0];
    expect(merge?.converge?.map(p => p.name)).toEqual(['x', 'NEW', 'y']);
  });

  it('inserts inside a nested phases group', () => {
    const orch: Node = {
      name: 'root',
      phases: [
        {
          name: 'outer',
          phases: [{ name: 'inner-a' }, { name: 'inner-b' }],
        },
      ],
    };
    const next = insertPhaseAfter(orch, 'inner-a', newPhase('NEW'));
    expect(next.phases?.[0].phases?.map(p => p.name)).toEqual([
      'inner-a',
      'NEW',
      'inner-b',
    ]);
  });

  it('falls back to root append when selection is stale / not found', () => {
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }],
    };
    const next = insertPhaseAfter(orch, 'does-not-exist', newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual(['A', 'B', 'NEW']);
  });

  it('selecting a composite container inserts AFTER it at the parent level (sibling, not child)', () => {
    // Decision: selecting `engineers` (the parallel composite itself)
    // means "add another phase after engineers" — not "add another
    // branch inside engineers." Predictable + matches the
    // selection-as-cursor mental model. Use "+ child" affordances
    // (PR 15) for the "add into" case.
    const orch: Node = {
      name: 'arc',
      phases: [
        { name: 'architect' },
        {
          name: 'engineers',
          parallel: [{ name: 'track-a' }, { name: 'track-b' }],
        },
        { name: 'reviewer' },
      ],
    };
    const next = insertPhaseAfter(orch, 'engineers', newPhase('NEW'));
    expect(next.phases?.map(p => p.name)).toEqual([
      'architect',
      'engineers',
      'NEW',
      'reviewer',
    ]);
    // Composite's children untouched
    const engineers = next.phases?.find(p => p.name === 'engineers');
    expect(engineers?.parallel?.map(p => p.name)).toEqual([
      'track-a',
      'track-b',
    ]);
  });

  it('does not mutate the input orchestration', () => {
    const orch: Node = {
      name: 'root',
      phases: [{ name: 'A' }, { name: 'B' }],
    };
    const orchSnapshot = JSON.stringify(orch);
    insertPhaseAfter(orch, 'A', newPhase('NEW'));
    expect(JSON.stringify(orch)).toBe(orchSnapshot);
  });

  it('handles deeply-nested parallel inside parallel', () => {
    const orch: Node = {
      name: 'root',
      phases: [
        {
          name: 'outer',
          parallel: [
            {
              name: 'inner-group',
              parallel: [{ name: 'leaf-a' }, { name: 'leaf-b' }],
            },
            { name: 'sibling' },
          ],
        },
      ],
    };
    const next = insertPhaseAfter(orch, 'leaf-a', newPhase('NEW'));
    expect(
      next.phases?.[0].parallel?.[0].parallel?.map(p => p.name),
    ).toEqual(['leaf-a', 'NEW', 'leaf-b']);
  });

  it('respects selection through map.body single-node container', () => {
    const orch: Node = {
      name: 'root',
      phases: [
        {
          name: 'mapper',
          map: {
            over: 'items',
            body: {
              name: 'body-group',
              phases: [{ name: 'step-1' }, { name: 'step-2' }],
            },
          },
        },
      ],
    };
    const next = insertPhaseAfter(orch, 'step-1', newPhase('NEW'));
    expect(
      next.phases?.[0].map?.body.phases?.map(p => p.name),
    ).toEqual(['step-1', 'NEW', 'step-2']);
  });
});
