import {
  ACCEPTED_LANDING_GRACE_MS,
  FOLLOW_HOLD_MS,
  isTerminalAttentionState,
  OFFER_TTL_MS,
  RETURN_WINDOW_MS,
  type AttentionRequestV1,
  type AttentionState,
  type ExpiryCause,
  type FocusResolutionKind,
  type ReturnPoint,
} from "./types";

/**
 * The attention request lifecycle, as a pure function (#688).
 *
 * Every state change in the feature goes through here, so an out-of-order
 * transition is refused in one place rather than being caught by whichever
 * caller happened to think of it. Nothing in this module reads the clock, the
 * filesystem or presence — the caller supplies `now`.
 */

export type AttentionEvent =
  /** An active device rendered the request. */
  | { kind: "offer"; deviceId: string }
  /** The operator asked to see it. The view does not move. */
  | { kind: "preview"; deviceId: string }
  | { kind: "accept"; deviceId: string; via?: "operator" | "auto-follow" }
  /** The view reached the target; the pre-move viewport comes with it. */
  | { kind: "arrive"; deviceId: string; returnPoint: ReturnPoint; resolution: FocusResolutionKind }
  /** The device that agreed could not land: there was nowhere to go. Its own
      close for a handoff that never happened — see the `abandon` case. */
  | { kind: "abandon"; deviceId: string }
  | { kind: "decline"; deviceId: string }
  /** Looked, and stayed put. */
  | { kind: "dismiss"; deviceId: string }
  | { kind: "return"; deviceId: string; via: "control" | "manual-move" }
  | { kind: "expire"; cause: ExpiryCause }
  | { kind: "supersede"; by: string };

export type AttentionRejection =
  /** The event does not exist from this state — the machine's whole job. */
  | "invalid-transition"
  /** A device that was never offered the request trying to answer it. */
  | "not-offered"
  /** A device that did not accept trying to land or to return. */
  | "not-acknowledger"
  /** Somebody wrote against a revision that has since moved. */
  | "stale-revision"
  /** Landing was attempted with no frame to land on; the caller expires it. */
  | "lost-target";

export type AttentionTransition =
  | { ok: true; request: AttentionRequestV1; changed: boolean }
  | { ok: false; reason: AttentionRejection; state: AttentionState };

/** States a request may still be acknowledged, expired or superseded from. */
const PRE_ACCEPTANCE: readonly AttentionState[] = ["pending", "offered", "previewing"];

function refuse(request: AttentionRequestV1, reason: AttentionRejection): AttentionTransition {
  return { ok: false, reason, state: request.state };
}

function advance(
  request: AttentionRequestV1,
  state: AttentionState,
  now: Date,
  patch: Partial<AttentionRequestV1> = {},
): AttentionTransition {
  return {
    ok: true,
    changed: true,
    request: {
      ...request,
      ...patch,
      state,
      stateChangedAt: now.toISOString(),
      revision: request.revision + 1,
    },
  };
}

/**
 * How the clock alone would end this request, or null while it may still run.
 *
 * Two different clocks, because they answer two different questions. Before
 * acceptance it is the TTL: nobody answered. After acceptance it is the landing
 * grace: somebody agreed and the move never completed, which is the one state a
 * request could otherwise never leave — `arrive` refuses a lost landing, and
 * `return` needs a follow that never began. And after landing it is the follow
 * hold: the only way out of `following` is the operator pressing Return, so an
 * operator who walks away instead leaves it live forever, holding the device's
 * one offer slot against every request raised after it.
 *
 * The hold runs far past the return window on purpose. Within that window the
 * card still names where the operator came from and a clock taking it away
 * would strand them; long after it, the control has already collapsed and the
 * record is holding a slot on behalf of a card with nothing left to press.
 */
export function expiryCauseByClock(request: AttentionRequestV1, now: Date): ExpiryCause | null {
  if (PRE_ACCEPTANCE.includes(request.state)) {
    return Date.parse(request.expiresAt) <= now.getTime() ? "ttl" : null;
  }
  if (request.state === "accepted") {
    return now.getTime() - Date.parse(request.stateChangedAt) >= ACCEPTED_LANDING_GRACE_MS ? "lost" : null;
  }
  if (request.state === "following") {
    return now.getTime() - Date.parse(request.stateChangedAt) >= FOLLOW_HOLD_MS ? "follow-elapsed" : null;
  }
  return null;
}

