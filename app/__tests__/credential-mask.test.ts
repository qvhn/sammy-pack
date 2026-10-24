import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SHORT_VALUE_MASK,
  credentialDestinationChange,
  isMaskOf,
  maskCredentialEntry,
  maskSecret,
  maskSecretsDeep,
  readCredentials,
  readCredentialsByNameRaw,
  reconcileMaskedDeep,
  reconcileMaskedEntry,
  writeCredentials,
  type Credential,
  type CredentialsConfig,
} from '../src/server/credentials-store';

describe('maskSecret', () => {
  it('shows first 6 + last 2 chars for a 32+ char secret (a real API token)', () => {
    expect(maskSecret('ghp_sharedenvtoken0123456789abcdefghij')).toBe('ghp_sh…ij');
    expect(maskSecret('sso-secret-access-key-value-7731')).toBe('sso-se…31');
  });

  it('reveals at most a QUARTER of a 16–31 char value, prefix-heavy', () => {
    // 31 chars → 7-char budget → 5 + 2; 20 → 5 → 3 + 2; 16 → 4 → 2 + 2.
    expect(maskSecret('ATATTfaketoken0EXAMPLE000000028')).toBe('ATATT…28');
    expect(maskSecret('AKIAIOSFODNN7EXAMPLE')).toBe('AKI…LE');
    expect(maskSecret('correcthorsebatt')).toBe('co…tt');
  });

  it('masks a human-length value (< 16 chars) to the fixed placeholder, never "" and never a slice', () => {
    // first6+last2 of a 9-char password is 8 of its 9 characters — "mostly
    // revealed", which is what GET /api/credentials returned for a
    // DB_PASSWORD. "" is indistinguishable from "not set" (a non-secret
    // AWS_REGION=us-west-2 rendered blank).
    for (const v of ['short', '12345678', '123456789', 'Passw0rd!', 'hunter2pass', 'S3cretPass12', 'fifteen-chars-x']) {
      expect(maskSecret(v)).toBe(SHORT_VALUE_MASK);
    }
    expect(SHORT_VALUE_MASK).not.toBe('');
    expect(SHORT_VALUE_MASK).not.toContain('12345678');
  });

  it('never discloses more than floor(len / 4) characters, at any length', () => {
    for (let n = 1; n <= 96; n++) {
      const raw = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3).slice(0, n);
      const masked = maskSecret(raw);
      const revealed = masked === SHORT_VALUE_MASK ? 0 : masked.length - 1;
      expect(revealed).toBeLessThanOrEqual(Math.floor(n / 4));
      expect(revealed).toBeLessThanOrEqual(8);
      if (masked !== SHORT_VALUE_MASK) {
        expect(masked).toContain('…');
        expect(raw.startsWith(masked.slice(0, masked.indexOf('…')))).toBe(true);
        expect(raw.endsWith(masked.slice(masked.indexOf('…') + 1))).toBe(true);
      }
    }
  });

  it('returns "" for empty / undefined', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret(undefined)).toBe('');
  });

  it('never emits a lone surrogate — a non-ASCII secret is cut by code point', () => {
    // Slicing by UTF-16 code unit cut a surrogate pair in half, so GET
    // shipped an ill-formed string; anything on the round trip that replaces
    // the lone surrogate with U+FFFD makes the echo unrecognisable to
    // `isMaskOf`, and the PUT then writes the mangled placeholder over the
    // real secret.
    const lone = (s: string) =>
      /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
    for (const raw of [
      '\u{1F600}'.repeat(10),
      '\u{1F600}'.repeat(24),
      `pw-${'\u{1F512}'.repeat(20)}-end`,
      '\u{1F680}\u{1F680}passphrase-with-emoji-0123456789\u{1F680}\u{1F680}',
    ]) {
      const masked = maskSecret(raw);
      expect(lone(masked)).toBe(false);
      // Still a mask, and still recognised as this value's mask.
      expect(masked).not.toBe(raw);
      expect(isMaskOf(masked, raw)).toBe(true);
    }
    // A 10-emoji secret is 20 code units but only 10 code points, so the
    // quarter budget holds nothing recognisable — the fixed placeholder.
    expect(maskSecret('\u{1F600}'.repeat(10))).toBe(SHORT_VALUE_MASK);
  });

  it('never returns the raw value for a realistic token', () => {
    const raw = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
    const masked = maskSecret(raw);
    expect(masked).not.toBe(raw);
    expect(raw.includes(masked)).toBe(false); // ellipsis breaks substring
    expect(masked.length).toBeLessThan(raw.length);
  });
});

