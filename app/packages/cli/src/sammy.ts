/**
 * sammy CLI — run a JSON orchestration from the terminal.
 *
 *   sammy run <orchestration.json> [--input "text"]
 *                                  [--provider anthropic|openai|gemini]
 *                                  [--model <model>]
 *                                  [--agents-dir ./agents]
 *                                  [--api-key $KEY  or use ANTHROPIC_API_KEY /
 *                                                       OPENAI_API_KEY / GEMINI_API_KEY]
 *                                  [--quiet] [--json]
 *
 *   sammy validate <orchestration.json>
 *
 *   sammy preview <orchestration.json> [--vars k=v,…] [--input "text"]
 *                                      [--depth N] [--json]
 *                             Symbolic dry-run: resolve the concrete plan
 *                             (every command, value, branch) with NO side
 *                             effects — no agent dispatch, no network. Exits 1
 *                             when any error-severity finding exists (CI gate).
 *
 *   sammy eval <eval.json>    [--datasets-dir ./datasets]
 *                             [--orchestrations-dir ./examples]
 *                             [--agents-dir ./agents]
 *                             [--threshold 1.0] [--limit N] [--json]
 *                             Replay a labeled dataset through its
 *                             orchestration and score every row. Exits 1 when
 *                             the pass rate falls under --threshold — the CI
 *                             gate for "did this orchestration regress?".
 *
 *   sammy replay <orchestration.json> --recording <run.json> [--json]
 *                             Re-execute a recorded run with its captured
 *                             phase outputs replayed and NO model calls, then
 *                             report control-flow divergence. Turns a
 *                             known-good production run into a free, instant
 *                             regression test. Exits 1 on divergence.
 *
 *   sammy mcp                 Run the stdio MCP server (engine embedded;
 *                             shares the web UI's runs.db).
 *
 *   sammy claude [args...]    Launch Claude Code with the sammy-pack plugin
 *                             (exec `claude --plugin-dir <bundled plugin>`).
 *
 *   sammy help
 *
 * Streams events to stdout (token-by-token text by default; one
 * JSON-per-event with `--json`). Exit code 0 on success, 1 on any
 * run-error / validation error.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argv, env, exit, stdout } from 'node:process';
import { runOrchestration } from '../../../src/llm/executor';
import {
  planHasErrors,
  previewOrchestration,
} from '../../../src/llm/preview';
import {
  renderPlanJson,
  renderPlanText,
} from '../../../src/llm/preview-render';
import { streamFnFor, type ProviderId } from '../../../src/llm/providers';
import {
  agentSystemPrompt,
  judgeRequest,
  parseJudgeReply,
  rowPassed,
  scoreDeterministic,
  scorerKey,
  summarize,
  type EvalRowResult,
} from '../../../src/lib/eval-scoring';
import type { Dataset, Eval } from '../../../src/api';
import {
  describeDivergence,
  deriveRecording,
  diffWalk,
  type RecordedEvent,
} from '../../../src/lib/run-replay';
import type { Node } from '../../../src/types';
import { validateOrchestration } from '../../../src/validate';

type Args = {
  command:
    | 'run' | 'validate' | 'preview' | 'eval' | 'replay' | 'mcp' | 'claude' | 'help' | null;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(raw: string[]): Args {
  const out: Args = { command: null, positional: [], flags: {} };
  let i = 0;
  if (raw[i] && !raw[i].startsWith('-')) {
    out.command = raw[i] as Args['command'];
    i += 1;
  }
  for (; i < raw.length; i++) {
    const a = raw[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = raw[i + 1];
        if (next && !next.startsWith('--')) {
          out.flags[a.slice(2)] = next;
          i += 1;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function printHelp(): void {
  stdout.write(
    [
      'sammy — orchestration CLI',
      '',
      'COMMANDS',
      '  sammy run <orchestration.json> [options]   Run an orchestration',
      '  sammy validate <orchestration.json>        Validate without running',
      '  sammy preview <orchestration.json> [opts]  Symbolic dry-run (no side effects)',
      '  sammy eval <eval.json> [--threshold 1.0]   Score a dataset through its orchestration (CI gate)',
      '  sammy replay <orch.json> --recording <run.json>  Re-walk a recorded run with ZERO model calls (CI gate)',
      '  sammy mcp                                  Run the stdio MCP server',
      '  sammy claude [args...]                     Launch Claude Code + plugin',
      '  sammy help                                 This text',
      '',
      'MCP / CLAUDE',
      '  sammy mcp        Embeds the engine, opens the shared runs.db, exposes',
      '                   list_orchestrations / start_run / get_run / cancel_run /',
      '                   resume_run over stdio. Env: SAMMY_REPO_ROOT,',
      '                   SAMMY_ORCH_DIR, SAMMY_RUN_DB, DATABASE_URL.',
      '  sammy claude     exec `claude --plugin-dir <bundled plugin> [args...]`.',
      '                   --print-argv dry-runs (prints the argv, does not exec).',
      '',
      'RUN OPTIONS',
      '  --input "text"            Initial input for the first phase',
      '  --provider <id>           anthropic | openai | gemini  (default: anthropic)',
      '  --model <id>              Override the default model for the provider',
      '  --agents-dir <path>       Directory of agent .md files (default: ./agents)',
      '  --api-key <key>           Override env-var key for the chosen provider',
      '  --quiet                   Only print final phase output, not deltas',
      '  --json                    Print one RunEvent per line (JSON)',
      '',
      'PREVIEW OPTIONS',
      '  --vars k=v,k2=v2          Override / supply top-level vars',
      '  --input "text"            Seed ${input} for the first phase',
      '  --depth N                 Cap subflow / static-map expansion depth',
      '  --json                    Print the PreviewPlan as JSON',
      '  Exit code 1 when any error-severity finding exists (CI gate).',
      '',
      'ENVIRONMENT',
      '  ANTHROPIC_API_KEY  /  OPENAI_API_KEY  /  GEMINI_API_KEY',
      '',
    ].join('\n'),
  );
}

async function loadAgents(
  dir: string,
): Promise<Array<{ name: string; raw: string }>> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; raw: string }> = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    if (f.toLowerCase() === 'readme.md') continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      out.push({ name: f.replace(/\.md$/, ''), raw });
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

async function runCmd(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    console.error('[sammy] usage: sammy run <orchestration.json> [options]');
    return 1;
  }
  const orch = JSON.parse(await fs.readFile(file, 'utf8')) as Node;
  const validation = validateOrchestration(orch);
  const errs = validation.filter(v => v.severity === 'error');
  if (errs.length) {
    console.error('[sammy] orchestration failed validation:');
    for (const e of errs) console.error(`  - ${e.path}: ${e.message}`);
    return 1;
  }

  const provider = (args.flags.provider as ProviderId) || 'anthropic';
  const model =
    (args.flags.model as string) ||
    (provider === 'openai'
      ? 'gpt-4o-mini'
      : provider === 'gemini'
        ? 'gemini-2.0-flash'
        : 'claude-sonnet-4-6');
  const envKey =
    provider === 'openai'
      ? env.OPENAI_API_KEY
      : provider === 'gemini'
        ? env.GEMINI_API_KEY
        : env.ANTHROPIC_API_KEY;
  const apiKey = (args.flags['api-key'] as string) || envKey || '';
  if (!apiKey) {
    console.error(
      `[sammy] no API key for provider "${provider}". Set --api-key or the matching env var.`,
    );
    return 1;
  }

  const fn = streamFnFor(provider, apiKey);
  if (!fn) {
    console.error(
      `[sammy] provider "${provider}" has no built-in adapter (claude-code requires the dev server).`,
    );
    return 1;
  }

  const agentsDir =
    (args.flags['agents-dir'] as string) || path.join(process.cwd(), 'agents');
  const agents = await loadAgents(agentsDir);

  const input = (args.flags.input as string) ?? '';
  const json = Boolean(args.flags.json);
  const quiet = Boolean(args.flags.quiet);

  let exitCode = 0;
  try {
    for await (const ev of runOrchestration({
      orchestration: orch,
      apiKey,
      model,
      streamFn: fn,
      initialInput: input,
      waitForApproval: async () => {
        console.error('[sammy] lock gate hit — auto-approving in CLI mode');
        return true;
      },
      cancelled: { v: false },
      agentsOverride: agents,
      orchestrationsOverride: [orch],
    })) {
      if (json) {
        stdout.write(JSON.stringify(ev) + '\n');
        continue;
      }
      if (ev.type === 'phase-delta' && !quiet) {
        stdout.write(ev.text);
      } else if (ev.type === 'phase-end' && quiet) {
        stdout.write(ev.output + '\n');
      } else if (ev.type === 'phase-end' && !quiet) {
        stdout.write('\n');
      } else if (ev.type === 'phase-start') {
        if (!quiet) console.error(`\n--- ${ev.phaseName} ---`);
      } else if (ev.type === 'run-error') {
        console.error(`[sammy] run-error: ${ev.error}`);
        exitCode = 1;
      } else if (ev.type === 'run-end' && !quiet) {
        console.error('\n[sammy] run-end');
      }
    }
  } catch (err) {
    console.error(`[sammy] ${(err as Error).message}`);
    return 1;
  }
  return exitCode;
}

/**
 * Headless eval: replay a labeled dataset through its orchestration and
 * score every row, then gate on the pass rate.
 *
 * WHY: scoring that lives only in the browser (EvalsPage) leaves an eval
 * suite that can be authored and watched but never ENFORCED — a regression
 * cannot fail a build. This runs the identical scorers from the shared
 * module (`src/lib/eval-scoring.ts`), so the CLI's verdict and the UI's
 * verdict cannot drift.
 */
