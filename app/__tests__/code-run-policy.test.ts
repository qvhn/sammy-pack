import { codeRunAllowlist, codeRunMode, matchAllowlist, splitArgv } from '../src/llm/code-run-policy';

describe('codeRunMode', () => {
  it('is off by default, unrestricted with the flag, allowlisted with patterns', () => {
    expect(codeRunMode({})).toBe('off');
    expect(codeRunMode({ SAMMY_ALLOW_CODE_RUN: '1' })).toBe('unrestricted');
    expect(codeRunMode({ SAMMY_ALLOW_CODE_RUN: 'true', SAMMY_CODE_RUN_ALLOW: 'x' })).toBe('unrestricted');
    expect(codeRunMode({ SAMMY_CODE_RUN_ALLOW: 'npx jest *' })).toBe('allowlist');
    expect(codeRunMode({ SAMMY_CODE_RUN_ALLOW: ' ;\n ' })).toBe('off');
    expect(codeRunAllowlist({ SAMMY_CODE_RUN_ALLOW: 'a *; b\nc' })).toEqual(['a *', 'b', 'c']);
  });
});

describe('matchAllowlist', () => {
  const pats = ['npx jest *', 'mvn -q -Dtest=* test', 'git status'];
  it('matches whole commands with * wildcards, whitespace-normalized', () => {
    expect(matchAllowlist('npx jest src/a.test.ts', pats)).toBe('npx jest *');
    expect(matchAllowlist('mvn  -q -Dtest=FooTest test', pats)).toBe('mvn -q -Dtest=* test');
    expect(matchAllowlist('npx jest "a b.test.ts"', pats)).toBe('npx jest *');
    expect(matchAllowlist('git status', pats)).toBe('git status');
  });
  it('does not match prefixes, suffixes or other commands', () => {
    expect(matchAllowlist('git status --porcelain', pats)).toBeNull();
    expect(matchAllowlist('sudo npx jest x', pats)).toBeNull();
    expect(matchAllowlist('mvn -q -Dtest=X deploy', pats)).toBeNull();
  });
  it('a wildcard stays inside ONE argument — a payload cannot add arguments', () => {
    // npx jest ${input} with input "foo --outputFile=/tmp/x --json"
    expect(matchAllowlist('npx jest foo --outputFile=/tmp/x --json', pats)).toBeNull();
    // the trailing-backslash trick that swallowed the pattern's last literal
    expect(matchAllowlist('mvn -q -Dtest=X -f /tmp/evil-pom.xml \\ test', pats)).toBeNull();
    expect(matchAllowlist('mvn -q "-Dtest=X -f /tmp/evil.xml" test', pats)).toBe('mvn -q -Dtest=* test');
  });

  it('a wildcard-supplied argument may not be an option', () => {
    expect(matchAllowlist('npx jest --config=/tmp/evil.js', pats)).toBeNull();
    expect(matchAllowlist('npx jest -c', pats)).toBeNull();
    expect(matchAllowlist('npx jest src/x-y.test.ts', pats)).toBe('npx jest *');
  });

  it('a wildcard argument cannot climb out of the directory the pattern names', () => {
    expect(matchAllowlist('./scripts/../../bin/sh', ['./scripts/*'])).toBeNull();
    expect(matchAllowlist('./scripts/sub/run.sh', ['./scripts/*'])).toBe('./scripts/*');
    expect(matchAllowlist('npx jest --globalSetup=/tmp/evil.js x', ['npx jest * *'])).toBeNull();
  });

  it('treats regex metacharacters in patterns literally', () => {
    expect(matchAllowlist('echo a.b', ['echo a.b'])).toBe('echo a.b');
    expect(matchAllowlist('echo aXb', ['echo a.b'])).toBeNull();
  });
});

describe('splitArgv', () => {
  it('splits words, honoring quotes and escapes, with no expansion', () => {
    expect(splitArgv(`npx jest "a b.test.ts" 'c $HOME' d\\ e`)).toEqual([
      'npx',
      'jest',
      'a b.test.ts',
      'c $HOME',
      'd e',
    ]);
  });
  it('turns shell operators into plain arguments', () => {
    expect(splitArgv('echo hi; rm -rf / && $(id) | cat > x')).toEqual([
      'echo',
      'hi;',
      'rm',
      '-rf',
      '/',
      '&&',
      '$(id)',
      '|',
      'cat',
      '>',
      'x',
    ]);
  });
  it('keeps empty quoted arguments and rejects unterminated quotes', () => {
    expect(splitArgv(`a "" b`)).toEqual(['a', '', 'b']);
    expect(() => splitArgv(`a "b`)).toThrow(/unterminated/);
  });
});