describe('isMaskOf', () => {
  it('recognizes the mask of a stored value', () => {
    const stored = 'ATATTfaketoken0EXAMPLE000000028';
    expect(isMaskOf(maskSecret(stored), stored)).toBe(true);
  });
  it('rejects a genuinely different value', () => {
    expect(isMaskOf('ATATTf…99', 'ATATTfaketoken0EXAMPLE000000028')).toBe(false);
    expect(isMaskOf('a-brand-new-secret', 'old-secret-value')).toBe(false);
  });
  it('rejects empty candidate', () => {
    expect(isMaskOf('', 'whatever-stored')).toBe(false);
  });

  it('recognizes the short-value placeholder as the mask of a short stored value', () => {
    expect(isMaskOf(SHORT_VALUE_MASK, 'debug')).toBe(true);
    expect(isMaskOf(SHORT_VALUE_MASK, 'ATATTfaketoken0EXAMPLE000000028')).toBe(false);
  });

  it('still recognises the pre-quarter-rule shape (first 6 + last 2), so an upgrade cannot store a mask as the secret', () => {
    // A client that loaded the registry before the reveal was bounded echoes
    // 'ATATTf…28' for this 31-char token; today's mask is 'ATATT…28'.
    const stored = 'ATATTfaketoken0EXAMPLE000000028';
    expect(isMaskOf('ATATTf…28', stored)).toBe(true);
    expect(isMaskOf('123456…89', '123456789')).toBe(true);
    expect(reconcileMaskedEntry({ value: 'ATATTf…28' }, { value: stored }).entry.value).toBe(stored);
    // Not a wildcard: a different prefix or suffix is a real value.
    expect(isMaskOf('ATATTx…28', stored)).toBe(false);
    expect(isMaskOf('ATATTf…29', stored)).toBe(false);
  });
});

