/**
 * Lightweight hash routing for the web shell.
 *
 * The current page lives in `location.hash` (`#/runs`, `#/approvals`,
 * `#/pipelines/<name>`), so a reload or dev-server restart lands back where
 * the user was, Back/Forward move between pages, and a link can point at a
 * page by setting the hash. On native there is no `location` — every helper
 * degrades to a no-op and the shell falls back to plain in-memory state.
 *
 * `location` / `history` / `window` are reached through globalThis because
 * the RN tsconfig doesn't pull in DOM types.
 */
import type { PageId } from '../Sidebar';

export const PAGE_IDS: readonly PageId[] = [
  'pipelines',
  'agents',
  'playground',
  'datasets',
  'evals',
  'schemas',
  'runs',
  'approvals',
  'queue',
  'notifications',
  'deliveries',
  'observability',
  'cost',
  'ab-compare',
  'connections',
  'workspaces',
  'triggers',
  'settings',
];

export const DEFAULT_PAGE: PageId = 'pipelines';

export type Route = { page: PageId; pipeline?: string };

/** Parse a hash (`#/pipelines/foo`, `#/runs`, `''`) into a route. Unknown or
 *  empty hashes resolve to the default page. */
export function parseHash(hash: string | null | undefined): Route {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  const page = (PAGE_IDS as readonly string[]).includes(head)
    ? (head as PageId)
    : DEFAULT_PAGE;
  if (page === 'pipelines' && rest.length > 0) {
    const encoded = rest.join('/');
    let name: string;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = encoded;
    }
    if (name) return { page, pipeline: name };
  }
  return { page };
}

/** The hash for a route — the inverse of parseHash. */
export function formatHash(route: Route): string {
  if (route.page === 'pipelines' && route.pipeline) {
    return `#/pipelines/${encodeURIComponent(route.pipeline)}`;
  }
  return `#/${route.page}`;
}

type Loc = { hash: string; pathname?: string; search?: string };
type Win = {
  location?: Loc;
  history?: { replaceState?: (data: unknown, title: string, url: string) => void };
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
};
const win = (): Win => globalThis as unknown as Win;

/** The route in the address bar right now (default page on native). */
export function currentRoute(): Route {
  try {
    return parseHash(win().location?.hash);
  } catch {
    return { page: DEFAULT_PAGE };
  }
}

// The last pipeline the Pipelines page had selected. Navigating back to
// Pipelines from another page (`#/pipelines` with no name) restores it,
// rather than resetting to the first pipeline in the list.
let lastPipeline: string | null = null;
export function rememberPipeline(name: string | null): void {
  lastPipeline = name;
}
export function rememberedPipeline(): string | null {
  return lastPipeline;
}

/** Navigate to a page, adding a history entry (assigning `location.hash`
 *  pushes one and fires `hashchange`). Returns false when there's no
 *  location to route through (native) so the caller updates its own state. */
export function navigateTo(route: Route): boolean {
  const loc = win().location;
  if (!loc) return false;
  const next = formatHash(route);
  if (loc.hash !== next) loc.hash = next;
  return true;
}

/** Rewrite the hash WITHOUT a history entry or a `hashchange` — used for
 *  in-page state (the selected pipeline) that should survive a reload but
 *  not turn every click into a Back step. */
export function replaceRoute(route: Route): void {
  const w = win();
  const loc = w.location;
  if (!loc) return;
  const next = formatHash(route);
  if (loc.hash === next) return;
  try {
    if (w.history?.replaceState) {
      w.history.replaceState(
        null,
        '',
        `${loc.pathname ?? ''}${loc.search ?? ''}${next}`,
      );
      return;
    }
  } catch {
    /* fall through */
  }
  loc.hash = next;
}

/** Subscribe to address-bar route changes (Back/Forward, a link setting the
 *  hash, a hand-edited URL). Returns the unsubscribe. */
export function onRouteChange(fn: (route: Route) => void): () => void {
  const w = win();
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const handler = () => fn(currentRoute());
  w.addEventListener('hashchange', handler);
  return () => w.removeEventListener?.('hashchange', handler);
}
