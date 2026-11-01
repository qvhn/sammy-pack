/**
 * Which model a phase runs on, and the models the editor offers.
 *
 * Highest first: the phase's own `model` → the agent file's `model:`
 * frontmatter (Claude Code's convention: a full id or an alias like `opus`;
 * `inherit` means no choice) → the run's model (Settings → Default model, or
 * what the run was started with). An agent file's choice only applies when
 * the phase runs on Claude — a phase routed to another provider keeps the
 * run's model unless the phase names one itself.
 */

import { modelPrice } from './pricing';

export type ModelChoice = { id: string; label: string };

/** The models the pickers list. Any other id can still be typed in. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/** Claude Code's model aliases: the newest model of the family. */
const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

/** A model as written (an id, an alias, `inherit` or blank) → the id to run,
 *  or undefined for "no choice here". */
export function resolveModelName(model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m || m === 'inherit') return undefined;
  return ALIASES[m.toLowerCase()] ?? m;
}

export function modelLabel(id: string): string {
  return MODEL_CHOICES.find(c => c.id === id)?.label ?? id;
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : Number.isInteger(n) ? n : n.toFixed(2)}`;

/** "$4 / $20 per 1M tokens" — input / output; "≈" when the price is a
 *  family estimate; '' when the model has no known price. */
export function modelPriceLabel(id: string): string {
  const p = modelPrice(id);
  if (!p) return '';
  return `${p.estimated ? '≈ ' : ''}${usd(p.input)} in / ${usd(p.output)} out per 1M tokens`;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const MODEL_LINE = /^model:[ \t]*(.*)$/m;

/** The `model:` an agent file's frontmatter declares, as written. */
export function agentFileModel(raw: string): string | undefined {
  const fm = FRONTMATTER.exec(raw)?.[1];
  const v = fm ? MODEL_LINE.exec(fm)?.[1] : undefined;
  const unquoted = v?.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return unquoted || undefined;
}

/** The agent file with its `model:` set (or removed, for null). A file with
 *  no frontmatter gets one. Everything else in the file is left as it was. */
export function withAgentFileModel(raw: string, model: string | null): string {
  const m = FRONTMATTER.exec(raw);
  if (!m) return model ? `---\nmodel: ${model}\n---\n\n${raw}` : raw;
  const fm = m[1];
  let next: string;
  if (MODEL_LINE.test(fm)) {
    next = model ? fm.replace(MODEL_LINE, `model: ${model}`) : fm.replace(/^model:.*(\r?\n|$)/m, '').replace(/\r?\n$/, '');
  } else {
    if (!model) return raw;
    next = `${fm}\nmodel: ${model}`;
  }
  return raw.slice(0, m.index) + `---\n${next}\n---${m[2]}` + raw.slice(m.index + m[0].length);
}

export type ModelSource = 'phase' | 'agent' | 'run';

/** The model a phase runs on, and where that choice came from. */
export function phaseModel(opts: {
  phaseModel?: string;
  agentRaw?: string;
  runModel: string;
  /** False when the phase is routed to a non-Claude provider. */
  claude?: boolean;
}): { model: string; source: ModelSource } {
  const own = resolveModelName(opts.phaseModel);
  if (own) return { model: own, source: 'phase' };
  const fromAgent = opts.claude !== false && opts.agentRaw ? resolveModelName(agentFileModel(opts.agentRaw)) : undefined;
  if (fromAgent) return { model: fromAgent, source: 'agent' };
  return { model: opts.runModel, source: 'run' };
}
