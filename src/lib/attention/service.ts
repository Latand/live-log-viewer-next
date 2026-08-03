import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import { rootIdentity } from "@/lib/root/store";
import { freshness, listPresence } from "@/lib/view/presenceStore";
import type { StoredViewSession } from "@/lib/view/types";

import { attentionCapablePresence } from "./eligibility";

import {
  applyAttentionEvent,
  offerStatusForDevice,
  offerStillActionable,
  returnControlIsLive,
  type AttentionEvent,
  type DeviceOfferStatus,
} from "./machine";
import {
  createAttentionRequest,
  liveAttentionRequests,
  readAttentionFile,
  sweepExpiredAttention,
  transitionAttentionRequest,
  type AttentionCreateInput,
} from "./store";
import { isTerminalAttentionState, type AttentionRequestV1, type FocusTarget } from "./types";

/**
 * What the surfaces call (#688 slice 3): raise a request, read what this device
 * should render, answer it, go back.
 *
 * The root identity is resolved here rather than accepted from a caller. A
 * request that could name any root it liked would be a request a worker could
 * forge, and D4 gives only the root agent and the operator a claim on the
 * screen.
 */

export interface DeviceAttentionOffer {
  request: AttentionRequestV1;
  status: DeviceOfferStatus;
  /** Whether the return control still names where the operator came from, as
      opposed to having collapsed into a conversation line that restores it. */
  returnAvailable: boolean;
}

export interface DeviceAttentionView {
  rootId: string;
  /** The one request this device should act on, if any. At most one is offered
      per device; the rest wait. */
  offer: DeviceAttentionOffer | null;
  /** Everything still in flight for this device, newest last. */
  live: DeviceAttentionOffer[];
  /** Requests the clock ran out on during this read. Each is one line in the
      conversation and one journal event, so an unseen request is a fact both
      sides can see. */
  expired: string[];
}

/** Requests are answered oldest-first, so a queued one surfaces in the order it
    was raised rather than the order the file happens to hold. */
function byAge(left: AttentionRequestV1, right: AttentionRequestV1): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

export function attentionForDevice(
  deviceId: string,
  options: { filePath?: string; now?: Date } = {},
): DeviceAttentionView {
  const now = options.now ?? new Date();
  /* Sweeping on read is what makes expiry hold without a daemon: the clock is
     checked by whoever next looks, and nothing silently lingers as a live card
     because no background job happened to run. */
  const expired = sweepExpiredAttention({ filePath: options.filePath, now });
  const file = readAttentionFile(options.filePath, now);
  const live = liveAttentionRequests(file)
    .sort(byAge)
    .map((request) => ({
      request,
      status: offerStatusForDevice(request, deviceId),
      returnAvailable: returnControlIsLive(request, deviceId, now),
    }));

  /* At most one request is rendered per device, oldest first — but a follow the
     operator has wandered away from must not be what that one is. Its return
     control has already collapsed, so it offers nothing to press, and being the
     oldest live entry it would go on being this device's only offer while every
     newer request sat behind it unseen. So a follow still naming its way back
     wins (the operator is mid-handoff and Return is the thing to show), then
     anything answerable, and only then a collapsed follow. */
  const slot = live.filter((entry) => entry.status === "actionable" || entry.status === "following");
  const offer = slot.find((entry) => offerStillActionable(entry.request, now))
    ?? slot[0]
    ?? null;

  return {
    rootId: rootIdentity(),
    offer,
    live,
    expired,
  };
}

/**
 * Raise a request. `rootId` is never taken from the caller — see above.
 *
 * An operator command (a chip tapped in the overlay, "show me the reviewer")
 * comes through the same door with `origin: "operator"`, so return, expiry and
 * the multi-device rules apply to it identically. It simply skips consent,
 * because it is the operator's own act.
 */
export function raiseAttentionRequest(
  input: Omit<AttentionCreateInput, "rootId">,
  options: { filePath?: string; now?: Date; id?: string; conversations?: ConversationLookup } = {},
): ReturnType<typeof createAttentionRequest> {
  return createAttentionRequest({
    ...input,
    /* Who this is being put in front of, answered AT CREATION rather than left
       for whichever surface polls next. The caller — the agent's tool, most of
       all — gets one synchronous response and then goes on talking to the
       operator about it; an `offeredTo` that only fills in seconds later, on a
       browser's next poll, meant that response could never name a device and
       the agent was told nobody was there while the operator watched the board.
       An explicit list still wins: the operator's own commands name their own
       device, and nothing here may overrule that. */
    offeredTo: input.offeredTo
      ?? (input.origin === "root-agent" && input.directedAt === undefined ? followCapableDevices(options.now) : undefined),
    target: canonicalConversationTarget(input.target, options.conversations),
    rootId: rootIdentity(),
  }, options);
}

