/**
 * Minimal JSON-Schema-subset validator.
 *
 * sammy-pack deliberately avoids an Ajv dependency (see validate.ts) —
 * the project hand-rolls the small amount of validation it needs. This
 * module covers the JSON Schema keywords that actually show up in node
 * `input` / `output` contracts:
 *
 *   type · properties · required · additionalProperties · items ·
 *   enum · const · minLength · maxLength · pattern · minimum · maximum ·
 *   minItems · maxItems · anyOf · oneOf
 *
 * `pattern` earns its place as the narrative-output contract: a phase
 * whose deliverable is prose can declare
 * `output: {"type":"string","pattern":"## Converged board"}` and a
 * partial result fails the phase fast instead of flowing downstream.
 *
 * It is NOT a complete JSON Schema implementation — no $ref, no
 * format. If a contract needs those, the user can still declare them;
 * this checker simply won't enforce the unsupported keywords (it never
 * produces a false positive for a keyword it doesn't understand).
 */

export type JsonSchema = Record<string, unknown>;

export type SchemaViolation = {
  /** JSON-pointer-ish path to the offending value, e.g. "/items/0/name". */
  path: string;
  message: string;
};

/** Validate `value` against `schema`. Returns [] when valid. */
export function checkSchema(
  value: unknown,
  schema: JsonSchema,
): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  walk(value, schema, '', out);
  return out;
}

function jsonType(
  v: unknown,
): 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? 'integer' : 'number';
  }
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  return 'object';
}

function typeMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // An integer is also an acceptable `number`.
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function walk(
  value: unknown,
  schema: JsonSchema,
  path: string,
  out: SchemaViolation[],
): void {
  // type
  const t = schema.type;
  if (typeof t === 'string') {
    const actual = jsonType(value);
    if (!typeMatches(actual, t)) {
      out.push({ path: path || '/', message: `expected ${t}, got ${actual}` });
      // Type mismatch — deeper checks would just be noise.
      return;
    }
  } else if (Array.isArray(t)) {
    const actual = jsonType(value);
    if (!t.some(x => typeof x === 'string' && typeMatches(actual, x))) {
      out.push({
        path: path || '/',
        message: `expected one of [${t.join(', ')}], got ${actual}`,
      });
      return;
    }
  }

  // const / enum
  if ('const' in schema) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      out.push({
        path: path || '/',
        message: `must equal const ${JSON.stringify(schema.const)}`,
      });
    }
  }
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some(
      e => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!ok) {
      out.push({
        path: path || '/',
        message: `must be one of ${JSON.stringify(schema.enum)}`,
      });
    }
  }

  // anyOf / oneOf — value must satisfy at least one (anyOf) /
  // exactly one (oneOf). We don't surface the sub-errors; just the
  // top-level "matched none".
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.filter(
      s => checkSchema(value, s as JsonSchema).length === 0,
    );
    if (matched.length === 0) {
      out.push({ path: path || '/', message: 'matched none of anyOf' });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      s => checkSchema(value, s as JsonSchema).length === 0,
    );
    if (matched.length !== 1) {
      out.push({
        path: path || '/',
        message: `must match exactly one of oneOf (matched ${matched.length})`,
      });
    }
  }

  // string constraints
  if (typeof value === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      out.push({
        path: path || '/',
        message: `string shorter than minLength ${schema.minLength}`,
      });
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      out.push({
        path: path || '/',
        message: `string longer than maxLength ${schema.maxLength}`,
      });
    }
    // `pattern` — the fail-fast contract for NARRATIVE phase outputs: an
    // `output` of {"type":"string","pattern":"## Converged board"} fails a
    // phase whose agent shipped a partial result ("pass in flight — I'll
    // poll in 2 minutes") instead of propagating it downstream.
    // Un-anchored, per JSON Schema semantics (a match anywhere passes). A
    // malformed regex is a contract-authoring error and fails loudly rather
    // than silently passing everything.
    if (typeof schema.pattern === 'string') {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        out.push({
          path: path || '/',
          message: `contract pattern ${JSON.stringify(schema.pattern)} is not a valid regex`,
        });
      }
      if (re && !re.test(value)) {
        out.push({
          path: path || '/',
          message: `string does not match pattern ${JSON.stringify(schema.pattern)}`,
        });
      }
    }
  }

  // number constraints
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push({
        path: path || '/',
        message: `number below minimum ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push({
        path: path || '/',
        message: `number above maximum ${schema.maximum}`,
      });
    }
  }

  // array
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push({
        path: path || '/',
        message: `array shorter than minItems ${schema.minItems}`,
      });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push({
        path: path || '/',
        message: `array longer than maxItems ${schema.maxItems}`,
      });
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => {
        walk(item, schema.items as JsonSchema, `${path}/${i}`, out);
      });
    }
  }

  // object
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JsonSchema>) ?? {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in obj)) {
          out.push({
            path: `${path}/${key}`,
            message: `missing required property "${key}"`,
          });
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        walk(obj[key], sub, `${path}/${key}`, out);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          out.push({
            path: `${path}/${key}`,
            message: `unexpected property "${key}" (additionalProperties: false)`,
          });
        }
      }
    }
  }
}

/** Salvage the LAST balanced top-level JSON object/array embedded in a string.
 *  A single forward scan tracks string state so braces/brackets inside string
 *  literals don't throw off the depth count, and records each complete
 *  top-level `{…}`/`[…]` span — returning the parse of the last one. This lets
 *  an `output` contract accept agent narration around the JSON (the common
 *  case) instead of requiring a pure-JSON reply. Returns `undefined` when no
 *  balanced JSON value is present. */
export function extractLastJsonValue(s: string): unknown {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let lastSpan: [number, number] | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) lastSpan = [start, i];
      }
    }
  }
  if (!lastSpan) return undefined;
  try {
    return JSON.parse(s.slice(lastSpan[0], lastSpan[1] + 1));
  } catch {
    return undefined;
  }
}

/** Convenience used by the executor: given a node's `output` / `input`
 *  contract (a SchemaRef) and a raw agent output string, decide whether
 *  the contract is enforceable + whether it holds.
 *
 *  Only the INLINE object-schema form of a SchemaRef is enforced. The
 *  string form (a JSON-pointer / file path) is treated as documentation
 *  only — resolving external refs is out of scope. Returns:
 *    - { enforce: false }                 — no inline schema, skip
 *    - { enforce: true, ok: true }        — output parsed + matched
 *    - { enforce: true, ok: false, ... }  — parse failed or violations */
export function checkContract(
  contract: unknown,
  rawOutput: string,
):
  | { enforce: false }
  | { enforce: true; ok: true; parsed: unknown }
  | { enforce: true; ok: false; reason: string } {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return { enforce: false };
  }
  const schema = contract as JsonSchema;
  // A schema with no recognized constraints isn't worth enforcing.
  const hasConstraints =
    'type' in schema ||
    'properties' in schema ||
    'required' in schema ||
    'enum' in schema ||
    'items' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema ||
    'const' in schema;
  if (!hasConstraints) return { enforce: false };

  // If the schema expects an object/array, the agent output must be
  // JSON. Strip a ```json fence if the model wrapped it.
  let parsed: unknown;
  const trimmed = rawOutput
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A string-typed contract can validate the raw text directly.
    if (schema.type === 'string') {
      parsed = rawOutput;
    } else {
      // Agents narrate ("Here's the result: {...}") far more often than they
      // emit pure JSON, so before failing, salvage the last balanced JSON
      // value embedded anywhere in the output.
      const extracted = extractLastJsonValue(rawOutput);
      if (extracted !== undefined) {
        parsed = extracted;
      } else {
        return {
          enforce: true,
          ok: false,
          reason:
            'output declared a structured contract but contained no JSON object/array',
        };
      }
    }
  }
  const violations = checkSchema(parsed, schema);
  if (violations.length > 0) {
    return {
      enforce: true,
      ok: false,
      reason:
        'output violates its declared contract: ' +
        violations
          .slice(0, 5)
          .map(v => `${v.path} — ${v.message}`)
          .join('; '),
    };
  }
  return { enforce: true, ok: true, parsed };
}
