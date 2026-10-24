/**
 * Every `examples/*.json` the docs point a reader at exists.
 *
 * A prose pointer is as citable as a code marker and drifts the same way: an
 * example renamed or removed leaves a dead path on the page a reader was
 * routed to, and nothing else in the tree notices. Deriving the list from the
 * docs themselves — rather than restating it — means a rename fails here
 * instead of in a reader's shell.
 *
 * Same idiom as cli-parity.test.ts: the source of truth is the artifact, and
 * the test reads it.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('every examples/*.json the docs point at exists', () => {
  const DOCS = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'AGENTS.md',
    ...fs
      .readdirSync(path.join(REPO_ROOT, 'docs'))
      .filter(f => f.endsWith('.md'))
      .map(f => path.join('docs', f)),
  ].filter(f => fs.existsSync(path.join(REPO_ROOT, f)));

  const refs: Array<{ doc: string; example: string }> = [];
  for (const doc of DOCS) {
    const raw = fs.readFileSync(path.join(REPO_ROOT, doc), 'utf8');
    for (const m of raw.matchAll(/`(examples\/[A-Za-z0-9._-]+\.json)`/g)) {
      refs.push({ doc, example: m[1] });
    }
  }

  test('the docs reference at least a few examples', () => {
    expect(refs.length).toBeGreaterThan(5);
  });

  test.each(refs)('$doc → $example', ({ doc, example }) => {
    if (!fs.existsSync(path.join(REPO_ROOT, example))) {
      throw new Error(
        `${doc} points at ${example}, which does not exist — the pointer has ` +
          `drifted from the workspace (or the file was renamed).`,
      );
    }
  });
});