/**
 * The devices that could actually follow this request right now.
 *
 * Read from presence, which is where "a view is open" is already recorded — and
 * filtered by the same two rules the surfaces enforce, so the list never
 * promises the agent a device that will not move:
 *
 * - VISIBLE AND ACTIVE. A backgrounded tab neither renders an offer nor follows
 *   one, and a stale one may be a laptop that was shut hours ago;
 * - NOT A PHONE. Mobile is chat-only by design: it withholds its device id, so
 *   it can neither report the offer nor move its board. Counting it would tell
 *   an agent its request had somewhere to land when it has not.
 *
 * One entry per device, newest interaction first — two tabs on one machine are
 * one place to be taken.
 */
/**
 * The presence sessions an attention handoff may move, in presence's
 * deterministic order (latest interaction first), one per device.
 *
 * Eligibility is the SHARED predicate (`@/lib/attention/eligibility`): the
 * same rules the surfaces enforce — visible and active, not a phone, wide
 * enough to actually mount the attention host, in a mode a board can be
 * mounted in — so the list never promises the agent a view that will not
 * move. The mode and viewport reported by presence are the only signals that
 * cross the process boundary here — the bus lives in the browser and this
 * runs wherever the tool was called — so they are what the answer stands on.
 */
function followCapableSessions(now = new Date()): StoredViewSession[] {
  const at = now.getTime();
  const sessions: StoredViewSession[] = [];
  for (const session of listPresence(at)) {
    if (!attentionCapablePresence({ ...session, freshness: freshness(session, at) })) continue;
    /* Two tabs on one machine are one place to be taken; the latest-interaction
       one is the tab the operator counts as being at. */
    if (sessions.some((held) => held.deviceId === session.deviceId)) continue;
    sessions.push(session);
  }
  return sessions;
}

function followCapableDevices(now = new Date()): string[] {
  return followCapableSessions(now).map((session) => session.deviceId);
}

/**
 * A conversation target names a card, and a card is a durable conversation —
 * not whichever transcript path the caller happened to hold (#708).
 *
 * A Codex conversation accumulates transcript paths it no longer renders as:
 * archived migration generations, and provider forks adopted as its history. A
 * request aimed at one of those would resolve to an anchor the board never
 * draws and expire as `lost`, so the path is resolved through the registry to
 * the conversation's current generation before the request is recorded.
 */
function canonicalConversationTarget(target: FocusTarget, lookup?: ConversationLookup): FocusTarget {
  if (target.kind !== "conversation") return target;
  const conversations = lookup ?? agentRegistry();
  const current = conversations.conversationForPath(target.path)?.generations.at(-1);
  return current && current.path !== target.path ? { kind: "conversation", path: current.path } : target;
}

/** The exact view a directed handoff executes on: the device the Return
    control belongs to, and the ONE browser session (tab) that owns the move. */
export interface DirectedAttentionView {
  deviceId: string;
  viewSessionId: string;
}

/**
 * The one view an immediate directed handoff moves (#873).
 *
 * `followCapableSessions` already applies every eligibility rule the surfaces
 * enforce — the shared `attentionCapablePresence` predicate — and preserves
 * presence's deterministic order: latest interaction first, then latest
 * heartbeat, then session id. So "which view does the operator count as being
 * at" has exactly one answer, and two active devices are never a coin toss:
 * the one they touched last wins, every time, and the other is named nowhere
 * on the record — no competing offer can ever reach it.
 *
 * The SESSION is part of the answer, not a detail collapsed into the device:
 * two tabs share one device id, and a record that named only the device made
 * every tab on that machine an executor — duplicate navigations racing each
 * other for one camera. The record names the winning tab, and only that tab
 * runs the move.
 *
 * Null is the explicit no-view answer. The caller reports it as a bounded
 * failure rather than filing a pending ask nobody could ever act on.
 */
export function resolveDirectedAttentionView(now = new Date()): DirectedAttentionView | null {
  const session = followCapableSessions(now)[0];
  return session ? { deviceId: session.deviceId, viewSessionId: session.viewSessionId } : null;
}

/** Device-only projection of {@link resolveDirectedAttentionView}, kept for
    callers that need nothing session-scoped. */
export function resolveDirectedAttentionDevice(now = new Date()): string | null {
  return resolveDirectedAttentionView(now)?.deviceId ?? null;
}

/** How long the raise waits for the directed view to land before closing the
    request as lost. Generous against the browser's own clocks — a 4s offer
    poll plus a 4s board wait — while staying far inside the MCP transport's
    30s call deadline. */
