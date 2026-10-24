import {
  collectConnectionSecretsDeep,
  interpolate,
} from '../src/llm/interpolate';
import { scrubEvent } from '../src/server/scrub-secrets';

describe('interpolate', () => {
  it('substitutes a simple ${var}', () => {
    expect(interpolate('hi ${name}', { name: 'Sam' })).toBe('hi Sam');
  });

  it('JSON-stringifies a non-string value', () => {
    expect(interpolate('v=${x}', { x: { a: 1 } })).toBe('v={"a":1}');
  });

  it('resolves a dotted ${a.b} path, transparently JSON-parsing an as-bound string', () => {
    // `as`-bound agent/code outputs land in state as raw strings; a deeper path
    // should parse them rather than dead-end to undefined.
    expect(interpolate('${login.ready}', { login: '{"ready":"yes"}' })).toBe('yes');
  });

  it('leaves an unresolved ${ref} as a literal (degrade-gracefully contract)', () => {
    // Some flows rely on the un-substituted literal passing through (a
    // default-bearing CLI arg). interpolate must NOT swallow or blank it.
    expect(interpolate('base ${missing} tail', {})).toBe('base ${missing} tail');
  });

  it('invokes onUnresolved for each unresolved ref, and not for resolved ones', () => {
    const seen: string[] = [];
    const out = interpolate('${a} ${b.c} ${d}', { a: 'A', d: 'D' }, r => seen.push(r));
    expect(out).toBe('A ${b.c} D'); // a, d resolve; b.c stays literal
    expect(seen).toEqual(['b.c']); // exactly the unresolved ref is signalled
  });

  it('does not invoke onUnresolved when everything resolves', () => {
    const seen: string[] = [];
    interpolate('${a}-${b}', { a: '1', b: '2' }, r => seen.push(r));
    expect(seen).toEqual([]);
  });
});

describe('collectConnectionSecretsDeep — fields.* / headers.*', () => {
  // The credentials GET surface MASKS a secret-looking `fields` key and every
  // `headers` value. The harvester's prefix rule rejected both blocks, so such
  // a value was a secret on the API surface and not a
  // secret to the run's scrubber — and the scrubber only catches an
  // unregistered value when it happens to match a token pattern, which a
  // human-length password does not.
  const connections = {
    jira: {
      value: '',
      fields: {
        siteUrl: 'https://acme.atlassian.net',
        email: 'qa@example.com',
        apiToken: 'ATATT3xFfGF0abcdefghijklmnopqrstuvwx28',
        password: 'correct horse battery staple',
      },
      headers: { Authorization: 'Bearer hand-written-0123456789' },
    },
  };

  it('registers a secret-looking fields.* value, by the masker vocabulary', () => {
    const out = collectConnectionSecretsDeep(
      {
        env: {
          TOKEN: '${connections:jira.fields.apiToken}',
          PASSWORD: '${connections:jira.fields.password}',
        },
      },
      connections,
    );
    expect([...out].sort()).toEqual([
      'ATATT3xFfGF0abcdefghijklmnopqrstuvwx28',
      'correct horse battery staple',
    ]);
  });

  it('registers every headers.* value — a header is credential material', () => {
    const out = collectConnectionSecretsDeep(
      { headers: { A: '${connections:jira.headers.Authorization}' } },
      connections,
    );
    expect([...out]).toEqual(['Bearer hand-written-0123456789']);
  });

  it('still leaves an ordinary fields.* value (site URL, email) readable', () => {
    const out = collectConnectionSecretsDeep(
      {
        args: ['--site', '${connections:jira.fields.siteUrl}'],
        env: { EMAIL: '${connections:jira.fields.email}' },
      },
      connections,
    );
    expect([...out]).toEqual([]);
  });

  // The masker decides a `fields` leaf by NAME *or* by VALUE SHAPE; the
  // harvester decided by name alone, so a credential filed under an
  // innocuous key was masked on GET and printed verbatim into the run's
  // durable events. Of the masker's three shape clauses only one — a value
  // the scrubber's own pattern pass recognises — has a backstop; a DSN and
  // an argv `--password=` match NO token pattern, so for those the harvester
  // is the only thing between the value and the event log.
  const shaped = {
    acme: {
      value: '',
      fields: {
        dsn: 'postgres://pguser:hunter2hunter2@db.internal:5432/app',
        extraArgs: '--password=correct-horse-battery',
        hook: 'https://admin:s3cr3t-p4ssw0rd@internal.example/hook',
        // Must stay readable: a long ordinary URL is what mirroring the
        // THIRD clause would have started redacting out of run output.
        site: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456789/Some-Long-Page-Title',
        serverSpec: '@modelcontextprotocol/server-postgres',
        flag: '--max-rows=1000',
      },
    },
  };

  it.each([
    ['dsn', 'postgres://pguser:hunter2hunter2@db.internal:5432/app'],
    ['extraArgs', '--password=correct-horse-battery'],
    ['hook', 'https://admin:s3cr3t-p4ssw0rd@internal.example/hook'],
  ])(
    'harvests a credential-bearing fields.%s whatever its key is called',
    (key, value) => {
      const secrets = collectConnectionSecretsDeep(
        { args: ['-v', `\${connections:acme.fields.${key}}`] },
        shaped,
      );
      expect([...secrets]).toEqual([value]);
      const leak = { type: 'phase-end', phaseName: 'a', output: `curl ${value}` };
      // The pattern pass alone does not see either shape — being harvested
      // is the whole mitigation.
      expect(scrubEvent(leak).output).toBe(leak.output);
      expect(scrubEvent(leak, secrets).output).toBe('curl [REDACTED]');
    },
  );

  it.each(['site', 'serverSpec', 'flag'])(
    'leaves an ordinary fields.%s out of the sink, so run output stays readable',
    key => {
      const secrets = collectConnectionSecretsDeep(
        { args: ['-v', `\${connections:acme.fields.${key}}`] },
        shaped,
      );
      expect([...secrets]).toEqual([]);
      const value = (shaped.acme.fields as Record<string, string>)[key];
      const ev = { type: 'phase-end', phaseName: 'a', output: `ran ${value}` };
      // The sink adds NOTHING for these: whatever the pattern pass does to
      // the value (it still redacts a high-entropy run inside a long URL)
      // is all that happens, and the value is never exact-redacted whole.
      expect(scrubEvent(ev, secrets).output).toBe(scrubEvent(ev).output);
      expect(scrubEvent(ev, secrets).output).not.toBe('ran [REDACTED]');
    },
  );

  it('being registered is what makes a fields.* secret redactable from an event', () => {
    const secrets = collectConnectionSecretsDeep(
      { env: { PASSWORD: '${connections:jira.fields.password}' } },
      connections,
    );
    const leak = {
      type: 'phase-end',
      phaseName: 'a',
      output: 'DB_PASSWORD=correct horse battery staple',
    };
    // Unregistered, the pattern pass alone does not recognise it.
    expect(scrubEvent(leak).output).toBe(leak.output);
    expect(scrubEvent(leak, secrets).output).toBe('DB_PASSWORD=[REDACTED]');
  });
});
