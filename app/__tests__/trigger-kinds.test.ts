/**
 * Trigger-kind registry unit tests.
 *
 * The registry (src/trigger-kinds.ts) is the data-driven table the
 * validator + the server's describeTrigger both consume. These tests pin
 * the additive contract: every built-in kind is present with the right
 * `fired` side, describe() summaries match the historical switch output,
 * validate() reports the right field-scoped issues, and the unknown-kind
 * message is derived from the registry's key set (so it can't drift).
 */

import {
  TRIGGER_KINDS,
  TRIGGER_KIND_NAMES,
  getTriggerKind,
  describeTrigger,
  validateTrigger,
} from '../src/trigger-kinds';
import { LIVE_TRIGGER_KINDS, type Trigger } from '../src/types';

describe('trigger-kind registry — coverage', () => {
  it('registers exactly the six live kinds (in sync with LIVE_TRIGGER_KINDS)', () => {
    expect(new Set(TRIGGER_KIND_NAMES)).toEqual(new Set(LIVE_TRIGGER_KINDS));
    expect(TRIGGER_KIND_NAMES).toHaveLength(6);
  });

  it('tags each kind with the dispatch half it fires on', () => {
    const fired = Object.fromEntries(
      TRIGGER_KIND_NAMES.map(k => [k, TRIGGER_KINDS[k].fired]),
    );
    expect(fired).toEqual({
      webhook: 'http',
      events: 'http',
      deployment: 'http',
      queue: 'http',
      cron: 'schedule',
      polling: 'schedule',
    });
  });

  it('getTriggerKind returns undefined for an unknown kind', () => {
    expect(getTriggerKind('telepathy')).toBeUndefined();
  });
});

describe('describeTrigger — summaries match the historical switch', () => {
  const cases: Array<[Trigger, string]> = [
    [{ kind: 'webhook', path: 'foo' }, 'POST /api/triggers/foo'],
    [{ kind: 'webhook', path: 'foo', method: 'GET' }, 'GET /api/triggers/foo'],
    [{ kind: 'cron', expr: '*/5 * * * *' }, '*/5 * * * *'],
    [{ kind: 'events', event: 'pr.opened' }, 'pr.opened'],
    [{ kind: 'deployment', environment: 'staging' }, 'staging'],
    [{ kind: 'queue', queue: 'jobs' }, 'jobs'],
    [
      { kind: 'polling', source: 'https://x', intervalSeconds: 30 },
      'https://x every 30s',
    ],
  ];
  it.each(cases)('describes %j', (trigger, expected) => {
    expect(describeTrigger(trigger)).toBe(expected);
  });

  it('falls back to the raw kind (never throws) for an unknown kind', () => {
    expect(describeTrigger({ kind: 'telepathy' } as unknown as Trigger)).toBe('telepathy');
  });
});

describe('validateTrigger — field-scoped issues', () => {
  it('accepts every well-formed built-in', () => {
    expect(validateTrigger({ kind: 'webhook', path: 'wh' })).toEqual([]);
    expect(validateTrigger({ kind: 'cron', expr: '0 9 * * *' })).toEqual([]);
    expect(validateTrigger({ kind: 'events', event: 'a.done' })).toEqual([]);
    expect(validateTrigger({ kind: 'deployment', environment: 'prod' })).toEqual([]);
    expect(validateTrigger({ kind: 'queue', queue: 'jobs' })).toEqual([]);
    expect(
      validateTrigger({ kind: 'polling', source: 'https://x', intervalSeconds: 60 }),
    ).toEqual([]);
  });

  it('flags a bad webhook path on the `path` field', () => {
    const issues = validateTrigger({ kind: 'webhook', path: 'has spaces' });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('path');
  });

  it('flags a bad webhook method on the `method` field', () => {
    const issues = validateTrigger({ kind: 'webhook', path: 'ok', method: 'PUT' });
    expect(issues).toEqual([
      { field: 'method', message: expect.stringMatching(/GET or POST/) },
    ]);
  });

  it('flags both polling problems independently', () => {
    const issues = validateTrigger({ kind: 'polling' });
    expect(issues.map(i => i.field).sort()).toEqual(['intervalSeconds', 'source']);
  });

  it('reports a non-object trigger', () => {
    expect(validateTrigger(null)).toEqual([{ message: 'trigger must be an object' }]);
  });

  it('reports an unknown kind with the registry key set (no drift)', () => {
    const issues = validateTrigger({ kind: 'telepathy' });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('kind');
    // The valid set is derived from the registry, so it lists all six.
    for (const name of TRIGGER_KIND_NAMES) {
      expect(issues[0].message).toContain(name);
    }
  });
});

