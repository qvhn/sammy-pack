/**
 * `PreviewPlan` → output. Two renderers, ONE source of truth (the plan):
 *   - `renderPlanText`  — an indented terminal plan with inline findings, for
 *     a human reading it at the terminal.
 *   - `renderPlanJson`  — the plan as JSON (for `--json`, CI gates, tooling).
 *
 * Kept deliberately separate from the walk (`preview.ts`) so the symbolic walk
 * is computed once and both outputs derive from it — they can't disagree about
 * what the plan IS, only about how it's formatted.
 */

import type { PreviewPlan, PreviewNode, PreviewFinding } from './preview';

/** `--json` output: the plan, pretty-printed. */
export function renderPlanJson(plan: PreviewPlan): string {
  return JSON.stringify(plan, null, 2);
}

/** Glyphs for the three severities (ASCII-safe sigils + a leading icon). */
const SEV_ICON: Record<PreviewFinding['severity'], string> = {
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
};

const MAX_ACTION = 100;

/**
 * Render the terminal plan. Shape:
 *
 *   preview  <orchestration>
 *     triggers   …
 *     concurrency …
 *     vars       k=v  k=v  …
 *     ⚠  <root finding>
 *
 *     phases
 *     1  <name>   <kind>   <expansion>   → <as>   when <…>
 *          would run: <resolved command>
 *          ⚠ <inline finding>
 *     …
 *
 *     summary  N phases · S subflows · A agents · R code.run
 *     findings E errors · W warnings
 */
export function renderPlanText(plan: PreviewPlan): string {
  const out: string[] = [];
  out.push(`preview  ${plan.orchestration}`);
  if (plan.triggers.length > 0) {
    out.push(`  triggers   ${plan.triggers.join('  ·  ')}`);
  }
  if (plan.concurrency) {
    out.push(`  concurrency  ${plan.concurrency}`);
  }
  if (plan.vars.length > 0) {
    const varsStr = plan.vars
      .map(v => `${v.key}=${clip(v.value, 40)}`)
      .join('  ');
    out.push(`  vars       ${varsStr}`);
  }
  // Root-level findings (e.g. decorative-var) sit right under the header — the
  // glance-level catch the doc shows on line 4.
  for (const f of plan.findings) {
    out.push(`  ${SEV_ICON[f.severity]}  ${f.message}`);
  }

  out.push('');
  out.push('  phases');
  let counter = 0;
  for (const phase of plan.phases) {
    counter = renderNode(phase, out, 1, counter, true);
  }

  out.push('');
  const s = plan.summary;
  out.push(
    `  summary  ${s.phases} phases · ${s.subflows} subflows · ` +
      `${s.agents} agents · ${s.codeRun} code.run`,
  );
  out.push(
    `  findings ${s.errors} error${s.errors === 1 ? '' : 's'} · ` +
      `${s.warnings} warning${s.warnings === 1 ? '' : 's'}`,
  );
  return out.join('\n');
}

/**
 * Render one node + its subtree. `depth` controls indentation; `counter` is the
 * running top-level phase number (only incremented for the outermost layer).
 * Returns the updated counter.
 */
function renderNode(
  node: PreviewNode,
  out: string[],
  depth: number,
  counter: number,
  topLevel: boolean,
): number {
  const indent = '  '.repeat(depth + 1);
  let nextCounter = counter;

  // The phase header line: number/marker, name, kind, expansion, → as, when.
  let lead: string;
  if (topLevel) {
    nextCounter = counter + 1;
    lead = `${indent}${String(nextCounter).padStart(2, ' ')}  `;
  } else {
    lead = `${indent}${runMarker(node)} `;
  }

  const parts: string[] = [pad(node.name, 22), pad(kindLabel(node), 11)];
  if (node.expansion) parts.push(node.expansion);
  if (node.as) parts.push(`→ ${node.as}`);
  if (node.whenLabel !== undefined) {
    parts.push(node.wouldRun === 'conditional' ? `when ${node.whenLabel}` : `when ${node.whenLabel}`);
  }
  if (node.wouldRun === false) parts.push('(skipped — when false)');

  out.push((lead + parts.join('  ')).replace(/\s+$/, ''));

  // The resolved/symbolic action line (would run / would prompt / would call).
  if (node.action) {
    const actIndent = '  '.repeat(depth + 2);
    const verbCol = node.action.verb === 'would run' ? 'run ' : node.action.verb === 'would prompt' ? 'prompt' : node.action.verb;
    const text = node.action.text.trim() === '' ? '(upstream output)' : oneLine(node.action.text, MAX_ACTION);
    out.push(`${actIndent}${verbCol}  ${text}`);
  }

  // Seeded bindings (a subflow's own vars, etc.).
  for (const b of node.bindings ?? []) {
    const bIndent = '  '.repeat(depth + 2);
    out.push(`${bIndent}│  vars  ${b.key}=${clip(b.value, 50)}`);
  }

  // Inline findings, sorted error → warning → info.
  for (const f of sortFindings(node.findings)) {
    const fIndent = '  '.repeat(depth + 2);
    out.push(`${fIndent}${SEV_ICON[f.severity]} ${f.message}`);
  }

  // Children (one level deeper). Children are never top-level-numbered.
  for (const child of node.children) {
    renderNode(child, out, depth + 1, nextCounter, false);
  }

  return nextCounter;
}

