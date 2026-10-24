import {
  credentialToEnv,
  credentialsToEnv,
  secretEnvVarNames,
} from '../src/server/credential-env';
import type { Credential } from '../src/server/credentials-store';

describe('credentialToEnv', () => {
  it('maps a jira credential to token + email + base URL (siteUrl field)', () => {
    const cred: Credential = {
      kind: 'jira',
      value: 'ATATTfaketoken0EXAMPLE000000028',
      fields: { email: 'you@example.com', siteUrl: 'https://team.atlassian.net' },
    };
    expect(credentialToEnv(cred)).toEqual({
      JIRA_API_TOKEN: 'ATATTfaketoken0EXAMPLE000000028',
      JIRA_EMAIL: 'you@example.com',
      JIRA_BASE_URL: 'https://team.atlassian.net',
    });
  });

  it('maps the atlassian kind via the `site` field alias to JIRA_BASE_URL', () => {
    const cred: Credential = {
      kind: 'atlassian',
      value: 'ATATTsecret',
      fields: { email: 'a@b.com', site: 'https://x.atlassian.net' },
    };
    expect(credentialToEnv(cred)).toEqual({
      JIRA_API_TOKEN: 'ATATTsecret',
      JIRA_EMAIL: 'a@b.com',
      JIRA_BASE_URL: 'https://x.atlassian.net',
    });
  });

  it('maps github → GITHUB_TOKEN only', () => {
    expect(credentialToEnv({ kind: 'github', value: 'ghp_abc123' })).toEqual({
      GITHUB_TOKEN: 'ghp_abc123',
    });
  });

  it('maps bitbucket → token + optional username', () => {
    expect(
      credentialToEnv({
        kind: 'bitbucket',
        value: 'bb-token',
        fields: { username: 'octocat' },
      }),
    ).toEqual({ BITBUCKET_TOKEN: 'bb-token', BITBUCKET_USERNAME: 'octocat' });
    // username omitted when the field is absent
    expect(credentialToEnv({ kind: 'bitbucket', value: 'bb-token' })).toEqual({
      BITBUCKET_TOKEN: 'bb-token',
    });
  });

  it('maps the provider keys to conventional env vars', () => {
    expect(credentialToEnv({ kind: 'openai', value: 'sk-x' })).toEqual({
      OPENAI_API_KEY: 'sk-x',
    });
    expect(credentialToEnv({ kind: 'anthropic', value: 'sk-ant-y' })).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-y',
    });
    expect(credentialToEnv({ kind: 'gemini', value: 'g-z' })).toEqual({
      GEMINI_API_KEY: 'g-z',
    });
  });

  it('returns {} for an unknown / unmapped kind without throwing', () => {
    expect(credentialToEnv({ kind: 'secret', value: 'whatever' })).toEqual({});
    expect(
      credentialToEnv({ kind: 'mcp-server', value: '', env: { A: 'b' } }),
    ).toEqual({});
    // A kind not in the union at all (defensive — value cast) → {}
    expect(
      credentialToEnv({ kind: 'totally-made-up' as never, value: 'x' }),
    ).toEqual({});
  });

  it('omits the secret var when value is empty/whitespace, and skips empty fields', () => {
    expect(credentialToEnv({ kind: 'github', value: '' })).toEqual({});
    expect(credentialToEnv({ kind: 'github', value: '   ' })).toEqual({});
    expect(
      credentialToEnv({
        kind: 'jira',
        value: 'tok',
        fields: { email: '', siteUrl: 'https://x' },
      }),
    ).toEqual({ JIRA_API_TOKEN: 'tok', JIRA_BASE_URL: 'https://x' });
  });

  it('does not let an empty alias overwrite a populated one (site vs siteUrl)', () => {
    // siteUrl present, site empty — JIRA_BASE_URL should keep siteUrl.
    const cred: Credential = {
      kind: 'jira',
      value: 't',
      fields: { siteUrl: 'https://real', site: '' },
    };
    expect(credentialToEnv(cred).JIRA_BASE_URL).toBe('https://real');
  });
});

describe('credentialsToEnv (merge)', () => {
  it('merges several creds; later entries win on key collision', () => {
    const a: Credential = { kind: 'github', value: 'ghp_first' };
    const b: Credential = { kind: 'jira', value: 'jt', fields: { email: 'e@x' } };
    const c: Credential = { kind: 'github', value: 'ghp_second' };
    expect(credentialsToEnv([a, b, c])).toEqual({
      GITHUB_TOKEN: 'ghp_second',
      JIRA_API_TOKEN: 'jt',
      JIRA_EMAIL: 'e@x',
    });
  });

  it('is empty for an empty list', () => {
    expect(credentialsToEnv([])).toEqual({});
  });
});

describe('secretEnvVarNames', () => {
  it('includes the known secret-bearing env vars', () => {
    const names = secretEnvVarNames();
    expect(names.has('JIRA_API_TOKEN')).toBe(true);
    expect(names.has('GITHUB_TOKEN')).toBe(true);
    expect(names.has('OPENAI_API_KEY')).toBe(true);
    // non-secret field vars are NOT in this set
    expect(names.has('JIRA_BASE_URL')).toBe(false);
    expect(names.has('JIRA_EMAIL')).toBe(false);
  });
});
