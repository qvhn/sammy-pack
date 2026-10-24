/**
 * Display form of a map node's `over` expression. Authors write it either
 * bare (`state.items`) or already interpolated (`${state.items}`); wrapping
 * the latter again rendered `${${state.items}}` on the canvas. Only wrap a
 * value that has no `${…}` of its own.
 */
export function formatMapOver(over: string): string {
  const v = (over ?? '').trim();
  return v.includes('${') ? v : `\${${v}}`;
}
