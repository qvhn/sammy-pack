/**
 * The run prompt's shape, shared by the server that builds it and the Run
 * dialog that pre-fills a replay from it: the person's own words, then the
 * context fetched for them under PROMPT_CONTEXT_HEADING.
 */
export const PROMPT_CONTEXT_HEADING = '--- Context attached to this run (fetched before it started) ---';

/** A run's initial input without the context attached to it — what the
 *  person typed, for a replay to start from (the context is fetched again). */
export function promptWords(initialInput: string): string {
  const at = initialInput.indexOf(PROMPT_CONTEXT_HEADING);
  return (at === -1 ? initialInput : initialInput.slice(0, at)).trimEnd();
}
