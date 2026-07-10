/**
 * Contained client contract for the runtime event bus (issue #25, slice one).
 *
 * This mirrors the frozen Sol wire types (`/api/runtime/snapshot` +
 * `/api/runtime/stream?after=<seq>`) and the Fable product state vocabulary so
 * the frontend can be built and tested before Terra's
 * `src/lib/runtime/contracts.ts` lands. When that module merges, the type
 * aliases and the reducer here re-point at it with no change to the components
 * or hooks that consume this file. Everything below is a pure client model —
 * no I/O, no React — so the ordering, revision-guard, and receipt logic is
 * deterministically testable.
 *
 * Ordering rule (Sol, frozen): the journal assigns one global monotonic `seq`;
 * every scoped event also carries a consecutive `revision` within its scope. A
 * consumer applies an event iff `revision === currentRevision + 1`; a lower
 * revision is a duplicate/reorder and drops idempotently; a higher revision is
 * a gap and forces a fresh snapshot. There is no second ordering authority.
 */

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Activity } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

/* ------------------------------------------------------------------ *
 * Vocabulary (frozen)                                                 *
 * ------------------------------------------------------------------ */

export type RuntimeEngine = "codex" | "claude";

/** Where a session's structured plane lives. Legacy tmux is always degraded. */
export type HostKind = "codex-app-server" | "claude-broker" | "tmux-legacy" | "unhosted";

/** Orthogonal host axis (Sol). Never collapsed into the linear state. */
export type HostAxis = "registering" | "hosted" | "recovering" | "unhosted" | "conflict" | "dead";

/** Orthogonal turn axis (Sol). `unknown` after a host crash mid-tool. */
export type TurnAxis = "unknown" | "idle" | "running" | "interrupt_requested";

/**
 * How fresh/trustworthy the projected state is. `derived` marks legacy
 * scanner/tmux inference; `replayed` marks journal-reconstructed state after a
 * restart until the first live event confirms it. Legacy sessions always show
 * `derived` — the task's "degraded provenance" requirement.
 */
export type Provenance = "structured" | "derived" | "replayed";

/**
 * The linear runtime state the UI renders, derived from the orthogonal axes by
 * {@link deriveSessionState}. Not carried on the wire — the wire carries axes.
 */
export type SessionUiState =
  | "dead"
  | "conflict"
  | "recovering"
  | "unhosted"
  | "waiting_input"
  | "working"
  | "idle"
  | "unknown";

export type AttentionKind = "approval" | "permission" | "question" | "waiting_heuristic";

export type AttentionState =
  | "open"
  | "resolving"
  | "resolved"
  | "expired-confirmed"
  | "cancelled"
  | "resolution-unknown";

/**
 * Command receipt status shown inline on the message (Fable command lifecycle
 * mapped onto Sol operation outcomes). `pending` is the in-flight POST before
 * any journaled receipt arrives.
 */
export type ReceiptStatus =
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

export type OperationKind = "send" | "steer" | "interrupt" | "answer" | "spawn";

/** Client connection state (Fable §2). `resynced` is a transient note, not a state. */
export type ConnectionState = "live" | "reconnecting" | "degraded" | "offline";

/** All durable wire event kinds the UI observes. Unknown kinds are applied as
 *  revision-advancing no-ops so a future producer never manufactures a gap. */
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
  | "reconcile.drift"
  | "files.revision"
  | (string & {});

export type ScopeType = "session" | "flow" | "workflow" | "task" | "operation" | "edge" | "account" | "system";

/* ------------------------------------------------------------------ *
 * Wire envelope + payloads (match Sol)                                *
 * ------------------------------------------------------------------ */

export interface EventScope {
  type: ScopeType;
  id: string;
}

export interface RuntimeEnvelope<P = unknown> {
  schemaVersion: number;
  seq: number;
  eventId: string;
  scope: EventScope;
  /** Consecutive within `scope`. Absent only on non-scoped system events. */
  revision?: number;
  kind: RuntimeEventKind;
  occurredAt?: string;
  recordedAt?: string;
  producer?: {
    kind: string;
    accountId?: string | null;
    eventKey?: string;
    hostEpoch?: number;
  };
  causationId?: string | null;
  correlationId?: string | null;
  payload: P;
}

