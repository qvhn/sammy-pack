import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export type PillOption = { value: string; label: string };

/**
 * Single-select pill picker that scales. A flat wall of pills is unusable once
 * a list grows to dozens/hundreds (agents, orchestrations…), so this:
 *  - shows a filter box once the option count crosses `searchThreshold`,
 *  - filters pills by label (case-insensitive),
 *  - caps how many render at once with a "+N more — refine" hint,
 *  - applies consistent styling + a11y (role/selected/label) on every pill.
 *
 * It is the shared replacement for the per-page `pickerRow`/`pickerChip` walls
 * so every page's pickers look and behave the same.
 */
export function SearchablePills({
  options,
  value,
  onChange,
  searchThreshold = 12,
  cap = 60,
  placeholder = 'Filter',
  emptyText = 'No options.',
  ariaLabel,
}: {
  options: PillOption[];
  value: string;
  onChange: (value: string) => void;
  /** Show the filter box only once there are more than this many options. */
  searchThreshold?: number;
  /** Max pills rendered at once; the rest collapse behind the refine hint. */
  cap?: number;
  placeholder?: string;
  emptyText?: string;
  ariaLabel?: (o: PillOption) => string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => o.label.toLowerCase().includes(q))
    : options;
  const capped = filtered.slice(0, cap);
  // Keep the CURRENT selection on screen even when the filter (or the cap)
  // hides it — otherwise a no-match search left a page acting on a choice
  // the user can no longer see (e.g. A/B compare's "Run both").
  const selectedOpt = options.find(o => o.value === value);
  const shown =
    selectedOpt && !capped.includes(selectedOpt) ? [selectedOpt, ...capped] : capped;
  const overflow = filtered.length - capped.length;
  const showSearch = options.length > searchThreshold;

  return (
    <View style={{ gap: 6 }}>
      {showSearch && (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`${placeholder} (${options.length})…`}
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.search}
        />
      )}
      <View style={styles.row}>
        {shown.map(o => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={ariaLabel ? ariaLabel(o) : o.label}
              style={[styles.pill, selected && styles.pillSelected]}>
              <Text
                style={[styles.pillText, selected && styles.pillTextSelected]}
                numberOfLines={1}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
        {options.length === 0 && <Text style={styles.dim}>{emptyText}</Text>}
        {q !== '' && filtered.length === 0 && options.length > 0 && (
          <Text style={styles.dim}>No match for "{query.trim()}".</Text>
        )}
      </View>
      {overflow > 0 && (
        <Text style={styles.dim}>
          +{overflow} more — refine the filter to narrow.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#ffffff',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    maxWidth: 280,
  },
  pillSelected: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  pillText: { fontSize: 11, color: '#374151' },
  pillTextSelected: { color: '#ffffff', fontWeight: '600' },
  dim: { fontSize: 11, color: '#9ca3af', fontStyle: 'italic' },
});
