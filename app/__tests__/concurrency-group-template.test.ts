import {
  effectiveConcurrency,
  isGroupTemplate,
  MAX_RESOLVED_GROUP_CHARS,
  resolveConcurrencyGroup,
} from '../src/server/concurrency-group';

describe('templated concurrency groups', () => {
  const orch = {
    name: 'intake',
    concurrency: { group: 'intake:${input.fingerprint}', policy: 'skip' as const },
  };

  it('resolves a field of the JSON input, one group per key', () => {
    const a = effectiveConcurrency(orch, 'queue', JSON.stringify({ fingerprint: 'abc' }));
    const b = effectiveConcurrency(orch, 'queue', JSON.stringify({ fingerprint: 'def' }));
    expect(a).toEqual({ group: 'intake:abc', policy: 'skip' });
    expect(b?.group).toBe('intake:def');
  });

  it('returns the declared template when no input is given (visibility)', () => {
    expect(effectiveConcurrency(orch, 'queue')?.group).toBe('intake:${input.fingerprint}');
    expect(isGroupTemplate('intake:${input.fingerprint}')).toBe(true);
    expect(isGroupTemplate('staging-env')).toBe(false);
  });

  it('fails closed: a missing field leaves the literal, so those fires share one group', () => {
    const missed: string[] = [];
    const g1 = resolveConcurrencyGroup('k:${input.fingerprint}', '{"other":1}', r => missed.push(r));
    const g2 = resolveConcurrencyGroup('k:${input.fingerprint}', 'not json', r => missed.push(r));
    expect(g1).toBe('k:${input.fingerprint}');
    expect(g2).toBe(g1);
    expect(missed).toEqual(['input.fingerprint', 'input.fingerprint']);
  });

  it('supports the raw input', () => {
    expect(resolveConcurrencyGroup('dev:${input}', 'iphone-16')).toBe('dev:iphone-16');
  });

  it('cannot be steered into the reserved sammy: namespace', () => {
    expect(resolveConcurrencyGroup('k:${input}', 'x')).toBe('k:x');
    expect(resolveConcurrencyGroup('sammy${input}', ':cron:nightly')).toBe('u:sammy:cron:nightly');
  });

  it('namespaces a template with no literal prefix to its orchestration', () => {
    // Otherwise a payload could join (and cancel-existing) another
    // orchestration's literal group.
    expect(resolveConcurrencyGroup('${input.repo}', '{"repo":"prod-deploy"}', undefined, 'intake')).toBe(
      'tmpl:intake:prod-deploy',
    );
    const o = { name: 'intake', concurrency: { group: '${input}', policy: 'cancel-existing' as const } };
    expect(effectiveConcurrency(o, 'queue', 'prod-deploy')?.group).toBe('tmpl:intake:prod-deploy');
  });

  it('bounds a huge resolved value with a stable digest', () => {
    const big = 'x'.repeat(5000);
    const g = resolveConcurrencyGroup('k:${input}', big);
    expect(g.length).toBeLessThanOrEqual(MAX_RESOLVED_GROUP_CHARS);
    expect(resolveConcurrencyGroup('k:${input}', big)).toBe(g);
    expect(resolveConcurrencyGroup('k:${input}', big + 'y')).not.toBe(g);
  });

  it('leaves literal groups untouched', () => {
    expect(resolveConcurrencyGroup('staging', '{"a":1}')).toBe('staging');
  });
});
