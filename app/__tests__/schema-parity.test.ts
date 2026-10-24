import fs from 'node:fs';
import path from 'node:path';
import { ALL_PROVIDERS } from '../src/types';
import { NODE_BOUNDS } from '../src/validate';

/**
 * Schema ⇄ runtime parity for ENUM values.
 *
 * cli-parity.test.ts already guards that every schema *property* is handled by
 * the executor + documented in SKILL.md. This guards the other drift axis — an
 * enum value that exists in the schema but not the runtime (or vice versa).
 * That's the exact failure that shipped `bedrock` runnable but missing from the
 * published schema enum: the provider list was hand-copied into four places.
 *
 * The provider set is now a single source (`ALL_PROVIDERS` in types.ts), so
 * this only has to pin the schema's `provider` enum to it. Other schema enums
 * (kind / environment / method / backoff / permissionMode / accumulate-mode)
 * have no single canonical runtime array to compare against — they're handled
 * inline in the executor and already covered by the property-parity test.
 */

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schema/orchestration.schema.json',
);

function loadSchema(): Record<string, any> {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

describe('schema ⇄ runtime enum parity', () => {
  it('schema `provider` enum exactly matches ALL_PROVIDERS', () => {
    const schema = loadSchema();
    const schemaEnum: string[] = schema?.$defs?.node?.properties?.provider?.enum;
    expect(Array.isArray(schemaEnum)).toBe(true);
    // Set equality, order-independent.
    expect([...schemaEnum].sort()).toEqual([...ALL_PROVIDERS].sort());
  });
});

describe('schema ⇄ runtime numeric-bound parity', () => {
  // The runtime validator's caps (NODE_BOUNDS) must equal the schema's
  // minimum/maximum for the same field — closing the reverse-drift axis the
  // enum guard doesn't cover (the schema declared `maxIterations ≤ 100` etc.
  // but validate.ts used to check only the lower bound).
  const MAP: Array<{
    bound: keyof typeof NODE_BOUNDS;
    def: string;
    prop: string;
  }> = [
    { bound: 'loopMaxIterations', def: 'loopBody', prop: 'maxIterations' },
    { bound: 'conversationRounds', def: 'conversationBody', prop: 'rounds' },
    { bound: 'retryTimes', def: 'retryPolicy', prop: 'times' },
    { bound: 'retryInitialMs', def: 'retryPolicy', prop: 'initialMs' },
  ];

  for (const { bound, def, prop } of MAP) {
    it(`NODE_BOUNDS.${bound} matches schema ${def}.${prop} min/max`, () => {
      const schema = loadSchema();
      const field = schema?.$defs?.[def]?.properties?.[prop];
      expect(field).toBeDefined();
      expect(NODE_BOUNDS[bound].min).toBe(field.minimum);
      expect(NODE_BOUNDS[bound].max).toBe(field.maximum);
    });
  }
});
