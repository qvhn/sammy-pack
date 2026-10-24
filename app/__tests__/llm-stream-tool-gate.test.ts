/**
 * /api/llm/stream — the tool gate is transitive and the permission mode is
 * always explicit; MCP-resolved secrets are scrubbed from the relay.
 *
 * Two bypasses of the route's own gate:
 *
 *   (a) The route refused an EXPLICIT `permissionMode: 'bypassPermissions'`
 *       but passed an omitted one straight through, and `sdk-stream.ts`
 *       defaults an undefined mode to `bypassPermissions` whenever tools are
 *       present. Omitting the field produced the exact escalation the
 *       refusal existed to stop. The route now passes an explicit mode —
 *       the operator's SAMMY_LLM_STREAM_PERMISSION_MODE, default `default`
 *       — and a caller may only narrow it.
 *
 *   (b) `subagents` were forwarded verbatim with their own `tools` and
 *       `permissionMode`, untouched by SAMMY_LLM_STREAM_TOOLS=off or the
 *       allowlist, and the off-switch only looked at the TOP-LEVEL list —
 *       so `tools: []` plus a subagent was never examined. Both gates now
 *       apply to every subagent, and a subagent that omits `tools` (which
 *       the SDK reads as "inherit everything") is tool-bearing.
 *
 * Plus: a `${connections:…}` ref expanded for this route joined no
 * redaction set, so an MCP subprocess echoing its token streamed it to the
 * browser verbatim. The route now threads the same secret sink the
 * run-runner uses and scrubs every relayed chunk against it.
 *
 * `streamSdk` is mocked at the module seam so the assertions are on the
 * exact params the SDK would have received — no `claude` subprocess.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { streamSdk } from '../src/server/sdk-stream';
import {
  makeWorkspace,
  mountServer,
  pinTestEnv,
  type Mount,
} from './lifecycle-harness.helpers';

jest.mock('../src/server/sdk-stream', () => {
  const actual = jest.requireActual('../src/server/sdk-stream');
  return { ...actual, streamSdk: jest.fn() };
});

jest.setTimeout(60_000);

const mockedStream = streamSdk as jest.MockedFunction<typeof streamSdk>;
type StreamParams = Parameters<typeof streamSdk>[0];

const GATE_ENV = [
  'SAMMY_LLM_STREAM_TOOLS',
  'SAMMY_LLM_STREAM_TOOL_ALLOWLIST',
  'SAMMY_LLM_STREAM_PERMISSION_MODE',
] as const;

function textOnly(text: string): void {
  mockedStream.mockImplementation(async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
  });
}

async function post(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/api/llm/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  return { status: res.status, text: await res.text() };
}

function lastParams(): StreamParams {
  const calls = mockedStream.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

describe('/api/llm/stream tool gate', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let tmpRoot: string;
  const savedGateEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    for (const k of GATE_ENV) savedGateEnv.set(k, process.env[k]);
    for (const k of GATE_ENV) delete process.env[k];
    tmpRoot = await makeWorkspace('llm-stream-gate');
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    for (const [k, v] of savedGateEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    restoreEnv?.();
  });

  beforeEach(() => {
    mockedStream.mockReset();
    textOnly('ok');
    for (const k of GATE_ENV) delete process.env[k];
  });

  /** The operator mode is resolved ONCE at mount (it cannot change per
   *  request), so a test that sets it re-mounts around its body and
   *  re-mounts back to the default afterwards. */
  async function withOperatorMode(mode: string, body: () => Promise<void>): Promise<void> {
    process.env.SAMMY_LLM_STREAM_PERMISSION_MODE = mode;
    await mount.kill();
    mount = await mountServer(tmpRoot);
    try {
      await body();
    } finally {
      delete process.env.SAMMY_LLM_STREAM_PERMISSION_MODE;
      await mount.kill();
      mount = await mountServer(tmpRoot);
    }
  }

  it('passes an explicit permissionMode when the caller omits one — never the SDK bypass default', async () => {
    const r = await post(mount.baseUrl, { tools: ['Bash'] });
    expect(r.status).toBe(200);
    expect(lastParams().permissionMode).toBe('default');
  });

  it('the operator mode is the ceiling: applied when omitted, narrowable, never widenable', async () => {
    await withOperatorMode('acceptEdits', async () => {
      expect((await post(mount.baseUrl, { tools: ['Read'] })).status).toBe(200);
      expect(lastParams().permissionMode).toBe('acceptEdits');

      expect(
        (await post(mount.baseUrl, { tools: ['Read'], permissionMode: 'plan' })).status,
      ).toBe(200);
      expect(lastParams().permissionMode).toBe('plan');

      const calls = mockedStream.mock.calls.length;
      const refused = await post(mount.baseUrl, {
        tools: ['Read'],
        permissionMode: 'bypassPermissions',
      });
      expect(refused.status).toBe(403);
      expect(refused.text).toContain('SAMMY_LLM_STREAM_PERMISSION_MODE');
      expect(mockedStream.mock.calls.length).toBe(calls);
    });
  });

  it('an unrecognised operator value is not honoured — it falls back to default, warning ONCE at mount', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withOperatorMode('yolo', async () => {
        const warnedAtMount = warn.mock.calls.filter(c =>
          String(c[0]).includes('SAMMY_LLM_STREAM_PERMISSION_MODE="yolo"'),
        ).length;
        expect(warnedAtMount).toBe(1);
        expect((await post(mount.baseUrl, { tools: ['Read'] })).status).toBe(200);
        expect((await post(mount.baseUrl, { tools: ['Read'] })).status).toBe(200);
        expect(lastParams().permissionMode).toBe('default');
        // Pre-fix the per-request reader warned on EVERY call.
        expect(
          warn.mock.calls.filter(c =>
            String(c[0]).includes('SAMMY_LLM_STREAM_PERMISSION_MODE="yolo"'),
          ).length,
        ).toBe(warnedAtMount);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('=off: a PLAIN request reaches the SDK with NO built-in toolset, not the default preset', async () => {
    // The off-switch only refused tool-BEARING requests; a plain
    // `{messages}` call still ran with the SDK's full built-in preset, and
    // under permissionMode `default` its permission-free members (Read,
    // Glob, Grep) executed unprompted.
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    const r = await post(mount.baseUrl, {});
    expect(r.status).toBe(200);
    expect(lastParams().builtinTools).toEqual([]);
  });

  it('the base toolset is the POLICED list: the allowlist intersection, or the request as made', async () => {
    process.env.SAMMY_LLM_STREAM_TOOL_ALLOWLIST = 'Read,Grep';
    expect((await post(mount.baseUrl, { tools: ['Bash', 'Read'] })).status).toBe(200);
    expect(lastParams().builtinTools).toEqual(['Read']);

    delete process.env.SAMMY_LLM_STREAM_TOOL_ALLOWLIST;
    expect((await post(mount.baseUrl, { tools: ['Bash'] })).status).toBe(200);
    expect(lastParams().builtinTools).toEqual(['Bash']);
    // "Empty / undefined → text-only completion", as the route documents.
    expect((await post(mount.baseUrl, {})).status).toBe(200);
    expect(lastParams().builtinTools).toEqual([]);
  });

  it('=off refuses subagent tools even when the top-level tools list is empty', async () => {
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    const r = await post(mount.baseUrl, {
      tools: [],
      subagents: { helper: { description: 'd', prompt: 'p', tools: ['Bash'] } },
    });
    expect(r.status).toBe(403);
    expect(r.text).toContain('helper');
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('=off treats a subagent that OMITS tools as tool-bearing (the SDK makes it inherit)', async () => {
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    const r = await post(mount.baseUrl, {
      subagents: { inherits: { description: 'd', prompt: 'p' } },
    });
    expect(r.status).toBe(403);
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('=off refuses a request carrying registry MCP servers, naming the lever', async () => {
    // `tools: []` disables only the SDK's built-in preset; a named MCP
    // server is spawned with its resolved secrets and its tools are listed
    // to the model. The off-switch judged "tool-bearing" by `tools` and
    // `subagents` alone, so `{messages, mcp:[…]}` passed the text-only
    // posture. Refused before any registry lookup — the request carries
    // servers, whether or not they resolve.
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    const r = await post(mount.baseUrl, { tools: [], mcp: ['svc'] });
    expect(r.status).toBe(403);
    expect(r.text).toContain('SAMMY_LLM_STREAM_TOOLS=off');
    expect(r.text).toContain('svc');
    expect(mockedStream).not.toHaveBeenCalled();
    // An empty list carries nothing and is still a text-only call.
    expect((await post(mount.baseUrl, { mcp: [] })).status).toBe(200);
  });

  it('=off still allows a text-only call whose subagents declare no tools', async () => {
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    const r = await post(mount.baseUrl, {
      subagents: { writer: { description: 'd', prompt: 'p', tools: [] } },
    });
    expect(r.status).toBe(200);
    expect(lastParams().subagents?.writer.tools).toEqual([]);
  });

  it('the allowlist applies transitively to every subagent, and pins an omitted list', async () => {
    process.env.SAMMY_LLM_STREAM_TOOL_ALLOWLIST = 'Read,Grep';
    const r = await post(mount.baseUrl, {
      tools: ['Bash', 'Read'],
      subagents: {
        helper: { description: 'd', prompt: 'p', tools: ['Bash', 'Grep'] },
        inherits: { description: 'd', prompt: 'p' },
      },
    });
    expect(r.status).toBe(200);
    const params = lastParams();
    expect(params.tools).toEqual(['Read']);
    expect(params.subagents?.helper.tools).toEqual(['Grep']);
    // Omitted = inherit in the SDK; pinned to the policed top-level list so
    // inheritance cannot out-run the allowlist.
    expect(params.subagents?.inherits.tools).toEqual(['Read']);
  });

  it('a subagent cannot escalate its own permissionMode', async () => {
    const r = await post(mount.baseUrl, {
      tools: ['Read'],
      subagents: {
        helper: {
          description: 'd',
          prompt: 'p',
          tools: ['Read'],
          permissionMode: 'bypassPermissions',
        },
      },
    });
    expect(r.status).toBe(403);
    expect(r.text).toContain('helper');
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('subagents that omit a permissionMode get the explicit top-level one', async () => {
    const r = await post(mount.baseUrl, {
      tools: ['Read'],
      subagents: { helper: { description: 'd', prompt: 'p', tools: ['Read'] } },
    });
    expect(r.status).toBe(200);
    expect(lastParams().subagents?.helper.permissionMode).toBe('default');
  });
});

describe('/api/llm/stream redacts MCP-resolved secrets', () => {
  let restoreEnv: () => void;
  let mount: Mount;
  let tmpRoot: string;
  // Custom-format on purpose: matches none of the scrubber's token
  // PATTERNS, so only the literal secret sink can catch it.
  const SECRET = 'pat-7731-custom-value';

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    tmpRoot = await makeWorkspace('llm-stream-scrub');
    await fs.writeFile(
      path.join(tmpRoot, 'credentials.json'),
      JSON.stringify({ 'svc-token': { value: SECRET } }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpRoot, 'mcp'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'mcp', 'servers.json'),
      JSON.stringify({
        svc: {
          command: 'svc-mcp',
          env: { SVC_TOKEN: '${connections:svc-token.value}' },
        },
      }),
      'utf8',
    );
    mount = await mountServer(tmpRoot);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('a resolved ${connections:…} value never reaches the wire, in text or tool output', async () => {
    mockedStream.mockReset();
    mockedStream.mockImplementation(async function* (params) {
      const env = (params.mcpServers?.svc as { env?: Record<string, string> } | undefined)
        ?.env;
      yield { type: 'text-delta', text: `token is ${env?.SVC_TOKEN}` };
      yield {
        type: 'tool-result',
        toolUseId: 't1',
        output: `echo ${env?.SVC_TOKEN}`,
        isError: false,
      };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const r = await post(mount.baseUrl, { mcp: ['svc'] });
    expect(r.status).toBe(200);
    // The ref DID resolve into the config the SDK was handed…
    const handed = lastParams().mcpServers?.svc as { env?: Record<string, string> };
    expect(handed.env?.SVC_TOKEN).toBe(SECRET);
    // …and the stream the browser saw carries only the redaction.
    expect(r.text).not.toContain(SECRET);
    expect(r.text).toContain('[REDACTED]');
  });
});
