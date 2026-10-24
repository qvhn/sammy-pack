/**
 * run-context provenance tagging: the loader must tag each orchestration's
 * __origin so subflow name-resolution precedence (imported/domain > shipped
 * example) is deterministic. A SYMLINK in examples/ (how a domain set is
 * imported) ⇒ 'imported'; a real in-repo file ⇒ 'shipped'.
 *
 * This is the production-path companion to the executor's precedence unit
 * tests — those drive the resolution given tagged nodes; this proves the
 * filesystem loader produces the right tags.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeLoadRunContext } from '../src/server/run-context';

let tmpRoot: string;
let examplesDir: string;
let agentsDir: string;
let domainDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-origin-'));
  examplesDir = path.join(tmpRoot, 'examples');
  agentsDir = path.join(tmpRoot, 'agents');
  domainDir = path.join(tmpRoot, 'domain'); // stands in for an out-of-repo workspace
  await fs.mkdir(examplesDir, { recursive: true });
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(domainDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const write = (dir: string, file: string, obj: unknown) =>
  fs.writeFile(path.join(dir, file), JSON.stringify(obj), 'utf8');

test('a real in-repo example file is tagged shipped', async () => {
  await write(examplesDir, 'plain.json', {
    name: 'plain',
    phases: [{ name: 'p', code: { source: 'return input' } }],
  });
  const load = makeLoadRunContext({ examplesDir, agentsDir });
  const ctx = await load('plain');
  expect(ctx).not.toBeNull();
  const found = ctx!.orchestrations.find(o => o.name === 'plain');
  expect(found?.__origin).toBe('shipped');
});

test('a symlinked (imported/domain) example file is tagged imported', async () => {
  // Real file lives outside examples/ (the domain workspace); examples/ holds
  // only a symlink to it — exactly how the import endpoint's linkOrCopy lands a
  // domain orchestration on macOS/Linux.
  await write(domainDir, 'router.json', {
    name: 'router',
    phases: [{ name: 'p', code: { source: 'return input' } }],
  });
  await fs.symlink(
    path.join(domainDir, 'router.json'),
    path.join(examplesDir, 'router.json'),
  );
  const load = makeLoadRunContext({ examplesDir, agentsDir });
  const ctx = await load('router');
  expect(ctx).not.toBeNull();
  const found = ctx!.orchestrations.find(o => o.name === 'router');
  expect(found?.__origin).toBe('imported');
});

test('mixed dir: symlinks are imported, real files are shipped', async () => {
  await write(examplesDir, 'shipped-one.json', { name: 'shipped-one', code: { source: 'return 1' } });
  await write(domainDir, 'imported-one.json', { name: 'imported-one', code: { source: 'return 2' } });
  await fs.symlink(
    path.join(domainDir, 'imported-one.json'),
    path.join(examplesDir, 'imported-one.json'),
  );
  const load = makeLoadRunContext({ examplesDir, agentsDir });
  const ctx = await load('shipped-one');
  expect(ctx).not.toBeNull();
  const byName = Object.fromEntries(
    ctx!.orchestrations.map(o => [o.name, o.__origin]),
  );
  expect(byName['shipped-one']).toBe('shipped');
  expect(byName['imported-one']).toBe('imported');
});
