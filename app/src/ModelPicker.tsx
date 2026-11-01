import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MODEL_CHOICES, modelLabel, modelPriceLabel, resolveModelName } from './llm/models';

/**
 * Pick a model, or leave the default — the native build's picker (the web
 * build uses the dropdown in ModelPicker.web.tsx, with the same props).
 * `value` is the model as written ('' = the default); any id not in the list
 * shows under "Other" as typed.
 */
export function ModelPicker({
  value,
  onChange,
  defaultModel,
  defaultSource,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The model "Default" runs on here, and where that comes from. */
  defaultModel: string;
  defaultSource: string;
}) {
  const listed = MODEL_CHOICES.some(c => c.id === value);
  const [other, setOther] = useState(!!value && !listed);
  const isDefault = !value && !other;

  const chip = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Model">
        {chip('default', 'Default', isDefault, () => {
          setOther(false);
          onChange('');
        })}
        {MODEL_CHOICES.map(c =>
          chip(c.id, c.label, !other && value === c.id, () => {
            setOther(false);
            onChange(c.id);
          }),
        )}
        {chip('other', 'Other…', other, () => {
          setOther(true);
          if (listed) onChange('');
        })}
      </View>
      {other ? (
        <TextInput
          value={value}
          onChangeText={t => onChange(t.trim())}
          placeholder="a model id, e.g. claude-opus-4-1, or an alias: opus / sonnet / haiku"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Model id"
        />
      ) : null}
      <Text style={styles.hint}>
        {isDefault ? `Default: ${modelLabel(defaultModel)} (${defaultSource}). ` : ''}
        Runs on {resolveModelName(value) ?? defaultModel}
        {modelPriceLabel(resolveModelName(value) ?? defaultModel)
          ? ` · ${modelPriceLabel(resolveModelName(value) ?? defaultModel)}`
          : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  chipOn: { borderColor: '#2563eb', backgroundColor: '#dbeafe' },
  chipText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  chipTextOn: { color: '#1d4ed8' },
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
  hint: { fontSize: 11, color: '#6b7280' },
});
