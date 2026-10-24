import {
  applyToolPolicy,
  checkDeniedCommand,
  mergeSandbox,
  resolvePermissionMode,
} from '../src/server/sandbox-policy';
import type { Sandbox } from '../src/types';

describe('mergeSandbox — tighten-only composition', () => {
  it('returns the other side when one is undefined', () => {
    const s: Sandbox = { allowedTools: ['Read'] };
    expect(mergeSandbox(undefined, s)).toBe(s);
    expect(mergeSandbox(s, undefined)).toBe(s);
    expect(mergeSandbox(undefined, undefined)).toBeUndefined();
  });

  it('intersects allowedTools', () => {
    const m = mergeSandbox(
      { allowedTools: ['Read', 'Write', 'Bash'] },
      { allowedTools: ['Read', 'Bash', 'Glob'] },
    );
    expect(m?.allowedTools?.sort()).toEqual(['Bash', 'Read']);
  });

  it('keeps the only cap when one side has no allowlist', () => {
    expect(
      mergeSandbox({ allowedTools: ['Read'] }, { networkAccess: false })
        ?.allowedTools,
    ).toEqual(['Read']);
  });

  it('unions deniedCommands + dedupes', () => {
    const m = mergeSandbox(
      { deniedCommands: ['rm -rf', 'sudo'] },
      { deniedCommands: ['sudo', 'curl | sh'] },
    );
    expect(m?.deniedCommands?.sort()).toEqual(['curl | sh', 'rm -rf', 'sudo']);
  });

  it('networkAccess: false wins', () => {
    expect(
      mergeSandbox({ networkAccess: true }, { networkAccess: false })
        ?.networkAccess,
    ).toBe(false);
    expect(
      mergeSandbox({ networkAccess: true }, { networkAccess: true })
        ?.networkAccess,
    ).toBe(true);
  });

  it('permissionMode: stricter wins', () => {
    // plan (strictest) beats bypassPermissions (loosest)
    expect(
      mergeSandbox(
        { permissionMode: 'bypassPermissions' },
        { permissionMode: 'plan' },
      )?.permissionMode,
    ).toBe('plan');
    expect(
      mergeSandbox(
        { permissionMode: 'acceptEdits' },
        { permissionMode: 'default' },
      )?.permissionMode,
    ).toBe('acceptEdits');
  });
});

describe('applyToolPolicy', () => {
  it('passes everything through when there is no sandbox', () => {
    expect(applyToolPolicy(['Bash', 'Read'], undefined)).toEqual({
      effectiveTools: ['Bash', 'Read'],
      strippedTools: [],
    });
  });

  it('strips tools not in the allowlist', () => {
    const r = applyToolPolicy(['Bash', 'Read', 'Write'], {
      allowedTools: ['Read'],
    });
    expect(r.effectiveTools).toEqual(['Read']);
    expect(r.strippedTools.sort()).toEqual(['Bash', 'Write']);
  });

  it('strips network tools when networkAccess is false', () => {
    const r = applyToolPolicy(['Read', 'WebFetch', 'WebSearch'], {
      networkAccess: false,
    });
    expect(r.effectiveTools).toEqual(['Read']);
    expect(r.strippedTools.sort()).toEqual(['WebFetch', 'WebSearch']);
  });

  it('applies allowlist + network strip together', () => {
    const r = applyToolPolicy(['Read', 'Bash', 'WebFetch'], {
      allowedTools: ['Read', 'Bash', 'WebFetch'],
      networkAccess: false,
    });
    expect(r.effectiveTools.sort()).toEqual(['Bash', 'Read']);
    expect(r.strippedTools).toEqual(['WebFetch']);
  });
});

describe('resolvePermissionMode', () => {
  it('returns undefined when neither is set', () => {
    expect(resolvePermissionMode(undefined, undefined)).toBeUndefined();
    expect(resolvePermissionMode(undefined, {})).toBeUndefined();
  });

  it('returns the only one set', () => {
    expect(resolvePermissionMode('acceptEdits', undefined)).toBe('acceptEdits');
    expect(resolvePermissionMode(undefined, { permissionMode: 'plan' })).toBe(
      'plan',
    );
  });

  it('returns the stricter of the two', () => {
    expect(
      resolvePermissionMode('bypassPermissions', { permissionMode: 'plan' }),
    ).toBe('plan');
    expect(
      resolvePermissionMode('plan', { permissionMode: 'bypassPermissions' }),
    ).toBe('plan');
  });
});

describe('checkDeniedCommand', () => {
  const sandbox: Sandbox = { deniedCommands: ['rm -rf', 'sudo', 'curl | sh'] };

  it('returns null when nothing matches', () => {
    expect(checkDeniedCommand('ls -la', sandbox)).toBeNull();
    expect(checkDeniedCommand('echo hello', undefined)).toBeNull();
    expect(checkDeniedCommand('echo hello', {})).toBeNull();
  });

  it('returns the matched needle for a denied command', () => {
    expect(checkDeniedCommand('rm -rf /tmp/x', sandbox)).toBe('rm -rf');
    expect(checkDeniedCommand('sudo apt install', sandbox)).toBe('sudo');
  });

  it('matches case-insensitively', () => {
    expect(checkDeniedCommand('RM -RF /', sandbox)).toBe('rm -rf');
    expect(checkDeniedCommand('SUDO reboot', sandbox)).toBe('sudo');
  });

  it('matches a denied substring anywhere in a longer command', () => {
    expect(
      checkDeniedCommand('echo start && rm -rf node_modules && echo done', sandbox),
    ).toBe('rm -rf');
  });
});
