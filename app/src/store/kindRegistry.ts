/**
 * Kind registry — data-driven definitions for every kind of connection
 * that lives in the unified `credentials.json` registry. Used by:
 *
 *   - `ConnectionsPage`: renders Add-Connection forms from this table
 *     instead of hardcoding a component per kind. Adding a new kind =
 *     one entry here, no new component.
 *   - Import command (`/api/credentials/import`): knows how to map
 *     legacy `sammy.connection.<type>.<field>` localStorage entries
 *     and `mcp/servers.json` env blocks onto kind-tagged credentials.
 *   - Validation hint surface: each kind declares its required fields
 *     so the UI can red-line missing data before save.
 *
 * Conventions:
 *   - `value` is always the primary secret (PAT, API key, OAuth token).
 *     Non-secret companion fields live under `fields:` keyed by the
 *     same names the legacy localStorage entries used.
 *   - Auth-method-specific kinds (`aws-sso`) override `secret: false`
 *     for fields the user never types (token cache, etc.).
 */

import type {
  CredentialAuthMethod,
  CredentialKind,
} from '../server/credentials-store';

export type FieldType = 'text' | 'secret' | 'url' | 'email' | 'select';

export type KindField = {
  /** Storage key. For `fields:` entries this is the key under
   *  `Credential.fields`; for `value`/`url`/`ssoStartUrl`/etc. it
   *  matches the Credential top-level property name. */
  key: string;
  /** Where the field lives on the Credential entry. */
  location: 'value' | 'url' | 'fields' | 'env' | 'top';
  label: string;
  type: FieldType;
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  /** Options for `type: select`. */
  options?: Array<{ value: string; label: string }>;
};

export type ConnectionKindDef = {
  id: CredentialKind;
  label: string;
  description: string;
  /** Default `authMethod` for new entries of this kind. */
  defaultAuthMethod: CredentialAuthMethod;
  /** Field forms — rendered top-down by ConnectionsPage. */
  fields: KindField[];
  /** Optional health probe descriptor (URL template). The Connections
   *  UI surfaces a "Test connection" button when present; the probe is
   *  a HEAD/GET against the resolved URL with the bearer/api-token. */
  testProbe?: {
    method: 'GET' | 'HEAD';
    /** May reference `${value}` and `${fields.<key>}`. */
    urlTemplate: string;
    /** Auth header to send. */
    auth?: 'bearer' | 'basic-email-token' | 'api-key-header' | 'none';
    /** For api-key-header — the header name (e.g. `X-API-Key`). */
    headerName?: string;
  };
  /** When a user runs the one-shot Import command, this descriptor
   *  tells the server how to construct a kind-tagged credential from
   *  legacy data. Each entry says: "if the legacy `sammy.connection.<id>.token`
   *  localStorage entry has a value, write it as `value:`; for each
   *  legacy `sammy.connection.<id>.<field>` entry, write it under
   *  `fields.<field>`." */
  importFrom?: {
    legacyConnectionType?: string; // matches old ConnectionType id
    fieldKeys?: string[]; // which legacy fields to hoist into `fields:`
  };
  /** Marks this kind as one of the canonical provider names the
   *  per-node `provider: ...` field resolves against. The Connections
   *  UI surfaces a "default provider key" badge for these. */
  isProviderKey?: boolean;
  /** Known limitations of this connection at the service / SDK level.
   *  Surfaced in the Add/Edit form so users know upfront what won't
   *  work — much cheaper than discovering a missing capability at run
   *  time inside an agent. One short sentence per item. */
  limitations?: string[];
  /** Default `mcp/servers.json` key this kind pairs with. Used by
   *  hoist-from-MCP: when a user clicks "+ Add" for this kind and an
   *  MCP server with this name has an inline secret in its env block,
   *  the form is pre-filled with that value (so users don't re-type a
   *  token already configured elsewhere). */
  mcpServerName?: string;
  /** The env-block key inside the matched MCP server config that
   *  carries this kind's primary secret. Together with `mcpServerName`
   *  this lets the form locate and lift the value. */
  mcpSecretEnvKey?: string;
};