/** Structured attention request — the real command/tool, never a scraped menu. */
export interface AttentionRequest {
  title?: string;
  /** Approval command text (`approval` kind). */
  command?: string;
  /** Tool name (`permission`/`can_use_tool`). */
  tool?: string;
  detail?: string;
  /** Structured AskUserQuestion / requestUserInput payload. */
  question?: {
    header?: string;
    prompt: string;
    options?: { label: string; description?: string; recommended?: boolean }[];
    multiSelect?: boolean;
  };
}

export interface RuntimeAttention {
  id: string;
  conversationId: string;
  kind: AttentionKind;
  state: AttentionState;
  /** No attached approval owner — a first-class alarm at the queue head. */
  unowned: boolean;
  createdAt: string;
  request: AttentionRequest;
  /** Countdown for `item/tool/requestUserInput`; null when it never expires. */
  autoResolutionMs?: number | null;
  turnId?: string | null;
}

export interface RuntimeReceipt {
  operationId: string;
  idempotencyKey: string;
  conversationId: string;
  kind: OperationKind;
  status: ReceiptStatus;
  turnId?: string | null;
  queuePosition?: number | null;
  /** Sanitized rejected/failed reason, shown verbatim. */
  reason?: string | null;
  /** Message text for inline display (bounded summary). */
  text?: string | null;
  at: string;
  revision: number;
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
  /** Human-readable evidence string; never auto-mutates the board. */
  evidence: string;
  at: string;
}

export interface RuntimeSession {
  conversationId: string;
  sessionKey: { engine: RuntimeEngine; sessionId: string };
  hostKind: HostKind;
  host: HostAxis;
  turn: TurnAxis;
  provenance: Provenance;
  revision: number;
  /** Open attention ids on this session (records live in the store map). */
  attentionIds: string[];
  /** Most-recent-first bounded receipts recovered on reload. */
  recentReceipts: RuntimeReceipt[];
  accountId: string | null;
  parentConversationId: string | null;
  flowId: string | null;
  workflowId: string | null;
  cwd: string | null;
  artifactPath: string | null;
  capabilities: { steer: boolean; structuredAttention: boolean };
  activeTurnId: string | null;
  /** Unresolved drift notice, if any. */
  drift?: RuntimeDrift | null;
}

/**
 * The compatibility-shaped flow/workflow/task payloads carry no revision of
 * their own, so the snapshot pairs each with its scope revision. That lets the
 * client seed the scope head and demand exactly `revision + 1` from the first
 * streamed `flow.state`, instead of treating it as a false gap.
 */
export interface ScopedEntity<T> {
  revision: number;
  value: T;
}

export interface RuntimeSnapshot {
  schemaVersion: number;
  snapshotSeq: number;
  retentionFloorSeq: number;
  serverTime?: string;
  runtime: { hostEpoch: number; health: string };
  filesRevision: number;
  sessions: RuntimeSession[];
  attentions: RuntimeAttention[];
  recentOperations: RuntimeReceipt[];
  edges: RuntimeEdge[];
  flows: ScopedEntity<Flow>[];
  workflows: ScopedEntity<Workflow>[];
  tasks: ScopedEntity<BoardTask>[];
}

/* ------------------------------------------------------------------ *
 * Client store                                                        *
 * ------------------------------------------------------------------ */

export interface RuntimeStore {
  /** Last applied global seq — the reconnect cursor. */
  cursor: number;
  retentionFloorSeq: number;
  filesRevision: number;
  hostEpoch: number;
  health: string;
  /** `${scopeType}:${scopeId}` → current revision. The gap authority. */
  scopeHeads: Record<string, number>;
  sessions: Record<string, RuntimeSession>;
  attentions: Record<string, RuntimeAttention>;
  operations: Record<string, RuntimeReceipt>;
  edges: Record<string, RuntimeEdge>;
  flows: Record<string, Flow>;
  workflows: Record<string, Workflow>;
  tasks: Record<string, BoardTask>;
}

/** Most recent receipts kept per session on the client (Fable "last N"). */
export const RECENT_RECEIPTS_CAP = 8;

