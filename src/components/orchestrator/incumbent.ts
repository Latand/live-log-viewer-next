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
    context: contextOf(raw.context),
    transcriptFacts: transcriptOf(raw.transcriptFacts),
    rotation: rotationOf(raw.rotation),
  };
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
