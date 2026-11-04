/**
 * The Result card's facts, derived from a run's events: its state, what it
 * produced (the best link its steps wrote), the branch it left, and the
 * last answer. Fixtures follow the shapes real runs record — a pipeline run
 * that opened a PR after a gate, and a harness run whose final narration
 * links the PR — with neutral content.
 */

import type { RunEvent } from '../src/llm/executor';
import {
  classify,
  collectLinks,
  countSteps,
  deriveRunResult,
  displayText,
  linksIn,
  type RunLike,
} from '../src/lib/run-result';
import type { Node } from '../src/types';

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
const end = (phaseName: string, output: string, extra: Record<string, unknown> = {}) =>
  ev({ type: 'phase-end', phaseName, output, inputTokens: 1, outputTokens: 1, costUsd: 0.1, durationMs: 5, model: 'm', ...extra });
const start = (phaseName: string, agentPath = `agents/${phaseName}.md`) =>
  ev({ type: 'phase-start', phaseName, agentPath });

const snapshot: Node = {
  name: 'ticket-flow',
  phases: [
    { name: 'implement', agent: 'agents/dev.md' },
    {
      name: 'checks',
      converge: [
        { name: 'review', agent: 'agents/review.md' },
        { name: 'qa', agent: 'agents/qa.md' },
      ],
      merger: 'agents/lead.md',
    },
    { name: 'open-pr', agent: 'agents/gh.md', lock: true },
  ],
} as unknown as Node;

/** A pipeline run: three steps, a converge with a merger, a gate before
 *  open-pr, a resume that replays the finished steps, then the PR. */
const pipelineRun: RunLike = {
  status: 'done',
  startedAt: 1_000,
  endedAt: 61_000,
  orchestrationSnapshot: snapshot,
  events: [
    ev({ type: 'run-start', orchestrationName: 'ticket-flow' }),
    ev({ type: 'worktrees-ready', worktrees: [{ name: 'repo', path: '/w', branch: 'sammy/abc123-repo', base: 'f00', reused: false }] }),
    start('implement'),
    end('implement', 'Added the helper and three tests.'),
    ev({ type: 'composite-start', phaseName: 'checks', kind: 'converge' }),
    start('review'),
    start('qa'),
    end('review', '## Verdict\napprove'),
    end('qa', 'VERDICT: PASS — 5/5 tests'),
    start('checks/merger', 'agents/lead.md'),
    end('checks/merger', 'Scope verdict: approve'),
    ev({ type: 'composite-end', phaseName: 'checks', kind: 'converge' }),
    ev({ type: 'lock-gate', phaseName: 'open-pr' }),
    ev({ type: 'run-paused', pausedFor: 'open-pr' }),
    ev({ type: 'gate-decision', phaseName: 'open-pr', decision: 'approve' }),
    ev({ type: 'run-resumed', pausedFor: 'open-pr' }),
    ev({ type: 'run-start', orchestrationName: 'ticket-flow' }),
    ev({ type: 'worktrees-ready', worktrees: [{ name: 'repo', path: '/w', branch: 'sammy/abc123-repo', base: 'f00', reused: true }] }),
    start('implement'),
    end('implement', 'Added the helper and three tests.', { costUsd: 0, replayed: true }),
    ev({ type: 'lock-gate', phaseName: 'open-pr' }),
    start('open-pr'),
    end('open-pr', 'PR is open: **https://github.com/acme/calc/pull/5**\n\n**"Add a helper"**\n- Branch pushed.'),
    ev({ type: 'run-end' }),
  ],
};

/** A harness run: one agent does the steps; its own leg ("harness") ends
 *  with a narration that links the PR as markdown. */
const harnessRun: RunLike = {
  status: 'done',
  startedAt: 0,
  endedAt: 120_000,
  orchestrationSnapshot: snapshot,
  events: [
    ev({ type: 'run-start', orchestrationName: 'ticket-flow' }),
    ev({ type: 'phase-start', phaseName: 'harness' }),
    ev({ type: 'harness-start', follow: 'strict', steps: [] }),
    ev({ type: 'phase-start', phaseName: 'implement' }),
    end('implement', 'Implemented on branch sammy/xyz-repo.'),
    ev({ type: 'phase-start', phaseName: 'open-pr' }),
    end('open-pr', '{ "ok": true, "number": 1, "url": "https://github.com/acme/web/pull/1" }'),
    end('harness', 'Run complete.\n- **PR opened:** [acme/web#1](https://github.com/acme/web/pull/1)'),
    ev({ type: 'run-end' }),
  ],
};

