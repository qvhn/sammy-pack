/**
 * Tests for the unified connections registry (kind-tagged credentials,
 * ${connections:...} interpolation, scoped reads, SAMMY_CONNECTIONS_FILE).
 *
 * Covers the migration safety contract: every shape that worked
 * before (`{ value, description }`) still parses + resolves; new
 * kind-tagged entries land alongside without disturbing old ones.
 */

import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  readCredentials,
  readCredentialsByNameRaw,
  readCredentialsByNameSync,
  resolveCredentialsFile,
  resolveProviderKeysSync,
  writeCredentials,
} from '../src/server/credentials-store';
import {
  collectConnectionSecretsDeep,
  resolveConnectionRefs,
  resolveConnectionRefsDeep,
} from '../src/llm/interpolate';
import { KIND_REGISTRY } from '../src/store/kindRegistry';

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sammy-credentials-'));
  return path.join(dir, 'credentials.json');
}

describe('credentials-store — back-compat (pre-kind shape)', () => {
  it('round-trips a legacy {value, description} entry unchanged', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      openai: { value: 'sk-legacy', description: 'pre-kind entry' },
    });
    const round = await readCredentials(file);
    expect(round.openai.value).toBe('sk-legacy');
    expect(round.openai.description).toBe('pre-kind entry');
    expect(round.openai.kind).toBeUndefined();
  });

  it('readCredentialsByNameSync still returns {name: value} for legacy entries', () => {
    const file = tempFile();
    require('node:fs').writeFileSync(
      file,
      JSON.stringify({ slack: { value: 'xoxb-legacy' } }),
    );
    const out = readCredentialsByNameSync(file);
    expect(out.slack).toBe('xoxb-legacy');
  });

  it('resolveProviderKeysSync sees pre-kind canonical entries', () => {
    const file = tempFile();
    require('node:fs').writeFileSync(
      file,
      JSON.stringify({ anthropic: { value: 'sk-ant-x' } }),
    );
    expect(resolveProviderKeysSync(file)).toMatchObject({
      anthropic: 'sk-ant-x',
    });
  });
});

describe('credentials-store — kind-tagged extensions', () => {
  it('persists kind, authMethod, fields, url, env, ssoStartUrl', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      'atlassian-prod': {
        value: 'ATATT-test',
        kind: 'atlassian',
        authMethod: 'api-token',
        fields: { email: 'a@b.com', site: 'https://x.atlassian.net' },
        description: 'desc',
      } as never,
      'aws-stage': {
        value: '',
        kind: 'aws',
        authMethod: 'sso',
        ssoStartUrl: 'https://d-1.awsapps.com/start',
        ssoRegion: 'us-west-2',
        accountId: '111',
        roleName: 'Dev',
      } as never,
      'mcp-atlassian': {
        value: '',
        kind: 'mcp-server',
        ref: 'atlassian',
        env: { ATLASSIAN_TOKEN: '${connections:atlassian-prod.value}' },
      } as never,
    });
    const round = await readCredentials(file);
    expect(round['atlassian-prod'].kind).toBe('atlassian');
    expect(round['atlassian-prod'].fields).toEqual({
      email: 'a@b.com',
      site: 'https://x.atlassian.net',
    });
    expect(round['aws-stage'].ssoStartUrl).toBe(
      'https://d-1.awsapps.com/start',
    );
    expect(round['mcp-atlassian'].ref).toBe('atlassian');
    expect(round['mcp-atlassian'].env).toEqual({
      ATLASSIAN_TOKEN: '${connections:atlassian-prod.value}',
    });
  });

  it('keeps an entry with empty value when kind-substance is present', async () => {
    // mcp-server entries can legitimately have value:"" — the env block
    // is the substance. They should NOT be dropped during write.
    const file = tempFile();
    await writeCredentials(file, {
      'mcp-github': {
        value: '',
        kind: 'mcp-server',
        env: { GITHUB_TOKEN: 'ghp_x' },
      } as never,
    });
    const round = await readCredentials(file);
    expect(round['mcp-github']).toBeDefined();
    expect(round['mcp-github'].env?.GITHUB_TOKEN).toBe('ghp_x');
  });

  it('still drops totally-empty entries', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      junk: { value: '   ' } as never,
      blank: { value: '', kind: 'secret' } as never,
    });
    const round = await readCredentials(file);
    expect(round.junk).toBeUndefined();
    expect(round.blank).toBeUndefined();
  });
});

