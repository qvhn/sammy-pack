/**
 * Questions agents wait on (server/run-questions) and the page's view of them
 * (lib/run-questions): who is waiting, what counts as an answer, and how a
 * wait ends.
 */

import {
  answerQuestion,
  openQuestionIds,
  waitForAnswer,
} from '../src/server/run-questions';
import { answerText, openQuestions } from '../src/lib/run-questions';
import type { QuestionItem } from '../src/llm/anthropic';

const q = (question: string, multiSelect = false): QuestionItem => ({
  question,
  header: 'H',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
  multiSelect,
});

describe('waiting for an answer', () => {
  test('an answer reaches the waiting agent, trimmed and keyed by question', async () => {
    const wait = waitForAnswer('run-1', 'q1', [q('One?'), q('Two?')], {
      signal: new AbortController().signal,
    });
    expect(openQuestionIds('run-1')).toEqual(['q1']);
    expect(answerQuestion('run-1', 'q1', { 'One?': ' A ', 'Two?': 'B' })).toEqual({ ok: true });
    await expect(wait).resolves.toEqual({ outcome: 'answered', answers: { 'One?': 'A', 'Two?': 'B' } });
    expect(openQuestionIds('run-1')).toEqual([]);
  });

  test('a question left blank is refused, and the agent keeps waiting', async () => {
    const wait = waitForAnswer('run-2', 'q1', [q('One?'), q('Two?')], {
      signal: new AbortController().signal,
    });
    expect(answerQuestion('run-2', 'q1', { 'One?': 'A', 'Two?': '  ' })).toMatchObject({ ok: false, status: 400 });
    expect(answerQuestion('run-2', 'q1', 'A')).toMatchObject({ ok: false, status: 400 });
    expect(openQuestionIds('run-2')).toEqual(['q1']);
    answerQuestion('run-2', 'q1', { 'One?': 'A', 'Two?': 'B' });
    await wait;
  });

  test('no one waiting on it — another run, or already answered — is a 404', async () => {
    const wait = waitForAnswer('run-3', 'q1', [q('One?')], { signal: new AbortController().signal });
    expect(answerQuestion('run-other', 'q1', { 'One?': 'A' })).toMatchObject({ ok: false, status: 404 });
    answerQuestion('run-3', 'q1', { 'One?': 'A' });
    await wait;
    expect(answerQuestion('run-3', 'q1', { 'One?': 'B' })).toMatchObject({ ok: false, status: 404 });
  });

  test('the step stopping ends the wait as cancelled', async () => {
    const ac = new AbortController();
    const wait = waitForAnswer('run-4', 'q1', [q('One?')], { signal: ac.signal });
    ac.abort();
    await expect(wait).resolves.toEqual({ outcome: 'cancelled' });
    expect(openQuestionIds('run-4')).toEqual([]);
  });

  test('questionTimeout ends the wait as timed-out', async () => {
    jest.useFakeTimers();
    try {
      const wait = waitForAnswer('run-5', 'q1', [q('One?')], {
        signal: new AbortController().signal,
        timeoutSeconds: 30,
      });
      jest.advanceTimersByTime(29_000);
      expect(openQuestionIds('run-5')).toEqual(['q1']);
      jest.advanceTimersByTime(1_000);
      await expect(wait).resolves.toEqual({ outcome: 'timed-out' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the page’s view', () => {
  const asked = (id: string) => ({ type: 'question', phaseName: 'plan', questionId: id, questions: [q('One?')], ts: 5 });
  const closed = (id: string) => ({ type: 'question-closed', phaseName: 'plan', questionId: id, outcome: 'answered' });

  test('open = asked and not yet closed, oldest first', () => {
    const events = [asked('a'), asked('b'), closed('a'), { type: 'phase-delta' }, asked('c')];
    expect(openQuestions(events, 'running').map(o => o.questionId)).toEqual(['b', 'c']);
  });

  test('a run that is not running has no one waiting', () => {
    expect(openQuestions([asked('a')], 'error')).toEqual([]);
    expect(openQuestions([asked('a')], 'paused')).toEqual([]);
  });

  test('the answer text: one pick, your own words instead, or several picks joined', () => {
    expect(answerText(q('?'), ['A'], '')).toBe('A');
    expect(answerText(q('?'), ['A'], ' something else ')).toBe('something else');
    expect(answerText(q('?'), [], '')).toBe('');
    expect(answerText(q('?', true), ['A', 'B'], '')).toBe('A, B');
    expect(answerText(q('?', true), ['B'], 'and C')).toBe('B, and C');
  });
});

describe('answers keyed by the logged copy of a question', () => {
  test('a question whose text was scrubbed in the log is answered by position', async () => {
    // The page answers from the event log, where a secret in the question's
    // text reads [REDACTED]; the agent waits under the original text.
    const wait = waitForAnswer('run-s', 'q1', [q('Use token abc123?'), q('Two?')], {
      signal: new AbortController().signal,
    });
    expect(answerQuestion('run-s', 'q1', { 'Use token [REDACTED]?': 'A', 'Two?': 'B' })).toEqual({ ok: true });
    await expect(wait).resolves.toEqual({
      outcome: 'answered',
      answers: { 'Use token abc123?': 'A', 'Two?': 'B' },
    });
  });

  test('a stray key does not stand in for a missing answer', () => {
    void waitForAnswer('run-t', 'q1', [q('One?'), q('Two?')], { signal: new AbortController().signal });
    expect(answerQuestion('run-t', 'q1', { 'One?': 'A', 'Other?': 'B', 'Third?': 'C' })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
