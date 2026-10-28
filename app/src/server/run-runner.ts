/**
 * run-runner — the server-side run-creation engine, extracted from the Vite
 * plugin (executor-in-worker, step 2) so the standalone
 * worker can EXECUTE runs in-process instead of delegating run creation back to
 * the server over HTTP.
 *
 * `createRunRunner({ root })` derives the workspace paths and returns the same
 * functions the plugin used to define inline — moved here verbatim:
 *   - buildExecutorSource: builds the run-controller's event source (the
 *     executor) for an orchestration context.
 *   - loadMcpRegistry / loadHooksRegistry / expandConnectionRefsInMcpConfig /
 *     buildHookCallback: the MCP + hooks + connection-ref resolution the
 *     server-side StreamFn needs (also used by the plugin's /api/llm/stream +
 *     /api/mcp-servers handlers).
 *
 * The plugin destructures these back into identically-named consts, so its
 * existing call sites are unchanged.
 */

import { checkDeniedCommand } from './sandbox-policy';
import { ensureWorktrees } from './worktrees';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  readCredentialsByNameRaw,
  registrySecretValues,
  readCredentialsByNameSync,
  resolveCredentialsFile,
  resolveProviderKeysSync,
} from './credentials-store';
import { scrubEvent } from './scrub-secrets';
import {
  collectConnectionSecretsDeep,
  resolveConnectionRefsDeep,
} from '../llm/interpolate';
import { buildProviderRegistry } from '../llm/providers';
import {
  RunPauseRequested,
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../llm/executor';
import { streamSdk } from './sdk-stream';
import { buildHarnessMcpServer, harnessControlFor, harnessToolGateHook, skillInstalled } from './harness-session';
import { HARNESS_TOOL_SERVER, resolveFollow, type ResolvedFollow } from '../llm/harness';
import { harnessSettingsFile, readHarnessSettingsSync } from './harness-settings';
import type { RunContext } from './run-context';

/** Wrap a run's event stream in a secret-scrubbing pass. Redacts known
 *  token patterns + the run's active injected-secret literals from the
 *  text-bearing fields of each event, leaving structural fields
 *  (phaseName, key, toolName, branch, …) untouched. `injectedSecrets` is
 *  read live per-event — a secret resolved by a later phase still scrubs
 *  earlier-arriving text the SDK buffers (cheap; the Set is tiny).
 *
 *  This is the single chokepoint every event passes through before the
 *  run-controller persists + broadcasts it, so it's the "scrub before
 *  appendEvent" hook the security invariant requires. */
async function* scrubEventStream(
  source: AsyncIterable<RunEvent>,
  injectedSecrets: Set<string>,
): AsyncIterable<RunEvent> {
  for await (const ev of source) {
    yield scrubEvent(ev, injectedSecrets);
  }
}


export type ExecutorSourceOpts = {
  initialInput?: string;
  model?: string;
  allowAgentTools?: boolean;
  replayOutputs?: Record<string, string>;
  autoApproveLocks?: string[];
  /** Human gate corrections (phase name → free-text), seeded when a
   *  paused lock gate is approved with a message. The named phase's
   *  agent receives it appended to its input. */
  gateMessages?: Record<string, string>;
  /** Owner of the run; scopes per-credential `owners` allowlists. */
  ownerId?: string;
  /** Resolved run inputs (name → content) seeded into state as ${name}. */
  resolvedInputs?: Record<string, string>;
  /** Owning run id, threaded onto each leaf's concurrency-queue waiter so
   *  the Queue view can attribute a blocked dispatch to its run. */
  runId?: string;
  /** Durable-wait seed for a RESUMED leg (see server/wait-resolution.ts):
   *  unresolved `wait` specs keyed by replayKey + buffered unconsumed signal
   *  payloads. Fresh runs omit both. */
  pendingWaits?: Record<string, import('../llm/executor').PendingWaitSpec>;
  deliveredSignals?: Record<string, string[]>;
  /** `artifact` events to carry into this run (a fork's replayed leaves). */
  seedArtifacts?: Array<Extract<RunEvent, { type: 'artifact' }>>;
  /** Harness strictness the start path resolved (Run dialog > orchestration
   *  > Settings > strict) and where it came from. A resumed leg omits it and
   *  the executor reads the snapshot's `harness.follow`. */
  harnessFollow?: ResolvedFollow;
};

/** Parse SAMMY_MAX_AGENT_TOKENS into a per-agent token ceiling. Accepts a
 *  plain integer (e.g. "30000000") or underscore/comma-grouped digits for
 *  readability (e.g. "30_000_000" / "30,000,000"). Returns undefined for an
 *  unset / blank / non-numeric value so the caller falls through to the next
 *  precedence tier (streamSdk's built-in default). `0` is honored — it
 *  disables the breaker run-wide. */
function parseMaxAgentTokensEnv(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.trim().replace(/[_,]/g, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/** Parse SAMMY_ALLOWED_MCP_TOOLS — a comma / whitespace separated list of tool
 *  ids to PRE-APPROVE run-wide for headless runs (so a permission-gated MCP
 *  write tool never stalls on a human "Allow"). Mirrors the SAMMY_ALLOW_CODE_RUN
 *  opt-in pattern. Blank / unset → []. */
export function parseAllowedMcpToolsEnv(raw: string | undefined): string[] {
  if (raw == null) return [];
  return raw
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Whether headless fail-fast on a tool permission prompt is enabled
 *  (SAMMY_HEADLESS_TOOL_DENY=1/true). Off by default so behavior is unchanged
 *  unless the operator opts in — then a non-pre-approved permission-gated tool
 *  fails the phase fast (with an `awaiting-approval` event) instead of stalling
 *  the whole run waiting for an "Allow" no one is present to give. */
export function headlessToolDenyEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** Read the latest `artifact` event with this name from a stored run. */
export type ArtifactLoader = (
  runId: string,
  name: string,
) => Promise<{ text: string; mediaType: string; dropped?: boolean } | undefined>;

/** The loader both the server and the worker hand to createRunRunner. */
export function artifactLoaderFor(store: {
  getRun(id: string): Promise<{ events: unknown[] } | null>;
}): ArtifactLoader {
  return async (runId, name) => {
    const run = await store.getRun(runId);
    const hit = [...((run?.events ?? []) as Array<Record<string, unknown>>)]
      .reverse()
      .find(e => e.type === 'artifact' && e.name === name);
    return hit
      ? {
          text: String(hit.content ?? ''),
          mediaType: String(hit.mediaType ?? 'text/plain'),
          ...(hit.dropped === true ? { dropped: true } : {}),
        }
      : undefined;
  };
}

export function createRunRunner(opts: { root: string; loadArtifact?: ArtifactLoader }) {
  const runnerOpts = opts;
  const { root } = opts;
  const credentialsFile = resolveCredentialsFile(root);
  const mcpRegistryFile = path.join(root, 'mcp', 'servers.json');
  const hooksRegistryFile = path.join(root, 'hooks', 'hooks.json');

  async function readJsonFile(file: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // Load the workspace MCP registry. Returns {} if the file doesn't exist.
  async function loadMcpRegistry(): Promise<Record<string, unknown>> {
    const parsed = await readJsonFile(mcpRegistryFile);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  }

  // Resolve `${connections:<name>.<field>}` placeholders inside an MCP server
  // config (env / command / url / headers — deeply). Per-credential owners /
  // orchestrations scoping is honored: unmatched entries don't resolve.
  //
  // SECURITY: when `collectSecretsInto` is passed, every secret-bearing ref
  // the config resolved (a credential `value` / `env.*` / `cache.*` token) is
  // also recorded into that Set, so the run's scrubber can redact those exact
  // literals if an MCP subprocess echoes one back into its output. This closes
  // the residual MCP-env leak surface — resolution and collection read the
  // SAME scoped connections map, so a secret the agent can't resolve (failed
  // owners/orchestrations scoping) is never collected either.
  function expandConnectionRefsInMcpConfig(
    config: unknown,
    opts?: {
      ownerId?: string;
      orchestrationName?: string;
      collectSecretsInto?: Set<string>;
    },
  ): unknown {
    if (!config || typeof config !== 'object') return config;
    const connections = readCredentialsByNameRaw(credentialsFile, opts);
    if (opts?.collectSecretsInto) {
      collectConnectionSecretsDeep(config, connections, opts.collectSecretsInto);
    }
    return resolveConnectionRefsDeep(config, connections);
  }

  type HookSpec = {
    event: string;
    matcher?: string;
    command: string;
    args?: string[];
    timeoutSeconds?: number;
  };
  async function loadHooksRegistry(): Promise<Record<string, HookSpec>> {
    const parsed = await readJsonFile(hooksRegistryFile);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, HookSpec>;
    }
    return {};
  }

  /** Build a HookCallback from a registry entry — spawns the shell command,
   *  writes the hook input as JSON to stdin, parses stdout as the SDK's
   *  HookJSONOutput. Empty/non-JSON → allow; non-zero exit → block. */
  function buildHookCallback(
    spec: HookSpec,
  ): (input: unknown, toolUseId: string | undefined) => Promise<unknown> {
    return async (input, toolUseId) => {
      return new Promise(resolve => {
        const proc = spawn(spec.command, spec.args ?? [], {
          shell: !spec.args,
        });
        let stdout = '';
        let stderr = '';
        const timeoutHandle = setTimeout(
          () => {
            proc.kill('SIGTERM');
            resolve({
              continue: false,
              decision: 'block',
              reason: `hook timed out after ${spec.timeoutSeconds ?? 30}s`,
            });
          },
          (spec.timeoutSeconds ?? 30) * 1000,
        );
        proc.stdout.on('data', d => (stdout += d.toString()));
        proc.stderr.on('data', d => (stderr += d.toString()));
        proc.on('close', code => {
          clearTimeout(timeoutHandle);
          if (code !== 0) {
            resolve({
              continue: false,
              decision: 'block',
              reason: `hook exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
            });
            return;
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            resolve({ continue: true });
            return;
          }
          try {
            resolve(JSON.parse(trimmed));
          } catch {
            resolve({ continue: true, systemMessage: trimmed.slice(0, 200) });
          }
        });
        try {
          proc.stdin.write(JSON.stringify({ input, toolUseId }));
          proc.stdin.end();
        } catch {
          // pipe closed early; ignore — proc.on('close') will fire.
        }
      });
    };
  }

  function buildServerStreamFn(
    abortController: AbortController,
    /** Run-scoped secret sink. MCP-config secrets resolved below are added
     *  here so the scrubber redacts them from any output an MCP subprocess
     *  echoes back (the residual MCP-env leak surface). */
    injectedSecrets?: Set<string>,
    /** Owner / orchestration scoping so MCP connection-ref resolution (and
     *  the matching secret collection) honors per-credential allowlists. */
    credScope?: { ownerId?: string; orchestrationName?: string },
  ): StreamFn {
    return async function* serverStream(params) {
      const requestedMcp = Array.isArray(params.mcp) ? params.mcp : [];
      let mcpServers:
        | Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>
        | undefined;
      if (requestedMcp.length > 0) {
        const registry = await loadMcpRegistry();
        const expanded: Record<string, unknown> = {};
        for (const name of requestedMcp) {
          const config = registry[name];
          if (config) {
            expanded[name] = expandConnectionRefsInMcpConfig(config, {
              ...credScope,
              collectSecretsInto: injectedSecrets,
            });
          }
        }
        if (Object.keys(expanded).length > 0) {
          mcpServers = expanded as Record<
            string,
            import('@anthropic-ai/claude-agent-sdk').McpServerConfig
          >;
        }
      }
      const requestedHooks = Array.isArray(params.hooks) ? params.hooks : [];
      let hooksOption:
        | Partial<
            Record<
              import('@anthropic-ai/claude-agent-sdk').HookEvent,
              import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher[]
            >
          >
        | undefined;
      if (requestedHooks.length > 0) {
        const registry = await loadHooksRegistry();
        const grouped: Record<
          string,
          Array<{
            matcher?: string;
            hooks: Array<(...a: unknown[]) => Promise<unknown>>;
          }>
        > = {};
        for (const name of requestedHooks) {
          const spec = registry[name];
          if (!spec) continue;
          const callback = buildHookCallback(spec);
          (grouped[spec.event] ??= []).push({
            matcher: spec.matcher,
            hooks: [callback as (...a: unknown[]) => Promise<unknown>],
          });
        }
        if (Object.keys(grouped).length > 0) {
          hooksOption = grouped as typeof hooksOption;
        }
      }
      // The phase sandbox's denied commands: refuse the ONE matching Bash
      // call before it runs and tell the agent why, so it can take another
      // way — rather than failing the whole phase after the fact (the
      // executor's backstop then only records the refusal).
      const denied = Array.isArray(params.deniedCommands) ? params.deniedCommands : [];
      if (denied.length > 0) {
        const refuse = async (input: unknown) => {
          const cmd = (input as { tool_input?: { command?: unknown } })?.tool_input?.command;
          const hit = typeof cmd === 'string' ? checkDeniedCommand(cmd, { deniedCommands: denied }) : null;
          if (!hit) return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `This run's sandbox refuses commands containing "${hit}". ` +
                'Do the task another way, or say why it cannot be done without it.',
            },
          };
        };
        hooksOption = {
          ...(hooksOption ?? {}),
          PreToolUse: [
            ...((hooksOption?.PreToolUse as unknown[] | undefined) ?? []),
            { matcher: 'Bash', hooks: [refuse] },
          ],
        } as typeof hooksOption;
      }
      // Harness session: the executor's step tools as an in-process MCP
      // server, and its per-step tool gate as a PreToolUse hook on every tool.
      if (params.harness) {
        mcpServers = {
          ...(mcpServers ?? {}),
          [HARNESS_TOOL_SERVER]: await buildHarnessMcpServer(params.harness.tools),
        };
        if (params.harness.toolGate) {
          hooksOption = {
            ...(hooksOption ?? {}),
            PreToolUse: [
              ...((hooksOption?.PreToolUse as unknown[] | undefined) ?? []),
              harnessToolGateHook(params.harness.toolGate),
            ],
          } as typeof hooksOption;
        }
      }
      const userMessage = params.messages[0]?.content ?? '';
      // Per-agent token ceiling precedence: per-phase node field
      // (params.maxAgentTokens, threaded from the executor) > env var
      // (SAMMY_MAX_AGENT_TOKENS) > streamSdk's built-in default. When neither
      // the node field nor the env var is set we leave it undefined so
      // streamSdk applies its own default — keeping the default in one place.
      const envMaxAgentTokens = parseMaxAgentTokensEnv(
        process.env.SAMMY_MAX_AGENT_TOKENS,
      );
      const maxAgentTokens = params.maxAgentTokens ?? envMaxAgentTokens;
      // Headless tool pre-approval: the phase's own `autoApproveTools` (threaded
      // via params) ∪ the run-wide SAMMY_ALLOWED_MCP_TOOLS env. With the
      // fail-fast switch (SAMMY_HEADLESS_TOOL_DENY) a permission-gated tool that
      // ISN'T pre-approved fails the phase fast instead of stalling the
      // unattended run on an "Allow" no one can give.
      const autoApproveTools = [
        ...(Array.isArray(params.autoApproveTools) ? params.autoApproveTools : []),
        ...parseAllowedMcpToolsEnv(process.env.SAMMY_ALLOWED_MCP_TOOLS),
      ];
      const failOnToolPrompt = headlessToolDenyEnabled(
        process.env.SAMMY_HEADLESS_TOOL_DENY,
      );
      yield* streamSdk({
        userMessage,
        systemPrompt: params.system,
        model: params.model,
        maxTurns: params.maxTurns,
        abortController,
        tools: params.tools,
        permissionMode: params.permissionMode,
        ...(autoApproveTools.length > 0 ? { autoApproveTools } : {}),
        ...(failOnToolPrompt ? { failOnToolPrompt } : {}),
        subagents: params.subagents,
        mcpServers,
        effort: params.effort,
        maxThinkingTokens: params.maxThinkingTokens,
        ...(maxAgentTokens !== undefined ? { maxAgentTokens } : {}),
        hooks: hooksOption,
        // Per-phase credential env injection. The executor resolved the
        // phase's `credential`/`credentials` into a {VAR: secret} map and
        // threaded it here. sdk-stream merges it over process.env for the
        // spawned agent subprocess only — the secret never touches the
        // prompt, context, or event log.
        ...(params.env && Object.keys(params.env).length > 0
          ? { env: params.env }
          : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.harness?.resume
          ? { resume: params.harness.resume }
          : params.harness?.sessionId
            ? { sessionId: params.harness.sessionId }
            : {}),
        ...(params.harness?.skills ? { skills: params.harness.skills } : {}),
      });
    };
  }

  /** Build the run-controller's event source: given the orchestration context
   *  + abort signal + skip-replay inputs, returns the AsyncIterable of events
   *  the executor produces. */
  function buildExecutorSource(
    ctx: RunContext,
    opts: ExecutorSourceOpts,
    signal: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const c = new AbortController();
    signal.addEventListener('abort', () => c.abort());
    const credFallback = resolveProviderKeysSync(credentialsFile);
    // Bedrock creds: standard AWS_* env (assembled to the JSON the adapter
    // wants) wins, else a `bedrock` entry in credentials.json.
    const awsEnv =
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION
        ? JSON.stringify({
            region: process.env.AWS_REGION,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            ...(process.env.AWS_SESSION_TOKEN
              ? { sessionToken: process.env.AWS_SESSION_TOKEN }
              : {}),
          })
        : '';
    const providerStreamFns = buildProviderRegistry({
      openai: process.env.OPENAI_API_KEY || credFallback.openai || '',
      gemini: process.env.GEMINI_API_KEY || credFallback.gemini || '',
      anthropic: process.env.ANTHROPIC_API_KEY || credFallback.anthropic || '',
      bedrock: awsEnv || credFallback.bedrock || '',
    });

    const credScope = {
      ownerId: opts.ownerId,
      orchestrationName:
        typeof ctx.orchestration.name === 'string'
          ? ctx.orchestration.name
          : undefined,
    };
    // Run-scoped sink of every plaintext secret injected into an agent
    // subprocess this run. The executor adds to it as each phase resolves
    // its credential(s); the scrubbing wrapper below reads it to redact
    // those literals from event text before they're persisted — so even a
    // custom-format token an agent echoes back is caught.
    // Seeded with EVERY registry secret, not only the ones this run will be
    // given: a `code.run` test that prints its environment or reads the
    // credentials file must not get one into an artifact, a log or a ticket.
    const injectedSecrets = new Set<string>(registrySecretValues(credentialsFile));

    // A harness run that didn't come through the start path (a trigger, a
    // fork, a resumed leg whose snapshot predates the start path baking it
    // in) still honors the workspace default.
    const harnessFollow: ResolvedFollow | undefined =
      ctx.orchestration.execution !== 'harness'
        ? undefined
        : (opts.harnessFollow ??
          resolveFollow({
            declared: ctx.orchestration.harness?.follow,
            locked: ctx.orchestration.harness?.lockFollow,
            workspaceDefault: readHarnessSettingsSync(harnessSettingsFile(root)).follow ?? undefined,
          }));

    const run = (
      worktrees?: Awaited<ReturnType<typeof ensureWorktrees>>,
    ): AsyncIterable<RunEvent> => runOrchestration({
      orchestration: ctx.orchestration,
      apiKey: '',
      model: opts.model ?? 'claude-sonnet-4-6',
      initialInput: opts.initialInput,
      // Thread the run's secret sink + cred scope so MCP-config secrets get
      // collected for scrubbing (and resolved under the same allowlists).
      streamFn: buildServerStreamFn(c, injectedSecrets, credScope),
      // That stream refuses a sandbox-denied Bash command itself (PreToolUse).
      enforcesDeniedCommands: true,
      // ...and hosts harness sessions (in-process step tools, resume, skills).
      harnessSupported: true,
      ...(harnessFollow ? { harnessFollow } : {}),
      // A harness agent with no worktree works in the workspace root, where
      // its project skills live and where `claude --resume` finds the session.
      harnessCwd: root,
      // The run's handle for a person taking it over in a terminal.
      ...(harnessFollow && opts.runId ? { harnessControl: harnessControlFor(opts.runId) } : {}),
      skillExists: (name: string) =>
        skillInstalled(name, worktrees && worktrees.length === 1 ? worktrees[0].path : root),
      providerStreamFns,
      credentialsByName: readCredentialsByNameSync(credentialsFile, credScope),
      // Full entries (kind + fields) so a phase's `credential`/`credentials`
      // can be projected onto subprocess env vars by kind.
      credentialsRaw: readCredentialsByNameRaw(credentialsFile, credScope),
      injectedSecrets,
      waitForApproval: async (phaseName: string) => {
        throw new RunPauseRequested(phaseName);
      },
      cancelled: { v: false },
      allowAgentTools: opts.allowAgentTools === true,
      agentsOverride: ctx.agents,
      orchestrationsOverride: ctx.orchestrations,
      replayOutputs: opts.replayOutputs,
      autoApproveLocks: opts.autoApproveLocks,
      gateMessages: opts.gateMessages,
      resolvedInputs: opts.resolvedInputs,
      runId: opts.runId,
      pendingWaits: opts.pendingWaits,
      deliveredSignals: opts.deliveredSignals,
      // Server-owned runs park `wait` leaves DURABLY (snapshot + pause at
      // zero cost, resumed by the wait sweeper / signal endpoint) — the same
      // pause seam waitForApproval uses for lock gates.
      durableWaits: true,
      worktrees,
      seedArtifacts: opts.seedArtifacts,
      // An artifact an earlier leg of THIS run recorded (an upload after a
      // gate), read back from the store.
      ...(opts.runId && runnerOpts.loadArtifact
        ? { loadArtifact: (name: string) => runnerOpts.loadArtifact!(opts.runId!, name) }
        : {}),
    });

    // Root `worktrees`: check each out BEFORE the executor starts (or find
    // the ones an earlier leg of this run made). A failure here fails the run
    // with git's own message rather than letting agents loose in the wrong
    // tree. Cleanup happens at the run's terminal (cleanupWorktrees).
    const decls = ctx.orchestration.worktrees;
    const source: AsyncIterable<RunEvent> =
      Array.isArray(decls) && decls.length > 0
        ? (async function* () {
            if (!opts.runId) {
              throw new Error('worktrees need a server-owned run (no run id was assigned)');
            }
            const wts = await ensureWorktrees(decls, {
              root,
              runId: opts.runId,
              orchestration: String(ctx.orchestration.name),
              initialInput: opts.initialInput ?? '',
              mustExist: Object.keys(opts.replayOutputs ?? {}).length > 0,
              vars: {
                ...((ctx.orchestration.vars as Record<string, unknown> | undefined) ?? {}),
                ...(opts.resolvedInputs ?? {}),
              },
            });
            yield* run(wts);
          })()
        : run();

    // Central scrubbing chokepoint. EVERY run event passes through here on
    // its way to the run-controller's appendEvent + SSE broadcast, and the
    // `injectedSecrets` Set is in scope — so this is exactly the "scrub
    // before append" hook. It redacts known token patterns plus the run's
    // active injected secret literals from event text fields, so a secret
    // an agent echoes into stdout never reaches the durable store, the
    // /runs UI, or any API response. Pure pass-through otherwise.
    return scrubEventStream(source, injectedSecrets);
  }

  return {
    buildExecutorSource,
    loadMcpRegistry,
    loadHooksRegistry,
    expandConnectionRefsInMcpConfig,
    buildHookCallback,
  };
}