describe('readCredentialsByNameRaw — scoping + substance', () => {
  it('returns full Credential entries (not just value)', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      atlassian: {
        value: 'TOKEN',
        kind: 'atlassian',
        fields: { site: 'https://x.atlassian.net', email: 'a@b.com' },
      } as never,
    });
    const out = readCredentialsByNameRaw(file);
    expect(out.atlassian.value).toBe('TOKEN');
    expect(out.atlassian.fields?.site).toBe('https://x.atlassian.net');
  });

  it('honors owners scoping', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      'team-secret': {
        value: 'X',
        owners: ['alice'],
      } as never,
    });
    expect(readCredentialsByNameRaw(file, { ownerId: 'alice' })['team-secret'])
      .toBeDefined();
    expect(readCredentialsByNameRaw(file, { ownerId: 'bob' })['team-secret'])
      .toBeUndefined();
    // Anonymous caller — fail closed.
    expect(readCredentialsByNameRaw(file)['team-secret']).toBeUndefined();
  });

  it('honors orchestrations scoping', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      'qa-only': {
        value: 'X',
        orchestrations: ['full-lifecycle-qa'],
      } as never,
    });
    expect(
      readCredentialsByNameRaw(file, {
        orchestrationName: 'full-lifecycle-qa',
      })['qa-only'],
    ).toBeDefined();
    expect(readCredentialsByNameRaw(file, { orchestrationName: 'other' })['qa-only'])
      .toBeUndefined();
  });
});

describe('${connections:...} interpolation', () => {
  const connections = {
    'atlassian-prod': {
      value: 'ATATT-secret',
      fields: { site: 'https://x.atlassian.net', email: 'a@b.com' },
    },
    'team-a2a': {
      value: 'bearer-x',
      url: 'https://orchestrator.example.test/a2a',
    },
  };

  it('resolves default `.value` when no dotted path', () => {
    expect(resolveConnectionRefs('${connections:atlassian-prod}', connections))
      .toBe('ATATT-secret');
    expect(
      resolveConnectionRefs('${connections:atlassian-prod.value}', connections),
    ).toBe('ATATT-secret');
  });

  it('resolves dotted paths into fields and top-level keys', () => {
    expect(
      resolveConnectionRefs(
        '${connections:atlassian-prod.fields.site}',
        connections,
      ),
    ).toBe('https://x.atlassian.net');
    expect(resolveConnectionRefs('${connections:team-a2a.url}', connections))
      .toBe('https://orchestrator.example.test/a2a');
  });

  it('leaves unknown refs literal (safety: visible failure, not silent empty)', () => {
    expect(resolveConnectionRefs('${connections:missing}', connections))
      .toBe('${connections:missing}');
    expect(
      resolveConnectionRefs(
        '${connections:atlassian-prod.fields.unknown}',
        connections,
      ),
    ).toBe('${connections:atlassian-prod.fields.unknown}');
  });

  it('substitutes inside a larger string', () => {
    const url =
      'Bearer ${connections:team-a2a.value} → ${connections:team-a2a.url}';
    expect(resolveConnectionRefs(url, connections)).toBe(
      'Bearer bearer-x → https://orchestrator.example.test/a2a',
    );
  });

  it('resolveConnectionRefsDeep walks nested objects + arrays', () => {
    const mcpConfig = {
      command: 'npx -y mcp-remote',
      args: ['--url', 'https://mcp.atlassian.com/v1/sse'],
      env: {
        ATLASSIAN_TOKEN: '${connections:atlassian-prod.value}',
        ATLASSIAN_EMAIL: '${connections:atlassian-prod.fields.email}',
        LITERAL: 'unchanged',
      },
    };
    const out = resolveConnectionRefsDeep(mcpConfig, connections);
    expect(out.env.ATLASSIAN_TOKEN).toBe('ATATT-secret');
    expect(out.env.ATLASSIAN_EMAIL).toBe('a@b.com');
    expect(out.env.LITERAL).toBe('unchanged');
    expect(out.command).toBe('npx -y mcp-remote');
    expect(out.args[1]).toBe('https://mcp.atlassian.com/v1/sse');
    // Input untouched (purity).
    expect(mcpConfig.env.ATLASSIAN_TOKEN).toBe(
      '${connections:atlassian-prod.value}',
    );
  });

  it('returns input unchanged when there are no refs', () => {
    const cfg = { command: 'foo', env: { X: '1' } };
    const out = resolveConnectionRefsDeep(cfg, connections);
    expect(out).toEqual(cfg);
  });
});

