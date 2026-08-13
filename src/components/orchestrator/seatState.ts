import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

/*
 * The orchestrator panel's state machine, as a pure module (PRD #976 slice A).
 *
 * The panel has SIX states and every one of them gets a deliberate rendering —
 * that is the operator's explicit requirement, and the reason the derivation
 * lives here rather than as branches inside JSX: a state that cannot be named
 * cannot be designed, and one that is never derived is silently unreachable.
 *
 *   empty/draft → creating → live → stalled/dead → rotation-recommended
 *                                              ↘ intent-error
 *
 * `intent-error` is never a dead end and never hidden. With no incumbent it IS
 * the panel; with one, it rides ALONGSIDE the live conversation
 * (`OrchestratorLiveState.transition`) so a failed transition can be read and
 * retried without taking the conversation away.
 */

/** `GET /api/orchestrator/seat?project=…`, as the client reads it. */
export interface OrchestratorSeatStatus {
  seat: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  /** False once the active seat's transcript has left the disk — the operator
      closed the conversation card, so the panel returns to the draft. */
  exists: boolean;
}

/** Crash-safe read of the seat route's body: anything malformed reads as «no
    seat», which lands the panel on the draft rather than on a broken render. */
export function parseSeatStatus(body: unknown): OrchestratorSeatStatus {
  const raw = body as { seat?: unknown; pending?: unknown; exists?: unknown } | null;
  return {
    seat: seatOf(raw?.seat),
    pending: seatOf(raw?.pending),
    exists: raw?.exists !== false,
  };
}

function seatOf(value: unknown): OrchestratorSeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seat = value as Partial<OrchestratorSeat>;
  const intent = seat.intent as Partial<OrchestratorSeat["intent"]> | undefined;
  if (typeof seat.project !== "string" || typeof seat.mandate !== "string") return null;
  if (seat.state !== "pending" && seat.state !== "active") return null;
  if (!intent || typeof intent.clientRequestId !== "string") return null;
  if (intent.mode !== "spawn" && intent.mode !== "existing") return null;
  return {
    project: seat.project,
    seatEpoch: typeof seat.seatEpoch === "number" ? seat.seatEpoch : 0,
    conversationId: typeof seat.conversationId === "string" ? seat.conversationId : null,
    path: typeof seat.path === "string" ? seat.path : null,
    mandate: seat.mandate,
    promptVersion: typeof seat.promptVersion === "number" ? seat.promptVersion : null,
    predecessorConversationId: typeof seat.predecessorConversationId === "string" ? seat.predecessorConversationId : null,
    state: seat.state,
    intent: {
      clientRequestId: intent.clientRequestId,
      mode: intent.mode,
      launchId: typeof intent.launchId === "string" ? intent.launchId : null,
      error: typeof intent.error === "string" ? intent.error : null,
    },
    designatedAt: typeof seat.designatedAt === "string" ? seat.designatedAt : "",
    activatedAt: typeof seat.activatedAt === "string" ? seat.activatedAt : null,
  };
}

/**
 * What the last confirm attempt proved, when it did not settle.
 *
 * TERMINAL: the server recorded the failure on the durable intent (or refused
 * before touching anything), so the next attempt must carry a FRESH
 * `clientRequestId` — replaying the old one would re-deliver the original
 * mandate rather than the corrected one, because the seat command completes the
 * ORIGINAL intent on replay.
 *
 * AMBIGUOUS: transport loss or an opaque 5xx. A worker may exist, so the retry
 * replays the SAME key and converges onto the one receipt.
 */
export type SeatSubmitFailure = { kind: "terminal" | "ambiguous"; error: string };

/** A rotation ADVISORY and nothing more (`@/lib/orchestrator/health`): reaching
    the threshold changes what the panel says, never what it does. Slice B reads
    the server's full reading; slice A derives the same rule from the context
    usage the board already carries, so the state is not merely declared. */
export interface RotationHint {
  level: "recommend" | "strongly_recommend";
  /** Context usage percent behind a `strongly_recommend`, when it is known. */
  contextPercent: number | null;
  reasons: ("context" | "dead")[];
}

/** `ROTATION_THRESHOLD_FRACTION` (`@/lib/orchestrator/contextPolicy`) as a
    percentage — the same line the server's recommendation draws. */
export const ROTATION_CONTEXT_PERCENT = 50;

export type SeatLiveness = "resolving" | "live" | "stalled" | "dead";

/** A transition riding alongside a live incumbent, so a failed or in-flight
    designation is visible without the conversation disappearing. */
export type SeatTransition =
  | { kind: "creating"; launchId: string | null }
  | { kind: "error"; error: string };

export interface OrchestratorLiveState {
  kind: "live";
  seat: OrchestratorSeat;
  conversationId: string;
  liveness: SeatLiveness;
  rotation: RotationHint | null;
  transition: SeatTransition | null;
}

