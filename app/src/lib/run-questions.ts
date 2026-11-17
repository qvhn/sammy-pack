import type { QuestionItem } from '../llm/anthropic';

/** A question a run's agent asked and is still waiting on. */
export type OpenQuestion = {
  questionId: string;
  phaseName: string;
  questions: QuestionItem[];
  ts: number;
};

/** The questions still waiting for an answer, oldest first: each `question`
 *  event with no `question-closed` after it. Only a running run has any — a
 *  run that stopped took its waiting agents with it. */
export function openQuestions(events: readonly unknown[], status: string): OpenQuestion[] {
  if (status !== 'running') return [];
  const open = new Map<string, OpenQuestion>();
  for (const raw of events) {
    const e = raw as Partial<OpenQuestion> & { type?: string };
    if (typeof e?.questionId !== 'string') continue;
    if (e.type === 'question' && Array.isArray(e.questions)) {
      open.set(e.questionId, {
        questionId: e.questionId,
        phaseName: String(e.phaseName ?? ''),
        questions: e.questions,
        ts: typeof e.ts === 'number' ? e.ts : 0,
      });
    } else if (e.type === 'question-closed') {
      open.delete(e.questionId);
    }
  }
  return [...open.values()];
}

/** The answer to send for one question: the chosen labels (joined with ", "
 *  for a multi-select, the SDK's own convention) plus the person's own words
 *  when they wrote some. Empty when nothing was given. */
export function answerText(
  q: Pick<QuestionItem, 'multiSelect'>,
  picked: readonly string[],
  other: string,
): string {
  const own = other.trim();
  const labels = q.multiSelect ? [...picked] : picked.slice(0, 1);
  if (!q.multiSelect && own) return own;
  return [...labels, ...(own ? [own] : [])].join(', ');
}
