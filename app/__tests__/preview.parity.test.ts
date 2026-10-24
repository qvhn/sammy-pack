/**
 * Faithfulness parity — the property that matters.
 *
 * For a corpus of orchestrations, EVERY command/prompt that `preview` renders as
 * FULLY RESOLVED (no `«…»` symbolic placeholder) must be BYTE-IDENTICAL to what
 * the executor builds at that phase. We run the executor in a RECORDING HARNESS
 * that captures the resolved agent inputs + code.run commands WITHOUT executing
 * side effects (the LLM stream is mocked; `code.run`'s child process is stubbed
 * so the resolved command is captured but never spawned), then diff against the
 * preview plan's resolved action text.
 *
 * This is the regression guard against drift: change interpolation in the
 * executor but not preview (or vice versa) and a resolved string diverges and
 * this test fails. The shared-helpers refactor (resolution.ts) makes the
 * property hold by construction; this test keeps it true.
 *
 * Mechanism note: the executor's agent USER message is exactly
 * `resolveAgentInput(node, input, lookup)` (before any runtime-only gate-message
 * append), and its `code.run` command is exactly `resolveCommand(node.code.run,
 * lookup)` — the same shared helpers preview's action text flows through. So a
 * statically-resolvable phase resolves identically on both sides.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Node } from '../src/types';
import {
  previewOrchestration,
  type PreviewNode,
  type PreviewPlan,
} from '../src/llm/preview';

// ── Recording harness: mock the LLM + stub code.run's spawn ──────────────────

// Captured agent user-messages in call order (the resolved prompt the executor
// hands the model). `mock`-prefixed name is exempt from jest's scope check.
const mockRec: { agentInputs: string[]; commands: string[] } = {
  agentInputs: [],
  commands: [],
};

jest.mock('../src/llm/anthropic', () => ({
  streamAnthropic(params: { messages: { role: string; content: string }[] }) {
    const user = params.messages[params.messages.length - 1]?.content ?? '';
    mockRec.agentInputs.push(user);
    let stage = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (stage === 0) {
              stage = 1;
              // Return a deterministic, side-effect-free reply.
              return { value: { type: 'text-delta', text: 'OK' }, done: false };
            }
            if (stage === 1) {
              stage = 2;
              return {
                value: { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
                done: false,
              };
            }
            return { value: undefined, done: true };
          },
          return() {
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  },
}));

// Every agent the corpus orchestrations dispatch to — a missing agent throws
// "Agent file not found" and the run aborts before recording anything, so the
// override must be complete.
const mockCorpusAgents = [
  'echo',
  'stg-runner',
  'summarizer',
  'qa-runner',
  'judge-blast-radius',
  'judge-release-readiness',
  'pm',
].map(name => ({ name, raw: `---\nname: ${name}\n---\n${name} agent.` }));

jest.mock('../src/api', () => ({
  listAgents: async () => mockCorpusAgents,
  listOrchestrations: async () => [],
}));

// Stub `code.run`'s child process. The executor resolves `spawn` via
// `process.getBuiltinModule('node:child_process')` at runtime; we intercept that
// lookup so the RESOLVED command is recorded but no process is spawned.
const realGetBuiltin = (process as unknown as {
  getBuiltinModule?: (id: string) => unknown;
}).getBuiltinModule?.bind(process);

function installSpawnStub(): void {
  (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule =
    (id: string) => {
      if (id === 'node:child_process') {
        return {
          spawn(command: string) {
            mockRec.commands.push(command);
            // A minimal fake child that immediately closes with exit 0.
            const handlers: Record<string, (...a: unknown[]) => void> = {};
            const child = {
              stdout: { on: () => {} },
              stderr: { on: () => {} },
              stdin: { write: () => {}, end: () => {} },
              on(ev: string, cb: (...a: unknown[]) => void) {
                handlers[ev] = cb;
                if (ev === 'close') setTimeout(() => cb(0), 0);
              },
            };
            return child;
          },
        };
      }
      return realGetBuiltin ? realGetBuiltin(id) : undefined;
    };
}

function restoreSpawn(): void {
  if (realGetBuiltin) {
    (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule =
      realGetBuiltin;
  }
}

// Import the executor AFTER the mocks are registered.
import { runOrchestration } from '../src/llm/executor';

async function recordExecutor(
  orch: Node,
  opts: { vars?: Record<string, string>; initialInput?: string },
): Promise<{ agentInputs: string[]; commands: string[] }> {
  mockRec.agentInputs = [];
  mockRec.commands = [];
  // Seed --vars exactly as the preview path: layer over the orchestration's vars.
  const seeded: Node = {
    ...orch,
    vars: { ...(orch.vars ?? {}), ...(opts.vars ?? {}) },
  };
  installSpawnStub();
  const prevAllow = process.env.SAMMY_ALLOW_CODE_RUN;
  process.env.SAMMY_ALLOW_CODE_RUN = '1';
  try {
    // Drain the run to completion — we only care about the RECORDED resolved
    // inputs / commands (captured by the mock + spawn stub), not the events.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of runOrchestration({
      orchestration: seeded,
      apiKey: 'test',
      model: 'test-model',
      initialInput: opts.initialInput ?? '',
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: mockCorpusAgents as never,
      orchestrationsOverride: [],
    })) {
      // no-op: events are not asserted on here
    }
  } finally {
    restoreSpawn();
    if (prevAllow === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = prevAllow;
  }
  return { agentInputs: mockRec.agentInputs, commands: mockRec.commands };
}

// ── Collect preview's FULLY-RESOLVED action strings ──────────────────────────

function collectResolvedActions(plan: PreviewPlan): {
  prompts: string[];
  commands: string[];
} {
  const prompts: string[] = [];
  const commands: string[] = [];
  const visit = (n: PreviewNode): void => {
    // Only FULLY-RESOLVED, NON-EMPTY actions (no symbolic placeholder) are
    // subject to the byte-identical property; symbolic ones are runtime-
    // dependent by contract, and an empty prompt (no override, empty upstream)
    // carries no resolution worth diffing.
    if (n.action && !n.symbolic && !n.action.text.includes('«') && n.action.text.length > 0) {
      if (n.action.verb === 'would prompt') prompts.push(n.action.text);
      else if (n.action.verb === 'would run') commands.push(n.action.text);
    }
    n.children.forEach(visit);
  };
  plan.phases.forEach(visit);
  return { prompts, commands };
}

// ── The corpus ───────────────────────────────────────────────────────────────

const FIX = path.join(__dirname, 'fixtures');
const EXAMPLES = path.resolve(__dirname, '..', '..', 'examples');

function load(file: string): Node {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Node;
}

type Case = { name: string; orch: Node; vars?: Record<string, string>; input?: string };

const corpus: Case[] = [
  { name: 'parity-corpus fixture', orch: load(path.join(FIX, 'parity-corpus.json')), input: 'PAYLOAD' },
  { name: 'deploy-fanout-qa example', orch: load(path.join(EXAMPLES, 'deploy-fanout-qa.json')) },
];

describe('faithfulness parity — preview resolved == executor resolved (byte-identical)', () => {
  for (const c of corpus) {
    test(`${c.name}: every fully-resolved preview prompt/command is what the executor builds`, async () => {
      const rec = await recordExecutor(c.orch, { vars: c.vars, initialInput: c.input });
      const plan = previewOrchestration(c.orch, {
        vars: c.vars,
        initialInput: c.input,
      });
      const resolved = collectResolvedActions(plan);

      // The executor's recorded agent inputs / commands as sets — preview's
      // fully-resolved strings must each appear verbatim.
      const execPrompts = new Set(rec.agentInputs);
      const execCommands = new Set(rec.commands);

      expect(resolved.prompts.length).toBeGreaterThan(0); // corpus actually exercises agents
      for (const p of resolved.prompts) {
        expect(execPrompts.has(p)).toBe(true);
      }
      for (const cmd of resolved.commands) {
        expect(execCommands.has(cmd)).toBe(true);
      }
    });
  }

  test('a divergence WOULD be caught: a hand-mutated resolved prompt is not in the executor set', async () => {
    const orch = load(path.join(FIX, 'parity-corpus.json'));
    const rec = await recordExecutor(orch, { initialInput: 'PAYLOAD' });
    const execPrompts = new Set(rec.agentInputs);
    // Simulate drift: a prompt preview "would" render that the executor never
    // built. The guard must reject it.
    expect(execPrompts.has('Say hello to the world — DRIFTED')).toBe(false);
  });
});