/**
 * Whether a follow is still inside the window in which the way back is live.
 *
 * The device-agnostic counterpart to {@link returnControlIsLive}, because the
 * one thing that may end a follow early — a newer request from the same agent —
 * has no device to ask about. It means the same thing by it: is there still a
 * live way back that dropping this record would take away.
 *
 * Measured from `stateChangedAt`, which the SERVER wrote when the arrival
 * landed, and never from a return point's `capturedAt`, which is the client's
 * own clock. A device whose clock reads far ahead would otherwise keep its
 * follow permanently un-evictable — the wedge this bound exists to close,
 * reintroduced by trusting the wedged party for the time. `capturedAt` is at or
 * before the arrival, so this window closes no earlier than the control the
 * operator can actually see.
 */
export function followReturnWindowOpen(request: AttentionRequestV1, now: Date): boolean {
  return request.state === "following" && now.getTime() - Date.parse(request.stateChangedAt) < RETURN_WINDOW_MS;
}

/** Whether the clock alone has run this request out. */
export function isExpiredByClock(request: AttentionRequestV1, now: Date): boolean {
  return expiryCauseByClock(request, now) !== null;
}

/** Whether the return control still names where the operator came from. Past
    this it collapses to a conversation line that restores the same point. */
export function returnControlIsLive(request: AttentionRequestV1, deviceId: string, now: Date): boolean {
  if (request.state !== "following" || request.acknowledgedBy !== deviceId) return false;
  const captured = request.returnPoints.find((point) => point.deviceId === deviceId);
  return captured !== undefined && now.getTime() - Date.parse(captured.capturedAt) < RETURN_WINDOW_MS;
}

/** Whether this request is still holding the screen for something the operator
    can act on, as opposed to a follow they have long since wandered away from.
    A collapsed follow yields the device's one offer slot to a live request. */
export function offerStillActionable(request: AttentionRequestV1, now: Date): boolean {
  return request.state !== "following" || followReturnWindowOpen(request, now);
}

/**
 * What one device should render for a request.
 *
 * A request is offered on every active device and the record names which one
 * accepted, so the withdrawal of the other offers is a *read* of the record
 * rather than a second write: the devices that did not accept show a short
 * "followed on the phone" note in place of a stale card, and nothing has to
 * chase them.
 */
export type DeviceOfferStatus =
  /** Answerable here: accept, preview or decline. */
  | "actionable"
  /** This device accepted; it is the one holding the return point. */
  | "following"
  /** Another device answered it. */
  | "withdrawn"
  /** Over, one way or another. */
  | "closed"
  /** Not this device's business. */
  | "none";

export function offerStatusForDevice(request: AttentionRequestV1, deviceId: string): DeviceOfferStatus {
  if (isTerminalAttentionState(request.state)) return "closed";
  if (request.state === "accepted" || request.state === "following") {
    return request.acknowledgedBy === deviceId ? "following" : "withdrawn";
  }
  if (request.state === "pending") return "none";
  return request.offeredTo.includes(deviceId) ? "actionable" : "none";
}

/** The expiry stamp a freshly created request carries. */
export function expiryFrom(createdAt: Date): string {
  return new Date(createdAt.getTime() + OFFER_TTL_MS).toISOString();
}

