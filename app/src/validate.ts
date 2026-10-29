/**
 * Lightweight runtime validator for the orchestration schema.
 *
 * Mirrors schema/orchestration.schema.json closely enough that the canonical
 * JSON Schema (consumed by external tools / IDEs) and this in-browser
 * validator agree on what's valid. Kept hand-rolled (no Ajv dep) because the
 * ruleset is small, focused, and rare to evolve — the bundle saving is worth
 * the duplication.
 *
 * If you change the JSON Schema, also update this module.
 */

import { validateHttpBody } from './llm/http-node';
import { validateLimits, validateWorktrees } from './intake-options';
import { ALL_PROVIDERS, type Node } from './types';
import { childNodesOf } from './lib/node-walk';
import { validateTrigger } from './trigger-kinds';

export type ValidationError = {
  /** Dotted path to the offending field, e.g. "phases[0].loop.maxIterations". */
  path: string;
  /** Human-readable message. */
  message: string;
  /** Nearest enclosing node name (for UI decoration). */
  nodeName?: string;
  /** Severity. `warning` is a soft signal (e.g. unused decorator); `error`
   *  means the orchestration won't validate. */
  severity: 'error' | 'warning';
};

/**
 * Numeric bounds enforced by the runtime validator. These mirror the schema's
 * `minimum` / `maximum` for the same fields — kept in lockstep by
 * `__tests__/schema-parity.test.ts`, which fails if either side drifts. Both
 * ends matter: checking only the lower bound lets `maxIterations: 10000` run
 * effectively unbounded despite the schema's `≤ 100`.
 */
export const NODE_BOUNDS = {
  loopMaxIterations: { min: 1, max: 100 },
  conversationRounds: { min: 1, max: 50 },
  retryTimes: { min: 1, max: 20 },
  retryInitialMs: { min: 0, max: 60_000 },
} as const;

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const COMPOSITE_KEYS = [
  'agent', 'agents', 'phases', 'parallel', 'converge', 'subflow',
  'loop', 'conversation', 'route', 'switch', 'map', 'a2a', 'code', 'wait',
  'http',
] as const;

export function validateOrchestration(root: Node): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(root, [], root.name, errors);
  return errors;
}

/**
 * A single register-time lint finding. ALWAYS advisory (`level: 'warning'`) —
 * lint NEVER blocks a save. The point is to surface the class of silent
 * authoring mistakes that "work" only because an agent improvises around them:
 * an unwired `${ref}`, a placeholder marker left in a value, etc. These would
 * pass `validateOrchestration` (schema-valid) yet waste a live run.
 */
export type LintFinding = {
  /** Severity. Load-time lint is warning-only (advisory, never blocking).
   *  The structural checks reused by `preview` add `info` (runtime-dependent
   *  notes); a genuine error finding is reserved for the preview-context checks
   *  in preview.ts (load-time lint here never emits one, so a save is never
   *  blocked). */
  level: 'error' | 'warning' | 'info';
  /** Stable machine code: 'unwired-ref' | 'placeholder-marker' | 'code-run' |
   *  'decorative-var' | 'unconsumed-as' | 'composite-contract'. */
  code: string;
  message: string;
  /** Nearest enclosing node name (for UI decoration). */
  node?: string;
};

/** Placeholder marker tokens (the unfinished-value sentinels an author leaves
 *  behind). Matched as a standalone token with a prose guard (see
 *  PLACEHOLDER_RE) so a value like `TODO(live-wiring)` / `<TODO>` / a bare
 *  `TODO` flags, but ordinary prose using the word as a common noun ("the
 *  planned TODO tickets") does not. */
const PLACEHOLDER_MARKERS = ['TODO', 'FIXME', 'XXX', 'PLACEHOLDER'] as const;
// A standalone marker token (word boundary both sides) that is NOT immediately
// followed by a space + another word — i.e. NOT the "MARKER nounphrase" prose
// shape (a sentence noun "planned TODO tickets" OR an all-caps section label
// "TODO TICKETS:"). So a SIGIL-attached or terminal sentinel flags
// — `TODO(...)`, `TODO:`, `<TODO>`, `TODO_KEY`, `XXX`, a bare trailing `TODO`,
// or `TODO\n${x}` — while `TODO tickets` / `TODO TICKETS` / `FIXME later` do not.
const PLACEHOLDER_RE = new RegExp(
  `\\b(${PLACEHOLDER_MARKERS.join('|')})\\b(?![ \\t]+[A-Za-z])`,
);

/**
 * Reference bases that are ALWAYS in scope at interpolation time and must
 * never be flagged as unwired. Mirrors the reserved keys documented in
 * llm/interpolate.ts + types.ts (the `vars`/`state`/`secrets`/`env`
 * namespaces and the per-scope `input`/`item`/`index`/`error` vars):
 *  - `input`         — the current input string (predecessor's output)
 *  - `item` / `index`— the per-element scope inside a `map` body
 *  - `error`(+`.*`)  — the failure scope inside an `onError` branch
 *  - `vars`/`secrets`/`env`/`state` — reserved interpolation namespaces
 */
const RESERVED_REF_BASES = new Set([
  'input', 'item', 'index', 'error', 'vars', 'secrets', 'env', 'state',
]);

/** Same `${...}` matcher the interpolator uses (llm/interpolate.ts). */
const INTERP_REF_RE = /\$\{([^}]+)\}/g;

/**
 * Register-time LINT pass — advisory warnings only, NEVER blocking. Separate
 * from `validateOrchestration` (hard schema errors) by design: these checks
 * are heuristic and tuned to minimize false positives, so they must not be
 * able to reject an existing-valid orchestration.
 *
 * Checks:
 *  1. unwired-ref — a `${ref}` whose BASE name (before the first `.`) is
 *     neither reserved nor produced anywhere by an `as:` write / a top-level
 *     `state:` slot, AND is a near-spelling of a name the orchestration DOES
 *     produce (edit distance ≤ 2). The near-bound guard is deliberate: a bare
 *     unbound base is ALSO the normal "run-input var" pattern — a value passed
 *     as `initialInput` at run start, never produced by an `as:` write (most
 *     shipped examples reference one, e.g. `${ticket}`, `${invoice}`). Those
 *     are valid, so flagging every unbound ref is ~28 false positives on the
 *     real corpus. Restricting to near-a-bound-name catches the catchable
 *     mistake (a typo of a var the orchestration produces, e.g. `${paln}` for
 *     `as: "plan"`) with zero corpus false positives. `${connections:...}` is
 *     a different mechanism and is skipped entirely.
 *  2. placeholder-marker — a value containing a TODO / FIXME / XXX /
 *     PLACEHOLDER token in placeholder SHAPE (the literal `TODO(live-wiring)…`
 *     that shipped as a JQL once and only "worked" because an agent improvised
 *     from the comment — the days-wasting failure this linter exists for).
 *  3. code-run — a node uses `code.run` (external shell). Register-time
 *     heads-up; the executor still runs it.
 *  6. composite-contract — an `input` / `output` contract on a node whose
 *     kind never evaluates one (see CONTRACT_ENFORCED_KINDS).
 */
