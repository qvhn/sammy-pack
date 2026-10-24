import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { listRuns } from './api';
import { useRuns } from './store/runs';
import { getActiveWorkspace } from './store/workspace';
import { BRAND_ICON_URI } from './brandIcon';

/** Poll the run list for a count of runs paused at a human gate — drives
 *  the Approvals badge. Deliberately lightweight: one GET every 8s,
 *  skipped while the tab is hidden. Failures are swallowed (the badge
 *  just shows 0 / stale rather than throwing in the nav). */
function usePausedRunCount(): number {
  const [count, setCount] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      try {
        const runs = await listRuns<{ status?: string }>();
        if (!alive.current) return;
        setCount(runs.filter(r => r.status === 'paused').length);
      } catch {
        /* keep last known count */
      }
    };
    void tick();
    const g = globalThis as unknown as {
      setInterval: (fn: () => void, ms: number) => number;
      clearInterval: (h: number) => void;
      document?: { hidden?: boolean };
    };
    const h = g.setInterval(() => {
      if (g.document?.hidden) return;
      void tick();
    }, 8000);
    return () => {
      alive.current = false;
      g.clearInterval(h);
    };
  }, []);
  return count;
}

export type PageId =
  | 'pipelines'
  | 'agents'
  | 'playground'
  | 'datasets'
  | 'evals'
  | 'schemas'
  | 'runs'
  | 'approvals'
  | 'queue'
  | 'notifications'
  | 'deliveries'
  | 'observability'
  | 'cost'
  | 'ab-compare'
  | 'connections'
  | 'workspaces'
  | 'triggers'
  | 'settings';

type Section = { id: PageId; label: string; hint?: string };
type Group = { title: string; sections: Section[] };

const GROUPS: Group[] = [
  {
    title: 'Build',
    sections: [
      { id: 'pipelines', label: 'Pipelines', hint: 'orchestration editor' },
      { id: 'agents', label: 'Agents', hint: 'agent definitions' },
      { id: 'playground', label: 'Playground', hint: 'try an agent solo' },
      { id: 'datasets', label: 'Datasets', hint: 'inputs to test against' },
      { id: 'evals', label: 'Evals', hint: 'score runs against criteria' },
      { id: 'schemas', label: 'Schemas', hint: 'JSON shapes things conform to' },
    ],
  },
  {
    title: 'Observe',
    sections: [
      { id: 'runs', label: 'Runs', hint: 'history + live traces' },
      {
        id: 'approvals',
        label: 'Approvals',
        hint: 'paused runs awaiting a human gate',
      },
      { id: 'queue', label: 'Queue', hint: 'waiting on the concurrency cap' },
      {
        id: 'notifications',
        label: 'Notifications',
        hint: 'run outcomes + recovery',
      },
      { id: 'deliveries', label: 'Deliveries', hint: 'trigger queue + dead-letter' },
      {
        id: 'observability',
        label: 'Observability',
        hint: 'aggregate analytics + trends',
      },
      { id: 'cost', label: 'Token & Cost', hint: 'spend per run + per agent' },
      { id: 'ab-compare', label: 'A/B compare', hint: 'two runs, same input' },
    ],
  },
  {
    title: 'Configure',
    sections: [
      { id: 'connections', label: 'Connections', hint: 'GitHub, Jira, ...' },
      { id: 'workspaces', label: 'Workspaces', hint: 'context pointers' },
      { id: 'triggers', label: 'Triggers', hint: 'webhooks + crons' },
      { id: 'settings', label: 'Settings', hint: 'API keys, models' },
    ],
  },
];

