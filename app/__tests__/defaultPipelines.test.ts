/**
 * Guards the shipped-default allowlist in src/defaultPipelines.ts against
 * drift: every name we badge "default" must still have a matching
 * examples/<name>.json on disk. If a shipped example is renamed or
 * removed without updating the list, this fails loudly instead of the UI
 * silently badging a pipeline that no longer exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_PIPELINE_NAMES,
  isDefaultPipeline,
} from '../src/defaultPipelines';

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', 'examples');

describe('defaultPipelines', () => {
  const onDisk = new Set(
    fs
      .readdirSync(EXAMPLES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, '')),
  );

  test('the default set is non-empty', () => {
    expect(DEFAULT_PIPELINE_NAMES.size).toBeGreaterThan(0);
  });

  test.each([...DEFAULT_PIPELINE_NAMES])(
    '"%s" has a matching examples/<name>.json',
    name => {
      expect(onDisk.has(name)).toBe(true);
    },
  );

  test('isDefaultPipeline reflects membership', () => {
    expect(isDefaultPipeline('ticket-to-pr')).toBe(true);
    expect(isDefaultPipeline('some-user-authored-pipeline')).toBe(false);
  });
});
