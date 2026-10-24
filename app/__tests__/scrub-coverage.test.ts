/**
 * Every event that carries free text is actually scrubbed.
 *
 * `run-runner.ts` described its stream wrapper as "the single chokepoint every
 * event passes through before the run-controller persists + broadcasts it, so
 * it's the 'scrub before appendEvent' hook the security invariant requires".
 * It was not a chokepoint — four route handlers called `store.appendEvent`
 * directly and went around it, including `signal-received.payload`, which is
 * the raw POST body of an unauthenticated-ingress-adjacent route. The
 * invariant was asserted in a comment and enforced by nothing.
 *
 * Two different failures were possible and both are now covered:
 *
 *  1. A CALLER that bypasses the scrubber. Fixed by moving `scrubEvent` into
 *     `scrub-secrets.ts` so the routes can use the same function, and wrapping
 *     the three text-bearing route appends.
 *
 *  2. A NEW event variant with a text field that the scrubber's switch does
 *     not know about — which produced no compiler error and no test failure.
 *     That is what the drift test below is for: it reads the RunEvent union
 *     out of `executor.ts`, finds every variant declaring a free-text field,
 *     and asserts the scrubber handles it. Adding `{ type: 'whatever';
 *     error: string }` without teaching the scrubber now fails here.
 *
 *     "Free-text field" is DERIVED, not listed: every field the union types as
 *     `string` (or `string | undefined`) is a candidate unless its name is on
 *     the short STRUCTURAL allowlist of identifiers below. Filtering on a
 *     fixed list of field names instead would reproduce the same stale-list
 *     failure one level up: a new variant carrying model output under a name
 *     the list does not have (`detail`, `summary`, `stderr`…) slips through
 *     the net silently.
 *
 * Same idiom as `cli-parity`: the source of truth is the code, and the test
 * derives from it rather than restating it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { scrubEvent, serverSecretValues } from '../src/server/scrub-secrets';

const EXECUTOR = path.resolve(__dirname, '..', 'src', 'llm', 'executor.ts');

/**
 * String-typed fields that are IDENTIFIERS, not free text — names the
 * orchestration author, the SDK or the platform chose, never model / human /
 * sender output. Scrubbing them would be a no-op at best and, for an audit
 * identity like `decidedBy`, destructive. Everything string-typed and NOT
 * here must be scrubbed. Keep this list short and each entry justified:
 *
 *   phaseName / orchestrationName / name / pausedFor — node + definition names
 *   agentPath / model / via / source / kind / type / stage — dispatch metadata
 *   toolUseId / toolName / replayKey / key / signal / branch — SDK ids, state
 *     keys, declared route-branch / switch-case keys, signal names
 *   decision / decidedBy — the gate verdict enum and the approver's identity
 *   version — the definition's semver pin
 */
const STRUCTURAL = new Set([
  'phaseName',
  'orchestrationName',
  'name',
  'pausedFor',
  'agentPath',
  'model',
  'via',
  'source',
  'kind',
  'type',
  'stage',
  'toolUseId',
  'toolName',
  'replayKey',
  'key',
  'signal',
  'branch',
  'decision',
  'decidedBy',
  'version',
]);

/** Structural fields that are only structural ON ONE VARIANT — exempted
 *  there and nowhere else, so a future free-text `path` on another event is
 *  still held to the coverage check:
 *    worktrees-ready.path / .base — a worktree's server-generated location
 *    and the commit sha it started from (a sha is exactly the high-entropy
 *    shape the scrubber's pattern pass would destroy). */
const STRUCTURAL_BY_VARIANT: Record<string, string[]> = {
  'worktrees-ready': ['path', 'base'],
};

/** Field names that are free text by their nature and must be scrubbed even
 *  if a variant types one more narrowly (e.g. `reason: 'user' | 'max-turns'`
 *  on phase-paused — scrubbing an enum is a harmless no-op, and the cost of
 *  missing a free-text one is a leaked secret). */
const ALWAYS_TEXT = ['text', 'output', 'error', 'reason', 'message', 'payload'];

/**
 * Parse the `RunEvent` union out of executor.ts: every `type: '<name>'`
 * together with the free-text field names declared in the same union member.
 *
 * Deliberately a source scan rather than a hand-maintained list — a hand list
 * is the thing that goes stale, and this file exists because something went
 * stale.
 */