describe('reconcileMaskedEntry — prevents mask round-trip corruption of `value`', () => {
  const existing: CredentialsConfig = {
    jira: {
      kind: 'jira',
      value: 'ATATTfaketoken0EXAMPLE000000028',
      fields: { email: 'you@x.com', siteUrl: 'https://x.atlassian.net' },
    },
    gh: { kind: 'github', value: 'ghp_0123456789abcdefghijABCDEF0123' },
    mcpOnly: { kind: 'mcp-server', value: '', env: { A: 'b' } },
  };

  it('restores the stored secret when the client echoes the MASK back', () => {
    // Simulates the edit form: user changed the description, never re-typed
    // the secret, so `value` arrives as the mask we sent on GET.
    const incoming: Credential = {
      kind: 'jira',
      value: maskSecret(existing.jira.value),
      description: 'edited',
      fields: existing.jira.fields,
    };
    const out = reconcileMaskedEntry(incoming, existing.jira);
    expect(out.entry.value).toBe('ATATTfaketoken0EXAMPLE000000028');
    expect(out.entry.description).toBe('edited');
    expect(out.restored).toBe(true);
  });

  it('restores the stored secret when the client sends an empty value for an existing entry', () => {
    const out = reconcileMaskedEntry({ kind: 'jira', value: '' }, existing.jira);
    expect(out.entry.value).toBe('ATATTfaketoken0EXAMPLE000000028');
    expect(out.restored).toBe(true);
  });

  it('takes a genuinely NEW value as-is (real rotation)', () => {
    const out = reconcileMaskedEntry(
      { kind: 'jira', value: 'ATATTbrandNewRotatedToken99' },
      existing.jira,
    );
    expect(out.entry.value).toBe('ATATTbrandNewRotatedToken99');
    expect(out.restored).toBe(false);
  });

  it('keeps a legitimately-empty value for a kind that never had one', () => {
    const out = reconcileMaskedEntry(
      { kind: 'mcp-server', value: '', env: { A: 'c' } },
      existing.mcpOnly,
    );
    expect(out.entry.value).toBe('');
  });

  it('passes through a brand-new entry (no prior on disk) unchanged', () => {
    const out = reconcileMaskedEntry(
      { kind: 'github', value: 'ghp_brandnewtoken1234567890ABCD' },
      existing.fresh,
    );
    expect(out.entry.value).toBe('ghp_brandnewtoken1234567890ABCD');
    expect(out.restored).toBe(false);
  });

  it('round-trips a short non-secret env value through the placeholder', () => {
    // GET masks EVERY env value (the entry treats env as secret-bearing).
    // A short one must come back as the placeholder — visibly "set" — and a
    // PUT echoing that placeholder must restore the real value, not write
    // the placeholder (or "") into the file.
    const prior: Credential = {
      kind: 'aws',
      value: '',
      env: { LOG_LEVEL: 'debug', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY' },
    };
    const echoed = maskCredentialEntry(prior);
    expect(echoed.env?.LOG_LEVEL).toBe(SHORT_VALUE_MASK);
    const out = reconcileMaskedEntry(echoed, prior);
    expect(out.entry.env).toEqual(prior.env);
    expect(out.restored).toBe(true);
  });
});

// ─── Every secret-bearing field, not just `value` ───────────────────────────

const SSO_ENTRY: Credential = {
  kind: 'aws',
  value: '',
  ssoStartUrl: 'https://d-1.awsapps.com/start',
  fields: { region: 'us-west-2' },
  cache: {
    accessToken: 'sso-access-token-value-7731',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'sso-secret-access-key-value-7731',
    sessionToken: 'sso-session-token-value-7731',
    expiresAt: '2030-01-01T00:00:00Z',
  },
};

const MCP_ENTRY: Credential & { headers?: Record<string, string> } = {
  kind: 'mcp-server',
  value: '',
  url: 'https://mcp.example.test',
  env: { GITHUB_TOKEN: 'ghp_envtoken0123456789abcdefghijklmn', PLAIN: 'x' },
  headers: { Authorization: 'Bearer bearer-raw-value-7731' },
};

describe('maskCredentialEntry — masks every secret-bearing field', () => {
  it('masks env values, cache tokens and header values, and still value', () => {
    const env = maskCredentialEntry(MCP_ENTRY);
    expect(env.env).toEqual({ GITHUB_TOKEN: 'ghp_en…mn', PLAIN: SHORT_VALUE_MASK });
    expect((env as { headers?: Record<string, string> }).headers).toEqual({
      Authorization: 'Beare…31',
    });
    expect(env.url).toBe('https://mcp.example.test');

    const sso = maskCredentialEntry(SSO_ENTRY);
    expect(sso.cache?.accessToken).toBe('sso-…31');
    expect(sso.cache?.secretAccessKey).toBe('sso-se…31');
    expect(sso.cache?.sessionToken).toBe('sso-s…31');
    expect(sso.cache?.accessKeyId).toBe('AKI…LE');
    // Timestamp, not a secret — the UI shows when a refresh is due.
    expect(sso.cache?.expiresAt).toBe('2030-01-01T00:00:00Z');
    // Non-secret metadata is untouched.
    expect(sso.fields).toEqual({ region: 'us-west-2' });
    expect(sso.ssoStartUrl).toBe('https://d-1.awsapps.com/start');

    const legacy = maskCredentialEntry({ value: 'ATATTfaketoken0EXAMPLE000000028' });
    expect(legacy.value).toBe('ATATT…28');
  });

  it('never leaks any raw secret through JSON.stringify of the masked entry', () => {
    for (const entry of [MCP_ENTRY, SSO_ENTRY]) {
      const text = JSON.stringify(maskCredentialEntry(entry));
      expect(text).not.toContain('raw-value');
      expect(text).not.toContain('token-value');
      expect(text).not.toContain('ghp_envtoken');
      expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  });

  it('tolerates an undefined / empty entry', () => {
    expect(maskCredentialEntry(undefined)).toEqual({ value: '' });
  });
});

describe('reconcileMaskedEntry — round-trips every masked field, reports restores', () => {
  it('restores masked env / cache / header values and flags the entry as restored', () => {
    const echoedMcp = maskCredentialEntry(MCP_ENTRY);
    const mcp = reconcileMaskedEntry(echoedMcp, MCP_ENTRY);
    expect(mcp.restored).toBe(true);
    expect(mcp.entry.env).toEqual(MCP_ENTRY.env);
    expect((mcp.entry as { headers?: Record<string, string> }).headers).toEqual(
      MCP_ENTRY.headers,
    );

    const sso = reconcileMaskedEntry(maskCredentialEntry(SSO_ENTRY), SSO_ENTRY);
    expect(sso.restored).toBe(true);
    expect(sso.entry.cache).toEqual(SSO_ENTRY.cache);
  });

  it('the restore survives the WRITER — a hand-written headers block is still on disk after a save', async () => {
    // The halves were each covered and the whole was not: `writeCredentials`
    // rebuilds every entry from a field whitelist that had no `headers` case,
    // so the restored block was discarded one function later. PUT replaces
    // the whole file, so saving one entry through the editor erased every
    // entry's headers — including the ones outside the caller's view that
    // the handler copies over precisely because it must not touch them.
    const dir = mkdtempSync(path.join(tmpdir(), 'sammy-hdr-'));
    const file = path.join(dir, 'credentials.json');
    const stored: CredentialsConfig = {
      webhookish: MCP_ENTRY as Credential,
      other: {
        kind: 'a2a',
        value: 'tok-other-0123456789abcdefghij',
        url: 'https://other.example.test',
        headers: { 'X-Api-Key': 'other-header-0123456789' },
      } as Credential,
    };
    await writeCredentials(file, stored);
    const onDisk = await readCredentials(file);
    expect((onDisk.webhookish as { headers?: unknown }).headers).toEqual(MCP_ENTRY.headers);

    // Now the editor's round trip: the masked GET echoed back verbatim.
    const echoed = maskCredentialEntry(onDisk.webhookish);
    const r = reconcileMaskedEntry(echoed, onDisk.webhookish);
    expect(r.restored).toBe(true);
    await writeCredentials(file, { ...onDisk, webhookish: r.entry });
    const after = await readCredentials(file);
    expect((after.webhookish as { headers?: unknown }).headers).toEqual(MCP_ENTRY.headers);
    // The untouched entry keeps its own block too.
    expect((after.other as { headers?: unknown }).headers).toEqual({
      'X-Api-Key': 'other-header-0123456789',
    });
    // Non-string header values are dropped, as the `env` case does.
    await writeCredentials(file, {
      weird: { kind: 'a2a', value: 'tok-0123456789abcdefghij', headers: { A: 1, B: 'keep' } } as unknown as Credential,
    });
    expect((await readCredentials(file)).weird).toMatchObject({ headers: { B: 'keep' } });
  });

  it('does not flag an entry whose secrets were genuinely re-typed', () => {
    const r = reconcileMaskedEntry(
      { ...MCP_ENTRY, env: { GITHUB_TOKEN: 'ghp_rotated0123456789abcdefghijklmnop', PLAIN: 'y' } },
      MCP_ENTRY,
    );
    expect(r.restored).toBe(false);
    expect(r.entry.env?.GITHUB_TOKEN).toBe('ghp_rotated0123456789abcdefghijklmnop');
  });

  it('a brand-new entry (no prior) is passed through, not restored', () => {
    const r = reconcileMaskedEntry({ kind: 'github', value: 'ghp_new0123456789abcdefghijklmnopq' }, undefined);
    expect(r.restored).toBe(false);
    expect(r.entry.value).toBe('ghp_new0123456789abcdefghijklmnopq');
  });
});

describe('credentialDestinationChange — what a masked save may not move', () => {
  const prior: Credential = {
    kind: 'a2a',
    value: 'bearer-x-7731',
    url: 'https://agent.example.test/a2a',
    fields: { site: 'https://site.example.test', email: 'a@b.test' },
    owners: ['alice'],
    orchestrations: ['qa'],
  };

  it('reports url / fields / owners / orchestrations changes by name', () => {
    expect(credentialDestinationChange({ ...prior, url: 'https://exfil.test' }, prior)).toBe('url');
    expect(
      credentialDestinationChange({ ...prior, fields: { ...prior.fields, site: 'x' } }, prior),
    ).toBe('fields');
    expect(credentialDestinationChange({ ...prior, owners: ['alice', 'bob'] }, prior)).toBe(
      'owners',
    );
    expect(credentialDestinationChange({ ...prior, orchestrations: [] }, prior)).toBe(
      'orchestrations',
    );
  });

  it('ignores ordering, whitespace and non-destination metadata', () => {
    expect(
      credentialDestinationChange(
        {
          ...prior,
          description: 'edited',
          url: ' https://agent.example.test/a2a ',
          fields: { email: 'a@b.test', site: 'https://site.example.test' },
          owners: [' alice '],
        },
        prior,
      ),
    ).toBeNull();
    // Absent and empty are the same thing.
    expect(
      credentialDestinationChange({ value: 'x' }, { value: 'x', owners: [], fields: {} }),
    ).toBeNull();
  });
});

describe('maskSecretsDeep / reconcileMaskedDeep — free-form registry', () => {
  const registry = {
    svc: {
      command: 'svc-mcp',
      args: ['--port', '1'],
      env: { SVC_TOKEN: 'svc-token-raw-value-7731', PLAIN: 'visible' },
      headers: { Authorization: 'Bearer bearer-raw-value-7731', 'X-Api-Key': 'apikey-raw-7731' },
      options: { nested: { client_secret: 'client-secret-raw-7731', retries: 3 } },
    },
    chained: { command: 'x', env: { T: '${connections:svc-token.value}' } },
  };

  it('masks secret-looking keys at any depth and every ${connections:…} ref', () => {
    const masked = maskSecretsDeep(registry) as typeof registry;
    expect(masked.svc.env.SVC_TOKEN).toBe('svc-…31');
    expect(masked.svc.env.PLAIN).toBe('visible');
    expect(masked.svc.headers.Authorization).toBe('Beare…31');
    expect(masked.svc.headers['X-Api-Key']).toBe(SHORT_VALUE_MASK);
    expect(masked.svc.options.nested.client_secret).toBe('cli…31');
    expect(masked.svc.options.nested.retries).toBe(3);
    expect(masked.svc.args).toEqual(['--port', '1']);
    expect(masked.chained.env.T).toBe('${con…e}');
    expect(JSON.stringify(masked)).not.toContain('raw');
    // Input not mutated.
    expect(registry.svc.env.SVC_TOKEN).toBe('svc-token-raw-value-7731');
  });

  it('reconcile restores echoed masks + empties, keeps real changes', () => {
    const masked = maskSecretsDeep(registry) as typeof registry;
    const edited = {
      ...masked,
      svc: {
        ...masked.svc,
        env: { ...masked.svc.env, SVC_TOKEN: 'rotated-9999', PLAIN: 'changed' },
        headers: { ...masked.svc.headers, 'X-Api-Key': '' },
      },
    };
    const out = reconcileMaskedDeep(edited, registry) as typeof registry;
    expect(out.svc.env.SVC_TOKEN).toBe('rotated-9999');
    expect(out.svc.env.PLAIN).toBe('changed');
    expect(out.svc.headers.Authorization).toBe('Bearer bearer-raw-value-7731');
    expect(out.svc.headers['X-Api-Key']).toBe('apikey-raw-7731');
    expect(out.svc.options.nested.client_secret).toBe('client-secret-raw-7731');
    expect(out.chained.env.T).toBe('${connections:svc-token.value}');
  });

  it('a non-secret key echoing the mask of nothing stays as sent', () => {
    expect(reconcileMaskedDeep({ a: { name: '' } }, { a: { name: 'kept?' } })).toEqual({
      a: { name: '' },
    });
  });

  it('masks a key the shared name vocabulary recognises (CREDENTIAL — the scrubber’s word, not the old local list’s)', () => {
    const masked = maskSecretsDeep({
      env: { SERVICE_CREDENTIALS: 'service-cred-raw-7731', REGION: 'us-west-2' },
    }) as { env: Record<string, string> };
    expect(masked.env.SERVICE_CREDENTIALS).toBe('ser…31');
    expect(masked.env.REGION).toBe('us-west-2');
  });
});

// ─── The shared name vocabulary: suffix words ───────────────────────────────

describe('maskSecretsDeep — the canonical DB-client / proxy names the vocabulary missed', () => {
  const registry = {
    db: {
      command: 'db-mcp',
      env: {
        MYSQL_PWD: 'mysql-pw-raw-7731',
        DB_PASS: 'db-pass-raw-7731',
        REDIS_AUTH: 'redis-auth-raw-7731',
        SSH_PASSPHRASE: 'passphrase-raw-7731',
        // The shell's own cwd and the agent's identity knobs — a bare PWD /
        // AUTH / SESSION word would blank these out of every log.
        PWD: '/home/operator/workspace/mcp',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock-7731',
        GIT_AUTHOR_NAME: 'Operator Person',
        TERM_SESSION_ID: 'term-session-7731',
        SAMMY_REQUIRE_AUTH_READS: 'definitely-set',
      },
      headers: {
        Cookie: 'sid=cookie-raw-7731',
        'X-Auth': 'xauth-raw-7731',
        'X-Request-Id': 'req-7731-abc',
      },
    },
  };
  const masked = maskSecretsDeep(registry) as typeof registry;

  it('masks MYSQL_PWD / DB_PASS / REDIS_AUTH / *_PASSPHRASE env values and Cookie / X-Auth headers', () => {
    for (const k of ['MYSQL_PWD', 'DB_PASS', 'REDIS_AUTH', 'SSH_PASSPHRASE'] as const) {
      expect(masked.db.env[k]).not.toBe(registry.db.env[k]);
    }
    expect(masked.db.headers.Cookie).not.toBe(registry.db.headers.Cookie);
    expect(masked.db.headers['X-Auth']).not.toBe(registry.db.headers['X-Auth']);
    expect(JSON.stringify(masked)).not.toContain('raw-7731');
  });

  it('leaves the cwd, the agent socket, the author name, session ids and the gating switch readable', () => {
    for (const k of [
      'PWD',
      'SSH_AUTH_SOCK',
      'GIT_AUTHOR_NAME',
      'TERM_SESSION_ID',
      'SAMMY_REQUIRE_AUTH_READS',
    ] as const) {
      expect(masked.db.env[k]).toBe(registry.db.env[k]);
    }
    expect(masked.db.headers['X-Request-Id']).toBe('req-7731-abc');
  });

  it('round-trips: the echoed masks restore every one of them', () => {
    expect(reconcileMaskedDeep(masked, registry)).toEqual(registry);
  });
});

// ─── `fields` is free-form: a hand-written secret there is masked by key ───

describe('maskCredentialEntry / reconcileMaskedEntry — secret-looking keys inside `fields`', () => {
  const prior: Credential = {
    kind: 'jira',
    value: 'ATATTfaketoken0EXAMPLE000000028',
    fields: {
      email: 'you@x.test',
      siteUrl: 'https://x.atlassian.test',
      password: 'fields-pw-raw-7731',
      apiToken: 'fields-token-raw-7731',
    },
  };

  it('masks fields.password / fields.apiToken and leaves email / siteUrl readable', () => {
    const masked = maskCredentialEntry(prior);
    expect(masked.fields?.email).toBe('you@x.test');
    expect(masked.fields?.siteUrl).toBe('https://x.atlassian.test');
    expect(masked.fields?.password).not.toBe(prior.fields?.password);
    expect(masked.fields?.apiToken).not.toBe(prior.fields?.apiToken);
    expect(JSON.stringify(masked)).not.toContain('raw-7731');
  });

  it('the GET → PUT round trip restores them and reports the entry as restored', () => {
    const out = reconcileMaskedEntry(maskCredentialEntry(prior), prior);
    expect(out.restored).toBe(true);
    expect(out.entry.fields).toEqual(prior.fields);
    // Nothing "moved": the PUT handler's destination check runs on the
    // reconciled entry and must not refuse a save that only echoed GET.
    expect(credentialDestinationChange(out.entry, prior)).toBeNull();
  });

  it('an emptied non-secret field is a genuine edit; a re-typed secret field is taken as-is', () => {
    const echoed = maskCredentialEntry(prior);
    const edited: Credential = {
      ...echoed,
      fields: { ...echoed.fields, email: '', password: 'rotated-pw-9999' },
    };
    const out = reconcileMaskedEntry(edited, prior);
    expect(out.entry.fields?.email).toBe('');
    expect(out.entry.fields?.password).toBe('rotated-pw-9999');
    expect(out.entry.fields?.apiToken).toBe('fields-token-raw-7731');
  });
});

// ─── By SHAPE, with a slash in it ───────────────────────────────────────────

describe('maskSecretsDeep — a slash does not exempt a shape the scrubber recognises', () => {
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const SLACK_HOOK = 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
  // Every location shape the carve-out exists for — the first two are what
  // it was written against; `./` is a 40+ char run the generic pattern
  // matches too, so it proves the narrowing is by shape, not by luck.
  const LOCATIONS = [
    '/Users/someone/projects/mcp-servers/filesystem/dist/index.js',
    '@modelcontextprotocol/server-sequential-thinking',
    './packages/mcp-servers/filesystem/build/server/index',
    '../packages/mcp-servers/filesystem/build/server/index',
    '~/projects/mcp-servers/filesystem/build/server/index',
    'C:\\Users\\someone\\projects\\mcp-servers\\filesystem\\dist\\index.js',
  ];
  const registry = {
    svc: { command: 'svc-mcp', args: ['--region', 'us-west-2', AWS_SECRET, SLACK_HOOK, ...LOCATIONS] },
  };
  const masked = maskSecretsDeep(registry) as typeof registry;

  it('masks an AWS secret access key (base64 alphabet has "/") and a webhook URL whose path IS the secret', () => {
    expect(masked.svc.args[2]).not.toBe(AWS_SECRET);
    expect(masked.svc.args[3]).not.toBe(SLACK_HOOK);
    const text = JSON.stringify(masked);
    expect(text).not.toContain(AWS_SECRET);
    expect(text).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX');
  });

  it('still leaves every location shape readable — the carve-out was narrowed, not removed', () => {
    expect(masked.svc.args.slice(4)).toEqual(LOCATIONS);
    expect(masked.svc.args.slice(0, 2)).toEqual(['--region', 'us-west-2']);
  });

  it('round-trips through reconcileMaskedDeep', () => {
    expect(reconcileMaskedDeep(masked, registry)).toEqual(registry);
  });
});

// ─── Secrets by SHAPE, under a non-secret key (an MCP server's argv) ────────

describe('maskSecretsDeep / reconcileMaskedDeep — positional credentials in argv', () => {
  const GHP = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
  const ANT = 'sk-ant-api03-AbCdEf0123456789ghijklmnop';
  const PG_URL = 'postgresql://app:pg-pass-raw-7731@db.example.test:5432/app';
  const registry = {
    // The UI's own Postgres template: the URL (credentials included) is the
    // last positional arg.
    postgres: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', PG_URL],
    },
    flagged: {
      command: 'svc-mcp',
      // The last pair is the one only the argv rule can catch: a plain
      // human-chosen value with no token shape of its own.
      args: ['--api-key', GHP, '--port', '1', '--token=' + ANT, '--verbose', '--password', 'plain-pass-7731'],
    },
    bare: {
      command: 'svc-mcp',
      args: [ANT, '/Users/someone/projects/mcp-servers/filesystem/dist/index.js'],
    },
    fs: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: { REMOTE: 'https://x-access-token:' + GHP + '@git.example.test/org/repo.git' },
    },
  };
  const masked = maskSecretsDeep(registry) as typeof registry;

  it('(a) masks a URL carrying userinfo, wherever it sits', () => {
    expect(masked.postgres.args[2]).toBe('postgr…pp');
    expect(masked.postgres.args[2]).not.toContain('pg-pass');
    // Under a non-secret env key too — the shape, not the key, decides.
    expect(masked.fs.env.REMOTE).not.toContain(GHP);
  });

  it('(b) masks a positional value the log scrubber would redact', () => {
    expect(masked.bare.args[0]).toBe('sk-ant…op');
  });

  it('(c) `--flag=value` masks itself; a bare `--flag` marks the NEXT element', () => {
    expect(masked.flagged.args).toEqual([
      '--api-key',
      'ghp_01…23',
      '--port',
      '1',
      '--toke…op',
      '--verbose',
      '--password',
      SHORT_VALUE_MASK,
    ]);
  });

  it('leaves the non-secret argv an operator must be able to read visible', () => {
    // Paths and scoped package specs are 40+ char runs the generic
    // high-entropy pattern would otherwise swallow.
    expect(masked.bare.args[1]).toBe(registry.bare.args[1]);
    expect(masked.fs.args).toEqual(registry.fs.args);
    expect(masked.postgres.args.slice(0, 2)).toEqual(['-y', '@modelcontextprotocol/server-postgres']);
    expect(masked.postgres.command).toBe('npx');
  });

  it('nothing raw survives JSON.stringify of the masked registry', () => {
    const text = JSON.stringify(masked);
    for (const raw of [GHP, ANT, 'pg-pass-raw-7731', 'plain-pass-7731']) {
      expect(text).not.toContain(raw);
    }
  });

  it('GET → PUT round trip: every masked arg is restored, a rotated one is taken as-is', () => {
    // The write side must make the SAME argv decision from the STORED array
    // — the flag-marked value has no shape of its own, so without the
    // predecessor the echo of its mask would be written into the file.
    const out = reconcileMaskedDeep(masked, registry) as typeof registry;
    expect(out).toEqual(registry);
    expect(out.flagged.args[7]).toBe('plain-pass-7731');

    const rotated = {
      ...masked,
      flagged: { ...masked.flagged, args: ['--api-key', 'ghp_ROTATED0123456789abcdefghijk', '--port', '2', masked.flagged.args[4], '--verbose'] },
    };
    const out2 = reconcileMaskedDeep(rotated, registry) as typeof registry;
    expect(out2.flagged.args[1]).toBe('ghp_ROTATED0123456789abcdefghijk');
    expect(out2.flagged.args[3]).toBe('2');
    expect(out2.flagged.args[4]).toBe('--token=' + ANT);
  });
});