describe('collectConnectionSecretsDeep — MCP residual-leak scrubbing', () => {
  // Secrets an MCP config pulls from the connections registry must be
  // registered for run-wide output scrubbing, so an MCP subprocess that
  // echoes one back into a tool result gets it redacted. This is the
  // collector the run-runner feeds into the run's injectedSecrets sink.
  const connections = {
    'atlassian-prod': {
      value: 'ATATT-mcp-secret-000000',
      fields: { site: 'https://x.atlassian.net', email: 'qa@example.com' },
    },
    'sso-thing': {
      value: '',
      cache: { accessToken: 'sso-access-token-abcdef123456' },
    },
    'env-only': {
      value: '',
      env: { DEEP_TOKEN: 'env-block-secret-xyz789' },
    },
  };

  it('collects the secret a `${connections:name.value}` env ref resolves to', () => {
    const mcpConfig = {
      command: 'npx -y atlassian-mcp',
      env: {
        ATLASSIAN_TOKEN: '${connections:atlassian-prod.value}',
        // default field (no dotted path) is also `.value` → secret
        ALT_TOKEN: '${connections:atlassian-prod}',
      },
    };
    const out = collectConnectionSecretsDeep(mcpConfig, connections);
    expect(out.has('ATATT-mcp-secret-000000')).toBe(true);
    expect(out.size).toBe(1); // both refs resolve to the same secret
  });

  it('does NOT collect non-secret fields (site URL / email) or url', () => {
    const mcpConfig = {
      args: ['--site', '${connections:atlassian-prod.fields.site}'],
      env: {
        EMAIL: '${connections:atlassian-prod.fields.email}',
        SITE: '${connections:atlassian-prod.fields.site}',
      },
    };
    const out = collectConnectionSecretsDeep(mcpConfig, connections);
    // A base URL / email an agent legitimately echoes must not be redacted.
    expect(out.has('https://x.atlassian.net')).toBe(false);
    expect(out.has('qa@example.com')).toBe(false);
    expect(out.size).toBe(0);
  });

  it('collects env.* and cache.* secret-bearing refs', () => {
    const out = collectConnectionSecretsDeep(
      {
        headers: { Authorization: 'Bearer ${connections:sso-thing.cache.accessToken}' },
        env: { DEEP: '${connections:env-only.env.DEEP_TOKEN}' },
      },
      connections,
    );
    expect(out.has('sso-access-token-abcdef123456')).toBe(true);
    expect(out.has('env-block-secret-xyz789')).toBe(true);
  });

  it('ignores unknown refs and short (<6 char) resolved values', () => {
    const out = collectConnectionSecretsDeep(
      {
        env: {
          MISSING: '${connections:nope.value}',
          SHORT: '${connections:tiny.value}',
        },
      },
      { tiny: { value: 'abc' } }, // 3 chars — below the scrubber's floor
    );
    expect(out.size).toBe(0);
  });

  it('walks nested objects + arrays and dedups into the provided set', () => {
    const seed = new Set<string>(['pre-existing-secret']);
    const out = collectConnectionSecretsDeep(
      {
        servers: [
          { env: { A: '${connections:atlassian-prod.value}' } },
          { env: { B: '${connections:atlassian-prod.value}' } },
        ],
      },
      connections,
      seed,
    );
    expect(out).toBe(seed); // mutates + returns the same set
    expect(out.has('pre-existing-secret')).toBe(true);
    expect(out.has('ATATT-mcp-secret-000000')).toBe(true);
  });
});

