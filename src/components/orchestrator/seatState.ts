import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import type { StripSurface } from "../agentCapabilities";

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
 *
 * It carries the key it is ABOUT, so the durable read can retire it: an
 * ambiguous failure whose key the server later reports as landed is history,
 * and must stop riding along as a banner over the conversation it created.
 */
export type SeatSubmitFailure = { kind: "terminal" | "ambiguous"; error: string; clientRequestId: string };

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

/**
 * What the operator can do with the seat's conversation RIGHT NOW, projected
 * from the §4 capability matrix (`../agentCapabilities`) rather than guessed
 * from the transcript's activity — a finished root looks exactly as quiet as a
 * running one from the outside, and calling it «live» is the difference between
 * «it is working» and «it is waiting for you to resume it».
 *
 *  - `resolving` — no file yet, or the runtime plane has not resolved the host.
 *  - `live` / `stalled` — a hosted conversation, quiet or not.
 *  - `resumable` — finished or killed, and the composer can pick THIS
 *    conversation back up (never a second spawn).
 *  - `dead` — the host is gone, retired or unresumable; recovery is the
 *    banner's, and rotation is the way forward.
 */
export type SeatLiveness = "resolving" | "live" | "stalled" | "resumable" | "dead";

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
  /** A designation is in flight or durably pending with no terminal error.
      `clientRequestId` is the pending intent's own idempotency key: re-posting
      it is what converges an intent whose accepting request died, so the state
      carries a way through instead of spinning forever. */
  | { kind: "creating"; launchId: string | null; clientRequestId: string | null; designatedAt: string }
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
  /** The seat conversation's capability surface (`../agentCapabilities`), or
      null while there is no file to classify. */
  surface: StripSurface | null;
}): OrchestratorPanelState {
  const { status } = input;
  const active = status?.seat && status.exists ? status.seat : null;
  const pending = status?.pending ?? null;
  /* A client-side failure outranks the durable read only when the read has not
     caught up with it yet: the server's own record is the truth as soon as it
     shows the same error — or shows where that submission landed, which retires
     the failure outright. */
  const clientError = input.submitFailure && !seatRequestSettled(status, input.submitFailure.clientRequestId)
    ? { error: input.submitFailure.error, retry: input.submitFailure.kind === "ambiguous" ? "same" as const : "fresh" as const }
    : null;
  const pendingError = pending?.intent.error ?? null;

  if (active?.conversationId) {
    const liveness = livenessOf(input.file, input.surface);
    return {
      kind: "live",
      seat: active,
      conversationId: active.conversationId,
      liveness,
      rotation: rotationHintOf(input.file, liveness),
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
    return {
      kind: "creating",
      launchId: pending?.intent.launchId ?? null,
      clientRequestId: pending?.intent.clientRequestId ?? null,
      designatedAt: pending?.designatedAt ?? "",
    };
  }
  if (pendingError) {
    return { kind: "intent-error", error: pendingError, retry: "fresh", designatedAt: pending?.designatedAt ?? "" };
  }
  if (clientError) {
    return { kind: "intent-error", error: clientError.error, retry: clientError.retry, designatedAt: pending?.designatedAt ?? "" };
  }
  if (pending) {
    return {
      kind: "creating",
      launchId: pending.intent.launchId,
      clientRequestId: pending.intent.clientRequestId,
      designatedAt: pending.designatedAt,
    };
  }
  if (!status) return input.statusFailed ? { kind: "unavailable" } : { kind: "loading" };
  return { kind: "draft", vacated: Boolean(status.seat) && !status.exists };
}

/**
 * The capability surface decides liveness; `activity` only separates a quiet
 * hosted conversation from a working one. Reading `activity` FIRST is what made
 * a finished Claude session and a killed Codex thread both show «live»: they are
 * not stalled, so everything else fell through to it. Both engines reach
 * `resume` through the same matrix — a claude-projects session and a
 * codex-sessions thread with no live host are resumable in place.
 */
function livenessOf(file: FileEntry | null, surface: StripSurface | null): SeatLiveness {
  if (surface === "resume") return "resumable";
  /* `inert` is a finished conversation the engines cannot resume, and
     `superseded` a retired round; neither can be picked back up here. */
  if (surface === "dead" || surface === "superseded" || surface === "inert" || surface === "shell") return "dead";
  /* No file, or the plane is authoritative and has not resolved the host yet:
     say «opening» rather than claim either liveness. */
  if (!file || surface === null || surface === "unresolved") return "resolving";
  return file.activity === "stalled" ? "stalled" : "live";
}

function rotationHintOf(file: FileEntry | null, liveness: SeatLiveness): RotationHint | null {
  const reasons: RotationHint["reasons"] = [];
  const percent = typeof file?.ctx?.pct === "number" ? file.ctx.pct : null;
  if (percent !== null && percent >= ROTATION_CONTEXT_PERCENT) reasons.push("context");
  /* A gone host has nothing to rotate FROM but its mandate; a merely finished
     one is resumed in place, so it is not an advisory. */
  if (liveness === "dead") reasons.push("dead");
  if (!reasons.length) return null;
  return {
    level: reasons.includes("context") ? "strongly_recommend" : "recommend",
    contextPercent: percent,
    reasons,
  };
}

/**
 * Whether the durable read has SETTLED the fate of a submission key that was
 * kept because its own reply never came.
 *
 * A kept key is a promise to converge onto one designation; once the server's
 * own record shows where that key landed, the promise is discharged and holding
 * the key any longer turns it into a trap. The seat command completes an
 * ALREADY-COMPLETED intent on replay (`beginOrchestratorSeatIntent` →
 * `completed`), so a genuinely new submission carrying the old key is answered
 * with the old seat and creates nothing — a Confirm button that does nothing at
 * all, which is exactly what happens after the seat is later vacated. A pending
 * intent that errored is the same trap in the other direction: replaying its key
 * re-delivers the ORIGINAL mandate rather than the corrected one.
 *
 * Unknown stays unknown: a key the read cannot find anywhere may still be in
 * flight server-side, so it is kept and the retry replays it.
 */
export function seatRequestSettled(status: OrchestratorSeatStatus | null, clientRequestId: string): boolean {
  if (!status || !clientRequestId) return false;
  /* It reached an active seat — including one whose conversation has since been
     closed (`exists: false`), which is the vacancy the next draft creates into. */
  if (status.seat?.intent.clientRequestId === clientRequestId) return true;
  if (status.pending?.intent.clientRequestId === clientRequestId) return status.pending.intent.error !== null;
  return false;
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
export function classifySeatFailure(
  status: number,
  body: { error?: unknown; code?: unknown } | null,
  clientRequestId: string,
): SeatSubmitFailure | null {
  const error = typeof body?.error === "string" && body.error ? body.error : `the seat route answered HTTP ${status}`;
  if (status === 409 && body?.code === "seat_intent_in_progress") return null;
  /* Every 4xx is a refusal the server recorded (or never started): editing and
     retrying is safe, and must carry a fresh key so the corrected mandate is
     the one delivered. A 5xx or a thrown fetch leaves worker existence unknown. */
  if (status >= 400 && status < 500) return { kind: "terminal", error, clientRequestId };
  return { kind: "ambiguous", error, clientRequestId };
}
