import { Pressable, StyleSheet, Text, View } from 'react-native';
import { followLabel, HARNESS_FOLLOWS } from './llm/harness';
import { FOLLOW_HELP } from './store/harness';
import type { HarnessFollow, Node } from './types';

/**
 * How the orchestration runs by default, shown beside the triggers in every
 * editor view. Writes the top-level `execution` (absent = pipeline) and, for a
 * harness, `harness.follow` (absent = the workspace default from Settings).
 * The Run dialog still lets a single run choose differently.
 */
export function RunsAsHead({ orchestration, onChange }: { orchestration: Node; onChange: (next: Node) => void }) {
  const harness = orchestration.execution === 'harness';
  const follow = orchestration.harness?.follow ?? null;

  function setHarness(on: boolean) {
    if (on === harness) return;
    const next = { ...orchestration };
    if (on) next.execution = 'harness';
    else delete next.execution;
    onChange(next);
  }

  function setFollow(f: HarnessFollow | null) {
    const cfg = { ...orchestration.harness };
    if (f) cfg.follow = f;
    else delete cfg.follow;
    const next = { ...orchestration };
    if (Object.keys(cfg).length) next.harness = cfg;
    else delete next.harness;
    onChange(next);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.head}>⚙ Runs as</Text>
        <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Runs as">
          {([false, true] as const).map(on => (
            <Pressable
              key={String(on)}
              onPress={() => setHarness(on)}
              style={[styles.chip, harness === on && styles.chipOn]}
              accessibilityRole="radio"
              accessibilityState={{ checked: harness === on }}
              accessibilityLabel={on ? 'Harness' : 'Pipeline'}>
              <Text style={[styles.chipText, harness === on && styles.chipTextOn]}>
                {harness === on ? '◉' : '○'} {on ? 'Harness' : 'Pipeline'}
              </Text>
            </Pressable>
          ))}
        </View>
        {harness && (
          <>
            <Text style={styles.sep}>·</Text>
            <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="How strictly">
              {([null, ...HARNESS_FOLLOWS] as const).map(f => {
                const on = follow === f;
                const label = f ? followLabel(f) : 'Settings default';
                return (
                  <Pressable
                    key={f ?? 'default'}
                    onPress={() => setFollow(f)}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={label}>
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}
      </View>
      <Text style={styles.hint}>
        {harness
          ? `One agent follows the steps and does each itself. ${
              follow ? FOLLOW_HELP[follow] : 'Strictness comes from Settings → Harness runs (strict unless changed there).'
            }`
          : 'Each agent step gets its own agent; the engine walks the steps.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  head: { fontSize: 12, fontWeight: '700', color: '#7c3aed', marginRight: 2 },
  sep: { fontSize: 12, color: '#9ca3af' },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  chipOn: { borderColor: '#7c3aed', backgroundColor: '#ede9fe' },
  chipText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  chipTextOn: { color: '#5b21b6' },
  hint: { fontSize: 11, color: '#6b7280' },
});