export function lintOrchestration(root: Node): LintFinding[] {
  const findings: LintFinding[] = [];

  // ── Collect the set of bound names visible to interpolation ──────────────
  // BOUND = every `as:` write anywhere in the tree (state is a flat run-wide
  // namespace, so a var produced in any branch can be referenced elsewhere —
  // collecting tree-wide rather than only-upstream avoids false "unwired"
  // positives on legitimate cross-branch reads) ∪ every top-level `state:`
  // reducer-slot key (declared structured-state slots; see StateDecl).
  const bound = new Set<string>();
  collectBoundNames(root, bound);
  if (root.state && typeof root.state === 'object') {
    for (const key of Object.keys(root.state)) bound.add(key);
  }

  lintNode(root, root.name, bound, findings);

  // ── Tree-wide reference census, for the decorative-var / unconsumed-as
  //    structural checks (these also strengthen load-time validation). ────────
  // `usedInExec` = every name a value actually flows into at EXECUTION time:
  //   - a `${ref}` base in an INTERPOLATED field (prompt / when / code.run /
  //     code.source / switch.on / map.over / loop.* / a2a), AND
  //   - a `state.<name>` / `state["<name>"]` access inside a `code` body — the
  //     JS way a snippet reads an upstream `as` output or a top-level var (both
  //     live on `state`). Without this, every orchestration that chains code
  //     phases via `state.X` false-flags its `as` outputs as unconsumed.
  // `usedInDesc` = bases referenced in `description` text. A name in `usedInExec`
  // is load-bearing; a declared var in NEITHER is dead.
  const usedInExec = new Set<string>();
  const usedInDesc = new Set<string>();
  collectRefBases(root, usedInExec, usedInDesc);
  collectStateAccessInCode(root, usedInExec);

  // (4) decorative-var / unused-var — a declared `vars` key (or `state` slot)
  //     with ZERO executable-field references. Two shapes, one root cause (it
  //     threads into no run behavior — the exact appEnv bug):
  //       - referenced only in descriptions → "decorative" (reads like it
  //         matters but never takes effect),
  //       - referenced NOWHERE at all       → "unused".
  //     Both are flagged; the message names which. (`state.X` access in a code
  //     body counts as a real use via `usedInExec`, so a var a snippet reads is
  //     never flagged.)
  const declaredVars = new Set<string>([
    ...Object.keys(root.vars ?? {}),
    ...(root.state && typeof root.state === 'object'
      ? Object.keys(root.state)
      : []),
  ]);
  for (const v of declaredVars) {
    if (usedInExec.has(v)) continue;
    if (usedInDesc.has(v)) {
      const count = countRefOccurrences(root, v);
      findings.push({
        level: 'warning',
        code: 'decorative-var',
        message:
          `var "${v}" appears only in descriptions (${count}×), never in an ` +
          `executable field (prompt / code / when / …) — likely decorative. ` +
          `Reference it where it should take effect, or drop it.`,
        node: root.name,
      });
    } else {
      findings.push({
        level: 'warning',
        code: 'decorative-var',
        message:
          `var "${v}" is declared but referenced nowhere — not in any executable ` +
          `field (prompt / code / when / …) nor description. It threads into no ` +
          `run behavior; wire it where it should take effect, or drop it.`,
        node: root.name,
      });
    }
  }

  // (5) unconsumed-as — an `as: "name"` output nothing downstream reads, by
  //     EITHER `${name}` interpolation OR `state.name` JS access in a code body
  //     (both fold into `usedInExec` above). The phase produces a value nothing
  //     consumes — dead wiring or a typo at the read site.
  const asOwners = new Map<string, string | undefined>();
  collectAsOwners(root, asOwners);
  for (const [name, owner] of asOwners) {
    if (!usedInExec.has(name)) {
      findings.push({
        level: 'warning',
        code: 'unconsumed-as',
        message:
          `\`as: "${name}"\` is never consumed — no downstream \${${name}} or ` +
          `\`state.${name}\` reads it. Remove the binding, or wire a reader ` +
          `(check for a typo at the read site).`,
        node: owner,
      });
    }
  }

  return findings;
}

/** Add every `state.<name>` / `state["<name>"]` / `state['<name>']` access
 *  found in a `code` body (`source` or `run`) to `into`. This is how a JS
 *  snippet reads an upstream `as` output or a top-level var — both live on the
 *  run `state` object — so a name accessed this way is genuinely consumed even
 *  though it never appears as a `${...}` interpolation. Tree-wide, mirroring the
 *  flat run-wide state namespace. */
function collectStateAccessInCode(node: Node, into: Set<string>): void {
  if (node.code && typeof node.code === 'object') {
    for (const body of [node.code.source, node.code.run]) {
      if (typeof body === 'string' && body.length > 0) {
        addStateAccessNames(body, into);
      }
    }
  }
  for (const child of childNodes(node)) collectStateAccessInCode(child, into);
}

/** `state.foo`, `state.foo.bar`, `state["foo"]`, `state['foo']` → add `foo`. */
const STATE_ACCESS_RE =
  /\bstate\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
function addStateAccessNames(code: string, into: Set<string>): void {
  STATE_ACCESS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATE_ACCESS_RE.exec(code)) !== null) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name) into.add(name);
  }
}

/** Collect every `${ref}` base used in an INTERPOLATED field into `exec`, and
 *  every base used in a `description` into `desc`. A base that appears in both
 *  lands in both sets; the caller computes "desc-only" as `desc \ exec`. */
function collectRefBases(
  node: Node,
  exec: Set<string>,
  desc: Set<string>,
): void {
  for (const field of interpolatedFields(node)) addRefBases(field, exec);
  if (typeof node.description === 'string') addRefBases(node.description, desc);
  for (const child of childNodes(node)) collectRefBases(child, exec, desc);
}

/** Add the base names of every `${ref}` in `text` to `into` (skips
 *  `${connections:…}`, a different mechanism). */
function addRefBases(text: string, into: Set<string>): void {
  INTERP_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERP_REF_RE.exec(text)) !== null) {
    const ref = m[1].trim();
    if (ref.startsWith('connections:')) continue;
    const base = ref.split('.')[0].trim();
    if (base) into.add(base);
  }
}