async function evalCmd(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    console.error('[sammy] usage: sammy eval <eval.json> [--threshold 1.0]');
    return 1;
  }
  const evalSpec = JSON.parse(await fs.readFile(file, 'utf8')) as Eval;
  const baseDir = path.dirname(path.resolve(file));
  const repoDir = path.dirname(baseDir);
  const datasetsDir =
    (args.flags['datasets-dir'] as string) || path.join(repoDir, 'datasets');
  const orchDir =
    (args.flags['orchestrations-dir'] as string) || path.join(repoDir, 'examples');
  const agentsDir =
    (args.flags['agents-dir'] as string) || path.join(repoDir, 'agents');

  let dataset: Dataset;
  let orch: Node;
  try {
    dataset = JSON.parse(
      await fs.readFile(path.join(datasetsDir, `${evalSpec.datasetName}.json`), 'utf8'),
    ) as Dataset;
    orch = JSON.parse(
      await fs.readFile(
        path.join(orchDir, `${evalSpec.orchestrationName}.json`),
        'utf8',
      ),
    ) as Node;
  } catch (err) {
    console.error(`[sammy] could not load eval inputs: ${(err as Error).message}`);
    return 1;
  }

  const provider = (args.flags.provider as ProviderId) || 'anthropic';
  const model = (args.flags.model as string) || 'claude-sonnet-4-6';
  const apiKey =
    (args.flags['api-key'] as string) || env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    console.error('[sammy] no API key — set --api-key or ANTHROPIC_API_KEY.');
    return 1;
  }
  const fn = streamFnFor(provider, apiKey);
  if (!fn) {
    console.error(`[sammy] provider "${provider}" has no built-in adapter.`);
    return 1;
  }
  const agents = await loadAgents(agentsDir);

  const limitFlag = Number(args.flags.limit);
  const cap = Number.isFinite(limitFlag) && limitFlag > 0
    ? limitFlag
    : (evalSpec.sampleSize ?? dataset.rows.length);
  const rows = dataset.rows.slice(0, cap);
  const asJson = Boolean(args.flags.json);
  const thresholdFlag = Number(args.flags.threshold);
  const threshold =
    Number.isFinite(thresholdFlag) && thresholdFlag >= 0 && thresholdFlag <= 1
      ? thresholdFlag
      : 1;

  const results: EvalRowResult[] = [];
  for (const row of rows) {
    const startedAt = Date.now();
    let output = '';
    let error: string | undefined;
    try {
      for await (const ev of runOrchestration({
        orchestration: orch,
        apiKey,
        model,
        streamFn: fn,
        initialInput: row.input,
        // An eval must never block on a human; a gated orchestration under
        // eval is auto-approved exactly like `sammy run` does.
        waitForApproval: async () => true,
        cancelled: { v: false },
        agentsOverride: agents,
        orchestrationsOverride: [orch],
      })) {
        if (ev.type === 'phase-end') output = ev.output;
        else if (ev.type === 'run-error') error = ev.error;
      }
    } catch (err) {
      error = (err as Error).message;
    }

    const scores = scoreDeterministic(output, row.expectedOutput, evalSpec.scorers);
    // llm-judge scorers need a model round-trip; the prompt + parsing come
    // from the shared module so the judge is asked the same question here
    // as in the UI. A judge that errors or whose agent is missing scores 0
    // (block-on-error rather than silently skip).
    for (let i = 0; i < evalSpec.scorers.length; i++) {
      const sc = evalSpec.scorers[i];
      if (sc.type !== 'llm-judge') continue;
      const key = scorerKey(sc, i);
      const agentName = sc.judgeAgent.replace(/^agents\//, '').replace(/\.md$/, '');
      const agent = agents.find(a => a.name === agentName);
      if (!agent) {
        scores[key] = 0;
        continue;
      }
      const { system, user } = judgeRequest(
        sc,
        agentSystemPrompt(agent.raw),
        output,
        row.expectedOutput,
      );
      let reply = '';
      try {
        for await (const ev of fn({
          apiKey,
          model,
          system,
          messages: [{ role: 'user', content: user }],
        })) {
          if (ev.type === 'text-delta') reply += ev.text;
        }
        scores[key] = parseJudgeReply(reply);
      } catch {
        scores[key] = 0;
      }
    }

    const result: EvalRowResult = {
      rowId: row.id,
      pass: error ? false : rowPassed(scores),
      scores,
      output,
      expectedOutput: row.expectedOutput,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    };
    results.push(result);
    if (!asJson) {
      console.error(
        `  ${result.pass ? 'PASS' : 'FAIL'}  ${row.id}` +
          (error ? `  (error: ${error})` : ''),
      );
    }
  }

  const summary = summarize(results);
  if (asJson) {
    stdout.write(
      JSON.stringify({ eval: evalSpec.name, threshold, summary, rows: results }, null, 2) +
        '\n',
    );
  } else {
    console.error(
      `\n[sammy] ${evalSpec.name}: ${summary.passed}/${summary.total} passed ` +
        `(${(summary.passRate * 100).toFixed(1)}%, threshold ${(threshold * 100).toFixed(1)}%)`,
    );
    for (const [key, mean] of Object.entries(summary.byScorer)) {
      console.error(`         ${key}: mean ${mean.toFixed(3)}`);
    }
  }
  return summary.passRate + 1e-9 >= threshold ? 0 : 1;
}

