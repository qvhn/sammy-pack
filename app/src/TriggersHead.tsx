import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { type Trigger } from './types';

/**
 * The orchestration's entry point, shown as a head element above the phases
 * in every editor view (Pipeline / Tree / Graph). A trigger is NOT a phase —
 * it has no agent and doesn't execute — so it's rendered separately and reads
 * / writes the top-level `orchestration.triggers` array.
 *
 * All six kinds fire on the dev server: webhook / events / deployment / queue
 * are HTTP-fired (POST /api/<ns>/<name>); cron / polling run on a server-side
 * schedule. The editor shows each kind's "how to fire" hint.
 */
const KINDS: Array<{ kind: Trigger['kind']; label: string; icon: string }> = [
  { kind: 'webhook', label: 'Webhook', icon: '▷' },
  { kind: 'cron', label: 'Cron', icon: '⏰' },
  { kind: 'events', label: 'Events', icon: '⚡' },
  { kind: 'deployment', label: 'Deployment', icon: '🚀' },
  { kind: 'polling', label: 'Polling', icon: '🔁' },
  { kind: 'queue', label: 'Queue', icon: '📥' },
];

function kindMeta(kind: Trigger['kind']) {
  return KINDS.find(k => k.kind === kind) ?? KINDS[0];
}

function defaultTrigger(kind: Trigger['kind']): Trigger {
  switch (kind) {
    case 'webhook':
      return { kind, path: '' };
    case 'cron':
      return { kind, expr: '0 9 * * *' };
    case 'events':
      return { kind, event: '' };
    case 'deployment':
      return { kind, environment: 'staging' };
    case 'polling':
      return { kind, source: '', intervalSeconds: 60 };
    case 'queue':
      return { kind, queue: '' };
  }
}

function summary(t: Trigger): string {
  switch (t.kind) {
    case 'webhook':
      return `/api/triggers/${t.path || '…'}`;
    case 'cron':
      return t.expr || '…';
    case 'events':
      return t.event || '…';
    case 'deployment':
      return t.environment || '…';
    case 'polling':
      return `${t.source || '…'} · ${t.intervalSeconds}s`;
    case 'queue':
      return t.queue || '…';
  }
}

/** How this trigger actually fires — shown in the editor so the entry point
 *  is testable. Mirrors the executors in `sammy-pack-api.ts`. */
function fireHint(t: Trigger): string {
  switch (t.kind) {
    case 'webhook':
      return `Fires on ${(t.method ?? 'POST')} /api/triggers/${t.path || '<path>'} — body becomes the input.`;
    case 'cron':
      return 'Fires on the cron schedule (server time); firing time is the input.';
    case 'events':
      return `Fires on POST /api/events/${t.event || '<event>'} — body becomes the input.`;
    case 'deployment':
      return `Fires on POST /api/deploy/${t.environment || '<environment>'} — body becomes the input.`;
    case 'polling':
      return `Server fetches the source every ${t.intervalSeconds || '…'}s; fires when the body changes.`;
    case 'queue':
      return `Fires on POST /api/queue/${t.queue || '<queue>'} — message body becomes the input.`;
  }
}