describe('resolveCredentialsFile — SAMMY_CONNECTIONS_FILE override', () => {
  const originalEnv = process.env.SAMMY_CONNECTIONS_FILE;
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SAMMY_CONNECTIONS_FILE;
    } else {
      process.env.SAMMY_CONNECTIONS_FILE = originalEnv;
    }
  });

  it('defaults to <repoRoot>/credentials.json', () => {
    delete process.env.SAMMY_CONNECTIONS_FILE;
    expect(resolveCredentialsFile('/repo')).toBe('/repo/credentials.json');
  });

  it('honors an absolute SAMMY_CONNECTIONS_FILE', () => {
    process.env.SAMMY_CONNECTIONS_FILE = '/Users/example/secrets/x.json';
    expect(resolveCredentialsFile('/repo')).toBe(
      '/Users/example/secrets/x.json',
    );
  });

  it('resolves a relative SAMMY_CONNECTIONS_FILE against the repo root', () => {
    process.env.SAMMY_CONNECTIONS_FILE = 'private/credentials.json';
    expect(resolveCredentialsFile('/repo')).toBe(
      '/repo/private/credentials.json',
    );
  });

  it('treats whitespace-only override as unset', () => {
    process.env.SAMMY_CONNECTIONS_FILE = '   ';
    expect(resolveCredentialsFile('/repo')).toBe('/repo/credentials.json');
  });
});

describe('integration — MCP env block resolves via registry', () => {
  it('expanding mcp/servers.json with ${connections:...} yields real values', async () => {
    const file = tempFile();
    await writeCredentials(file, {
      atlassian: {
        value: 'ATATT-runtime',
        kind: 'atlassian',
        fields: { email: 'qa@example.com' },
      } as never,
    });
    const registry = readCredentialsByNameRaw(file);
    // Simulating what api.ts does at MCP-expansion time.
    const inlineMcpConfig = {
      type: 'stdio',
      command: 'npx -y atlassian-mcp',
      env: {
        ATLASSIAN_TOKEN: '${connections:atlassian.value}',
        ATLASSIAN_EMAIL: '${connections:atlassian.fields.email}',
        NOT_A_REF: 'plain-string',
      },
    };
    const resolved = resolveConnectionRefsDeep(inlineMcpConfig, registry);
    expect(resolved.env.ATLASSIAN_TOKEN).toBe('ATATT-runtime');
    expect(resolved.env.ATLASSIAN_EMAIL).toBe('qa@example.com');
    expect(resolved.env.NOT_A_REF).toBe('plain-string');
    expect(resolved.command).toBe('npx -y atlassian-mcp');
  });

  it('missing credential entry leaves the literal ref in place (visible failure)', async () => {
    const file = tempFile();
    await fs.writeFile(file, '{}', 'utf8');
    const registry = readCredentialsByNameRaw(file);
    const cfg = {
      env: { TOKEN: '${connections:not-there.value}' },
    };
    const resolved = resolveConnectionRefsDeep(cfg, registry);
    expect(resolved.env.TOKEN).toBe('${connections:not-there.value}');
  });
});