describe('deriveRunResult', () => {
  it('reads a finished pipeline run: the PR, the branch, the steps and the last answer', () => {
    const r = deriveRunResult(pipelineRun);
    expect(r.state).toBe('done');
    expect(r.hero).toMatchObject({ kind: 'pull-request', url: 'https://github.com/acme/calc/pull/5', ref: 'acme/calc #5', phaseName: 'open-pr' });
    // Bold text after the link is not a title — only a markdown link's text is.
    expect(r.hero?.title).toBeUndefined();
    expect(r.branches).toEqual(['sammy/abc123-repo']);
    expect(r.stepsDone).toBe(5);
    expect(r.stepsTotal).toBe(5);
    expect(r.approvals).toBe(1);
    expect(r.output?.phaseName).toBe('open-pr');
    expect(r.durationMs).toBe(60_000);
    // The replayed step costs nothing; the five that ran cost 0.1 each.
    expect(r.costUsd).toBeCloseTo(0.5);
    expect(r.forkPoints).toEqual(['implement', 'review', 'qa', 'checks/merger', 'open-pr']);
  });

  it('reads a harness run: the narration is the answer, and its leg is not a step', () => {
    const r = deriveRunResult(harnessRun);
    expect(r.hero).toMatchObject({ kind: 'pull-request', ref: 'acme/web #1' });
    // `acme/web#1` restates the link — not a title.
    expect(r.hero?.title).toBeUndefined();
    expect(r.links).toEqual([]);
    expect(r.output?.phaseName).toBe('harness');
    expect(r.stepsDone).toBe(2);
  });

  it('a run waiting at a gate names the gated step', () => {
    const events = pipelineRun.events.slice(0, 14);
    const r = deriveRunResult({ ...pipelineRun, status: 'paused', endedAt: undefined, events }, 31_000);
    expect(r.state).toBe('waiting');
    expect(r.gatedPhase).toBe('open-pr');
    expect(r.output?.phaseName).toBe('checks/merger');
    expect(r.durationMs).toBe(30_000);
  });

  it('a paused run that is not at a gate has no gated step', () => {
    const r = deriveRunResult({
      status: 'paused',
      startedAt: 0,
      events: [ev({ type: 'lock-gate', phaseName: 'x' }), ev({ type: 'run-resumed', pausedFor: 'x' }), ev({ type: 'wait-started' })],
    });
    expect(r.gatedPhase).toBeNull();
  });

  it('a failed run names the step, the error and its partial output', () => {
    const r = deriveRunResult({
      status: 'error',
      startedAt: 0,
      endedAt: 10_000,
      events: [
        start('implement'),
        end('implement', 'done'),
        start('qa'),
        ev({ type: 'phase-delta', phaseName: 'qa', text: 'Running the suite… ' }),
        ev({ type: 'phase-delta', phaseName: 'qa', text: 'still running' }),
        ev({ type: 'phase-error', phaseName: 'qa', error: 'Timed out after 900s' }),
        ev({ type: 'run-error', error: 'qa: Timed out after 900s' }),
      ],
    });
    expect(r.state).toBe('failed');
    expect(r.failedPhase).toBe('qa');
    expect(r.error).toBe('qa: Timed out after 900s');
    expect(r.output).toEqual({ phaseName: 'qa', text: 'Running the suite… still running' });
    expect(r.forkPoints).toEqual(['implement']);
  });

  it('a run that failed before any step has no failed step', () => {
    const r = deriveRunResult({
      status: 'error',
      startedAt: 0,
      endedAt: 200,
      events: [ev({ type: 'run-error', error: 'worktree "repo": base "HEAD" is not a commit' })],
    });
    expect(r).toMatchObject({ state: 'failed', failedPhase: null, output: null, hero: null });
    expect(r.error).toMatch(/not a commit/);
  });

  it('an interrupted run reads as failed, with the reason', () => {
    const r = deriveRunResult({
      status: 'interrupted',
      startedAt: 0,
      events: [start('a'), ev({ type: 'run-interrupted', reason: 'server restarted' })],
    });
    expect(r).toMatchObject({ state: 'failed', interrupted: true, failedPhase: 'a', error: 'server restarted' });
  });

  it('a done run with degradation reasons is degraded — from the record, or derived', () => {
    const fromRecord = deriveRunResult({
      ...pipelineRun,
      degradationReasons: [{ phase: 'qa', reason: 'continued past an error' }],
    });
    expect(fromRecord.state).toBe('degraded');
    expect(fromRecord.degradationReasons).toHaveLength(1);
    expect(deriveRunResult({ ...pipelineRun, degradationReasons: [] }).state).toBe('done');
  });

  it('a running run names the step running now', () => {
    const r = deriveRunResult({ status: 'running', startedAt: 0, events: [start('a'), end('a', 'x'), start('b')] }, 5_000);
    expect(r).toMatchObject({ state: 'running', currentPhase: 'b', stepsDone: 1, durationMs: 5_000 });
  });

  it('counts artifacts, not dropped ones', () => {
    const r = deriveRunResult({
      status: 'done',
      startedAt: 0,
      endedAt: 1,
      events: [
        ev({ type: 'artifact', phaseName: 'a', name: 'log' }),
        ev({ type: 'artifact', phaseName: 'a', name: 'log' }),
        ev({ type: 'artifact', phaseName: 'a', name: 'big', dropped: true }),
      ],
    });
    expect(r.artifacts).toBe(1);
  });
});