export const KIND_REGISTRY: ConnectionKindDef[] = [
  // ─── Generic secret (the original shape — every pre-kind entry parses as this) ───
  {
    id: 'secret',
    label: 'Generic secret',
    description: 'Any opaque string. Used for one-off API keys, webhook signing tokens, etc.',
    defaultAuthMethod: 'none',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Secret value',
        type: 'secret',
        required: true,
      },
    ],
  },

  // ─── LLM provider keys ───
  {
    id: 'anthropic',
    label: 'Anthropic API key',
    description: 'Direct-API-key auth for Claude. Used when `authMode: direct-api-key` is set.',
    defaultAuthMethod: 'api-key',
    isProviderKey: true,
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'API key',
        type: 'secret',
        placeholder: 'sk-ant-…',
        required: true,
        helpText: 'Create at console.anthropic.com.',
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API key',
    description: 'For nodes routed with `provider: "openai"`.',
    defaultAuthMethod: 'api-key',
    isProviderKey: true,
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'API key',
        type: 'secret',
        placeholder: 'sk-…',
        required: true,
        helpText: 'Create at platform.openai.com/api-keys.',
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini API key',
    description: 'For nodes routed with `provider: "gemini"`.',
    defaultAuthMethod: 'api-key',
    isProviderKey: true,
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'API key',
        type: 'secret',
        required: true,
        helpText: 'Create at aistudio.google.com/apikey.',
      },
    ],
  },

  // ─── Code hosts ───
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repos, PRs, issues, code search. Also feeds the GitHub MCP server.',
    defaultAuthMethod: 'api-token',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Personal access token',
        type: 'secret',
        placeholder: 'ghp_…',
        required: true,
        helpText: 'github.com/settings/tokens — classic, repo scope.',
      },
    ],
    testProbe: {
      method: 'GET',
      urlTemplate: 'https://api.github.com/user',
      auth: 'bearer',
    },
    importFrom: { legacyConnectionType: 'github' },
    mcpServerName: 'github',
    mcpSecretEnvKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    limitations: [
      'Classic PATs are per-user — actions show up as authored by you, not as a bot.',
      'Rate limit: 5,000 requests/hour authenticated. Heavy MCP tool runs (search, deep traversal) can hit it.',
      'No way to create draft PRs as a different author — orchestrations that fan out to many engineers all attribute to the token owner.',
      'Fine-grained tokens require explicit per-repo allow-listing; classic tokens just check scopes.',
    ],
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    description: 'Repos + PRs.',
    defaultAuthMethod: 'api-token',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'App password',
        type: 'secret',
        placeholder: 'ATBB…',
        required: true,
      },
      {
        key: 'workspace',
        location: 'fields',
        label: 'Workspace slug',
        type: 'text',
        placeholder: 'my-workspace',
      },
    ],
    importFrom: { legacyConnectionType: 'bitbucket', fieldKeys: ['workspace'] },
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    description: 'Repos + MRs (gitlab.com + self-hosted).',
    defaultAuthMethod: 'api-token',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Personal access token',
        type: 'secret',
        placeholder: 'glpat-…',
        required: true,
      },
      {
        key: 'baseUrl',
        location: 'fields',
        label: 'Base URL (blank for gitlab.com)',
        type: 'url',
        placeholder: 'https://gitlab.example.com',
      },
    ],
    importFrom: { legacyConnectionType: 'gitlab', fieldKeys: ['baseUrl'] },
  },

  // ─── Atlassian (Jira) ───
  {
    id: 'atlassian',
    label: 'Atlassian (Jira)',
    description: 'Tickets, sprints, comments. Also feeds the Atlassian MCP server.',
    defaultAuthMethod: 'api-token',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'API token',
        type: 'secret',
        placeholder: 'ATATT…',
        required: true,
        helpText: 'id.atlassian.com/manage-profile/security/api-tokens.',
      },
      {
        key: 'email',
        location: 'fields',
        label: 'Atlassian account email',
        type: 'email',
        placeholder: 'you@example.com',
        required: true,
      },
      {
        key: 'site',
        location: 'fields',
        label: 'Site URL',
        type: 'url',
        placeholder: 'https://your-team.atlassian.net',
        required: true,
      },
    ],
    testProbe: {
      method: 'GET',
      urlTemplate: '${fields.site}/rest/api/3/myself',
      auth: 'basic-email-token',
    },
    importFrom: { legacyConnectionType: 'jira', fieldKeys: ['email', 'siteUrl'] },
    mcpServerName: 'atlassian',
    mcpSecretEnvKey: 'ATLASSIAN_API_TOKEN',
    limitations: [
      'No image / file attachments — the MCP can read existing attachments but cannot upload new ones.',
      'Custom fields with screen-only visibility don\'t round-trip; the API returns null even when the UI shows a value.',
      'Comment threading is flat — replies surface as siblings, not nested children.',
      'Confluence + Jira share one API token, but the MCP only exposes Jira tools today.',
    ],
  },
  // Alias so the legacy 'jira' connector keeps a kind to land in after
  // import. Same registry shape as Atlassian — keeps existing
  // orchestrations referencing `jira` working unchanged. Note the
  // different field key (`siteUrl`) vs Atlassian's `site` — the
  // legacy ConnectionsPage hoisted it from `sammy.connection.jira.siteUrl`
  // localStorage, so we preserve that name here. The probe template
  // reflects that.
  {
    id: 'jira',
    label: 'Jira (legacy alias for Atlassian)',
    description: 'Same as Atlassian. Prefer the Atlassian kind for new entries.',
    defaultAuthMethod: 'api-token',
    fields: [
      { key: 'value', location: 'value', label: 'API token', type: 'secret', required: true },
      { key: 'email', location: 'fields', label: 'Account email', type: 'email', required: true },
      { key: 'siteUrl', location: 'fields', label: 'Site URL', type: 'url', required: true },
    ],
    testProbe: {
      method: 'GET',
      urlTemplate: '${fields.siteUrl}/rest/api/3/myself',
      auth: 'basic-email-token',
    },
    importFrom: { legacyConnectionType: 'jira', fieldKeys: ['email', 'siteUrl'] },
  },

  // ─── Linear / Figma / Notion / Slack ───
  {
    id: 'linear',
    label: 'Linear',
    description: 'Issues + cycles.',
    defaultAuthMethod: 'api-key',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Personal API key',
        type: 'secret',
        placeholder: 'lin_api_…',
        required: true,
      },
    ],
    testProbe: {
      method: 'GET',
      urlTemplate: 'https://api.linear.app/graphql',
      auth: 'bearer',
    },
    importFrom: { legacyConnectionType: 'linear' },
    mcpServerName: 'linear',
    mcpSecretEnvKey: 'LINEAR_API_KEY',
    limitations: [
      'Personal API keys act as you — every issue + comment is attributed to your user.',
      'GraphQL pagination is cursor-based; full-team queries can be expensive.',
      'No webhooks via API key — server-side workflows need OAuth instead.',
    ],
  },
  {
    id: 'figma',
    label: 'Figma',
    description: 'Design files + frames.',
    defaultAuthMethod: 'api-key',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Personal access token',
        type: 'secret',
        placeholder: 'figd_…',
        required: true,
      },
    ],
    importFrom: { legacyConnectionType: 'figma' },
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Docs + databases.',
    defaultAuthMethod: 'api-token',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Internal integration token',
        type: 'secret',
        placeholder: 'secret_…',
        required: true,
      },
    ],
    importFrom: { legacyConnectionType: 'notion' },
    mcpServerName: 'notion',
    mcpSecretEnvKey: 'NOTION_API_KEY',
    limitations: [
      'Only sees pages + databases explicitly shared with the integration — discovery is blind without sharing.',
      'No workspace-wide search; queries are scoped to shared resources.',
      'Page archival is reversible only by a workspace admin, not the integration.',
      'Property updates on database rows trigger automations; bulk edits can fan out unintended workflows.',
    ],
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Message + react via bot.',
    defaultAuthMethod: 'bearer',
    fields: [
      {
        key: 'value',
        location: 'value',
        label: 'Bot user token',
        type: 'secret',
        placeholder: 'xoxb-…',
        required: true,
      },
      {
        key: 'teamId',
        location: 'fields',
        label: 'Workspace team id',
        type: 'text',
        placeholder: 'T01234567',
      },
    ],
    importFrom: { legacyConnectionType: 'slack', fieldKeys: ['teamId'] },
    mcpServerName: 'slack',
    mcpSecretEnvKey: 'SLACK_BOT_TOKEN',
    limitations: [
      'Bot tokens (xoxb-) can\'t read DMs the bot isn\'t a member of — group + 1:1 visibility requires explicit invite.',
      'Rate limit varies by method tier; chat.postMessage is 1 msg/sec/channel.',
      'Threads need parent ts — replying without it posts to the channel, which is often unintended.',
      'Files >1GB don\'t upload via the API; chunked uploads aren\'t exposed in the MCP today.',
    ],
  },

  // ─── AWS (SSO, IAM role, access keys) ───
  {
    id: 'aws',
    label: 'AWS',
    description:
      'Pluggable AWS credential — SSO via IAM Identity Center, IAM role, or static access keys. Feeds Bedrock provider and AWS-backed tools.',
    defaultAuthMethod: 'sso',
    fields: [
      {
        key: 'ssoStartUrl',
        location: 'top',
        label: 'SSO start URL',
        type: 'url',
        placeholder: 'https://d-1234567890.awsapps.com/start',
        helpText: 'For SSO auth. Leave blank for static keys.',
      },
      {
        key: 'ssoRegion',
        location: 'top',
        label: 'SSO region',
        type: 'text',
        placeholder: 'us-west-2',
      },
      {
        key: 'accountId',
        location: 'top',
        label: 'AWS account ID',
        type: 'text',
        placeholder: '123456789012',
      },
      {
        key: 'roleName',
        location: 'top',
        label: 'Role name',
        type: 'text',
        placeholder: 'BedrockInvoker',
      },
      {
        key: 'value',
        location: 'value',
        label: 'Static access key (optional)',
        type: 'secret',
        placeholder: 'AKIA…',
        helpText: 'For static-key auth. SSO is recommended.',
      },
    ],
  },

  // ─── MCP server with env-block credential ───
  {
    id: 'mcp-server',
    label: 'MCP server credential',
    description:
      'Holds the env vars an MCP server subprocess needs (Atlassian token, GitHub PAT, etc.) so secrets live here, not inline in mcp/servers.json. Reference from the MCP entry with `${connections:<name>.env.<KEY>}`.',
    defaultAuthMethod: 'none',
    fields: [
      {
        key: 'ref',
        location: 'top',
        label: 'mcp/servers.json entry name',
        type: 'text',
        placeholder: 'atlassian',
        helpText: 'The key in mcp/servers.json this credential supplies env for.',
      },
      {
        key: 'value',
        location: 'value',
        label: 'Primary token (optional)',
        type: 'secret',
        helpText:
          'Free-form — typically the same token referenced from the env block below.',
      },
    ],
    // env block is edited via raw JSON for now; the kind-picker form
    // shows a textarea fed by ConnectionsPage code rather than a
    // generated field list (the keys are MCP-server-specific).
  },

  // ─── A2A endpoint ───
  {
    id: 'a2a',
    label: 'A2A endpoint',
    description:
      'A remote agent-to-agent endpoint. Orchestrations reference `${connections:<name>.url}` and `${connections:<name>.value}` instead of inlining URLs/tokens.',
    defaultAuthMethod: 'bearer',
    fields: [
      {
        key: 'url',
        location: 'top',
        label: 'Agent-card URL',
        type: 'url',
        placeholder: 'https://orchestrator.example.test/a2a',
        required: true,
      },
      {
        key: 'value',
        location: 'value',
        label: 'Bearer token (optional)',
        type: 'secret',
      },
    ],
    testProbe: {
      method: 'GET',
      urlTemplate: '${url}/.well-known/agent-card.json',
      auth: 'bearer',
    },
  },
];

export function getKindDef(id: string): ConnectionKindDef | undefined {
  return KIND_REGISTRY.find(k => k.id === id);
}

/** Map a connection kind id to a stable display group. The
 *  ConnectionsPage uses this to render kinds under category headings
 *  (LLM, Code, Project mgmt, AWS, MCP, Custom). */
export function kindGroup(id: string): string {
  if (id === 'anthropic' || id === 'openai' || id === 'gemini') return 'LLM provider';
  if (id === 'github' || id === 'bitbucket' || id === 'gitlab') return 'Code host';
  if (id === 'atlassian' || id === 'jira' || id === 'linear' || id === 'notion') {
    return 'Project mgmt';
  }
  if (id === 'figma' || id === 'slack') return 'Other';
  if (id === 'aws') return 'Cloud';
  if (id === 'mcp-server') return 'MCP';
  if (id === 'a2a') return 'A2A';
  return 'Custom';
}
