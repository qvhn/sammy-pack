import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  checkMcpServerStatus,
  getAgentSlots,
  importAgentContents,
  importAgents,
  listHooks,
  listMcpServers,
  saveHooks,
  saveMcpServers,
  scanAgentSources,
  setAgentSlots,
  type AgentSlots,
  type HookSpec,
  type McpServerConfig,
  type McpServerStatus,
  type ScannedAgent,
} from '../api';
import {
  deriveAgentName,
  shouldSkipAgentDir,
  shouldSkipAgentFile,
} from '../lib/agentName';
import {
  DEFAULT_MODEL,
  getAllowAgentTools,
  getAuthMode,
  getModel,
  setAllowAgentTools,
  setAuthMode,
  setModel,
  type AuthMode,
} from '../store/apiKey';
import { getBudgetConfig, saveBudgetConfig, type BudgetConfig } from '../store/budget';
import { TOKEN_KEY, USER_KEY } from '../../web/api-auth';
import { Card, Hint, Page } from './Page';
import { navigateTo } from '../lib/hashRoute';

// Linking the Connections page from text. RN-Web renders <a> via
// Pressable+Text; we use a tiny ConnectionsLink component to keep
// the wording consistent everywhere Settings sends users over.
function ConnectionsLink({ label }: { label: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => {
        // Routes through the app's hash router (App listens for
        // hashchange). On native there's no location — a no-op.
        try {
          navigateTo({ page: 'connections' });
        } catch {
          /* native — no-op */
        }
      }}>
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  );
}

/**
 * A persistent collapsible Settings section. The page is long (provider,
 * tools, sources, caps, MCP, hooks, identity, backup, app), so each section
 * collapses to a header — common ones open by default, advanced ones closed.
 */