describe('links', () => {
  it('ranks a PR over an issue over any other link, latest step first', () => {
    const links = collectLinks([
      end('triage', 'Ticket: https://example.atlassian.net/browse/ABC-12 and docs https://example.com/guide.'),
      end('open-pr', 'Opened https://gitlab.com/group/sub/app/-/merge_requests/7 and https://github.com/acme/app/pull/9'),
    ]);
    expect(links.map(l => [l.kind, l.ref])).toEqual([
      ['pull-request', 'acme/app #9'],
      ['merge-request', 'group/sub/app !7'],
      ['issue', 'ABC-12'],
      ['link', 'example.com/guide'],
    ]);
  });

  it('dedupes a link across steps and keeps a title from markdown text', () => {
    const links = collectLinks([
      end('a', 'see [Fix the totals](https://github.com/acme/app/pull/3)'),
      end('b', 'PR: https://github.com/acme/app/pull/3.'),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ title: 'Fix the totals', phaseName: 'b' });
  });

  it('a markdown label that only restates the link is not a title', () => {
    for (const label of ['#4', 'PR #4', 'acme/app#4', 'https://github.com/acme/app/pull/4']) {
      expect(linksIn(`[${label}](https://github.com/acme/app/pull/4)`, 'p')[0].title).toBeUndefined();
    }
  });

  it('classifies GitHub issues and trims long plain links', () => {
    expect(classify('https://github.com/acme/app/issues/2', 'p')).toMatchObject({ kind: 'issue', ref: 'acme/app #2' });
    expect(classify('not a url', 'p')).toBeNull();
    // A step's own local server is gone after the run — not a result.
    expect(classify('http://localhost:3000/page.html', 'p')).toBeNull();
    expect(classify('http://127.0.0.1:8080/', 'p')).toBeNull();
    expect(classify(`https://example.com/${'x'.repeat(80)}`, 'p')!.ref.length).toBeLessThanOrEqual(48);
  });
});

describe('displayText', () => {
  it('drops emphasis, inline-code and heading markers; a link keeps its text', () => {
    expect(
      displayText('## Verdict\nThe verdict is **ship it**, see `src/a.js` and _notes_.\n- **PR:** [acme/web#1](https://github.com/acme/web/pull/1)'),
    ).toBe('Verdict\nThe verdict is ship it, see src/a.js and notes.\n- PR: acme/web#1');
  });

  it('leaves words with underscores and arithmetic alone, and keeps code lines', () => {
    expect(displayText('snake_case_name, 2*3*4 and *emphasis*')).toBe('snake_case_name, 2*3*4 and emphasis');
    expect(displayText('```js\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('parts two messages a session leg ran together at bold text', () => {
    expect(displayText('Pushed the PR.**Run complete.** Done.')).toBe('Pushed the PR.\n\nRun complete. Done.');
  });
});

describe('a failed run keeps what its steps produced', () => {
  it('finds the PR a step opened before a later step failed', () => {
    const r = deriveRunResult({
      status: 'error',
      startedAt: 0,
      endedAt: 1,
      events: [
        start('open-pr'),
        end('open-pr', 'Opened https://github.com/acme/app/pull/8'),
        start('notify'),
        ev({ type: 'phase-error', phaseName: 'notify', error: 'webhook refused' }),
      ],
    });
    expect(r).toMatchObject({ state: 'failed', failedPhase: 'notify' });
    expect(r.hero?.ref).toBe('acme/app #8');
  });
});

describe('countSteps', () => {
  it('counts leaves and a converge merger; refuses shapes that repeat or branch', () => {
    expect(countSteps(snapshot)).toBe(5);
    expect(countSteps({ name: 'r', phases: [{ name: 'l', loop: { body: { name: 'b', agent: 'a' } } }] } as unknown as Node)).toBeNull();
    expect(countSteps({ name: 'r', parallel: [{ name: 'a', agent: 'a' }, { name: 'b', code: { run: 'x' } }] } as unknown as Node)).toBe(2);
  });
});
