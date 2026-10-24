/**
 * The Approvals page's pure logic (src/pages/approvalsModel.ts): which phase
 * output a gate card shows, the review thread, output formatting, artifacts
 * and the deck/tally.
 */
import type { RunEvent } from '../src/llm/executor';
import {
  buildDeck,
  buildThread,
  decisionLabel,
  extractArtifacts,
  extractGate,
  fanOutReplacesPlan,
  formatOutput,
  isControlOutput,
  tally,
  type Outcome,
} from '../src/pages/approvalsModel';

let ts = 1000;
const ev = (e: Record<string, unknown>): RunEvent =>
  ({ ts: ts++, ...e }) as unknown as RunEvent;
const phase = (name: string, output: string): RunEvent[] => [
  ev({ type: 'phase-start', phaseName: name }),
  ev({ type: 'phase-end', phaseName: name, output }),
];

const BRIEF = [
  '## Goal',
  '',
  'Add a `median(values)` helper alongside the existing helpers.',
  '',
  '## Questions',
  '',
  '1. Should an empty array throw or return undefined?',
].join('\n');
const REVIEW = 'Reviewed the diff: the helper sorts a copy, tests cover odd and even lengths. PASS.';
const QA = 'Ran the suite live: 6/6 green, mutation probe confirms the input is not mutated. PASS.';
const DECIDE = [
  '**Scope verdict: approve**',
  '',
  'Review and QA agree; every acceptance criterion has observed evidence.',
  '',
  'DECISION: SHIP',
].join('\n');

/** A ticket-to-pr-shaped run paused at its `open-pr` gate: plan → (code)
 *  needs-answers → build loop { implement → parallel checks { review, qa } →
 *  decide } → lock open-pr. */
function openPrGateRun(): RunEvent[] {
  return [
    ev({ type: 'run-start', orchestrationName: 'ticket-to-pr' }),
    ...phase('plan', BRIEF),
    ...phase('needs-answers', 'no'),
    ev({ type: 'phase-skipped', phaseName: 'answers' }),
    ev({ type: 'composite-start', phaseName: 'build', kind: 'loop' }),
    ...phase('implement', 'Implemented the helper and its tests; all tests pass. Committed.'),
    ev({ type: 'composite-start', phaseName: 'checks', kind: 'parallel' }),
    ev({ type: 'phase-start', phaseName: 'review' }),
    ev({ type: 'phase-start', phaseName: 'qa' }),
    ev({ type: 'phase-end', phaseName: 'review', output: REVIEW }),
    ev({ type: 'phase-end', phaseName: 'qa', output: QA }),
    ev({ type: 'composite-end', phaseName: 'checks', kind: 'parallel' }),
    ...phase('decide', DECIDE),
    ev({ type: 'loop-stopped', phaseName: 'build' }),
    ev({ type: 'composite-end', phaseName: 'build', kind: 'loop' }),
    ev({ type: 'lock-gate', phaseName: 'open-pr' }),
    ev({ type: 'run-paused', pausedFor: 'open-pr' }),
  ];
}

describe('isControlOutput — classified on the output, never the phase name', () => {
  it('flags mechanical tokens and small control objects', () => {
    expect(isControlOutput('DECISION: SHIP')).toBe(true);
    expect(isControlOutput('needs-review')).toBe(true);
    expect(isControlOutput('{"branch":"default"}')).toBe(true);
    expect(
      isControlOutput('{"status":"ENV_READY","sha":"abc123def456","sims":3,"note":"warm cache reused ok"}'),
    ).toBe(true);
  });
  it('treats prose — even a decision ending in a verdict token — as content', () => {
    expect(isControlOutput(DECIDE)).toBe(false);
    expect(isControlOutput('All six acceptance criteria met; ship it.')).toBe(false);
    expect(isControlOutput('[{"id":"A-1"},{"id":"A-2"}]')).toBe(false);
  });
});

