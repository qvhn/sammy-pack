/**
 * Payload scrubbing at INGRESS — a trigger's declared `scrub` policy applied
 * to the body BEFORE it is stored as a delivery, so personal data in an
 * inbound payload never reaches the run store, a prompt, a ticket, or a log.
 *
 * Distinct from `scrub-secrets.ts`, which redacts the server's OWN secrets
 * (injected credentials, env tokens) out of run output on the way OUT. That
 * layer knows the exact values it is hunting; this one does not know whose
 * phone number is in a webhook body, so it works by policy:
 *
 *   1. `allowFields` — when set, ONLY these JSON paths survive. An allowlist is
 *      the strong form: a field the sender adds next month is dropped by
 *      default instead of leaking by default.
 *   2. `dropFields`  — remove these paths.
 *   3. `hashFields`  — replace these values with a salted digest, so they stay
 *      COUNTABLE (distinct users affected) without being readable. The salt is
 *      `SAMMY_SCRUB_SALT`; with no salt the field is dropped rather than
 *      hashed, because an unsalted digest of a short identifier is reversible
 *      by enumeration.
 *   4. patterns      — every remaining string value (or the whole body, when
 *      it is not JSON) has the built-in detectors (email, phone, bearer token,
 *      JWT, known secret formats) and any custom `patterns` replaced.
 *
 * Paths are dot-separated; `*` matches any single key or array index
 * (`samples.*.stack`). Naming a container keeps or drops its whole subtree.
 *
 * Fail closed: an `allowFields` policy on a body that is not JSON cannot be
 * applied, so the body is replaced by a placeholder rather than passed raw.
 */

import { createHash } from 'node:crypto';
import { scrubSecrets } from './scrub-secrets';
import {
  BUILTIN_DETECTORS,
  compilePattern,
  type BuiltinDetector,
  type ScrubPolicy,
} from '../intake-options';

export { BUILTIN_DETECTORS, validateScrubPolicy } from '../intake-options';
export type { BuiltinDetector, ScrubPattern, ScrubPolicy } from '../intake-options';

export type ScrubResult = {
  body: string;
  /** Values replaced by a detector / pattern. */
  redactions: number;
  /** Paths removed by `allowFields` / `dropFields` (or hashed-then-dropped). */
  fieldsDropped: number;
  fieldsHashed: number;
  /** True when an `allowFields` policy met a non-JSON body. */
  replacedNonJson: boolean;
};

export const NON_JSON_PLACEHOLDER =
  '{"_scrubbed":"non-JSON payload dropped: the trigger\'s scrub.allowFields policy needs a JSON body"}';

/** Detector regexes. Phone numbers require separators or a leading `+`, so
 *  ISO dates, epoch timestamps and plain ids are not mistaken for one. */
const DETECTORS: Record<Exclude<BuiltinDetector, 'secrets'>, { re: RegExp; label: string }> = {
  email: {
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    label: '[email]',
  },
  jwt: {
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    label: '[jwt]',
  },
  bearer: {
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    label: '$1 [token]',
  },
  phone: {
    re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)|\d{1,4})(?:[\s.-]?\d{2,4}){2,3}|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/g,
    label: '[phone]',
  },
};

function activeDetectors(policy: ScrubPolicy): Set<BuiltinDetector> {
  if (policy.builtins === false) return new Set();
  if (Array.isArray(policy.builtins)) return new Set(policy.builtins);
  return new Set(BUILTIN_DETECTORS);
}

type Path = string[];
const parsePath = (p: string): Path => p.split('.').map(s => s.trim()).filter(Boolean);

function segMatches(pattern: string, seg: string): boolean {
  return pattern === '*' || pattern === seg;
}

/** `pattern` matches `path` exactly (same length). */
function matchesExactly(pattern: Path, path: Path): boolean {
  return pattern.length === path.length && pattern.every((s, i) => segMatches(s, path[i]));
}

/** `path` is a proper prefix of something `pattern` could match. */
function isAncestorOf(path: Path, pattern: Path): boolean {
  return pattern.length > path.length && path.every((s, i) => segMatches(pattern[i], s));
}

function entriesOf(v: unknown): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>);
  return [];
}

function rebuild(container: unknown, entries: Array<[string, unknown]>): unknown {
  if (Array.isArray(container)) return entries.map(([, x]) => x);
  return Object.fromEntries(entries);
}

