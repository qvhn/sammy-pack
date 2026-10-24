/**
 * Pure, browser-safe declarations + validators for the intake options:
 * trigger `scrub` / `idempotencyTtlSeconds` and the root `limits` and
 * `worktrees` blocks. The
 * runtime halves (server/payload-scrub.ts, server/admission.ts) import from
 * here; the editor's validator does too, so the two cannot disagree about
 * what a valid policy is. No Node imports.
 */

export const BUILTIN_DETECTORS = ['email', 'phone', 'bearer', 'jwt', 'secrets'] as const;
export type BuiltinDetector = (typeof BUILTIN_DETECTORS)[number];

export type ScrubPattern = {
  /** A JavaScript regular expression source. */
  pattern: string;
  /** Extra flags; `g` is always added. */
  flags?: string;
  /** Replacement text. Default `[redacted]`. */
  replacement?: string;
};

export type ScrubPolicy = {
  /** Built-in detectors to run. `true` / omitted = all; `false` = none; or a
   *  list of names. */
  builtins?: boolean | BuiltinDetector[];
  patterns?: ScrubPattern[];
  allowFields?: string[];
  dropFields?: string[];
  hashFields?: string[];
};

/** Validate a `scrub` policy; returns problems (empty = valid). */
export function validateScrubPolicy(policy: unknown): string[] {
  if (policy === undefined) return [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['`scrub` must be an object'];
  }
  const out: string[] = [];
  const p = policy as Record<string, unknown>;
  const known = ['builtins', 'patterns', 'allowFields', 'dropFields', 'hashFields'];
  for (const k of Object.keys(p)) {
    if (!known.includes(k)) out.push(`scrub.${k} is not a known option`);
  }
  if (p.builtins !== undefined && typeof p.builtins !== 'boolean') {
    if (!Array.isArray(p.builtins)) {
      out.push('scrub.builtins must be true, false, or a list of detector names');
    } else {
      for (const b of p.builtins) {
        if (!(BUILTIN_DETECTORS as readonly unknown[]).includes(b)) {
          out.push(
            `scrub.builtins: unknown detector ${JSON.stringify(b)} (known: ${BUILTIN_DETECTORS.join(', ')})`,
          );
        }
      }
    }
  }
  if (p.patterns !== undefined) {
    if (!Array.isArray(p.patterns)) {
      out.push('scrub.patterns must be a list');
    } else {
      p.patterns.forEach((pat, i) => {
        const q = pat as ScrubPattern;
        if (!q || typeof q.pattern !== 'string' || q.pattern === '') {
          out.push(`scrub.patterns[${i}].pattern must be a non-empty string`);
          return;
        }
        try {
          compilePattern(q);
        } catch (err) {
          out.push(`scrub.patterns[${i}] does not compile: ${(err as Error).message}`);
        }
      });
    }
  }
  for (const k of ['allowFields', 'dropFields', 'hashFields'] as const) {
    const v = p[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some(f => typeof f !== 'string' || f.trim() === '')) {
      out.push(`scrub.${k} must be a list of non-empty dot paths`);
    }
  }
  return out;
}

export function compilePattern(p: ScrubPattern): RegExp {
  const flags = new Set((p.flags ?? '').split(''));
  flags.add('g');
  return new RegExp(p.pattern, [...flags].join(''));
}

/** Validate a `limits` block. Returns problems as strings (empty = valid). */
export function validateLimits(limits: unknown): string[] {
  if (limits === undefined) return [];
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return ['`limits` must be an object'];
  }
  const out: string[] = [];
  const l = limits as Record<string, unknown>;
  for (const k of Object.keys(l)) {
    if (!['maxRunsPerDay', 'maxCostUsdPerDay', 'maxCostUsdPerMonth'].includes(k)) {
      out.push(`limits.${k} is not a known limit`);
    }
  }
  if (l.maxRunsPerDay !== undefined) {
    const n = l.maxRunsPerDay;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      out.push('limits.maxRunsPerDay must be a non-negative integer');
    }
  }
  for (const k of ['maxCostUsdPerDay', 'maxCostUsdPerMonth'] as const) {
    const n = l[k];
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      out.push(`limits.${k} must be a non-negative number`);
    }
  }
  return out;
}

/** Validate a trigger's `idempotencyTtlSeconds`. */
export function validateIdempotencyTtl(ttl: unknown): string[] {
  if (ttl === undefined) return [];
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    return ['idempotencyTtlSeconds must be a positive number of seconds'];
  }
  return [];
}

const WORKTREE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Validate a `worktrees` block; returns problems (empty = valid). */
export function validateWorktrees(decls: unknown): string[] {
  if (decls === undefined) return [];
  if (!Array.isArray(decls)) return ['worktrees must be a list'];
  const out: string[] = [];
  const seen = new Set<string>();
  decls.forEach((d, i) => {
    const w = d as Partial<import('./types').WorktreeDecl> & Record<string, unknown>;
    if (!w || typeof w !== 'object') {
      out.push(`worktrees[${i}] must be an object`);
      return;
    }
    for (const k of Object.keys(w)) {
      if (!['name', 'repo', 'base', 'branch', 'cleanup'].includes(k)) {
        out.push(`worktrees[${i}].${k} is not a known option`);
      }
    }
    if (typeof w.name !== 'string' || !WORKTREE_NAME_RE.test(w.name)) {
      out.push(`worktrees[${i}].name must start with a letter and use letters, digits, _ or -`);
    } else if (seen.has(w.name.toLowerCase())) {
      out.push(`worktrees[${i}].name "${w.name}" is declared twice`);
    } else {
      seen.add(w.name.toLowerCase());
    }
    if (typeof w.repo !== 'string' || w.repo.trim() === '') {
      out.push(`worktrees[${i}].repo is required (a path to a local git repository)`);
    }
    for (const k of ['base', 'branch'] as const) {
      if (w[k] !== undefined && (typeof w[k] !== 'string' || w[k] === '')) {
        out.push(`worktrees[${i}].${k} must be a non-empty string`);
      }
    }
    if (w.cleanup !== undefined && !['remove', 'keep', 'always-remove'].includes(w.cleanup)) {
      out.push(`worktrees[${i}].cleanup must be remove, keep or always-remove`);
    }
  });
  return out;
}

