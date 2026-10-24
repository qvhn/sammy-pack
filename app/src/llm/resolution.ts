/**
 * Shared resolution primitives — the SINGLE source of truth for how the
 * executor turns a node's declarative `${...}` fields and static control-flow
 * predicates into concrete values.
 *
 * Why this module exists (the faithfulness guarantee): `preview.ts` performs a
 * symbolic walk of the same node tree the executor runs, and its WHOLE value
 * proposition is that "what preview shows is what the executor does". The only
 * way to guarantee that — rather than hope two parallel implementations stay in
 * sync — is to have BOTH call the exact same functions for:
 *
 *   - building the interpolation lookup (state + scope + reserved `input`),
 *   - running interpolation (`interpolate`, incl. its `onUnresolved` hook),
 *   - the static control-flow predicates: `when` truthiness and `switch`-case
 *     selection.
 *
 * `executor.ts` historically inlined these (`{ ...state, ...scope, input }`,
 * `whenTruthy(node.when, …)`, the `switch.on ?? input` + `decideSwitch` dance).
 * They are extracted here verbatim, with NO behavior change — the executor now
 * delegates, and `preview.ts` calls the same helpers, so a resolved command or
 * prompt in preview is byte-identical to what the executor builds at that phase.
 *
 * Pure + dependency-light (only `interpolate` / `control-flow`, themselves
 * pure) → unit-tested in isolation (resolution.test.ts) and safe to import from
 * both the Node-server executor and the browser/CLI preview path.
 */

import { interpolate, whenTruthy, type State } from './interpolate';
import { decideSwitch } from './control-flow';
import type { Node, SwitchBody } from '../types';

/**
 * The interpolation lookup map for a node, exactly as the executor builds it:
 * run-wide `state` (vars + `as`-bound outputs + state-decl slots), overlaid
 * with scope-local vars (`item` / `index` inside a `map`, `error` inside an
 * `onError` branch), overlaid with the reserved `input` (the current upstream
 * output). Later spreads win — matching the executor's `lookupState`.
 *
 * This is the one place the lookup shape is defined; both the executor and the
 * preview walker call it so neither can drift on precedence.
 */
export function buildLookup(state: State, scope: State, input: string): State {
  return { ...state, ...scope, input };
}

/**
 * Interpolate a single template field against a lookup. A thin, intention-named
 * pass-through to `interpolate` so every resolved field in both the executor
 * and preview flows through ONE call site (and the same `onUnresolved` hook is
 * available to collect unbound refs). Faithful by construction.
 */
export function resolveTemplate(
  template: string,
  lookup: State,
  onUnresolved?: (ref: string) => void,
): string {
  return interpolate(template, lookup, onUnresolved);
}

/**
 * Evaluate a node's `when` decorator against a lookup. Returns true when the
 * node should run (predicate truthy or absent), false when it should be
 * skipped. Mirrors the executor's guard exactly:
 *   `node.when !== undefined && !whenTruthy(node.when, lookup)` → skip.
 * A node with no `when` always runs.
 *
 * `onUnresolved` fires for each `${ref}` in the predicate that doesn't resolve
 * against the lookup. The executor uses it to make an unresolved predicate a
 * LOUD fail-safe skip: an unresolved ref renders as the literal `${...}` — a
 * non-empty, therefore TRUTHY, string — so before this hook a
 * `when: "${flagNobodySets}"` phase silently always-ran (the top
 * intent/reality divergence). The return value is still the raw truthiness of
 * the (possibly literal-bearing) resolved string; the CALLER decides the skip,
 * so preview and any other consumer keep their own handling.
 *
 * Preview uses this to decide a STATIC branch (take it / skip it) identically to
 * execution; when the predicate references a runtime value the caller detects
 * the unresolved ref separately and renders the branch symbolically instead.
 */
export function evalWhen(
  when: string | undefined,
  lookup: State,
  onUnresolved?: (ref: string) => void,
): boolean {
  if (when === undefined) return true;
  return whenTruthy(when, lookup, onUnresolved);
}

