import { createHash, randomUUID } from "node:crypto";

export const RUNTIME_SCOPE_KINDS = ["session", "flow", "workflow", "task", "operation", "edge", "account", "system"] as const;
export type RuntimeScopeKind = (typeof RUNTIME_SCOPE_KINDS)[number];
export type RuntimeScope = `${RuntimeScopeKind}:${string}`;

export type RuntimeHostAxis = "starting" | "running" | "reconnecting" | "degraded" | "offline" | "unknown";
export type RuntimeTurnAxis = "none" | "running" | "completed" | "interrupted" | "recovering";
export type RuntimeAttentionAxis = "none" | "approval" | "permission" | "question";

export interface RuntimeSessionAxes {
  host: RuntimeHostAxis;
  turn: RuntimeTurnAxis;
  attention: RuntimeAttentionAxis;
  freshness: "fresh" | "stale" | "resynced";
}

export interface RuntimeEventInput {
  scope: RuntimeScope;
  kind: string;
  payload: Record<string, unknown>;
  producerKey?: string;
  operationId?: string;
  effect?: RuntimeEffect;
}

export interface RuntimeEvent extends RuntimeEventInput {
  seq: number;
  revision: number;
  createdAt: number;
  prevHash: string;
  hash: string;
}

export interface RuntimeEffect {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RuntimeOperationReceipt {
  operationId: string;
  state: "accepted" | "completed" | "failed";
  seq: number;
  revision: number;
}

export interface RuntimeSnapshot {
  snapshotSeq: number;
  scopes: Record<string, { revision: number; state: Record<string, unknown> }>;
}

export interface RuntimeReplay {
  reset: boolean;
  floorSeq: number;
  events: RuntimeEvent[];
}

export interface RuntimeSocketRequest {
  id: string;
  method: "snapshot" | "events" | "append" | "operation";
  params?: Record<string, unknown>;
}

export interface RuntimeSocketResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function runtimeScope(kind: RuntimeScopeKind, id: string): RuntimeScope {
  if (!id || id.includes(":")) throw new Error("runtime scope id is invalid");
  return `${kind}:${id}`;
}

/** Viewer identity remains stable across process and transcript-host replacement. */
export function viewerConversationId(engine: "codex" | "claude", transcriptPath: string): string {
  if (!transcriptPath) throw new Error("transcript path is required for a Viewer conversation id");
  return `${engine}_${createHash("sha256").update(transcriptPath).digest("hex").slice(0, 24)}`;
}

export function newOperationId(): string {
  return randomUUID();
}

export function axesForEvent(current: RuntimeSessionAxes, event: Pick<RuntimeEventInput, "kind" | "payload">): RuntimeSessionAxes {
  const next = { ...current };
  if (event.kind === "host.connected") next.host = "running";
  if (event.kind === "host.disconnected") next.host = "reconnecting";
  if (event.kind === "host.degraded") next.host = "degraded";
  if (event.kind === "turn.started") next.turn = "running";
  if (event.kind === "turn.completed") next.turn = "completed";
  if (event.kind === "turn.interrupted") next.turn = "interrupted";
  if (event.kind === "turn.recovery-needed") next.turn = "recovering";
  if (event.kind === "attention.requested") {
    const kind = event.payload.kind;
    next.attention = kind === "approval" || kind === "permission" || kind === "question" ? kind : "question";
  }
  if (event.kind === "attention.resolved") next.attention = "none";
  if (event.kind === "session.resynced") next.freshness = "resynced";
  return next;
}

export function assertRuntimeEvent(input: RuntimeEventInput): void {
  if (!/^([a-z]+):[^:\s]+$/.test(input.scope)) throw new Error("runtime event scope is invalid");
  if (!/^[a-z][a-z0-9._-]{1,120}$/.test(input.kind)) throw new Error("runtime event kind is invalid");
  if (!input.payload || Array.isArray(input.payload)) throw new Error("runtime event payload is invalid");
  if (Buffer.byteLength(JSON.stringify(input.payload)) > 128 * 1024) throw new Error("runtime event payload exceeds 128 KiB");
}
