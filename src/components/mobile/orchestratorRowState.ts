import type { MessageKey } from "@/lib/i18n";

import type { OrchestratorPanelState, RotationHint } from "../orchestrator/seatState";
import type { MobileRowState } from "./mobileBoardModel";

/*
 * What the phone's orchestrator seat card shows, as a pure projection of the
 * seat state machine (PRD #976 slice C, issue #979; mobile v2 lane 6,
 * docs/design/mobile-v2/README.md §4.1, §4.5).
 *
 * The panel's six states (`../orchestrator/seatState`) all reach the phone —
 * the operator's requirement is that every one of them is designed, not that
 * the phone gets a simpler machine. What differs is the DESTINATION of a tap:
 * a live seat opens its conversation in the standard conversation screen, and
 * every other state opens the seat sheet, which is the only surface that can
 * act on it (create, resume a pending designation, read a terminal error,
 * re-read an unavailable seat).
 *
 * It lives apart from the card's JSX for the same reason the panel's
 * derivation does: a state that is never named cannot be designed, and the
 * mapping from eleven seat outcomes onto ten card renderings is exactly the
 * part worth asserting without a DOM.
 */

/** One word per designed seat rendering; also the card's data attribute. */
export type OrchestratorRowState =
  | "loading"
  | "unavailable"
  | "draft"
  | "creating"
  | "intent-error"
  | "live"
  | "stalled"
  | "resumable"
  | "dead"
  | "resolving";

export interface OrchestratorRowView {
  state: OrchestratorRowState;
  /** Where a tap lands. `conversation` only when there IS a conversation to
      open on this device — a seated orchestrator whose transcript has not
      reached the phone yet still has to answer a tap with something, and the
      sheet is the surface that can say what it is waiting for. */
  tap: "conversation" | "sheet";
  /** The rotation advisory riding on a live incumbent, mirrored as a marker. */
  rotation: RotationHint["level"] | null;
  /** A designation in flight or failed ALONGSIDE a live incumbent. The card's
      own tap keeps opening the conversation, so this rides as its own control
      — a failed rotation must never be the thing that takes the chat away. */
  transition: "creating" | "error" | null;
  /** Something the operator has to deal with: a refused designation, a host
      that is gone, a failed transition, an unreadable seat. */
  attention: boolean;
}

export function orchestratorRowView(
  state: OrchestratorPanelState,
  options: { conversationReady: boolean },
): OrchestratorRowView {
  if (state.kind === "live") {
    const transition = state.transition?.kind ?? null;
    return {
      state: state.liveness,
      /* A live seat with no transcript on this device falls back to the sheet,
         which offers the board deep link — never a tap that does nothing. */
      tap: options.conversationReady ? "conversation" : "sheet",
      rotation: state.rotation?.level ?? null,
      transition,
      attention: state.liveness === "dead" || transition === "error",
    };
  }
  const quiet = { tap: "sheet" as const, rotation: null, transition: null };
  if (state.kind === "intent-error") return { ...quiet, state: "intent-error", attention: true };
  if (state.kind === "unavailable") return { ...quiet, state: "unavailable", attention: true };
  if (state.kind === "creating") return { ...quiet, state: "creating", attention: false };
  if (state.kind === "loading") return { ...quiet, state: "loading", attention: false };
  return { ...quiet, state: "draft", attention: false };
}

/** The two faces of the seat card (README §4.1): the seat itself, or — over a
    vacancy — the invitation that opens the create draft. */
export type SeatCardShape = "seat" | "invitation";

/** Whose state the card's badge speaks. A live seat whose transcript is on
    this device carries the CONVERSATION's own phrase («working 2:14»), the
    same phrase the board's rows and the conversation's bar carry, so one seat
    never reads two ways. Everything else carries the seat's own state word. */
export type SeatBadgeSource = "conversation" | "state";

export interface SeatCardView extends OrchestratorRowView {
  shape: SeatCardShape;
  badge: SeatBadgeSource;
}

export function seatCardView(
  state: OrchestratorPanelState,
  options: { conversationReady: boolean },
): SeatCardView {
  const view = orchestratorRowView(state, options);
  return {
    ...view,
    /* Only a plain vacancy invites. A designation that FAILED over one is not
       an empty slot with a friendly line on it: the card says «failed» and its
       tap opens the sheet holding the error and the draft that retries it. */
    shape: view.state === "draft" ? "invitation" : "seat",
    badge: view.state === "live" && view.tap === "conversation" ? "conversation" : "state",
  };
}

/** The badge recipe's one tone per state (README §5): soft fill + role text.
    Colour never carries a state alone — the word beside it says the same
    thing — so a quiet seat is deliberately neutral rather than green. */
export type SeatBadgeTone = "success" | "warning" | "danger" | "accent" | "neutral";

export const SEAT_STATE_TONE: Record<OrchestratorRowState, SeatBadgeTone> = {
  loading: "neutral",
  unavailable: "warning",
  draft: "accent",
  creating: "accent",
  "intent-error": "danger",
  live: "success",
  stalled: "warning",
  resumable: "neutral",
  dead: "danger",
  resolving: "neutral",
};

/** The tone a LIVE seat's badge takes: its conversation's own, by the board's
    precedence, so the card and the row that conversation would have had cannot
    disagree. Only working and the states that need the operator are coloured;
    a seat that has simply finished is quiet (README §5). */
export const CONVERSATION_STATE_TONE: Record<MobileRowState["key"], SeatBadgeTone> = {
  killed: "danger",
  stalled: "danger",
  limit: "warning",
  held: "warning",
  waiting: "warning",
  working: "success",
  returned: "neutral",
  done: "neutral",
};

/** The state word, shared with the desktop panel's badge so the two surfaces
    never drift into two vocabularies for one seat. */
export const ROW_STATE_LABEL: Record<OrchestratorRowState, MessageKey> = {
  loading: "orchPanel.badgeReading",
  unavailable: "orchMobile.unreadable",
  draft: "orchPanel.badgeNone",
  creating: "orchPanel.badgeCreating",
  "intent-error": "orchPanel.badgeFailed",
  live: "orchPanel.badgeLive",
  stalled: "orchPanel.badgeStalled",
  resumable: "orchPanel.badgeResumable",
  dead: "orchPanel.badgeDead",
  resolving: "orchPanel.badgeResolving",
};
