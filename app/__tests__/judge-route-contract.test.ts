/**
 * Contract test: every `route` whose router is one of the judgement agents must
 * use branch keys that are a SUBSET of that judge's declared branches.
 *
 * Judges emit `{"branch": "<key>"}`; if a judge's branch vocabulary and an
 * example's route keys drift apart (rename a branch in the judge, forget the
 * example — or vice versa), routing silently dead-ends at the `default`. This
 * locks the two together statically, no LLM needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node } from '../src/types';

const AGENTS_DIR = path.resolve(__dirname, '..', '..', 'agents');
const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'examples');

/** Parse a judge's declared branch set from its `branch` MUST be … line. */
function parseJudgeBranches(md: string): string[] | null {
  const line = md.split('\n').find(l => /`branch`\s+MUST be/i.test(l));
  if (!line) return null;
  const after = line.replace(/^.*MUST be (?:one of:|exactly)/i, '');
  const tokens = [...after.matchAll(/`([^`]+)`/g)].map(m => m[1]);
  return tokens.length ? tokens : null;
}

/** Map `agents/judge-*.md` → its declared branch set (router judges only). */
function loadJudgeBranches(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (!/^judge-.*\.md$/.test(f)) continue;
    const branches = parseJudgeBranches(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
    if (branches) map.set(`agents/${f}`, branches);
  }
  return map;
}

type RouteRef = { router?: string; keys: string[]; name: string };

function collectRoutes(node: Node, out: RouteRef[]): void {
  if (node.route) {
    out.push({
      router: node.route.router,
      keys: Object.keys(node.route.branches ?? {}),
      name: node.name,
    });
    for (const b of Object.values(node.route.branches ?? {})) collectRoutes(b as Node, out);
    if (node.route.default) collectRoutes(node.route.default as Node, out);
  }
  for (const arr of [node.phases, node.parallel, node.converge] as (Node[] | undefined)[]) {
    if (Array.isArray(arr)) for (const c of arr) collectRoutes(c, out);
  }
  if (node.loop?.body) collectRoutes(node.loop.body, out);
  if (node.map?.body) collectRoutes(node.map.body, out);
  if (node.onError) collectRoutes(node.onError, out);
}

describe('judge ↔ route branch contract', () => {
  const judges = loadJudgeBranches();

  test('the judgement agents declare parseable branch sets', () => {
    // triage, severity, blast-radius, flake, reproducibility, risk, release-readiness
    expect(judges.size).toBeGreaterThanOrEqual(7);
  });

  const files = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json'));
  test.each(files)(
    '%s — route keys ⊆ the routing judge\'s declared branches',
    filename => {
      const node = JSON.parse(
        fs.readFileSync(path.join(EXAMPLES_DIR, filename), 'utf8'),
      ) as Node;
      const routes: RouteRef[] = [];
      collectRoutes(node, routes);
      for (const r of routes) {
        if (!r.router) continue;
        const declared = judges.get(r.router);
        if (!declared) continue; // not one of our judges (generic router, etc.)
        for (const key of r.keys) {
          // A drift here means the route names a branch the judge can never
          // emit — routing would silently dead-end at the default.
          if (!declared.includes(key)) {
            throw new Error(
              `route "${r.name}" (router ${r.router}) has branch "${key}" not in the judge's declared branches [${declared.join(', ')}]`,
            );
          }
        }
      }
    },
  );
});