describe('author-time validation closes the silent-divergence gaps', () => {
  /**
   * Both of these used to save with a 200 and no warning, then be discarded
   * at registration behind a single console.warn — so the trigger did not
   * exist, /api/triggers never listed it, and nothing told the author. A
   * trigger that silently does not exist is the exact failure this project
   * is built to surface, so it belongs in the author-time lint rather than
   * only in the server's registration path.
   */
  const issuesFor = (trigger: unknown) => validateTrigger(trigger);

  describe('cron expr', () => {
    it.each([
      ['0 9 * * *', 'daily at 09:00'],
      ['*/15 * * * *', 'step values'],
      ['30 10 * * 1-5', 'a weekday range'],
      ['0 0 1 JAN *', 'month names'],
      ['*/5 * * * * *', '6-field with seconds'],
      ['0 0 * * ?', 'the dom/dow blank marker'],
    ])('accepts %s (%s)', expr => {
      expect(issuesFor({ kind: 'cron', expr })).toEqual([]);
    });

    it('rejects prose, naming the field count', () => {
      const [issue] = issuesFor({ kind: 'cron', expr: 'every monday' });
      expect(issue.field).toBe('expr');
      expect(issue.message).toMatch(/2 field\(s\)/);
      // The message has to show the author what a right answer looks like.
      expect(issue.message).toContain('0 9 * * *');
    });

    it('rejects the wrong number of fields in both directions', () => {
      expect(issuesFor({ kind: 'cron', expr: '0 9 * *' })).toHaveLength(1);
      expect(issuesFor({ kind: 'cron', expr: '0 0 9 * * * *' })).toHaveLength(1);
    });

    it('rejects an unparseable field and says which', () => {
      const [issue] = issuesFor({ kind: 'cron', expr: '0 9 * * mon@day' });
      expect(issue.message).toContain('mon@day');
    });

    it('still reports the missing-expr case', () => {
      expect(issuesFor({ kind: 'cron' })[0].field).toBe('expr');
    });

    it('validates `timezone`, so a typo is not a cron that throws forever', () => {
      expect(issuesFor({ kind: 'cron', expr: '0 9 * * *', timezone: 'UTC' })).toEqual([]);
      expect(
        issuesFor({ kind: 'cron', expr: '0 9 * * *', timezone: 'America/New_York' }),
      ).toEqual([]);
      const [issue] = issuesFor({
        kind: 'cron',
        expr: '0 9 * * *',
        timezone: 'America/New_Yrok',
      });
      expect(issue.field).toBe('timezone');
      expect(issue.message).toContain('America/New_York'); // suggests the shape
    });

    it('reports expr AND timezone problems together', () => {
      const issues = issuesFor({ kind: 'cron', expr: 'nope', timezone: 'Bad/Zone' });
      expect(issues.map(i => i.field).sort()).toEqual(['expr', 'timezone']);
    });
  });

  describe('polling source', () => {
    it('accepts absolute http(s) urls', () => {
      for (const source of [
        'http://localhost:8080/feed',
        'https://example.com/a?b=c',
      ]) {
        expect(issuesFor({ kind: 'polling', source, intervalSeconds: 30 })).toEqual([]);
      }
    });

    it('rejects a scheme-less host:port — the classic typo', () => {
      // Note this one PARSES as a URL ("localhost:" becomes the protocol),
      // so it has to be caught by the protocol check, and that message has
      // to carry the scheme hint too.
      const [issue] = issuesFor({
        kind: 'polling',
        source: 'localhost:8080',
        intervalSeconds: 30,
      });
      expect(issue.field).toBe('source');
      expect(issue.message).toMatch(/scheme/);
      expect(issue.message).toContain('http://localhost:8080');
    });

    it('rejects a non-http scheme', () => {
      const [issue] = issuesFor({
        kind: 'polling',
        source: 'file:///etc/passwd',
        intervalSeconds: 30,
      });
      expect(issue.message).toMatch(/must be http or https/);
    });

    it('reports source AND interval problems together', () => {
      // One save should surface every problem, not make the author iterate.
      const issues = issuesFor({ kind: 'polling', source: 'nope', intervalSeconds: 0 });
      expect(issues.map(i => i.field).sort()).toEqual(['intervalSeconds', 'source']);
    });
  });
});
