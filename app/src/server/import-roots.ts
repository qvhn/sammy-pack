/**
 * import-roots — where a filesystem import is allowed to read from.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * `POST /api/agents/import` (and the orchestration twin) took ANY absolute
 * path, required only that it be a file, and symlinked it into `agents/`.
 * There was no confinement to the workspace and no extension check, despite a
 * comment claiming one. Two routes then turned that into host access:
 *
 *   - `GET /api/agents/:name` reads the symlink target and returns its
 *     contents — and GET is unauthenticated by default, so one import
 *     converted into an unauthenticated read of any file the server process
 *     can read (the credentials file itself, `~/.aws/credentials`, SSH keys,
 *     a `.env`).
 *   - `PUT /api/agents/:name` writes through it. That symlink-following is
 *     DELIBERATE and documented ("editing an imported agent updates the
 *     source file in the origin repo") — it is a real feature — but combined
 *     with an unconfined source it is arbitrary file write anywhere the
 *     server user can write.
 *
 * `SECURITY.md` claims "orchestration, agent and workspace paths are
 * sanitised; traversal outside the workspace is a vulnerability". The *names*
 * are sanitised correctly (`isSafeName` everywhere). The symlink TARGET was
 * not checked at all, so the escape was never in the name.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * Confine sources to an allowlist of roots. Default: the workspace root only.
 * Importing an agent set from another repo — the documented per-machine
 * onboarding flow — stays supported, but the operator names those roots
 * explicitly in `SAMMY_IMPORT_ROOTS`, which turns "read any file on the host"
 * into "read files under paths I listed".
 *
 * Confining the SOURCE is what makes the write-through feature safe: a write
 * can only ever reach somewhere the operator already allowlisted.
 *
 * ── What containment alone does NOT cover ────────────────────────────────
 * The always-allowed root CONTAINS the server's own state files — the default
 * connections file is `<root>/credentials.json`, and the MCP / hooks
 * registries sit one directory down. Those pass every check above, so
 * importing one linked the credential store into `examples/`, where the
 * unmasked orchestration GET returns it verbatim and the PUT writes THROUGH
 * the link. The `deny` option is the second half of the confinement: a source
 * may be inside a root AND still be off-limits because it is the server's own
 * state, not content.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type ImportCheck =
  | { ok: true; realPath: string }
  | { ok: false; reason: string };

/**
 * Split a `SAMMY_IMPORT_ROOTS` value into its entries. Separators are `,`,
 * `;` and the platform path delimiter (`:` on POSIX, `;` on Windows) — never
 * a bare `:` on its own, which shredded a Windows drive path (`C:\agents` →
 * `C`, `\agents`) against the repo's cross-platform goal. Unlike `envList`
 * (the grammar every other list knob shares) whitespace is NOT a separator:
 * a path may contain spaces. `delimiter` is a parameter only so the Windows
 * case can be pinned by a test running on POSIX; callers take the default.
 */
export function splitImportRoots(
  raw: string,
  delimiter: string = path.delimiter,
): string[] {
  return raw
    .split(/[,;]/)
    .flatMap(s => s.split(delimiter))
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * The allowlisted roots, as real (symlink-resolved) absolute paths.
 *
 * `workspaceRoot` is always included — importing from inside the workspace is
 * the ordinary case. `SAMMY_IMPORT_ROOTS` adds more, separated by the
 * platform path delimiter, commas or semicolons.
 */
export async function importRoots(workspaceRoot: string): Promise<string[]> {
  const extra = splitImportRoots(process.env.SAMMY_IMPORT_ROOTS ?? '').filter(
    s => path.isAbsolute(s),
  );
  const roots: string[] = [];
  for (const candidate of [workspaceRoot, ...extra]) {
    // realpath so a root given through a symlink still matches a source
    // resolved through the same symlink.
    const real = await fs.realpath(candidate).catch(() => null);
    if (real) roots.push(real);
  }
  return roots;
}

/** True when `child` is `parent` or sits beneath it. Compares resolved paths
 *  segment-wise, so `/data/agents-evil` is NOT inside `/data/agents`. Both
 *  sides must already be realpath'd. Exported for the directory-scan route,
 *  which confines to the same roots and must agree on what "inside" means. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether `file` IS one of `deny` — the server's own state files.
 *
 * Both sides are realpath'd, so a symlink pointing at a state file counts: the
 * whole point is that the path a caller names and the file it reaches can
 * differ. A `deny` entry that cannot be resolved is compared raw (it may not
 * exist yet — the budget file is written on first save).
 *
 * Exported because the SOURCE check below and the SINK fences in the API
 * (`serverStateFiles` — the orchestration and agent loaders) have to agree on
 * what "is a state file" means; two copies of this predicate would be two
 * chances to drift, and the sink half is what catches a link an earlier build
 * or a hand edit already left on disk.
 */
export async function resolvesToDeniedFile(
  file: string,
  deny: string[],
): Promise<boolean> {
  if (deny.length === 0) return false;
  const real = await fs.realpath(file).catch(() => null);
  if (!real) return false;
  for (const candidate of deny) {
    const denied = await fs.realpath(candidate).catch(() => candidate);
    if (denied === real) return true;
  }
  return false;
}

/**
 * Validate one import source.
 *
 * Checks, in order: absolute, resolvable, a regular FILE, the expected
 * extension, inside an allowlisted root, and not on the `deny` list. The path
 * is resolved with `realpath` FIRST and the containment test runs on the
 * resolved path, so a symlink inside an allowed root that points outside it is
 * still rejected — checking before resolution would be the classic bypass.
 *
 * `deny` names the server's OWN state files (see the header). It is checked
 * after containment because it is a narrower rule than the roots, and both
 * sides are realpath'd so a link to a state file is refused as well.
 */
export async function checkImportSource(
  from: string,
  opts: { roots: string[]; extension?: string; deny?: string[] },
): Promise<ImportCheck> {
  if (!from || !path.isAbsolute(from)) {
    return { ok: false, reason: 'from must be an absolute path' };
  }
  if (opts.extension && path.extname(from).toLowerCase() !== opts.extension) {
    return {
      ok: false,
      reason: `from must be a ${opts.extension} file`,
    };
  }
  const real = await fs.realpath(from).catch(() => null);
  if (!real) return { ok: false, reason: 'source file not found' };
  const st = await fs.stat(real).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, reason: 'source file not found' };
  }
  if (!opts.roots.some(root => isInside(root, real))) {
    return {
      ok: false,
      reason:
        'source is outside the allowed import roots. Add its directory to ' +
        'SAMMY_IMPORT_ROOTS to permit importing from there.',
    };
  }
  if (await resolvesToDeniedFile(real, opts.deny ?? [])) {
    return {
      ok: false,
      reason:
        'source is one of the server\'s own state files (the connections ' +
        'file, the budget file, the MCP / hooks registries, the run ' +
        'database) and cannot be imported.',
    };
  }
  return { ok: true, realPath: real };
}
