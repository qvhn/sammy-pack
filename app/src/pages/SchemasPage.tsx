import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { listSchemas, type SchemaDoc } from '../api';
import { Card, Hint, Page } from './Page';

/** Read-only viewer for JSON schemas under `schema/`. Lets users
 *  inspect the shape orchestrations + datasets + evals must conform
 *  to without having to dig through git, and try a document against a
 *  schema in-page. Editing happens in source control — schemas are
 *  infrastructure, not user data. */
export function SchemasPage() {
  const [schemas, setSchemas] = useState<SchemaDoc[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    listSchemas()
      .then(list => {
        setSchemas(list);
        if (list.length > 0) setSelectedName(list[0].name);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return schemas;
    return schemas.filter(s => {
      if (s.name.toLowerCase().includes(q)) return true;
      const meta = s.content as { title?: string; description?: string } | null;
      if (meta && typeof meta === 'object') {
        if (meta.title?.toLowerCase().includes(q)) return true;
        if (meta.description?.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [schemas, query]);

  // Keep selection valid as the filter narrows the list.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (!filtered.some(s => s.name === selectedName)) {
      setSelectedName(filtered[0].name);
    }
  }, [filtered, selectedName]);

  const selected = useMemo(
    () => schemas.find(s => s.name === selectedName) ?? null,
    [schemas, selectedName],
  );

  // With a single schema there's no list to navigate — drop the
  // master-detail chrome and show the one schema full-width.
  const single = !loading && !error && schemas.length === 1;

  return (
    <Page
      title="Schemas"
      subtitle="JSON schemas that orchestrations, datasets, and evals validate against">
      {loading && (
        <Card>
          <Hint>Loading…</Hint>
        </Card>
      )}
      {error && (
        <Card>
          <Text style={styles.errText}>Error: {error}</Text>
        </Card>
      )}
      {!loading && !error && schemas.length === 0 && (
        <Card>
          <Hint>
            No schemas registered. Drop JSON Schema files into the workspace's{' '}
            <Text style={styles.mono}>schema/</Text> directory.
          </Hint>
        </Card>
      )}

      {!loading && !error && schemas.length > 0 && (
        <View style={styles.layout}>
          {!single && (
            <View style={styles.sidebar}>
              <View style={styles.searchWrap}>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Filter schemas…"
                  placeholderTextColor="#9ca3af"
                  accessibilityLabel="Filter schemas"
                  style={styles.search}
                />
              </View>
              <ScrollView style={styles.sidebarScroll} nestedScrollEnabled>
                {filtered.length === 0 && (
                  <View style={styles.sidebarEmpty}>
                    <Hint>No schemas match “{query.trim()}”.</Hint>
                  </View>
                )}
                {filtered.map(s => {
                  const sel = selectedName === s.name;
                  return (
                    <Pressable
                      key={s.name}
                      onPress={() => setSelectedName(s.name)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: sel }}
                      accessibilityLabel={`Schema ${s.name}`}
                      style={[
                        styles.sidebarRow,
                        sel && styles.sidebarRowSelected,
                      ]}>
                      <Text
                        style={[
                          styles.sidebarName,
                          sel && styles.sidebarTextSelected,
                        ]}>
                        {s.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}

          <View style={styles.detail}>
            {selected ? (
              <SchemaDetail schema={selected} />
            ) : (
              <Card>
                <Hint>Select a schema on the left.</Hint>
              </Card>
            )}
          </View>
        </View>
      )}
    </Page>
  );
}

/** Detail pane for one schema: collapsible tree / raw toggle, copy
 *  button, and an in-page validation playground. */
function SchemaDetail({ schema }: { schema: SchemaDoc }) {
  const [view, setView] = useState<'tree' | 'raw'>('tree');
  const [copied, setCopied] = useState(false);

  const raw = useMemo(
    () => JSON.stringify(schema.content, null, 2),
    [schema.content],
  );

  // Reset transient UI when switching schemas.
  useEffect(() => {
    setView('tree');
    setCopied(false);
  }, [schema.name]);

  const copy = async () => {
    const ok = await copyText(raw);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Card title={schema.name} subtitle={schemaSubtitle(schema.content)}>
      <View style={styles.toolbar}>
        <View style={styles.segment}>
          <Pressable
            onPress={() => setView('tree')}
            accessibilityRole="button"
            accessibilityState={{ selected: view === 'tree' }}
            style={[styles.segBtn, view === 'tree' && styles.segBtnActive]}>
            <Text
              style={[
                styles.segText,
                view === 'tree' && styles.segTextActive,
              ]}>
              Tree
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setView('raw')}
            accessibilityRole="button"
            accessibilityState={{ selected: view === 'raw' }}
            style={[styles.segBtn, view === 'raw' && styles.segBtnActive]}>
            <Text
              style={[styles.segText, view === 'raw' && styles.segTextActive]}>
              Raw
            </Text>
          </Pressable>
        </View>
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel="Copy schema JSON to clipboard"
          style={styles.copyBtn}>
          <Text style={styles.copyBtnText}>{copied ? 'Copied ✓' : 'Copy JSON'}</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.codeScroll} nestedScrollEnabled horizontal={false}>
        {/* Tree: the root is the only/last item — no trailing comma. */}
        {view === 'tree' ? (
          <JsonNode value={schema.content} name={null} depth={0} defaultOpen isLast />
        ) : (
          <Text style={styles.codeText} selectable>
            {raw}
          </Text>
        )}
      </ScrollView>

      <ValidatePlayground schema={schema.content} />

      <Hint>
        Schemas are git-managed source-of-truth — editing happens in source
        control. The JSON panel in Pipelines validates against{' '}
        <Text style={styles.mono}>orchestration.schema.json</Text> automatically.
      </Hint>
    </Card>
  );
}

/* ────────────────────────────── JSON tree ────────────────────────────── */

type Json = unknown;

function valueType(
  v: Json,
): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

/** Hand-rolled recursive JSON tree. Objects/arrays collapse; leaf
 *  values are colored by type. Dependency-free. */
function JsonNode({
  value,
  name,
  depth,
  defaultOpen,
  isLast,
}: {
  value: Json;
  name: string | null;
  depth: number;
  defaultOpen?: boolean;
  isLast?: boolean;
}) {
  const t = valueType(value);
  const branch = t === 'object' || t === 'array';
  const [open, setOpen] = useState(!!defaultOpen || depth < 1);

  const indent = { paddingLeft: depth * 14 };
  const keyEl =
    name !== null ? <Text style={styles.tKey}>"{name}": </Text> : null;
  const comma = isLast ? '' : ',';

  if (!branch) {
    return (
      <View style={[styles.tRow, indent]}>
        <Text style={styles.tLine} selectable>
          {keyEl}
          <LeafValue value={value} type={t} />
          <Text style={styles.tPunct}>{comma}</Text>
        </Text>
      </View>
    );
  }

  const entries: Array<[string | null, Json]> = Array.isArray(value)
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, Json>);
  const empty = entries.length === 0;
  const open0 = Array.isArray(value) ? '[' : '{';
  const close0 = Array.isArray(value) ? ']' : '}';

  if (empty) {
    return (
      <View style={[styles.tRow, indent]}>
        <Text style={styles.tLine} selectable>
          {keyEl}
          <Text style={styles.tPunct}>
            {open0}
            {close0}
            {comma}
          </Text>
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Pressable
        onPress={() => setOpen(o => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${
          name ?? (Array.isArray(value) ? 'array' : 'object')
        }`}
        style={[styles.tRow, indent]}>
        <Text style={styles.tLine}>
          <Text style={styles.tCaret}>{open ? '▾ ' : '▸ '}</Text>
          {keyEl}
          <Text style={styles.tPunct}>{open0}</Text>
          {!open && (
            <Text style={styles.tCount}>
              {' '}
              {entries.length} {entries.length === 1 ? 'item' : 'items'}{' '}
              {close0}
              {comma}
            </Text>
          )}
        </Text>
      </Pressable>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k ?? i}
              name={Array.isArray(value) ? null : k}
              value={v}
              depth={depth + 1}
              isLast={i === entries.length - 1}
            />
          ))}
          <View style={[styles.tRow, indent]}>
            <Text style={styles.tLine} selectable>
              <Text style={styles.tPunct}>
                {close0}
                {comma}
              </Text>
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

function LeafValue({ value, type }: { value: Json; type: string }) {
  if (type === 'string') {
    return <Text style={styles.tString}>"{String(value)}"</Text>;
  }
  if (type === 'number') {
    return <Text style={styles.tNumber}>{String(value)}</Text>;
  }
  if (type === 'boolean') {
    return <Text style={styles.tBool}>{String(value)}</Text>;
  }
  return <Text style={styles.tNull}>null</Text>;
}

/* ───────────────────────── Validation playground ──────────────────────── */

function ValidatePlayground({ schema }: { schema: Json }) {
  const [doc, setDoc] = useState('');
  const [result, setResult] = useState<
    | { kind: 'ok' }
    | { kind: 'errors'; errors: string[] }
    | { kind: 'parse'; message: string }
    | null
  >(null);

  const run = () => {
    let parsed: Json;
    try {
      parsed = JSON.parse(doc);
    } catch (e) {
      setResult({ kind: 'parse', message: (e as Error).message });
      return;
    }
    const errors = validate(parsed, schema, schema, '$');
    setResult(errors.length === 0 ? { kind: 'ok' } : { kind: 'errors', errors });
  };

  return (
    <View style={styles.playground}>
      <Text style={styles.sectionLabel}>Validate a document</Text>
      <TextInput
        value={doc}
        onChangeText={t => {
          setDoc(t);
          if (result) setResult(null);
        }}
        placeholder={'Paste a JSON document to check against this schema…'}
        placeholderTextColor="#9ca3af"
        accessibilityLabel="Document to validate"
        multiline
        style={styles.docInput}
      />
      <View style={styles.playRow}>
        <Pressable
          onPress={run}
          accessibilityRole="button"
          disabled={doc.trim() === ''}
          style={[styles.validateBtn, doc.trim() === '' && styles.btnDisabled]}>
          <Text style={styles.validateBtnText}>Validate</Text>
        </Pressable>
        {result && (
          <Pressable
            onPress={() => {
              setDoc('');
              setResult(null);
            }}
            accessibilityRole="button"
            style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {result?.kind === 'parse' && (
        <View style={[styles.resultBox, styles.resultFail]}>
          <Text style={styles.resultFailText}>
            Not valid JSON: {result.message}
          </Text>
        </View>
      )}
      {result?.kind === 'ok' && (
        <View style={[styles.resultBox, styles.resultPass]}>
          <Text style={styles.resultPassText}>
            ✓ Document is valid against this schema.
          </Text>
        </View>
      )}
      {result?.kind === 'errors' && (
        <View style={[styles.resultBox, styles.resultFail]}>
          <Text style={styles.resultFailHead}>
            ✗ {result.errors.length}{' '}
            {result.errors.length === 1 ? 'error' : 'errors'}
          </Text>
          {result.errors.map((er, i) => (
            <Text key={i} style={styles.resultFailItem}>
              • {er}
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.partialNote}>
        Focused validator — covers type, required, properties,
        additionalProperties, enum, const, items, and local $ref. Not a full
        JSON-Schema implementation (e.g. no allOf/oneOf/format/pattern). For the
        complete contract, the server validates on save.
      </Text>
    </View>
  );
}

/** Hand-rolled JSON-Schema validator covering the common keywords.
 *  `root` is the top schema (for resolving local `$ref`). Returns a
 *  flat list of human-readable error strings ('' = valid). */
function validate(data: Json, schema: Json, root: Json, path: string): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: no value is allowed here`];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [];
  }
  const s = schema as Record<string, Json>;

  // Resolve a local $ref (e.g. "#/$defs/foo") before anything else.
  if (typeof s.$ref === 'string') {
    const resolved = resolveRef(s.$ref, root);
    if (resolved === undefined) {
      return [`${path}: cannot resolve $ref "${s.$ref}"`];
    }
    return validate(data, resolved, root, path);
  }

  const errors: string[] = [];
  const dType = valueType(data);

  // type (string or array of strings)
  if (s.type !== undefined) {
    const allowed = Array.isArray(s.type) ? (s.type as Json[]) : [s.type];
    const ok = allowed.some(t => matchesType(data, dType, String(t)));
    if (!ok) {
      errors.push(
        `${path}: expected type ${allowed
          .map(t => `"${t}"`)
          .join(' | ')}, got ${dType}`,
      );
      // If the base type is wrong, deeper checks are noise — bail here.
      return errors;
    }
  }

  // enum
  if (Array.isArray(s.enum)) {
    const matched = (s.enum as Json[]).some(e => deepEqual(e, data));
    if (!matched) {
      errors.push(
        `${path}: value must be one of ${(s.enum as Json[])
          .map(e => JSON.stringify(e))
          .join(', ')}`,
      );
    }
  }

  // const
  if ('const' in s) {
    if (!deepEqual(s.const, data)) {
      errors.push(`${path}: value must equal ${JSON.stringify(s.const)}`);
    }
  }

  if (dType === 'object') {
    const obj = data as Record<string, Json>;
    const props = (s.properties as Record<string, Json>) ?? {};

    // required
    if (Array.isArray(s.required)) {
      for (const key of s.required as Json[]) {
        if (!(String(key) in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }

    // properties
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        errors.push(...validate(obj[key], sub, root, `${path}.${key}`));
      }
    }

    // additionalProperties (boolean or schema)
    if ('additionalProperties' in s) {
      const ap = s.additionalProperties;
      const known = new Set(Object.keys(props));
      const patterns = s.patternProperties
        ? Object.keys(s.patternProperties as object)
        : [];
      for (const key of Object.keys(obj)) {
        if (known.has(key)) continue;
        if (patterns.some(p => safeTest(p, key))) continue;
        if (ap === false) {
          errors.push(`${path}: additional property "${key}" is not allowed`);
        } else if (ap && typeof ap === 'object') {
          errors.push(...validate(obj[key], ap, root, `${path}.${key}`));
        }
      }
    }
  }

  if (dType === 'array') {
    const arr = data as Json[];
    // items as a single schema → applies to every element.
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
      arr.forEach((el, i) => {
        errors.push(...validate(el, s.items, root, `${path}[${i}]`));
      });
    }
    // items as a tuple → positional schemas.
    if (Array.isArray(s.items)) {
      (s.items as Json[]).forEach((sub, i) => {
        if (i < arr.length) {
          errors.push(...validate(arr[i], sub, root, `${path}[${i}]`));
        }
      });
    }
  }

  return errors;
}

function matchesType(data: Json, dType: string, expected: string): boolean {
  if (expected === 'integer') {
    return typeof data === 'number' && Number.isInteger(data);
  }
  if (expected === 'number') return dType === 'number';
  return dType === expected;
}

function resolveRef(ref: string, root: Json): Json | undefined {
  if (!ref.startsWith('#')) return undefined; // only local refs supported
  const pointer = ref.slice(1); // drop leading '#'
  if (pointer === '' || pointer === '/') return root;
  const parts = pointer
    .split('/')
    .filter(Boolean)
    .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: Json = root;
  for (const part of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, Json>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((x, i) => deepEqual(x, b[i]));
    }
    const ao = a as Record<string, Json>;
    const bo = b as Record<string, Json>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every(k => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/* ──────────────────────────────── utils ──────────────────────────────── */

/** Copy text to the clipboard. Uses the async Clipboard API when
 *  available (web / RN-Web), falling back to a hidden textarea +
 *  execCommand. No dependency, matching the app's blob/anchor pattern
 *  elsewhere. Returns whether the copy was attempted successfully. */
async function copyText(text: string): Promise<boolean> {
  const g = globalThis as unknown as {
    navigator?: { clipboard?: { writeText(t: string): Promise<void> } };
    document?: {
      createElement(tag: string): {
        value: string;
        style: { position: string; left: string; top: string };
        focus(): void;
        select(): void;
      };
      body: {
        appendChild(n: unknown): void;
        removeChild(n: unknown): void;
      };
      execCommand(cmd: string): boolean;
    };
  };
  try {
    if (g.navigator?.clipboard?.writeText) {
      await g.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    if (!g.document) return false;
    const ta = g.document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    g.document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = g.document.execCommand('copy');
    g.document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function schemaSubtitle(content: unknown): string {
  if (content && typeof content === 'object') {
    const c = content as { title?: string; description?: string };
    if (c.title && c.description) return `${c.title} — ${c.description}`;
    if (c.title) return c.title;
    if (c.description) return c.description;
  }
  return 'JSON Schema';
}

const styles = StyleSheet.create({
  layout: { flexDirection: 'row', flex: 1, minHeight: 500, gap: 12 },
  sidebar: {
    width: 260,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  searchWrap: {
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  search: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  sidebarEmpty: { padding: 14 },
  sidebarScroll: { flex: 1 },
  sidebarRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  sidebarRowSelected: { backgroundColor: '#2563eb' },
  sidebarTextSelected: { color: '#ffffff' },
  sidebarName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  detail: { flex: 1 },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  segment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    overflow: 'hidden',
  },
  segBtn: { paddingHorizontal: 12, paddingVertical: 5, backgroundColor: '#ffffff' },
  segBtnActive: { backgroundColor: '#2563eb' },
  segText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  segTextActive: { color: '#ffffff' },
  copyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#111827',
    borderRadius: 6,
  },
  copyBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },

  codeScroll: {
    maxHeight: 560,
    backgroundColor: '#020617',
    borderRadius: 6,
    padding: 10,
  },
  codeText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#e2e8f0',
    lineHeight: 16,
  },

  // JSON tree
  tRow: { paddingVertical: 1 },
  tLine: { fontFamily: 'Menlo', fontSize: 11, lineHeight: 17 },
  tCaret: { color: '#64748b', fontSize: 10 },
  tKey: { color: '#7dd3fc', fontFamily: 'Menlo', fontSize: 11 },
  tPunct: { color: '#94a3b8', fontFamily: 'Menlo', fontSize: 11 },
  tCount: { color: '#64748b', fontFamily: 'Menlo', fontSize: 11, fontStyle: 'italic' },
  tString: { color: '#86efac', fontFamily: 'Menlo', fontSize: 11 },
  tNumber: { color: '#fdba74', fontFamily: 'Menlo', fontSize: 11 },
  tBool: { color: '#c4b5fd', fontFamily: 'Menlo', fontSize: 11 },
  tNull: { color: '#f87171', fontFamily: 'Menlo', fontSize: 11 },

  // Validate playground
  playground: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 10,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  docInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 11,
    fontFamily: 'Menlo',
    color: '#111827',
    backgroundColor: '#ffffff',
    minHeight: 96,
    textAlignVertical: 'top',
  },
  playRow: { flexDirection: 'row', gap: 6 },
  validateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  validateBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 12 },
  btnDisabled: { opacity: 0.5 },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  clearBtnText: { color: '#374151', fontWeight: '600', fontSize: 12 },
  resultBox: { borderRadius: 6, padding: 10, gap: 3, borderWidth: 1 },
  resultPass: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  resultPassText: { color: '#166534', fontSize: 12, fontWeight: '600' },
  resultFail: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  resultFailText: { color: '#b91c1c', fontSize: 12 },
  resultFailHead: { color: '#b91c1c', fontSize: 12, fontWeight: '700' },
  resultFailItem: {
    color: '#991b1b',
    fontSize: 11,
    fontFamily: 'Menlo',
    lineHeight: 16,
  },
  partialNote: { fontSize: 11, color: '#9ca3af', lineHeight: 16, fontStyle: 'italic' },

  mono: {
    fontFamily: 'Menlo',
    fontSize: 11,
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  errText: { color: '#b91c1c', fontSize: 12 },
});