export function Sidebar({
  active,
  onChange,
}: {
  active: PageId;
  onChange: (id: PageId) => void;
}) {
  const runs = useRuns();
  const isRunning = !!runs.active;
  const attentionCount = runs.attentionCount;
  const pausedCount = usePausedRunCount();
  return (
    <View style={styles.sidebar}>
      <View style={styles.brand}>
        <Image
          source={{ uri: BRAND_ICON_URI }}
          style={styles.brandIcon}
          accessibilityLabel="sammy-pack"
        />
        <Text style={styles.brandName}>sammy-pack</Text>
        <Text style={styles.brandTag}>v0.1</Text>
      </View>
      <ScrollView style={styles.scroll}>
        {GROUPS.map(group => (
          <View key={group.title} style={styles.group}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            {group.sections.map(s => {
              const showLiveDot = s.id === 'runs' && isRunning;
              const badgeCount =
                s.id === 'notifications' && attentionCount > 0
                  ? attentionCount
                  : s.id === 'approvals' && pausedCount > 0
                    ? pausedCount
                    : 0;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => onChange(s.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active === s.id }}
                  accessibilityLabel={s.label}
                  style={[styles.item, active === s.id && styles.itemActive]}>
                  <View style={styles.itemRow}>
                    <Text
                      style={[
                        styles.itemLabel,
                        active === s.id && styles.itemLabelActive,
                      ]}>
                      {s.label}
                    </Text>
                    {showLiveDot && <View style={styles.liveDot} />}
                    {badgeCount > 0 && (
                      <View style={styles.countBadge}>
                        <Text style={styles.countBadgeText}>
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </Text>
                      </View>
                    )}
                  </View>
                  {s.hint && (
                    <Text
                      style={[
                        styles.itemHint,
                        active === s.id && styles.itemHintActive,
                      ]}>
                      {showLiveDot
                        ? `running · ${runs.active?.orchestrationName ?? ''}`
                        : badgeCount > 0
                        ? s.id === 'approvals'
                          ? `${badgeCount} awaiting approval`
                          : `${badgeCount} need attention`
                        : s.hint}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <View style={styles.footer}>
        <WorkspaceFooter />
      </View>
    </View>
  );
}

function WorkspaceFooter() {
  const ws = getActiveWorkspace();
  if (!ws) {
    return <Text style={styles.footerText}>dev workspace (local)</Text>;
  }
  return (
    <View>
      <Text style={styles.footerLabel}>workspace</Text>
      <Text style={styles.footerActive}>{ws.name}</Text>
      <Text style={styles.footerRepo}>
        {ws.connection} · {ws.repo}
        {ws.ref ? `@${ws.ref}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: 220,
    backgroundColor: '#111827',
    borderRightWidth: 1,
    borderRightColor: '#1f2937',
    // Web: the shell only has a MIN height, so without a cap the sidebar
    // grew to fit every item and the nav ScrollView never scrolled — the
    // last items (Settings) slid under the footer on a ~900px window. Pin
    // the sidebar to the viewport (sticky, in case the document itself
    // scrolls) so the nav list scrolls above the fixed footer.
    ...(Platform.OS === 'web'
      ? ({
          height: '100vh',
          maxHeight: '100vh',
          position: 'sticky',
          top: 0,
        } as unknown as object)
      : null),
  },
  brand: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandIcon: {
    width: 32,
    height: 32,
  },
  brandName: {
    color: '#f9fafb',
    fontWeight: '700',
    fontSize: 16,
  },
  brandTag: {
    color: '#6b7280',
    fontSize: 10,
  },
  scroll: {
    flex: 1,
    // Let the list shrink below its content height so it scrolls instead
    // of pushing the footer off-screen.
    minHeight: 0,
  },
  group: {
    marginTop: 12,
  },
  groupTitle: {
    paddingHorizontal: 16,
    paddingBottom: 4,
    color: '#6b7280',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
    // The pulsing animation lives in CSS for the web build; on native
    // it just shows as a steady green dot which still does the job.
  },
  countBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  itemActive: {
    backgroundColor: '#1f2937',
    borderLeftWidth: 2,
    borderLeftColor: '#3b82f6',
    paddingLeft: 14,
  },
  itemLabel: {
    color: '#d1d5db',
    fontSize: 13,
    fontWeight: '500',
  },
  itemLabelActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  itemHint: {
    color: '#6b7280',
    fontSize: 10,
    marginTop: 1,
  },
  itemHintActive: {
    color: '#9ca3af',
  },
  footer: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#1f2937',
  },
  footerText: {
    color: '#6b7280',
    fontSize: 10,
    textAlign: 'center',
  },
  footerLabel: {
    color: '#6b7280',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  footerActive: {
    color: '#ecfdf5',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  footerRepo: {
    color: '#9ca3af',
    fontSize: 10,
    fontFamily: 'Menlo',
    marginTop: 1,
  },
});
