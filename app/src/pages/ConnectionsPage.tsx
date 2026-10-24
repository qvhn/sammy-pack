import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  listMcpServers,
  saveMcpServers,
  type McpServerConfig,
} from '../api';
import {
  getConnectionField,
  getConnectionToken,
  setConnectionField,
  setConnectionToken,
  type ConnectionType,
} from '../store/connections';
import {
  SHORT_VALUE_MASK,
  getCredentials,
  getCredentialsUsage,
  importCredentials,
  maskedFieldKeys,
  maskedSecretBlocks,
  saveCredentials,
  secretReentryRequired,
  snapshotSammyLocalStorage,
  testConnection,
  type Credential,
  type CredentialDraft,
  type CredentialsMap,
  type ImportResult,
  type TestConnectionResult,
  type UsageMap,
  type UsageRow,
} from '../store/credentials';
import {
  KIND_REGISTRY,
  getKindDef,
  kindGroup,
  type ConnectionKindDef,
  type KindField,
} from '../store/kindRegistry';
import { useToast } from '../store/toast';
import { Card, Hint, Page, SectionTitle } from './Page';

type McpRegistry = Record<string, McpServerConfig>;

/** Wrapped shape for the Advanced JSON view. The editor presents one
 *  blob so the user sees both stores side-by-side; on save the two
 *  halves go to their own endpoints. */
type UnifiedJsonShape = {
  credentials: CredentialsMap;
  mcpServers: McpRegistry;
};

type ExtraField = {
  key: string;
  label: string;
  placeholder: string;
  helpText?: string;
};

type Provider = {
  id: ConnectionType;
  label: string;
  description: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  /** Per-provider help text shown under the token input. */
  tokenHelp: string;
  /** Any non-token fields the connector needs (e.g., Jira site URL). */
  extras?: ExtraField[];
};

const PROVIDERS: Provider[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repos, PRs, issues, code search.',
    tokenLabel: 'Personal access token',
    tokenPlaceholder: 'ghp_…',
    tokenHelp:
      'Create at github.com/settings/tokens (classic, repo scope). Stays in this browser; only sent to api.github.com.',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    description: 'Repos + PRs.',
    tokenLabel: 'App password',
    tokenPlaceholder: 'ATBB…',
    tokenHelp:
      'Create at bitbucket.org/account/settings/app-passwords. Needs repository read at minimum.',
    extras: [
      {
        key: 'workspace',
        label: 'Workspace slug',
        placeholder: 'my-workspace',
        helpText: 'The URL slug for your team (bitbucket.org/<workspace>).',
      },
    ],
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    description: 'Repos + MRs.',
    tokenLabel: 'Personal access token',
    tokenPlaceholder: 'glpat-…',
    tokenHelp:
      'Create at gitlab.com/-/user_settings/personal_access_tokens. Needs api scope. Self-hosted? Set base URL below.',
    extras: [
      {
        key: 'baseUrl',
        label: 'Base URL (leave blank for gitlab.com)',
        placeholder: 'https://gitlab.example.com',
      },
    ],
  },
  {
    id: 'jira',
    label: 'Jira',
    description: 'Tickets, sprints, comments.',
    tokenLabel: 'API token',
    tokenPlaceholder: 'token from id.atlassian.com',
    tokenHelp:
      'Create at id.atlassian.com/manage-profile/security/api-tokens. Paired with your account email below.',
    extras: [
      {
        key: 'email',
        label: 'Atlassian account email',
        placeholder: 'you@example.com',
      },
      {
        key: 'siteUrl',
        label: 'Site URL',
        placeholder: 'https://your-team.atlassian.net',
      },
    ],
  },
  {
    id: 'linear',
    label: 'Linear',
    description: 'Issues + cycles.',
    tokenLabel: 'Personal API key',
    tokenPlaceholder: 'lin_api_…',
    tokenHelp: 'Create at linear.app/settings/api. Read-write or read-only depending on need.',
  },
  {
    id: 'figma',
    label: 'Figma',
    description: 'Design files + frames.',
    tokenLabel: 'Personal access token',
    tokenPlaceholder: 'figd_…',
    tokenHelp: 'Create at figma.com/settings (Personal access tokens section).',
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Docs + databases.',
    tokenLabel: 'Internal integration token',
    tokenPlaceholder: 'secret_…',
    tokenHelp:
      'Create at notion.so/profile/integrations. Share the pages/DBs you want the integration to see.',
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Message + react via bot.',
    tokenLabel: 'Bot user token',
    tokenPlaceholder: 'xoxb-…',
    tokenHelp:
      'Create a Slack app at api.slack.com/apps, install to your workspace, copy the bot token.',
    extras: [
      {
        key: 'teamId',
        label: 'Workspace team id',
        placeholder: 'T01234567',
      },
    ],
  },
];

// Each legacy connector id maps onto a kind in KIND_REGISTRY whose
// `importFrom.legacyConnectionType` matches it. The dual-write path
// uses this map to land the localStorage save into credentials.json as
// a kind-tagged entry under the same name as the connector id (so
// existing orchestrations referencing e.g. `credential: "github"`
// continue to resolve).
const LEGACY_TO_KIND: Record<ConnectionType, string> = {
  github: 'github',
  bitbucket: 'bitbucket',
  gitlab: 'gitlab',
  jira: 'atlassian',
  linear: 'linear',
  figma: 'figma',
  notion: 'notion',
  slack: 'slack',
};