/**
 * Parity / well-formedness contract for the testProbe descriptors on
 * kind defs.
 *
 * Why this matters: the `/api/credentials/test` handler in
 * `sammy-pack-api.ts` reads `KIND_REGISTRY` directly — there's no
 * inline duplicate table — so a typo in a kind def silently breaks
 * the live Test button for that kind without any compile-time check.
 * These tests catch that class of regression in CI.
 *
 * Same drift class as `cli-parity.test.ts` already polices for the
 * CLI ↔ web executor.
 */
describe('kindRegistry — testProbe well-formedness contract', () => {
  const kindsWithProbes = KIND_REGISTRY.filter(k => k.testProbe);

  it('ships at least the documented set of probes', () => {
    // If the list shrinks, someone deleted a probe; review whether
    // that's intentional. If it grows, also fine — just bump the
    // baseline. The set below is the shipped baseline as of the
    // collapse-to-single-source PR.
    const ids = new Set(kindsWithProbes.map(k => k.id));
    for (const required of ['github', 'atlassian', 'jira', 'linear', 'a2a']) {
      expect(ids.has(required as never)).toBe(true);
    }
  });

  it.each(kindsWithProbes.map(k => [k.id, k]))(
    '%s: testProbe descriptor is complete + well-formed',
    (_id, def) => {
      const probe = def.testProbe!;
      // Method must be GET or HEAD — only safe probe verbs.
      expect(['GET', 'HEAD']).toContain(probe.method);
      // URL template must be non-empty.
      expect(typeof probe.urlTemplate).toBe('string');
      expect(probe.urlTemplate.length).toBeGreaterThan(0);
      // Auth method must be one of the four the handler implements.
      expect(['bearer', 'basic-email-token', 'api-key-header', 'none']).toContain(
        probe.auth ?? 'none',
      );
      if (probe.auth === 'api-key-header') {
        expect(probe.headerName).toBeTruthy();
      }
    },
  );

  it.each(kindsWithProbes.map(k => [k.id, k]))(
    '%s: every URL-template placeholder resolves to a known source (value/url/fields.*)',
    (_id, def) => {
      const probe = def.testProbe!;
      // Extract every `${expr}` and check the expression is one of:
      //   - `value`            → entry.value
      //   - `url`              → entry.url
      //   - `fields.<key>`     → entry.fields[key]
      // Anything else is a typo (e.g. ${field.site} instead of
      // ${fields.site}) and will surface at runtime as an
      // "URL template has unresolved placeholders" failure.
      const exprs = Array.from(probe.urlTemplate.matchAll(/\$\{([^}]+)\}/g)).map(
        m => m[1].trim(),
      );
      for (const expr of exprs) {
        const knownTop = expr === 'value' || expr === 'url';
        const knownField =
          expr.startsWith('fields.') && expr.slice('fields.'.length).length > 0;
        expect(knownTop || knownField).toBe(true);
      }
    },
  );

  it.each(kindsWithProbes.map(k => [k.id, k]))(
    '%s: basic-email-token probes have a `fields.email` declared in the kind def',
    (_id, def) => {
      const probe = def.testProbe!;
      if (probe.auth !== 'basic-email-token') return;
      const hasEmail = def.fields.some(
        f => f.location === 'fields' && f.key === 'email',
      );
      expect(hasEmail).toBe(true);
    },
  );

  it.each(kindsWithProbes.map(k => [k.id, k]))(
    '%s: bearer/api-key probes have a value field declared in the kind def',
    (_id, def) => {
      const probe = def.testProbe!;
      if (probe.auth !== 'bearer' && probe.auth !== 'api-key-header') return;
      const hasValue = def.fields.some(f => f.location === 'value');
      expect(hasValue).toBe(true);
    },
  );

  it.each(kindsWithProbes.map(k => [k.id, k]))(
    '%s: a2a-style probes that reference `${url}` declare a url field on the kind def',
    (_id, def) => {
      const probe = def.testProbe!;
      if (!probe.urlTemplate.includes('${url}')) return;
      const hasUrl = def.fields.some(f => f.location === 'top' && f.key === 'url');
      expect(hasUrl).toBe(true);
    },
  );
});