export function scrubPayload(
  body: string,
  policy: ScrubPolicy,
  opts: { salt?: string } = {},
): ScrubResult {
  const result: ScrubResult = {
    body,
    redactions: 0,
    fieldsDropped: 0,
    fieldsHashed: 0,
    replacedNonJson: false,
  };
  const detectors = activeDetectors(policy);
  const custom = (policy.patterns ?? []).map(p => ({
    re: compilePattern(p),
    label: p.replacement ?? '[redacted]',
  }));
  const salt = opts.salt ?? process.env.SAMMY_SCRUB_SALT ?? '';

  const scrubText = (text: string): string => {
    let out = text;
    for (const name of ['jwt', 'bearer', 'email', 'phone'] as const) {
      if (!detectors.has(name)) continue;
      const { re, label } = DETECTORS[name];
      re.lastIndex = 0;
      out = out.replace(re, (...m) => {
        result.redactions += 1;
        return label.replace('$1', String(m[1] ?? ''));
      });
    }
    if (detectors.has('secrets')) {
      const before = out;
      out = scrubSecrets(out);
      if (out !== before) result.redactions += 1;
    }
    for (const { re, label } of custom) {
      re.lastIndex = 0;
      out = out.replace(re, () => {
        result.redactions += 1;
        return label;
      });
    }
    return out;
  };

  let parsed: unknown;
  let isJson = false;
  let isForm = false;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed);
      isJson = true;
    } catch {
      isJson = false;
    }
  } else if (FORM_BODY.test(trimmed)) {
    // A form-encoded body (`a=1&b=2`, what many providers POST) is a flat
    // object in disguise: percent-encoding hides `%40` / `%2B` from every
    // text detector, so it is decoded, scrubbed field by field like JSON
    // (allow / drop / hash all apply) and re-encoded.
    const obj: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(trimmed)) {
      const prior = obj[k];
      obj[k] = prior === undefined ? v : Array.isArray(prior) ? [...prior, v] : [prior, v];
    }
    parsed = obj;
    isForm = true;
  }

  if (!isJson && !isForm) {
    if (policy.allowFields && policy.allowFields.length > 0) {
      result.body = NON_JSON_PLACEHOLDER;
      result.replacedNonJson = true;
      return result;
    }
    result.body = scrubText(body);
    return result;
  }

  const allow = (policy.allowFields ?? []).map(parsePath);
  const drop = (policy.dropFields ?? []).map(parsePath);
  const hash = (policy.hashFields ?? []).map(parsePath);

  const walk = (value: unknown, path: Path, underAllowed: boolean): unknown => {
    if (!Array.isArray(value) && !(value && typeof value === 'object')) {
      if (typeof value === 'string') return scrubText(value);
      return value;
    }
    const kept: Array<[string, unknown]> = [];
    for (const [k, v] of entriesOf(value)) {
      const child = [...path, k];
      let allowedHere = underAllowed;
      if (allow.length > 0 && !underAllowed) {
        if (allow.some(a => matchesExactly(a, child))) {
          allowedHere = true;
        } else if (!allow.some(a => isAncestorOf(child, a))) {
          result.fieldsDropped += 1;
          continue;
        }
      }
      if (drop.some(d => matchesExactly(d, child))) {
        result.fieldsDropped += 1;
        continue;
      }
      if (hash.some(h => matchesExactly(h, child)) && v !== null && typeof v !== 'object') {
        if (!salt) {
          result.fieldsDropped += 1;
          continue;
        }
        kept.push([
          k,
          `hash:${createHash('sha256').update(`${salt}\u0000${String(v)}`).digest('hex').slice(0, 24)}`,
        ]);
        result.fieldsHashed += 1;
        continue;
      }
      // Object KEYS are data too (`{"jane@example.com": "sent"}`): run the
      // detectors over them after the path decisions above, which matched
      // the original key. A collision gets a numeric suffix.
      let key = k;
      if (!Array.isArray(value)) {
        key = scrubText(k);
        if (key !== k) {
          let n = 2;
          const base = key;
          while (kept.some(([kk]) => kk === key)) key = `${base}#${n++}`;
        }
      }
      kept.push([key, walk(v, child, allowedHere)]);
    }
    return rebuild(value, kept);
  };

  const scrubbed = walk(parsed, [], allow.length === 0);
  if (isForm) {
    // Nothing changed → hand back the body exactly as received (decoding and
    // re-encoding would otherwise rewrite `%20` as `+` and the like).
    if (result.redactions === 0 && result.fieldsDropped === 0 && result.fieldsHashed === 0) {
      result.body = body;
      return result;
    }
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(scrubbed as Record<string, unknown>)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        out.append(k, typeof one === 'string' ? one : JSON.stringify(one));
      }
    }
    result.body = out.toString();
  } else {
    result.body = JSON.stringify(scrubbed);
  }
  return result;
}

/** `k=v&k2=v2`. Keys may be percent- or `+`-encoded (`user%5Bemail%5D`,
 *  `first+name` — what jQuery / Rails forms send) but never contain `/`, `:`
 *  or `?`, which is what keeps a URL (`https://…?a=1`) or base64 with a `/`
 *  from being mistaken for a form. (An unchanged form body is returned
 *  byte-for-byte anyway, so a false positive that redacts nothing is free.) */
const FORM_BODY = /^[A-Za-z0-9_.\-[\]%+*~]+=[^\s&]*(?:&[A-Za-z0-9_.\-[\]%+*~]+=[^\s&]*)*$/;

/** One-line summary for a delivery's audit trail. */
export function describeScrub(r: ScrubResult): string {
  if (r.replacedNonJson) return 'scrubbed: non-JSON body replaced (allowFields policy)';
  return (
    `scrubbed: ${r.redactions} value(s) redacted, ${r.fieldsDropped} field(s) dropped, ` +
    `${r.fieldsHashed} field(s) hashed`
  );
}
