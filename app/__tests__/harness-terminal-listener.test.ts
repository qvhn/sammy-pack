/**
 * The listener a terminal-driven harness leg serves its step tools on: a real
 * MCP client must be able to list and call them with the leg's token, and
 * nothing without it. Bound to loopback; gone once closed.
 */

// The MCP client's OAuth helper pulls in an ESM-only package jest's CommonJS
// resolver can't load; this test never authenticates through OAuth.
jest.mock('pkce-challenge', () => ({ __esModule: true, default: async () => ({ code_verifier: '', code_challenge: '' }) }), { virtual: true });

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HarnessToolSpec } from '../src/llm/harness';
import { harnessTerminalCommand } from '../src/llm/harness';
import { serveHarnessToolsHttp, skillInstalled } from '../src/server/harness-session';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const calls: Array<Record<string, string | undefined>> = [];
const tools: HarnessToolSpec[] = [
  {
    name: 'start_step',
    description: 'Start a step.',
    params: { step: 'The step id or name.' },
    handler: async args => {
      calls.push(args);
      return { text: `started ${args.step}` };
    },
  },
  {
    name: 'complete_step',
    description: 'Hand in a step.',
    params: { step: 'The step.', 'output?': 'Its result.' },
    handler: async args => ({ text: `done ${args.step}:${args.output ?? ''}`, isError: !args.output }),
  },
];

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-terminal', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('serveHarnessToolsHttp', () => {
  it('serves the step tools to an MCP client holding the token, on loopback', async () => {
    const served = await serveHarnessToolsHttp(tools);
    try {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const client = await connect(served.url, served.token);
      const listed = await client.listTools();
      expect(listed.tools.map(t => t.name).sort()).toEqual(['complete_step', 'start_step']);
      const res = await client.callTool({ name: 'start_step', arguments: { step: 'plan' } });
      expect(res.content).toEqual([{ type: 'text', text: 'started plan' }]);
      expect(calls).toEqual([{ step: 'plan' }]);
      const bad = await client.callTool({ name: 'complete_step', arguments: { step: 'plan' } });
      expect(bad.isError).toBe(true);
      await client.close();
    } finally {
      served.close();
    }
  });

  it('refuses a request without the token', async () => {
    const served = await serveHarnessToolsHttp(tools);
    try {
      const res = await fetch(served.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      const none = await fetch(served.url, { method: 'POST', body: '{}' });
      expect(none.status).toBe(401);
    } finally {
      served.close();
    }
  });

  it('is gone once closed', async () => {
    const served = await serveHarnessToolsHttp(tools);
    served.close();
    await new Promise(r => setTimeout(r, 20));
    await expect(fetch(served.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});

describe('harnessTerminalCommand', () => {
  it('resumes the session in its directory, with the step tools when a leg is live', () => {
    const cmd = harnessTerminalCommand({
      sessionId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      cwd: "/tmp/it's here",
      runId: 'run-1',
      tools: { url: 'http://127.0.0.1:5555/mcp', token: 'abc' },
    });
    expect(cmd.startsWith(`cd '/tmp/it'\\''s here' && claude --resume 1b4e28ba-2fa1-11d2-883f-0016d3cca427 `)).toBe(true);
    expect(cmd).toContain(`--mcp-config '{"mcpServers":{"sammy":{"type":"http","url":"http://127.0.0.1:5555/mcp","headers":{"Authorization":"Bearer abc"}}}}'`);
    expect(cmd).toContain(`--allowedTools 'mcp__sammy'`);
    expect(harnessTerminalCommand({ sessionId: 'x' })).toBe('claude --resume x');
  });
});

describe('skillInstalled', () => {
  it('finds a project or user skill by name; plugin-qualified names are not checked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'triage'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'triage', 'SKILL.md'), '---\nname: triage\n---\n');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    expect(skillInstalled('triage', root, home)).toBe(true);
    expect(skillInstalled('mine', root, home)).toBe(true);
    expect(skillInstalled('absent', root, home)).toBe(false);
    expect(skillInstalled('../etc', root, home)).toBe(false);
    expect(skillInstalled('plugin:anything', root, home)).toBe(true);
  });
});
