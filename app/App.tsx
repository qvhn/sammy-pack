import { useCallback, useEffect, useState } from 'react';
import { StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from './src/safe-area';
import { CommandPalette } from './src/CommandPalette';
import { Sidebar, type PageId } from './src/Sidebar';
import { AgentsPage } from './src/pages/AgentsPage';
import { ConnectionsPage } from './src/pages/ConnectionsPage';
import { DatasetsPage } from './src/pages/DatasetsPage';
import { EvalsPage } from './src/pages/EvalsPage';
import { NotificationsPage } from './src/pages/NotificationsPage';
import { ObservabilityPage } from './src/pages/ObservabilityPage';
import { CostPage } from './src/pages/CostPage';
import { PipelinesPage } from './src/pages/PipelinesPage';
import { PlaygroundPage } from './src/pages/PlaygroundPage';
import { RunsPage } from './src/pages/RunsPage';
import { ApprovalsPage } from './src/pages/ApprovalsPage';
import { QueuePage } from './src/pages/QueuePage';
import { DeliveriesPage } from './src/pages/DeliveriesPage';
import { SchemasPage } from './src/pages/SchemasPage';
import { SettingsPage } from './src/pages/SettingsPage';
import { ABComparePage } from './src/pages/ABComparePage';
import { TriggersPage } from './src/pages/TriggersPage';
import { WorkspacesPage } from './src/pages/WorkspacesPage';
import { RunsProvider } from './src/store/runs';
import { requestRun } from './src/store/runSelection';
import { ToastProvider } from './src/store/toast';
import { ImproveJobsProvider } from './src/store/improveJobs';
import {
  currentRoute,
  navigateTo,
  onRouteChange,
  rememberedPipeline,
} from './src/lib/hashRoute';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <ToastProvider>
        {/* ImproveJobsProvider is inside ToastProvider so a completed
            "Improve" job can pop a click-to-open toast. It's mounted at the
            app root (above the page router) so a background improve job
            survives in-app navigation + the Improve modal closing. */}
        <ImproveJobsProvider>
          <RunsProvider>
            <AppContent />
          </RunsProvider>
        </ImproveJobsProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  // The page lives in the URL hash (see src/lib/hashRoute.ts) so a reload
  // lands where the user was and Back/Forward move between pages. State
  // mirrors the hash; on native (no location) it's the only source.
  const [page, setPage] = useState<PageId>(() => currentRoute().page);
  useEffect(() => onRouteChange(route => setPage(route.page)), []);
  const navigate = useCallback((next: PageId) => {
    // Returning to Pipelines restores the pipeline that was selected there.
    const pipeline =
      next === 'pipelines' ? rememberedPipeline() ?? undefined : undefined;
    navigateTo({ page: next, pipeline });
    setPage(next);
  }, []);

  return (
    <View style={[styles.shell, { paddingTop: insets.top }]}>
      <Sidebar active={page} onChange={navigate} />
      <View style={styles.main}>{renderPage(page, navigate)}</View>
      <CommandPalette onNavigate={navigate} />
    </View>
  );
}

function renderPage(page: PageId, navigate: (page: PageId) => void) {
  switch (page) {
    case 'pipelines':
      return <PipelinesPage onNavigate={navigate} />;
    case 'agents':
      return <AgentsPage />;
    case 'playground':
      return <PlaygroundPage />;
    case 'datasets':
      return <DatasetsPage />;
    case 'evals':
      return <EvalsPage />;
    case 'schemas':
      return <SchemasPage />;
    case 'runs':
      return <RunsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'queue':
      return <QueuePage />;
    case 'notifications':
      return <NotificationsPage onNavigate={navigate} />;
    case 'deliveries':
      return (
        <DeliveriesPage
          onOpenRun={runId => {
            requestRun(runId);
            navigate('runs');
          }}
        />
      );
    case 'observability':
      return <ObservabilityPage />;
    case 'cost':
      return <CostPage />;
    case 'ab-compare':
      return <ABComparePage />;
    case 'connections':
      return <ConnectionsPage />;
    case 'workspaces':
      return <WorkspacesPage />;
    case 'triggers':
      return <TriggersPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#f9fafb',
    minHeight: '100%' as unknown as number,
  },
  main: {
    flex: 1,
  },
});

export default App;