export const ATTENTION_ARRIVAL_TIMEOUT_MS = 15_000;
const ATTENTION_ARRIVAL_POLL_MS = 250;

export type AttentionArrivalOutcome =
  /** The chosen view landed: the record is `following` (or already `returned`,
      when the operator arrived and went straight back), with the pre-move
      return point captured on it. */
  | { kind: "arrived"; request: AttentionRequestV1 }
  /** The handoff finished as an explicit bounded failure; the record is
      terminal and nothing is left for a later poll to navigate. */
  | { kind: "failed"; code: "TARGET_LOST" | "HANDOFF_TIMEOUT" | "HANDOFF_ABORTED" | "REQUEST_LOST"; request: AttentionRequestV1 | null };

export interface AttentionArrivalWait {
  filePath?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function arrivalOf(request: AttentionRequestV1): AttentionArrivalOutcome | null {
  /* `returned` counts as an arrival: the view landed and the operator pressed
     Return before this reader caught up. Reporting that as a failure would
     deny a move that visibly happened. */
  if (request.state === "following" || (request.state === "returned" && request.returnPoints.length > 0)) {
    return { kind: "arrived", request };
  }
  if (isTerminalAttentionState(request.state)) {
    return { kind: "failed", code: request.expiredCause === "lost" ? "TARGET_LOST" : "HANDOFF_TIMEOUT", request };
  }
  return null;
}

/**
 * Block until a directed request lands or fails, bounded (#873).
 *
 * Polled off the shared file rather than any in-process signal because the
 * arrival is written by ANOTHER process: the browser posts it to the Next
 * server, and this wait usually runs inside the stdio MCP server. The file is
 * the one place both of them already agree on.
 *
 * The deadline closes the record rather than merely giving up on it: an
 * `accepted` request left behind would be navigated by whichever poll comes
 * next — success the caller was already told did not happen. The close races
 * the arrival through the store's serialized transition, so whichever lands
 * first wins and the loser reads the truth: an expiry refused because the
 * record just reached `following` is reported as the arrival it is.
 */
export async function awaitAttentionArrival(id: string, options: AttentionArrivalWait = {}): Promise<AttentionArrivalOutcome> {
  const timeoutMs = options.timeoutMs ?? ATTENTION_ARRIVAL_TIMEOUT_MS;
  const pollMs = options.pollMs ?? ATTENTION_ARRIVAL_POLL_MS;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  const read = (): AttentionRequestV1 | null =>
    readAttentionFile(options.filePath).requests.find((request) => request.id === id) ?? null;

  for (;;) {
    const request = read();
    if (!request) return { kind: "failed", code: "REQUEST_LOST", request: null };
    const settled = arrivalOf(request);
    if (settled) return settled;

    const aborted = options.signal?.aborted === true;
    if (aborted || now() >= deadline) {
      /* Close it, race-safely: `expire` is refused from `following`, so an
         arrival that beat this write turns the close into the success it
         really was. */
      const closed = transitionAttentionRequest(id, { kind: "expire", cause: "lost" }, { filePath: options.filePath });
      if (closed.ok) return { kind: "failed", code: aborted ? "HANDOFF_ABORTED" : "HANDOFF_TIMEOUT", request: closed.request };
      const current = read();
      const late = current ? arrivalOf(current) : null;
      return late ?? { kind: "failed", code: aborted ? "HANDOFF_ABORTED" : "HANDOFF_TIMEOUT", request: current };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

export function answerAttentionRequest(
  id: string,
  event: AttentionEvent,
  options: { filePath?: string; now?: Date; expectedRevision?: number } = {},
): ReturnType<typeof transitionAttentionRequest> {
  return transitionAttentionRequest(id, event, options);
}

/**
 * Whether a device may still be moved by a standing auto-follow.
 *
 * Consent itself is slice 7 and is not stored yet; this is the guard every
 * auto-follow path has to pass regardless of where the consent is recorded, so
 * it lives with the machine rather than with the future consent store. A phone
 * in a pocket never auto-follows even where consent exists.
 */
export function autoFollowEligible(presence: { visibility: "visible" | "hidden"; freshness: string } | null): boolean {
  return presence?.visibility === "visible" && presence.freshness === "active";
}

/** Fold one event into a request value without persisting — the surfaces use
    this for optimistic rendering, and the store is still the authority. */
export function previewTransition(request: AttentionRequestV1, event: AttentionEvent, now = new Date()): AttentionRequestV1 {
  const transition = applyAttentionEvent(request, event, { now });
  return transition.ok ? transition.request : request;
}
