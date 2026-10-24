/**
 * The curated set of example orchestrations that ship with sammy-pack
 * (the git-tracked files under examples/). These are the "starter"
 * pipelines every workspace gets out of the box — as opposed to the
 * ones a user authors, pastes, generates, or duplicates locally.
 *
 * Membership is intentionally an explicit allowlist rather than a
 * heuristic (e.g. git-tracked status): a user who commits their own
 * pipeline to the repo shouldn't suddenly see it badged "default", and
 * the list shouldn't require a server round-trip to compute. When the
 * shipped example set changes, update this list (the
 * defaultPipelines.test.ts drift-guard fails if a name here no longer
 * has a matching examples/<name>.json on disk).
 */
export const DEFAULT_PIPELINE_NAMES: ReadonlySet<string> = new Set([
  'architect-engineers-reviewer',
  'bug-report-funnel',
  'ci-flake-detector',
  'company-operating-system',
  'compose-pipeline',
  'content-review-board',
  'context-aware-triage',
  'context-compaction',
  'cross-functional-review',
  'customer-signal-router',
  'decision-tree',
  'defect-to-pr',
  'deploy-fanout-qa',
  'doc-generation',
  'eval-pipeline',
  'fanout-summarize',
  'federated-research',
  'finance-invoice-approval',
  'hr-candidate-screening',
  'idea-to-prototype',
  'incident-response',
  'iterative-refinement-scored',
  'legal-contract-review',
  'marketing-campaign',
  'memory-augmented-run',
  'multi-agent-dialog',
  'nightly-eval-gate',
  'parallel-research-then-build',
  'parameterized-review',
  'persona-fan-out',
  'production-rag',
  'refinement-loop',
  'release-pipeline',
  'sales-lead-to-close',
  'security-watch',
  'severity-classify',
  'sprint-delivery',
  'support-ticket-resolution',
  'ticket-to-pr',
  'ticket-triage',
]);

/** True when `name` is one of the shipped default pipelines. */
export function isDefaultPipeline(name: string): boolean {
  return DEFAULT_PIPELINE_NAMES.has(name);
}

// Which slice of the Pipelines sidebar list is shown:
//   'all'      — everything (shipped defaults + user-authored)
//   'mine'     — only user-authored (hide the shipped defaults)
//   'defaults' — only the shipped defaults
// Persisted so the choice sticks across reloads, mirroring the other
// small UI prefs in store/apiKey.ts. Defaults to 'all'.
export type PipelineFilter = 'all' | 'mine' | 'defaults';

const PIPELINE_FILTER_KEY = 'sammy.pipelineFilter';

export function getPipelineFilter(): PipelineFilter {
  try {
    const v = localStorage.getItem(PIPELINE_FILTER_KEY);
    return v === 'mine' || v === 'defaults' ? v : 'all';
  } catch {
    return 'all';
  }
}

export function setPipelineFilter(filter: PipelineFilter): void {
  try {
    localStorage.setItem(PIPELINE_FILTER_KEY, filter);
  } catch {
    /* localStorage unavailable */
  }
}