function eventVariantsWithTextFields(): Map<string, string[]> {
  const src = fs.readFileSync(EXECUTOR, 'utf8');
  const start = src.indexOf('export type RunEvent =');
  expect(start).toBeGreaterThan(-1);
  // The union ends at the first blank line after its last `ts: number; };`.
  const end = src.indexOf('\n\n', src.indexOf('ts: number;\n    };', start));
  const union = src.slice(start, end > start ? end : start + 40_000);

  const out = new Map<string, string[]>();
  // Split on `| {` / `| { type:` boundaries; each chunk is one variant.
  for (const chunk of union.split(/\n\s*\|\s*/)) {
    const typeMatch = /type:\s*'([a-z-]+)'/.exec(chunk);
    if (!typeMatch) continue;
    const name = typeMatch[1];
    const fields = new Set<string>();
    // Every `field: string` / `field?: string` / `field: string | undefined`
    // declared in this member, minus the structural identifiers. A field is
    // delimited by `{`, `;` or a newline before it and `;` or `}` after —
    // NOT by line starts: the one-line members (`| { type: 'run-error';
    // error: string; ts: number }`) put every field on the same line, and
    // the first version of this net anchored on line starts and so never
    // saw `run-error`, `phase-error`, `phase-delta`, `budget-halted`… at all.
    const decl =
      /(?:^|[{;\n])\s*(\w+)\??:\s*string(?:\s*\|\s*undefined)?\s*(?=[;}])/g;
    for (let m = decl.exec(chunk); m; m = decl.exec(chunk)) {
      if (!STRUCTURAL.has(m[1]) && !(STRUCTURAL_BY_VARIANT[name] ?? []).includes(m[1])) {
        fields.add(m[1]);
      }
    }
    for (const f of ALWAYS_TEXT) {
      if (new RegExp(`(^|[{;\\n])\\s*${f}\\??:`).test(chunk)) fields.add(f);
    }
    if (fields.size > 0) out.set(name, [...fields]);
  }
  return out;
}

const SECRET = 'sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

describe('scrubEvent covers every text-bearing event variant', () => {
  const variants = eventVariantsWithTextFields();

  it('found a meaningful number of variants to check', () => {
    // Floor guards against the parser silently matching nothing and the whole
    // suite passing vacuously.
    expect(variants.size).toBeGreaterThan(8);
  });

  it('the derivation sees the fields the old fixed list knew about', () => {
    // A second vacuity guard, on the DERIVATION: if the string-field regex
    // stopped matching, the structural allowlist would make this pass with
    // nothing checked. Pin a few known free-text fields.
    expect(variants.get('phase-end')).toContain('output');
    expect(variants.get('gate-decision')).toContain('message');
    expect(variants.get('signal-received')).toContain('payload');
    expect(variants.get('phase-terminal')).toContain('reason');
    // The one-line members the line-anchored parser used to skip entirely.
    expect(variants.get('phase-error')).toContain('error');
    expect(variants.get('run-error')).toContain('error');
    expect(variants.get('phase-delta')).toContain('text');
    expect(variants.get('budget-halted')).toContain('reason');
  });

  it.each([...variants].map(([name, fields]) => [name, fields] as const))(
    '%s redacts %s',
    (type, fields) => {
      for (const field of fields) {
        const ev = { type, [field]: `prefix ${SECRET} suffix`, ts: 1 };
        const scrubbed = scrubEvent(ev) as Record<string, unknown>;
        const value = String(scrubbed[field] ?? '');
        expect(value).not.toContain(SECRET);
      }
    },
  );
});