/** Count how many `${name}` references to a base appear in description fields
 *  tree-wide (for the decorative-var message's `(N×)`). */
function countRefOccurrences(node: Node, base: string): number {
  let n = 0;
  const scan = (text: string | undefined): void => {
    if (typeof text !== 'string') return;
    INTERP_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INTERP_REF_RE.exec(text)) !== null) {
      if (m[1].trim().split('.')[0].trim() === base) n++;
    }
  };
  const visit = (nd: Node): void => {
    scan(nd.description);
    for (const c of childNodes(nd)) visit(c);
  };
  visit(node);
  return n;
}

/** Map every `as:` name to the node that produces it (first writer wins). */
function collectAsOwners(node: Node, into: Map<string, string | undefined>): void {
  if (node.as && !into.has(node.as)) into.set(node.as, node.name);
  for (const child of childNodes(node)) collectAsOwners(child, into);
}

/** Gather every `as:` decorator value across the whole tree. */
function collectBoundNames(node: Node, into: Set<string>): void {
  if (node.as) into.add(node.as);
  for (const child of childNodes(node)) collectBoundNames(child, into);
}

/**
 * Every child Node reachable from `node` through any composite kind — the
 * shared `childNodesOf` walker (lib/node-walk.ts), re-exposed under the local
 * name the collectors and the lint walk already use. This file's hand-rolled
 * copy was the ONLY complete one (switch + onStall.recover); it moved to
 * node-walk.ts as the single source of truth so the executor's walkers (which
 * HAD drifted — switch/onStall holes) recurse identically to validation.
 * Intentionally EXCLUDES string-ref bodies (`subflow`) and string[] bodies
 * (`conversation.participants`, `agents`) — those are references, not nodes.
 */
const childNodes = childNodesOf;

/** The interpolated string fields on a single node (NOT its children). Each is
 *  a value the executor runs `interpolate()` over, so a `${ref}` here is a
 *  real reference. route/switch case KEYS are NOT interpolated — excluded. */
function interpolatedFields(node: Node): string[] {
  const fields: (string | undefined)[] = [
    node.prompt,
    node.when,
    node.idempotencyKey,
    node.code?.source,
    node.code?.run,
    node.switch?.on,
    node.map?.over,
    node.loop?.until,
    node.loop?.whileOutput,
    node.loop?.judge,
    node.a2a?.agentCard,
    node.http?.url,
    ...Object.values(node.http?.headers ?? {}),
    ...(typeof node.http?.body === 'string' ? [node.http.body] : []),
  ];
  return fields.filter((f): f is string => typeof f === 'string' && f.length > 0);
}

/** Nondeterministic calls inside a `code` body. A code leaf's output is
 *  CHECKPOINTED and replayed verbatim on resume / fork / composite re-run,
 *  so a snippet that reads the clock or the RNG produces one value on the
 *  first pass and a different one whenever it genuinely re-executes — the
 *  two legs of the same run disagree, silently. (Claude's own Dynamic
 *  Workflows makes these THROW inside an orchestration script for exactly
 *  this reason; sammy-pack warns instead of breaking existing flows, and
 *  the fix is the same: pass the value in as a var / upstream output.) */
const NONDETERMINISTIC_CODE_RE =
  /\b(?:Math\s*\.\s*random|Date\s*\.\s*now|performance\s*\.\s*now)\s*\(|\bnew\s+Date\s*\(\s*\)/g;

function lintCodeDeterminism(
  node: Node,
  ctxName: string | undefined,
  findings: LintFinding[],
): void {
  const source = node.code?.source;
  if (typeof source !== 'string' || source.length === 0) return;
  NONDETERMINISTIC_CODE_RE.lastIndex = 0;
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = NONDETERMINISTIC_CODE_RE.exec(source)) !== null) {
    hits.add(m[0].replace(/\s+/g, '').replace(/\($/, '()'));
  }
  if (hits.size === 0) return;
  findings.push({
    level: 'warning',
    code: 'nondeterministic-code',
    node: ctxName,
    message:
      `code phase uses ${[...hits].join(', ')} — its output is checkpointed ` +
      `and REPLAYED verbatim on resume / fork / composite re-run, so a real ` +
      `re-execution produces a different value than the replay and the two ` +
      `legs of the run disagree. Pass the timestamp / random value in as a ` +
      `var or an upstream phase output instead.`,
  });
}

/** The body kinds whose runner evaluates an `input` / `output` contract. The
 *  executor checks contracts in exactly these four leaf runners; `input` and
 *  `output` are declared on the flat Node type for EVERY kind, so a contract
 *  on a composite (phases / parallel / map / loop / route / switch / …) is
 *  accepted by the schema, the validator and `preview`, and then never
 *  evaluated — the silent "looks enforced, isn't" gap this linter exists
 *  for. Keep in step with the executor's checkContract call sites. */
const CONTRACT_ENFORCED_KINDS = ['agent', 'code', 'wait', 'a2a', 'http'] as const;

