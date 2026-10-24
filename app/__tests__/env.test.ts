/**
 * Numeric env knobs: the reader and the banner's "set but INVALID" check
 * agree on what is valid.
 *
 * `envIsSetButInvalid` accepted `>= 0` while `envPositiveInt` required `> 0`,
 * so a `0` handed to a positive-int knob was rejected by the reader (a
 * `[config]` warning, default used) but the banner — built to tell "unset"
 * from "set and ignored" — would not have called it INVALID. Both now consult
 * one predicate table, keyed by the knob's kind.
 */

import {
  _resetEnvWarningsForTests,
  envEnum,
  envFlag,
  envIsSet,
  envIsSetButInvalid,
  envList,
  envNonNegativeInt,
  envPositiveInt,
} from '../src/server/env';

const NAME = 'SAMMY_TEST_NUMERIC_KNOB';

function withEnv(value: string | undefined, body: () => void): void {
  const prev = process.env[NAME];
  if (value === undefined) delete process.env[NAME];
  else process.env[NAME] = value;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env[NAME];
    else process.env[NAME] = prev;
  }
}

describe('env readers', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    _resetEnvWarningsForTests();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('unset → fallback, no warning, not "set but invalid"', () => {
    withEnv(undefined, () => {
      expect(envIsSet(NAME)).toBe(false);
      expect(envPositiveInt(NAME, 7)).toBe(7);
      expect(envNonNegativeInt(NAME, 7)).toBe(7);
      expect(envIsSetButInvalid(NAME, 'positive')).toBe(false);
      expect(envIsSetButInvalid(NAME)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('a unit suffix is rejected by both readers and reported INVALID by both kinds', () => {
    withEnv('14d', () => {
      expect(envPositiveInt(NAME, 7)).toBe(7);
      expect(envNonNegativeInt(NAME, 7)).toBe(7);
      expect(envIsSetButInvalid(NAME, 'positive')).toBe(true);
      expect(envIsSetButInvalid(NAME, 'non-negative')).toBe(true);
      // Warned once per variable, not once per read.
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it('0: the positive reader rejects it AND the positive banner check says INVALID', () => {
    withEnv('0', () => {
      expect(envPositiveInt(NAME, 7)).toBe(7);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(envIsSetButInvalid(NAME, 'positive')).toBe(true);
    });
  });

  it('0: the non-negative reader accepts it AND the (default) banner check does not call it INVALID', () => {
    // Several knobs use 0 as "disabled" (retention days, gate TTL) — their
    // banner line must say "OFF (=0)", not "INVALID".
    withEnv('0', () => {
      expect(envNonNegativeInt(NAME, 7)).toBe(0);
      expect(envIsSetButInvalid(NAME, 'non-negative')).toBe(false);
      expect(envIsSetButInvalid(NAME)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('a negative is invalid for both kinds; a positive float floors', () => {
    withEnv('-3', () => {
      expect(envIsSetButInvalid(NAME, 'positive')).toBe(true);
      expect(envIsSetButInvalid(NAME, 'non-negative')).toBe(true);
    });
    withEnv('2.9', () => {
      expect(envPositiveInt(NAME, 7)).toBe(2);
      expect(envIsSetButInvalid(NAME, 'positive')).toBe(false);
    });
  });
});

describe('envFlag', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    _resetEnvWarningsForTests();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it.each(['1', 'true', 'yes', 'on', ' TRUE ', 'Yes', '1 '])('%j is ON', v => {
    // `=== '1'` made every one of these except the first mean OFF for the
    // two SAMMY_REQUIRE_* flags — an operator who typed `true` had not
    // closed the door they believed they had.
    withEnv(v, () => {
      expect(envFlag(NAME)).toBe(true);
      expect(envFlag(NAME, { failClosed: true })).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it.each(['0', 'false', 'no', 'off', ' OFF '])('%j is OFF', v => {
    withEnv(v, () => {
      expect(envFlag(NAME)).toBe(false);
      expect(envFlag(NAME, { failClosed: true })).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('unset / empty is OFF, silently, whichever way it fails', () => {
    // An empty string is how a compose file leaves a knob unset.
    withEnv(undefined, () => {
      expect(envFlag(NAME)).toBe(false);
      expect(envFlag(NAME, { failClosed: true })).toBe(false);
    });
    withEnv('', () => {
      expect(envFlag(NAME)).toBe(false);
      expect(envFlag(NAME, { failClosed: true })).toBe(false);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a whitespace-only value is PRESENT but unrecognised: warns once, ON with failClosed', () => {
    // `=' '` (a stray space in a compose line) used to read as unset — OFF
    // with no [config] warning — for a flag whose promise is that a set-but-
    // unrecognised value warns and counts as ON. The operator typed
    // something; the fail-closed rule must see it.
    withEnv('   ', () => {
      expect(envFlag(NAME)).toBe(false);
      expect(envFlag(NAME)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`${NAME}="   "`);
    });
    _resetEnvWarningsForTests();
    withEnv(' ', () => {
      expect(envFlag(NAME, { failClosed: true })).toBe(true);
      expect(String(warn.mock.calls[1][0])).toContain('ENABLED');
    });
  });

  it('a present-but-unrecognised value warns once; it is OFF by default and ON with failClosed', () => {
    withEnv('maybe', () => {
      expect(envFlag(NAME)).toBe(false);
      expect(envFlag(NAME)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`${NAME}="maybe"`);
    });
    _resetEnvWarningsForTests();
    withEnv('maybe', () => {
      expect(envFlag(NAME, { failClosed: true })).toBe(true);
      expect(String(warn.mock.calls[1][0])).toContain('ENABLED');
    });
  });
});

describe('envList', () => {
  it('one grammar: commas, semicolons and whitespace all separate; entries are trimmed', () => {
    withEnv('a, b;c\td  e,,;', () => {
      expect(envList(NAME)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  it('unset / blank → empty', () => {
    withEnv(undefined, () => expect(envList(NAME)).toEqual([]));
    withEnv(' ', () => expect(envList(NAME)).toEqual([]));
  });
});

describe('envEnum', () => {
  const MODES = ['plan', 'default', 'acceptEdits'] as const;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    _resetEnvWarningsForTests();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('returns a recognised value (trimmed), the fallback when unset', () => {
    withEnv(' acceptEdits ', () => {
      expect(envEnum(NAME, MODES, 'default')).toBe('acceptEdits');
    });
    withEnv(undefined, () => {
      expect(envEnum(NAME, MODES, 'default')).toBe('default');
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an unrecognised value falls back and warns ONCE, not once per read', () => {
    withEnv('yolo', () => {
      expect(envEnum(NAME, MODES, 'default')).toBe('default');
      expect(envEnum(NAME, MODES, 'default')).toBe('default');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('plan | default | acceptEdits');
    });
  });
});
