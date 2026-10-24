import { StyleSheet, Text, View } from 'react-native';
import type { GraphEditorProps } from './GraphEditorProps';

/**
 * Native fallback. The web Graph editor uses @xyflow/react which is DOM-only.
 * On iOS / Android we just point users at the Pipeline view.
 */
export function GraphEditor(_props: GraphEditorProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Graph view is web-only</Text>
      <Text style={styles.body}>
        The drag-and-drop graph editor uses a DOM-based library and isn't available on iOS or
        Android yet. Use Pipeline view here, or open this orchestration in the web app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  title: { fontSize: 16, fontWeight: '700', color: '#374151' },
  body: { fontSize: 12, color: '#6b7280', textAlign: 'center', lineHeight: 18 },
});
