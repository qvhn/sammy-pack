import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { type InputDecl } from './types';

/**
 * The orchestration's typed run inputs, shown as a head element above the
 * phases (like TriggersHead). Each declared input is collected from the user in
 * a form when they press ▶ Run (see RunInputsModal) and resolved to text —
 * `text` raw, `url` fetched, `jira` / `confluence` / `github` via the connector
 * credential, `file` extracted from an upload — then seeded as `${name}` before
 * phase 1. Without a declaration here, Run just runs with no input; this is
 * what makes the run prompt appear. Reads / writes `orchestration.inputs`.
 */
const KINDS: Array<{
  kind: InputDecl['kind'];
  label: string;
  icon: string;
  hint: string;
}> = [
  { kind: 'text', label: 'Text', icon: '✎', hint: 'A raw string the user types — a brief, an ID, freeform context.' },
  { kind: 'url', label: 'URL', icon: '🔗', hint: 'A URL — the server fetches it to text before the run.' },
  { kind: 'jira', label: 'Jira', icon: '🎫', hint: 'A Jira key or issue URL — fetched via the `atlassian` connector credential.' },
  { kind: 'confluence', label: 'Confluence', icon: '📘', hint: 'A Confluence page URL / id — fetched via the `atlassian` connector credential.' },
  { kind: 'github', label: 'GitHub', icon: '🐙', hint: 'A GitHub issue / PR URL — fetched via the `github` connector credential.' },
  { kind: 'file', label: 'File / Doc', icon: '📎', hint: 'A document uploaded at run time — extracted to text (PDF / docx / etc.).' },
];

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A sensible default variable name per kind — so a user picking "Jira" gets
 *  `ticket` rather than an empty field they'd be tempted to type the ticket
 *  VALUE into (the value goes in the run prompt, not here). */
const DEFAULT_NAME: Record<InputDecl['kind'], string> = {
  text: 'input',
  url: 'source',
  jira: 'ticket',
  confluence: 'page',
  github: 'issue',
  file: 'document',
};
const DEFAULT_NAME_VALUES = Object.values(DEFAULT_NAME);

function kindMeta(kind: InputDecl['kind']) {
  return KINDS.find(k => k.kind === kind) ?? KINDS[0];
}

function summary(d: InputDecl): string {
  return `${d.name || '…'}${d.required ? ' *' : ''} · ${d.kind}`;
}

export function InputsHead({
  inputs,
  onChange,
}: {
  inputs?: InputDecl[];
  onChange: (next: InputDecl[]) => void;
}) {
  const list = inputs ?? [];
  // With no inputs yet, open the add-input form expanded by default so the user
  // can start declaring immediately instead of clicking "+ Add input" first.
  const [editing, setEditing] = useState<number | 'new' | null>(
    list.length === 0 ? 'new' : null,
  );

  function commit(idx: number | 'new', d: InputDecl) {
    if (idx === 'new') onChange([...list, d]);
    else onChange(list.map((x, i) => (i === idx ? d : x)));
    setEditing(null);
  }
  function remove(idx: number) {
    onChange(list.filter((_, i) => i !== idx));
    setEditing(null);
  }

  const draft: InputDecl | null =
    editing === 'new'
      ? { name: DEFAULT_NAME.text, kind: 'text', required: true }
      : typeof editing === 'number'
        ? (list[editing] ?? null)
        : null;

  // Names already taken (for duplicate detection in the form).
  const takenNames = list
    .filter((_, i) => i !== editing)
    .map(d => d.name);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.head}>◇ Input{list.length === 1 ? '' : 's'}</Text>
        {list.length === 0 && (
          <Text style={styles.none}>None — Run starts immediately with no prompt</Text>
        )}
        {list.map((d, i) => (
          <Pressable
            key={i}
            onPress={() => setEditing(i)}
            accessibilityRole="button"
            accessibilityLabel={`Edit input ${d.name}`}
            style={styles.chip}>
            <Text style={styles.chipIcon}>{kindMeta(d.kind).icon}</Text>
            <Text style={styles.chipText} numberOfLines={1}>
              {summary(d)}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setEditing(editing === 'new' ? null : 'new')}
          accessibilityRole="button"
          accessibilityLabel="Add input"
          style={styles.addBtn}>
          <Text style={styles.addText}>+ Add input</Text>
        </Pressable>
      </View>
      {draft && (
        <InputForm
          key={String(editing)}
          initial={draft}
          isNew={editing === 'new'}
          takenNames={takenNames}
          onSave={d => commit(editing as number | 'new', d)}
          onCancel={() => setEditing(null)}
          onDelete={
            typeof editing === 'number' ? () => remove(editing) : undefined
          }
        />
      )}
    </View>
  );
}

