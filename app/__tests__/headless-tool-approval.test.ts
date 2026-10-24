/**
 * MCP tool pre-approval + headless fail-fast.
 *
 * Two layers, tested where each lives:
 *   - Pure config/decision helpers (no live SDK): `isToolPreApproved`
 *     (server-level + exact allowlist matching) and the two env parsers
 *     (`parseAllowedMcpToolsEnv`, `headlessToolDenyEnabled`).
 *   - The executor's handling of a `ToolPermissionRequiredError` thrown by the
 *     stream: it emits a loud `awaiting-approval` event and fails the phase
 *     fast (routed through continueOnError like any per-leaf failure) instead
 *     of stalling.
 *
 * NOT covered here (needs a live Agent SDK): the streamSdk `canUseTool`
 * deny→interrupt→throw round-trip itself. The decision it delegates to
 * (`isToolPreApproved`) and the executor's reaction to the thrown error ARE
 * covered, so only the SDK glue is left for an on-device check.
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import {
  isToolPreApproved,
  ToolPermissionRequiredError,
} from '../src/server/sdk-stream';
import {
  parseAllowedMcpToolsEnv,
  headlessToolDenyEnabled,
} from '../src/server/run-runner';
import type { Node } from '../src/types';

describe('isToolPreApproved', () => {
  test('an exact tool id in the allowlist is pre-approved', () => {
    const allow = new Set(['mcp__github__create_pull_request']);
    expect(isToolPreApproved('mcp__github__create_pull_request', allow)).toBe(true);
    expect(isToolPreApproved('mcp__github__merge_pull_request', allow)).toBe(false);
  });

  test('a whole-server grant covers every tool under that server', () => {
    const allow = new Set(['mcp__github']);
    expect(isToolPreApproved('mcp__github__create_pull_request', allow)).toBe(true);
    expect(isToolPreApproved('mcp__github__anything_else', allow)).toBe(true);
    // A different server is NOT covered.
    expect(isToolPreApproved('mcp__slack__post_message', allow)).toBe(false);
  });

  test('a built-in tool name matches exactly (no server prefix logic)', () => {
    const allow = new Set(['Bash']);
    expect(isToolPreApproved('Bash', allow)).toBe(true);
    expect(isToolPreApproved('Write', allow)).toBe(false);
  });

  test('an empty allowlist pre-approves nothing', () => {
    expect(isToolPreApproved('mcp__github__x', new Set())).toBe(false);
  });
});

describe('parseAllowedMcpToolsEnv', () => {
  test('splits on commas and whitespace, trims, drops blanks', () => {
    expect(parseAllowedMcpToolsEnv('mcp__github, mcp__slack__post  Bash')).toEqual([
      'mcp__github',
      'mcp__slack__post',
      'Bash',
    ]);
  });
  test('unset / blank → empty list', () => {
    expect(parseAllowedMcpToolsEnv(undefined)).toEqual([]);
    expect(parseAllowedMcpToolsEnv('')).toEqual([]);
    expect(parseAllowedMcpToolsEnv('  ')).toEqual([]);
  });
});

describe('headlessToolDenyEnabled', () => {
  test('only "1" / "true" enable it', () => {
    expect(headlessToolDenyEnabled('1')).toBe(true);
    expect(headlessToolDenyEnabled('true')).toBe(true);
    expect(headlessToolDenyEnabled('0')).toBe(false);
    expect(headlessToolDenyEnabled('yes')).toBe(false);
    expect(headlessToolDenyEnabled(undefined)).toBe(false);
  });
});

describe('executor surfaces a ToolPermissionRequiredError as awaiting-approval', () => {
  // A stream that dies the way streamSdk does on a headless permission block:
  // it throws ToolPermissionRequiredError before yielding anything.
  const denyingStreamFn: StreamFn = async function* () {
    throw new ToolPermissionRequiredError('mcp__github__create_pull_request');
    // eslint-disable-next-line no-unreachable
    yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } } as never;
  };

  async function run(node: Node): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const ev of runOrchestration({
      orchestration: node,
      apiKey: 'k',
      model: 'claude-sonnet-4-6',
      streamFn: denyingStreamFn,
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: [{ name: 'w', raw: '---\nname: w\n---\nsystem prompt' }],
      orchestrationsOverride: [],
    })) {
      events.push(ev);
    }
    return events;
  }

  test('emits awaiting-approval (with the tool) right before the phase-error', async () => {
    const events = await run({
      name: 'flow',
      phases: [
        {
          name: 'open-pr',
          agent: 'agents/w.md',
          mcp: ['github'],
          continueOnError: true, // keep the run alive so we can inspect events
        },
      ],
    });
    const approval = events.find(e => e.type === 'awaiting-approval') as any;
    expect(approval).toBeDefined();
    expect(approval.phaseName).toBe('open-pr');
    expect(approval.toolName).toBe('mcp__github__create_pull_request');

    // It precedes the phase-error for the same phase (loud signal first).
    const idxApproval = events.findIndex(e => e.type === 'awaiting-approval');
    const idxError = events.findIndex(
      e => e.type === 'phase-error' && (e as any).phaseName === 'open-pr',
    );
    expect(idxError).toBeGreaterThan(idxApproval);
  });
});
