/**
 * The web app bundles the executor, so nothing it imports — transitively —
 * may statically import a `node:` module: Vite externalizes it and the page
 * renders blank ("Module node:child_process has been externalized for
 * browser compatibility"). Server-only capabilities are loaded at call time
 * (process.getBuiltinModule) or live outside this graph.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const IMPORT_RE = /^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|^\s*export\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm;

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(c) && c.match(/\.tsx?$/)) return c;
  }
  return null;
}

test('no static node: import is reachable from the executor', () => {
  const entry = path.join(SRC, 'llm', 'executor.ts');
  const seen = new Set<string>();
  const offenders: string[] = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith('node:')) offenders.push(`${path.relative(SRC, file)} → ${spec}`);
      else if (spec.startsWith('.')) {
        const next = resolve(file, spec);
        if (next) stack.push(next);
      }
    }
  }
  expect(seen.size).toBeGreaterThan(5);
  expect(offenders).toEqual([]);
});