// ─── A credential in a URL's QUERY, not its userinfo ───────────────────────
//
// The other half of the shape the polling-trigger listing is masked against,
// and the half that was missing: a feed key is typically a 32-char opaque
// blob, so no provider pattern matches it and the generic 40+ entropy run
// does not reach it. Only the PARAMETER NAME says what it is — which is why
// the by-shape rule has to read the query rather than the value alone.
describe('maskSecretsDeep — a credential in the query string', () => {
  const FEED_KEY = 'abcdef0123456789abcdef0123456789';

  it('masks ?token= / ?api_key= / ?access_token= under a non-secret key', () => {
    for (const param of ['token', 'api_key', 'access_token', 'apiKey', 'secret']) {
      const url = `https://feeds.example.test/rss?${param}=${FEED_KEY}`;
      const masked = maskSecretsDeep(url, 'source');
      expect(`${param} → ${masked}`).toBe(`${param} → https:…89`);
      expect(masked).not.toContain(FEED_KEY);
    }
  });

  it('leaves a URL whose query carries no credential readable', () => {
    for (const url of [
      'https://feeds.example.test/rss?page=2&format=atom',
      'https://feeds.example.test/rss',
      'https://feeds.example.test/rss?token=',
    ]) {
      expect(maskSecretsDeep(url, 'source')).toBe(url);
    }
  });

  it('the write side restores the echoed mask, so a save cannot overwrite the source', () => {
    const stored = { source: `https://feeds.example.test/rss?token=${FEED_KEY}` };
    const masked = maskSecretsDeep(stored) as typeof stored;
    expect(masked.source).not.toContain(FEED_KEY);
    expect(reconcileMaskedDeep(masked, stored)).toEqual(stored);
  });
});

describe('readCredentialsByNameRaw — orchestrations allowlist applies only to runs', () => {
  it('includes an orchestrations-scoped entry when no orchestration is in scope', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sammy-cred-scope-')), 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        'qa-only': { value: 'qa-secret-7731', orchestrations: ['full-lifecycle-qa'] },
      }),
    );
    // The probe's read: owner known, no run.
    expect(readCredentialsByNameRaw(file, { ownerId: 'alice' })['qa-only']).toBeDefined();
    expect(readCredentialsByNameRaw(file)['qa-only']).toBeDefined();
    // A run that IS named still has to be on the list.
    expect(
      readCredentialsByNameRaw(file, { orchestrationName: 'full-lifecycle-qa' })['qa-only'],
    ).toBeDefined();
    expect(readCredentialsByNameRaw(file, { orchestrationName: 'other' })['qa-only']).toBeUndefined();
  });
});
