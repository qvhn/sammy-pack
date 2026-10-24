/**
 * Map a repository URL to a clone on this machine — and make one on request.
 *
 * A root `worktrees` entry needs a LOCAL repository, but people naturally
 * paste the repository's web address. `findLocalClone` answers "do I already
 * have this?" by matching `remote.origin.url` of the git repositories directly
 * under a few search roots; `cloneRepo` makes the clone the Run dialog offers
 * when there is none.
 *
 * Search roots: `SAMMY_REPO_ROOTS` (path-delimited), else the conventional
 * `~/git`, `~/src`, `~/code`, `~/projects`, `~/Developer`, plus the directory
 * that holds this workspace — whichever exist. A clone lands in the first.
 *
 * Every git call is `execFile` with an argument list — no shell.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetProcess, registerRunProcess, SERVER_OWNER } from './run-process-registry';

/** True when `s` is a remote address rather than a local path. */
export function isRepoUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

/** `host/owner/repo`, lowercased — the same for the https, ssh and scp forms
 *  of one repository, with or without `.git` or a trailing slash. Null for
 *  anything that does not name a repository on a host. */
export function normalizeRepoUrl(url: string): string | null {
  const s = url.trim();
  let host: string;
  let rest: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s);
  if (scp && !s.includes('://')) {
    host = scp[1];
    rest = scp[2];
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    // No plaintext http: a clone over it can be tampered with in transit.
    if (!['https:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    host = u.hostname;
    rest = u.pathname;
  }
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (!host || parts.length < 2) return null;
  // Every segment is a plain name: no `.`/`..`, no backslash (a Windows path
  // separator), nothing that could walk the clone destination out of its root.
  if (parts.some(p => p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) return null;
  return `${host}/${parts.join('/')}`.toLowerCase();
}

/** The directories searched for clones, existing ones only, in order. */
export async function repoSearchRoots(workspaceRoot: string): Promise<string[]> {
  const env = process.env.SAMMY_REPO_ROOTS?.trim();
  const home = os.homedir();
  const candidates = env
    ? env.split(path.delimiter).filter(Boolean).map(p => path.resolve(p.replace(/^~(?=$|\/)/, home)))
    : [
        ...['git', 'src', 'code', 'projects', 'Developer'].map(d => path.join(home, d)),
        path.dirname(path.resolve(workspaceRoot)),
      ];
  const out: string[] = [];
  for (const c of candidates) {
    if (out.includes(c)) continue;
    const st = await fs.stat(c).catch(() => null);
    if (st?.isDirectory()) out.push(c);
  }
  return out;
}

function originUrlFromGit(dir: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', dir, 'config', '--get', 'remote.origin.url'],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });
}

/** `remote.origin.url` of the repository at `dir`. Read straight from
 *  `.git/config` when `.git` is a directory — a scan of a few dozen repos
 *  then costs file reads, not a git process each; a `.git` FILE (a linked
 *  worktree or submodule) asks git, which knows where its config lives. */
async function originUrl(dir: string): Promise<string | null> {
  const dotGit = path.join(dir, '.git');
  const st = await fs.stat(dotGit).catch(() => null);
  if (!st) return null;
  if (!st.isDirectory()) return originUrlFromGit(dir);
  const config = await fs.readFile(path.join(dotGit, 'config'), 'utf8').catch(() => '');
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const m = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (m) return m[1].trim();
  }
  return null;
}

/** The first git repository directly under a search root whose origin is
 *  `url`, or null. */
export async function findLocalClone(url: string, roots: string[]): Promise<string | null> {
  const want = normalizeRepoUrl(url);
  if (!want) return null;
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(root, e.name));
    const hits = await Promise.all(
      dirs.map(async dir => {
        const origin = await originUrl(dir);
        return origin && normalizeRepoUrl(origin) === want ? dir : null;
      }),
    );
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** Where `cloneRepo` would put `url`: `<first root>/<repo name>`. */
export function cloneDestination(url: string, roots: string[]): string | null {
  const norm = normalizeRepoUrl(url);
  if (!norm || roots.length === 0) return null;
  const name = norm.split('/').pop()!;
  const dest = path.join(roots[0], name);
  const rel = path.relative(roots[0], dest);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? dest : null;
}

/** Clone `url` to `dest` (which must not exist yet). Uses the machine's own
 *  git credentials — the same ones a `git clone` in a terminal would. */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  if (await fs.stat(dest).catch(() => null)) {
    throw new Error(`${dest} already exists and is not a clone of ${url}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      ['clone', '--', url, dest],
      { timeout: 10 * 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, _stdout, stderr) => {
        if (child.pid !== undefined) forgetProcess(child.pid);
        if (err) reject(new Error(`git clone failed: ${String(stderr).trim() || err.message}`));
        else resolve();
      },
    );
    // A run ending meanwhile must not reap the clone (reap.ts).
    if (child.pid !== undefined) registerRunProcess(SERVER_OWNER, child.pid);
  });
  // Commits a run makes in this clone are authored by the identity the
  // operator chose for sammy-pack's clones, not whatever the machine's global
  // git config holds (often a work identity on a personal machine).
  const name = process.env.SAMMY_GIT_USER_NAME?.trim();
  const email = process.env.SAMMY_GIT_USER_EMAIL?.trim();
  for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
    if (!value) continue;
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['-C', dest, 'config', key, value], { timeout: 5_000, windowsHide: true }, err =>
        err ? reject(new Error(`git config ${key} failed: ${err.message}`)) : resolve(),
      );
    });
  }
}
