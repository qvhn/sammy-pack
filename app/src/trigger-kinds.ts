/**
 * Trigger-kind registry — the data-driven table of trigger KINDS (axis 1:
 * *how* a run starts), so adding a kind is additive rather than editing a
 * growing `switch (t.kind)` in three different places.
 *
 * Context (see docs/PLUGGABLE_QUEUE_SOURCES.md): a trigger kind is acted on
 * at three points —
 *   1. declaration VALIDATION (validate.ts),
 *   2. a `describe(t)` summary (sammy-pack-api.ts), and
 *   3. server-side REGISTER / LISTEN wiring (sammy-pack-api.ts).
 *
 * This module turns the two PURE points (1 + 2) into one registry entry per
 * kind: `{ kind, fired, describe(t), validate(t) }`. `validate.ts` and the
 * server's `describeTrigger` look the kind up here, so a new kind's
 * shape + summary live in ONE place and the "unknown kind" message is
 * derived from the registry's key set.
 *
 * The REGISTER/LISTEN wiring (point 3 — cron timers, polling intervals,
 * the HTTP-fired named-trigger maps) is deliberately NOT folded in: it is
 * tightly bound to the server's request-scoped closure state (the trigger
 * maps, `deliver()`, node-cron, the catalog), and a registry that owned it
 * would have to own that state too. `fired` records which side each kind
 * lives on so that extraction stays mechanical; see the ADR's
 * "trigger-kind registry" section.
 *
 * This module is pure (no server imports), so it's unit-testable and usable
 * from both the validator and the server.
 */

import { validateIdempotencyTtl, validateScrubPolicy } from './intake-options';
import { isValidTimeZone } from './server/cron-bucket';
import { WEBHOOK_PROVIDER_NAMES, type Trigger } from './types';

/** How a kind is fired — metadata that documents which dispatch half a
 *  kind's register/listen wiring lives on (the not-yet-extracted point 3).
 *    - 'http'     : fired by an inbound HTTP request to /api/<ns>/<name>
 *                   (webhook / events / deployment / queue).
 *    - 'schedule' : fired by a server-side timer (cron / polling). */
export type TriggerFiring = 'http' | 'schedule';

/** One field-scoped validation problem for a trigger declaration. `field`
 *  is the sub-path under `triggers[i]` (e.g. "path", "intervalSeconds");
 *  omit it for a whole-trigger problem. The caller renders these into its
 *  own error shape. */
export interface TriggerValidationIssue {
  field?: string;
  message: string;
}

/** A trigger-kind descriptor. One entry per kind makes validation + the
 *  human summary additive. `T` narrows to the concrete trigger variant. */