describe('scrubEvent redaction behaviour', () => {
  it('redacts an injected run secret, not just a known token pattern', () => {
    const ev = { type: 'phase-end', output: 'the value is hunter2-abcdef', ts: 1 };
    const out = scrubEvent(ev, ['hunter2-abcdef']) as { output: string };
    expect(out.output).not.toContain('hunter2-abcdef');
  });

  it('redacts a secret pasted into a SIGNAL payload (route-level append)', () => {
    // The raw POST body of /api/runs/:id/signal, which used to land verbatim.
    const ev = { type: 'signal-received', signal: 'go', payload: SECRET, ts: 1 };
    expect(String((scrubEvent(ev) as { payload: string }).payload)).not.toContain(
      SECRET,
    );
  });

  it('redacts a secret pasted into a GATE message, and keeps the approver', () => {
    const ev = {
      type: 'gate-decision',
      phaseName: 'review',
      decision: 'approve',
      message: `ship it, token ${SECRET}`,
      decidedBy: 'alice',
      ts: 1,
    };
    const out = scrubEvent(ev) as { message: string; decidedBy: string };
    expect(out.message).not.toContain(SECRET);
    // `decidedBy` is an identity, not free text — redacting it would destroy
    // the audit trail it exists to provide.
    expect(out.decidedBy).toBe('alice');
  });

  it('deep-scrubs tool-call arguments', () => {
    const ev = {
      type: 'phase-tool-use',
      input: { command: `curl -H "Authorization: ${SECRET}" https://x` },
      ts: 1,
    };
    expect(JSON.stringify(scrubEvent(ev))).not.toContain(SECRET);
  });

  it("redacts the SERVER's own env secrets from agent output", () => {
    // Agents inherit the server environment by design — that is an accepted
    // access decision. Inheriting a secret and PERSISTING it in the durable
    // log are different things: an agent that echoes $SAMMY_API_TOKEN used to
    // land it in `events`, the SSE stream, an exported trace and the UI.
    // These are NOT in the run's injectedSecrets set (that only holds
    // per-phase credential values), and a human-chosen token matches no
    // pattern.
    const prev = process.env.SAMMY_API_TOKEN;
    process.env.SAMMY_API_TOKEN = 'correct-horse-battery-staple';
    try {
      const ev = {
        type: 'phase-end',
        output: 'echo correct-horse-battery-staple',
        ts: 1,
      };
      // No per-run secret set passed — the server's own secrets are always on.
      const out = scrubEvent(ev) as { output: string };
      expect(out.output).not.toContain('correct-horse-battery-staple');
    } finally {
      if (prev === undefined) delete process.env.SAMMY_API_TOKEN;
      else process.env.SAMMY_API_TOKEN = prev;
    }
  });
});

describe('server env secrets by NAME shape (operator-supplied credentials)', () => {
  /** Set `name` for the test body, restoring whatever was there after. */
  function withEnv(name: string, value: string, body: () => void): void {
    const prev = process.env[name];
    process.env[name] = value;
    try {
      body();
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  }

  it('redacts a GITHUB_TOKEN-named variable the hardcoded list never knew', () => {
    // No known prefix, under the generic-blob floor, not on the explicit
    // list: exactly the operator-supplied credential that used to reach the
    // log when an agent echoed it.
    withEnv('GITHUB_TOKEN', 'plain-human-chosen-value', () => {
      expect(serverSecretValues()).toContain('plain-human-chosen-value');
      const out = scrubEvent({
        type: 'phase-end',
        output: 'curl -H "Authorization: plain-human-chosen-value"',
        ts: 1,
      }) as { output: string };
      expect(out.output).not.toContain('plain-human-chosen-value');
      expect(out.output).toContain('[REDACTED]');
    });
  });

  it('covers the other name shapes: *_PASSWORD, *_SECRET, *_API_KEY, *_CREDENTIAL*', () => {
    withEnv('DB_PASSWORD', 'db-pass-value-1', () =>
      withEnv('WEBHOOK_SIGNING_SECRET', 'signing-secret-2', () =>
        withEnv('JIRA_API_KEY', 'jira-api-key-3', () =>
          withEnv('SERVICE_CREDENTIALS', 'service-cred-4', () => {
            const values = serverSecretValues();
            for (const v of [
              'db-pass-value-1',
              'signing-secret-2',
              'jira-api-key-3',
              'service-cred-4',
            ]) {
              expect(values).toContain(v);
            }
          }),
        ),
      ),
    );
  });

  it('does NOT redact a numeric knob whose name merely contains TOKEN / TIMEOUT', () => {
    // SAMMY_MAX_AGENT_TOKENS is a token COUNT; SAMMY_PG_STATEMENT_TIMEOUT_MS a
    // duration. Redacting "6000000" wherever it appears in output is noise,
    // not safety.
    withEnv('SAMMY_MAX_AGENT_TOKENS', '60000000', () =>
      withEnv('SAMMY_PG_STATEMENT_TIMEOUT_MS', '120000000', () =>
        withEnv('GITHUB_TOKEN_FILE', '/run/secrets/github-token', () => {
          const values = serverSecretValues();
          expect(values).not.toContain('60000000');
          expect(values).not.toContain('120000000');
          expect(values).not.toContain('/run/secrets/github-token');
          const out = scrubEvent({
            type: 'phase-end',
            output: 'ceiling is 60000000 tokens, statement timeout 120000000',
            ts: 1,
          }) as { output: string };
          expect(out.output).toContain('60000000');
        }),
      ),
    );
  });

  it('ignores a short value under the name-shape floor (avoids redacting prose)', () => {
    withEnv('DB_PASSWORD', 'short', () => {
      expect(serverSecretValues()).not.toContain('short');
    });
  });
});
