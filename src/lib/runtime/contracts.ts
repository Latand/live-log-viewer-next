import { createHash, randomUUID } from "node:crypto";

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Workflow } from "@/lib/workflows/types";

export const RUNTIME_SCHEMA_VERSION = 1;
export const RUNTIME_SCOPE_KINDS = ["session", "flow", "workflow", "task", "operation", "deployment", "edge", "account", "system"] as const;
export type RuntimeScopeKind = (typeof RUNTIME_SCOPE_KINDS)[number];

export interface RuntimeScope {
  type: RuntimeScopeKind;
  id: string;
}

export type RuntimeScopeString = `${RuntimeScopeKind}:${string}`;
export type RuntimeScopeInput = RuntimeScope | RuntimeScopeString;

export type RuntimeEngine = "codex" | "claude";
export type RuntimeHostKind = "codex-app-server" | "claude-broker" | "tmux-legacy" | "unhosted";
export type RuntimeHostAxis = "registering" | "hosted" | "recovering" | "unhosted" | "conflict" | "dead";
export type RuntimeTurnAxis = "unknown" | "idle" | "running" | "interrupt_requested";
export type RuntimeProvenance = "structured" | "derived" | "replayed";
export type RuntimeAttentionAxis = "none" | "approval" | "permission" | "question" | "waiting_heuristic";
export type ScopeType = RuntimeScopeKind;
export type EventScope = RuntimeScope;
export type HostKind = RuntimeHostKind;
export type HostAxis = RuntimeHostAxis;
export type TurnAxis = RuntimeTurnAxis;
export type Provenance = RuntimeProvenance;

export interface RuntimeSessionAxes {
  host: RuntimeHostAxis;
  turn: RuntimeTurnAxis;
  attention: RuntimeAttentionAxis;
  freshness: RuntimeProvenance | "stale";
}

export type RuntimeAttentionKind = "approval" | "permission" | "question" | "waiting_heuristic";
export type RuntimeAttentionState = "open" | "resolving" | "resolved" | "expired-confirmed" | "cancelled" | "resolution-unknown";
export type RuntimeOperationKind = "send" | "steer" | "interrupt" | "answer" | "spawn";
export type RuntimeReceiptStatus =
  | "pending"
  | "turn-started"
  | "steered"
  | "queued"
  | "delivered"
  | "interrupted"
  | "answered"
  | "rejected"
  | "failed"
  | "uncertain";
export type OperationKind = RuntimeOperationKind;
export type ReceiptStatus = RuntimeReceiptStatus;

export type RuntimeEventKind =
  | "session-status"
  | "turn-started"
  | "turn-ended"
  | "item"
  | "attention"
  | "attention-resolved"
  | "limits"
  | "receipt"
  | "edge.created"
  | "flow.state"
  | "workflow.state"
  | "task.state"
  | "reconcile.drift"
  | "files.revision"
  | (string & {});

export interface RuntimeProducer {
  kind: string;
  accountId?: string | null;
  eventKey?: string;
  hostEpoch?: number;
}

