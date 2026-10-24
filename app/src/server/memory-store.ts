/**
 * Cross-run memory store — a durable, file-backed key→text store so an
 * orchestration can read what prior runs learned and write back new lessons.
 *
 * This is the persistence layer behind the `memory-reader` / `memory-writer`
 * agents and the `memory-augmented-run` example: memory is "a source you read
 * at the start of a run and write at the end." Each key is one namespace of
 * memory (e.g. a component, a customer, a triage queue) stored as
 * `memory-store/<key>.json`. Plain files keep it git-diffable-if-you-want,
 * trivially inspectable, and free of a new infra dependency — same spirit as
 * the file-backed datasets/evals.
 *
 * A MISSING key is not an error: it returns empty content, so a first run
 * starts cold cleanly and the same flow warms up on subsequent runs.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export type MemoryEntry = {
  key: string;
  /** The accumulated memory text for this namespace ('' on a cold start). */
  content: string;
  /** Epoch ms of the last write, or null if never written. */
  updatedAt: number | null;
};

/** Keys must be safe path segments (no traversal, no separators). */
export function isSafeMemoryKey(key: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(key);
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/**
 * Read a memory namespace. Returns empty content (not an error) when the key
 * has never been written, so cold starts are a normal, handled case.
 */
export async function readMemory(dir: string, key: string): Promise<MemoryEntry> {
  try {
    const raw = await fs.readFile(fileFor(dir, key), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MemoryEntry>;
    return {
      key,
      content: typeof parsed.content === 'string' ? parsed.content : '',
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { key, content: '', updatedAt: null };
    }
    throw err;
  }
}

/**
 * Write (replace) a memory namespace's content. The writer agent emits the
 * FULL updated store, so a write is a replace, not an append — dedupe/prune
 * happens in the agent, persistence is dumb on purpose.
 */
export async function writeMemory(
  dir: string,
  key: string,
  content: string,
  now: number,
): Promise<MemoryEntry> {
  await fs.mkdir(dir, { recursive: true });
  const entry: MemoryEntry = { key, content, updatedAt: now };
  await fs.writeFile(fileFor(dir, key), JSON.stringify(entry, null, 2) + '\n', 'utf8');
  return entry;
}

/** List the keys currently in the store. */
export async function listMemoryKeys(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

/** Delete a memory namespace. A missing key is a no-op (idempotent). */
export async function deleteMemory(dir: string, key: string): Promise<void> {
  try {
    await fs.unlink(fileFor(dir, key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
