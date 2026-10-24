/**
 * A2A protocol — agent-card builders, the outbound client (with a
 * mocked fetch), and the inbound run↔task translation.
 */

import {
  buildOrchestrationCard,
  buildRootCard,
  callRemoteA2aAgent,
  extractTaskOutput,
  isTerminalA2aState,
  partsToText,
  type A2aTask,
} from '../src/llm/a2a';
import {
  buildTaskFromRun,
  jsonRpcError,
  jsonRpcResult,
  runEventToA2aStreamEvent,
  runStatusToA2aState,
} from '../src/server/a2a-inbound';
import type { Run } from '../src/server/db';

describe('agent-card builders', () => {
  it('builds a per-orchestration card with an invocable endpoint', () => {
    const card = buildOrchestrationCard({
      name: 'ticket-triage',
      description: 'Triage a ticket.',
      baseUrl: 'http://localhost:5173',
    });
    expect(card.url).toBe('http://localhost:5173/api/a2a/ticket-triage');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe('run');
  });

  it('builds a root card whose skills enumerate orchestrations', () => {
    const card = buildRootCard({
      baseUrl: 'http://h',
      orchestrations: [
        { name: 'a', description: 'A' },
        { name: 'b' },
      ],
    });
    expect(card.skills.map(s => s.id)).toEqual(['a', 'b']);
  });
});

describe('A2A helpers', () => {
  it('partsToText concatenates text parts', () => {
    expect(
      partsToText([
        { kind: 'text', text: 'foo' },
        { kind: 'text', text: 'bar' },
      ]),
    ).toBe('foobar');
  });

  it('extractTaskOutput prefers artifacts, falls back to status message', () => {
    const withArtifact: A2aTask = {
      id: 't',
      contextId: 't',
      kind: 'task',
      status: { state: 'completed' },
      artifacts: [
        { artifactId: 'a', parts: [{ kind: 'text', text: 'artifact text' }] },
      ],
    };
    expect(extractTaskOutput(withArtifact)).toBe('artifact text');

    const messageOnly: A2aTask = {
      id: 't',
      contextId: 't',
      kind: 'task',
      status: {
        state: 'completed',
        message: {
          role: 'agent',
          kind: 'message',
          messageId: 'm',
          parts: [{ kind: 'text', text: 'fallback text' }],
        },
      },
    };
    expect(extractTaskOutput(messageOnly)).toBe('fallback text');
  });

  it('isTerminalA2aState — terminal vs in-flight', () => {
    expect(isTerminalA2aState('completed')).toBe(true);
    expect(isTerminalA2aState('failed')).toBe(true);
    expect(isTerminalA2aState('input-required')).toBe(true);
    expect(isTerminalA2aState('working')).toBe(false);
    expect(isTerminalA2aState('submitted')).toBe(false);
  });
});