describe('extractGate', () => {
  it('open-pr gate: shows the decide output, not the review/qa fan-out', () => {
    const g = extractGate(openPrGateRun());
    expect(g?.gatedPhase).toBe('open-pr');
    expect(g?.planPhase).toBe('decide');
    expect(g?.plan).toBe(DECIDE);
    expect(g?.plan).toMatch(/DECISION: SHIP$/);
    expect(g?.upstream).toEqual(['qa', 'review', 'implement']);
  });

  it('answers gate: shows the plan brief including its Questions', () => {
    const events = [
      ev({ type: 'run-start', orchestrationName: 'ticket-to-pr' }),
      ...phase('plan', BRIEF),
      ...phase('needs-answers', 'yes'),
      ev({ type: 'lock-gate', phaseName: 'answers' }),
      ev({ type: 'run-paused', pausedFor: 'answers' }),
    ];
    const g = extractGate(events);
    expect(g?.gatedPhase).toBe('answers');
    expect(g?.planPhase).toBe('plan');
    expect(g?.plan).toContain('## Questions');
  });

  it('skips a router token in favor of the substantive output behind it', () => {
    const events = [
      ...phase('synthesize', 'A long synthesized report of everything the run found.'),
      ...phase('route/router', '{"branch":"default"}'),
      ev({ type: 'run-paused', pausedFor: 'publish' }),
    ];
    expect(extractGate(events)?.planPhase).toBe('synthesize');
  });

  it('falls back to the control output when nothing substantive exists', () => {
    const events = [
      ...phase('route/router', '{"branch":"default"}'),
      ev({ type: 'run-paused', pausedFor: 'publish' }),
    ];
    const g = extractGate(events);
    expect(g?.plan).toBe('{"branch":"default"}');
    expect(g?.planPhase).toBe('route/router');
  });

  it('upstream never names the plan phase itself, nor a phase twice', () => {
    // A resumed run replays its completed leaves, so the same phases appear
    // again behind the latest output.
    const events = [
      ...phase('fetch', 'Fetched the source event payload and normalized it.'),
      ...phase('read-event', 'The event describes a failed nightly build on main.'),
      ev({ type: 'run-resumed', pausedFor: 'x' }),
      ...phase('fetch', 'Fetched the source event payload and normalized it.'),
      ...phase('read-event', 'The event describes a failed nightly build on main.'),
      ev({ type: 'run-paused', pausedFor: 'notify' }),
    ];
    const g = extractGate(events);
    expect(g?.planPhase).toBe('read-event');
    expect(g?.upstream).toEqual(['fetch']);
  });

  it('uses the run-level pausedFor when the events carry no sentinel', () => {
    expect(extractGate([], 'open-pr')?.gatedPhase).toBe('open-pr');
    expect(extractGate([])).toBeNull();
  });
});

describe('fanOutReplacesPlan', () => {
  const fanOut = { branches: [{ name: 'review' }, { name: 'qa' }] };
  it('keeps a later decision as the headline', () => {
    expect(fanOutReplacesPlan(fanOut, 'decide')).toBe(false);
  });
  it('replaces the plan when the gate sits right after the fan-out', () => {
    expect(fanOutReplacesPlan(fanOut, 'qa')).toBe(true);
    expect(fanOutReplacesPlan(fanOut, null)).toBe(true);
    expect(fanOutReplacesPlan(null, 'qa')).toBe(false);
  });
});

describe('buildThread', () => {
  it('plan → feedback → revision, skipping checkpoint replays', () => {
    const events = [
      ...phase('decide', DECIDE),
      ev({ type: 'run-paused', pausedFor: 'open-pr' }),
      ev({
        type: 'gate-decision',
        phaseName: 'open-pr',
        decision: 'request-changes',
        message: 'Also add a mode() helper.',
        decidedBy: 'system',
      }),
      ev({ type: 'run-resumed', pausedFor: 'open-pr' }),
      ...phase('decide', `${DECIDE}\n\n(mode added)`),
      // A later resume replays the identical output — not a new revision.
      ...phase('decide', `${DECIDE}\n\n(mode added)`),
    ];
    const thread = buildThread(events, 'decide');
    expect(thread.map(t => t.kind)).toEqual(['agent', 'user', 'agent']);
    const user = thread[1];
    // `system` is the server's no-identity placeholder → not an actor.
    expect(user.kind === 'user' && user.decidedBy).toBeFalsy();
  });

  it('drops a bare identity-less approval, keeps a named approver', () => {
    const events = [
      ev({ type: 'gate-decision', decision: 'approve', message: '', decidedBy: 'system' }),
      ev({ type: 'gate-decision', decision: 'approve', message: '', decidedBy: 'dana' }),
    ];
    const thread = buildThread(events, null);
    expect(thread).toHaveLength(1);
    expect(thread[0].kind === 'user' && thread[0].decidedBy).toBe('dana');
  });
});