/**
 * Deterministic replay: re-walk an orchestration using a recorded run's
 * captured leaf outputs, with model dispatch DISABLED, and report
 * control-flow divergence.
 *
 * What it catches that nothing else does cheaply: an edit to a `when`
 * predicate, a `switch` case, a `route` branch key or a loop stop condition
 * silently sends the tree down a different path. A live run would cost
 * money and minutes to discover that; this costs neither, because every
 * leaf's output comes from the recording and the stream fn is wired to
 * THROW if the walk ever needs a real agent call.
 */
async function replayCmd(args: Args): Promise<number> {
  const file = args.positional[0];
  const recordingPath = args.flags.recording as string | undefined;
  if (!file || !recordingPath) {
    console.error(
      '[sammy] usage: sammy replay <orchestration.json> --recording <run.json>',
    );
    return 1;
  }
  const orch = JSON.parse(await fs.readFile(file, 'utf8')) as Node;
  const raw = JSON.parse(await fs.readFile(recordingPath, 'utf8')) as
    | { events?: RecordedEvent[] }
    | RecordedEvent[];
  // Accept either a GET /api/runs/:id body or a bare events array.
  const events: RecordedEvent[] = Array.isArray(raw) ? raw : (raw.events ?? []);
  if (events.length === 0) {
    console.error('[sammy] recording has no events — nothing to replay.');
    return 1;
  }
  const recording = deriveRecording(events);
  if (recording.order.length === 0) {
    console.error('[sammy] recording has no completed leaves — nothing to replay.');
    return 1;
  }

  const agentsDir =
    (args.flags['agents-dir'] as string) || path.join(process.cwd(), 'agents');
  const agents = await loadAgents(agentsDir);
  const initialInput =
    (args.flags.input as string) ??
    (Array.isArray(raw) ? '' : ((raw as { initialInput?: string }).initialInput ?? ''));

  // Any real dispatch means the walk went somewhere the recording cannot
  // answer. Throwing names the phase instead of silently calling a model.
  const forbidden = () => {
    throw new Error(
      'replay attempted a real model call — the walk reached a leaf with no ' +
        'recorded output (see MISSING below)',
    );
  };

  const walked: string[] = [];
  let runError: string | undefined;
  try {
    for await (const ev of runOrchestration({
      orchestration: orch,
      apiKey: 'replay-no-key',
      model: 'replay',
      streamFn: forbidden as never,
      initialInput,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: agents,
      orchestrationsOverride: [orch],
      replayOutputs: recording.outputs,
    })) {
      if (ev.type === 'phase-end') {
        walked.push(ev.replayKey ?? ev.phaseName);
      } else if (ev.type === 'run-error') {
        runError = ev.error;
      }
    }
  } catch (err) {
    runError = (err as Error).message;
  }

  const divergence = diffWalk(recording, walked);
  const faithful =
    !runError &&
    divergence.missing.length === 0 &&
    divergence.unused.length === 0 &&
    !divergence.reordered;

  if (args.flags.json) {
    stdout.write(
      JSON.stringify(
        { orchestration: orch.name, faithful, walked, ...divergence, error: runError },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.error(
      `[sammy] replay ${orch.name}: ${walked.length} leaf/leaves re-walked ` +
        `against ${recording.order.length} recorded`,
    );
    for (const line of describeDivergence(divergence)) console.error(line);
    if (runError) console.error(`  ERROR    ${runError}`);
    console.error(
      faithful
        ? '[sammy] FAITHFUL — control flow matches the recorded run'
        : '[sammy] DIVERGED — this orchestration no longer walks like the recording',
    );
  }
  return faithful ? 0 : 1;
}

async function validateCmd(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    console.error('[sammy] usage: sammy validate <orchestration.json>');
    return 1;
  }
  const orch = JSON.parse(await fs.readFile(file, 'utf8')) as Node;
  const errs = validateOrchestration(orch);
  if (errs.length === 0) {
    console.log('[sammy] OK — no validation errors');
    return 0;
  }
  for (const e of errs) {
    console.error(`[${e.severity}] ${e.path}: ${e.message}`);
  }
  return errs.some(e => e.severity === 'error') ? 1 : 0;
}

/** Parse a `--vars k=v,k2=v2` spec (commas split pairs). Mirrors the in-repo
 *  `sammy-cli preview` flag format so the two surfaces accept the same spec. */
function parseVarsSpec(spec: string | boolean | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof spec !== 'string') return out;
  for (const pair of spec.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Symbolic dry-run: resolve the plan the executor WOULD run — every command,
 *  value, branch — with no side effects, and flag structural incoherence.
 *  Sibling .json files in the orchestration's own directory are loaded (best-
 *  effort) so `subflow` references expand; a parse failure is skipped, and a
 *  name collision keeps the first file read (matching the in-repo CLI). */
async function previewCmd(args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) {
    console.error(
      '[sammy] usage: sammy preview <orchestration.json> ' +
        '[--vars k=v,…] [--input "text"] [--depth N] [--json]',
    );
    return 1;
  }
  let orch: Node;
  try {
    orch = JSON.parse(await fs.readFile(file, 'utf8')) as Node;
  } catch (err) {
    console.error(`[sammy] could not read ${file}: ${(err as Error).message}`);
    return 1;
  }

  const byName = new Map<string, Node>();
  const dir = path.dirname(path.resolve(file));
  let siblings: string[] = [];
  try {
    siblings = await fs.readdir(dir);
  } catch {
    /* no sibling context — subflows render symbolically */
  }
  for (const f of siblings) {
    if (!f.endsWith('.json')) continue;
    try {
      const node = JSON.parse(
        await fs.readFile(path.join(dir, f), 'utf8'),
      ) as Node;
      if (node && typeof node.name === 'string' && !byName.has(node.name)) {
        byName.set(node.name, node);
      }
    } catch {
      /* skip unparsable sibling */
    }
  }

  const depthRaw = args.flags.depth;
  const depth =
    typeof depthRaw === 'string' ? Number.parseInt(depthRaw, 10) : undefined;
  const plan = previewOrchestration(orch, {
    vars: parseVarsSpec(args.flags.vars),
    initialInput:
      typeof args.flags.input === 'string' ? args.flags.input : undefined,
    maxDepth: depth != null && Number.isFinite(depth) ? depth : undefined,
    orchestrationByName: byName,
  });
  stdout.write(
    (args.flags.json ? renderPlanJson(plan) : renderPlanText(plan)) + '\n',
  );
  // Exit 1 on any error-level finding so CI can gate; warnings don't fail.
  return planHasErrors(plan) ? 1 : 0;
}

