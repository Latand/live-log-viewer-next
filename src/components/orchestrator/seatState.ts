import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import type { StripSurface } from "../agentCapabilities";
import type { OrchestratorIncumbent } from "./incumbent";

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
    the server's own recommendation over HTTP; with no answer yet, slice A's rule
    over the context usage the board already carries still holds the state up. */
export interface RotationHint {
  level: "recommend" | "strongly_recommend";
  /** Context usage percent behind a `strongly_recommend`, when it is known. */
  contextPercent: number | null;
  reasons: ("context" | "dead")[];
  /** Slice B: the SERVER's own reasons, verbatim — each names the threshold it
      crossed and whether the number behind it is an estimate. Never re-worded
      here, because re-wording a threshold is how two surfaces start disagreeing
      about the same seat. Absent on a client-derived hint. */
  notes?: readonly string[];
  /** Where the advisory came from. Absent means client-derived (slice A). */
  source?: "server" | "client";
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
  /** Slice B: `GET /api/orchestrator/seat/status`, once it has answered. Null
      keeps the panel on slice A's own derivation, so the advisory never blinks
      out while the slower read catches up. */
  incumbent?: OrchestratorIncumbent | null;
}): OrchestratorPanelState {
  const { status } = input;
  const active = status?.seat && status.exists ? status.seat : null;
  const pending = status?.pending ?? null;
  const clientError = unsettledClientError(status, input.submitFailure);
  const pendingError = pending?.intent.error ?? null;

  if (active?.conversationId) {
    const liveness = livenessOf(input.file, input.surface);
    return {
      kind: "live",
      seat: active,
      conversationId: active.conversationId,
      liveness,
      rotation: rotationHintOf(input.file, liveness, input.incumbent ?? null),
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

/** The warning is eligible only after the mandate has produced a visible
    assistant message and a later turn has gone quiet. While the mandate is
    still awaiting its first visible status, or the current turn already
    contains that status, the operator-action warning stays hidden. */
export function orchestratorQuietBannerEligible(
  state: OrchestratorPanelState,
  file: FileEntry | null,
): boolean {
  if (state.kind !== "live" || state.liveness !== "stalled" || !file) return false;
  const turn = file.lastTurn;
  if (!turn || turn.endedAt !== null) return true;
  const assistantAt = file.lastAssistantMessageAt;
  if (typeof assistantAt === "number" && assistantAt >= turn.startedAt) return false;

  const designatedAt = Date.parse(state.seat.designatedAt);
  const mandateStillAwaitsStatus = Number.isFinite(designatedAt)
    && turn.startedAt >= designatedAt
    && (assistantAt === null || (typeof assistantAt === "number" && assistantAt < designatedAt));
  return !mandateStillAwaitsStatus;
}

/**
 * A client-side failure outranks the durable read only while the read has not
 * caught up with it: the server's own record is the truth as soon as it shows
 * the same error — or shows where that submission landed, which retires the
 * failure outright.
 */
function unsettledClientError(
  status: OrchestratorSeatStatus | null,
  failure: SeatSubmitFailure | null,
): { error: string; retry: "fresh" | "same" } | null {
  if (!failure || seatRequestSettled(status, failure.clientRequestId)) return null;
  return { error: failure.error, retry: failure.kind === "ambiguous" ? "same" : "fresh" };
}

/**
 * The rotate draft's own surface (PRD #976 slice B).
 *
 * Rotation is confirmed from the SAME form the create draft renders, so it needs
 * the same two states — the plain form, and the form with the last attempt's
 * terminal error above it and retry in place. The panel state stays `live`
 * throughout: the incumbent keeps running, and a failed rotation must never take
 * its conversation off the screen.
 */
export function deriveRotateDraftState(input: {
  status: OrchestratorSeatStatus | null;
  submitFailure: SeatSubmitFailure | null;
}): Extract<OrchestratorPanelState, { kind: "draft" } | { kind: "intent-error" }> {
  const pending = input.status?.pending ?? null;
  const designatedAt = pending?.designatedAt ?? "";
  /* The server's durable record first: a rotation refused before anything ran
     is recorded on the pending intent, and it outlives this page. */
  if (pending?.intent.error) return { kind: "intent-error", error: pending.intent.error, retry: "fresh", designatedAt };
  const clientError = unsettledClientError(input.status, input.submitFailure);
  if (clientError) return { kind: "intent-error", ...clientError, designatedAt };
  return { kind: "draft", vacated: false };
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

/**
 * The advisory the panel shows, from the best reading available.
 *
 * The SERVER's recommendation wins whenever it has answered: it knows the
 * model's real window policy and the provider-reported token count, which is the
 * exact reading `get_orchestrator` reports — two surfaces disagreeing about the
 * same seat is precisely what putting this on HTTP was for. `not recommended`
 * from the server is equally authoritative, so a client guess cannot re-raise a
 * banner the server has stood down.
 *
 * The one thing the client still contributes is a GONE host: the capability
 * matrix classifies the seat conversation from the board's own evidence, and it
 * sees a dead host the liveness plane may not have caught up with yet. That
 * reason is added, never subtracted.
 */
function rotationHintOf(file: FileEntry | null, liveness: SeatLiveness, incumbent: OrchestratorIncumbent | null): RotationHint | null {
  /* A gone host has nothing to rotate FROM but its mandate; a merely finished
     one is resumed in place, so it is not an advisory. */
  const deadHere = liveness === "dead";
  const server = incumbent?.designated ? incumbent.rotation : null;
  if (server) {
    const reasons: RotationHint["reasons"] = [];
    if (server.level === "strongly_recommend") reasons.push("context");
    if (deadHere) reasons.push("dead");
    if (!server.recommended && !reasons.length) return null;
    return {
      level: server.level === "strongly_recommend" ? "strongly_recommend" : "recommend",
      contextPercent: incumbent?.context?.percent ?? null,
      reasons,
      notes: server.reasons,
      source: "server",
    };
  }

  const reasons: RotationHint["reasons"] = [];
  const percent = typeof file?.ctx?.pct === "number" ? file.ctx.pct : null;
  if (percent !== null && percent >= ROTATION_CONTEXT_PERCENT) reasons.push("context");
  if (deadHere) reasons.push("dead");
  if (!reasons.length) return null;
  return {
    level: reasons.includes("context") ? "strongly_recommend" : "recommend",
    contextPercent: percent,
    reasons,
    source: "client",
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
