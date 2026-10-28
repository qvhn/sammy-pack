/**
 * Harness mode — the server half: hosts the executor's step tools for the
 * harness agent's SDK session.
 *
 *  - the step tools (start_step, complete_step, run_step, …) become an
 *    in-process MCP server, so a tool call runs inside the run's executor
 *    with its state and events;
 *  - the executor's per-step tool gate becomes a PreToolUse hook that refuses
 *    any tool the active step doesn't allow, telling the agent why;
 *  - a step's `skill` is checked against the skills installed where the agent
 *    runs, before the run starts.
 *
 * Server-only (node:fs, the SDK).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookCallbackMatcher, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { HARNESS_TOOL_SERVER, type HarnessStreamOptions } from '../llm/harness';

/** The step tools as an in-process MCP server named `sammy` — the agent sees
 *  them as `mcp__sammy__<tool>`. */
export async function buildHarnessMcpServer(
  tools: HarnessStreamOptions['tools'],
): Promise<McpServerConfig> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  return sdk.createSdkMcpServer({
    name: HARNESS_TOOL_SERVER,
    version: '1.0.0',
    tools: tools.map(t => {
      const shape: Record<string, unknown> = {};
      for (const [name, description] of Object.entries(t.params)) {
        const optional = name.endsWith('?');
        const key = optional ? name.slice(0, -1) : name;
        shape[key] = optional ? z.string().optional().describe(description) : z.string().describe(description);
      }
      return sdk.tool(t.name, t.description, shape as Parameters<typeof sdk.tool>[2], async args => {
        const res = await t.handler(args as Record<string, string | undefined>);
        return {
          content: [{ type: 'text' as const, text: res.text }],
          ...(res.isError ? { isError: true } : {}),
        };
      });
    }),
  });
}

/** The executor's tool gate as a PreToolUse hook on every tool. */
export function harnessToolGateHook(
  gate: NonNullable<HarnessStreamOptions['toolGate']>,
): HookCallbackMatcher {
  return {
    hooks: [
      async (input: unknown) => {
        const i = input as { tool_name?: unknown; tool_input?: unknown };
        const reason = typeof i?.tool_name === 'string' ? gate(i.tool_name, i.tool_input) : null;
        if (!reason) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: reason,
          },
        };
      },
    ],
  };
}

/** Where Claude Code looks for a skill named `name` when it runs in `cwd`:
 *  the project's `.claude/skills/<name>/SKILL.md`, then the user's. A
 *  plugin-qualified name (`plugin:skill`) is resolved by the plugin system,
 *  which this check can't see — it counts as installed. */
export function skillInstalled(name: string, cwd: string, home = os.homedir()): boolean {
  if (name.includes(':')) return true;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return [path.join(cwd, '.claude', 'skills'), path.join(home, '.claude', 'skills')].some(dir =>
    fs.existsSync(path.join(dir, name, 'SKILL.md')),
  );
}
