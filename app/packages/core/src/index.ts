/**
 * sammy-pack — programmatic SDK for the orchestration engine.
 *
 * The runtime + types you need to embed sammy-pack in your own app or
 * CLI. The web app (Vite + React Native Web) is a CONSUMER of these
 * exports; nothing here pulls in React or the browser-only routes.
 *
 * Quickstart:
 *
 *   import {
 *     runOrchestration,
 *     buildProviderRegistry,
 *     streamFnFor,
 *     type Node,
 *   } from 'sammy-pack';
 *
 *   const fn = streamFnFor('openai', process.env.OPENAI_API_KEY!);
 *   for await (const ev of runOrchestration({
 *     orchestration: myNode,
 *     apiKey: '',
 *     model: 'gpt-4o-mini',
 *     streamFn: fn!,
 *     waitForApproval: async () => true,
 *     cancelled: { v: false },
 *     agentsOverride: [{ name: 'writer', raw: '---\n---\nYou write things.' }],
 *   })) {
 *     console.log(ev);
 *   }
 *
 * Per-node `provider: "openai" | "gemini" | "anthropic"` routes the
 * phase to the matching adapter; pass a `providerStreamFns` registry
 * so routing has somewhere to land.
 */

// ── Runtime ────────────────────────────────────────────────────────
export {
  runOrchestration,
  PhaseChatQueue,
  RunPauseRequested,
  type RunEvent,
  type StreamFn,
  type SubagentSpec,
  type CompositeKind,
} from '../../../src/llm/executor';

// ── Provider routing ──────────────────────────────────────────────
export {
  ALL_PROVIDERS,
  DEFAULT_MODEL_BY_PROVIDER,
  buildProviderRegistry,
  streamFnFor,
  streamAnthropic,
  streamOpenAI,
  streamGemini,
  type ProviderId,
  type ProviderRegistry,
} from '../../../src/llm/providers';

export {
  type Message,
  type StreamEvent,
  type Usage,
} from '../../../src/llm/anthropic';

// ── A2A (outbound client + shared types) ──────────────────────────
export {
  callRemoteA2aAgent,
  fetchAgentCard,
  buildOrchestrationCard,
  buildRootCard,
  partsToText,
  extractTaskOutput,
  isTerminalA2aState,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  type A2aAgentCard,
  type A2aTask,
  type A2aTaskState,
  type A2aMessage,
  type A2aPart,
  type A2aArtifact,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../../src/llm/a2a';

// ── Pricing + cost ────────────────────────────────────────────────
export { costUsd, knownModel } from '../../../src/llm/pricing';

// ── Schema types ──────────────────────────────────────────────────
export {
  compositeKey,
  compositeChildCount,
  type Node,
  type LoopBody,
  type ConversationBody,
  type RouteBody,
  type MapBody,
  type A2aBody,
  type Lifecycle,
  type RetryPolicy,
  type Budget,
  type Sandbox,
  type CompositeKey,
  type SchemaRef,
  type Workspace,
} from '../../../src/types';

// ── Code-first authoring DSL (compiles to the JSON format) ────────
export {
  orchestration,
  OrchestrationBuilder,
  agentPhase,
  agents,
  phases,
  parallelNodes,
  converge,
  subflow,
  loop,
  conversation,
  route,
  switchOn,
  mapOver,
  a2a,
  codePhase,
  waitPhase,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
  deploymentTrigger,
  pollingTrigger,
  queueTrigger,
  BuilderError,
  CompileError,
  type CompiledOrchestration,
  type NodeOpts,
  type AgentOpts,
  type ConvergeOpts,
  type RootOpts,
  type LoopOpts,
  type MapOpts,
  type RouteOpts,
  type SwitchOpts,
  type A2aOpts,
} from './builder';

// ── Validation ────────────────────────────────────────────────────
export {
  validateOrchestration,
  type ValidationError,
} from '../../../src/validate';

export { checkSchema, checkContract } from '../../../src/lib/json-schema-check';

// ── Persistence interface (storage backends pluggable behind it) ──
export {
  openRunStore,
  importLegacyRunFiles,
  assertStatus,
  type RunStore,
  type RunStatus,
  type RunHeader,
  type Run,
  type StoredEvent,
  type UpsertRunInput,
  type UpdateRunPatch,
} from '../../../src/server/run-store';

// ── Run controller (upsert row → run executor in background) ──────
export {
  startRun,
  subscribe,
  resume,
  cancel,
  isActive,
  type StartRunOpts,
  type ResumeOpts,
  type ResumeResult,
} from '../../../src/server/run-controller';

// ── Sandbox policy ────────────────────────────────────────────────
export {
  mergeSandbox,
  applyToolPolicy,
  resolvePermissionMode,
  checkDeniedCommand,
} from '../../../src/server/sandbox-policy';

// ── Budget ────────────────────────────────────────────────────────
export {
  readBudgetConfig,
  writeBudgetConfig,
  evaluateBudget,
  loadBudgetState,
  checkGateBreach,
  type BudgetConfig,
  type BudgetStatus,
  type BudgetGate,
} from '../../../src/server/budget-store';

// ── Observability ─────────────────────────────────────────────────
export { buildOtlpTrace } from '../../../src/server/otlp-trace';

// ── Queue sources (pluggable broker adapters) ─────────────────────
// The narrow-waist contract every broker adapter (SQS/Kafka/Rabbit/…)
// implements. The core ships ONLY this contract + the httpDeliver helper
// — never a broker SDK. Adapters are optional out-of-process packages
// (e.g. @sammy-pack/source-sqs) that depend on this.
export {
  makeHttpDeliver,
  httpDeliver,
  type QueueSource,
  type SourceMessage,
  type DeliveryResult as QueueDeliveryResult,
  type DeliverFn,
  type DeliverSigning,
  type HttpDeliverOptions,
} from '../../../src/server/queue-source';

// ── A2A inbound translation (Run ↔ Task) ──────────────────────────
export {
  runStatusToA2aState,
  isTerminalRunStatus,
  buildTaskFromRun,
  runEventToA2aStreamEvent,
  jsonRpcResult,
  jsonRpcError,
  type A2aStreamEvent,
} from '../../../src/server/a2a-inbound';