export interface TriggerKindDef<T extends Trigger = Trigger> {
  /** The discriminator value, e.g. "webhook". */
  kind: T['kind'];
  /** Which dispatch half this kind's firing lives on (see TriggerFiring). */
  fired: TriggerFiring;
  /** A short human summary of a configured trigger (for the catalog / UI /
   *  logs), e.g. "POST /api/triggers/foo" or a cron expression. */
  describe(trigger: T): string;
  /** Validate a trigger declaration of THIS kind. Returns the problems
   *  (empty = valid). `kind` itself is already known-correct here. */
  validate(trigger: T): TriggerValidationIssue[];
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Validate the `signed` field shared by the four HTTP-fired kinds.
 *
 *  This check is the reason a typo cannot quietly weaken an endpoint. The
 *  ingress resolves `signed` to a provider and enforces nothing when it
 *  resolves to none — so `"signed": "githbu"` would otherwise register a
 *  trigger its author believed was authenticated and leave it wide open.
 *  An unrecognized value is an ERROR here, and the server additionally
 *  refuses to register such a trigger at all (fail closed: no endpoint beats
 *  an unprotected one). */
function validateSigned(signed: unknown): TriggerValidationIssue[] {
  if (signed === undefined || typeof signed === 'boolean') return [];
  if (
    typeof signed === 'string' &&
    (WEBHOOK_PROVIDER_NAMES as readonly string[]).includes(signed)
  ) {
    return [];
  }
  return [
    {
      field: 'signed',
      message:
        'signed must be true/false (sammy-pack\'s own X-Sammy-Signature scheme) or ' +
        `one of ${WEBHOOK_PROVIDER_NAMES.join(' / ')} (got ${JSON.stringify(signed)})`,
    },
  ];
}

// ── The built-in kinds (the closed, server-owned set) ────────────────────

const webhook: TriggerKindDef<Extract<Trigger, { kind: 'webhook' }>> = {
  kind: 'webhook',
  fired: 'http',
  describe: t => `${t.method ?? 'POST'} /api/triggers/${t.path}`,
  validate: t => {
    const issues: TriggerValidationIssue[] = [];
    if (!isNonEmptyString(t.path) || !/^[a-zA-Z0-9_-]+$/.test(t.path)) {
      issues.push({
        field: 'path',
        message:
          'webhook trigger needs a `path` string (alphanumeric / underscore / hyphen)',
      });
    }
    if (t.method !== undefined && t.method !== 'GET' && t.method !== 'POST') {
      issues.push({ field: 'method', message: 'webhook trigger method must be GET or POST' });
    }
    issues.push(...validateSigned(t.signed));
    return issues;
  },
};

/** Shape-check a cron expression: 5 or 6 whitespace-separated fields, each
 *  made only of the characters cron allows.
 *
 *  Deliberately a SHAPE check, not a reimplementation of node-cron's parser —
 *  registration still calls `cron.validate()`, which is authoritative. The
 *  point is that author time otherwise catches nothing at all: `"expr":
 *  "every monday"` saves with a 200 and no warning, then gets dropped at
 *  registration behind a single console.warn — the trigger simply never
 *  exists, and /api/triggers never mentions it. That is precisely the
 *  silent intent/reality divergence this project is built to surface, so it
 *  belongs in the author-time lint. */
function cronExprIssues(expr: string): TriggerValidationIssue[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) {
    return [
      {
        field: 'expr',
        message:
          `cron expr ${JSON.stringify(expr)} has ${fields.length} field(s); ` +
          'expected 5 (min hour dom month dow) or 6 (with leading seconds), ' +
          'e.g. "0 9 * * *" for daily at 09:00',
      },
    ];
  }
  // Digits, names, and cron's own operators: * , - / and ? (dom/dow blank).
  const bad = fields.filter(f => !/^[0-9A-Za-z*,\-/?]+$/.test(f));
  if (bad.length > 0) {
    return [
      {
        field: 'expr',
        message:
          `cron expr ${JSON.stringify(expr)} has unparseable field(s) ` +
          `${bad.map(b => JSON.stringify(b)).join(', ')}`,
      },
    ];
  }
  return [];
}

const cron: TriggerKindDef<Extract<Trigger, { kind: 'cron' }>> = {
  kind: 'cron',
  fired: 'schedule',
  describe: t => t.expr,
  validate: t => [
    ...(isNonEmptyString(t.expr)
      ? cronExprIssues(t.expr)
      : [
          {
            field: 'expr',
            message: 'cron trigger needs an `expr` string (5-field cron)',
          },
        ]),
    // A bad zone would otherwise throw on every tick, forever, for the life
    // of the process — the same silent-trigger shape the expr check closes.
    ...(t.timezone !== undefined && !isValidTimeZone(t.timezone)
      ? [
          {
            field: 'timezone',
            message:
              `cron timezone ${JSON.stringify(t.timezone)} is not an IANA zone ` +
              'this runtime knows (e.g. "UTC", "America/New_York", "Europe/London")',
          },
        ]
      : []),
  ],
};

const events: TriggerKindDef<Extract<Trigger, { kind: 'events' }>> = {
  kind: 'events',
  fired: 'http',
  describe: t => t.event,
  validate: t => [
    ...(isNonEmptyString(t.event)
      ? []
      : [{ field: 'event', message: 'events trigger needs an `event` name string' }]),
    ...validateSigned(t.signed),
  ],
};

const deployment: TriggerKindDef<Extract<Trigger, { kind: 'deployment' }>> = {
  kind: 'deployment',
  fired: 'http',
  describe: t => t.environment,
  validate: t => [
    ...(isNonEmptyString(t.environment)
      ? []
      : [
          {
            field: 'environment',
            message: 'deployment trigger needs an `environment` string',
          },
        ]),
    ...validateSigned(t.signed),
  ],
};

const queue: TriggerKindDef<Extract<Trigger, { kind: 'queue' }>> = {
  kind: 'queue',
  fired: 'http',
  describe: t => t.queue,
  validate: t => [
    ...(isNonEmptyString(t.queue)
      ? []
      : [{ field: 'queue', message: 'queue trigger needs a `queue` name string' }]),
    ...validateSigned(t.signed),
  ],
};

/** The source must parse as an http(s) URL. Without this, `"localhost:8080"`
 *  saved clean and then threw inside every single tick, forever — a trigger
 *  that looks registered and can never fire. */
