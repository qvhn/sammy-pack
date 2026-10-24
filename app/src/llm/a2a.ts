/**
 * A2A (Agent2Agent) protocol — shared shapes, agent-card builders, and
 * the outbound client.
 *
 * No db / server dependency: this module is safe to import from the
 * executor, which runs in both the browser bundle and the dev server.
 * The inbound JSON-RPC server (sammy-pack-api.ts) imports the same
 * shapes plus the translation helpers in `server/a2a-inbound.ts`.
 *
 * Mapping: an A2A Task is a sammy-pack run, a
 * Task id is a run id, and the task lifecycle states line up 1:1 with
 * run statuses.
 */

import { verifyAgentCard } from './a2a-card-signing';

export const A2A_PROTOCOL_VERSION = '0.3.0';

export type A2aTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'unknown';

/** Terminal — no further polling will change the outcome. `input-required`
 *  counts as terminal for an *outbound* call: we can't supply the extra
 *  input the remote is asking for, so we stop and surface it. */
export function isTerminalA2aState(s: A2aTaskState): boolean {
  return (
    s === 'completed' ||
    s === 'failed' ||
    s === 'canceled' ||
    s === 'input-required'
  );
}

export type A2aTextPart = { kind: 'text'; text: string };
export type A2aPart = A2aTextPart;

export type A2aMessage = {
  role: 'user' | 'agent';
  parts: A2aPart[];
  messageId: string;
  kind: 'message';
  metadata?: Record<string, unknown>;
};

export type A2aArtifact = {
  artifactId: string;
  name?: string;
  parts: A2aPart[];
};

export type A2aTaskStatus = {
  state: A2aTaskState;
  message?: A2aMessage;
  timestamp?: string;
};

export type A2aTask = {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  kind: 'task';
};

export type A2aAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes?: string[];
  outputModes?: string[];
};

export type A2aAgentCard = {
  protocolVersion: string;
  name: string;
  description: string;
  /** JSON-RPC endpoint the task is submitted to. */
  url: string;
  preferredTransport: 'JSONRPC';
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  /** JWS signatures over the card (minus this field) so a caller can
   *  authenticate the publisher before trusting `url`. See
   *  a2a-card-signing.ts for the signing/verification scheme. */
  signatures?: A2aCardSignature[];
};

/** One JWS signature entry (JWS JSON serialization shape): `protected` is
 *  the base64url-encoded JWS header, `signature` the base64url RS256
 *  signature over `<protected>.<payload>` where payload =
 *  base64url(canonical JSON of the card without `signatures`). */
export type A2aCardSignature = {
  protected: string;
  signature: string;
};

/** JSON-RPC 2.0 envelopes. */
export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
};
export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Standard JSON-RPC + A2A error codes. */
export const A2A_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
} as const;

// ─── Agent-card builders (pure) ───────────────────────────────────────

/** Per-orchestration card: the real invocable A2A agent. Its `url` is
 *  the JSON-RPC endpoint that runs this one orchestration. */
export function buildOrchestrationCard(opts: {
  name: string;
  description?: string;
  baseUrl: string;
}): A2aAgentCard {
  const desc =
    opts.description?.trim() ||
    `Runs the "${opts.name}" sammy-pack orchestration.`;
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: opts.name,
    description: desc,
    url: `${opts.baseUrl}/api/a2a/${opts.name}`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'run',
        name: `Run ${opts.name}`,
        description: desc,
        tags: ['orchestration', 'sammy-pack'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
  };
}

/** Workspace root card served at /.well-known/agent-card.json — a
 *  discovery index whose skills enumerate every saved orchestration. */
export function buildRootCard(opts: {
  baseUrl: string;
  orchestrations: Array<{ name: string; description?: string }>;
}): A2aAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: 'sammy-pack',
    description:
      'A sammy-pack workspace exposed over A2A. Each skill below is a ' +
      'saved orchestration; fetch /api/a2a/<name>/agent-card.json for ' +
      'the per-orchestration card with the invocable JSON-RPC endpoint.',
    url: `${opts.baseUrl}/api/a2a`,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: opts.orchestrations.map(o => ({
      id: o.name,
      name: o.name,
      description: o.description?.trim() || `The "${o.name}" orchestration.`,
      tags: ['orchestration', 'sammy-pack'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    })),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Concatenate every text part of a message / artifact list. */
export function partsToText(parts: A2aPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p): p is A2aTextPart => p.kind === 'text')
    .map(p => p.text)
    .join('');
}

