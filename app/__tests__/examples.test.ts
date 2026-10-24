/**
 * Validate every example orchestration in ../../examples/ against the
 * runtime validator. Catches schema drift in checked-in JSON.
 */

import * as fs from 'fs';
import * as path from 'path';
import { validateOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'examples');

describe('examples/', () => {
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter(f => f.endsWith('.json'));

  test('directory has at least one example', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s validates', filename => {
    const raw = fs.readFileSync(path.join(EXAMPLES_DIR, filename), 'utf8');
    const parsed = JSON.parse(raw) as Node;
    // Only hard errors fail the check — warnings are advisory (e.g. a
    // non-Anthropic provider with Claude-only features) and shouldn't block.
    const errors = validateOrchestration(parsed).filter(
      e => e.severity === 'error',
    );
    if (errors.length > 0) {
      const msg = errors
        .map(e => `  - [${e.severity}] ${e.path}: ${e.message}`)
        .join('\n');
      throw new Error(`${filename} has ${errors.length} validation error(s):\n${msg}`);
    }
  });
});