export function emptyStore(): RuntimeStore {
  return {
    cursor: 0,
    retentionFloorSeq: 0,
    filesRevision: 0,
    hostEpoch: 0,
    health: "unknown",
    scopeHeads: {},
    sessions: {},
    attentions: {},
    operations: {},
    edges: {},
    flows: {},
    workflows: {},
    tasks: {},
  };
}

function scopeKey(scope: EventScope): string {
  return `${scope.type}:${scope.id}`;
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of list) out[item.id] = item;
  return out;
}

/**
 * Build a fresh store from a snapshot: install every projected scope and seed
 * each scope head from its entity revision so the first streamed event for a
 * scope must be exactly `revision + 1`.
 */
export function installSnapshot(snapshot: RuntimeSnapshot): RuntimeStore {
  const scopeHeads: Record<string, number> = {};
  const sessions: Record<string, RuntimeSession> = {};
  for (const session of snapshot.sessions) {
    sessions[session.conversationId] = { ...session, attentionIds: [...session.attentionIds], recentReceipts: [...session.recentReceipts] };
    scopeHeads[`session:${session.conversationId}`] = session.revision;
  }
  const operations: Record<string, RuntimeReceipt> = {};
  for (const op of snapshot.recentOperations) {
    operations[op.operationId] = op;
    scopeHeads[`operation:${op.operationId}`] = op.revision;
  }
  const edges: Record<string, RuntimeEdge> = {};
  for (const edge of snapshot.edges) {
    edges[edge.id] = edge;
    scopeHeads[`edge:${edge.id}`] = edge.revision;
  }
  const flows: Record<string, Flow> = {};
  for (const { revision, value } of snapshot.flows) {
    flows[value.id] = value;
    scopeHeads[`flow:${value.id}`] = revision;
  }
  const workflows: Record<string, Workflow> = {};
  for (const { revision, value } of snapshot.workflows) {
    workflows[value.id] = value;
    scopeHeads[`workflow:${value.id}`] = revision;
  }
  const tasks: Record<string, BoardTask> = {};
  for (const { revision, value } of snapshot.tasks) {
    tasks[value.id] = value;
    scopeHeads[`task:${value.id}`] = revision;
  }
  return {
    cursor: snapshot.snapshotSeq,
    retentionFloorSeq: snapshot.retentionFloorSeq,
    filesRevision: snapshot.filesRevision,
    hostEpoch: snapshot.runtime.hostEpoch,
    health: snapshot.runtime.health,
    scopeHeads,
    sessions,
    attentions: byId(snapshot.attentions),
    operations,
    edges,
    flows,
    workflows,
    tasks,
  };
}

/* ------------------------------------------------------------------ *
 * Reducer                                                             *
 * ------------------------------------------------------------------ */

export type ApplyResult =
  /** Event applied; `store` is a new object. `filesBumped` asks the caller to
   *  fetch `/api/files` (debounced). */
  | { outcome: "applied"; store: RuntimeStore; filesBumped: boolean }
  /** Older/equal revision or already-seen seq — dropped idempotently. */
  | { outcome: "duplicate" }
  /** Revision skipped ahead of this scope — the caller must resnapshot. */
  | { outcome: "gap"; scope: string; expected: number; got: number };

/**
 * Apply one durable envelope under the strict consecutive-revision rule.
 * Deterministic: shuffled, duplicated, and gapped delivery all converge — a
 * duplicate is a no-op, a gap never mutates state and signals resnapshot.
 */
export function applyEvent(store: RuntimeStore, env: RuntimeEnvelope): ApplyResult {
  // Non-scoped, monotonic files signal: not under the per-scope revision guard.
  if (env.kind === "files.revision") {
    const next = readFilesRevision(env.payload);
    if (next <= store.filesRevision) return { outcome: "duplicate" };
    return { outcome: "applied", store: { ...store, filesRevision: next, cursor: Math.max(store.cursor, env.seq) }, filesBumped: true };
  }

  // Global seq already consumed: a straight duplicate from an overlapping resume.
  if (env.seq <= store.cursor) return { outcome: "duplicate" };

  const key = scopeKey(env.scope);
  const current = store.scopeHeads[key] ?? 0;
  const revision = env.revision ?? current + 1;

  if (revision <= current) return { outcome: "duplicate" };
  if (revision > current + 1) return { outcome: "gap", scope: key, expected: current + 1, got: revision };

  const next: RuntimeStore = {
    ...store,
    cursor: env.seq,
    scopeHeads: { ...store.scopeHeads, [key]: revision },
  };
  reduceKnown(next, env, revision);
  return { outcome: "applied", store: next, filesBumped: false };
}

