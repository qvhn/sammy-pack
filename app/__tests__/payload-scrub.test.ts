import {
  NON_JSON_PLACEHOLDER,
  scrubPayload,
  validateScrubPolicy,
} from '../src/server/payload-scrub';

const SALT = { salt: 's1' };

describe('scrubPayload — detectors', () => {
  it('redacts emails, phones, bearer tokens and JWTs in plain text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX3Zh';
    const r = scrubPayload(
      `mail a.b+c@ex-ample.co.uk, call (415) 555-0100 or +44 20 7946 0958, ` +
        `auth: Bearer abcdefghijkl, token ${jwt}`,
      {},
    );
    expect(r.body).toBe(
      'mail [email], call [phone] or [phone], auth: Bearer [token], token [jwt]',
    );
    expect(r.redactions).toBe(5);
  });

  it('does not mistake dates, timestamps, versions or ids for phone numbers', () => {
    const text =
      '2026-10-23T03:02:00Z 1792826771059 v12.3.4 build 63 id 550e8400-e29b-41d4-a716-446655440000 port 5432';
    expect(scrubPayload(text, {}).body).toBe(text);
  });

  it('honors a restricted builtins list and builtins: false', () => {
    const t = 'x@y.io 415-555-0100';
    expect(scrubPayload(t, { builtins: ['email'] }).body).toBe('[email] 415-555-0100');
    expect(scrubPayload(t, { builtins: false }).body).toBe(t);
  });

  it('applies custom patterns with their replacement', () => {
    const r = scrubPayload('order ORD-12345 shipped', {
      builtins: false,
      patterns: [{ pattern: 'ORD-\\d+', replacement: '[order]' }],
    });
    expect(r.body).toBe('order [order] shipped');
  });

  it('redacts known secret formats via the shared secret scrubber', () => {
    const r = scrubPayload('key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ here', {});
    expect(r.body).not.toContain('sk-ant-api03-ZZZZ');
  });
});

describe('scrubPayload — JSON fields', () => {
  const body = JSON.stringify({
    title: 'crash',
    user: 'uid-1',
    nested: { keep: 'k', secret: 's' },
    samples: [
      { stack: 's1', context: { a: 1 } },
      { stack: 's2', context: { a: 2 } },
    ],
  });

  it('keeps only allowFields, with * over array items and whole subtrees', () => {
    const r = scrubPayload(body, { allowFields: ['title', 'samples.*.stack', 'nested'] });
    expect(JSON.parse(r.body)).toEqual({
      title: 'crash',
      nested: { keep: 'k', secret: 's' },
      samples: [{ stack: 's1' }, { stack: 's2' }],
    });
    expect(r.fieldsDropped).toBe(3); // user + two contexts
  });

  it('drops dropFields', () => {
    const r = scrubPayload(body, { dropFields: ['nested.secret', 'samples.*.context'] });
    const out = JSON.parse(r.body);
    expect(out.nested).toEqual({ keep: 'k' });
    expect(out.samples).toEqual([{ stack: 's1' }, { stack: 's2' }]);
  });

  it('hashes hashFields stably with the salt, and differently per salt', () => {
    const a = JSON.parse(scrubPayload(body, { hashFields: ['user'] }, SALT).body).user;
    const b = JSON.parse(scrubPayload(body, { hashFields: ['user'] }, SALT).body).user;
    const c = JSON.parse(scrubPayload(body, { hashFields: ['user'] }, { salt: 's2' }).body).user;
    expect(a).toMatch(/^hash:[0-9a-f]{24}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('drops a hashField when no salt is configured (no reversible digests)', () => {
    const r = scrubPayload(body, { hashFields: ['user'] }, { salt: '' });
    expect(JSON.parse(r.body).user).toBeUndefined();
    expect(r.fieldsDropped).toBe(1);
  });

  it('runs detectors inside surviving string values only', () => {
    const r = scrubPayload(JSON.stringify({ msg: 'from x@y.io', n: 4155550100 }), {});
    expect(JSON.parse(r.body)).toEqual({ msg: 'from [email]', n: 4155550100 });
  });

  it('fails closed: allowFields on a non-JSON body replaces it', () => {
    const r = scrubPayload('raw text with x@y.io', { allowFields: ['a'] });
    expect(r.body).toBe(NON_JSON_PLACEHOLDER);
    expect(r.replacedNonJson).toBe(true);
  });

  it('treats a malformed JSON-looking body as text', () => {
    expect(scrubPayload('{not json x@y.io', {}).body).toBe('{not json [email]');
  });
});

describe('scrubPayload — keys and form bodies', () => {
  it('runs the detectors over object keys too', () => {
    const r = scrubPayload(JSON.stringify({ recipients: { 'jane@example.com': 'sent', 'bob@example.com': 'sent' } }), {});
    expect(JSON.parse(r.body)).toEqual({ recipients: { '[email]': 'sent', '[email]#2': 'sent' } });
  });

  it('decodes a form-encoded body, scrubs it field by field, and re-encodes it', () => {
    const r = scrubPayload('From=%2B14155550100&Email=jane%40example.com&Body=hi&Body=again', {});
    const out = new URLSearchParams(r.body);
    expect(out.get('From')).toBe('[phone]');
    expect(out.get('Email')).toBe('[email]');
    expect(out.getAll('Body')).toEqual(['hi', 'again']);
  });

  it('applies allow / hash field policies to a form body', () => {
    const r = scrubPayload('From=%2B14155550100&MessageSid=SM1&Body=secret+text', {
      allowFields: ['From', 'MessageSid'],
      hashFields: ['From'],
    }, { salt: 's' });
    const out = new URLSearchParams(r.body);
    expect(out.get('Body')).toBeNull();
    expect(out.get('From')).toMatch(/^hash:/);
    expect(out.get('MessageSid')).toBe('SM1');
  });
});

describe('validateScrubPolicy', () => {
  it('accepts a full policy', () => {
    expect(
      validateScrubPolicy({
        builtins: ['email', 'phone'],
        patterns: [{ pattern: 'a+', flags: 'i' }],
        allowFields: ['a.b'],
        dropFields: ['c'],
        hashFields: ['d'],
      }),
    ).toEqual([]);
  });

  it('names each problem', () => {
    const problems = validateScrubPolicy({
      builtins: ['email', 'ssn'],
      patterns: [{ pattern: '(' }, {}],
      allowFields: [''],
      extra: true,
    });
    expect(problems.join('\n')).toMatch(/scrub.extra is not a known option/);
    expect(problems.join('\n')).toMatch(/unknown detector "ssn"/);
    expect(problems.join('\n')).toMatch(/patterns\[0\] does not compile/);
    expect(problems.join('\n')).toMatch(/patterns\[1\].pattern must be/);
    expect(problems.join('\n')).toMatch(/allowFields must be a list/);
  });
});