/** A marker for a non-top-level child: tree branch, conditional, or skipped. */
function runMarker(node: PreviewNode): string {
  if (node.wouldRun === false) return '⊘';
  if (node.wouldRun === 'conditional') return '├?';
  return '├─';
}

/** The kind label shown in the plan (a code.run renders as `code.run`). */
function kindLabel(node: PreviewNode): string {
  return node.kind;
}

function sortFindings(findings: PreviewFinding[]): PreviewFinding[] {
  const rank: Record<PreviewFinding['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function oneLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Diff (--diff <other config>) ─────────────────────────────────────────────

/**
 * Preview two configurations side by side and report only what DIFFERS — the
 * "what changes if I set appEnv=stg?" question. We compare the two plans'
 * per-phase resolved action lines (the byte-identical command/prompt the
 * executor would build): a phase whose resolved action differs is shown with
 * both renderings; phases that resolve identically are summarized as a count.
 * Vars and finding-counts are diffed at the top.
 *
 * `labelA` / `labelB` name the two configs (e.g. "appEnv=dev" / "appEnv=stg").
 */
export function renderDiffText(
  planA: PreviewPlan,
  planB: PreviewPlan,
  labelA: string,
  labelB: string,
): string {
  const out: string[] = [];
  out.push(`preview-diff  ${planA.orchestration}`);
  out.push(`  A = ${labelA}`);
  out.push(`  B = ${labelB}`);

  // Vars delta.
  const varsA = new Map(planA.vars.map(v => [v.key, v.value]));
  const varsB = new Map(planB.vars.map(v => [v.key, v.value]));
  const varKeys = [...new Set([...varsA.keys(), ...varsB.keys()])].sort();
  const varDiffs = varKeys.filter(k => varsA.get(k) !== varsB.get(k));
  if (varDiffs.length > 0) {
    out.push('');
    out.push('  vars changed');
    for (const k of varDiffs) {
      out.push(`    ${k}:  ${varsA.get(k) ?? '(unset)'}  →  ${varsB.get(k) ?? '(unset)'}`);
    }
  }

  // Per-phase action diff, walked in lockstep by name+position.
  const actionsA = flattenActions(planA.phases);
  const actionsB = flattenActions(planB.phases);
  const keys = [...new Set([...actionsA.keys(), ...actionsB.keys()])];
  const changed: string[] = [];
  let identical = 0;
  for (const key of keys) {
    const a = actionsA.get(key);
    const b = actionsB.get(key);
    if (a === b) {
      identical++;
      continue;
    }
    changed.push(key);
  }

  out.push('');
  if (changed.length === 0) {
    out.push('  no resolved-action differences — both configs run identical commands/prompts.');
  } else {
    out.push(`  phases that resolve DIFFERENTLY (${changed.length})`);
    for (const key of changed) {
      out.push(`  · ${key}`);
      out.push(`      A: ${actionsA.get(key) ?? '(absent)'}`);
      out.push(`      B: ${actionsB.get(key) ?? '(absent)'}`);
    }
    out.push('');
    out.push(`  ${identical} phase(s) resolve identically.`);
  }

  // Finding-count delta.
  out.push('');
  out.push(
    `  findings  A: ${planA.summary.errors}E/${planA.summary.warnings}W   ` +
      `B: ${planB.summary.errors}E/${planB.summary.warnings}W`,
  );
  return out.join('\n');
}

/** Flatten a plan's phase tree to `phaseKey → resolved action text`, keyed by a
 *  path that is stable across two previews of the same orchestration. */
function flattenActions(
  nodes: PreviewNode[],
  prefix = '',
  into: Map<string, string> = new Map(),
): Map<string, string> {
  nodes.forEach((n, i) => {
    const key = `${prefix}${i}:${n.name}`;
    if (n.action) into.set(key, `${n.action.verb}: ${oneLine(n.action.text, 200)}`);
    flattenActions(n.children, `${key} / `, into);
  });
  return into;
}
