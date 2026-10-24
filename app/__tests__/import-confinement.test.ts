/**
 * Filesystem imports are confined to allowlisted roots.
 *
 * `POST /api/agents/import` took ANY absolute path, required only that it be a
 * file, and symlinked it into `agents/`. Two routes then turned that into host
 * access: `GET /api/agents/:name` reads the symlink target and returns its
 * contents (and GET is unauthenticated by default), and `PUT` writes THROUGH
 * the symlink — which is deliberate and documented ("editing an imported agent
 * updates the source file in the origin repo"), but with an unconfined source
 * is arbitrary file write.
 *
 * `SECURITY.md` claims "orchestration, agent and workspace paths are
 * sanitised; traversal outside the workspace is a vulnerability". The *names*
 * were sanitised correctly everywhere (`isSafeName`); the symlink TARGET was
 * never checked, so the escape was never in the name at all.
 *
 * The confinement is tested at the unit level (`checkImportSource`) rather
 * than by driving the route, because the property worth pinning is about
 * PATH RESOLUTION ORDER — resolve first, then contain — and that is far
 * clearer asserted directly. The route wiring is covered by typecheck plus
 * the existing import suites.
 *
 * ── A second property: the roots CONTAIN the server's own state ──────────
 * Every case below the resolution-order block tests escape FROM a root. That
 * blind spot is what let `<root>/credentials.json` — always inside the
 * always-allowed workspace root — be imported. The `deny` cases pin the other
 * half; the route halves (an unmasked GET, a write-through PUT) are driven in
 * `import-state-file-fence.test.ts`, because a unit test alone stays green
 * under a sink-only regression.
 *
 * ── The fixture base is realpath'd, on purpose ───────────────────────────
 * `importRoots` realpaths every root, and on macOS `os.tmpdir()` is a symlink
 * (`/var` → `/private/var`). With an un-resolved fixture base, every path fed
 * in fails containment under the inversion this suite exists to catch
 * (contain BEFORE resolve) — so the symlink-escape case would pass for the
 * wrong reason, its only assertion being a reason string that reads "outside
 * the roots" either way. Resolving the base makes the accept case pass under
 * that inversion and the escape case come back `ok: true` with a realPath
 * pointing at the secret — which is what the assertions below refuse.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkImportSource,
  importRoots,
  splitImportRoots,
} from '../src/server/import-roots';

describe('import source confinement', () => {
  let workspace: string;
  let outside: string;
  let roots: string[];

  beforeEach(async () => {
    const base = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'sammy-import-'),
    );
    workspace = path.join(base, 'workspace');
    outside = path.join(base, 'elsewhere');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(workspace, 'ok.md'), '# fine', 'utf8');
    await fs.writeFile(path.join(outside, 'secret.md'), 'TOP SECRET', 'utf8');
    delete process.env.SAMMY_IMPORT_ROOTS;
    roots = await importRoots(workspace);
    // The fixture must be REAL paths, or the containment checks below pass
    // and fail for reasons that have nothing to do with the code under test.
    expect(roots).toEqual([workspace]);
  });

  afterEach(() => {
    delete process.env.SAMMY_IMPORT_ROOTS;
  });

  it('accepts a file inside the workspace', async () => {
    const out = await checkImportSource(path.join(workspace, 'ok.md'), {
      roots,
      extension: '.md',
    });
    expect(out).toEqual({ ok: true, realPath: path.join(workspace, 'ok.md') });
  });

  it('refuses a file outside every allowed root', async () => {
    const out = await checkImportSource(path.join(outside, 'secret.md'), {
      roots,
      extension: '.md',
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toContain('SAMMY_IMPORT_ROOTS');
  });

  it('refuses a SYMLINK inside the workspace that points outside it', async () => {
    // The classic bypass: containment checked before resolution would accept
    // this, because the link itself lives in an allowed directory.
    const link = path.join(workspace, 'innocent.md');
    const target = path.join(outside, 'secret.md');
    await fs.symlink(target, link);
    const out = await checkImportSource(link, { roots, extension: '.md' });
    // Pin the ORDER, not just a verdict: contain-before-resolve returns
    // `{ ok: true, realPath: <the secret> }` here, and an assertion on the
    // reason string alone cannot tell that apart from a correct refusal
    // when the fixture paths happen not to match the realpath'd roots.
    expect(out).toEqual({
      ok: false,
      reason: expect.stringContaining('outside the allowed import roots'),
    });
    expect(JSON.stringify(out)).not.toContain(target);
  });

  it('refuses a traversal path that climbs out', async () => {
    const out = await checkImportSource(
      path.join(workspace, '..', 'elsewhere', 'secret.md'),
      { roots, extension: '.md' },
    );
    expect(out.ok).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as inside', async () => {
    // `/base/workspace-evil` must not count as inside `/base/workspace`.
    const sibling = `${workspace}-evil`;
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'x.md'), 'nope', 'utf8');
    const out = await checkImportSource(path.join(sibling, 'x.md'), {
      roots,
      extension: '.md',
    });
    expect(out.ok).toBe(false);
  });

  it('enforces the extension the route expects', async () => {
    await fs.writeFile(path.join(workspace, 'creds.json'), '{}', 'utf8');
    const asMd = await checkImportSource(path.join(workspace, 'creds.json'), {
      roots,
      extension: '.md',
    });
    expect(asMd.ok).toBe(false);
    if (asMd.ok) throw new Error('unreachable');
    expect(asMd.reason).toContain('.md');
    // …and the orchestration importer's extension is accepted.
    const asJson = await checkImportSource(path.join(workspace, 'creds.json'), {
      roots,
      extension: '.json',
    });
    expect(asJson.ok).toBe(true);
  });

  it('refuses a directory and a relative path', async () => {
    expect(
      (await checkImportSource(workspace, { roots })).ok,
    ).toBe(false);
    expect(
      (await checkImportSource('relative/path.md', { roots, extension: '.md' }))
        .ok,
    ).toBe(false);
  });

  // ── The server's own state files, INSIDE an allowed root ────────────────
  // Everything above tests escape FROM the roots. The workspace root is
  // ALWAYS a root and the default connections file is `<root>/credentials.json`
  // — so containment accepted the credential store itself, and the import
  // linked it into `examples/` where the orchestration GET reads it back
  // unmasked and the PUT writes through the link.
  it('refuses a server state file that sits inside an allowed root', async () => {
    const stateFiles = [
      path.join(workspace, 'credentials.json'),
      path.join(workspace, 'budget.json'),
      path.join(workspace, 'mcp', 'servers.json'),
      path.join(workspace, 'hooks', 'hooks.json'),
    ];
    await fs.mkdir(path.join(workspace, 'mcp'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'hooks'), { recursive: true });
    for (const f of stateFiles) await fs.writeFile(f, '{}', 'utf8');
    for (const f of stateFiles) {
      const out = await checkImportSource(f, {
        roots,
        extension: '.json',
        deny: stateFiles,
      });
      expect(out).toEqual({
        ok: false,
        reason: expect.stringContaining("server's own state files"),
      });
    }
    // Nested paths are compared whole, not by basename: a workspace file that
    // merely SHARES a name with a registry stays importable.
    const lookalike = path.join(workspace, 'servers.json');
    await fs.writeFile(lookalike, '{}', 'utf8');
    expect(
      await checkImportSource(lookalike, {
        roots,
        extension: '.json',
        deny: stateFiles,
      }),
    ).toEqual({ ok: true, realPath: lookalike });
  });

  it('refuses a symlink whose target is a denied state file', async () => {
    const creds = path.join(workspace, 'credentials.json');
    await fs.writeFile(creds, '{"t":{"value":"SECRET"}}', 'utf8');
    const link = path.join(workspace, 'innocent.json');
    await fs.symlink(creds, link);
    const out = await checkImportSource(link, {
      roots,
      extension: '.json',
      deny: [creds],
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.reason).toContain("server's own state files");
  });

  it('leaves an ordinary .json import untouched when a deny list is passed', async () => {
    const orch = path.join(workspace, 'pipeline.json');
    await fs.writeFile(orch, '{"name":"pipeline"}', 'utf8');
    expect(
      await checkImportSource(orch, {
        roots,
        extension: '.json',
        deny: [path.join(workspace, 'credentials.json')],
      }),
    ).toEqual({ ok: true, realPath: orch });
  });

  it('SAMMY_IMPORT_ROOTS opts a second tree in, explicitly', async () => {
    // The documented per-machine flow — importing an agent set from another
    // repo — stays supported; the operator just has to name the tree.
    process.env.SAMMY_IMPORT_ROOTS = outside;
    const widened = await importRoots(workspace);
    const out = await checkImportSource(path.join(outside, 'secret.md'), {
      roots: widened,
      extension: '.md',
    });
    expect(out.ok).toBe(true);
  });
});

describe('SAMMY_IMPORT_ROOTS splitting is cross-platform', () => {
  it('keeps a Windows drive path whole under the Windows delimiter', () => {
    // Splitting on a bare `:` shredded `C:\agents` into `C` and `\agents`,
    // so no Windows root could ever be allowlisted.
    expect(splitImportRoots('C:\\agents;D:\\more', ';')).toEqual([
      'C:\\agents',
      'D:\\more',
    ]);
    expect(splitImportRoots('C:\\agents, D:\\more', ';')).toEqual([
      'C:\\agents',
      'D:\\more',
    ]);
  });

  it('splits on the POSIX delimiter, commas and semicolons, trimming blanks', () => {
    expect(splitImportRoots('/a:/b,/c; /d ,, ', ':')).toEqual([
      '/a',
      '/b',
      '/c',
      '/d',
    ]);
    expect(splitImportRoots('', ':')).toEqual([]);
  });

  it('defaults to this platform\'s delimiter', () => {
    const two = ['/one', '/two'].join(path.delimiter);
    expect(splitImportRoots(two)).toEqual(['/one', '/two']);
  });
});
