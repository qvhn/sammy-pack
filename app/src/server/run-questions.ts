import type { QuestionItem, QuestionOutcome } from '../llm/anthropic';

/**
 * Questions agents in server runs are waiting on. An agent's AskUserQuestion
 * call parks here (sdk-stream's permission hook awaits `waitForAnswer`) until
 * a person answers through `POST /api/runs/:id/questions/:qid`, the step's
 * `questionTimeout` passes, or the step is cancelled. Only the asking agent
 * waits: the rest of the run carries on.
 *
 * In-memory by design: the waiting agent's session lives in this process, so
 * a question outlives neither.
 */

type Pending = {
  questions: QuestionItem[];
  settle: (r: { outcome: QuestionOutcome; answers?: Record<string, string> }) => void;
};

const byRun = new Map<string, Map<string, Pending>>();

/** Wait for the answer to `questions`. Resolves `timed-out` after
 *  `timeoutSeconds` (when set) and `cancelled` when `signal` aborts. */
export function waitForAnswer(
  runId: string,
  id: string,
  questions: QuestionItem[],
  opts: { signal: AbortSignal; timeoutSeconds?: number },
): Promise<{ outcome: QuestionOutcome; answers?: Record<string, string> }> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: { outcome: QuestionOutcome; answers?: Record<string, string> }) => {
      const open = byRun.get(runId);
      if (!open?.has(id)) return;
      open.delete(id);
      if (open.size === 0) byRun.delete(runId);
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => done({ outcome: 'cancelled' });
    const open = byRun.get(runId) ?? new Map<string, Pending>();
    byRun.set(runId, open);
    open.set(id, { questions, settle: done });
    if (opts.signal.aborted) return onAbort();
    opts.signal.addEventListener('abort', onAbort);
    if (opts.timeoutSeconds !== undefined && opts.timeoutSeconds > 0) {
      timer = setTimeout(() => done({ outcome: 'timed-out' }), opts.timeoutSeconds * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  });
}

/** Check `answers` against what was asked: one non-empty answer per question,
 *  keyed by the question's text. Returns the problem, or null. */
export function answersProblem(
  questions: QuestionItem[],
  answers: unknown,
): string | null {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return '`answers` must be an object of question text → answer.';
  }
  const given = answers as Record<string, unknown>;
  for (const q of questions) {
    const a = given[q.question];
    if (typeof a !== 'string' || !a.trim()) return `No answer for "${q.question}".`;
  }
  return null;
}

/** Deliver a person's answers. */
export function answerQuestion(
  runId: string,
  id: string,
  answers: unknown,
): { ok: true } | { ok: false; status: 404 | 400; reason: string } {
  const pending = byRun.get(runId)?.get(id);
  if (!pending) {
    return { ok: false, status: 404, reason: 'No agent in this run is waiting on that question.' };
  }
  const problem = answersProblem(pending.questions, answers);
  if (problem) return { ok: false, status: 400, reason: problem };
  const clean: Record<string, string> = {};
  for (const q of pending.questions) {
    clean[q.question] = String((answers as Record<string, unknown>)[q.question]).trim();
  }
  pending.settle({ outcome: 'answered', answers: clean });
  return { ok: true };
}

/** Ids of the questions a run's agents are waiting on right now. */
export function openQuestionIds(runId: string): string[] {
  return [...(byRun.get(runId)?.keys() ?? [])];
}