export interface RuntimeEffect {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RuntimeEventInput {
  scope: RuntimeScopeInput;
  kind: string;
  payload: Record<string, unknown>;
  producer?: RuntimeProducer;
  producerKey?: string;
  operationId?: string;
  effect?: RuntimeEffect;
  occurredAt?: string;
  causationId?: string | null;
  correlationId?: string | null;
}

export interface NormalizedRuntimeEventInput extends Omit<RuntimeEventInput, "scope" | "kind" | "producer"> {
  scope: RuntimeScope;
  kind: RuntimeEventKind;
  producer: RuntimeProducer;
}

export interface RuntimeEvent {
  schemaVersion: number;
  seq: number;
  eventId: string;
  scope: RuntimeScope;
  revision: number;
  kind: RuntimeEventKind;
  occurredAt: string;
  recordedAt: string;
  producer: RuntimeProducer;
  causationId: string | null;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export type RuntimeEnvelope<P = Record<string, unknown>> = Omit<RuntimeEvent, "payload"> & { payload: P };

export interface RuntimeAttentionRequest {
  title?: string;
  command?: string;
  tool?: string;
  detail?: string;
  question?: {
    header?: string;
    prompt: string;
    options?: Array<{ label: string; description?: string; recommended?: boolean }>;
    multiSelect?: boolean;
  };
}

export interface RuntimeAttention {
  id: string;
  conversationId: string;
  kind: RuntimeAttentionKind;
  state: RuntimeAttentionState;
  unowned: boolean;
  createdAt: string;
  request: RuntimeAttentionRequest;
  autoResolutionMs?: number | null;
  turnId?: string | null;
}

export interface RuntimeOperationReceipt {
  operationId: string;
  idempotencyKey: string;
  conversationId: string;
  kind: RuntimeOperationKind;
  status: RuntimeReceiptStatus;
  turnId?: string | null;
  queuePosition?: number | null;
  reason?: string | null;
  text?: string | null;
  at: string;
  revision: number;
}
export type RuntimeReceipt = RuntimeOperationReceipt;

interface RuntimeCommandBase {
  kind: RuntimeOperationKind;
  conversationId: string;
  operationId?: string;
  idempotencyKey: string;
}

export interface RuntimeSendCommand extends RuntimeCommandBase {
  kind: "send" | "steer";
  text: string;
  images?: string[];
  policy?: "queue" | "steer-if-active";
  turnId?: string | null;
}

export interface RuntimeInterruptCommand extends RuntimeCommandBase {
  kind: "interrupt";
  turnId?: string | null;
}

export interface RuntimeAnswerCommand extends RuntimeCommandBase {
  kind: "answer";
  attentionId: string;
  resolution: unknown;
}

export interface RuntimeSpawnCommand extends RuntimeCommandBase {
  kind: "spawn";
  engine: RuntimeEngine;
  cwd: string;
  prompt: string;
  accountId?: string | null;
  parentConversationId?: string | null;
  sessionId?: string | null;
}

export type RuntimeOperationCommand = RuntimeSendCommand | RuntimeInterruptCommand | RuntimeAnswerCommand | RuntimeSpawnCommand;

export interface RuntimeOperationResult {
  operationId: string;
  receipt: RuntimeOperationReceipt;
  replayed: boolean;
}

export class RuntimeIdempotencyConflictError extends Error {
  readonly code = "idempotency-conflict";
}

export interface RuntimeEdge {
  id: string;
  kind: string;
  parentConversationId: string;
  childConversationId: string;
  createdByOperationId?: string | null;
  revision: number;
  createdAt: string;
}

export interface RuntimeDrift {
  conversationId: string;
  evidence: string;
  at: string;
}

export interface RuntimeSession {
  conversationId: string;
  sessionKey: { engine: RuntimeEngine; sessionId: string };
  hostKind: RuntimeHostKind;
  host: RuntimeHostAxis;
  turn: RuntimeTurnAxis;
  provenance: RuntimeProvenance;
  revision: number;
  attentionIds: string[];
  recentReceipts: RuntimeOperationReceipt[];
  accountId: string | null;
  parentConversationId: string | null;
  flowId: string | null;
  workflowId: string | null;
  cwd: string | null;
  artifactPath: string | null;
  capabilities: { steer: boolean; structuredAttention: boolean };
  activeTurnId: string | null;
  drift?: RuntimeDrift | null;
}

export interface ScopedEntity<T> {
  revision: number;
  value: T;
}

export interface RuntimeSnapshot {
  schemaVersion: number;
  snapshotSeq: number;
  retentionFloorSeq: number;
  serverTime: string;
  runtime: { hostEpoch: number; health: string };
  filesRevision: number;
  sessions: RuntimeSession[];
  attentions: RuntimeAttention[];
  recentOperations: RuntimeOperationReceipt[];
  edges: RuntimeEdge[];
  flows: ScopedEntity<Flow>[];
  workflows: ScopedEntity<Workflow>[];
  tasks: ScopedEntity<BoardTask>[];
  deployments: ViewerDeploymentStatus[];
}

export type ViewerDeploymentPhase =
  | "admitted"
  | "building"
  | "candidate-starting"
  | "candidate-health"
  | "promoting"
  | "post-promotion-health"
  | "rolling-back"
  | "succeeded"
  | "rolled-back"
  | "failed";

export interface ViewerReleaseIdentity {
  image: string;
  container: string;
  endpoint: string;
  revision: string;
}

export interface ViewerHealthEvidence {
  checkedAt: string;
  endpoint: string;
  processReady: boolean;
  rootStatus: number;
  authenticatedStatus: number | null;
  unauthorizedStatus: number | null;
  assets: Array<{ path: string; status: number }>;
  ok: boolean;
  detail?: string;
}

export interface ViewerDeploymentOwner {
  pid: number;
  startIdentity: string | null;
}

export interface ViewerDeploymentStatus {
  deploymentId: string;
  idempotencyKey: string;
  requestedRevision: string;
  revision: string;
  phase: ViewerDeploymentPhase;
  terminal: boolean;
  candidate: ViewerReleaseIdentity | null;
  previous: ViewerReleaseIdentity | null;
  health: ViewerHealthEvidence[];
  error: string | null;
  owner: ViewerDeploymentOwner;
  createdAt: string;
  updatedAt: string;
  revisionNumber: number;
}

export interface ViewerDeploymentRequest {
  revision?: string;
  idempotencyKey: string;
}

export type ViewerDeploymentReceipt =
  | { state: "accepted"; deploymentId: string; revision: string; replayed: boolean }
  | { state: "busy"; deploymentId: string; revision: string };

export interface RuntimeReplay {
  reset: boolean;
  floorSeq: number;
  events: RuntimeEvent[];
}

export interface RuntimeSocketRequest {
  id: string;
  method: "snapshot" | "events" | "wait" | "append" | "operation" | "command" | "operation-status" | "viewer-deployment-request" | "viewer-deployment-read";
  params?: Record<string, unknown>;
}

export interface RuntimeSocketResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

const KIND_ALIASES: Record<string, RuntimeEventKind> = {
  "host.connected": "session-status",
  "host.disconnected": "session-status",
  "host.degraded": "session-status",
  "session.status": "session-status",
  "turn.started": "turn-started",
  "turn.completed": "turn-ended",
  "turn.interrupted": "turn-ended",
  "turn.recovery-needed": "session-status",
  "item.started": "item",
  "item.completed": "item",
  "attention.requested": "attention",
  "attention.resolved": "attention-resolved",
  "operation.receipt": "receipt",
  "flow.ready": "flow.state",
};

export function canonicalRuntimeKind(kind: string): RuntimeEventKind {
  return KIND_ALIASES[kind] ?? kind;
}

export function runtimeScope(type: RuntimeScopeKind, id: string): RuntimeScope {
  if (!RUNTIME_SCOPE_KINDS.includes(type)) throw new Error("runtime scope type is invalid");
  if (!id || id.length > 200 || id.includes(":") || /\s/.test(id)) throw new Error("runtime scope id is invalid");
  return { type, id };
}

export function parseRuntimeScope(scope: RuntimeScopeInput): RuntimeScope {
  if (typeof scope !== "string") return runtimeScope(scope.type, scope.id);
  const separator = scope.indexOf(":");
  if (separator < 1) throw new Error("runtime event scope is invalid");
  const type = scope.slice(0, separator) as RuntimeScopeKind;
  if (!RUNTIME_SCOPE_KINDS.includes(type)) throw new Error("runtime event scope is invalid");
  return runtimeScope(type, scope.slice(separator + 1));
}

export function runtimeScopeKey(scope: RuntimeScopeInput): RuntimeScopeString {
  const parsed = parseRuntimeScope(scope);
  return `${parsed.type}:${parsed.id}`;
}

function compatibilityPayload(input: RuntimeEventInput, kind: RuntimeEventKind): Record<string, unknown> {
  const payload = { ...input.payload };
  if (kind === "session-status") {
    if (input.kind === "host.connected") Object.assign(payload, { host: "hosted", provenance: "structured" });
    if (input.kind === "host.disconnected") Object.assign(payload, { host: "recovering", turn: "unknown", provenance: "replayed" });
    if (input.kind === "host.degraded") Object.assign(payload, { host: "unhosted", turn: "unknown", provenance: "derived" });
    if (input.kind === "turn.recovery-needed") Object.assign(payload, { turn: "unknown", host: "recovering", provenance: "replayed" });
  }
  if (kind === "turn-ended" && input.kind === "turn.interrupted" && payload.outcome === undefined) payload.outcome = "interrupted";
  if (kind === "item" && payload.phase === undefined) payload.phase = input.kind.endsWith("started") ? "started" : "completed";
  return payload;
}

export function normalizeRuntimeEventInput(input: RuntimeEventInput): NormalizedRuntimeEventInput {
  const kind = canonicalRuntimeKind(input.kind);
  const producer: RuntimeProducer = {
    kind: input.producer?.kind ?? "viewer-compat",
    ...(input.producer?.accountId !== undefined ? { accountId: input.producer.accountId } : {}),
    ...(input.producer?.hostEpoch !== undefined ? { hostEpoch: input.producer.hostEpoch } : {}),
    ...((input.producer?.eventKey ?? input.producerKey) ? { eventKey: input.producer?.eventKey ?? input.producerKey } : {}),
  };
  return {
    ...input,
    scope: parseRuntimeScope(input.scope),
    kind,
    payload: compatibilityPayload(input, kind),
    producer,
  };
}

/** Viewer identity remains stable across host and artifact replacement. */
export function viewerConversationId(engine: RuntimeEngine, transcriptPath: string): string {
  if (!transcriptPath) throw new Error("transcript path is required for a Viewer conversation id");
  return `${engine}_${createHash("sha256").update(transcriptPath).digest("hex").slice(0, 24)}`;
}

export function newOperationId(): string {
  return `op_${randomUUID()}`;
}

export function axesForEvent(current: RuntimeSessionAxes, event: Pick<RuntimeEventInput, "kind" | "payload">): RuntimeSessionAxes {
  const next = { ...current };
  const normalized = normalizeRuntimeEventInput({ ...event, scope: runtimeScope("system", "axes") });
  if (normalized.kind === "session-status") {
    const host = normalized.payload.host;
    if (host === "registering" || host === "hosted" || host === "recovering" || host === "unhosted" || host === "conflict" || host === "dead") next.host = host;
    const turn = normalized.payload.turn;
    if (turn === "unknown" || turn === "idle" || turn === "running" || turn === "interrupt_requested") next.turn = turn;
    const provenance = normalized.payload.provenance;
    if (provenance === "structured" || provenance === "derived" || provenance === "replayed") next.freshness = provenance;
  }
  if (normalized.kind === "turn-started") next.turn = "running";
  if (normalized.kind === "turn-ended") next.turn = "idle";
  if (normalized.kind === "attention") {
    const kind = normalized.payload.kind;
    next.attention = kind === "approval" || kind === "permission" || kind === "question" || kind === "waiting_heuristic" ? kind : "question";
  }
  if (normalized.kind === "attention-resolved") next.attention = "none";
  return next;
}

export function assertRuntimeEvent(input: RuntimeEventInput): void {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("runtime event payload is invalid");
  const normalized = normalizeRuntimeEventInput(input);
  if (!/^[a-z][a-z0-9._-]{1,120}$/.test(normalized.kind)) throw new Error("runtime event kind is invalid");
  if (Buffer.byteLength(JSON.stringify(normalized.payload)) > 16 * 1024) throw new Error("runtime event payload exceeds 16 KiB");
}
