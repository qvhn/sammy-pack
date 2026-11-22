/**
 * Repositories the Run dialog remembers, so a pipeline that always lands in
 * the same repo doesn't ask for it on every run: the last one each pipeline
 * input used, and a short list of recent ones to switch between. Per browser
 * (localStorage), like the other dialog conveniences; nothing depends on it.
 */
const KEY = 'sammy.runRepos';
const MAX_RECENT = 8;

type Saved = { last: Record<string, string>; recent: string[] };

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    return {
      last: raw && typeof raw.last === 'object' && raw.last ? raw.last : {},
      recent: Array.isArray(raw?.recent) ? raw.recent.filter(r => typeof r === 'string') : [],
    };
  } catch {
    return { last: {}, recent: [] };
  }
}

const slot = (orchestration: string, input: string) => `${orchestration}::${input}`;

/** The repo this pipeline's input used last time, if any. */
export function lastRepo(orchestration: string, input: string): string | undefined {
  return load().last[slot(orchestration, input)];
}

/** Recent repos across every pipeline, most recent first. */
export function recentRepos(): string[] {
  return load().recent;
}

/** Record a repo a run started with. */
export function rememberRepo(orchestration: string, input: string, repo: string): void {
  const value = repo.trim();
  if (!value) return;
  const saved = load();
  saved.last[slot(orchestration, input)] = value;
  saved.recent = [value, ...saved.recent.filter(r => r !== value)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* localStorage unavailable */
  }
}
