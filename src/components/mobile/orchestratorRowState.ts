import type { MessageKey } from "@/lib/i18n";

import type { OrchestratorPanelState, RotationHint } from "../orchestrator/seatState";

/*
 * What the phone's pinned orchestrator row shows, as a pure projection of the
 * seat state machine (PRD #976 slice C, issue #979).
 *
 * The panel's six states (`../orchestrator/seatState`) all reach the phone —
 * the operator's requirement is that every one of them is designed, not that
 * the phone gets a simpler machine. What differs is the DESTINATION of a tap:
 * a live seat opens its conversation in the standard `MobileFocusView`, and
 * every other state opens the fullscreen sheet, which is the only surface that
 * can act on it (create, resume a pending designation, read a terminal error,
 * re-read an unavailable seat).
 *
 * It lives apart from the row's JSX for the same reason the panel's derivation
 * does: a state that is never named cannot be designed, and the mapping from
 * eleven seat outcomes onto ten row renderings is exactly the part worth
 * asserting without a DOM.
 */

/** One word per designed row rendering; also the row's data attribute. */
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
  /** A designation in flight or failed ALONGSIDE a live incumbent. The row's
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

/** The chip face per row state. Borders and fills carry the tone; the label
    beside them says the same thing in words, so neither is load-bearing alone. */
export const ROW_TONE: Record<OrchestratorRowState, { chip: string; dot: string }> = {
  loading: { chip: "border-border bg-canvas text-muted", dot: "bg-strong/60" },
  unavailable: { chip: "border-warning/45 bg-warning-soft text-warning", dot: "bg-warning" },
  draft: { chip: "border-dashed border-accent/50 bg-accent/5 text-accent", dot: "bg-accent/60" },
  creating: { chip: "border-accent/45 bg-accent-soft text-accent", dot: "bg-accent" },
  "intent-error": { chip: "border-danger/40 bg-danger-soft text-danger", dot: "bg-danger" },
  live: { chip: "border-success/45 bg-success-soft text-success", dot: "bg-success" },
  stalled: { chip: "border-warning/45 bg-warning-soft text-warning", dot: "bg-warning" },
  resumable: { chip: "border-border bg-canvas text-muted", dot: "bg-strong" },
  dead: { chip: "border-danger/40 bg-danger-soft text-danger", dot: "bg-danger" },
  resolving: { chip: "border-border bg-canvas text-muted", dot: "bg-strong/60" },
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