export function TriggersHead({
  triggers,
  onChange,
}: {
  triggers?: Trigger[];
  onChange: (next: Trigger[]) => void;
}) {
  const list = triggers ?? [];
  // Which trigger is open in the editor: an index, 'new', or null (closed).
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  function commit(idx: number | 'new', t: Trigger) {
    if (idx === 'new') onChange([...list, t]);
    else onChange(list.map((x, i) => (i === idx ? t : x)));
    setEditing(null);
  }
  function remove(idx: number) {
    onChange(list.filter((_, i) => i !== idx));
    setEditing(null);
  }

  const draft: Trigger | null =
    editing === 'new'
      ? defaultTrigger('webhook')
      : typeof editing === 'number'
        ? (list[editing] ?? null)
        : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.head}>▷ Trigger{list.length === 1 ? '' : 's'}</Text>
        {list.length === 0 && (
          <Text style={styles.manual}>Manual — runs only from the ▶ Run button</Text>
        )}
        {list.map((t, i) => (
          <Pressable
            key={i}
            onPress={() => setEditing(i)}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${t.kind} trigger`}
            style={styles.chip}>
            <Text style={styles.chipIcon}>{kindMeta(t.kind).icon}</Text>
            <Text style={styles.chipText} numberOfLines={1}>
              {summary(t)}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setEditing(editing === 'new' ? null : 'new')}
          accessibilityRole="button"
          accessibilityLabel="Add trigger"
          style={styles.addBtn}>
          <Text style={styles.addText}>+ Add trigger</Text>
        </Pressable>
        <Text style={styles.arrow}>→</Text>
      </View>
      {draft && (
        <TriggerForm
          key={String(editing)}
          initial={draft}
          onSave={t => commit(editing as number | 'new', t)}
          onCancel={() => setEditing(null)}
          onDelete={
            typeof editing === 'number' ? () => remove(editing) : undefined
          }
        />
      )}
    </View>
  );
}

function TriggerForm({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Trigger;
  onSave: (t: Trigger) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [t, setT] = useState<Trigger>(initial);
  return (
    <View style={styles.form}>
      <View style={styles.kindRow}>
        {KINDS.map(k => {
          const active = t.kind === k.kind;
          return (
            <Pressable
              key={k.kind}
              onPress={() => setT(defaultTrigger(k.kind))}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${k.label} trigger`}
              style={[styles.kindChip, active && styles.kindChipActive]}>
              <Text style={[styles.kindChipText, active && styles.kindChipTextActive]}>
                {k.icon} {k.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>{fireHint(t)}</Text>
      <TriggerFields t={t} onChange={setT} />
      <View style={styles.formBtns}>
        <Pressable onPress={() => onSave(t)} style={styles.saveBtn} accessibilityRole="button" accessibilityLabel="Save trigger">
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.cancelBtn} accessibilityRole="button" accessibilityLabel="Cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        {onDelete && (
          <Pressable onPress={onDelete} style={styles.delBtn} accessibilityRole="button" accessibilityLabel="Delete trigger">
            <Text style={styles.delText}>Delete</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function TriggerFields({
  t,
  onChange,
}: {
  t: Trigger;
  onChange: (t: Trigger) => void;
}) {
  switch (t.kind) {
    case 'webhook':
      return (
        <>
          <Field label="Path — POST /api/triggers/…">
            <Input
              value={t.path}
              onChangeText={v => onChange({ ...t, path: v })}
              placeholder="deploy"
            />
          </Field>
          <View style={styles.methodRow}>
            {(['POST', 'GET'] as const).map(m => {
              const active = (t.method ?? 'POST') === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => onChange({ ...t, method: m })}
                  style={[styles.methodChip, active && styles.methodChipActive]}>
                  <Text style={[styles.methodText, active && styles.methodTextActive]}>
                    {m}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      );
    case 'cron':
      return (
        <Field label="Cron expression (5-field, server time)">
          <Input
            value={t.expr}
            onChangeText={v => onChange({ ...t, expr: v })}
            placeholder="0 9 * * *"
          />
        </Field>
      );
    case 'events':
      return (
        <Field label="Event name">
          <Input
            value={t.event}
            onChangeText={v => onChange({ ...t, event: v })}
            placeholder="pr.opened"
          />
        </Field>
      );
    case 'deployment':
      return (
        <Field label="Environment (deploy → run)">
          <Input
            value={t.environment}
            onChangeText={v => onChange({ ...t, environment: v })}
            placeholder="staging"
          />
        </Field>
      );
    case 'polling':
      return (
        <>
          <Field label="Source (URL or name)">
            <Input
              value={t.source}
              onChangeText={v => onChange({ ...t, source: v })}
              placeholder="https://example.com/queue"
            />
          </Field>
          <Field label="Interval (seconds)">
            <Input
              value={String(t.intervalSeconds)}
              onChangeText={v =>
                onChange({ ...t, intervalSeconds: Number(v.replace(/[^0-9]/g, '')) || 0 })
              }
              placeholder="60"
            />
          </Field>
        </>
      );
    case 'queue':
      return (
        <Field label="Queue name">
          <Input
            value={t.queue}
            onChangeText={v => onChange({ ...t, queue: v })}
            placeholder="jobs"
          />
        </Field>
      );
  }
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
}) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor="#9ca3af"
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  head: { fontSize: 12, fontWeight: '700', color: '#0891b2', marginRight: 2 },
  manual: { fontSize: 11, color: '#9ca3af', fontStyle: 'italic' },
  arrow: { fontSize: 14, color: '#9ca3af', marginLeft: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#a5f3fc',
    backgroundColor: '#ecfeff',
  },
  chipIcon: { fontSize: 12 },
  chipText: { fontSize: 11, color: '#0e7490', fontWeight: '600', fontFamily: 'Menlo' },
  addBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#67e8f9',
  },
  addText: { fontSize: 11, color: '#0891b2', fontWeight: '700' },
  form: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#a5f3fc',
    backgroundColor: '#f0fdff',
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
  kindChipActive: { borderColor: '#0891b2', backgroundColor: '#cffafe' },
  kindChipText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  kindChipTextActive: { color: '#0e7490' },
  hint: { fontSize: 11, color: '#0e7490' },
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
  methodRow: { flexDirection: 'row', gap: 4 },
  methodChip: {
    paddingVertical: 3,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  methodChipActive: { borderColor: '#0891b2', backgroundColor: '#cffafe' },
  methodText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  methodTextActive: { color: '#0e7490' },
  formBtns: { flexDirection: 'row', gap: 6 },
  saveBtn: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#0891b2',
  },
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
