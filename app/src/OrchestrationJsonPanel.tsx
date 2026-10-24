import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Node } from './types';
import { validateOrchestration, type ValidationError } from './validate';

/** Side-by-side JSON editor for an orchestration. Both Pipeline and
 *  Tree views mount this so every mode has a complete edit path —
 *  Graph stays the visual one, Tree stays the inspect one, but you
 *  can always drop into raw JSON without leaving the view.
 *
 *  Edits are buffered locally; only commits to onChange when the
 *  text parses + the user clicks Apply (or hits Cmd+S equivalent).
 *  Errors surface inline; outer state stays clean. */
export function OrchestrationJsonPanel({
  orchestration,
  onChange,
}: {
  orchestration: Node;
  onChange: (next: Node) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(orchestration, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // External edits (e.g. drag on the graph) flow into the buffer so
  // both views stay in sync. We compare serialized form to avoid
  // re-formatting the user's in-progress edit when nothing meaningful
  // changed.
  useEffect(() => {
    const next = JSON.stringify(orchestration, null, 2);
    setText(prev => (prev === next ? prev : next));
    setError(null);
  }, [orchestration]);

  function apply() {
    let parsed: Node;
    try {
      parsed = JSON.parse(text) as Node;
    } catch (err) {
      setError(`JSON: ${(err as Error).message}`);
      setValidationErrors([]);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Top-level must be a JSON object');
      setValidationErrors([]);
      return;
    }
    if (!parsed.name || typeof parsed.name !== 'string') {
      setError('Top-level "name" string is required');
      setValidationErrors([]);
      return;
    }
    // Hard errors block apply; warnings let it through (the executor
    // tolerates them and the user has already seen them in the
    // PipelinesPage validation banner).
    const issues = validateOrchestration(parsed);
    const hardErrors = issues.filter(i => i.severity === 'error');
    setValidationErrors(issues);
    if (hardErrors.length > 0) {
      setError(`Validation: ${hardErrors.length} error${hardErrors.length === 1 ? '' : 's'} — fix below to apply`);
      return;
    }
    onChange(parsed);
    setError(null);
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 1500);
  }

  function reset() {
    setText(JSON.stringify(orchestration, null, 2));
    setError(null);
  }

  const dirty = text !== JSON.stringify(orchestration, null, 2);

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>JSON</Text>
        <View style={styles.headerRight}>
          {dirty && <Text style={styles.dirtyTag}>· unsaved</Text>}
          {savedAt && <Text style={styles.savedTag}>✓ applied</Text>}
          <Pressable
            onPress={apply}
            disabled={!dirty}
            style={[styles.applyBtn, !dirty && styles.btnDisabled]}>
            <Text style={styles.applyBtnText}>Apply</Text>
          </Pressable>
          <Pressable onPress={reset} disabled={!dirty} style={styles.resetBtn}>
            <Text style={styles.resetBtnText}>Reset</Text>
          </Pressable>
        </View>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {validationErrors.length > 0 && (
        <View style={styles.validationList}>
          {validationErrors.slice(0, 8).map((v, i) => (
            <Text
              key={i}
              style={[
                styles.validationItem,
                v.severity === 'error' ? styles.validationErr : styles.validationWarn,
              ]}>
              {v.severity === 'error' ? 'ERR' : 'WRN'} {v.path}: {v.message}
            </Text>
          ))}
          {validationErrors.length > 8 && (
            <Text style={styles.validationItem}>
              … and {validationErrors.length - 8} more
            </Text>
          )}
        </View>
      )}
      <TextInput
        value={text}
        onChangeText={t => {
          setText(t);
          setError(null);
        }}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.editor}
      />
      <Text style={styles.footer}>
        Apply parses + replaces the full orchestration. Edits propagate to the
        Pipeline / Graph / Tree views and persist on the next outer save.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 10,
    gap: 8,
    minHeight: 400,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dirtyTag: { fontSize: 10, color: '#fde68a' },
  savedTag: { fontSize: 10, color: '#86efac' },
  applyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  applyBtnText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
  resetBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#1e293b',
    borderRadius: 6,
  },
  resetBtnText: { color: '#cbd5e1', fontSize: 11, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  error: {
    fontSize: 11,
    color: '#fca5a5',
    fontFamily: 'Menlo',
    backgroundColor: '#7f1d1d',
    padding: 6,
    borderRadius: 4,
  },
  editor: {
    flex: 1,
    minHeight: 380,
    backgroundColor: '#020617',
    borderRadius: 6,
    padding: 10,
    color: '#e2e8f0',
    fontFamily: 'Menlo',
    fontSize: 11,
    textAlignVertical: 'top',
  },
  footer: { fontSize: 10, color: '#64748b' },
  validationList: {
    gap: 2,
    backgroundColor: '#1e293b',
    padding: 6,
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#fde68a',
  },
  validationItem: { fontSize: 10, fontFamily: 'Menlo', color: '#fde68a' },
  validationErr: { color: '#fca5a5' },
  validationWarn: { color: '#fde68a' },
});