export function applyAttentionEvent(
  request: AttentionRequestV1,
  event: AttentionEvent,
  options: { now?: Date; expectedRevision?: number } = {},
): AttentionTransition {
  const now = options.now ?? new Date();
  if (options.expectedRevision !== undefined && options.expectedRevision !== request.revision) {
    return refuse(request, "stale-revision");
  }
  /* A terminal request answers nothing. Saying so explicitly here is what keeps
     a late click on a card that already expired from reviving it. */
  if (isTerminalAttentionState(request.state)) return refuse(request, "invalid-transition");

  switch (event.kind) {
    case "offer": {
      if (request.state !== "pending" && request.state !== "offered") return refuse(request, "invalid-transition");
      if (request.state === "offered" && request.offeredTo.includes(event.deviceId)) {
        return { ok: true, request, changed: false };
      }
      const offeredTo = request.offeredTo.includes(event.deviceId) ? request.offeredTo : [...request.offeredTo, event.deviceId];
      return advance(request, "offered", now, { offeredTo });
    }

    case "preview": {
      if (request.state !== "offered") return refuse(request, "invalid-transition");
      if (!request.offeredTo.includes(event.deviceId)) return refuse(request, "not-offered");
      return advance(request, "previewing", now);
    }

    case "accept": {
      if (request.state !== "offered" && request.state !== "previewing") return refuse(request, "invalid-transition");
      if (!request.offeredTo.includes(event.deviceId)) return refuse(request, "not-offered");
      return advance(request, "accepted", now, {
        acknowledgedBy: event.deviceId,
        acceptedVia: event.via ?? "operator",
      });
    }

    case "arrive": {
      if (request.state !== "accepted") return refuse(request, "invalid-transition");
      if (request.acknowledgedBy !== event.deviceId) return refuse(request, "not-acknowledger");
      /* Nowhere to land is not a follow. The device that agreed closes it with
         `abandon` instead, which writes one line to the conversation rather
         than a silent no-op — and never records a follow that did not happen. */
      if (event.resolution === "lost") return refuse(request, "lost-target");
      const returnPoints = [
        ...request.returnPoints.filter((point) => point.deviceId !== event.deviceId),
        event.returnPoint,
      ];
      return advance(request, "following", now, { returnPoints, resolution: event.resolution });
    }

    /* The accepting device's own way out of a handoff that found nowhere to go.
       It is deliberately none of the other three endings: nobody refused
       anything, so it is not `declined`; the offer was seen and agreed to, so
       it is not a TTL expiry; and the view never moved, so it is not a follow
       that was returned from. The cause on the record says which it was, and
       the request becomes terminal at once — otherwise it stays `accepted`
       forever and, being the oldest live entry, hides every later offer on that
       device behind a card nothing renders. */
    case "abandon": {
      if (request.state !== "accepted") return refuse(request, "invalid-transition");
      if (request.acknowledgedBy !== event.deviceId) return refuse(request, "not-acknowledger");
      return advance(request, "expired", now, { expiredCause: "lost" });
    }

    case "decline": {
      if (request.state !== "offered") return refuse(request, "invalid-transition");
      if (!request.offeredTo.includes(event.deviceId)) return refuse(request, "not-offered");
      return advance(request, "declined", now);
    }

    case "dismiss": {
      if (request.state !== "previewing") return refuse(request, "invalid-transition");
      if (!request.offeredTo.includes(event.deviceId)) return refuse(request, "not-offered");
      return advance(request, "declined", now);
    }

    case "return": {
      if (request.state !== "following") return refuse(request, "invalid-transition");
      if (request.acknowledgedBy !== event.deviceId) return refuse(request, "not-acknowledger");
      return advance(request, "returned", now, { returnedVia: event.via });
    }

    case "expire": {
      /* The clock's own event, and never a client's — see `validateAttentionEvent`.
         From `accepted` it is only ever the landing grace running out, so the
         cause is checked rather than trusted: nothing may end an agreed request
         by calling it a TTL expiry, which would say the operator never saw it. */
      const landingLost = request.state === "accepted" && event.cause === "lost";
      /* And from `following` it is only ever the follow hold, for the same
         reason: a follow the operator saw and agreed to may not be closed as a
         TTL expiry, which would report it to the agent as never seen. */
      const followElapsed = request.state === "following" && event.cause === "follow-elapsed";
      if (!PRE_ACCEPTANCE.includes(request.state) && !landingLost && !followElapsed) return refuse(request, "invalid-transition");
      /* The cause is kept, not just acted on: the caller that dropped a request
         to make room is gone as soon as its response is written, and the record
         still has to be able to say which kind of ending this was. */
      return advance(request, "expired", now, { expiredCause: event.cause });
    }

    case "supersede": {
      /* One speaker, so a second request means it changed its mind. */
      if (PRE_ACCEPTANCE.includes(request.state)) return advance(request, "superseded", now, { supersededBy: event.by });
      /* A follow may be replaced once its way back has collapsed, and never
         before. While the return control still names where the operator came
         from, superseding would take that point away from someone who is mid-
         handoff — so it is refused, and the newer request waits the window out.
         Afterwards the record holds nothing the operator can still use, and
         letting it shadow the newer request is how a live agent goes unheard.
         `accepted` is never superseded either way: the move is in flight. */
      if (request.state === "following" && !followReturnWindowOpen(request, now)) {
        return advance(request, "superseded", now, { supersededBy: event.by });
      }
      return refuse(request, "invalid-transition");
    }
  }
}
