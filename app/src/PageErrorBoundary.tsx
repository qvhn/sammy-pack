import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Catches a render error in one page so it doesn't blank the whole app:
 * the sidebar stays, the page shows what broke, and "Try again" re-renders
 * it. Keyed by page in App.tsx, so navigating away also clears it.
 */
export class PageErrorBoundary extends Component<
  { page: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.page}] page crashed:`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.wrap} accessibilityRole="alert">
        <Text style={styles.title}>This page hit an error</Text>
        <Text style={styles.message}>{error.message || String(error)}</Text>
        <Text style={styles.hint}>
          The rest of the app still works — pick another page, or try this one again.
        </Text>
        <Pressable
          onPress={() => this.setState({ error: null })}
          accessibilityRole="button"
          style={styles.button}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { padding: 24, gap: 8, maxWidth: 720 },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  message: { fontSize: 13, color: '#b91c1c', fontFamily: 'monospace' },
  hint: { fontSize: 13, color: '#6b7280' },
  button: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: '#111827',
  },
  buttonText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
});