function readFilesRevision(payload: unknown): number {
  if (payload && typeof payload === "object" && "filesRevision" in payload) {
    const value = (payload as { filesRevision: unknown }).filesRevision;
    if (typeof value === "number") return value;
  }
  return 0;
}

/** Mutate the (already-cloned) store for a known event kind. Unknown kinds are
 *  intentionally ignored — the revision head still advanced above. */
function reduceKnown(store: RuntimeStore, env: RuntimeEnvelope, revision: number): void {
  switch (env.kind) {
    case "session-status": {
      const p = env.payload as Partial<RuntimeSession> & { conversationId?: string };
      const id = p.conversationId ?? env.scope.id;
      const prev = store.sessions[id];
      const merged: RuntimeSession = {
        ...(prev ?? baseSession(id, p)),
        ...p,
        conversationId: id,
        revision,
        // never let a status payload silently drop live sub-projections
        attentionIds: p.attentionIds ?? prev?.attentionIds ?? [],
        recentReceipts: prev?.recentReceipts ?? [],
      };
      store.sessions = { ...store.sessions, [id]: merged };
      break;
    }
    case "turn-started": {
      const p = env.payload as { conversationId?: string; turnId?: string };
      updateSession(store, p.conversationId ?? env.scope.id, revision, (s) => ({
        ...s,
        turn: "running",
        activeTurnId: p.turnId ?? s.activeTurnId,
      }));
      break;
    }
    case "turn-ended": {
      const p = env.payload as { conversationId?: string; outcome?: string };
      updateSession(store, p.conversationId ?? env.scope.id, revision, (s) => ({
        ...s,
        turn: "idle",
        activeTurnId: null,
      }));
      break;
    }
    case "attention": {
      const att = env.payload as RuntimeAttention;
      store.attentions = { ...store.attentions, [att.id]: att };
      updateSession(store, att.conversationId, revision, (s) =>
        s.attentionIds.includes(att.id) ? s : { ...s, attentionIds: [...s.attentionIds, att.id] },
      );
      break;
    }
    case "attention-resolved": {
      const p = env.payload as { attentionId: string; conversationId?: string; state?: AttentionState };
      const existing = store.attentions[p.attentionId];
      if (existing) {
        store.attentions = { ...store.attentions, [p.attentionId]: { ...existing, state: p.state ?? "resolved", unowned: false } };
      }
      const convId = p.conversationId ?? existing?.conversationId;
      if (convId) {
        updateSession(store, convId, revision, (s) => ({ ...s, attentionIds: s.attentionIds.filter((id) => id !== p.attentionId) }));
      }
      break;
    }
    case "receipt": {
      const receipt = env.payload as RuntimeReceipt;
      const withRev: RuntimeReceipt = { ...receipt, revision };
      store.operations = { ...store.operations, [receipt.operationId]: withRev };
      updateSession(store, receipt.conversationId, store.sessions[receipt.conversationId]?.revision ?? 0, (s) => ({
        ...s,
        recentReceipts: mergeReceipt(s.recentReceipts, withRev),
      }));
      break;
    }
    case "edge.created": {
      const edge = env.payload as RuntimeEdge;
      store.edges = { ...store.edges, [edge.id]: { ...edge, revision } };
      break;
    }
    case "flow.state": {
      const flow = env.payload as Flow;
      store.flows = { ...store.flows, [flow.id]: flow };
      break;
    }
    case "reconcile.drift": {
      const drift = env.payload as RuntimeDrift;
      updateSession(store, drift.conversationId, revision, (s) => ({ ...s, drift }));
      break;
    }
    case "limits":
      // Account-scoped; the existing limits footer owns rendering. Head advanced.
      break;
    default:
      // Unknown/forward-compatible kind: head already advanced; no projection.
      break;
  }
}