function CollapsibleSection({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const storageKey = `sammy.settings.section.${title}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {
      /* localStorage unavailable */
    }
    return defaultOpen;
  });
  function toggle() {
    setOpen(prev => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  return (
    <View style={styles.settingsSection}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={styles.settingsSectionHeader}>
        <Text style={styles.settingsSectionChevron}>{open ? '▾' : '▸'}</Text>
        <Text style={styles.settingsSectionTitle}>{title}</Text>
        {hint && !open ? (
          <Text style={styles.settingsSectionHint} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </Pressable>
      {open ? <View style={styles.settingsSectionBody}>{children}</View> : null}
    </View>
  );
}

export function SettingsPage() {
  const [model, setModelLocal] = useState(DEFAULT_MODEL);
  const [authMode, setAuthModeLocal] = useState<AuthMode>('direct-api-key');
  const [allowTools, setAllowToolsLocal] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setModelLocal(getModel());
    setAuthModeLocal(getAuthMode());
    setAllowToolsLocal(getAllowAgentTools());
  }, []);

  function save() {
    setModel(model);
    setAuthMode(authMode);
    setAllowAgentTools(allowTools);
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2000);
  }

  return (
    <Page title="Settings" subtitle="Run defaults and app prefs (manage secrets in Connections)">
      <CollapsibleSection title="LLM Provider" defaultOpen>
      <Card
        title="Anthropic"
        subtitle="Routing + default model. API keys live in Connections.">
        <View style={styles.field}>
          <Text style={styles.label}>Auth mode</Text>
          <View style={styles.authRow}>
            <Pressable
              onPress={() => setAuthModeLocal('direct-api-key')}
              style={[
                styles.authOption,
                authMode === 'direct-api-key' && styles.authOptionActive,
              ]}>
              <Text
                style={[
                  styles.authOptionText,
                  authMode === 'direct-api-key' && styles.authOptionTextActive,
                ]}>
                Direct API key
              </Text>
              <Text style={styles.authOptionSub}>
                Browser → api.anthropic.com with your sk-ant-… key. Calls billed
                per-token.
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setAuthModeLocal('claude-code-proxy')}
              style={[
                styles.authOption,
                authMode === 'claude-code-proxy' && styles.authOptionActive,
              ]}>
              <Text
                style={[
                  styles.authOptionText,
                  authMode === 'claude-code-proxy' && styles.authOptionTextActive,
                ]}>
                Claude Code login
              </Text>
              <Text style={styles.authOptionSub}>
                Browser → dev-server proxy using your `claude` CLI login. No API
                key needed. Calls draw from your Claude plan SDK credit pool.
              </Text>
            </Pressable>
          </View>
          {authMode === 'claude-code-proxy' && (
            <Hint>
              Make sure you're logged into Claude Code (`claude` in a terminal).
              The dev server has to be running for this mode to work; it won't
              function in production-built static hosting.
            </Hint>
          )}
          {authMode === 'direct-api-key' && (
            <Hint>
              Manage your Anthropic API key in{' '}
              <ConnectionsLink label="Connections" />. Add an entry of kind
              "Anthropic API key" (or name it <Text style={styles.code}>anthropic</Text>{' '}
              — the resolver looks it up by canonical name).
            </Hint>
          )}
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Default model</Text>
          <TextInput
            value={model}
            onChangeText={setModelLocal}
            placeholder={DEFAULT_MODEL}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Hint>e.g. claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001</Hint>
        </View>
        <View style={styles.buttonRow}>
          <Pressable
            onPress={save}
            accessibilityRole="button"
            accessibilityLabel="Save LLM provider settings"
            style={styles.saveButton}>
            <Text style={styles.saveButtonText}>Save</Text>
          </Pressable>
          {savedAt && <Text style={styles.savedNote}>Saved.</Text>}
        </View>
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Agent tools (advanced)" hint="Let agents run shell / file tools">
      <Card
        title="Allow agents to use tools"
        subtitle="When ON, an agent that declares `tools: ['Bash']` (or Read / Write / Edit / Glob / Grep / WebFetch) in its orchestration node gets those tools exposed to the LLM via the Claude Code proxy. The agent can then drive simulators (idb), run mvn / jest / xcrun, edit files, etc. — actually executing work instead of just describing it.">
        <Pressable
          onPress={() => {
            // Auto-save on toggle — flip = persisted. The Save button at
            // the top of this page only saves the API-key / model fields;
            // baking that into the same Save flow caused users to flip
            // this toggle, never realize they had to click Save above,
            // and then see "missing tools" warnings at run time.
            const next = !allowTools;
            setAllowToolsLocal(next);
            setAllowAgentTools(next);
          }}
          style={styles.checkRow}>
          <View style={[styles.checkbox, allowTools && styles.checkboxOn]} />
          <Text style={styles.checkLabel}>
            Expose declared tools to agents at run time
            {' '}
            <Text style={styles.autoSavedHint}>(auto-saved)</Text>
          </Text>
        </Pressable>
        <Hint>
          ⚠ This lets agents run **shell commands and file edits on your
          machine** — only enable if you trust the agents you're invoking.
          Requires Claude Code login mode (above) — direct-API mode can't
          execute server-side tools and silently ignores this setting.
        </Hint>
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Agent sources" hint="Import agents from a folder">
      <Card
        title="Import agents from a folder"
        subtitle="Point at any folder of .md agent files. Sammy-pack scans + symlinks the ones you pick into your local agents/ dir, so orchestrations can reference them as agents/<name>.md. Symlinks read live — edits in the source folder propagate.">
        <AgentSourcesPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Orchestration sources" hint="Import orchestrations from a path">
      <Card
        title="Import orchestrations from a path"
        subtitle="Point at an orchestration .json or a folder of them (e.g. another repo's orchestrations/). Sammy-pack symlinks each into your local examples/ so it shows up in Pipelines — symlinks read live, edits in the source propagate, and imports stay out of git. The execution-side parallel to Agent sources.">
        <OrchestrationSourcesPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Cost guardrails" defaultOpen>
      <Card
        title="Spend caps"
        subtitle="Per-day + per-month USD limits, enforced server-side against the durable run store. The Run button warns at 80%; at 100% the server refuses new runs."
        >
        <BudgetPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Concurrency" hint="cap simultaneous agent runs">
      <Card
        title="Max concurrent agents"
        subtitle="Process-wide ceiling on how many agent subprocesses run at once across ALL runs. A wide parallel/map fan-out or a cron burst queues here (FIFO) instead of stampeding the machine. Default from SAMMY_MAX_CONCURRENT_AGENTS (else CPU-derived); changes here apply live, but reset to the env default on server restart.">
        <AgentConcurrencyPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="MCP servers" hint="jira / github / postgres / slack — by name">
      <Card
        title="MCP server registry"
        subtitle="Configure MCP servers (jira, github, postgres, slack, anything). Orchestration nodes reference these by name with `mcp: ['github']`, and the proxy passes the full config — secrets and all — to the SDK. Configs never leave your machine.">
        <McpServerPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Hooks" hint="Shell-command lifecycle hooks">
      <Card
        title="Shell-command hooks"
        subtitle="Run a shell command before/after every tool call, or on other agent lifecycle events. Mirrors the CLI's settings.json hooks. Orchestration nodes reference hooks by name with `hooks: ['audit-log']`.">
        <HooksPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="User identity" hint="X-Sammy-User header + API bearer token">
      <Card
        title="User id (multi-tenancy seam) + API token"
        subtitle="The user id is sent as `X-Sammy-User` on every /api request. Scopes the Runs list, observability digest, and any new run you start to this user. Leave blank for the single-tenant default ('system'). The API token is sent as `Authorization: Bearer` — required when the server runs with SAMMY_API_TOKEN set (and for reads too under SAMMY_REQUIRE_AUTH_READS=1). A real per-user auth layer (JWT) plugs in here without changing call sites.">
        <UserIdentityPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="Backup (prefs only)" hint="Export / import preferences">
      <Card
        title="Export / import preferences"
        subtitle="Round-trip sammy.* localStorage entries (theme, default model, MCP/hooks/budget caps, workspace, user id). For credentials, use Connections → Export / Import all.">
        <BackupPanel />
      </Card>
      </CollapsibleSection>

      <CollapsibleSection title="App" defaultOpen>
      <Card title="Theme">
        <Hint>Light / dark / system. Defaults to system.</Hint>
      </Card>
      <Card title="Workspace root">
        <Hint>
          When running locally via the Vite dev middleware, the repo root is auto-detected.
          For production web + native, you'll pick a workspace via the Connections + Workspaces
          configuration.
        </Hint>
      </Card>
      </CollapsibleSection>
    </Page>
  );
}

function BackupPanel() {
  const [status, setStatus] = useState<'idle' | 'imported' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number>(0);

  function refreshCount() {
    const g = globalThis as unknown as {
      localStorage?: { length: number; key(i: number): string | null };
    };
    const ls = g.localStorage;
    if (!ls) {
      setCount(0);
      return;
    }
    let n = 0;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('sammy.')) n++;
    }
    setCount(n);
  }

  useEffect(() => {
    refreshCount();
  }, []);

  // Backup is now scope-limited: it round-trips localStorage prefs
  // ONLY. The credentials registry has its own Export all / Import
  // all on the Connections page — same area (credentials state),
  // different purpose (bulk machine snapshot vs per-entry edit). This
  // file stays focused on prefs so the two surfaces don't blur.
  //
  // Import still accepts the older v2 wrapped shape that briefly
  // bundled credentials, but the credentials half is intentionally
  // dropped on import — the user is expected to re-import them via
  // the Connections page so the destructive overwrite happens behind
  // its confirm prompt.
  type BackupV2_Legacy = {
    schema: 'sammy-backup/v2';
    exportedAt: string;
    localStorage: Record<string, string>;
    credentials?: Record<string, unknown>;
  };

  function exportSettings() {
    const g = globalThis as unknown as {
      localStorage?: {
        length: number;
        key(i: number): string | null;
        getItem(k: string): string | null;
      };
      URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
      Blob?: new (parts: string[], opts?: { type: string }) => unknown;
      document?: {
        createElement(t: string): { href: string; download: string; click(): void };
      };
      setTimeout?: (fn: () => void, ms: number) => void;
    };
    const ls = g.localStorage;
    if (!ls || !g.URL || !g.Blob || !g.document) return;
    const dump: Record<string, string> = {};
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith('sammy.')) continue;
      const v = ls.getItem(k);
      if (v != null) dump[k] = v;
    }
    const blob = new g.Blob([JSON.stringify(dump, null, 2)], {
      type: 'application/json',
    });
    const url = g.URL.createObjectURL(blob);
    const a = g.document.createElement('a');
    a.href = url;
    a.download = `sammy-prefs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    g.setTimeout?.(() => g.URL!.revokeObjectURL(url), 1000);
  }

  function importSettings() {
    const g = globalThis as unknown as {
      document?: {
        createElement(t: string): {
          type: string;
          accept: string;
          onchange: ((e: unknown) => void) | null;
          click(): void;
        };
      };
      localStorage?: { setItem(k: string, v: string): void };
    };
    if (!g.document || !g.localStorage) return;
    const input = g.document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async ev => {
      const filesUnknown = (ev as { target?: { files?: unknown } } | undefined)
        ?.target?.files as { 0?: { text(): Promise<string> } } | null | undefined;
      const file = filesUnknown?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setStatus('error');
          setError('Backup file must be a JSON object');
          return;
        }
        // Accept v1 flat shape OR the brief v2 wrapped shape (credentials
        // half is dropped intentionally — see comment above).
        let localStorageDump: Record<string, string>;
        let droppedCredentials = false;
        if (parsed.schema === 'sammy-backup/v2') {
          const v2 = parsed as unknown as BackupV2_Legacy;
          localStorageDump = v2.localStorage ?? {};
          droppedCredentials =
            !!v2.credentials && Object.keys(v2.credentials).length > 0;
        } else {
          localStorageDump = parsed as Record<string, string>;
        }
        let n = 0;
        for (const [k, v] of Object.entries(localStorageDump)) {
          if (!k.startsWith('sammy.') || typeof v !== 'string') continue;
          g.localStorage!.setItem(k, v);
          n++;
        }
        setStatus('imported');
        setError(
          droppedCredentials
            ? 'localStorage restored. Credentials section was skipped — re-import them from the Connections page.'
            : null,
        );
        setCount(n);
        setTimeout(() => setStatus('idle'), 4000);
      } catch (err) {
        setStatus('error');
        setError((err as Error).message);
      }
    };
    input.click();
  }

  return (
    <View style={{ gap: 8 }}>
      <Hint>
        <Text style={{ fontWeight: '700' }}>Prefs only.</Text> Round-trips
        the <Text style={{ fontWeight: '700' }}>{count}</Text> sammy.*
        localStorage entries (theme, default model, MCP/hooks/budget caps,
        active workspace, user id, etc.). For credentials (API keys,
        connection tokens), use{' '}
        <ConnectionsLink label="Connections → Export / Import all" />
        {' '}— different state, different purpose.
      </Hint>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={exportSettings} style={styles.saveButton}>
          <Text style={styles.saveButtonText}>↓ Export JSON</Text>
        </Pressable>
        <Pressable
          onPress={importSettings}
          style={[styles.saveButton, { backgroundColor: '#f3f4f6' }]}>
          <Text style={[styles.saveButtonText, { color: '#374151' }]}>
            ↑ Import JSON
          </Text>
        </Pressable>
        {status === 'imported' && (
          <Text style={styles.savedNote}>Imported {count} keys.</Text>
        )}
        {status === 'error' && error && (
          <Text style={{ color: '#b91c1c', fontSize: 11, flex: 1 }}>{error}</Text>
        )}
      </View>
      <Hint>
        Import OVERWRITES localStorage entries with matching keys. Reload to
        pick up new prefs. Older v2 backups that bundled credentials still
        import — but the credentials half is intentionally skipped here so
        the destructive overwrite happens behind Connections' confirm
        prompt.
      </Hint>
    </View>
  );
}