describe('decisionLabel', () => {
  it('labels identity-less feedback as the viewer\'s, a named one by name', () => {
    expect(decisionLabel({ decision: 'request-changes' })).toBe('You · Requested changes');
    expect(decisionLabel({ decision: 'request-changes', decidedBy: 'system' })).toBe(
      'You · Requested changes',
    );
    expect(decisionLabel({ decision: 'approve', decidedBy: 'dana' })).toBe('dana · Approved');
  });
});

describe('formatOutput', () => {
  it('pretty-prints JSON objects and arrays', () => {
    expect(formatOutput('{"a":1,"b":[1,2]}')).toEqual({
      kind: 'json',
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    });
    expect(formatOutput('```json\n[{"id":"A-1"}]\n```').kind).toBe('json');
  });
  it('decodes a JSON-encoded string into real lines', () => {
    expect(formatOutput('"## Plan\\n\\n- step one"')).toEqual({
      kind: 'text',
      text: '## Plan\n\n- step one',
    });
  });
  it('unescapes literal \\n in single-line text', () => {
    expect(formatOutput('line one\\nline two').text).toBe('line one\nline two');
  });
  it('leaves ordinary markdown and non-JSON braces alone', () => {
    expect(formatOutput(BRIEF)).toEqual({ kind: 'text', text: BRIEF });
    expect(formatOutput('{not json} but prose').kind).toBe('text');
    expect(formatOutput('[a link](https://example.com)').kind).toBe('text');
  });
});

describe('extractArtifacts', () => {
  it('lists one entry per name, latest wins', () => {
    const events = [
      ev({ type: 'artifact', phaseName: 'run-tests', name: 'test-log', bytes: 10, truncated: false }),
      ev({ type: 'artifact', phaseName: 'build', name: 'build-log', bytes: 5, truncated: false }),
      ev({ type: 'artifact', phaseName: 'run-tests', name: 'test-log', bytes: 2048, truncated: true }),
    ];
    expect(extractArtifacts(events)).toEqual([
      { name: 'test-log', phaseName: 'run-tests', bytes: 2048, truncated: true, dropped: false },
      { name: 'build-log', phaseName: 'build', bytes: 5, truncated: false, dropped: false },
    ]);
  });
});

describe('deck + tally', () => {
  const run = (id: string, pausedAt: number, stale = false) => ({ id, pausedAt, stale });
  it('the tally survives a poll that rebuilds the deck', () => {
    const outcomes: Record<string, Outcome> = { a: 'approved' };
    // Poll 1 still lists `a` (server hasn't flipped it yet); poll 2 doesn't.
    expect(buildDeck([run('a', 3), run('b', 2)], outcomes, {}).map(r => r.id)).toEqual(['b']);
    expect(buildDeck([run('b', 2)], outcomes, {}).map(r => r.id)).toEqual(['b']);
    expect(tally(outcomes)).toEqual({ approved: 1, rejected: 0 });
  });
  it('a gate decided elsewhere leaves the deck but not the tally', () => {
    const outcomes: Record<string, Outcome> = { a: 'resolved', b: 'rejected' };
    expect(buildDeck([run('a', 3), run('b', 2), run('c', 1)], outcomes, {}).map(r => r.id)).toEqual([
      'c',
    ]);
    expect(tally(outcomes)).toEqual({ approved: 0, rejected: 1 });
  });
  it('sorts fresh before stale, newest first; keeps a revising run pinned', () => {
    const deck = buildDeck([run('old', 9, true), run('x', 1), run('y', 5)], {}, { r: run('r', 3) });
    expect(deck.map(r => r.id)).toEqual(['y', 'r', 'x', 'old']);
  });
});

describe('buildThread — gate scoping', () => {
  it('omits decisions made at a different gate', () => {
    const events = [
      ev({ type: 'gate-decision', phaseName: 'implement-ask', decision: 'approve', message: 'Retry.' }),
      ...phase('decide', DECIDE),
      ev({ type: 'gate-decision', phaseName: 'open-pr', decision: 'request-changes', message: 'Add mode().' }),
    ];
    expect(buildThread(events, 'decide', 'open-pr').map(t => t.kind)).toEqual(['agent', 'user']);
    expect(buildThread(events, 'decide').map(t => t.kind)).toEqual(['user', 'agent', 'user']);
  });
});