export function ConnectionsPage() {
  const [registry, setRegistry] = useState<CredentialsMap>({});
  // MCP server registry mirrored here so the unified JSON view + the
  // hoist-from-MCP affordance both have a single source of truth. We
  // refetch on every refresh() so an edit from the MCP panel in
  // Settings reflects here on next navigation.
  const [mcpRegistry, setMcpRegistry] = useState<McpRegistry>({});
  const [loading, setLoading] = useState(true);
  const [addingKind, setAddingKind] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; entry: Credential } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  // Raw-JSON editor — guarded by a confirm prompt because opening it
  // unmasks every secret on screen. Same disclosure pattern as the
  // MCP / Hooks panels but with an extra "are you sure" gate since
  // these specifically are the secrets the rest of the page is at
  // pains to hide. The editor shows BOTH credentials + mcp/servers.json
  // so users see the full auth picture in one place.
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [rawJsonText, setRawJsonText] = useState('');
  const [rawJsonError, setRawJsonError] = useState<string | null>(null);
  // Reverse index "used by". The server walks examples/
  // each call; the page fetches on mount + after saves so reads in the
  // UI are O(1). Map shape: {credName: {directRefs[], viaMcp[]}}.
  const [usage, setUsage] = useState<UsageMap>({});
  const toast = useToast();

  async function refresh(): Promise<void> {
    try {
      // Parallel — all three endpoints are local and small; halving
      // the round-trip matters for the perceived snappiness when the
      // user navigates back to this page. Usage failures are
      // non-fatal — the "Used by" footers just won't render.
      const [creds, mcps, use] = await Promise.all([
        getCredentials(),
        listMcpServers().catch(() => ({}) as McpRegistry),
        getCredentialsUsage().catch(() => ({}) as UsageMap),
      ]);
      setRegistry(creds);
      setMcpRegistry(mcps);
      setUsage(use);
    } catch (err) {
      console.error('[ConnectionsPage] refresh failed', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runImport(dryRun: boolean): Promise<void> {
    try {
      const result = await importCredentials({
        localStorage: snapshotSammyLocalStorage(),
        dryRun,
      });
      if (dryRun) {
        setImportPreview(result);
        return;
      }
      setImportPreview(null);
      await refresh();
      toast.show(
        `Imported: +${result.added.length} added, ${result.updated.length} updated`,
        'success',
      );
    } catch (err) {
      toast.show(`Import failed: ${(err as Error).message}`, 'error');
    }
  }

  async function deleteEntry(name: string): Promise<void> {
    const next = { ...registry };
    delete next[name];
    try {
      await saveCredentials(next);
      await refresh();
      toast.show(`Deleted ${name}`, 'info');
    } catch (err) {
      toast.show(`Delete failed: ${(err as Error).message}`, 'error');
    }
  }

  async function upsertEntry(name: string, entry: Credential): Promise<void> {
    const next = { ...registry, [name]: entry };
    try {
      const saved = await saveCredentials(next);
      setRegistry(saved);
      toast.show(`Saved ${name}`, 'success');
    } catch (err) {
      toast.show(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  /** Download the entire credentials.json as a single JSON file.
   *  This is the "machine snapshot" flow — distinct from per-entry
   *  edits above and from the legacy localStorage import below.
   *  Settings → Backup explicitly skips credentials.json (prefs only)
   *  to keep the two surfaces from blurring. */
  function exportAll(): void {
    const g = globalThis as unknown as {
      URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
      Blob?: new (parts: string[], opts?: { type: string }) => unknown;
      document?: {
        createElement(t: string): { href: string; download: string; click(): void };
      };
      setTimeout?: (fn: () => void, ms: number) => void;
    };
    if (!g.URL || !g.Blob || !g.document) return;
    const payload = JSON.stringify(registry, null, 2);
    const blob = new g.Blob([payload], { type: 'application/json' });
    const url = g.URL.createObjectURL(blob);
    const a = g.document.createElement('a');
    a.href = url;
    a.download = `sammy-connections-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    g.setTimeout?.(() => g.URL!.revokeObjectURL(url), 1000);
  }

  /** Open the raw-JSON editor with a security gate. Confirm prompt
   *  makes the user explicitly accept that their secrets will appear
   *  on screen — protects against the "shared screen / co-worker
   *  walks by" case the masked cards above were designed to avoid.
   *  The editor shows BOTH credentials.json AND mcp/servers.json as a
   *  single wrapped object so users see the whole auth picture without
   *  flipping between pages. */
  function openRawJsonEditor(): void {
    const g = globalThis as unknown as {
      confirm?: (msg: string) => boolean;
    };
    const ok =
      g.confirm?.(
        'This will show your raw connection secrets AND MCP server ' +
          'configs (API keys, tokens, OAuth tokens, AWS access keys, ' +
          'inline MCP env values) in plain text. Anyone looking at your ' +
          'screen will be able to read them.\n\n' +
          'Continue?',
      ) ?? true;
    if (!ok) return;
    const unified: UnifiedJsonShape = {
      credentials: registry,
      mcpServers: mcpRegistry,
    };
    setRawJsonText(JSON.stringify(unified, null, 2));
    setRawJsonError(null);
    setRawJsonOpen(true);
  }

  function closeRawJsonEditor(): void {
    setRawJsonOpen(false);
    setRawJsonError(null);
  }

  /** Apply the raw-JSON edit. Parse → validate shape → split into
   *  credentials + mcpServers → PUT each to its own endpoint. Order
   *  matters: write credentials first, since a credential rename
   *  could break an MCP env block that references it, and writing
   *  MCP last gives the user a chance to fix the env in the same
   *  edit. Both PUTs are full overwrites — same semantics as the
   *  per-file editors. */
  async function saveRawJsonEditor(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJsonText);
    } catch (err) {
      setRawJsonError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setRawJsonError(
        'Top level must be a JSON object with `credentials` and `mcpServers` keys.',
      );
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const creds = obj.credentials;
    const mcps = obj.mcpServers;
    if (creds === undefined || typeof creds !== 'object' || creds === null || Array.isArray(creds)) {
      setRawJsonError(
        'Missing or invalid `credentials` key — must be a `{ "name": { ... } }` object.',
      );
      return;
    }
    if (mcps === undefined || typeof mcps !== 'object' || mcps === null || Array.isArray(mcps)) {
      setRawJsonError(
        'Missing or invalid `mcpServers` key — must be a `{ "name": { ... } }` object.',
      );
      return;
    }
    try {
      const savedCreds = await saveCredentials(creds as CredentialsMap);
      const savedMcps = await saveMcpServers(mcps as McpRegistry);
      setRegistry(savedCreds);
      setMcpRegistry(savedMcps);
      const next: UnifiedJsonShape = {
        credentials: savedCreds,
        mcpServers: savedMcps,
      };
      setRawJsonText(JSON.stringify(next, null, 2));
      setRawJsonError(null);
      toast.show(
        `Saved ${Object.keys(savedCreds).length} credential(s) + ` +
          `${Object.keys(savedMcps).length} MCP server(s)`,
        'success',
      );
      setRawJsonOpen(false);
    } catch (err) {
      setRawJsonError(`Save failed: ${(err as Error).message}`);
    }
  }

  /** Bulk overwrite the entire credentials.json with the uploaded file.
   *  Hard confirm prompt — overwrite is destructive in a way per-entry
   *  edits aren't. Accepts either the flat `{name: entry}` shape (a
   *  raw credentials.json) or a wrapped `{schema: "sammy-connections/v1",
   *  credentials: {...}}` payload (forward-compat). */
  function importAll(): void {
    const g = globalThis as unknown as {
      document?: {
        createElement(t: string): {
          type: string;
          accept: string;
          onchange: ((e: unknown) => void) | null;
          click(): void;
        };
      };
      confirm?: (msg: string) => boolean;
    };
    if (!g.document) return;
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
          toast.show('Import file must be a JSON object', 'error');
          return;
        }
        // Forward-compat: accept a wrapped {schema, credentials} shape too.
        const incoming =
          parsed.schema === 'sammy-connections/v1' && parsed.credentials
            ? (parsed.credentials as Record<string, Credential>)
            : (parsed as Record<string, Credential>);
        const incomingCount = Object.keys(incoming).length;
        const currentCount = Object.keys(registry).length;
        const ok =
          g.confirm?.(
            `Overwrite ${currentCount} existing connection(s) with ${incomingCount} from the uploaded file? This cannot be undone.`,
          ) ?? true;
        if (!ok) return;
        const saved = await saveCredentials(incoming as CredentialsMap);
        setRegistry(saved);
        toast.show(`Imported ${incomingCount} connection(s)`, 'success');
      } catch (err) {
        toast.show(`Import failed: ${(err as Error).message}`, 'error');
      }
    };
    input.click();
  }

  // Group custom (non-legacy-connector) entries by kindGroup for
  // display. Legacy-connector entries (kind matches LEGACY_TO_KIND)
  // surface inside the existing connector cards instead.
  const legacyKindIds = new Set(Object.values(LEGACY_TO_KIND));
  const customEntries = Object.entries(registry).filter(
    ([, entry]) => entry.kind && !legacyKindIds.has(entry.kind),
  );
  const grouped: Record<string, Array<[string, Credential]>> = {};
  for (const [name, entry] of customEntries) {
    const g = kindGroup(entry.kind ?? 'secret');
    (grouped[g] ??= []).push([name, entry]);
  }

  return (
    <Page
      title="Connections"
      subtitle="auth credentials for the data sources your agents read">
      <Hint>
        Connections are stored in the workspace credentials.json registry
        (path: <Text style={styles.code}>credentials.json</Text>, or wherever
        <Text style={styles.code}> SAMMY_CONNECTIONS_FILE</Text> points). Per-node{' '}
        <Text style={styles.code}>credential: "name"</Text> resolves against this
        registry; MCP server <Text style={styles.code}>env</Text> blocks can
        reference entries with{' '}
        <Text style={styles.code}>{'${connections:name.value}'}</Text>.
      </Hint>

      <Card title="Export / Import all">
        <Hint>
          Bulk round-trip the entire connections registry as a single JSON
          file. Use this to move credentials to a new machine, share a
          team-wide setup, or stash a snapshot before destructive edits.
          For per-entry editing, use the cards below.
        </Hint>
        <View style={styles.buttonRow}>
          <Pressable onPress={exportAll} style={styles.saveButton}>
            <Text style={styles.saveButtonText}>↓ Export all</Text>
          </Pressable>
          <Pressable onPress={importAll} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>↑ Import all</Text>
          </Pressable>
        </View>
        <Hint>
          Import OVERWRITES the entire registry with the uploaded file's
          contents. You'll get a confirm prompt first. For an additive merge
          (legacy data → kind-tagged entries), use the Migration helper below.
        </Hint>
      </Card>

      <Card title="Migration helper">
        <Hint>
          Have legacy data in browser localStorage, env vars, or inline MCP env
          blocks? Run this to hoist them all into the unified registry as
          kind-tagged entries. Idempotent — safe to re-run; existing entries
          are merged, not clobbered.
        </Hint>
        <View style={styles.buttonRow}>
          <Pressable onPress={() => runImport(true)} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Preview import</Text>
          </Pressable>
          <Pressable onPress={() => runImport(false)} style={styles.saveButton}>
            <Text style={styles.saveButtonText}>Import existing config</Text>
          </Pressable>
        </View>
        {importPreview && (
          <View style={styles.field}>
            <Text style={styles.label}>Preview</Text>
            <Text style={styles.code}>
              + added: {importPreview.added.join(', ') || '(none)'}
              {'\n'}~ updated: {importPreview.updated.join(', ') || '(none)'}
              {'\n'}= unchanged: {importPreview.unchanged.join(', ') || '(none)'}
              {'\n'}- skipped: {importPreview.skipped.length} item(s)
            </Text>
          </View>
        )}
      </Card>

      <SectionTitle>Legacy provider connections</SectionTitle>
      {PROVIDERS.map(p => (
        <ConnectionCard
          key={p.id}
          provider={p}
          existingEntry={registry[p.id]}
          usage={usage[p.id]}
          onSaved={refresh}
        />
      ))}

      <SectionTitle>Custom connections</SectionTitle>
      {loading && <Hint>Loading…</Hint>}
      {!loading && Object.keys(grouped).length === 0 && (
        <Hint>
          No custom connections yet. Click "+ Add connection" below to add an
          Atlassian / GitHub MCP credential, AWS SSO, A2A endpoint, or any
          named secret.
        </Hint>
      )}
      {Object.entries(grouped).map(([group, entries]) => (
        <View key={group} style={styles.groupBlock}>
          <Text style={styles.groupHeading}>{group}</Text>
          {entries.map(([name, entry]) => (
            <View key={name}>
              <CustomConnectionCard
                name={name}
                entry={entry}
                usage={usage[name]}
                onEdit={() => setEditing({ name, entry })}
                onDelete={() => deleteEntry(name)}
              />
              {/* The edit form opens right under the card that was
                  clicked — at the bottom of this long page it read as a
                  dead button. */}
              {editing?.name === name && (
                <ConnectionForm
                  key={`edit-${name}`}
                  mode="edit"
                  initialName={editing.name}
                  initialEntry={editing.entry}
                  kind={getKindDef(editing.entry.kind ?? 'secret')}
                  onCancel={() => setEditing(null)}
                  onSave={async (newName, newEntry) => {
                    await upsertEntry(newName, newEntry);
                    setEditing(null);
                  }}
                />
              )}
            </View>
          ))}
        </View>
      ))}

      <KindPicker
        registry={registry}
        mcpRegistry={mcpRegistry}
        currentKind={addingKind}
        onPick={kind => setAddingKind(kind)}
        onCancel={() => setAddingKind(null)}
        onSave={async (name, entry) => {
          await upsertEntry(name, entry);
          setAddingKind(null);
        }}
      />

      {/* Power-user raw JSON — gated by confirm prompt because it
       *  unmasks every secret on screen. Disclosure pattern matches
       *  the MCP / Hooks panels in Settings. */}
      <Card title="Advanced">
        {!rawJsonOpen && (
          <>
            <Hint>
              Edit credentials.json directly. Useful for bulk renames, paste-from-vault
              workflows, or anything the field forms don't cover.
            </Hint>
            <View style={styles.buttonRow}>
              <Pressable onPress={openRawJsonEditor} style={styles.clearButton}>
                <Text style={styles.clearButtonText}>
                  ▸ Edit raw JSON (shows secrets)
                </Text>
              </Pressable>
            </View>
          </>
        )}
        {rawJsonOpen && (
          <View style={styles.field}>
            <Hint>
              <Text style={{ fontWeight: '700' }}>Secrets visible.</Text> Every API
              key, token, and OAuth credential is shown in plain text below. Save
              applies the file directly to <Text style={styles.code}>credentials.json</Text>;
              changes are immediately visible to runs.
            </Hint>
            <TextInput
              value={rawJsonText}
              onChangeText={setRawJsonText}
              style={[styles.input, styles.codeInput, { minHeight: 320 }]}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            {rawJsonError && (
              <Text style={{ color: '#dc2626', fontSize: 12, fontWeight: '500' }}>
                {rawJsonError}
              </Text>
            )}
            <View style={styles.buttonRow}>
              <Pressable onPress={saveRawJsonEditor} style={styles.saveButton}>
                <Text style={styles.saveButtonText}>Save JSON</Text>
              </Pressable>
              <Pressable onPress={closeRawJsonEditor} style={styles.clearButton}>
                <Text style={styles.clearButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}
      </Card>

    </Page>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Legacy connector card — dual-writes to localStorage AND credentials.json
// ─────────────────────────────────────────────────────────────────────

function ConnectionCard({
  provider,
  existingEntry,
  usage,
  onSaved,
}: {
  provider: Provider;
  existingEntry: Credential | undefined;
  usage?: UsageRow;
  onSaved: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Token stays masked (secureTextEntry) by default so a stored secret
  // isn't shown in cleartext on a shared screen; the reveal toggle below
  // lets the user check what they pasted.
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const toast = useToast();

  useEffect(() => {
    // Prefer the registry value when present (source of truth);
    // fall back to localStorage so users with pre-registry data still
    // see their token until they click Save (which dual-writes).
    const fromRegistry = existingEntry?.value ?? '';
    setToken(fromRegistry || getConnectionToken(provider.id) || '');
    const next: Record<string, string> = {};
    for (const f of provider.extras ?? []) {
      const fromReg = existingEntry?.fields?.[f.key];
      next[f.key] = fromReg ?? getConnectionField(provider.id, f.key) ?? '';
    }
    setExtras(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingEntry?.value, existingEntry?.fields]);

  async function save(): Promise<void> {
    // Local cache (for parity with pre-registry UX + instant UI feedback).
    setConnectionToken(provider.id, token);
    for (const f of provider.extras ?? []) {
      setConnectionField(provider.id, f.key, extras[f.key] ?? '');
    }
    // Registry (the source of truth — what orchestrations + the server
    // actually read).
    try {
      const kindId = LEGACY_TO_KIND[provider.id];
      const fields: Record<string, string> = {};
      for (const f of provider.extras ?? []) {
        if (extras[f.key]?.trim()) fields[f.key] = extras[f.key].trim();
      }
      const entry: Credential = {
        value: token.trim(),
        kind: kindId as Credential['kind'],
      };
      if (Object.keys(fields).length > 0) entry.fields = fields;
      const next = await getCredentials();
      next[provider.id] = entry;
      await saveCredentials(next);
      await onSaved();
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
      toast.show(`Saved ${provider.label} credentials`, 'success');
    } catch (err) {
      toast.show(
        `Saved to browser only; registry save failed: ${(err as Error).message}`,
        'error',
      );
    }
  }

  async function clear(): Promise<void> {
    setConnectionToken(provider.id, '');
    for (const f of provider.extras ?? []) {
      setConnectionField(provider.id, f.key, '');
    }
    setToken('');
    setExtras({});
    try {
      const next = await getCredentials();
      delete next[provider.id];
      await saveCredentials(next);
      await onSaved();
    } catch (err) {
      toast.show(`Registry clear failed: ${(err as Error).message}`, 'error');
    }
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2000);
    toast.show(`Cleared ${provider.label} credentials`, 'info');
  }

  const stored = existingEntry?.value || getConnectionToken(provider.id);
  const masked = stored
    ? stored.length > 10
      ? `${stored.slice(0, 6)}…${stored.slice(-4)}`
      : SHORT_VALUE_MASK
    : 'not set';

  return (
    <Card
      title={provider.label}
      subtitle={provider.description}
      right={
        stored ? <Text style={styles.connectedBadge}>connected</Text> : null
      }>
      <View style={styles.field}>
        <Text style={styles.label}>{provider.tokenLabel}</Text>
        <View style={styles.secretRow}>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder={provider.tokenPlaceholder}
            style={[styles.input, styles.secretInput]}
            secureTextEntry={!tokenRevealed}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={() => setTokenRevealed(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={tokenRevealed ? 'Hide token' : 'Show token'}
            style={styles.revealButton}>
            <Text style={styles.revealButtonText}>
              {tokenRevealed ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        </View>
        <Hint>
          Current: <Text style={styles.code}>{masked}</Text> · {provider.tokenHelp}
        </Hint>
      </View>
      {(provider.extras ?? []).map(f => (
        <View key={f.key} style={styles.field}>
          <Text style={styles.label}>{f.label}</Text>
          <TextInput
            value={extras[f.key] ?? ''}
            onChangeText={t => setExtras(prev => ({ ...prev, [f.key]: t }))}
            placeholder={f.placeholder}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {f.helpText && <Hint>{f.helpText}</Hint>}
        </View>
      ))}
      <View style={styles.buttonRow}>
        <Pressable onPress={save} style={styles.saveButton}>
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
        {stored && (
          <Pressable onPress={clear} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </Pressable>
        )}
        {stored && (
          <LegacyTestButton providerId={provider.id} />
        )}
        {savedAt && <Text style={styles.savedNote}>Saved.</Text>}
      </View>
      <UsedByFooter name={provider.id} usage={usage} />
    </Card>
  );
}

/** Small inline component for the legacy provider cards — wraps the
 *  same testConnection() call the CustomConnectionCard uses. Lives
 *  here (not in the main card body) so the connected provider gets
 *  the same Test affordance without bloating the legacy card's local
 *  state. */
function LegacyTestButton({ providerId }: { providerId: string }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  async function probe(): Promise<void> {
    setTesting(true);
    setResult(null);
    try {
      const r = await testConnection({ name: providerId });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable
        onPress={probe}
        disabled={testing}
        style={[styles.clearButton, testing && { opacity: 0.5 }]}>
        <Text style={styles.clearButtonText}>
          {testing ? 'Testing…' : 'Test'}
        </Text>
      </Pressable>
      {result && (
        <Text
          style={result.ok ? styles.testOkInline : styles.testFailInline}>
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </Text>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Custom connection card (kind-tagged entries beyond the 8 legacy ones)
// ─────────────────────────────────────────────────────────────────────

function CustomConnectionCard({
  name,
  entry,
  usage,
  onEdit,
  onDelete,
}: {
  name: string;
  entry: Credential;
  /** Reverse-index row for this credential — { directRefs[], viaMcp[] }.
   *  Undefined when the server-side walk hasn't completed yet (still
   *  render the rest of the card without the footer). */
  usage?: UsageRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const kindDef = getKindDef(entry.kind ?? 'secret');
  const masked = entry.value
    ? entry.value.length > 10
      ? `${entry.value.slice(0, 6)}…${entry.value.slice(-4)}`
      : SHORT_VALUE_MASK
    : '—';
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const canProbe = !!(kindDef?.testProbe || entry.kind === 'a2a');
  async function probe(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ name });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }
  return (
    <Card
      title={name}
      subtitle={kindDef?.label ?? entry.kind ?? 'secret'}
      right={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {canProbe && (
            <Pressable
              onPress={probe}
              disabled={testing}
              style={[styles.clearButton, testing && { opacity: 0.5 }]}>
              <Text style={styles.clearButtonText}>
                {testing ? 'Testing…' : 'Test'}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={onEdit} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Edit</Text>
          </Pressable>
          <Pressable onPress={onDelete} style={styles.dangerButton}>
            <Text style={styles.dangerButtonText}>Delete</Text>
          </Pressable>
        </View>
      }>
      <View style={styles.field}>
        <Text style={styles.label}>Value</Text>
        <Text style={styles.code}>{masked}</Text>
      </View>
      {entry.url && (
        <View style={styles.field}>
          <Text style={styles.label}>URL</Text>
          <Text style={styles.code}>{entry.url}</Text>
        </View>
      )}
      {entry.fields && Object.keys(entry.fields).length > 0 && (
        <View style={styles.field}>
          <Text style={styles.label}>Fields</Text>
          {Object.entries(entry.fields).map(([k, v]) => (
            <Text key={k} style={styles.code}>
              {k}: {v}
            </Text>
          ))}
        </View>
      )}
      {entry.env && Object.keys(entry.env).length > 0 && (
        <View style={styles.field}>
          <Text style={styles.label}>MCP env</Text>
          {Object.entries(entry.env).map(([k, v]) => (
            <Text key={k} style={styles.code}>
              {k}: {String(v).slice(0, 80)}
            </Text>
          ))}
        </View>
      )}
      {entry.ref && (
        <Hint>
          Linked to mcp/servers.json entry:{' '}
          <Text style={styles.code}>{entry.ref}</Text>
        </Hint>
      )}
      {testResult && (
        <View
          style={testResult.ok ? styles.testOkBox : styles.testFailBox}>
          <Text style={testResult.ok ? styles.testOkText : styles.testFailText}>
            {testResult.ok ? '✓ ' : '✗ '}
            {testResult.message}
            {testResult.probedUrl ? ` — ${testResult.probedUrl}` : ''}
          </Text>
        </View>
      )}
      <UsedByFooter name={name} usage={usage} />
    </Card>
  );
}

/** Reverse-index footer rendered on every card. Answers "which
 *  orchestrations use this credential" — without it, the blast radius of
 *  rotating or deleting one is invisible from the page that owns it.
 *  Two flavors: direct refs (`credential: "name"` on a node) +
 *  transitive (via MCP server whose env block points here). Zero
 *  refs renders nothing — keeps the card tight when usage is empty. */
function UsedByFooter({
  name,
  usage,
}: {
  name: string;
  usage?: UsageRow;
}) {
  const row = usage;
  const direct = row?.directRefs ?? [];
  const viaMcp = row?.viaMcp ?? [];
  const total = direct.length + viaMcp.length;
  if (total === 0) return null;
  return (
    <View style={styles.usedByBox}>
      <Text style={styles.usedByLabel}>
        Used by {total} orchestration{total === 1 ? '' : 's'}
      </Text>
      {direct.length > 0 && (
        <Text style={styles.usedByItem}>
          Direct: {direct.join(', ')}
        </Text>
      )}
      {viaMcp.length > 0 && (
        <Text style={styles.usedByItem}>
          Via MCP:{' '}
          {viaMcp
            .map((v: { orch: string; mcpName: string }) => `${v.orch} (${v.mcpName})`)
            .join(', ')}
        </Text>
      )}
      <Text style={styles.usedByHint}>
        Renaming or deleting <Text style={styles.code}>{name}</Text> will
        affect these. Edit those orchestrations first if you're changing the
        name.
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// + Add connection — kind picker + form
// ─────────────────────────────────────────────────────────────────────

/** The env block as the form will send it: the textarea's JSON when it
 *  parses to an object, undefined otherwise (empty, or malformed — the form
 *  already shows the raw text). One reading for both the re-enter rule and
 *  the save, so the two cannot disagree about what is being sent. */
function parseEnvJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — silently skip; the form already shows the raw text.
  }
  return undefined;
}

/** A hand-written entry's request headers. Not part of the typed shape
 *  (the server keeps it untyped too) but masked and restored like `env`, so
 *  the form must carry it the same way. */
function headersOf(entry: Credential | undefined): Record<string, unknown> | undefined {
  const h = (entry as { headers?: unknown } | undefined)?.headers;
  return h && typeof h === 'object' && !Array.isArray(h)
    ? (h as Record<string, unknown>)
    : undefined;
}

function KindPicker({
  registry,
  mcpRegistry,
  currentKind,
  onPick,
  onCancel,
  onSave,
}: {
  registry: CredentialsMap;
  mcpRegistry: McpRegistry;
  currentKind: string | null;
  onPick: (kind: string) => void;
  onCancel: () => void;
  onSave: (name: string, entry: Credential) => Promise<void>;
}) {
  if (currentKind) {
    const def = getKindDef(currentKind);
    if (!def) return null;
    return (
      <ConnectionForm
        mode="add"
        kind={def}
        registry={registry}
        mcpRegistry={mcpRegistry}
        onCancel={onCancel}
        onSave={onSave}
      />
    );
  }
  // Group available kinds by category for the picker grid.
  const grouped: Record<string, ConnectionKindDef[]> = {};
  for (const def of KIND_REGISTRY) {
    (grouped[kindGroup(def.id)] ??= []).push(def);
  }
  return (
    <Card title="+ Add connection">
      <Hint>Pick a kind to add. Each kind ships with the right field form.</Hint>
      {Object.entries(grouped).map(([group, defs]) => (
        <View key={group} style={styles.field}>
          <Text style={styles.label}>{group}</Text>
          <View style={styles.kindRow}>
            {defs.map(def => (
              <Pressable
                key={def.id}
                onPress={() => onPick(def.id)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${def.label} connection`}
                style={styles.kindChip}>
                <Text style={styles.kindChipText}>{def.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </Card>
  );
}

function ConnectionForm({
  mode,
  kind,
  registry,
  mcpRegistry,
  initialName,
  initialEntry,
  onCancel,
  onSave,
}: {
  mode: 'add' | 'edit';
  kind: ConnectionKindDef | undefined;
  registry?: CredentialsMap;
  /** Passed by ConnectionsPage so the form can detect an existing MCP
   *  server with an inline secret and offer to lift it. Optional —
   *  Edit-mode forms don't pass it. */
  mcpRegistry?: McpRegistry;
  initialName?: string;
  initialEntry?: Credential;
  onCancel: () => void;
  onSave: (name: string, entry: Credential) => Promise<void>;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [description, setDescription] = useState(initialEntry?.description ?? '');
  // ─── Hoist-from-MCP detection ───
  // If the kind ships an `mcpServerName` + `mcpSecretEnvKey` AND a
  // matching MCP server exists with an inline literal in that env key,
  // surface a one-click "use that token" button. Refs like
  // `${connections:foo.value}` are NOT hoist candidates — those are
  // already wired through the registry and re-prefilling them would
  // create a circular reference.
  const hoistMatch = (() => {
    if (mode !== 'add') return null;
    if (!kind?.mcpServerName || !kind?.mcpSecretEnvKey || !mcpRegistry) return null;
    const server = mcpRegistry[kind.mcpServerName] as
      | { env?: Record<string, string> }
      | undefined;
    const raw = server?.env?.[kind.mcpSecretEnvKey];
    if (typeof raw !== 'string' || !raw.trim()) return null;
    if (raw.includes('${connections:')) return null;
    return { serverName: kind.mcpServerName, envKey: kind.mcpSecretEnvKey, value: raw };
  })();
  const [hoistDismissed, setHoistDismissed] = useState(false);
  // Per-field reveal state for `secret` inputs — keyed by field.key. Secret
  // fields render masked (secureTextEntry) by default; toggling adds the key
  // here to show the value in cleartext.
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [topFields, setTopFields] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (initialEntry) {
      for (const key of ['value', 'url', 'ssoStartUrl', 'ssoRegion', 'accountId', 'roleName', 'ref'] as const) {
        const v = initialEntry[key];
        if (typeof v === 'string') out[key] = v;
      }
    }
    return out;
  });
  const [extraFields, setExtraFields] = useState<Record<string, string>>(
    initialEntry?.fields ?? {},
  );
  // The server masks env values on GET — a short one to the fixed
  // SHORT_VALUE_MASK, never '' — so what it sent is what the editor shows:
  // a stored value is visibly a stored value, an empty one is visibly empty,
  // and the masks go back as they came for the server to restore.
  const [envJson, setEnvJson] = useState<string>(
    initialEntry?.env ? JSON.stringify(initialEntry.env, null, 2) : '',
  );

  if (!kind) return null;
  const nameTaken =
    mode === 'add' && registry ? Boolean(registry[name.trim()]) : false;
  // The server refuses to move an entry (url / fields / owners /
  // orchestrations) while ANY of its secrets is the restored mask — see
  // `secretReentryRequired`. Decide it here, before Save, so the rule is a
  // required field with a hint instead of a 400 after the fact. The draft
  // is what `handleSave` sends: the blocks the form has no controls for
  // (cache, headers, env outside an mcp-server) ride along unchanged.
  const draft: CredentialDraft = {
    value: topFields.value ?? '',
    env: parseEnvJson(envJson),
    cache: initialEntry?.cache,
    headers: headersOf(initialEntry),
    url: topFields.url,
    fields: extraFields,
    owners: initialEntry?.owners,
    orchestrations: initialEntry?.orchestrations,
  };
  const masked = mode === 'edit' ? maskedSecretBlocks(draft, initialEntry) : [];
  const reentry = mode === 'edit' ? secretReentryRequired(draft, initialEntry) : null;
  // The value field is not always the secret the server is protecting: the
  // other masked blocks get their own note, and the ones this form has no
  // control for (an SSO cache, hand-written headers, a hand-written
  // `fields` secret, env on a kind without the env textarea) can only be
  // retyped through the raw JSON editor.
  const envEditable = kind.id === 'mcp-server';
  // Which `fields` keys are holding the save up. A masked key the active
  // kind declares no control for (a hand-written `fields.apiToken`) has
  // nowhere to be retyped in this form, so it belongs in the note that
  // points at the raw JSON editor rather than beside an input.
  const maskedFields = mode === 'edit' ? maskedFieldKeys(draft, initialEntry) : [];
  const otherMasked = masked.filter(b => b !== 'value');
  const unreenterable = otherMasked.filter(b => {
    if (b === 'env') return !envEditable;
    if (b === 'fields') {
      return maskedFields.some(
        k => !kind.fields.some(f => f.location === 'fields' && f.key === k),
      );
    }
    return true;
  });

  function setFieldValue(field: KindField, value: string): void {
    if (field.location === 'fields') {
      setExtraFields(prev => ({ ...prev, [field.key]: value }));
    } else {
      setTopFields(prev => ({ ...prev, [field.key]: value }));
    }
    // Moving a destination field while the value field still holds the
    // mask the server sent: clear it, so the operator sees a field that
    // must be filled rather than one that looks full of a secret.
    const movesDestination = field.location === 'fields' || field.key === 'url';
    if (
      mode === 'edit' &&
      movesDestination &&
      initialEntry?.value &&
      topFields.value === initialEntry.value
    ) {
      setTopFields(prev => ({ ...prev, value: '' }));
    }
  }
  function getFieldValue(field: KindField): string {
    if (field.location === 'fields') return extraFields[field.key] ?? '';
    return topFields[field.key] ?? '';
  }

  async function handleSave(): Promise<void> {
    const finalName = name.trim();
    if (!finalName) return;
    const entry: Credential = {
      kind: kind!.id,
      authMethod: kind!.defaultAuthMethod as Credential['authMethod'],
      value: (topFields.value ?? '').trim(),
    };
    if (description.trim()) entry.description = description.trim();
    for (const key of ['url', 'ssoStartUrl', 'ssoRegion', 'accountId', 'roleName', 'ref'] as const) {
      const v = topFields[key]?.trim();
      if (v) entry[key] = v;
    }
    const cleanFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(extraFields)) {
      if (v?.trim()) cleanFields[k] = v.trim();
    }
    if (Object.keys(cleanFields).length > 0) entry.fields = cleanFields;
    const env = parseEnvJson(envJson);
    if (env) entry.env = env as Record<string, string>;
    // The form has no controls for the audience lists; carry them over
    // unchanged, or every edit of a scoped entry reads as a move of
    // `owners` / `orchestrations` (refused while masked, silently
    // de-scoped once the secret is re-typed). Likewise an `aws` entry's
    // SSO cache and a hand-written `headers` block: the server restores
    // their masked secrets from disk only when they are sent back, and
    // drops them otherwise.
    if (mode === 'edit' && initialEntry) {
      if (initialEntry.owners) entry.owners = initialEntry.owners;
      if (initialEntry.orchestrations) {
        entry.orchestrations = initialEntry.orchestrations;
      }
      if (initialEntry.cache) entry.cache = initialEntry.cache;
      const headers = headersOf(initialEntry);
      if (headers) (entry as { headers?: unknown }).headers = headers;
    }
    await onSave(finalName, entry);
  }

  return (
    <Card title={mode === 'add' ? `+ Add ${kind.label}` : `Edit: ${initialName}`}>
      <Hint>{kind.description}</Hint>
      {kind.limitations && kind.limitations.length > 0 && (
        <View style={styles.limitationsBox}>
          <Text style={styles.limitationsTitle}>Known limitations</Text>
          {kind.limitations.map((line, i) => (
            <Text key={i} style={styles.limitationsItem}>
              • {line}
            </Text>
          ))}
        </View>
      )}
      {hoistMatch && !hoistDismissed && (
        <View style={styles.hoistBox}>
          <Text style={styles.hoistTitle}>
            Found a token in your MCP config
          </Text>
          <Text style={styles.hoistBody}>
            The MCP server <Text style={styles.code}>{hoistMatch.serverName}</Text>
            {' '}already has an inline value for{' '}
            <Text style={styles.code}>{hoistMatch.envKey}</Text>. Use it here
            so you don't have to re-paste the token? After save you should
            edit the MCP server's env block to read{' '}
            <Text style={styles.code}>
              {`\${connections:${name || '<name>'}.value}`}
            </Text>{' '}
            instead of the inline value.
          </Text>
          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => {
                setTopFields(prev => ({ ...prev, value: hoistMatch.value }));
                setHoistDismissed(true);
              }}
              style={styles.saveButton}>
              <Text style={styles.saveButtonText}>Use it</Text>
            </Pressable>
            <Pressable
              onPress={() => setHoistDismissed(true)}
              style={styles.clearButton}>
              <Text style={styles.clearButtonText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      )}
      <View style={styles.field}>
        <Text style={styles.label}>Entry name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. atlassian-prod"
          style={[styles.input, nameTaken && styles.inputError]}
          autoCapitalize="none"
          autoCorrect={false}
          editable={mode === 'add'}
        />
        {nameTaken && (
          <Hint>An entry with this name already exists — pick another.</Hint>
        )}
      </View>
      {kind.fields.map(field => {
        const isSecret = field.type === 'secret';
        const revealed = !!revealedSecrets[field.key];
        const needsReentry =
          reentry !== null &&
          ((field.location === 'value' && masked.includes('value')) ||
            (field.location === 'fields' && maskedFields.includes(field.key)));
        const input = (
          <TextInput
            value={getFieldValue(field)}
            onChangeText={t => setFieldValue(field, t)}
            placeholder={field.placeholder}
            accessibilityLabel={field.label}
            style={[
              styles.input,
              isSecret && styles.secretInput,
              needsReentry && styles.inputError,
            ]}
            secureTextEntry={isSecret && !revealed}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={field.type === 'email' ? 'email-address' : 'default'}
          />
        );
        return (
          <View key={field.key} style={styles.field}>
            <Text style={styles.label}>
              {field.label}
              {field.required || needsReentry ? ' *' : ''}
            </Text>
            {isSecret ? (
              <View style={styles.secretRow}>
                {input}
                <Pressable
                  onPress={() =>
                    setRevealedSecrets(prev => ({ ...prev, [field.key]: !prev[field.key] }))
                  }
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? `Hide ${field.label}` : `Show ${field.label}`}
                  style={styles.revealButton}>
                  <Text style={styles.revealButtonText}>
                    {revealed ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              input
            )}
            {needsReentry && (
              <Text style={styles.reentryHint}>
                Re-enter the secret to change `{reentry}`. The server keeps
                the stored secret when an entry is saved without it, but will
                not send that secret somewhere new, or let someone new use
                it, on the word of a caller who never saw it.
              </Text>
            )}
            {field.helpText ? <Hint>{field.helpText}</Hint> : null}
          </View>
        );
      })}
      {envEditable && (
        <View style={styles.field}>
          <Text style={styles.label}>
            Env block (JSON)
            {reentry !== null && masked.includes('env') ? ' *' : ''}
          </Text>
          <TextInput
            value={envJson}
            onChangeText={setEnvJson}
            accessibilityLabel="Env block (JSON)"
            placeholder={'{\n  "ATLASSIAN_TOKEN": "${connections:atlassian-prod.value}"\n}'}
            style={[
              styles.input,
              styles.codeInput,
              reentry !== null && masked.includes('env') && styles.inputError,
            ]}
            multiline
            numberOfLines={6}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Hint>
            Each key becomes an env var in the MCP subprocess. Values can
            reference other connection entries with{' '}
            <Text style={styles.code}>{'${connections:other.value}'}</Text>.
          </Hint>
        </View>
      )}
      {reentry !== null && otherMasked.length > 0 && (
        <Text style={styles.reentryHint}>
          Re-enter every masked secret in `{otherMasked.join('`, `')}` to change
          `{reentry}` — the server will not send a secret it had to restore
          somewhere new.
          {unreenterable.length > 0 &&
            ` This form has no field for \`${unreenterable.join('`, `')}\`: retype it in the raw JSON editor below, or delete and re-add the entry.`}
        </Text>
      )}
      <View style={styles.field}>
        <Text style={styles.label}>Description (optional)</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What this connection is for"
          style={styles.input}
        />
      </View>
      <View style={styles.buttonRow}>
        <Pressable
          onPress={handleSave}
          accessibilityLabel={mode === 'add' ? 'Add connection' : 'Save changes'}
          style={[styles.saveButton, reentry !== null && { opacity: 0.5 }]}
          disabled={!name || nameTaken || reentry !== null}>
          <Text style={styles.saveButtonText}>
            {mode === 'add' ? 'Add connection' : 'Save changes'}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.clearButton}>
          <Text style={styles.clearButtonText}>Cancel</Text>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  code: {
    fontFamily: 'Menlo',
    fontSize: 11,
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  codeInput: {
    fontFamily: 'Menlo',
    fontSize: 11,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  connectedBadge: {
    fontSize: 10,
    color: '#065f46',
    backgroundColor: '#ecfdf5',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    fontWeight: '700',
  },
  field: { gap: 4 },
  groupBlock: { gap: 8 },
  groupHeading: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
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
  inputError: { borderColor: '#dc2626' },
  reentryHint: { fontSize: 11, color: '#b91c1c', lineHeight: 15 },
  // Masked secret input + inline Show/Hide reveal toggle.
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  secretInput: { flex: 1 },
  revealButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
  },
  revealButtonText: { fontSize: 12, color: '#374151', fontWeight: '600' },
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
  dangerButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 6,
  },
  dangerButtonText: { color: '#dc2626', fontWeight: '500', fontSize: 12 },
  savedNote: { fontSize: 12, color: '#059669', fontWeight: '500' },
  kindRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  kindChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  kindChipText: { fontSize: 12, color: '#111827' },
  limitationsBox: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 6,
    padding: 10,
    gap: 4,
    marginTop: 4,
  },
  limitationsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  limitationsItem: { fontSize: 12, color: '#78350f', lineHeight: 17 },
  hoistBox: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 6,
    padding: 10,
    gap: 8,
    marginTop: 4,
  },
  hoistTitle: { fontSize: 13, fontWeight: '700', color: '#1e40af' },
  hoistBody: { fontSize: 12, color: '#1e3a8a', lineHeight: 17 },
  testOkBox: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
    borderRadius: 4,
    padding: 6,
  },
  testOkText: { color: '#065f46', fontSize: 12, fontWeight: '500' },
  testFailBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 4,
    padding: 6,
  },
  testFailText: { color: '#991b1b', fontSize: 12, fontWeight: '500' },
  testOkInline: { color: '#065f46', fontSize: 11, fontWeight: '500' },
  testFailInline: { color: '#991b1b', fontSize: 11, fontWeight: '500' },
  usedByBox: {
    backgroundColor: '#f9fafb',
    borderRadius: 4,
    padding: 8,
    gap: 3,
    marginTop: 4,
  },
  usedByLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  usedByItem: { fontSize: 12, color: '#4b5563' },
  usedByHint: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
});