/** Best-effort extraction of a task's textual output: artifacts first,
 *  then the final status message. */
export function extractTaskOutput(task: A2aTask): string {
  if (task.artifacts && task.artifacts.length > 0) {
    const joined = task.artifacts
      .map(a => partsToText(a.parts))
      .filter(Boolean)
      .join('\n\n');
    if (joined) return joined;
  }
  return partsToText(task.status.message?.parts);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Outbound client ──────────────────────────────────────────────────

async function jsonRpcCall(
  endpoint: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`A2A ${method} → HTTP ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) {
    throw new Error(`A2A ${method} error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

export async function fetchAgentCard(url: string): Promise<A2aAgentCard> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `A2A agent-card fetch failed: HTTP ${res.status} for ${url}`,
    );
  }
  const card = (await res.json()) as A2aAgentCard;
  if (!card || typeof card.url !== 'string' || !card.url) {
    throw new Error(`A2A agent card at ${url} has no usable \`url\` endpoint`);
  }
  // Pinned-publisher verification: when SAMMY_A2A_REMOTE_PUBLIC_KEY is set,
  // EVERY fetched card must carry a signature that verifies against that
  // key — unsigned or mismatched cards are refused (fail closed). Guards
  // the endpoint swap: a tampered card pointing `url` at an attacker is
  // rejected before any task is sent.
  const pinned =
    typeof process !== 'undefined'
      ? process.env?.SAMMY_A2A_REMOTE_PUBLIC_KEY?.trim()
      : undefined;
  if (pinned) {
    if (!(await verifyAgentCard(card, pinned))) {
      throw new Error(
        `A2A agent card at ${url} failed signature verification against the pinned publisher key (SAMMY_A2A_REMOTE_PUBLIC_KEY)`,
      );
    }
  }
  return card;
}

/**
 * Dispatch a phase to a remote A2A agent: fetch its card, submit the
 * input as a task (`message/send`), poll `tasks/get` to a terminal
 * state, and return the result. Honors cancellation by polling the
 * caller's flag and firing `tasks/cancel` on the remote.
 */
export async function callRemoteA2aAgent(opts: {
  agentCard: string;
  skill?: string;
  input: string;
  cancelled?: { v: boolean };
  pollIntervalMs?: number;
  /** Dedupe key forwarded as message metadata.idempotencyKey — a sammy-pack
   *  receiver returns the existing task for a repeated key instead of
   *  starting a duplicate run. */
  idempotencyKey?: string;
}): Promise<{ output: string; state: A2aTaskState; taskId: string }> {
  const card = await fetchAgentCard(opts.agentCard);
  const endpoint = card.url;

  const message: A2aMessage = {
    role: 'user',
    parts: [{ kind: 'text', text: opts.input }],
    messageId: crypto.randomUUID(),
    kind: 'message',
  };
  const sendParams: Record<string, unknown> = { message };
  const metadata: Record<string, unknown> = {};
  if (opts.skill) metadata.skill = opts.skill;
  if (opts.idempotencyKey) metadata.idempotencyKey = opts.idempotencyKey;
  if (Object.keys(metadata).length > 0) sendParams.metadata = metadata;

  let task = (await jsonRpcCall(endpoint, 'message/send', sendParams)) as A2aTask;
  if (!task || typeof task.id !== 'string') {
    throw new Error('A2A message/send did not return a task with an id');
  }
  const taskId = task.id;
  const interval = opts.pollIntervalMs ?? 1500;
  // Backstop so a wedged remote can't poll forever; the node's own
  // `timeout` decorator is the real bound when one is set.
  const maxPolls = Math.ceil((20 * 60 * 1000) / interval);

  for (let i = 0; !isTerminalA2aState(task.status.state) && i < maxPolls; i++) {
    if (opts.cancelled?.v) {
      try {
        await jsonRpcCall(endpoint, 'tasks/cancel', { id: taskId });
      } catch {
        // Best-effort — the run is being cancelled regardless.
      }
      throw new Error('run cancelled');
    }
    await sleep(interval);
    task = (await jsonRpcCall(endpoint, 'tasks/get', { id: taskId })) as A2aTask;
  }

  return {
    output: extractTaskOutput(task),
    state: task.status.state,
    taskId,
  };
}
