/**
 * Register-time lint for the `onStall` (stall → recovery) hook.
 *
 * `onStall.recover` must be a valid phase (recursed like an `onError` branch) and
 * `onStall.maxRetries`, when present, must be a non-negative integer.
 */

import { validateOrchestration } from '../src/validate';
import type { Node } from '../src/types';

const errorsFor = (n: Node) =>
  validateOrchestration(n).filter(e => e.severity === 'error');

describe('validate: onStall', () => {
  test('a well-formed onStall passes', () => {
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          stallTimeout: 60,
          onStall: { recover: { name: 'fix', agent: 'fixer' }, maxRetries: 2 },
        },
      ],
    });
    expect(errs).toHaveLength(0);
  });

  test('onStall without recover is an error', () => {
    const errs = errorsFor({
      name: 'root',
      // @ts-expect-error — intentionally omitting the required `recover`
      phases: [{ name: 'p', agent: 'a', onStall: { maxRetries: 1 } }],
    });
    expect(errs.some(e => /onStall\.recover is required/.test(e.message))).toBe(true);
  });

  test('onStall.recover that is not an object is an error', () => {
    const errs = errorsFor({
      name: 'root',
      // @ts-expect-error — recover must be a phase object
      phases: [{ name: 'p', agent: 'a', onStall: { recover: 'fixer' } }],
    });
    expect(errs.some(e => /onStall\.recover is required/.test(e.message))).toBe(true);
  });

  test('a malformed recover phase is caught by the recursive lint', () => {
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          // recover has a name but NO body — invalid like any phase.
          onStall: { recover: { name: 'fix' } as Node },
        },
      ],
    });
    // The recursed validateNode flags the bodyless recover phase.
    expect(
      errs.some(
        e => /no body/.test(e.message) && e.path.includes('onStall.recover'),
      ),
    ).toBe(true);
  });

  test('a negative maxRetries is an error', () => {
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          onStall: { recover: { name: 'fix', agent: 'fixer' }, maxRetries: -1 },
        },
      ],
    });
    expect(
      errs.some(e => /onStall\.maxRetries must be a non-negative integer/.test(e.message)),
    ).toBe(true);
  });

  test('a non-integer maxRetries is an error', () => {
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          onStall: { recover: { name: 'fix', agent: 'fixer' }, maxRetries: 1.5 },
        },
      ],
    });
    expect(
      errs.some(e => /onStall\.maxRetries must be a non-negative integer/.test(e.message)),
    ).toBe(true);
  });

  test('maxRetries: 0 is allowed (disables recovery)', () => {
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          onStall: { recover: { name: 'fix', agent: 'fixer' }, maxRetries: 0 },
        },
      ],
    });
    expect(errs).toHaveLength(0);
  });

  test('onStall as a non-object is an error', () => {
    const errs = errorsFor({
      name: 'root',
      // @ts-expect-error — onStall must be an object
      phases: [{ name: 'p', agent: 'a', onStall: true }],
    });
    expect(errs.some(e => /onStall must be an object/.test(e.message))).toBe(true);
  });

  test('a recover phase referencing an undefined ${ref} is still lint-walked (recovers reachable)', () => {
    // Smoke: the recover body participates in the normal node walk — a recover
    // with its own nested composite is validated recursively too.
    const errs = errorsFor({
      name: 'root',
      phases: [
        {
          name: 'p',
          agent: 'a',
          onStall: {
            recover: {
              name: 'fix-group',
              // a nested bodyless child is caught inside the recover subtree
              phases: [{ name: 'broken' } as Node],
            },
          },
        },
      ],
    });
    expect(errs.some(e => /no body/.test(e.message))).toBe(true);
  });
});