function OrchestrationSourcesPanel() {
  const [srcPath, setSrcPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function doImport() {
    const from = srcPath.trim();
    if (!from) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/orchestrations/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        imported?: string[];
        copied?: string[];
        skipped?: Array<{ as: string; reason: string }>;
        error?: string;
      };
      if (!res.ok) {
        setResult(`Error: ${data.error ?? res.status}`);
        return;
      }
      const imported = data.imported ?? [];
      const copied = data.copied ?? [];
      const skipped = data.skipped ?? [];
      const parts: string[] = [];
      if (imported.length > 0)
        parts.push(`Imported ${imported.length}: ${imported.join(', ')}`);
      if (copied.length > 0)
        parts.push(
          `${copied.length} copied instead of linked (Windows) — source edits won't propagate; re-import to refresh`,
        );
      if (skipped.length > 0)
        parts.push(
          `Skipped ${skipped.length}: ` +
            skipped.map(s => `${s.as} (${s.reason})`).join('; '),
        );
      setResult(parts.join('. ') || 'Nothing to import.');
    } catch (err) {
      setResult(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>
          Absolute path — an orchestration .json or a folder of them
        </Text>
        <TextInput
          value={srcPath}
          onChangeText={setSrcPath}
          placeholder="/Users/you/git/your-orchestrations"
          autoCapitalize="none"
          style={styles.input}
        />
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          onPress={doImport}
          disabled={busy || !srcPath.trim()}
          style={styles.saveButton}>
          <Text style={styles.saveButtonText}>
            {busy ? 'Importing…' : 'Import'}
          </Text>
        </Pressable>
      </View>
      {result ? <Hint>{result}</Hint> : null}
    </View>
  );
}

function UserIdentityPanel() {
  const [userId, setUserId] = useState('');
  // The token is write-only here: the field starts blank even when one is
  // stored (echoing a secret back defeats the point of masking it), and a
  // blank field on Save leaves the stored token alone — only the explicit
  // Clear removes it. Without this field nothing in the shipped UI ever
  // wrote `sammy.apiToken`, so the gated-reads posture needed DevTools.
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      const stored = localStorage.getItem(USER_KEY);
      if (stored) setUserId(stored);
      setHasToken(!!localStorage.getItem(TOKEN_KEY));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  function save() {
    try {
      if (typeof localStorage !== 'undefined') {
        const trimmed = userId.trim();
        if (trimmed) localStorage.setItem(USER_KEY, trimmed);
        else localStorage.removeItem(USER_KEY);
        const nextToken = token.trim();
        if (nextToken) {
          localStorage.setItem(TOKEN_KEY, nextToken);
          setHasToken(true);
          setToken('');
        }
      }
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 1500);
    } catch {
      /* keep form value so the user can retry */
    }
  }

  function clearToken() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY);
      setHasToken(false);
      setToken('');
    } catch {
      /* localStorage unavailable — nothing stored to clear */
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>User id</Text>
        <TextInput
          value={userId}
          onChangeText={setUserId}
          placeholder="alice (leave blank for the single-tenant default)"
          accessibilityLabel="User id"
          style={styles.input}
        />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.label}>API token</Text>
        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder={
            hasToken
              ? 'A token is stored — type a new one to replace it'
              : 'The server’s SAMMY_API_TOKEN (leave blank when it has none)'
          }
          accessibilityLabel="API token"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          onPress={save}
          accessibilityRole="button"
          accessibilityLabel="Save identity"
          style={styles.saveButton}>
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
        {hasToken && (
          <Pressable
            onPress={clearToken}
            accessibilityLabel="Clear API token"
            style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Clear token</Text>
          </Pressable>
        )}
        {savedAt && <Text style={styles.savedNote}>Saved.</Text>}
      </View>
      <Hint>
        Takes effect immediately — the global fetch wrapper reads both on
        every request, and the run event stream carries the same two values.
        Anything scoped to a user (Runs list, observability digest, new runs
        you start) sends the `X-Sammy-User` header; leave the id blank to
        fall back to the &apos;system&apos; default. The token is never shown
        again once saved.
      </Hint>
    </View>
  );
}


function AgentConcurrencyPanel() {
  const [limit, setLimitInput] = useState('');
  const [stats, setStats] = useState<AgentSlots | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAgentSlots()
      .then(s => {
        setStats(s);
        setLimitInput(String(s.limit));
      })
      .catch(() => {
        // Non-fatal — likely running without the server (e.g. native). The
        // env-var default still governs; the panel just can't show it.
      });
  }, []);

  function save() {
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1) {
      setError('Enter a whole number ≥ 1');
      return;
    }
    setError(null);
    setAgentSlots(n)
      .then(s => {
        setStats(s);
        setLimitInput(String(s.limit));
        setSavedAt(Date.now());
        setTimeout(() => setSavedAt(null), 1500);
      })
      .catch(e => setError((e as Error).message));
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
        <View style={{ width: 130, gap: 4 }}>
          <Text style={styles.label}>Max concurrent</Text>
          <TextInput
            value={limit}
            onChangeText={setLimitInput}
            placeholder="4"
            style={styles.input}
            keyboardType="number-pad"
          />
        </View>
        <View style={styles.buttonRow}>
          <Pressable
            onPress={save}
            accessibilityRole="button"
            accessibilityLabel="Save agent concurrency"
            style={styles.saveButton}>
            <Text style={styles.saveButtonText}>Apply</Text>
          </Pressable>
          {savedAt && <Text style={styles.savedNote}>Applied.</Text>}
        </View>
      </View>
      {stats && (
        <Hint>
          {`Live: ${stats.inUse}/${stats.limit} agent(s) running, ${stats.waiting} queued.`}
        </Hint>
      )}
      {error && <Text style={{ color: '#dc2626', fontSize: 11 }}>{error}</Text>}
    </View>
  );
}