function baseSession(id: string, p: Partial<RuntimeSession>): RuntimeSession {
  return {
    conversationId: id,
    sessionKey: p.sessionKey ?? { engine: "codex", sessionId: id },
    hostKind: p.hostKind ?? "unhosted",
    host: p.host ?? "registering",
    turn: p.turn ?? "unknown",
    provenance: p.provenance ?? "structured",
    revision: 0,
    attentionIds: [],
    recentReceipts: [],
    accountId: p.accountId ?? null,
    parentConversationId: p.parentConversationId ?? null,
    flowId: p.flowId ?? null,
    workflowId: p.workflowId ?? null,
    cwd: p.cwd ?? null,
    artifactPath: p.artifactPath ?? null,
    capabilities: p.capabilities ?? { steer: false, structuredAttention: false },
    activeTurnId: p.activeTurnId ?? null,
    drift: null,
  };
}

function updateSession(store: RuntimeStore, id: string, revision: number, fn: (s: RuntimeSession) => RuntimeSession): void {
  const prev = store.sessions[id] ?? baseSession(id, {});
  const nextRevision = revision > prev.revision ? revision : prev.revision;
  store.sessions = { ...store.sessions, [id]: { ...fn(prev), revision: nextRevision } };
}

/** Newest-first receipt merge, idempotent on operationId, bounded. */
function mergeReceipt(list: RuntimeReceipt[], receipt: RuntimeReceipt): RuntimeReceipt[] {
  const filtered = list.filter((r) => r.operationId !== receipt.operationId);
  return [receipt, ...filtered].slice(0, RECENT_RECEIPTS_CAP);
}

/* ------------------------------------------------------------------ *
 * Adapters (client view models)                                      *
 * ------------------------------------------------------------------ */

/** Sol's derivation precedence over the orthogonal axes. */
export function deriveSessionState(session: RuntimeSession, hasBlockingAttention: boolean): SessionUiState {
  if (session.host === "dead") return "dead";
  if (session.host === "conflict") return "conflict";
  if (session.host === "recovering") return "recovering";
  if (session.host === "unhosted") return "unhosted";
  if (hasBlockingAttention) return "waiting_input";
  if (session.turn === "running" || session.turn === "interrupt_requested") return "working";
  if (session.turn === "idle") return "idle";
  return "unknown";
}

export function sessionIsLegacy(session: RuntimeSession): boolean {
  return session.hostKind === "tmux-legacy";
}

/**
 * Map a hosted session's derived state onto the board's `Activity` dot so the
 * scheme node's indicator comes from `session-status` events instead of the
 * poll-derived `activity` (Fable §7). Legacy nodes keep today's derivation and
 * never call this.
 */
export function runtimeActivity(state: SessionUiState): Activity {
  if (state === "working") return "live";
  if (state === "waiting_input" || state === "conflict") return "stalled";
  if (state === "idle" || state === "dead") return "idle";
  return "recent"; // recovering / unhosted / unknown — transitional
}

/** Open attention records for a session, unowned alarms first (Fable R10-5). */
export function openAttentions(store: RuntimeStore, session: RuntimeSession): RuntimeAttention[] {
  const open = session.attentionIds
    .map((id) => store.attentions[id])
    .filter((a): a is RuntimeAttention => Boolean(a) && a.state === "open");
  return open.sort((a, b) => Number(b.unowned) - Number(a.unowned) || a.createdAt.localeCompare(b.createdAt));
}

export function hasBlockingAttention(store: RuntimeStore, session: RuntimeSession): boolean {
  return session.attentionIds.some((id) => store.attentions[id]?.state === "open");
}

/** A receipt is terminal once no further transition is expected. */
export function receiptIsTerminal(status: ReceiptStatus): boolean {
  return status === "delivered" || status === "answered" || status === "rejected" || status === "failed" || status === "interrupted";
}

/**
 * Mint an idempotency key for a fresh message draft. Same key must be reused on
 * Retry (never re-sends server-side) and replaced on Edit-and-resend.
 */
export function mintIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `op_${crypto.randomUUID()}`;
  // Deterministic fallback for environments without WebCrypto (never in prod).
  return `op_${Math.abs(hashString(String(performanceNow()))).toString(36)}`;
}

function performanceNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return 0;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  return hash;
}