function pollingSourceIssues(source: string): TriggerValidationIssue[] {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return [
      {
        field: 'source',
        message:
          `polling source ${JSON.stringify(source)} is not a valid absolute URL ` +
          '(did you omit the scheme? use "http://localhost:8080/path")',
      },
    ];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // "localhost:8080" PARSES — URL reads "localhost:" as the protocol and
    // "8080" as the path — so the commonest typo lands here rather than in
    // the catch above. The scheme hint has to be on this branch too.
    return [
      {
        field: 'source',
        message:
          `polling source ${JSON.stringify(source)} must be http or https, not ` +
          `${JSON.stringify(url.protocol)} — did you omit the scheme? ` +
          'use "http://localhost:8080/path"',
      },
    ];
  }
  return [];
}

const polling: TriggerKindDef<Extract<Trigger, { kind: 'polling' }>> = {
  kind: 'polling',
  fired: 'schedule',
  describe: t => `${t.source} every ${t.intervalSeconds}s`,
  validate: t => {
    const issues: TriggerValidationIssue[] = [];
    if (!isNonEmptyString(t.source)) {
      issues.push({ field: 'source', message: 'polling trigger needs a `source` URL string' });
    } else {
      issues.push(...pollingSourceIssues(t.source));
    }
    if (typeof t.intervalSeconds !== 'number' || t.intervalSeconds < 1) {
      issues.push({
        field: 'intervalSeconds',
        message: 'polling trigger needs `intervalSeconds` ≥ 1',
      });
    }
    return issues;
  },
};

/** The registry, keyed by kind. Adding a kind = one entry here (+ the
 *  Trigger union + LIVE_TRIGGER_KINDS in types.ts). */
export const TRIGGER_KINDS = {
  webhook,
  cron,
  events,
  deployment,
  queue,
  polling,
} as const satisfies Record<Trigger['kind'], TriggerKindDef>;

/** Every registered kind name, in declaration order. Used to derive the
 *  "unknown kind" message so it can never drift from the registry. */
export const TRIGGER_KIND_NAMES = Object.keys(TRIGGER_KINDS) as Array<Trigger['kind']>;

/** Look up a kind descriptor; undefined for an unknown kind. */
export function getTriggerKind(kind: string): TriggerKindDef | undefined {
  return (TRIGGER_KINDS as Record<string, TriggerKindDef>)[kind];
}

/**
 * Describe any trigger via its registered descriptor. Falls back to the raw
 * kind for an unknown kind (shouldn't happen post-validation, but never
 * throws — callers use this for logs/UI).
 */
export function describeTrigger(trigger: Trigger): string {
  const def = getTriggerKind(trigger.kind);
  return def ? def.describe(trigger as never) : String((trigger as { kind?: unknown }).kind);
}

/**
 * Validate a trigger declaration through the registry. Returns issues for
 * an unknown kind (one whole-trigger issue listing the valid set) or the
 * kind-specific issues otherwise. Pure — the caller renders these.
 */
export function validateTrigger(trigger: unknown): TriggerValidationIssue[] {
  if (!trigger || typeof trigger !== 'object') {
    return [{ message: 'trigger must be an object' }];
  }
  const kind = (trigger as { kind?: unknown }).kind;
  const def = typeof kind === 'string' ? getTriggerKind(kind) : undefined;
  if (!def) {
    return [
      {
        field: 'kind',
        message: `trigger kind must be one of ${TRIGGER_KIND_NAMES.join(' / ')} (got ${JSON.stringify(kind)})`,
      },
    ];
  }
  const issues = def.validate(trigger as never);
  // Ingress options (scrub / idempotency window) shape how an INBOUND fire is
  // recorded, so they exist only on HTTP-fired kinds. On a schedule-fired
  // kind they would be silently ignored — say so instead.
  const t = trigger as { scrub?: unknown; idempotencyTtlSeconds?: unknown };
  if (def.fired === 'http') {
    for (const m of validateScrubPolicy(t.scrub)) issues.push({ field: 'scrub', message: m });
    for (const m of validateIdempotencyTtl(t.idempotencyTtlSeconds)) {
      issues.push({ field: 'idempotencyTtlSeconds', message: m });
    }
  } else {
    for (const f of ['scrub', 'idempotencyTtlSeconds'] as const) {
      if (t[f] !== undefined) {
        issues.push({
          field: f,
          message: `${f} applies only to HTTP-fired triggers (webhook / events / deployment / queue), not ${def.kind}`,
        });
      }
    }
  }
  return issues;
}
