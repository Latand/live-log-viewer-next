import type { ViewMode } from "@/lib/view/types";

/**
 * The attention record (#688) — the root agent's durable offer to move the
 * operator's view.
 *
 * Two stores divide this feature cleanly. Presence (`src/lib/view/`) answers
 * *where each device is looking right now*: in-memory, a 25-second active
 * window, 120-second retention. This file's record answers *what was asked and
 * what the operator said*, and it has to outlive a page reload, a restart and a
 * root-session rollover — so it is durable, revisioned and written atomically,
 * and nothing here is ever written into presence.
 */

export const ATTENTION_SCHEMA_VERSION = 1 as const;

/* Timings. The design names these as chosen for coherence rather than measured,
   each deliberately a single constant so it can be revisited on evidence. The
   TTL is the one to revisit first: it interacts with how often the operator
   leaves the desk. */

/** An offer nobody acknowledges expires after this. A `pending` request — one
    no active device ever rendered, which is what happens when the operator is
    at no device at all — runs on the same clock. */
export const OFFER_TTL_MS = 10 * 60_000;
/** How long the return control names where you came from before collapsing to
    a conversation line that still restores it. */
export const RETURN_WINDOW_MS = 60_000;
/** How long an `accepted` request may go without landing before the clock ends
    it as lost. Acceptance is a move in progress and lives for seconds — the
    board wait bounds it — so a request still `accepted` this long afterwards is
    a device that agreed and then went away: a closed tab, a crash, a reload
    mid-handoff. Without this that request could never leave `accepted`, and it
    would stay that device's only offer for the life of the record. */
export const ACCEPTED_LANDING_GRACE_MS = 60_000;
/**
 * How long a follow nobody ever closed stays live before the clock ends it.
 *
 * `following` is the other state a request could never leave on its own: the
 * only way out is the operator pressing Return, and an operator who simply
 * walks away never presses anything. Being live and the oldest entry, that
 * request goes on being the device's one offer, so every later request is
 * stamped `offered`, rendered by nothing, and expires as if it had been
 * ignored — the same silent swallow a lost landing used to cause.
 *
 * Deliberately far longer than {@link RETURN_WINDOW_MS}: by the time this runs
 * the return control has long since stopped naming where the operator came
 * from, so nothing is taken away that was still on offer. Ending the record
 * never moves the view, so an operator still reading the target keeps reading
 * it — what they lose is a card that had no action left on it.
 */
export const FOLLOW_HOLD_MS = 10 * 60_000;
/** Auto-follow may move the view; it may not chain-move it. A request arriving
    inside this window after a move waits. */
export const AUTO_FOLLOW_SETTLE_MS = 4_000;
/** Offers queued behind the one on screen. Overflow drops the oldest routine
    entry and says so, so a dropped request is never silent. */
export const QUEUE_CAP = 3;
/** One operator-safe sentence. */
export const MAX_REASON_LENGTH = 240;
export const MAX_CONTEXT_LABEL_LENGTH = 120;
export const MAX_JOURNAL_CANDIDATES = 8;

/** World-space box, matching the board's own geometry (`SchemeRect`). */
export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What a request is about (D7). Fully general, down to an arbitrary board point,
 * with a conversation as the preferred default anchor because a conversation is
 * the only target that can explain itself in words without borrowing a name.
 *
 * Every kind corresponds to something the board layout already addresses, so
 * this is a naming of what can already be resolved rather than new vocabulary.
 */
export type FocusTarget =
  | { kind: "conversation"; path: string }
  | { kind: "pipeline"; pipelineId: string }
  | { kind: "stage"; pipelineId: string; stageId: string }
  | { kind: "flowRound"; flowId: string; round: number }
  | { kind: "task"; taskId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "region"; project: string; rect: FocusRect }
  | { kind: "point"; project: string; x: number; y: number; zoom?: number };

/** Geometric targets have no natural surface to open, so they accept `show`
    only — a request that says otherwise is refused at creation. */
export type GeometricFocusTarget = Extract<FocusTarget, { kind: "region" | "point" }>;

/**
 * Where the camera goes, kept separate from the anchor on purpose: an anchor can
 * vanish while its frame stays perfectly valid, and that separation is what
 * makes disappearance survivable rather than a silent no-op.
 */
export interface FocusFrame {
  project: string;
  rect: FocusRect;
  /** Board revision the frame was read at, or null when the board had none. */
  boardRevision: number | null;
}

/** Whether the anchor was still there when the operator agreed. Degradation is
    one-way and always spoken. */
export type FocusResolutionKind = "exact" | "approximate" | "lost";

/**
 * Why a request ended without an answer. Kept on the record rather than only in
 * the reply to whoever caused it: "nobody answered in ten minutes", "the anchor
 * was gone", "the queue was full" and "they followed and never came back" are
 * four different things to say out loud, and the record is the only place the
 * distinction outlives the response that caused it.
 *
 * `follow-elapsed` is the odd one out and says so: the operator DID see the
 * request and DID agree to it. It is on this list rather than being its own
 * state because the ending is the same shape — the clock closed a record nobody
 * closed by hand — and reading it as a refusal or as "never seen" would teach
 * the agent exactly the wrong lesson about asking again.
 */
