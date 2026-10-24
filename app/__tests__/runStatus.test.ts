/**
 * Unit tests for the shared live-run-status derivation
 * (app/src/lib/runStatus.ts) used by the Pipeline / Graph / Tree views and
 * the sidebar to highlight progress as a run streams.
 */

import {
  collectNodeNames,
  deriveRunStatus,
  STATUS_COLOR,
  type NodeRunStatus,
} from '../src/lib/runStatus';
import type { Node } from '../src/types';

const orch: Node = {
  name: 'root',
  phases: [
    { name: 'a', agent: 'x' },
    {
      name: 'loopy',
      loop: {
        body: {
          name: 'body',
          phases: [
            { name: 'impl', agent: 'd' },
            { name: 'qa', agent: 'q' },
          ],
        },
        maxIterations: 3,
      },
    },
    { name: 'b', agent: 'y' },
  ],
};

// Minimal event factory — `as any` because the test only needs the fields the
// deriver reads (the real RunEvent union is large).
const ev = (e: Record<string, unknown>) => e as any;

describe('collectNodeNames', () => {
  test('walks phases + loop body + nested phases', () => {
    expect(collectNodeNames(orch).sort()).toEqual([
      'a',
      'b',
      'body',
      'impl',
      'loopy',
      'qa',
      'root',
    ]);
  });

  test('walks parallel / converge / map / route branches', () => {
    const n: Node = {
      name: 'r',
      phases: [
        { name: 'par', parallel: [{ name: 'p1' }, { name: 'p2' }] },
        { name: 'conv', converge: [{ name: 'c1' }], merger: 'm' },
        { name: 'mp', map: { over: '[]', body: { name: 'item' } } },
        {
          name: 'rt',
          route: {
            branches: { x: { name: 'bx' } },
            default: { name: 'bd' },
          },
        },
      ],
    };
    expect(collectNodeNames(n).sort()).toEqual([
      'bd',
      'bx',
      'c1',
      'conv',
      'item',
      'mp',
      'p1',
      'p2',
      'par',
      'r',
      'rt',
    ]);
  });
});

describe('deriveRunStatus', () => {
  test('seeds pending and derives running/done/pending from events', () => {
    const info = deriveRunStatus(
      [
        ev({ type: 'run-start', orchestrationName: 'root', ts: 1 }),
        ev({ type: 'phase-start', phaseName: 'a', ts: 2 }),
        ev({ type: 'phase-end', phaseName: 'a', output: '', ts: 3 }),
        ev({ type: 'composite-start', phaseName: 'loopy', kind: 'loop', ts: 4 }),
        ev({ type: 'loop-iteration', phaseName: 'loopy', iteration: 2, ts: 5 }),
        ev({ type: 'phase-start', phaseName: 'impl', ts: 6 }),
      ],
      collectNodeNames(orch),
    );
    expect(info.statusByNode.get('a')).toBe('done');
    expect(info.statusByNode.get('loopy')).toBe('running');
    expect(info.statusByNode.get('impl')).toBe('running');
    expect(info.statusByNode.get('qa')).toBe('pending');
    expect(info.statusByNode.get('b')).toBe('pending');
    expect(info.activePhase).toBe('impl');
    expect(info.loopIterByNode.get('loopy')).toBe(2);
  });

  test('error is sticky — a re-entered phase never downgrades from error', () => {
    const info = deriveRunStatus([
      ev({ type: 'phase-start', phaseName: 'a', ts: 1 }),
      ev({ type: 'phase-error', phaseName: 'a', error: 'boom', ts: 2 }),
      ev({ type: 'phase-start', phaseName: 'a', ts: 3 }),
      ev({ type: 'phase-end', phaseName: 'a', output: '', ts: 4 }),
    ]);
    expect(info.statusByNode.get('a')).toBe('error');
  });

  test('skipped / map-progress / route-decision are captured', () => {
    const info = deriveRunStatus([
      ev({ type: 'phase-skipped', phaseName: 's', reason: 'when=false', ts: 1 }),
      ev({ type: 'map-iteration', phaseName: 'm', iteration: 2, total: 5, ts: 2 }),
      ev({ type: 'route-decision', phaseName: 'r', branch: 'beta', ts: 3 }),
    ]);
    expect(info.statusByNode.get('s')).toBe('skipped');
    expect(info.mapProgressByNode.get('m')).toEqual({ iteration: 2, total: 5 });
    expect(info.routeDecisionByNode.get('r')).toBe('beta');
  });

  test('activePhase is null once the open phase ends', () => {
    const info = deriveRunStatus([
      ev({ type: 'phase-start', phaseName: 'a', ts: 1 }),
      ev({ type: 'phase-end', phaseName: 'a', output: '', ts: 2 }),
    ]);
    expect(info.activePhase).toBeNull();
  });

  test('no seed names ⇒ only touched nodes appear', () => {
    const info = deriveRunStatus([
      ev({ type: 'phase-start', phaseName: 'only', ts: 1 }),
    ]);
    expect(info.statusByNode.get('only')).toBe('running');
    expect(info.statusByNode.has('a')).toBe(false);
  });
});

describe('STATUS_COLOR', () => {
  test('has a color for every status', () => {
    for (const s of [
      'pending',
      'running',
      'done',
      'error',
      'skipped',
    ] as NodeRunStatus[]) {
      expect(typeof STATUS_COLOR[s]).toBe('string');
      expect(STATUS_COLOR[s]).toMatch(/^#/);
    }
  });
});
