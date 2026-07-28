import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import { rootIdentity } from "@/lib/root/store";
import { freshness, listPresence } from "@/lib/view/presenceStore";

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
import type { AttentionRequestV1, FocusTarget } from "./types";

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
    offeredTo: input.offeredTo ?? (input.origin === "root-agent" ? followCapableDevices(options.now) : undefined),
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
function followCapableDevices(now = new Date()): string[] {
  const at = now.getTime();
  const devices: string[] = [];
  for (const session of listPresence(at)) {
    if (session.device.kind === "mobile") continue;
    /* The same guard a standing auto-follow passes, so "who was this offered
       to" and "who may be moved" can never drift apart. */
    if (!autoFollowEligible({ visibility: session.visibility, freshness: freshness(session, at) })) continue;
    if (!devices.includes(session.deviceId)) devices.push(session.deviceId);
  }
  return devices;
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