/** Run the stdio MCP server. Imported lazily so `sammy run` / `validate`
 *  don't pay the cost of loading the MCP SDK + Agent SDK glue. */
async function mcpCmd(): Promise<number> {
  const { runMcpServer } = await import('./mcp');
  await runMcpServer();
  // runMcpServer never resolves while the stdio transport is connected;
  // it returns only if the transport closes. Keep the process alive.
  return 0;
}

/** Resolve the bundled plugin directory. It ships at <cliPkg>/plugin —
 *  alongside src/ and bin/ — so it resolves both in-repo (dev) and after
 *  a global/npm install of @sammy-pack/cli. */
function resolvePluginDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // …/packages/cli/src
  return path.resolve(here, '..', 'plugin');
}

/** Launch Claude Code with the sammy-pack plugin loaded.
 *  `sammy claude [...]` → exec `claude --plugin-dir <pluginDir> [...]`.
 *  `--print-argv` (or SAMMY_DRY_RUN=1) prints the argv instead of exec'ing,
 *  so the dispatch is testable without Claude Code installed. */
async function claudeCmd(passthrough: string[]): Promise<number> {
  const pluginDir = resolvePluginDir();
  const dryRunFlag = passthrough.includes('--print-argv');
  const rest = passthrough.filter(a => a !== '--print-argv');
  const claudeArgs = ['--plugin-dir', pluginDir, ...rest];

  if (dryRunFlag || env.SAMMY_DRY_RUN === '1') {
    stdout.write(`claude ${claudeArgs.join(' ')}\n`);
    return 0;
  }

  return await new Promise<number>(resolve => {
    const child = spawn('claude', claudeArgs, { stdio: 'inherit' });
    child.on('error', err => {
      console.error(
        `[sammy] could not launch \`claude\`: ${(err as Error).message}. ` +
          'Is Claude Code installed and on PATH?',
      );
      resolve(127);
    });
    child.on('exit', code => resolve(code ?? 0));
  });
}