function InputForm({
  initial,
  isNew,
  takenNames,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: InputDecl;
  isNew: boolean;
  takenNames: string[];
  onSave: (d: InputDecl) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [d, setD] = useState<InputDecl>(initial);
  const nameOk = NAME_RE.test(d.name);
  const dup = !!d.name && takenNames.includes(d.name);
  const valid = nameOk && !dup;

  // Pick a kind. For a NEW input, auto-fill the variable name with that kind's
  // default (`jira` → `ticket`, `file` → `document`, …) UNLESS the user already
  // typed a custom name — so they don't have to invent one, and aren't tempted
  // to type the ticket VALUE here (that goes in the run prompt).
  const pickKind = (kind: InputDecl['kind']) =>
    setD(prev => ({
      ...prev,
      kind,
      name:
        isNew && (prev.name.trim() === '' || DEFAULT_NAME_VALUES.includes(prev.name))
          ? DEFAULT_NAME[kind]
          : prev.name,
    }));

  return (
    <View style={styles.form}>
      <View style={styles.kindRow}>
        {KINDS.map(k => {
          const active = d.kind === k.kind;
          return (
            <Pressable
              key={k.kind}
              onPress={() => pickKind(k.kind)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${k.label} input`}
              style={[styles.kindChip, active && styles.kindChipActive]}>
              <Text style={[styles.kindChipText, active && styles.kindChipTextActive]}>
                {k.icon} {k.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>{kindMeta(d.kind).hint}</Text>

      <Field label="Variable name — NOT the value; you'll reference it as ${name} in prompts">
        <Input
          value={d.name}
          onChangeText={v => setD({ ...d, name: v })}
          placeholder="ticket"
        />
        {!nameOk && d.name.length > 0 ? (
          <Text style={styles.err}>
            This is the variable name (e.g. "ticket"), not the ticket itself —
            letters, digits, underscore only. The actual{' '}
            {d.kind === 'file' ? 'document' : `${d.kind} value`} is entered when
            you press ▶ Run.
          </Text>
        ) : dup ? (
          <Text style={styles.err}>An input named "{d.name}" already exists.</Text>
        ) : null}
      </Field>

      <Field label="Description — shown to the user when collecting this input">
        <Input
          value={d.description ?? ''}
          onChangeText={v => setD({ ...d, description: v || undefined })}
          placeholder="The ticket to work on"
          multiline
        />
      </Field>

      <View style={styles.reqRow}>
        <Switch
          value={d.required ?? false}
          onValueChange={v => setD({ ...d, required: v })}
          accessibilityLabel="Required input"
        />
        <Text style={styles.reqLabel}>
          Required — refuse the run unless this is provided
        </Text>
      </View>

      <View style={styles.formBtns}>
        <Pressable
          onPress={() => valid && onSave({ ...d, name: d.name.trim() })}
          disabled={!valid}
          style={[styles.saveBtn, !valid && styles.saveBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Save input">
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.cancelBtn} accessibilityRole="button" accessibilityLabel="Cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        {onDelete && (
          <Pressable onPress={onDelete} style={styles.delBtn} accessibilityRole="button" accessibilityLabel="Delete input">
            <Text style={styles.delText}>Delete</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Input(props: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor="#9ca3af"
      autoCapitalize="none"
      autoCorrect={false}
      multiline={props.multiline}
      numberOfLines={props.multiline ? 3 : undefined}
      style={[styles.input, props.multiline && styles.inputMultiline]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  head: { fontSize: 12, fontWeight: '700', color: '#7c3aed', marginRight: 2 },
  none: { fontSize: 11, color: '#9ca3af', fontStyle: 'italic' },
  arrow: { fontSize: 14, color: '#9ca3af', marginLeft: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd6fe',
    backgroundColor: '#f5f3ff',
  },
  chipIcon: { fontSize: 12 },
  chipText: { fontSize: 11, color: '#6d28d9', fontWeight: '600', fontFamily: 'Menlo' },
  addBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#c4b5fd',
  },
  addText: { fontSize: 11, color: '#7c3aed', fontWeight: '700' },
  form: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd6fe',
    backgroundColor: '#faf5ff',
    gap: 8,
    maxWidth: 460,
  },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  kindChip: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  kindChipActive: { borderColor: '#7c3aed', backgroundColor: '#ede9fe' },
  kindChipText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  kindChipTextActive: { color: '#6d28d9' },
  hint: { fontSize: 11, color: '#6d28d9' },
  field: { gap: 3 },
  fieldLabel: { fontSize: 11, fontWeight: '600', color: '#374151' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  // Multi-line variant for the description — a 1-line bar is cramped to read
  // and type a sentence in. Grows from ~3 lines; text anchors at the top.
  inputMultiline: {
    minHeight: 64,
    paddingTop: 8,
    textAlignVertical: 'top',
    lineHeight: 17,
  },
  err: { fontSize: 10, color: '#b91c1c' },
  reqRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reqLabel: { fontSize: 11, color: '#374151', fontWeight: '600' },
  formBtns: { flexDirection: 'row', gap: 6 },
  saveBtn: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#7c3aed',
  },
  saveBtnDisabled: { backgroundColor: '#c4b5fd' },
  saveText: { fontSize: 12, color: '#ffffff', fontWeight: '700' },
  cancelBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  cancelText: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  delBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  delText: { fontSize: 12, color: '#b91c1c', fontWeight: '600' },
});
