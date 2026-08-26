/*
 * The incumbent as the panel reads it (PRD #976 slice B).
 *
 * `GET /api/orchestrator/seat/status` answers with the same reading
 * `get_orchestrator` composes — designation, context, rotation. This module is
 * the crash-safe parse of that body and nothing else: a malformed or absent
 * field reads as «unknown», which the header renders as a quiet dash rather than
 * as a confident wrong number.
 *
 * The rotation block here is WORDS. Nothing in this module, and nothing that
 * consumes it, may act on it: the only rotation in the product is the one the
 * operator explicitly confirms in the rotate draft.
 */

export interface IncumbentContext {
  tokens: number | null;
  limit: number | null;
  /** 0-100, or null when the model has no configured window. */
  percent: number | null;
  /** TRUE means the number is derived from transcript bytes, not reported. */
  estimated: boolean;
  /** Where the number came from, operator-readable — shown in the tooltip so a
      guess can never be mistaken for a provider count. */
  basis: string;
}

export interface IncumbentRotation {
  recommended: boolean;
  level: "none" | "recommend" | "strongly_recommend";
  /** The server's own reasons, in its words. Never re-worded here. */
  reasons: string[];
  thresholdUnknown: boolean;
}

/** The liveness plane's answer for the seat's conversation, as the status read
    reports it. `hostState` is the affirmative one: «alive» is the server saying
    a host is running for this durable id, whatever the file catalog has managed
    to show yet (issue #1182). */
export interface IncumbentLiveness {
  lifecycle: string;
  hostState: string;
  silentForMs: number | null;
}

export interface IncumbentTranscript {
  bytes: number | null;
  messageCount: number | null;
  toolCount: number | null;
  compactionCount: number | null;
}

export interface OrchestratorIncumbent {
  project: string;
  /** False means the seat is vacant — the status read agrees with the seat read
      rather than holding the last incumbent on screen. */
  designated: boolean;
  conversationId: string | null;
  predecessorConversationId: string | null;
  engine: "claude" | "codex" | null;
  model: string | null;
  effort: string | null;
  accountId: string | null;
  cwd: string | null;
  /** The transcript the REGISTRY currently writes this conversation to — the
      durable id resolved through its newest generation, server-side. The seat's
      own recorded path freezes at activation, so after a re-host this is the
      only thing that names the conversation the operator is watching (#1182). */
  transcriptPath: string | null;
  liveness: IncumbentLiveness | null;
  context: IncumbentContext | null;
  transcriptFacts: IncumbentTranscript | null;
  rotation: IncumbentRotation | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Anything unreadable answers null: the header then says «reading…» instead of
    rendering a half-parsed incumbent. */
export function parseIncumbent(body: unknown): OrchestratorIncumbent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const project = str(raw.project);
  if (!project) return null;
  const engine = raw.engine === "claude" || raw.engine === "codex" ? raw.engine : null;
  return {
    project,
    designated: raw.designated === true,
    conversationId: str(raw.conversationId),
    predecessorConversationId: str(raw.predecessorConversationId),
    engine,
    model: str(raw.model),
    effort: str(raw.effort),
    accountId: str(raw.accountId),
    cwd: str(raw.cwd),
    transcriptPath: str(raw.transcriptPath),
    liveness: livenessOf(raw.liveness),
    context: contextOf(raw.context),
    transcriptFacts: transcriptOf(raw.transcriptFacts),
    rotation: rotationOf(raw.rotation),
  };
}

function livenessOf(value: unknown): IncumbentLiveness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    lifecycle: str(raw.lifecycle) ?? "",
    hostState: str(raw.hostState) ?? "",
    silentForMs: num(raw.silentForMs),
  };
}

/** Whether the status read AFFIRMS a live host for the seat it describes. Only
    «alive» counts: «unknown» is the plane not having answered, and reading that
    as live would turn a legitimate wait into an accusation (#1182). */
export function incumbentHostLive(incumbent: OrchestratorIncumbent | null): boolean {
  return Boolean(incumbent?.designated) && incumbent?.liveness?.hostState === "alive";
}

function contextOf(value: unknown): IncumbentContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    tokens: num(raw.tokens),
    limit: num(raw.limit),
    percent: num(raw.percent),
    estimated: raw.estimated !== false,
    basis: str(raw.basis) ?? "",
  };
}

function transcriptOf(value: unknown): IncumbentTranscript | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    bytes: num(raw.bytes),
    messageCount: num(raw.messageCount),
    toolCount: num(raw.toolCount),
    compactionCount: num(raw.compactionCount),
  };
}

function rotationOf(value: unknown): IncumbentRotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const level = raw.level === "recommend" || raw.level === "strongly_recommend" ? raw.level : "none";
  return {
    /* A body claiming `recommended` with no level at all still counts: the
       server's own boolean is the flag, and «none» simply keeps the softer
       wording. */
    recommended: raw.recommended === true,
    level,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((reason): reason is string => typeof reason === "string") : [],
    thresholdUnknown: raw.thresholdUnknown === true,
  };
}
