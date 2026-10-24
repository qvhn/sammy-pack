import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * Common page chrome: header (title + subtitle), scrollable body.
 * Use for stub pages and any other section that doesn't need
 * custom layout outside the scroll.
 */
export function Page({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {badge && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
      <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView>
    </View>
  );
}

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={cardStyles.card}>
      {(title || subtitle || right) && (
        <View style={cardStyles.headerRow}>
          <View style={cardStyles.headerLeft}>
            {title && <Text style={cardStyles.title}>{title}</Text>}
            {subtitle && <Text style={cardStyles.subtitle}>{subtitle}</Text>}
          </View>
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={cardStyles.sectionTitle}>{children}</Text>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <Text style={cardStyles.hint}>{children}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  body: { padding: 24, paddingTop: 8, gap: 12 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  badgeText: { fontSize: 10, color: '#92400e', fontWeight: '700' },
});

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    // react-native-web gives every View its own stacking context, and the
    // body is painted after the header — so a popover opened from the
    // header's `right` slot (Fork / Compare) rendered BEHIND the body and
    // couldn't be clicked. Raise the header above its siblings.
    zIndex: 10,
  },
  headerLeft: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: '#111827' },
  subtitle: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  hint: { fontSize: 12, color: '#6b7280', lineHeight: 18 },
});
