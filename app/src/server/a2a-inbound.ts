/**
 * Inbound A2A — translation between sammy-pack's durable run store and
 * the A2A protocol. The JSON-RPC HTTP surface lives in sammy-pack-api.ts;
 * this module is the pure mapping it leans on.
 *
 * A2A Task  ←→  sammy-pack run.    Task id  ←→  run id.
 * Run status maps onto the A2A task lifecycle 1:1.
 */

import type { Run, RunStatus } from './db';
import {
  A2A_ERROR,
  partsToText,
  type A2aArtifact,
  type A2aTask,
  type A2aTaskState,
  type A2aTaskStatus,
  type JsonRpcResponse,
} from '../llm/a2a';

/** Map a durable run status onto an A2A task lifecycle state. */
export function runStatusToA2aState(status: RunStatus): A2aTaskState {
  switch (status) {
    case 'running':
      return 'working';
    case 'done':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'paused':
      // A lock gate — the run is waiting for a human. A2A's nearest
      // concept is input-required.
      return 'input-required';
    case 'interrupted':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** True once a run will not change state without an explicit action
 *  (resume / fresh run). Drives whether the SSE stream should close. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === 'done' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'paused' ||
    status === 'interrupted'
  );
}

/** Build a full A2A Task object from a durable run: each `phase-end`
 *  output becomes an artifact, the run's last output becomes the final
 *  status message. */
export function buildTaskFromRun(run: Run): A2aTask {
  const artifacts: A2aArtifact[] = [];
  for (const ev of run.events) {
    if (ev.type !== 'phase-end') continue;
    const e = ev as { phaseName?: string; output?: unknown };
    if (typeof e.output !== 'string') continue;
    artifacts.push({
      artifactId: e.phaseName ?? `artifact-${artifacts.length}`,
      name: e.phaseName,
      parts: [{ kind: 'text', text: e.output }],
    });
  }
  const status: A2aTaskStatus = {
    state: runStatusToA2aState(run.status),
    timestamp: new Date(run.updatedAt).toISOString(),
  };
  const finalText =
    (typeof run.lastOutput === 'string' && run.lastOutput) ||
    (artifacts.length > 0
      ? partsToText(artifacts[artifacts.length - 1].parts)
      : '');
  if (finalText) {
    status.message = {
      role: 'agent',
      parts: [{ kind: 'text', text: finalText }],
      messageId: `${run.id}-status`,
      kind: 'message',
    };
  }
  return {
    id: run.id,
    contextId: run.id,
    status,
    artifacts,
    kind: 'task',
  };
}

/** A2A streaming event — either a status-update or an artifact-update. */
export type A2aStreamEvent =
  | {
      kind: 'status-update';
      taskId: string;
      contextId: string;
      status: A2aTaskStatus;
      final: boolean;
    }
  | {
      kind: 'artifact-update';
      taskId: string;
      contextId: string;
      artifact: A2aArtifact;
    };

/** Translate one sammy-pack RunEvent into an A2A streaming event, or
 *  null when the event has no A2A equivalent (deltas, tool noise). */
export function runEventToA2aStreamEvent(
  event: Record<string, unknown> & { type: string },
  taskId: string,
): A2aStreamEvent | null {
  const now = new Date().toISOString();
  const statusUpdate = (
    state: A2aTaskState,
    final: boolean,
  ): A2aStreamEvent => ({
    kind: 'status-update',
    taskId,
    contextId: taskId,
    status: { state, timestamp: now },
    final,
  });

  switch (event.type) {
    case 'run-start':
      return statusUpdate('working', false);
    case 'phase-end': {
      const e = event as { phaseName?: string; output?: unknown };
      if (typeof e.output !== 'string') return null;
      return {
        kind: 'artifact-update',
        taskId,
        contextId: taskId,
        artifact: {
          artifactId: e.phaseName ?? 'artifact',
          name: e.phaseName,
          parts: [{ kind: 'text', text: e.output }],
        },
      };
    }
    case 'run-end':
      return statusUpdate('completed', true);
    case 'run-error':
    case 'run-interrupted':
    case 'budget-halted':
      return statusUpdate('failed', true);
    case 'run-cancelled':
      return statusUpdate('canceled', true);
    case 'run-paused':
      return statusUpdate('input-required', true);
    default:
      return null;
  }
}

/** JSON-RPC 2.0 success envelope. */
export function jsonRpcResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** JSON-RPC 2.0 error envelope. */
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export { A2A_ERROR };