export type OrchestratorPanelState =
  /** The seat has not been read yet. */
  | { kind: "loading" }
  /** The seat route could not be read; nothing is claimed either way. */
  | { kind: "unavailable" }
  /** No orchestrator: the create draft. `vacated` distinguishes «the seat's
      conversation was closed» from «there has never been one». */
  | { kind: "draft"; vacated: boolean }
  /** A designation is in flight or durably pending with no terminal error. */
  | { kind: "creating"; launchId: string | null; designatedAt: string }
  /** A durable terminal error on the pending intent, with retry. */
  | { kind: "intent-error"; error: string; retry: "fresh" | "same"; designatedAt: string }
  | OrchestratorLiveState;

export function deriveOrchestratorPanelState(input: {
  /** Null until the first `GET /api/orchestrator/seat` answers. */
  status: OrchestratorSeatStatus | null;
  statusFailed: boolean;
  /** A confirm POST is on the wire right now. */
  submitting: boolean;
  submitFailure: SeatSubmitFailure | null;
  /** The seat conversation as the files feed knows it, when it does. */
  file: FileEntry | null;
  /** The runtime plane says this conversation's host is gone. */
  hostDead: boolean;
}): OrchestratorPanelState {
  const { status } = input;
  const active = status?.seat && status.exists ? status.seat : null;
  const pending = status?.pending ?? null;
  /* A client-side failure outranks the durable read only when the read has not
     caught up with it yet: the server's own record is the truth as soon as it
     shows the same error. */
  const clientError = input.submitFailure
    ? { error: input.submitFailure.error, retry: input.submitFailure.kind === "ambiguous" ? "same" as const : "fresh" as const }
    : null;
  const pendingError = pending?.intent.error ?? null;

  if (active?.conversationId) {
    return {
      kind: "live",
      seat: active,
      conversationId: active.conversationId,
      liveness: livenessOf(input.file, input.hostDead),
      rotation: rotationHintOf(input.file, input.hostDead),
      transition: input.submitting
        ? { kind: "creating", launchId: pending?.intent.launchId ?? null }
        : pendingError
          ? { kind: "error", error: pendingError }
          : clientError
            ? { kind: "error", error: clientError.error }
            : pending
              ? { kind: "creating", launchId: pending.intent.launchId }
              : null,
    };
  }

  if (input.submitting) {
    return { kind: "creating", launchId: pending?.intent.launchId ?? null, designatedAt: pending?.designatedAt ?? "" };
  }
  if (pendingError) {
    return { kind: "intent-error", error: pendingError, retry: "fresh", designatedAt: pending?.designatedAt ?? "" };
  }
  if (clientError) {
    return { kind: "intent-error", error: clientError.error, retry: clientError.retry, designatedAt: pending?.designatedAt ?? "" };
  }
  if (pending) {
    return { kind: "creating", launchId: pending.intent.launchId, designatedAt: pending.designatedAt };
  }
  if (!status) return input.statusFailed ? { kind: "unavailable" } : { kind: "loading" };
  return { kind: "draft", vacated: Boolean(status.seat) && !status.exists };
}

function livenessOf(file: FileEntry | null, hostDead: boolean): SeatLiveness {
  if (hostDead) return "dead";
  if (!file) return "resolving";
  return file.activity === "stalled" ? "stalled" : "live";
}

function rotationHintOf(file: FileEntry | null, hostDead: boolean): RotationHint | null {
  const reasons: RotationHint["reasons"] = [];
  const percent = typeof file?.ctx?.pct === "number" ? file.ctx.pct : null;
  if (percent !== null && percent >= ROTATION_CONTEXT_PERCENT) reasons.push("context");
  if (hostDead) reasons.push("dead");
  if (!reasons.length) return null;
  return {
    level: reasons.includes("context") ? "strongly_recommend" : "recommend",
    contextPercent: percent,
    reasons,
  };
}

/** The idempotency key one confirm carries. Minted once per draft submission —
    never per click — and matched to the seat route's `^[A-Za-z0-9_-]{8,128}$`. */
export function newSeatRequestId(): string {
  const raw = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128).padEnd(8, "0");
}

/** How a confirm response that is not a success classifies. A 409 «already in
    progress» is neither: the transition another request owns will settle on its
    own, and the seat poll is what reports it. */
export function classifySeatFailure(status: number, body: { error?: unknown; code?: unknown } | null): SeatSubmitFailure | null {
  const error = typeof body?.error === "string" && body.error ? body.error : `the seat route answered HTTP ${status}`;
  if (status === 409 && body?.code === "seat_intent_in_progress") return null;
  /* Every 4xx is a refusal the server recorded (or never started): editing and
     retrying is safe, and must carry a fresh key so the corrected mandate is
     the one delivered. A 5xx or a thrown fetch leaves worker existence unknown. */
  if (status >= 400 && status < 500) return { kind: "terminal", error };
  return { kind: "ambiguous", error };
}