describe('callRemoteA2aAgent (outbound, mocked fetch)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    } as unknown as Response;
  }

  it('fetches the card, sends a task, polls to completion', async () => {
    const card = {
      protocolVersion: '0.3.0',
      name: 'remote',
      description: '',
      url: 'http://remote/api/a2a/x',
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(card))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: '1',
          result: {
            id: 'task-1',
            contextId: 'task-1',
            kind: 'task',
            status: { state: 'working' },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: '2',
          result: {
            id: 'task-1',
            contextId: 'task-1',
            kind: 'task',
            status: { state: 'completed' },
            artifacts: [
              { artifactId: 'r', parts: [{ kind: 'text', text: 'done!' }] },
            ],
          },
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callRemoteA2aAgent({
      agentCard: 'http://remote/.well-known/agent-card.json',
      input: 'hello',
      pollIntervalMs: 1,
    });
    expect(result.state).toBe('completed');
    expect(result.output).toBe('done!');
    expect(result.taskId).toBe('task-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('threads idempotencyKey into message/send metadata', async () => {
    const card = {
      protocolVersion: '0.3.0',
      name: 'remote',
      description: '',
      url: 'http://remote/api/a2a/x',
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(card))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: '1',
          result: {
            id: 'task-1',
            contextId: 'task-1',
            kind: 'task',
            status: { state: 'completed' },
            artifacts: [
              { artifactId: 'r', parts: [{ kind: 'text', text: 'ok' }] },
            ],
          },
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await callRemoteA2aAgent({
      agentCard: 'http://remote/.well-known/agent-card.json',
      input: 'hello',
      skill: 'research',
      idempotencyKey: 'run-42/remote-research',
      pollIntervalMs: 1,
    });
    // call 0 = card fetch; call 1 = message/send
    const sendBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as { body: string }).body,
    );
    expect(sendBody.method).toBe('message/send');
    expect(sendBody.params.metadata).toEqual({
      skill: 'research',
      idempotencyKey: 'run-42/remote-research',
    });
  });

  it('surfaces a failed remote task without polling forever', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          url: 'http://remote/x',
          name: 'r',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: '1',
          result: {
            id: 'task-2',
            contextId: 'task-2',
            kind: 'task',
            status: { state: 'failed' },
          },
        }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callRemoteA2aAgent({
      agentCard: 'http://remote/card',
      input: 'x',
      pollIntervalMs: 1,
    });
    expect(result.state).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('inbound translation', () => {
  function makeRun(over: Partial<Run>): Run {
    return {
      id: 'run-1',
      orchestrationName: 'o',
      startedAt: 1000,
      endedAt: null,
      status: 'running',
      orchestrationSnapshot: null,
      initialInput: null,
      currentPath: null,
      stateJson: null,
      lastOutput: null,
      pausedFor: null,
      completedLeaves: null,
      updatedAt: 2000,
      ownerId: 'system',
      concurrencyGroup: null,
      degraded: false,
      degradationReasons: [],
      events: [],
      eventVersion: 0,
      ...over,
    };
  }

  it('runStatusToA2aState maps every run status', () => {
    expect(runStatusToA2aState('running')).toBe('working');
    expect(runStatusToA2aState('done')).toBe('completed');
    expect(runStatusToA2aState('error')).toBe('failed');
    expect(runStatusToA2aState('cancelled')).toBe('canceled');
    expect(runStatusToA2aState('paused')).toBe('input-required');
    expect(runStatusToA2aState('interrupted')).toBe('failed');
  });

  it('buildTaskFromRun turns phase-end events into artifacts', () => {
    const run = makeRun({
      status: 'done',
      lastOutput: 'final answer',
      events: [
        { type: 'run-start', ts: 1 },
        { type: 'phase-end', phaseName: 'spec', output: 'spec out', ts: 2 },
        { type: 'phase-end', phaseName: 'build', output: 'build out', ts: 3 },
        { type: 'run-end', ts: 4 },
      ],
    });
    const task = buildTaskFromRun(run);
    expect(task.id).toBe('run-1');
    expect(task.status.state).toBe('completed');
    expect(task.artifacts?.map(a => a.artifactId)).toEqual(['spec', 'build']);
    expect(task.status.message?.parts[0]).toEqual({
      kind: 'text',
      text: 'final answer',
    });
  });

  it('runEventToA2aStreamEvent maps lifecycle + artifact events', () => {
    expect(runEventToA2aStreamEvent({ type: 'run-start' }, 't')?.kind).toBe(
      'status-update',
    );
    const artifact = runEventToA2aStreamEvent(
      { type: 'phase-end', phaseName: 'p', output: 'o' },
      't',
    );
    expect(artifact?.kind).toBe('artifact-update');

    const end = runEventToA2aStreamEvent({ type: 'run-end' }, 't');
    expect(end?.kind === 'status-update' && end.status.state).toBe('completed');
    expect(end?.kind === 'status-update' && end.final).toBe(true);

    const err = runEventToA2aStreamEvent({ type: 'run-error' }, 't');
    expect(err?.kind === 'status-update' && err.status.state).toBe('failed');

    // No A2A equivalent — dropped.
    expect(
      runEventToA2aStreamEvent({ type: 'phase-delta', text: 'x' }, 't'),
    ).toBeNull();
  });

  it('jsonRpcResult / jsonRpcError build valid 2.0 envelopes', () => {
    expect(jsonRpcResult('5', { ok: 1 })).toEqual({
      jsonrpc: '2.0',
      id: '5',
      result: { ok: 1 },
    });
    const err = jsonRpcError(null, -32601, 'nope');
    expect(err.error).toEqual({ code: -32601, message: 'nope' });
  });
});
