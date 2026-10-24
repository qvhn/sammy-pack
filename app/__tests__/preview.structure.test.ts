/**
 * Structural-parity guard: the preview walker (`walkBody`) must enumerate the
 * SAME body kinds the executor dispatches (`dispatchNode`), so the two can't
 * silently drift — a new body kind added to the executor but not preview (or
 * vice versa) fails here.
 *
 * We cross-check `PREVIEW_BODY_KINDS` against TWO independent sources of truth:
 *   1. the schema's `oneOf` body-key list (the canonical set of body kinds), and
 *   2. the actual `if (node.<kind>)` dispatch branches in executor.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW_BODY_KINDS } from '../src/llm/preview';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schema/orchestration.schema.json');
const EXECUTOR_PATH = path.join(REPO_ROOT, 'app/src/llm/executor.ts');

describe('preview ↔ executor structural parity', () => {
  test('preview handles every schema body kind', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const schemaKinds: string[] = schema.$defs.node.oneOf.map(
      (o: { required: string[] }) => o.required[0],
    );
    const previewSet = new Set<string>(PREVIEW_BODY_KINDS);
    for (const kind of schemaKinds) {
      expect(previewSet.has(kind)).toBe(true);
    }
  });

  test('preview enumerates exactly the schema body kinds (no extras, none missing)', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const schemaKinds = new Set<string>(
      schema.$defs.node.oneOf.map((o: { required: string[] }) => o.required[0]),
    );
    expect(new Set(PREVIEW_BODY_KINDS)).toEqual(schemaKinds);
  });

  test('every preview body kind has a dispatch branch in executor.ts', () => {
    const executor = fs.readFileSync(EXECUTOR_PATH, 'utf8');
    for (const kind of PREVIEW_BODY_KINDS) {
      // dispatchNode branches on `node.<kind>` (e.g. `if (node.subflow)`,
      // `Array.isArray(node.phases)`). A reference to `node.<kind>` must exist.
      const pattern = new RegExp(`node\\.${kind}\\b`);
      expect(pattern.test(executor)).toBe(true);
    }
  });
});