/** The resolved value a `switch` node selects on, and the chosen case key.
 *  `value` is the post-interpolation switched-on value (the executor's
 *  `switch.on` interpolated, or the upstream input when `on` is unset).
 *  `matched` is the case key `decideSwitch` chose, or null for the default /
 *  no-match path. */
export type SwitchSelection = { value: string; matched: string | null };

/**
 * Resolve a `switch` body to its switched-on value + selected case, exactly as
 * the executor does:
 *   value = `switch.on` interpolated over the lookup, else the upstream `input`;
 *   matched = `decideSwitch(value, caseKeys)`.
 *
 * The `onUnresolved` hook surfaces an unbound `${...}` inside `switch.on` (so
 * preview can mark the switch runtime-symbolic when its `on` doesn't resolve).
 * Selection logic itself is `decideSwitch` — the same exact-match-normalized
 * routine the executor and the `route`/loop decisions share.
 */
/**
 * Split a switch's unresolved `on` references by WHY they did not resolve:
 *   - `missingBase`: the first segment names nothing in state — a typo, or a
 *     binding whose step never ran. A real bug: the switch must not guess.
 *   - `missingField`: the base exists but the field does not (an empty search
 *     result, a map item without an optional field) — the long-standing
 *     "missing means default" case, kept, but reported.
 */
export function classifyUnresolved(
  refs: readonly string[],
  lookup: State,
): { missingBase: string[]; missingField: string[] } {
  const missingBase: string[] = [];
  const missingField: string[] = [];
  for (const r of new Set(refs)) {
    const base = r.split('.')[0].trim();
    if (Object.prototype.hasOwnProperty.call(lookup, base) && lookup[base] !== undefined) {
      missingField.push(r);
    } else {
      missingBase.push(r);
    }
  }
  return { missingBase, missingField };
}

export function selectSwitchCase(
  sw: SwitchBody,
  input: string,
  lookup: State,
  onUnresolved?: (ref: string) => void,
): SwitchSelection {
  const value =
    sw.on != null ? interpolate(sw.on, lookup, onUnresolved) : input;
  const matched = decideSwitch(value, Object.keys(sw.cases));
  return { value, matched };
}

/**
 * Resolve a leaf agent's effective input string, mirroring `runAgentPhase`:
 * the `node.prompt` override (interpolated) when present, else the upstream
 * `input` (also interpolated — an upstream value can itself carry `${...}`).
 * Unbound refs flow to `onUnresolved`. This is the exact string the executor
 * passes to the agent as its user message (before any runtime-only gate-message
 * append), so it is the byte-for-byte surface the faithfulness parity test
 * diffs preview against.
 */
export function resolveAgentInput(
  node: Pick<Node, 'prompt'>,
  input: string,
  lookup: State,
  onUnresolved?: (ref: string) => void,
  onEmpty?: (ref: string) => void,
): string {
  const baseInput = node.prompt ?? input;
  return interpolate(baseInput, lookup, onUnresolved, onEmpty);
}

/**
 * Resolve an agent PATH that may itself reference state — e.g.
 * `agents/${component}-crawler.md` or a bare `${agentVar}` — exactly as
 * `runAgentPhase` does before the registry lookup. A literal path (no `${`)
 * passes through unchanged.
 */
export function resolveAgentPath(
  agentPath: string,
  lookup: State,
  onUnresolved?: (ref: string) => void,
): string {
  return interpolate(agentPath, lookup, onUnresolved);
}

/**
 * Resolve a `code.run` external command, mirroring `runCodePhase`: the command
 * string interpolated over run state (so `${vars.scriptsDir}/build.sh`, an
 * upstream `${as}` value, or `${item}` / `${index}` resolve) — the exact string
 * the executor hands to the shell. Unbound refs flow to `onUnresolved`, which
 * is how preview flags the `build-install.sh … ${appEnv}` literal-passthrough
 * gotcha at author time.
 */
export function resolveCommand(
  run: string,
  lookup: State,
  onUnresolved?: (ref: string) => void,
): string {
  return interpolate(run, lookup, onUnresolved);
}
