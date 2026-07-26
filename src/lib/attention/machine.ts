import {
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
 * Whether the clock alone has run this request out. Only pre-acceptance states
 * expire: once the operator has agreed, the view has moved or is moving, and a
 * timer taking the return point away with it would strand them.
 */
export function isExpiredByClock(request: AttentionRequestV1, now: Date): boolean {
  return PRE_ACCEPTANCE.includes(request.state) && Date.parse(request.expiresAt) <= now.getTime();
}

/** Whether the return control still names where the operator came from. Past
    this it collapses to a conversation line that restores the same point. */
export function returnControlIsLive(request: AttentionRequestV1, deviceId: string, now: Date): boolean {
  if (request.state !== "following" || request.acknowledgedBy !== deviceId) return false;
  const captured = request.returnPoints.find((point) => point.deviceId === deviceId);
  return captured !== undefined && now.getTime() - Date.parse(captured.capturedAt) < RETURN_WINDOW_MS;
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
      /* Nowhere to land is not a follow. The caller expires the request, which
         writes one line to the conversation rather than a silent no-op. */
      if (event.resolution === "lost") return refuse(request, "lost-target");
      const returnPoints = [
        ...request.returnPoints.filter((point) => point.deviceId !== event.deviceId),
        event.returnPoint,
      ];
      return advance(request, "following", now, { returnPoints, resolution: event.resolution });
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
      if (!PRE_ACCEPTANCE.includes(request.state)) return refuse(request, "invalid-transition");
      /* The cause is kept, not just acted on: the caller that dropped a request
         to make room is gone as soon as its response is written, and the record
         still has to be able to say which kind of ending this was. */
      return advance(request, "expired", now, { expiredCause: event.cause });
    }

    case "supersede": {
      /* One speaker, so a second request means it changed its mind. It may not
         supersede a request the operator already agreed to: the view has moved,
         and taking the record away would take the return point with it. */
      if (!PRE_ACCEPTANCE.includes(request.state)) return refuse(request, "invalid-transition");
      return advance(request, "superseded", now, { supersededBy: event.by });
    }
  }
}