function lintNode(
  node: Node,
  enclosingName: string | undefined,
  bound: Set<string>,
  findings: LintFinding[],
): void {
  const ctxName = node.name ?? enclosingName;
  const fields = interpolatedFields(node);
  lintCodeDeterminism(node, ctxName, findings);

  // (6) composite-contract: a contract the executor will never consult.
  if (
    (node.input !== undefined || node.output !== undefined) &&
    !CONTRACT_ENFORCED_KINDS.some(k => node[k] !== undefined)
  ) {
    const declared = [
      node.input !== undefined ? 'input' : null,
      node.output !== undefined ? 'output' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    findings.push({
      level: 'warning',
      code: 'composite-contract',
      message:
        `node "${ctxName}" declares an ${declared} contract, but contracts are ` +
        `enforced on leaves (${CONTRACT_ENFORCED_KINDS.join('/')}) only; this one ` +
        `is ignored. Move it onto the leaf whose value it describes.`,
      node: ctxName,
    });
  }

  for (const field of fields) {
    // (1) unwired-ref: a `${ref}` whose base is neither reserved nor bound AND
    //     is a near-spelling of a produced name (a likely typo). A bare unbound
    //     base is NOT flagged — that's the valid run-input pattern (see the
    //     `lintOrchestration` docstring for why this guard exists).
    INTERP_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const reportedRefs = new Set<string>();
    while ((m = INTERP_REF_RE.exec(field)) !== null) {
      const ref = m[1].trim();
      // `${connections:...}` is a different substitution mechanism — skip.
      if (ref.startsWith('connections:')) continue;
      // Base name = before the first `.` (a dotted `${a.b}` is checked on `a`).
      const base = ref.split('.')[0].trim();
      if (!base) continue;
      if (RESERVED_REF_BASES.has(base) || bound.has(base)) continue;
      if (reportedRefs.has(base)) continue;
      const near = nearestBoundName(base, bound);
      if (!near) continue; // unbound but not a typo of a produced name → run-input; don't flag.
      reportedRefs.add(base);
      findings.push({
        level: 'warning',
        code: 'unwired-ref',
        message:
          `\${${ref}} references "${base}", which no node produces — but an ` +
          `\`as: "${near}"\` write exists. Likely a typo of "${near}" (the run ` +
          `would render the literal \`\${${ref}}\`). Fix the ref, or ignore if ` +
          `"${base}" is intentionally a run-input.`,
        node: ctxName,
      });
    }

    // (2) placeholder-marker: an unfinished value left in the orchestration.
    //     Matched only in a placeholder SHAPE so prose ("planned TODO tickets")
    //     doesn't trip it — see PLACEHOLDER_RE.
    const pm = PLACEHOLDER_RE.exec(field);
    if (pm) {
      findings.push({
        level: 'warning',
        code: 'placeholder-marker',
        message:
          `value contains a placeholder marker "${pm[1]}": ${truncate(field)}. ` +
          `A live run may "work" only because an agent improvises around it — ` +
          `wire the real value before shipping.`,
        node: ctxName,
      });
    }
  }

  // (3) code-run heads-up.
  if (node.code && typeof node.code === 'object' && typeof node.code.run === 'string' && node.code.run.length > 0) {
    findings.push({
      level: 'warning',
      code: 'code-run',
      message:
        `node uses \`code.run\` (external shell command) — runs outside the ` +
        `vm sandbox. Confirm the command + its env are intended.`,
      node: ctxName,
    });
  }

  for (const child of childNodes(node)) lintNode(child, ctxName, bound, findings);
}

/** Clip a long field value for a lint message. */
function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * The bound name `ref` is most likely a typo OF — within edit distance ≤ 2 and
 * similar length — or '' if none qualifies. Powers the unwired-ref guard:
 * only flag an unbound ref when it closely resembles a name the orchestration
 * actually produces (a real typo), never a plain run-input. Skips trivially
 * short names (≤ 2 chars) where a 2-edit window matches almost anything.
 */
function nearestBoundName(ref: string, bound: Set<string>): string {
  if (ref.length <= 2) return '';
  for (const name of bound) {
    if (name === ref || name.length <= 2) continue;
    if (Math.abs(name.length - ref.length) > 2) continue;
    if (levenshtein(ref, name) <= 2) return name;
  }
  return '';
}

/** Classic edit distance (insert/delete/substitute). Small inputs (var names)
 *  so the O(n·m) DP is fine. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function validateNode(
  node: Node,
  pathParts: (string | number)[],
  enclosingName: string | undefined,
  errors: ValidationError[],
): void {
  const ctxName = node.name ?? enclosingName;
  const here = (suffix?: string | number) =>
    [...pathParts, ...(suffix == null ? [] : [suffix])];

  if (!node.name || typeof node.name !== 'string' || node.name.length === 0) {
    errors.push({
      path: render(here('name')),
      message: 'name is required and must be a non-empty string',
      nodeName: ctxName,
      severity: 'error',
    });
  }

  const presentKinds = COMPOSITE_KEYS.filter(k => node[k] !== undefined);
  if (presentKinds.length === 0 && typeof node.skill === 'string' && node.skill.trim() !== '') {
    // A step done by a skill is a body only to a harness; a pipeline run of
    // this tree refuses at start (orchestrationUsesSkillOnlySteps).
    errors.push({
      path: render(pathParts),
      message: `node has only a skill ("${node.skill}") — it runs in harness mode only; add an agent to also run it as a pipeline`,
      nodeName: ctxName,
      severity: 'warning',
    });
  } else if (presentKinds.length === 0) {
    errors.push({
      path: render(pathParts),
      message:
        `node has no body — pick exactly one of: ${COMPOSITE_KEYS.join(', ')}`,
      nodeName: ctxName,
      severity: 'error',
    });
  } else if (presentKinds.length > 1) {
    errors.push({
      path: render(pathParts),
      message:
        `node has multiple bodies (${presentKinds.join(', ')}) — exactly one allowed`,
      nodeName: ctxName,
      severity: 'error',
    });
  }

  if (node.agents) {
    if (!Array.isArray(node.agents) || node.agents.length === 0) {
      errors.push({
        path: render(here('agents')),
        message: 'agents must be a non-empty array of agent paths',
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }

  if (node.parallel) {
    if (!Array.isArray(node.parallel) || node.parallel.length < 2) {
      errors.push({
        path: render(here('parallel')),
        message: 'parallel needs at least 2 branches',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      node.parallel.forEach(child =>
        validateNode(child, here('parallel'), ctxName, errors));
    }
  }

  if (node.converge) {
    if (!Array.isArray(node.converge) || node.converge.length < 2) {
      errors.push({
        path: render(here('converge')),
        message: 'converge needs at least 2 branches',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      node.converge.forEach(child =>
        validateNode(child, here('converge'), ctxName, errors));
    }
  }

  if (node.phases) {
    if (!Array.isArray(node.phases) || node.phases.length === 0) {
      errors.push({
        path: render(here('phases')),
        message: 'phases must be a non-empty array',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      node.phases.forEach(child =>
        validateNode(child, here('phases'), ctxName, errors));
    }
  }

  if (node.loop) {
    if (!node.loop.body) {
      errors.push({
        path: render(here('loop.body')),
        message: 'loop must define a body node',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      validateNode(node.loop.body, here('loop.body'), ctxName, errors);
    }
    if (
      typeof node.loop.maxIterations !== 'number' ||
      node.loop.maxIterations < NODE_BOUNDS.loopMaxIterations.min ||
      node.loop.maxIterations > NODE_BOUNDS.loopMaxIterations.max
    ) {
      errors.push({
        path: render(here('loop.maxIterations')),
        message: `loop.maxIterations must be an integer in ${NODE_BOUNDS.loopMaxIterations.min}–${NODE_BOUNDS.loopMaxIterations.max}`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
    if (node.loop.stopAtScore !== undefined) {
      if (
        typeof node.loop.stopAtScore !== 'number' ||
        !Number.isFinite(node.loop.stopAtScore)
      ) {
        errors.push({
          path: render(here('loop.stopAtScore')),
          message: 'loop.stopAtScore must be a finite number',
          nodeName: ctxName,
          severity: 'error',
        });
      }
      if (!node.loop.judge) {
        errors.push({
          path: render(here('loop.stopAtScore')),
          message: 'loop.stopAtScore needs a `judge` agent to emit the score',
          nodeName: ctxName,
          severity: 'error',
        });
      }
    }
    // maxFailures (optional): the consecutive-failure cap under retryOnFailure.
    if (node.loop.maxFailures !== undefined) {
      if (
        typeof node.loop.maxFailures !== 'number' ||
        !Number.isInteger(node.loop.maxFailures) ||
        node.loop.maxFailures < 1
      ) {
        errors.push({
          path: render(here('loop.maxFailures')),
          message: 'loop.maxFailures must be a positive integer (the consecutive-failure cap)',
          nodeName: ctxName,
          severity: 'error',
        });
      }
      // It only bites under retryOnFailure (a non-retrying loop has no failure
      // streak to cap) — surface a warning so a no-op config is caught.
      if (!node.loop.retryOnFailure) {
        errors.push({
          path: render(here('loop.maxFailures')),
          message: 'loop.maxFailures has no effect without retryOnFailure (the failure cap only bounds retry-on-failure re-iterations)',
          nodeName: ctxName,
          severity: 'warning',
        });
      }
    }
  }

  if (node.conversation) {
    const p = node.conversation.participants;
    if (!Array.isArray(p) || p.length < 2) {
      errors.push({
        path: render(here('conversation.participants')),
        message: 'conversation requires at least 2 participants',
        nodeName: ctxName,
        severity: 'error',
      });
    }
    if (
      typeof node.conversation.rounds !== 'number' ||
      node.conversation.rounds < NODE_BOUNDS.conversationRounds.min ||
      node.conversation.rounds > NODE_BOUNDS.conversationRounds.max
    ) {
      errors.push({
        path: render(here('conversation.rounds')),
        message: `conversation.rounds must be an integer in ${NODE_BOUNDS.conversationRounds.min}–${NODE_BOUNDS.conversationRounds.max}`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }

  if (node.route) {
    if (!node.route.branches || Object.keys(node.route.branches).length === 0) {
      errors.push({
        path: render(here('route.branches')),
        message: 'route needs at least one named branch',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      for (const [key, branch] of Object.entries(node.route.branches)) {
        validateNode(branch, here(`route.branches.${key}`), ctxName, errors);
      }
    }
    if (node.route.default) {
      validateNode(node.route.default, here('route.default'), ctxName, errors);
    } else if (
      node.route.branches &&
      Object.keys(node.route.branches).length > 0
    ) {
      // No default → input that matches no branch (e.g. a router agent that
      // emits an unexpected label) dead-ends as a phase error. Advisory:
      // a default makes the route total, so routing is always bounded.
      errors.push({
        path: render(here('route.default')),
        message:
          'route has no `default` branch — input matching no branch will fail the run. Add a `default` to make routing total.',
        nodeName: ctxName,
        severity: 'warning',
      });
    }
  }

  if (node.switch) {
    if (!node.switch.cases || Object.keys(node.switch.cases).length === 0) {
      errors.push({
        path: render(here('switch.cases')),
        message: 'switch needs at least one named case',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      for (const [key, branch] of Object.entries(node.switch.cases)) {
        validateNode(branch, here(`switch.cases.${key}`), ctxName, errors);
      }
    }
    if (node.switch.default) {
      validateNode(node.switch.default, here('switch.default'), ctxName, errors);
    } else if (
      node.switch.cases &&
      Object.keys(node.switch.cases).length > 0
    ) {
      // No default → a value matching no case fails the phase. Advisory:
      // a default makes the switch total.
      errors.push({
        path: render(here('switch.default')),
        message:
          'switch has no `default` case — a value matching no case will fail the run. Add a `default` to make the switch total.',
        nodeName: ctxName,
        severity: 'warning',
      });
    }
  }

  if (node.map) {
    if (!node.map.over || typeof node.map.over !== 'string') {
      errors.push({
        path: render(here('map.over')),
        message: 'map.over is required (${state_var} or inline JSON array literal)',
        nodeName: ctxName,
        severity: 'error',
      });
    }
    if (!node.map.body) {
      errors.push({
        path: render(here('map.body')),
        message: 'map must define a body node',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      validateNode(node.map.body, here('map.body'), ctxName, errors);
    }
    if (node.map.concurrency !== undefined) {
      if (
        typeof node.map.concurrency !== 'number' ||
        !Number.isInteger(node.map.concurrency) ||
        node.map.concurrency < 1
      ) {
        errors.push({
          path: render(here('map.concurrency')),
          message:
            'map.concurrency must be a positive integer (items run in batches of this size; unset = all at once)',
          nodeName: ctxName,
          severity: 'error',
        });
      }
    }
  }

  if (node.code) {
    if (typeof node.code !== 'object' || Array.isArray(node.code)) {
      errors.push({
        path: render(here('code')),
        message: 'code must be an object with a `source` or `run` string',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      // Mirror the schema's `codeBody` oneOf: EITHER `source` (inline JS,
      // vm-sandboxed) OR `run` (external shell command, opt-in). The
      // executor supports both — accept the node when exactly one is a
      // non-empty string, and only error when neither (or both) is given.
      const hasSource =
        typeof node.code.source === 'string' && node.code.source.length > 0;
      const hasRun =
        typeof node.code.run === 'string' && node.code.run.length > 0;
      if (!hasSource && !hasRun) {
        errors.push({
          path: render(here('code')),
          message:
            'code requires either `source` (inline JS) or `run` (shell command) — a non-empty string',
          nodeName: ctxName,
          severity: 'error',
        });
      } else if (hasSource && hasRun) {
        errors.push({
          path: render(here('code')),
          message:
            'code.source and code.run are mutually exclusive — provide exactly one',
          nodeName: ctxName,
          severity: 'error',
        });
      }
      if (node.code.cwd !== undefined) {
        if (typeof node.code.cwd !== 'string' || node.code.cwd.trim() === '') {
          errors.push({
            path: render(here('code.cwd')),
            message: 'code.cwd must be a non-empty path',
            nodeName: ctxName,
            severity: 'error',
          });
        } else if (/\$\{\s*input\b/.test(node.code.cwd)) {
          errors.push({
            path: render(here('code.cwd')),
            message:
              'code.cwd is built from the run input — a payload could then choose which directory ' +
              'an allowlisted relative command (./scripts/x.sh, a config lookup) resolves in. ' +
              'Prefer ${worktrees.<name>.path} plus a literal sub-path.',
            nodeName: ctxName,
            severity: 'warning',
          });
        }
        if (!hasRun && typeof node.code.cwd === 'string' && node.code.cwd.trim() !== '') {
          errors.push({
            path: render(here('code.cwd')),
            message: 'code.cwd sets where a command runs, so it needs `run` — it is ignored on `source`',
            nodeName: ctxName,
            severity: 'warning',
          });
        }
      }
      if (node.code.artifact !== undefined) {
        if (typeof node.code.artifact !== 'string' || node.code.artifact.trim() === '') {
          errors.push({
            path: render(here('code.artifact')),
            message: 'code.artifact must be a non-empty name',
            nodeName: ctxName,
            severity: 'error',
          });
        } else if (!hasRun) {
          errors.push({
            path: render(here('code.artifact')),
            message: 'code.artifact captures a command log, so it needs `run` — it is ignored on `source`',
            nodeName: ctxName,
            severity: 'warning',
          });
        }
      }
    }
  }

  if (node.http !== undefined) {
    for (const m of validateHttpBody(node.http)) {
      errors.push({
        path: render(here('http')),
        message: m,
        nodeName: ctxName,
        severity: m.includes('ignored') ? 'warning' : 'error',
      });
    }
  }

  if (node.a2a) {
    if (typeof node.a2a !== 'object' || Array.isArray(node.a2a)) {
      errors.push({
        path: render(here('a2a')),
        message: 'a2a must be an object with an agentCard URL',
        nodeName: ctxName,
        severity: 'error',
      });
    } else if (
      !node.a2a.agentCard ||
      typeof node.a2a.agentCard !== 'string'
    ) {
      errors.push({
        path: render(here('a2a.agentCard')),
        message:
          'a2a.agentCard is required — the URL of the remote agent card',
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }

  if (node.provider !== undefined) {
    // Canonical list from types.ts — never hand-copy the provider set (that's
    // how `bedrock` once drifted out of the schema).
    if (!(ALL_PROVIDERS as readonly string[]).includes(node.provider as string)) {
      errors.push({
        path: render(here('provider')),
        message: `provider must be one of: ${ALL_PROVIDERS.join(' | ')}`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
    // Claude-only features (subagents / mcp / per-node tools) silently no-op on
    // non-Anthropic providers. Warn so the author isn't surprised at runtime.
    const claudeProviders = ['anthropic', 'claude-code'];
    if (!claudeProviders.includes(node.provider as string)) {
      const claudeOnly: string[] = [];
      if (node.subagents && node.subagents.length > 0) claudeOnly.push('subagents');
      if (node.mcp && node.mcp.length > 0) claudeOnly.push('mcp');
      if (node.tools && node.tools.length > 0) claudeOnly.push('tools');
      if (claudeOnly.length > 0) {
        errors.push({
          path: render(here('provider')),
          message: `provider "${node.provider}" is non-Anthropic — ${claudeOnly.join(
            ', ',
          )} ${claudeOnly.length === 1 ? 'is' : 'are'} Claude-only and will be ignored on this phase`,
          nodeName: ctxName,
          severity: 'warning',
        });
      }
    }
  }
  if (node.model !== undefined) {
    if (typeof node.model !== 'string' || node.model.length === 0) {
      errors.push({
        path: render(here('model')),
        message: 'model must be a non-empty string when set',
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }
  if (node.credential !== undefined) {
    if (typeof node.credential !== 'string' || node.credential.length === 0) {
      errors.push({
        path: render(here('credential')),
        message: 'credential must be a non-empty string when set',
        nodeName: ctxName,
        severity: 'error',
      });
    }
    // NOTE: `credential` no longer requires `provider`. It has two
    // independent uses — provider routing (with `provider`) AND/OR env
    // injection (projected onto subprocess env vars by kind; see
    // server/credential-env.ts). A bare `credential` is the env-injection
    // case (e.g. a phase whose Bash/curl steps authenticate from
    // JIRA_API_TOKEN) and is fully valid. The previous "needs provider"
    // error was removed when env injection landed.
  }
  if (node.credentials !== undefined) {
    if (!Array.isArray(node.credentials)) {
      errors.push({
        path: render(here('credentials')),
        message: 'credentials must be an array of registry entry names',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      node.credentials.forEach((c, i) => {
        if (typeof c !== 'string' || c.length === 0) {
          errors.push({
            path: render(here(`credentials[${i}]`)),
            message: 'each credentials[] entry must be a non-empty string',
            nodeName: ctxName,
            severity: 'error',
          });
        }
      });
    }
  }

  if (node.triggers !== undefined) {
    if (!Array.isArray(node.triggers)) {
      errors.push({
        path: render(here('triggers')),
        message: 'triggers must be an array',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      node.triggers.forEach((t, i) => {
        if (!t || typeof t !== 'object') {
          errors.push({
            path: render(here(`triggers[${i}]`)),
            message: 'trigger must be an object',
            nodeName: ctxName,
            severity: 'error',
          });
          return;
        }
        // Per-kind validation is data-driven via the trigger-kind registry
        // (src/server/trigger-kinds.ts): a new kind's required-field checks
        // + the "unknown kind" message live in ONE place there, so adding a
        // kind is additive rather than extending this chain. Each issue's
        // `field` (e.g. "path", "intervalSeconds") is appended under
        // `triggers[i]`; a field-less issue attaches to the trigger itself.
        for (const issue of validateTrigger(t)) {
          errors.push({
            path: render(here(`triggers[${i}]${issue.field ? `.${issue.field}` : ''}`)),
            message: issue.message,
            nodeName: ctxName,
            severity: 'error',
          });
        }
      });
    }
  }

  if (node.worktrees !== undefined) {
    for (const m of validateWorktrees(node.worktrees)) {
      errors.push({ path: render(here('worktrees')), message: m, nodeName: ctxName, severity: 'error' });
    }
    if (pathParts.length > 0) {
      errors.push({
        path: render(here('worktrees')),
        message: 'worktrees is read only off the orchestration root — on a child node it is ignored',
        nodeName: ctxName,
        severity: 'warning',
      });
    }
  }

  if (node.limits !== undefined) {
    for (const m of validateLimits(node.limits)) {
      errors.push({ path: render(here('limits')), message: m, nodeName: ctxName, severity: 'error' });
    }
    if (pathParts.length > 0) {
      errors.push({
        path: render(here('limits')),
        message: 'limits is read only off the orchestration root — on a child node it is ignored',
        nodeName: ctxName,
        severity: 'warning',
      });
    }
  }

  if (node.execution !== undefined) {
    if (node.execution !== 'pipeline' && node.execution !== 'harness') {
      errors.push({
        path: render(here('execution')),
        message: 'execution must be "pipeline" or "harness"',
        nodeName: ctxName,
        severity: 'error',
      });
    } else if (pathParts.length > 0) {
      errors.push({
        path: render(here('execution')),
        message: 'execution is read only off the orchestration root — on a child node it is ignored',
        nodeName: ctxName,
        severity: 'warning',
      });
    }
  }

  if (node.harness !== undefined) {
    const h = node.harness as unknown;
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      errors.push({ path: render(here('harness')), message: 'harness must be an object', nodeName: ctxName, severity: 'error' });
    } else {
      const { follow, maxTurns } = node.harness;
      if (follow !== undefined && !['strict', 'loose', 'advisory'].includes(follow)) {
        errors.push({
          path: render(here('harness.follow')),
          message: 'harness.follow must be one of strict | loose | advisory',
          nodeName: ctxName,
          severity: 'error',
        });
      }
      if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1)) {
        errors.push({
          path: render(here('harness.maxTurns')),
          message: 'harness.maxTurns must be an integer ≥ 1',
          nodeName: ctxName,
          severity: 'error',
        });
      }
      if (pathParts.length > 0) {
        errors.push({
          path: render(here('harness')),
          message: 'harness is read only off the orchestration root — on a child node it is ignored',
          nodeName: ctxName,
          severity: 'warning',
        });
      }
    }
  }

  if (node.skill !== undefined && (typeof node.skill !== 'string' || node.skill.trim() === '')) {
    errors.push({
      path: render(here('skill')),
      message: 'skill must be a non-empty skill name (or plugin:skill)',
      nodeName: ctxName,
      severity: 'error',
    });
  }

  if (node.lifecycle) {
    if (typeof node.lifecycle !== 'object' || Array.isArray(node.lifecycle)) {
      errors.push({
        path: render(here('lifecycle')),
        message: 'lifecycle must be an object',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      const stage = node.lifecycle.stage;
      if (stage !== undefined && !['dev', 'staging', 'prod'].includes(stage)) {
        errors.push({
          path: render(here('lifecycle.stage')),
          message: `lifecycle.stage must be one of dev | staging | prod`,
          nodeName: ctxName,
          severity: 'error',
        });
      }
    }
  }

  // Decorator validation.
  if (node.as) {
    if (!NAME_RE.test(node.as)) {
      errors.push({
        path: render(here('as')),
        message: `as: "${node.as}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }
  if (node.merger && !node.converge) {
    errors.push({
      path: render(here('merger')),
      message: 'merger is only valid on converge composites',
      nodeName: ctxName,
      severity: 'error',
    });
  }
  if (node.tools && !node.agent) {
    errors.push({
      path: render(here('tools')),
      message: 'tools is only valid on agent (leaf) nodes',
      nodeName: ctxName,
      severity: 'error',
    });
  }
  if (node.timeout != null && (typeof node.timeout !== 'number' || node.timeout <= 0)) {
    errors.push({
      path: render(here('timeout')),
      message: 'timeout must be a positive number (seconds)',
      nodeName: ctxName,
      severity: 'error',
    });
  }
  if (node.retry) {
    if (
      typeof node.retry.times !== 'number' ||
      node.retry.times < NODE_BOUNDS.retryTimes.min ||
      node.retry.times > NODE_BOUNDS.retryTimes.max
    ) {
      errors.push({
        path: render(here('retry.times')),
        message: `retry.times must be an integer in ${NODE_BOUNDS.retryTimes.min}–${NODE_BOUNDS.retryTimes.max}`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
    if (
      node.retry.initialMs != null &&
      (typeof node.retry.initialMs !== 'number' ||
        node.retry.initialMs < NODE_BOUNDS.retryInitialMs.min ||
        node.retry.initialMs > NODE_BOUNDS.retryInitialMs.max)
    ) {
      errors.push({
        path: render(here('retry.initialMs')),
        message: `retry.initialMs must be a number in ${NODE_BOUNDS.retryInitialMs.min}–${NODE_BOUNDS.retryInitialMs.max} (ms)`,
        nodeName: ctxName,
        severity: 'error',
      });
    }
    if (
      node.retry.backoff != null &&
      node.retry.backoff !== 'fixed' &&
      node.retry.backoff !== 'exponential'
    ) {
      errors.push({
        path: render(here('retry.backoff')),
        message: 'retry.backoff must be "fixed" or "exponential"',
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }
  if (node.budget) {
    if (node.budget.maxTokens == null && node.budget.maxCostUsd == null) {
      errors.push({
        path: render(here('budget')),
        message: 'budget needs at least one of maxTokens or maxCostUsd',
        nodeName: ctxName,
        severity: 'error',
      });
    }
  }
  if (node.onError) {
    validateNode(node.onError, here('onError'), ctxName, errors);
  }
  if (node.onStall !== undefined) {
    if (
      typeof node.onStall !== 'object' ||
      node.onStall === null ||
      Array.isArray(node.onStall)
    ) {
      errors.push({
        path: render(here('onStall')),
        message:
          'onStall must be an object with a `recover` phase (and optional `maxRetries`)',
        nodeName: ctxName,
        severity: 'error',
      });
    } else {
      // `recover` is REQUIRED and must itself be a valid phase — recurse so a
      // malformed recovery body (no name, no body, etc.) is caught at register
      // time, exactly like an `onError` branch.
      if (
        node.onStall.recover == null ||
        typeof node.onStall.recover !== 'object' ||
        Array.isArray(node.onStall.recover)
      ) {
        errors.push({
          path: render(here('onStall.recover')),
          message:
            'onStall.recover is required — the recovery phase to run when the node stalls',
          nodeName: ctxName,
          severity: 'error',
        });
      } else {
        validateNode(node.onStall.recover, here('onStall.recover'), ctxName, errors);
      }
      // maxRetries (optional, default 1) must be a non-negative integer.
      if (
        node.onStall.maxRetries != null &&
        (typeof node.onStall.maxRetries !== 'number' ||
          !Number.isInteger(node.onStall.maxRetries) ||
          node.onStall.maxRetries < 0)
      ) {
        errors.push({
          path: render(here('onStall.maxRetries')),
          message: 'onStall.maxRetries must be a non-negative integer (default 1)',
          nodeName: ctxName,
          severity: 'error',
        });
      }
    }
  }
}

function render(parts: (string | number)[]): string {
  if (parts.length === 0) return '(root)';
  let out = '';
  for (const p of parts) {
    if (typeof p === 'number') out += `[${p}]`;
    else if (out === '' || p.startsWith('[')) out += p;
    else out += `.${p}`;
  }
  return out;
}

/**
 * Walk the orchestration tree and collect every agent path it references.
 * Covers: leaf `agent`, `agents[]`, `loop.judge`, `route.router`,
 * `conversation.participants[]`, `merger`, plus recursion into every
 * composite body / branch (incl. `switch` cases) / onError / onStall.recover
 * via the shared `childNodesOf` walker.
 *
 * Returns a sorted, deduplicated list. Used to cross-reference against the
 * actual agents on disk so the UI can warn about missing files at edit
 * time instead of waiting for run-time "Agent file not found".
 */
export function collectAgentPaths(node: Node): string[] {
  const seen = new Set<string>();
  collect(node, seen);
  return Array.from(seen).sort();
}

function collect(node: Node, into: Set<string>): void {
  if (node.agent) into.add(node.agent);
  if (Array.isArray(node.agents)) for (const a of node.agents) into.add(a);
  if (node.merger) into.add(node.merger);
  if (node.loop?.judge) into.add(node.loop.judge);
  if (node.route?.router) into.add(node.route.router);
  if (Array.isArray(node.conversation?.participants)) {
    for (const a of node.conversation.participants) into.add(a);
  }
  // Shared walker (node-walk.ts) — the hand-rolled recursion this replaced
  // missed `switch` cases and `onStall.recover`, so an agent referenced only
  // inside either never got a missing-file warning at edit time.
  for (const child of childNodesOf(node)) collect(child, into);
}

/**
 * Check which of the orchestration's referenced agents don't exist in the
 * given known-agents set. Returns one `warning` per missing agent.
 *
 * `knownAgentPaths` should be the result of `listAgents()` mapped to
 * `agents/<name>.md` paths — same format agents are referenced in
 * orchestration JSON.
 */
export function validateAgentExistence(
  orchestration: Node,
  knownAgentPaths: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const referenced = collectAgentPaths(orchestration);
  for (const ref of referenced) {
    // Parameterized paths (e.g. `agents/${component}-crawler.md`) resolve from
    // run state at execution time — they can't be checked against disk
    // statically, so skip them here rather than emit a false "not found".
    if (ref.includes('${')) continue;
    if (!knownAgentPaths.has(ref)) {
      errors.push({
        path: ref,
        message: `agent file not found: ${ref}. Create it or fix the path before running.`,
        severity: 'warning',
      });
    }
  }
  return errors;
}

/** Walk a node tree and collect every `credential: "name"` reference.
 *  Used by the UI to cross-check that the credentials registry has an
 *  entry for each one before a run starts. */
export function collectCredentialRefs(node: Node): string[] {
  const seen = new Set<string>();
  collectCreds(node, seen);
  return Array.from(seen).sort();
}

function collectCreds(node: Node, into: Set<string>): void {
  if (node.credential) into.add(node.credential);
  if (Array.isArray(node.credentials)) {
    for (const c of node.credentials) if (c) into.add(c);
  }
  // Shared walker — the recursion this replaced missed `switch` cases and
  // `onStall.recover`, so a credential referenced only inside either dodged
  // the registry cross-check.
  for (const child of childNodesOf(node)) collectCreds(child, into);
}

/** Warn for each referenced credential name that isn't in the registry.
 *  Mirrors `validateAgentExistence` — caller passes the Set of known
 *  names (typically `Object.keys(registry)`). Server-side check; the
 *  registry isn't visible to the browser without an extra fetch. */
export function validateCredentialExistence(
  orchestration: Node,
  knownCredentialNames: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const name of collectCredentialRefs(orchestration)) {
    if (!knownCredentialNames.has(name)) {
      errors.push({
        path: `credential:${name}`,
        message: `credential "${name}" referenced but not in the workspace credentials registry. Add it in Settings → Credentials, or remove the reference.`,
        severity: 'warning',
      });
    }
  }
  return errors;
}

