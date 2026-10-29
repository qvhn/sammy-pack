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

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HookCallbackMatcher, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  HARNESS_TOOL_SERVER,
  newHarnessControl,
  type HarnessControl,
  type HarnessStreamOptions,
  type HarnessToolSpec,
} from '../llm/harness';

/** A step tool's string parameters as a zod shape (`name?` = optional). */
function zodShape(params: HarnessToolSpec['params']): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const [name, description] of Object.entries(params)) {
    const optional = name.endsWith('?');
    const key = optional ? name.slice(0, -1) : name;
    shape[key] = optional ? z.string().optional().describe(description) : z.string().describe(description);
  }
  return shape;
}

async function callTool(t: HarnessToolSpec, args: unknown) {
  const res = await t.handler(args as Record<string, string | undefined>);
  return {
    content: [{ type: 'text' as const, text: res.text }],
    ...(res.isError ? { isError: true } : {}),
  };
}

/** The step tools as an in-process MCP server named `sammy` — the agent sees
 *  them as `mcp__sammy__<tool>`. */
export async function buildHarnessMcpServer(
  tools: HarnessStreamOptions['tools'],
): Promise<McpServerConfig> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const defs = [];
  for (const t of tools) {
    const shape = zodShape(t.params) as Parameters<typeof sdk.tool>[2];
    defs.push(sdk.tool(t.name, t.description, shape, args => callTool(t, args)));
  }
  return sdk.createSdkMcpServer({ name: HARNESS_TOOL_SERVER, version: '1.0.0', tools: defs });
}

const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_MCP_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Serve the step tools to a terminal session over MCP Streamable HTTP —
 *  on 127.0.0.1, a random port, behind a one-time bearer token, and only
 *  while that terminal drives the run. Deliberately NOT a route of the API:
 *  it needs no exemption from the API's auth gates, it can't be reached from
 *  another machine, and it is gone the moment the terminal's leg ends. */
export async function serveHarnessToolsHttp(
  tools: HarnessToolSpec[],
): Promise<{ url: string; token: string; close(): void }> {
  const shapes = tools.map(t => zodShape(t.params));
  const token = crypto.randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    void (async () => {
      const got = Buffer.from(String(req.headers.authorization ?? ''));
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      if ((req.url ?? '').split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== 'POST') {
        // Stateless: no server-initiated stream, no session to delete.
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const mcp = new McpServer({ name: HARNESS_TOOL_SERVER, version: '1.0.0' });
      tools.forEach((t, i) => {
        mcp.registerTool(
          t.name,
          { description: t.description, inputSchema: shapes[i] as never },
          ((args: unknown) => callTool(t, args)) as never,
        );
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end();
        console.error('[harness] terminal tool call failed:', (err as Error).message);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => {
      // In-flight calls finish; idle keep-alive sockets go now.
      server.close();
      server.closeIdleConnections();
    },
  };
}

/** One control per run, shared by the API (take over / hand back) and the
 *  run's executor. In memory: a terminal takeover only exists while this
 *  process runs the run. */
const controls = new Map<string, HarnessControl>();
const MAX_CONTROLS = 500;

export function harnessControlFor(runId: string): HarnessControl {
  let c = controls.get(runId);
  if (!c) {
    c = newHarnessControl(serveHarnessToolsHttp);
    controls.set(runId, c);
    // Oldest first: a run that finished long ago no longer needs its handle.
    // Never one a run is using right now (a leg is live, or a takeover asked).
    for (const [id, old] of controls) {
      if (controls.size <= MAX_CONTROLS) break;
      const busy = old.interruptLeg || old.endTerminalLeg || old.terminal || old.wantTerminal;
      if (!busy && id !== runId) controls.delete(id);
    }
  }
  return c;
}

export function existingHarnessControl(runId: string): HarnessControl | undefined {
  return controls.get(runId);
}

/** Open a terminal window on THIS machine running `command`. macOS
 *  (Terminal.app) and Linux desktops (x-terminal-emulator / gnome-terminal);
 *  anything else answers with why not, and the caller shows the command to
 *  copy instead. */
export async function openTerminalWith(command: string): Promise<{ opened: boolean; reason?: string }> {
  const run = (cmd: string, args: string[]) =>
    new Promise<boolean>(resolve => {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
  if (process.platform === 'darwin') {
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const ok = await run('osascript', [
      '-e',
      `tell application "Terminal" to do script "${escaped}"`,
      '-e',
      'tell application "Terminal" to activate',
    ]);
    return ok ? { opened: true } : { opened: false, reason: 'osascript is not available' };
  }
  if (process.platform === 'linux') {
    const shell = `${command}; exec "\${SHELL:-bash}"`;
    for (const [cmd, args] of [
      ['x-terminal-emulator', ['-e', 'bash', '-lc', shell]],
      ['gnome-terminal', ['--', 'bash', '-lc', shell]],
    ] as const) {
      if (await run(cmd, [...args])) return { opened: true };
    }
    return { opened: false, reason: 'no terminal emulator found (x-terminal-emulator, gnome-terminal)' };
  }
  return { opened: false, reason: `opening a terminal isn't supported on ${process.platform}` };
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