async function main(): Promise<void> {
  const raw = argv.slice(2);
  // `claude` passes everything after the verb straight through to Claude
  // Code (it has its own flags), so it bypasses parseArgs entirely.
  if (raw[0] === 'claude') {
    exit(await claudeCmd(raw.slice(1)));
  }
  // `mcp` runs the long-lived stdio server. It owns the process: it never
  // resolves while the transport is connected, so there's no exit() to wrap.
  // Calling it on the synchronous boot path (rather than buried under the
  // exit(await …) ladder) keeps stdin/stdout wiring deterministic for the
  // JSON-RPC channel.
  if (raw[0] === 'mcp') {
    await mcpCmd();
    return;
  }
  const args = parseArgs(raw);
  if (!args.command || args.command === 'help') {
    printHelp();
    exit(0);
  }
  if (args.command === 'run') exit(await runCmd(args));
  if (args.command === 'validate') exit(await validateCmd(args));
  if (args.command === 'preview') exit(await previewCmd(args));
  if (args.command === 'eval') exit(await evalCmd(args));
  if (args.command === 'replay') exit(await replayCmd(args));
  console.error(`[sammy] unknown command: ${args.command}`);
  exit(1);
}

main().catch(err => {
  console.error(`[sammy] crashed: ${(err as Error).stack ?? err}`);
  exit(1);
});
