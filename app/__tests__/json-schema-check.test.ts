import { checkContract, checkSchema } from '../src/lib/json-schema-check';

describe('checkSchema — primitives', () => {
  it('accepts a matching type', () => {
    expect(checkSchema('hi', { type: 'string' })).toEqual([]);
    expect(checkSchema(42, { type: 'number' })).toEqual([]);
    expect(checkSchema(42, { type: 'integer' })).toEqual([]);
    expect(checkSchema(true, { type: 'boolean' })).toEqual([]);
    expect(checkSchema(null, { type: 'null' })).toEqual([]);
  });

  it('rejects a type mismatch', () => {
    const v = checkSchema(42, { type: 'string' });
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/expected string, got integer/);
  });

  it('treats an integer as an acceptable number but not vice versa', () => {
    expect(checkSchema(7, { type: 'number' })).toEqual([]);
    expect(checkSchema(7.5, { type: 'integer' })).toHaveLength(1);
  });

  it('enforces enum + const', () => {
    expect(checkSchema('b', { enum: ['a', 'b', 'c'] })).toEqual([]);
    expect(checkSchema('z', { enum: ['a', 'b'] })).toHaveLength(1);
    expect(checkSchema('x', { const: 'x' })).toEqual([]);
    expect(checkSchema('y', { const: 'x' })).toHaveLength(1);
  });

  it('enforces string length + number range', () => {
    expect(checkSchema('ab', { type: 'string', minLength: 3 })).toHaveLength(1);
    expect(checkSchema('abcd', { type: 'string', maxLength: 3 })).toHaveLength(1);
    expect(checkSchema(2, { type: 'number', minimum: 5 })).toHaveLength(1);
    expect(checkSchema(99, { type: 'number', maximum: 10 })).toHaveLength(1);
  });
});

describe('checkSchema — objects', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
    },
    required: ['name'],
  };

  it('accepts a valid object', () => {
    expect(checkSchema({ name: 'x', count: 3 }, schema)).toEqual([]);
  });

  it('flags a missing required property with a pathed message', () => {
    const v = checkSchema({ count: 3 }, schema);
    expect(v).toHaveLength(1);
    expect(v[0].path).toBe('/name');
    expect(v[0].message).toMatch(/missing required property/);
  });

  it('flags a wrong-typed property', () => {
    const v = checkSchema({ name: 'x', count: 'three' }, schema);
    expect(v.some(e => e.path === '/count')).toBe(true);
  });

  it('enforces additionalProperties: false', () => {
    const strict = { ...schema, additionalProperties: false };
    const v = checkSchema({ name: 'x', bogus: 1 }, strict);
    expect(v.some(e => e.message.includes('unexpected property'))).toBe(true);
  });

  it('recurses into nested objects + arrays', () => {
    const nested = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        },
      },
    };
    expect(checkSchema({ items: [{ id: 1 }, { id: 2 }] }, nested)).toEqual([]);
    const v = checkSchema({ items: [{ id: 1 }, { name: 'no-id' }] }, nested);
    expect(v.some(e => e.path === '/items/1/id')).toBe(true);
  });

  it('enforces array minItems / maxItems', () => {
    expect(checkSchema([1], { type: 'array', minItems: 2 })).toHaveLength(1);
    expect(checkSchema([1, 2, 3], { type: 'array', maxItems: 2 })).toHaveLength(1);
  });
});

describe('checkSchema — anyOf / oneOf', () => {
  it('anyOf: passes when at least one matches', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(checkSchema('x', s)).toEqual([]);
    expect(checkSchema(5, s)).toEqual([]);
    expect(checkSchema(true, s)).toHaveLength(1);
  });

  it('oneOf: passes when exactly one matches', () => {
    const s = { oneOf: [{ const: 'a' }, { const: 'b' }] };
    expect(checkSchema('a', s)).toEqual([]);
    expect(checkSchema('c', s)).toHaveLength(1);
  });
});

describe('checkContract — executor integration shape', () => {
  it('returns enforce:false for a non-schema contract (string ref)', () => {
    expect(checkContract('some/json/pointer', '{}')).toEqual({ enforce: false });
    expect(checkContract(undefined, 'whatever')).toEqual({ enforce: false });
  });

  it('returns enforce:false for an empty / constraint-less schema', () => {
    expect(checkContract({}, '{}')).toEqual({ enforce: false });
    expect(checkContract({ description: 'just docs' }, '{}')).toEqual({
      enforce: false,
    });
  });

  it('passes when JSON output matches the contract', () => {
    const contract = {
      type: 'object',
      properties: { verdict: { type: 'string' }, score: { type: 'integer' } },
      required: ['verdict'],
    };
    const r = checkContract(contract, '{"verdict":"pass","score":9}');
    expect(r).toMatchObject({ enforce: true, ok: true });
  });

  it('strips a ```json fence the model added', () => {
    const contract = { type: 'object', required: ['ok'] };
    const r = checkContract(contract, '```json\n{"ok":true}\n```');
    expect(r).toMatchObject({ enforce: true, ok: true });
  });

  it('fails when a structured contract gets output with no JSON at all', () => {
    const contract = { type: 'object', required: ['x'] };
    const r = checkContract(contract, 'this is just prose, not JSON');
    expect(r).toMatchObject({ enforce: true, ok: false });
    if (r.enforce && !r.ok) expect(r.reason).toMatch(/no JSON object\/array/);
  });

  it('salvages the last balanced JSON object embedded in agent narration', () => {
    const contract = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    };
    const r = checkContract(
      contract,
      'Here is my analysis of the run.\nFinal answer: {"verdict":"pass"}',
    );
    expect(r).toMatchObject({ enforce: true, ok: true });
  });

  it('fails + reports violations when JSON output breaks the contract', () => {
    const contract = {
      type: 'object',
      properties: { score: { type: 'integer' } },
      required: ['score', 'verdict'],
    };
    const r = checkContract(contract, '{"score":"high"}');
    expect(r).toMatchObject({ enforce: true, ok: false });
    if (r.enforce && !r.ok) {
      expect(r.reason).toMatch(/violates its declared contract/);
    }
  });

  it('validates raw text directly for a string-typed contract', () => {
    const contract = { type: 'string', minLength: 5 };
    expect(checkContract(contract, 'plenty long')).toMatchObject({
      enforce: true,
      ok: true,
    });
    expect(checkContract(contract, 'hi')).toMatchObject({
      enforce: true,
      ok: false,
    });
  });
});