/** A cap as the field shows it: a number, or blank for "no cap". */
function showCap(n: number | null | undefined): string {
  return n != null ? String(n) : '';
}

/** A typed cap as the route must receive it. Blank is the deliberate clear;
 *  anything that is not a positive number is REFUSED here rather than sent.
 *  `parseFloat('$5')` is NaN, which `JSON.stringify` puts on the wire as
 *  `null` — indistinguishable from the deliberate clear — so a typo silently
 *  removed the cap, the route answered 200 with it gone, and the panel said
 *  "Saved." with the typo still on screen. A cost ceiling that quietly stops
 *  existing is the one failure a guardrail may not have. */
function parseCap(s: string, label: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${label}: enter a number greater than 0, or leave it blank to remove the cap.`,
    );
  }
  return n;
}

function BudgetPanel() {
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [perOwnerDaily, setPerOwnerDaily] = useState('');
  const [perOwnerMonthly, setPerOwnerMonthly] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getBudgetConfig()
      .then(cfg => {
        setDaily(showCap(cfg.dailyUsd));
        setMonthly(showCap(cfg.monthlyUsd));
        setPerOwnerDaily(showCap(cfg.perOwnerDailyUsd));
        setPerOwnerMonthly(showCap(cfg.perOwnerMonthlyUsd));
        setLoaded(true);
      })
      .catch(e => {
        // NOT non-fatal: a blank form reads exactly like "no caps
        // configured", and Save sends every blank as the deliberate clear —
        // so a panel that never read the caps would wipe all four. Same rule
        // as the typo path: a cost ceiling that quietly stops existing is
        // the one failure a guardrail may not have.
        setError(
          `could not read the current caps (${(e as Error).message}) — the ` +
            'fields below are blank because of that, not because no cap is ' +
            'set, so Save is refused until the read succeeds.',
        );
      });
  }, []);

  function save() {
    if (!loaded) {
      // Nothing was read, so there is nothing to compare the form against.
      setError(
        'the current caps have not been read yet — reload the page; nothing ' +
          'was sent.',
      );
      return;
    }
    // A blank field is sent as an explicit null: the server keeps a
    // per-owner cap that is merely OMITTED (so a client that only knows the
    // two global fields can't wipe it), which means clearing one from here
    // has to say so.
    let body: BudgetConfig;
    try {
      body = {
        dailyUsd: parseCap(daily, 'Daily cap'),
        monthlyUsd: parseCap(monthly, 'Monthly cap'),
        perOwnerDailyUsd: parseCap(perOwnerDaily, 'Per-owner daily cap'),
        perOwnerMonthlyUsd: parseCap(perOwnerMonthly, 'Per-owner monthly cap'),
      };
    } catch (e) {
      // Nothing is sent: an unparseable figure must not reach a route that
      // reads it as "no cap".
      setError((e as Error).message);
      return;
    }
    setError(null);
    saveBudgetConfig(body)
      .then(cfg => {
        // Show what was STORED, not what was typed — any cap the server
        // cleared or declined is otherwise invisible behind "Saved."
        setDaily(showCap(cfg.dailyUsd));
        setMonthly(showCap(cfg.monthlyUsd));
        setPerOwnerDaily(showCap(cfg.perOwnerDailyUsd));
        setPerOwnerMonthly(showCap(cfg.perOwnerMonthlyUsd));
        setSavedAt(Date.now());
        setTimeout(() => setSavedAt(null), 1500);
      })
      .catch(e => {
        // Keep the form values so the user can retry; say why it failed.
        setError((e as Error).message);
      });
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.label}>Daily cap (USD)</Text>
          <TextInput
            value={daily}
            onChangeText={setDaily}
            placeholder="5.00"
            accessibilityLabel="Daily cap"
            style={styles.input}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.label}>Monthly cap (USD)</Text>
          <TextInput
            value={monthly}
            onChangeText={setMonthly}
            placeholder="50.00"
            accessibilityLabel="Monthly cap"
            style={styles.input}
            keyboardType="decimal-pad"
          />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.label}>Per-owner daily cap (USD)</Text>
          <TextInput
            value={perOwnerDaily}
            onChangeText={setPerOwnerDaily}
            placeholder="1.00"
            accessibilityLabel="Per-owner daily cap"
            style={styles.input}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.label}>Per-owner monthly cap (USD)</Text>
          <TextInput
            value={perOwnerMonthly}
            onChangeText={setPerOwnerMonthly}
            placeholder="10.00"
            accessibilityLabel="Per-owner monthly cap"
            style={styles.input}
            keyboardType="decimal-pad"
          />
        </View>
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          onPress={save}
          accessibilityRole="button"
          accessibilityLabel="Save budget caps"
          style={styles.saveButton}>
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
        {savedAt && <Text style={styles.savedNote}>Saved.</Text>}
      </View>
      {error && <Text style={{ color: '#dc2626', fontSize: 11 }}>{error}</Text>}
      <Hint>
        Leave a field blank to disable that cap. The daily / monthly caps
        are the workspace-wide ceiling, measured against everyone&apos;s
        spend; the per-owner caps bound what any one user id (X-Sammy-User)
        may spend of it. Caps are enforced server-side — a run is refused
        once either is reached, and a long run is halted if its own cost
        crosses the line.
      </Hint>
    </View>
  );
}

/** Common MCP server templates — onboarding wins. Newcomer picks a
 *  template, fills in 1-2 fields (a token or URL), gets a working
 *  server config. Power-user "Custom" lands on the raw JSON form. */
const MCP_TEMPLATES: Array<{
  key: string;
  label: string;
  helpText: string;
  build: (fields: Record<string, string>) => { name: string; config: McpServerConfig };
  fields: Array<{ name: string; label: string; placeholder: string; secret?: boolean }>;
}> = [
  {
    key: 'github',
    label: 'GitHub (repos, issues, PRs)',
    helpText: 'Lets the agent read/write GitHub via the official MCP server. Needs a personal access token.',
    fields: [
      { name: 'token', label: 'GitHub token', placeholder: 'ghp_…', secret: true },
    ],
    build: (f) => ({
      name: 'github',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: f.token },
      },
    }),
  },
  {
    key: 'filesystem',
    label: 'Filesystem (read/write a directory)',
    helpText: 'Gives the agent file-level access to one directory tree. Safer than handing it the whole machine.',
    fields: [
      { name: 'root', label: 'Allowed root path', placeholder: '/Users/you/project' },
    ],
    build: (f) => ({
      name: 'filesystem',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', f.root],
      },
    }),
  },
  {
    key: 'postgres',
    label: 'Postgres (read-only query)',
    helpText: 'Lets the agent run SELECTs against a Postgres database. URL contains credentials.',
    fields: [
      {
        name: 'url',
        label: 'Connection URL',
        placeholder: 'postgresql://user:pass@host:5432/db',
        secret: true,
      },
    ],
    build: (f) => ({
      name: 'postgres',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', f.url],
      },
    }),
  },
  {
    key: 'slack',
    label: 'Slack (read/post messages)',
    helpText: 'Bot token + team id; agent can read channels and post messages.',
    fields: [
      { name: 'token', label: 'Slack bot token', placeholder: 'xoxb-…', secret: true },
      { name: 'team', label: 'Slack team id', placeholder: 'T01234567' },
    ],
    build: (f) => ({
      name: 'slack',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        env: { SLACK_BOT_TOKEN: f.token, SLACK_TEAM_ID: f.team },
      },
    }),
  },
  {
    key: 'http',
    label: 'Custom HTTP MCP server',
    helpText: 'Any remote MCP server exposed over HTTP. Headers optional.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'my-server' },
      { name: 'url', label: 'URL', placeholder: 'https://example.com/mcp' },
    ],
    build: (f) => ({
      name: f.name || 'http-server',
      config: { type: 'http', url: f.url },
    }),
  },
  {
    key: 'stdio',
    label: 'Custom stdio command',
    helpText: 'Spawn an arbitrary subprocess that speaks MCP over stdio.',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'my-server' },
      { name: 'command', label: 'Command', placeholder: 'node' },
      { name: 'args', label: 'Args (space-separated)', placeholder: './my-mcp.js arg1' },
    ],
    build: (f) => ({
      name: f.name || 'stdio-server',
      config: {
        type: 'stdio',
        command: f.command,
        args: f.args ? f.args.split(/\s+/).filter(Boolean) : [],
      },
    }),
  },
];

/** MCP servers editor. Top: registered servers as removable chips.
 *  Middle: quick-add form with templates for the most common cases.
 *  Bottom: collapsible raw-JSON editor for power users who want
 *  full control (env vars, alwaysLoad, custom transports, etc.). */
function McpServerPanel() {
  const [registry, setRegistry] = useState<Record<string, McpServerConfig>>({});
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState(MCP_TEMPLATES[0].key);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState('{}');
  const [serverStatuses, setServerStatuses] = useState<McpServerStatus[] | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  async function runStatusCheck() {
    setCheckingStatus(true);
    try {
      const rows = await checkMcpServerStatus();
      setServerStatuses(rows);
    } catch {
      // Non-fatal — leave previous status visible.
    } finally {
      setCheckingStatus(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await listMcpServers();
        setRegistry(r);
        setRawText(JSON.stringify(r, null, 2));
        setStatus('idle');
      } catch (err) {
        setError((err as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  const template = MCP_TEMPLATES.find(t => t.key === templateKey)!;

  async function persist(next: Record<string, McpServerConfig>) {
    setStatus('saving');
    setError(null);
    try {
      const written = await saveMcpServers(next);
      setRegistry(written);
      setRawText(JSON.stringify(written, null, 2));
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function addFromTemplate() {
    setError(null);
    const missing = template.fields.filter(f => !fieldValues[f.name]?.trim());
    if (missing.length > 0) {
      setError(`Missing: ${missing.map(f => f.label).join(', ')}`);
      return;
    }
    const { name, config } = template.build(fieldValues);
    if (!name.trim()) {
      setError('Server name is required');
      return;
    }
    if (registry[name]) {
      setError(`Server "${name}" already exists — remove it first to replace`);
      return;
    }
    await persist({ ...registry, [name]: config });
    setFieldValues({});
  }

  async function remove(name: string) {
    const next = { ...registry };
    delete next[name];
    await persist(next);
  }

  async function saveRaw() {
    let parsed: Record<string, McpServerConfig>;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Top-level must be a JSON object keyed by server name');
      return;
    }
    await persist(parsed);
  }

  return (
    <View style={{ gap: 12 }}>
      <Hint>
        Secrets in <Text style={styles.code}>env</Text> blocks should reference
        a credential by name —{' '}
        <Text style={styles.code}>{'${connections:atlassian-prod.value}'}</Text>{' '}
        — rather than inline tokens. Manage credentials in{' '}
        <ConnectionsLink label="Connections" />. Existing inline values still
        work for back-compat, but the unified registry is the new path.
      </Hint>
      {/* Registered servers */}
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={mcpStyles.sectionLabel}>
            Registered ({Object.keys(registry).length})
          </Text>
          {Object.keys(registry).length > 0 && (
            <Pressable
              onPress={runStatusCheck}
              disabled={checkingStatus}
              style={[mcpStyles.templateBtn, checkingStatus && { opacity: 0.5 }]}>
              <Text style={mcpStyles.templateBtnText}>
                {checkingStatus ? 'checking…' : '↻ test all'}
              </Text>
            </Pressable>
          )}
        </View>
        {Object.keys(registry).length === 0 ? (
          <Hint>None yet. Pick a template below to add your first MCP server.</Hint>
        ) : (
          <View style={mcpStyles.chipRow}>
            {Object.entries(registry).map(([name, config]) => {
              const status = serverStatuses?.find(s => s.name === name);
              const dot =
                status?.status === 'ok'
                  ? '#22c55e'
                  : status?.status === 'unreachable'
                    ? '#ef4444'
                    : status?.status === 'unknown'
                      ? '#9ca3af'
                      : null;
              return (
                <View key={name} style={mcpStyles.chip}>
                  {dot && (
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: dot,
                      }}
                    />
                  )}
                  <Text style={mcpStyles.chipName}>{name}</Text>
                  <Text style={mcpStyles.chipType}>
                    {(config as { type?: string }).type ?? 'stdio'}
                  </Text>
                  <Pressable onPress={() => remove(name)} style={mcpStyles.chipRemove}>
                    <Text style={mcpStyles.chipRemoveText}>×</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
        {serverStatuses && serverStatuses.some(s => s.message) && (
          <View style={{ gap: 2 }}>
            {serverStatuses
              .filter(s => s.message)
              .map(s => (
                <Text key={s.name} style={{ fontSize: 10, color: s.status === 'unreachable' ? '#b91c1c' : '#6b7280', fontFamily: 'Menlo' }}>
                  {s.name}: {s.message}
                </Text>
              ))}
          </View>
        )}
      </View>

      {/* Quick add */}
      <View style={mcpStyles.quickAdd}>
        <Text style={mcpStyles.sectionLabel}>Add server</Text>
        <View style={mcpStyles.templateRow}>
          {MCP_TEMPLATES.map(t => (
            <Pressable
              key={t.key}
              onPress={() => {
                setTemplateKey(t.key);
                setFieldValues({});
              }}
              style={[
                mcpStyles.templateBtn,
                templateKey === t.key && mcpStyles.templateBtnActive,
              ]}>
              <Text
                style={[
                  mcpStyles.templateBtnText,
                  templateKey === t.key && mcpStyles.templateBtnTextActive,
                ]}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Hint>{template.helpText}</Hint>
        {template.fields.map(field => (
          <View key={field.name} style={{ gap: 4 }}>
            <Text style={mcpStyles.fieldLabel}>{field.label}</Text>
            <TextInput
              value={fieldValues[field.name] ?? ''}
              onChangeText={t => setFieldValues(v => ({ ...v, [field.name]: t }))}
              placeholder={field.placeholder}
              style={mcpStyles.input}
              secureTextEntry={field.secret}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        ))}
        <View style={mcpStyles.row}>
          <Pressable
            onPress={addFromTemplate}
            disabled={status === 'saving'}
            style={[styles.saveButton, status === 'saving' && { opacity: 0.5 }]}>
            <Text style={styles.saveButtonText}>
              {status === 'saving' ? 'Adding…' : `+ Add ${template.label.split(' ')[0]}`}
            </Text>
          </Pressable>
          {status === 'saved' && <Text style={styles.savedNote}>Saved.</Text>}
          {error && <Text style={mcpStyles.error}>{error}</Text>}
        </View>
      </View>

      {/* Power-user raw JSON */}
      <Pressable onPress={() => setShowRaw(s => !s)} style={mcpStyles.disclosure}>
        <Text style={mcpStyles.disclosureText}>
          {showRaw ? '▾' : '▸'} Advanced: edit raw JSON
        </Text>
      </Pressable>
      {showRaw && (
        <View style={{ gap: 6 }}>
          <TextInput
            value={rawText}
            onChangeText={setRawText}
            style={mcpStyles.editor}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={mcpStyles.row}>
            <Pressable
              onPress={saveRaw}
              disabled={status === 'saving'}
              style={[styles.saveButton, status === 'saving' && { opacity: 0.5 }]}>
              <Text style={styles.saveButtonText}>Save raw JSON</Text>
            </Pressable>
          </View>
          <Hint>
            Full SDK shape: stdio (command/args/env), sse (url/headers), http
            (url/headers/type:"http"). Lives at mcp/servers.json — secrets stay
            server-side, never reach the browser at run time.
          </Hint>
        </View>
      )}
    </View>
  );
}

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
];

/** Hooks editor — form-first, JSON fallback. Same UX pattern as
 *  McpServerPanel: registered hooks as removable chips, guided "Add
 *  hook" form, collapsible raw-JSON editor for power users. */
function HooksPanel() {
  const [registry, setRegistry] = useState<Record<string, HookSpec>>({});
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [event, setEvent] = useState('PreToolUse');
  const [matcher, setMatcher] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [timeoutText, setTimeoutText] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState('{}');

  useEffect(() => {
    (async () => {
      try {
        const r = await listHooks();
        setRegistry(r);
        setRawText(JSON.stringify(r, null, 2));
        setStatus('idle');
      } catch (err) {
        setError((err as Error).message);
        setStatus('error');
      }
    })();
  }, []);

  async function persist(next: Record<string, HookSpec>) {
    setStatus('saving');
    setError(null);
    try {
      const written = await saveHooks(next);
      setRegistry(written);
      setRawText(JSON.stringify(written, null, 2));
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  async function addHook() {
    setError(null);
    if (!name.trim()) {
      setError('Hook name is required');
      return;
    }
    if (!command.trim()) {
      setError('Command is required');
      return;
    }
    if (registry[name]) {
      setError(`Hook "${name}" already exists — remove it first to replace`);
      return;
    }
    const spec: HookSpec = {
      event,
      command,
      ...(matcher ? { matcher } : {}),
      ...(argsText ? { args: argsText.split(/\s+/).filter(Boolean) } : {}),
      ...(timeoutText && !Number.isNaN(Number(timeoutText))
        ? { timeoutSeconds: Number(timeoutText) }
        : {}),
    };
    await persist({ ...registry, [name]: spec });
    setName('');
    setMatcher('');
    setCommand('');
    setArgsText('');
    setTimeoutText('');
  }

  async function remove(n: string) {
    const next = { ...registry };
    delete next[n];
    await persist(next);
  }

  async function saveRaw() {
    let parsed: Record<string, HookSpec>;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Top-level must be a JSON object keyed by hook name');
      return;
    }
    await persist(parsed);
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Text style={mcpStyles.sectionLabel}>
          Registered ({Object.keys(registry).length})
        </Text>
        {Object.keys(registry).length === 0 ? (
          <Hint>
            None yet. A hook can audit-log every Bash call, block destructive
            commands, post to Slack on completion, etc.
          </Hint>
        ) : (
          <View style={mcpStyles.chipRow}>
            {Object.entries(registry).map(([n, spec]) => (
              <View key={n} style={mcpStyles.chip}>
                <Text style={mcpStyles.chipName}>{n}</Text>
                <Text style={mcpStyles.chipType}>
                  {spec.event}
                  {spec.matcher ? ` · ${spec.matcher}` : ''}
                </Text>
                <Pressable onPress={() => remove(n)} style={mcpStyles.chipRemove}>
                  <Text style={mcpStyles.chipRemoveText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={mcpStyles.quickAdd}>
        <Text style={mcpStyles.sectionLabel}>Add hook</Text>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="audit-log"
            style={mcpStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Event</Text>
          <View style={mcpStyles.templateRow}>
            {HOOK_EVENTS.map(e => (
              <Pressable
                key={e}
                onPress={() => setEvent(e)}
                style={[
                  mcpStyles.templateBtn,
                  event === e && mcpStyles.templateBtnActive,
                ]}>
                <Text
                  style={[
                    mcpStyles.templateBtnText,
                    event === e && mcpStyles.templateBtnTextActive,
                  ]}>
                  {e}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Tool matcher (optional)</Text>
          <TextInput
            value={matcher}
            onChangeText={setMatcher}
            placeholder="Bash · only fires for Bash tool calls"
            style={mcpStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Command</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            placeholder="/path/to/script.sh"
            style={mcpStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Args (optional, space-separated)</Text>
          <TextInput
            value={argsText}
            onChangeText={setArgsText}
            placeholder="--mode strict --quiet"
            style={mcpStyles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text style={mcpStyles.fieldLabel}>Timeout seconds (optional, default 30)</Text>
          <TextInput
            value={timeoutText}
            onChangeText={setTimeoutText}
            placeholder="30"
            style={mcpStyles.input}
            keyboardType="numeric"
          />
        </View>

        <View style={mcpStyles.row}>
          <Pressable
            onPress={addHook}
            disabled={status === 'saving'}
            style={[styles.saveButton, status === 'saving' && { opacity: 0.5 }]}>
            <Text style={styles.saveButtonText}>
              {status === 'saving' ? 'Adding…' : '+ Add hook'}
            </Text>
          </Pressable>
          {status === 'saved' && <Text style={styles.savedNote}>Saved.</Text>}
          {error && <Text style={mcpStyles.error}>{error}</Text>}
        </View>

        <Hint>
          Hook contract: receives {`{ input, toolUseId }`} as JSON on stdin, returns
          SDK HookJSONOutput on stdout — usually {`{ "decision": "approve" }`} or{' '}
          {`{ "decision": "block", "reason": "..." }`}. Empty stdout = allow. Non-zero
          exit = block. Registry: hooks/hooks.json at repo root.
        </Hint>
      </View>

      <Pressable onPress={() => setShowRaw(s => !s)} style={mcpStyles.disclosure}>
        <Text style={mcpStyles.disclosureText}>
          {showRaw ? '▾' : '▸'} Advanced: edit raw JSON
        </Text>
      </Pressable>
      {showRaw && (
        <View style={{ gap: 6 }}>
          <TextInput
            value={rawText}
            onChangeText={setRawText}
            style={mcpStyles.editor}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={saveRaw}
            disabled={status === 'saving'}
            style={[styles.saveButton, status === 'saving' && { opacity: 0.5 }]}>
            <Text style={styles.saveButtonText}>Save raw JSON</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const mcpStyles = StyleSheet.create({
  serverNames: { fontSize: 12, color: '#374151' },
  sectionLabel: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 4,
    backgroundColor: '#ecfdf5',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  chipName: { fontSize: 12, fontWeight: '600', color: '#065f46' },
  chipType: { fontSize: 10, color: '#059669', fontFamily: 'Menlo' },
  chipRemove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#a7f3d0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRemoveText: { color: '#065f46', fontWeight: '700', fontSize: 13, lineHeight: 14 },
  quickAdd: {
    gap: 8,
    padding: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  templateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  templateBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: '#ffffff',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  templateBtnActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  templateBtnText: { fontSize: 11, color: '#374151' },
  templateBtnTextActive: { color: '#ffffff', fontWeight: '600' },
  fieldLabel: { fontSize: 11, color: '#374151', fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  disclosure: { paddingVertical: 6 },
  disclosureText: { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  editor: {
    minHeight: 180,
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#111827',
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    padding: 10,
    textAlignVertical: 'top',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  error: { fontSize: 11, color: '#b91c1c', flex: 1 },
});

/** Source of a scan result — affects which import endpoint we hit. */
type ScanMode = 'picker' | 'path';
type ScanRow = ScannedAgent & {
  /** Only set for picker results — the file content we already read in
   *  the browser. */
  content?: string;
};

function AgentSourcesPanel() {
  const [path, setPath] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [scanned, setScanned] = useState<ScanRow[]>([]);
  const [scanMode, setScanMode] = useState<ScanMode>('picker');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'idle' | 'scanning' | 'importing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function toggle(suggestedName: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(suggestedName)) next.delete(suggestedName);
      else next.add(suggestedName);
      return next;
    });
  }

  /** Modern Chromium browsers expose showDirectoryPicker which shows a
   *  much clearer dialog ("Let site view files in 'X'?") than the
   *  legacy <input type=file webkitdirectory> path (which says "Upload
   *  files from this folder?" even though we never upload to a remote
   *  server). Try this first, fall back to the file-input otherwise. */
  async function openFolderPicker() {
    const showDirectoryPicker = (
      globalThis as { showDirectoryPicker?: (opts?: { mode?: string }) => Promise<unknown> }
    ).showDirectoryPicker;
    if (typeof showDirectoryPicker === 'function') {
      try {
        const handle = await showDirectoryPicker({ mode: 'read' });
        await scanFromDirHandle(handle as Parameters<typeof scanFromDirHandle>[0]);
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return; // user cancelled
        // Any other failure (API blocked by permissions policy, etc.) →
        // fall through to the legacy input.
        console.warn('[settings] showDirectoryPicker failed, falling back:', err);
      }
    }
    fileInputRef.current?.click();
  }

  /** Recursively walk a FileSystemDirectoryHandle (modern API). */
  async function scanFromDirHandle(rootHandle: {
    name: string;
    values(): AsyncIterable<{
      kind: 'file' | 'directory';
      name: string;
      getFile?: () => Promise<File>;
      values?: () => AsyncIterable<unknown>;
    }>;
  }) {
    setStatus('scanning');
    setError(null);
    setResult(null);
    setScanned([]);
    setSelected(new Set());
    try {
      const rows: ScanRow[] = [];
      async function walk(handle: typeof rootHandle, relDir: string) {
        for await (const entry of handle.values()) {
          if (shouldSkipAgentDir(entry.name)) continue;
          if (entry.kind === 'directory') {
            const nextDir = relDir ? `${relDir}/${entry.name}` : entry.name;
            await walk(entry as typeof rootHandle, nextDir);
          } else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
            if (shouldSkipAgentFile(entry.name)) continue;
            const suggestedName = deriveAgentName(relDir, entry.name);
            if (!suggestedName) continue;
            const file = await entry.getFile!();
            const content = await file.text();
            const preview = content.slice(0, 200).replace(/\s+/g, ' ').trim();
            rows.push({
              suggestedName,
              sourcePath: relDir ? `${rootHandle.name}/${relDir}/${entry.name}` : `${rootHandle.name}/${entry.name}`,
              preview,
              content,
            });
          }
        }
      }
      await walk(rootHandle, '');
      rows.sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
      setScanMode('picker');
      setScanned(rows);
      setSelected(new Set(rows.map(r => r.suggestedName)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatus('idle');
    }
  }

  /** Legacy fallback: <input type=file webkitdirectory> for Safari /
   *  Firefox / older Chromium. Shows the "Upload" warning dialog —
   *  misleading wording, but the only path that works there. */
  async function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files as FileList | null;
    if (!fileList || fileList.length === 0) return;
    setStatus('scanning');
    setError(null);
    setResult(null);
    setScanned([]);
    setSelected(new Set());
    try {
      const rows: ScanRow[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList.item(i);
        if (!file) continue;
        if (!file.name.endsWith('.md')) continue;
        if (shouldSkipAgentFile(file.name)) continue;
        // webkitRelativePath: "<picked-folder-name>/<rest>/<file.md>"
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
        const parts = relPath.split('/');
        const dirParts = parts.slice(1, -1); // drop picked root + filename
        if (dirParts.some(shouldSkipAgentDir)) continue;
        const suggestedName = deriveAgentName(dirParts.join('/'), file.name);
        if (!suggestedName) continue;
        const content = await file.text();
        const preview = content.slice(0, 200).replace(/\s+/g, ' ').trim();
        rows.push({
          suggestedName,
          sourcePath: relPath,
          preview,
          content,
        });
      }
      rows.sort((a, b) => a.suggestedName.localeCompare(b.suggestedName));
      setScanMode('picker');
      setScanned(rows);
      setSelected(new Set(rows.map(r => r.suggestedName)));
      e.target.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatus('idle');
    }
  }

  /** Server-side scan via absolute path. Symlink-friendly. */
  async function scanByPath() {
    setStatus('scanning');
    setError(null);
    setResult(null);
    setScanned([]);
    setSelected(new Set());
    try {
      const list = await scanAgentSources(path.trim(), recursive);
      setScanMode('path');
      setScanned(list);
      setSelected(new Set(list.map(s => s.suggestedName)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatus('idle');
    }
  }

  async function doImport() {
    const chosen = scanned.filter(s => selected.has(s.suggestedName));
    if (chosen.length === 0) return;
    setStatus('importing');
    setError(null);
    setResult(null);
    try {
      let res: {
        imported: string[];
        copied?: string[];
        skipped: Array<{ as: string; reason: string; from?: string }>;
      };
      if (scanMode === 'picker') {
        // Copy mode — write file contents the browser already read.
        res = await importAgentContents(
          chosen.map(c => ({ as: c.suggestedName, content: c.content ?? '' })),
        );
      } else {
        // Symlink mode — server has the absolute path.
        res = await importAgents(
          chosen.map(c => ({ from: c.sourcePath, as: c.suggestedName })),
        );
      }
      const parts: string[] = [];
      if (res.imported.length > 0) {
        parts.push(`Imported ${res.imported.length}: ${res.imported.join(', ')}`);
      }
      if (res.copied && res.copied.length > 0) {
        parts.push(
          `${res.copied.length} copied instead of linked (Windows) — source edits won't propagate; re-import to refresh`,
        );
      }
      if (res.skipped.length > 0) {
        parts.push(
          `Skipped ${res.skipped.length}: ` +
            res.skipped.map(s => `${s.as} (${s.reason})`).join('; '),
        );
      }
      setResult(parts.join('. ') || 'Nothing to import.');
      setScanned(prev => prev.filter(s => !res.imported.includes(s.suggestedName)));
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatus('idle');
    }
  }

  return (
    <View>
      {/* Hidden native file input — opens the OS folder dialog. Rendered
          as a raw HTML element since react-native-web has no
          `webkitdirectory` analogue. */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory / directory aren't in the
        // standard HTMLInputElement type, but every Chromium-based browser
        // (and Safari ≥11) honors them.
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={onFolderPicked}
      />

      <View style={styles.buttonRow}>
        <Pressable
          onPress={openFolderPicker}
          disabled={status !== 'idle'}
          style={[
            styles.saveButton,
            status !== 'idle' && styles.buttonDisabled,
          ]}>
          <Text style={styles.saveButtonText}>
            {status === 'scanning' ? 'Reading…' : '📁 Choose folder…'}
          </Text>
        </Pressable>
        {scanned.length > 0 && (
          <Pressable
            onPress={doImport}
            disabled={selected.size === 0 || status !== 'idle'}
            style={[
              styles.saveButton,
              (selected.size === 0 || status !== 'idle') && styles.buttonDisabled,
              { backgroundColor: '#059669' },
            ]}>
            <Text style={styles.saveButtonText}>
              {status === 'importing'
                ? 'Importing…'
                : `Import ${selected.size} selected`}
            </Text>
          </Pressable>
        )}
      </View>
      <Hint>
        Native OS folder picker. Sammy-pack reads every .md file in the
        picked folder (recursively), filters out README / COMPONENT /
        `_`-prefixed files, derives names from the
        {' `[component]/[role].md` '}
        layout (e.g. `billing/host-qa.md` → `billing-host-qa`), and on
        import writes them as real .md files in your local agents/
        dir.{' '}
        <Text
          onPress={() => setShowAdvanced(v => !v)}
          style={styles.linkText}>
          {showAdvanced ? 'Hide' : 'Show'} advanced (symlink mode by
          absolute path)
        </Text>
      </Hint>

      {showAdvanced && (
        <View style={styles.advancedBox}>
          <Hint>
            Advanced: paste an absolute folder path to symlink files
            instead of copying. Symlinks read live — edits in the source
            propagate. Useful when you control both repos and want
            changes to flow automatically. Dev server only (won't work in
            production-built static hosting).
          </Hint>
          <View style={styles.field}>
            <Text style={styles.label}>Folder path (absolute)</Text>
            <TextInput
              value={path}
              onChangeText={setPath}
              placeholder="/Users/you/git/some-repo/agents"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={styles.field}>
            <Pressable
              onPress={() => setRecursive(r => !r)}
              style={styles.checkRow}>
              <View style={[styles.checkbox, recursive && styles.checkboxOn]} />
              <Text style={styles.checkLabel}>Recurse into subdirectories</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={scanByPath}
            disabled={!path.trim() || status !== 'idle'}
            style={[
              styles.saveButton,
              (!path.trim() || status !== 'idle') && styles.buttonDisabled,
              { alignSelf: 'flex-start' },
            ]}>
            <Text style={styles.saveButtonText}>
              {status === 'scanning' ? 'Scanning…' : 'Scan by path (symlink)'}
            </Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}
      {result && <Text style={styles.savedNote}>{result}</Text>}
      {scanned.length > 0 && (
        <View style={styles.scannedList}>
          <Text style={styles.scannedHeader}>
            {scanned.length} agent{scanned.length === 1 ? '' : 's'} found{' '}
            <Text style={styles.scannedMode}>
              ({scanMode === 'picker' ? 'will copy' : 'will symlink'})
            </Text>
          </Text>
          {scanned.map(s => {
            const isSelected = selected.has(s.suggestedName);
            return (
              <Pressable
                key={s.suggestedName}
                onPress={() => toggle(s.suggestedName)}
                style={[styles.scannedRow, isSelected && styles.scannedRowActive]}>
                <View style={[styles.checkbox, isSelected && styles.checkboxOn]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.scannedName}>{s.suggestedName}</Text>
                  <Text style={styles.scannedPath}>{s.sourcePath}</Text>
                  {s.preview && (
                    <Text style={styles.scannedPreview} numberOfLines={2}>
                      {s.preview}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  settingsSection: { marginBottom: 8 },
  settingsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  settingsSectionChevron: { fontSize: 11, color: '#6b7280', width: 12 },
  settingsSectionTitle: { fontSize: 13, fontWeight: '700', color: '#111827' },
  settingsSectionHint: { fontSize: 11, color: '#9ca3af', flex: 1, marginLeft: 4 },
  settingsSectionBody: { marginTop: 8, gap: 8 },
  field: { gap: 4, marginBottom: 8 },
  label: { fontSize: 12, fontWeight: '600', color: '#374151' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#2563eb',
    borderRadius: 6,
  },
  saveButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
  clearButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
  },
  clearButtonText: { color: '#6b7280', fontWeight: '500', fontSize: 12 },
  savedNote: { fontSize: 12, color: '#059669', fontWeight: '500' },
  authRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  authOption: {
    flex: 1,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  authOptionActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  authOptionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 4,
  },
  authOptionTextActive: { color: '#1d4ed8' },
  buttonDisabled: { opacity: 0.5 },
  errorText: { fontSize: 11, color: '#dc2626', marginTop: 4 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#9ca3af',
    backgroundColor: '#ffffff',
  },
  checkboxOn: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  checkLabel: { fontSize: 12, color: '#374151' },
  autoSavedHint: { fontSize: 10, color: '#9ca3af', fontStyle: 'italic' },
  scannedList: { marginTop: 12, gap: 6 },
  scannedHeader: {
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '600',
    marginBottom: 4,
  },
  scannedRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  scannedRowActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  scannedName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
    fontFamily: 'Menlo',
  },
  scannedPath: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'Menlo',
    marginTop: 1,
  },
  scannedPreview: {
    fontSize: 11,
    color: '#374151',
    marginTop: 4,
    lineHeight: 14,
  },
  scannedMode: {
    fontSize: 10,
    color: '#9ca3af',
    fontWeight: '400',
    fontStyle: 'italic',
  },
  linkText: { color: '#2563eb', textDecorationLine: 'underline' },
  code: {
    fontFamily: 'Menlo',
    fontSize: 11,
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  advancedBox: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  authOptionSub: {
    fontSize: 11,
    color: '#6b7280',
    lineHeight: 14,
  },
});
