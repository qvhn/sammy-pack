/**
 * Folder listing for the Run dialog's "Browse…" picker: the folders inside
 * one directory, so a person can click their way to a repository instead of
 * typing its path.
 *
 * Folders only — never files — and only inside the home directory or one of
 * the repo search roots (`repoSearchRoots`); everything else is refused, so
 * the listing can't be walked across the whole disk. Dot-folders are hidden.
 * Symlinks count as folders when they point at one. The route that serves
 * this answers loopback requests only (sammy-pack-api.ts).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** At most this many folders are listed; `truncated` says when there were more. */
export const MAX_ENTRIES = 2000;

export type DirEntry = { name: string; path: string; git: boolean };

export type DirListing = {
  path: string;
  /** The folder above, or null at the top of what may be browsed. */
  parent: string | null;
  home: string;
  /** Shortcuts: Home, then each repo search root. */
  roots: Array<{ label: string; path: string }>;
  entries: DirEntry[];
  truncated: boolean;
};

export class BrowseError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function isGitRepo(dir: string): Promise<boolean> {
  // A clone has a .git folder; a worktree or submodule has a .git file.
  return !!(await fs.stat(path.join(dir, '.git')).catch(() => null));
}

/** List the folders in `target` (default: the first repo root, else home).
 *  `~` expands to `home`. Throws BrowseError: 403 outside home and the
 *  roots, 404 when missing, 400 when not a folder. */
export async function listDirs(opts: {
  target?: string;
  home: string;
  roots: string[];
}): Promise<DirListing> {
  const home = path.resolve(opts.home);
  const roots = opts.roots.map(r => path.resolve(r));
  const allowed = [home, ...roots];

  const raw = opts.target?.trim() || roots[0] || home;
  const expanded = raw.replace(/^~(?=$|[/\\])/, home);
  if (!path.isAbsolute(expanded)) {
    throw new BrowseError(400, `${raw} is not an absolute path`);
  }
  const dir = path.resolve(expanded);
  if (!allowed.some(a => within(dir, a))) {
    throw new BrowseError(403, `${dir} is outside the folders that can be browsed (your home folder and the repo roots)`);
  }
  const st = await fs.stat(dir).catch(() => null);
  if (!st) throw new BrowseError(404, `${dir} does not exist`);
  if (!st.isDirectory()) throw new BrowseError(400, `${dir} is not a folder`);

  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(err => {
    throw new BrowseError(403, `${dir} can't be read: ${(err as Error).message}`);
  });
  const names: string[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    if (d.isDirectory()) names.push(d.name);
    else if (d.isSymbolicLink()) {
      const target = await fs.stat(path.join(dir, d.name)).catch(() => null);
      if (target?.isDirectory()) names.push(d.name);
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const shown = names.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(
    shown.map(async name => {
      const p = path.join(dir, name);
      return { name, path: p, git: await isGitRepo(p) };
    }),
  );

  const up = path.dirname(dir);
  const parent = up !== dir && allowed.some(a => within(up, a)) ? up : null;

  const shortcuts = [{ label: 'Home', path: home }];
  for (const r of roots) {
    if (shortcuts.some(s => s.path === r)) continue;
    shortcuts.push({ label: within(r, home) ? `~/${path.relative(home, r)}` : r, path: r });
  }

  return { path: dir, parent, home, roots: shortcuts, entries, truncated: names.length > shown.length };
}
