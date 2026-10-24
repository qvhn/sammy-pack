/**
 * Cross-run memory store — durability round-trip. Uses a real temp dir so the
 * file-backed persistence (not a mock) is what's under test.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readMemory,
  writeMemory,
  listMemoryKeys,
  deleteMemory,
  isSafeMemoryKey,
} from '../src/server/memory-store';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-mem-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('memory-store', () => {
  test('a cold read (never written) returns empty content, not an error', async () => {
    const m = await readMemory(dir, 'auth');
    expect(m).toEqual({ key: 'auth', content: '', updatedAt: null });
  });

  test('write then read round-trips the content and stamps updatedAt', async () => {
    const written = await writeMemory(dir, 'auth', 'lesson: X breaks on Y', 1000);
    expect(written).toEqual({ key: 'auth', content: 'lesson: X breaks on Y', updatedAt: 1000 });
    const read = await readMemory(dir, 'auth');
    expect(read.content).toBe('lesson: X breaks on Y');
    expect(read.updatedAt).toBe(1000);
  });

  test('persists ACROSS calls (the whole point — a later "run" sees the earlier write)', async () => {
    await writeMemory(dir, 'triage', 'run-1 learned A', 1);
    await writeMemory(dir, 'triage', 'run-1 learned A\nrun-2 learned B', 2);
    const m = await readMemory(dir, 'triage');
    expect(m.content).toBe('run-1 learned A\nrun-2 learned B');
    expect(m.updatedAt).toBe(2);
  });

  test('namespaces are independent', async () => {
    await writeMemory(dir, 'auth', 'auth memory', 1);
    await writeMemory(dir, 'billing', 'billing memory', 1);
    expect((await readMemory(dir, 'auth')).content).toBe('auth memory');
    expect((await readMemory(dir, 'billing')).content).toBe('billing memory');
    expect(await listMemoryKeys(dir)).toEqual(['auth', 'billing']);
  });

  test('delete removes a namespace and is idempotent', async () => {
    await writeMemory(dir, 'auth', 'x', 1);
    await deleteMemory(dir, 'auth');
    expect((await readMemory(dir, 'auth')).content).toBe('');
    await expect(deleteMemory(dir, 'auth')).resolves.toBeUndefined(); // no throw on missing
  });

  test('rejects unsafe keys (path traversal / separators)', () => {
    expect(isSafeMemoryKey('auth-prod_1')).toBe(true);
    expect(isSafeMemoryKey('../etc/passwd')).toBe(false);
    expect(isSafeMemoryKey('a/b')).toBe(false);
    expect(isSafeMemoryKey('')).toBe(false);
  });
});
