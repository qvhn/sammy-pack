import { scrubSecrets, scrubDeep, serverSecretValues } from '../src/server/scrub-secrets';

describe('scrubSecrets — known token patterns', () => {
  it('redacts Anthropic + OpenAI keys', () => {
    expect(scrubSecrets('key is sk-ant-api03-AbCdEf012345678ghi done')).toBe(
      'key is [REDACTED] done',
    );
    expect(scrubSecrets('OPENAI=sk-proj-ABCdef0123456789xyz')).toContain(
      '[REDACTED]',
    );
  });

  it('redacts GitHub tokens (ghp_, gho_, fine-grained)', () => {
    expect(scrubSecrets('ghp_0123456789abcdefghijABCDEFGHIJ0123')).toBe(
      '[REDACTED]',
    );
    expect(scrubSecrets('token gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      'token [REDACTED]',
    );
    expect(
      scrubSecrets('github_pat_11ABCDE0123456789_abcdefABCDEF0123456789'),
    ).toBe('[REDACTED]');
  });

  it('redacts Atlassian tokens (ATATT / ATCTT)', () => {
    expect(
      scrubSecrets('Authorization basic ATATTfaketoken0EXAMPLE000000_=ZZ'),
    ).toContain('[REDACTED]');
    expect(scrubSecrets('ATCTTfaketoken0EXAMPLE000000abcdef')).toBe('[REDACTED]');
  });

  it('redacts AWS access key ids', () => {
    expect(scrubSecrets('AKIAIOSFODNN7EXAMPLE here')).toBe('[REDACTED] here');
    expect(scrubSecrets('ASIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  it('redacts a long opaque base64/hex blob via the generic fallback', () => {
    const blob = 'a'.repeat(50);
    expect(scrubSecrets(`secret=${blob}`)).toBe('secret=[REDACTED]');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. Build passed!';
    expect(scrubSecrets(prose)).toBe(prose);
  });

  it('returns short / empty input unchanged', () => {
    expect(scrubSecrets('')).toBe('');
    expect(scrubSecrets('ok')).toBe('ok');
  });
});

describe('scrubSecrets — active injected literals', () => {
  it('redacts an injected jira value echoed in output (custom format, no known prefix)', () => {
    // A self-hosted PAT that matches no known prefix pattern — only the
    // literal-value layer catches it. This is the core invariant test:
    // an injected secret echoed back into agent output gets redacted.
    const secret = 'pat-7Qz9-customformat';
    const output = `running curl -H "Authorization: Bearer ${secret}" ...`;
    const scrubbed = scrubSecrets(output, [secret]);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('redacts ALL occurrences of an injected value', () => {
    const secret = 'mytoken-abcdef';
    const out = scrubSecrets(`${secret} and again ${secret}`, [secret]);
    expect(out).toBe('[REDACTED] and again [REDACTED]');
  });

  it('ignores too-short injected values (avoids over-redaction)', () => {
    // values < 6 chars are skipped so a short value doesn't redact noise
    const out = scrubSecrets('the abc here', ['abc']);
    expect(out).toBe('the abc here');
  });

  it('handles regex-special characters in an injected value safely', () => {
    const secret = 'a.b*c+d(e)[f]';
    const out = scrubSecrets(`x ${secret} y`, [secret]);
    expect(out).toBe('x [REDACTED] y');
  });

  it('redacts a known-format injected value too (both layers agree)', () => {
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
    const out = scrubSecrets(`echo ${secret}`, [secret]);
    expect(out).toBe('echo [REDACTED]');
  });
});

describe('serverSecretValues — the name-shape vocabulary’s suffix words', () => {
  const SECRET_NAMES = {
    MYSQL_PWD: 'mysql-pw-raw-7731',
    DB_PASS: 'db-pass-raw-7731',
    REDIS_AUTH: 'redis-auth-raw-7731',
    SSH_PASSPHRASE: 'passphrase-raw-7731',
    // The `_HEADER` carve-out was applied as a veto AFTER the whole
    // vocabulary had matched, so it beat AUTHORIZATION — the one word that
    // names the credential itself — and this value joined no redaction set.
    AUTHORIZATION_HEADER: 'Basic dXNlcjpzdXBlcnNlY3JldA==',
    PROXY_CREDENTIAL_HEADER: 'Basic cHJveHk6c2VjcmV0Zm9vYmFy',
    SESSION_PASSWORD_HEADER: 'session-pw-raw-7731',
  };
  // The shell's cwd, the agent socket, git identity, a terminal session id,
  // the repo's own read-gating switch and a cookie attribute — every value
  // ≥ 8 chars, so the length floor is not what keeps them out of the log
  // redaction; the NAME rule is. A bare PWD / AUTH / SESSION word would
  // blank the cwd out of every path in every agent log.
  const KNOB_NAMES = {
    PWD: '/home/operator/workspace',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock-7731',
    GIT_AUTHOR_NAME: 'Operator Person',
    TERM_SESSION_ID: 'term-session-7731',
    SAMMY_REQUIRE_AUTH_READS: 'definitely-set',
    COOKIE_DOMAIN: 'cookies.example.test',
    // A path to a secret and the NAME of one in a vault are not the secret,
    // however strong the word in the key — so these carve-outs must keep
    // winning even over SECRET / PASSWORD.
    SECRET_NAME: 'vault/platform/db-password',
    JWT_SECRET_FILE: '/etc/sammy/jwt-secret.pem',
    SAMMY_MAX_AGENT_TOKENS: '6000000',
    // A knob naming the header that CARRIES a credential, which is what the
    // `_HEADER` carve-out was written for — a weak word, so it still holds.
    SAMMY_TOKEN_HEADER: 'X-Sammy-Token',
    COOKIE_HEADER: 'X-Sammy-Cookie',
  };
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [k, v] of Object.entries({ ...SECRET_NAMES, ...KNOB_NAMES })) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('redacts a MYSQL_PWD / DB_PASS / REDIS_AUTH / *_PASSPHRASE / *_HEADER-named credential an agent echoes', () => {
    const values = serverSecretValues();
    for (const v of Object.values(SECRET_NAMES)) {
      expect(values).toContain(v);
      expect(scrubSecrets(`echo ${v}`)).toBe('echo [REDACTED]');
    }
  });

  it('does NOT redact the cwd, the agent socket, a git author, a session id, a gating switch, a path, a vault key name or a header NAME', () => {
    const values = serverSecretValues();
    for (const v of Object.values(KNOB_NAMES)) {
      expect(values).not.toContain(v);
      expect(scrubSecrets(`cd ${v}`)).toBe(`cd ${v}`);
    }
  });
});

describe('scrubDeep', () => {
  it('scrubs strings nested in objects + arrays', () => {
    const input = {
      command: 'echo ghp_0123456789abcdefghijABCDEFGHIJ0123',
      nested: { arr: ['plain', 'sk-ant-api03-AbCdEf012345678ghi'] },
      count: 3,
    };
    expect(scrubDeep(input)).toEqual({
      command: 'echo [REDACTED]',
      nested: { arr: ['plain', '[REDACTED]'] },
      count: 3,
    });
  });

  it('redacts injected literals in nested structures', () => {
    const secret = 'weird-secret-xyz';
    expect(
      scrubDeep({ a: [`carries ${secret}`] }, [secret]),
    ).toEqual({ a: ['carries [REDACTED]'] });
  });

  it('passes non-container scalars through', () => {
    expect(scrubDeep(42)).toBe(42);
    expect(scrubDeep(null)).toBe(null);
    expect(scrubDeep(true)).toBe(true);
  });
});