export type ExpiryCause = "ttl" | "lost" | "queue-evicted" | "follow-elapsed";

/** `show` frames and highlights; `open` also opens the target's natural surface,
    and return closes what it opened — which is why the two are one field (D8). */
export type FocusIntent = "show" | "open";

/** Zoom follows intent, not type: `inspect` zooms in until readable, `situate`
    fits the frame with context around it. */
export type ZoomIntent = "inspect" | "situate";

export type AttentionState =
  /** Created; no active device has rendered it. */
  | "pending"
  /** Rendered on at least one active device. */
  | "offered"
  /** The operator asked to see it. The view has NOT moved. */
  | "previewing"
  /** Agreed, or consumed by standing auto-follow. */
  | "accepted"
  /** The view is at the target; return is available. */
  | "following"
  /** The operator went back. Terminal, and deliberately distinct from declined. */
  | "returned"
  /** Refused. Terminal, and reported to the agent as a refusal rather than as
      silence — the difference between an agent that learns to stop asking and
      one that keeps asking. */
  | "declined"
  /** TTL elapsed unacknowledged, the target resolved as lost, the queue was
      full, or a follow was never closed. Which one is on the record as
      `expiredCause`. Terminal. */
  | "expired"
  /** Replaced by a newer request from the root agent. Terminal. */
  | "superseded";

export const TERMINAL_ATTENTION_STATES: readonly AttentionState[] = ["returned", "declined", "expired", "superseded"];

export function isTerminalAttentionState(state: AttentionState): boolean {
  return TERMINAL_ATTENTION_STATES.includes(state);
}

/**
 * Who raised it (D4). Only two sources reach this record: the root agent, and
 * the operator's own command. Workers and the #686 lifecycle journal signal the
 * root agent and hold no claim on the screen — a journal event arrives here as
 * a *candidate* on a request the root agent chose to raise, never as a request.
 */
export type AttentionOrigin = "root-agent" | "operator";

/** A #686 lifecycle event that prompted the request. Evidence, not authority. */
export interface JournalEventRef {
  eventId: string;
  kind?: string;
}

/** The viewport captured immediately before a move, so return restores it
    exactly. Per-device, because presence is per-device and two devices in the
    same seat do not want the same framing. */
export interface ReturnPoint {
  deviceId: string;
  mode: ViewMode;
  /** Null in the modes presence forbids a camera in (`overview`, `list`,
      `mobile-focus`) — there the handoff is a change of mode and focused path
      rather than a pan, and that is what return restores. */
  camera: { x: number; y: number; zoom: number } | null;
  focusedPath: string | null;
  capturedAt: string;
}

/** The #687 seam. Populated only when Computer Use is present on the root
    session; absent is the normal case, and the whole design runs unchanged
    without it. */
export interface DesktopWindowRef {
  windowId: string;
  application?: string;
  title?: string;
}

export interface AttentionRequestV1 {
  id: string;
  createdAt: string;
  /** The root conversation by STABLE IDENTITY, never a session path: D5 makes
      session replacement ordinary, and a request created before a rollover must
      still resolve after it. */
  requestedBy: { rootId: string };
  origin: AttentionOrigin;
  target: FocusTarget;
  frameAtCreation: FocusFrame;
  intent: FocusIntent;
  zoom: ZoomIntent;
  /** One sentence, operator-safe. Never the target's contents. */
  reason: string;
  /** Pipeline/stage naming used in the spoken sentence but never navigated to —
      "the review stage on that pipeline finished" while pointing at the
      reviewer's conversation. */
  contextLabel?: string;
  candidates?: JournalEventRef[];
  state: AttentionState;
  stateChangedAt: string;
  expiresAt: string;
  /** Active devices at offer time. */
  offeredTo: string[];
  /** Which device said yes. Accepting on one withdraws the offer on the others. */
  acknowledgedBy?: string;
  acceptedVia?: "operator" | "auto-follow";
  /** One entry per device that has been moved. Viewports are never mirrored;
      what is shared is the target and the acknowledgement. */
  returnPoints: ReturnPoint[];
  resolution?: FocusResolutionKind;
  /** Set with the `expired` state, so a dropped request stays distinguishable
      from an unanswered one long after the POST that dropped it. */
  expiredCause?: ExpiryCause;
  /** Why a follow ended, so the record never claims the operator is still
      looking at something they left by hand. */
  returnedVia?: "control" | "manual-move";
  supersededBy?: string;
  desktopTarget?: DesktopWindowRef;
  /** Bumped on every accepted transition; a stale writer is refused. */
  revision: number;
}

export interface AttentionFileV1 {
  schemaVersion: typeof ATTENTION_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  requests: AttentionRequestV1[];
}