/**
 * Walk a node tree and collect every subflow reference (by name).
 * Recurses through every composite kind so deeply nested subflow
 * refs are still surfaced.
 */
export function collectSubflowRefs(node: Node): string[] {
  const seen = new Set<string>();
  function visit(n: Node): void {
    if (n.subflow) seen.add(n.subflow);
    // Shared walker — the recursion this replaced missed `switch` cases and
    // `onStall.recover`, so a subflow reachable only through either was
    // invisible to cycle detection (detectSubflowCycles builds on this).
    for (const child of childNodesOf(n)) visit(child);
  }
  visit(node);
  return Array.from(seen).sort();
}

/**
 * Detect subflow cycles starting from `root`. Returns one
 * ValidationError per cycle found, each describing the call chain
 * (e.g. "compose-A → compose-B → compose-A").
 *
 * `orchestrationsByName` is the full registry of orchestrations the
 * workspace knows about — typically derived from listOrchestrations().
 * Refs to missing orchestrations are not flagged here; that's a
 * separate concern (the executor will throw at runtime).
 *
 * Detection is iterative DFS so it survives reasonably deep nests
 * without blowing the JS stack.
 */
export function detectSubflowCycles(
  root: Node,
  orchestrationsByName: Map<string, Node>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const reportedCycles = new Set<string>();
  type Frame = { name: string; path: string[] };
  const stack: Frame[] = [{ name: root.name, path: [root.name] }];
  // Pre-walk the root's own tree to seed the initial set of subflow
  // refs (the root isn't in the registry by name usually).
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.name === root.name ? root : orchestrationsByName.get(frame.name);
    if (!current) continue;
    const refs = collectSubflowRefs(current);
    for (const ref of refs) {
      if (frame.path.includes(ref)) {
        // Cycle detected — emit a chain showing how we got here.
        const chain = [...frame.path, ref].join(' → ');
        // Canonicalize by sorting names so repeated traversals don't
        // double-report (compose-A → compose-B → compose-A and
        // compose-B → compose-A → compose-B describe the same cycle).
        const fingerprint = [...frame.path, ref].slice().sort().join('|');
        if (reportedCycles.has(fingerprint)) continue;
        reportedCycles.add(fingerprint);
        errors.push({
          path: 'subflow',
          message: `subflow cycle: ${chain}`,
          severity: 'error',
        });
        continue;
      }
      // Recurse into ref's subflows.
      stack.push({ name: ref, path: [...frame.path, ref] });
    }
  }
  return errors;
}

/** Group errors by the nearest enclosing node name. Returns `{ nodeName -> errors }`. */
export function errorsByNode(errors: ValidationError[]): Map<string, ValidationError[]> {
  const out = new Map<string, ValidationError[]>();
  for (const e of errors) {
    const key = e.nodeName ?? '(root)';
    const list = out.get(key) ?? [];
    list.push(e);
    out.set(key, list);
  }
  return out;
}
