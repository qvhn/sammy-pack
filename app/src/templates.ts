/**
 * Built-in pipeline templates.
 *
 * These are starter orchestrations the user can pick when creating a new
 * pipeline. They showcase the v2 primitives (route, map, parallel, converge,
 * loop, decorators) so users have working examples to riff on.
 *
 * Agent paths are illustrative — most templates reference agents the user
 * will need to create. The runtime will surface "Agent file not found" at
 * run start; the user can edit the template after creation.
 */

import type { Node } from './types';

export type Template = {
  id: string;
  name: string;
  description: string;
  /** One-line category for grouping in the UI. */
  category: 'support' | 'engineering' | 'content' | 'data' | 'product';
  /** Tags advertising which v2 features this template exercises. */
  tags: string[];
  /** The orchestration node tree (root). `name` is filled in from user input
   *  at create time, so leave the template's `name` as the suggested default. */
  body: Node;
};

export const TEMPLATES: Template[] = [
  {
    id: 'support-triage',
    name: 'support-triage',
    description:
      'Route inbound support tickets to the right specialist branch. Human approval gate before any reply is sent.',
    category: 'support',
    tags: ['route', 'lock', 'retry'],
    body: {
      name: 'support-triage',
      description:
        'Classify support tickets, dispatch to the right handler, human-approve before sending.',
      phases: [
        {
          name: 'classify-and-handle',
          route: {
            router: 'agents/router.md',
            branches: {
              bug: {
                name: 'bug-investigator',
                agent: 'agents/bug-investigator.md',
                retry: { times: 2, backoff: 'exponential', initialMs: 1000 },
              },
              feature: {
                name: 'feature-request',
                agent: 'agents/product-triager.md',
              },
              billing: {
                name: 'billing-lookup',
                agent: 'agents/billing-specialist.md',
                tools: ['stripe'],
              },
            },
            default: {
              name: 'escalate',
              agent: 'agents/escalate.md',
            },
          },
        },
        {
          name: 'draft-reply',
          agent: 'agents/support-writer.md',
          as: 'reply',
        },
        {
          name: 'send',
          agent: 'agents/zendesk-sender.md',
          lock: true,
          tools: ['zendesk'],
        },
      ],
    },
  },
  {
    id: 'rag-ingestion',
    name: 'rag-ingestion',
    description:
      'Fan out over a list of documents: chunk → embed → upsert into a vector store. Per-item retry and a global cost budget.',
    category: 'data',
    tags: ['map', 'retry', 'budget', '${var}'],
    body: {
      name: 'rag-ingestion',
      description:
        'Ingest a doc list (passed in as ${docs}) into a vector store. Default: 10 docs from inline JSON.',
      phases: [
        {
          name: 'init',
          agent: 'agents/ingestion-coordinator.md',
          description:
            'Should set ${docs} (a JSON array of {id, url, text}) for the map to fan over.',
          as: 'docs',
        },
        {
          name: 'embed-each',
          map: {
            over: '${docs}',
            body: {
              name: 'embed-and-store',
              phases: [
                {
                  name: 'chunk',
                  agent: 'agents/chunker.md',
                  as: 'chunks',
                  retry: { times: 3, backoff: 'exponential' },
                },
                {
                  name: 'embed',
                  agent: 'agents/embedder.md',
                  tools: ['openai-embeddings'],
                  timeout: 30,
                  retry: { times: 3, backoff: 'exponential', initialMs: 500 },
                },
                {
                  name: 'upsert',
                  agent: 'agents/vector-writer.md',
                  tools: ['pinecone'],
                },
              ],
            },
          },
          budget: { maxCostUsd: 10.0 },
        },
        {
          name: 'summarize-run',
          agent: 'agents/run-reporter.md',
        },
      ],
    },
  },
  {
    id: 'code-review',
    name: 'code-review',
    description:
      'Three specialist reviewers in parallel (security, performance, style), then a senior engineer merges their findings into a single review.',
    category: 'engineering',
    tags: ['converge', 'merger', 'parallel'],
    body: {
      name: 'code-review',
      description:
        'Triple-review a PR. Each reviewer gets the same diff; the merger reconciles disagreements.',
      phases: [
        {
          name: 'fetch-diff',
          agent: 'agents/pr-fetcher.md',
          tools: ['github'],
          as: 'diff',
        },
        {
          name: 'review',
          converge: [
            { name: 'security-review', agent: 'agents/security-reviewer.md' },
            { name: 'perf-review', agent: 'agents/perf-reviewer.md' },
            { name: 'style-review', agent: 'agents/style-reviewer.md' },
          ],
          merger: 'agents/review-synthesizer.md',
        },
        {
          name: 'post-comment',
          agent: 'agents/pr-commenter.md',
          tools: ['github'],
          lock: true,
        },
      ],
    },
  },
  {
    id: 'research-synthesis',
    name: 'research-synthesis',
    description:
      'Three researchers tackle the same question in parallel, then a writer synthesizes into a single brief, iterated until a judge agent approves.',
    category: 'content',
    tags: ['parallel', 'loop', 'judge', 'converge'],
    body: {
      name: 'research-synthesis',
      description: 'Parallel research → synthesis → polish loop.',
      phases: [
        {
          name: 'gather',
          parallel: [
            { name: 'researcher-a', agent: 'agents/researcher.md' },
            { name: 'researcher-b', agent: 'agents/researcher.md' },
            { name: 'researcher-c', agent: 'agents/researcher.md' },
          ],
          as: 'findings',
        },
        {
          name: 'polish',
          loop: {
            body: {
              name: 'draft',
              agent: 'agents/writer.md',
            },
            maxIterations: 5,
            judge: 'agents/critique.md',
            until: '[APPROVED]',
          },
        },
      ],
    },
  },
  {
    id: 'incident-response',
    name: 'incident-response',
    description:
      'Severity-routed incident triage. P0/P1 page the on-call; P2/P3 file a ticket. Auto-recovery via onError if the pager fails.',
    category: 'engineering',
    tags: ['route', 'onError', 'retry', 'lock'],
    body: {
      name: 'incident-response',
      description: 'Classify severity, dispatch, escalate on failure.',
      phases: [
        {
          name: 'classify',
          agent: 'agents/severity-classifier.md',
          as: 'severity',
        },
        {
          name: 'dispatch',
          route: {
            router: 'agents/severity-classifier.md',
            branches: {
              p0: {
                name: 'page-oncall',
                agent: 'agents/pagerduty-pager.md',
                tools: ['pagerduty'],
                retry: { times: 3, backoff: 'exponential', initialMs: 2000 },
                timeout: 30,
                onError: {
                  name: 'fallback-slack',
                  agent: 'agents/slack-announcer.md',
                  tools: ['slack'],
                },
              },
              p1: {
                name: 'page-oncall',
                agent: 'agents/pagerduty-pager.md',
                tools: ['pagerduty'],
                retry: { times: 2 },
              },
              p2: {
                name: 'file-ticket',
                agent: 'agents/linear-ticketer.md',
                tools: ['linear'],
              },
              p3: {
                name: 'file-ticket',
                agent: 'agents/linear-ticketer.md',
                tools: ['linear'],
              },
            },
          },
        },
        {
          name: 'announce',
          agent: 'agents/status-page-updater.md',
          when: '${severity}',
          tools: ['statuspage'],
          lock: true,
        },
      ],
    },
  },
  {
    id: 'spec-design-impl',
    name: 'spec-design-impl',
    description:
      'PM writes a spec, designer drafts UX, engineer implements — each step references prior steps via ${spec} and ${design}.',
    category: 'product',
    tags: ['as', '${var}', 'lock'],
    body: {
      name: 'spec-design-impl',
      description:
        'Linear product flow with each step naming its output (as: spec / design / impl) for downstream context.',
      phases: [
        {
          name: 'spec',
          agent: 'agents/pm.md',
          as: 'spec',
          lock: true,
        },
        {
          name: 'design',
          agent: 'agents/uxui.md',
          as: 'design',
          description: 'Sees the PM spec via ${spec} in its prompt.',
        },
        {
          name: 'impl',
          agent: 'agents/dev.md',
          as: 'impl',
          description:
            'Has access to ${spec} and ${design}. Implementation plan output.',
          retry: { times: 2 },
          budget: { maxTokens: 50000 },
        },
        {
          name: 'review',
          agent: 'agents/dev-lead.md',
          lock: true,
        },
      ],
    },
  },
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find(t => t.id === id);
}
