import { expect, test } from "bun:test";

import {
  applyAttentionEvent,
  expiryCauseByClock,
  expiryFrom,
  isExpiredByClock,
  offerStatusForDevice,
  returnControlIsLive,
  type AttentionEvent,
} from "./machine";
import {
  ACCEPTED_LANDING_GRACE_MS,
  isTerminalAttentionState,
  OFFER_TTL_MS,
  RETURN_WINDOW_MS,
  type AttentionRequestV1,
  type AttentionState,
  type ReturnPoint,
} from "./types";

const T0 = new Date("2026-07-01T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

function request(overrides: Partial<AttentionRequestV1> = {}): AttentionRequestV1 {
  return {
    id: "attention_1",
    createdAt: T0.toISOString(),
    requestedBy: { rootId: "root_fixed" },
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "show",
    zoom: "situate",
    reason: "The reviewer finished with request-changes.",
    state: "pending",
    stateChangedAt: T0.toISOString(),
    expiresAt: expiryFrom(T0),
    offeredTo: [],
    returnPoints: [],
    revision: 0,
    ...overrides,
  };
}

const returnPoint = (deviceId: string): ReturnPoint => ({
  deviceId,
  mode: "scheme",
  camera: { x: 12, y: 34, zoom: 0.6 },
  focusedPath: "/tmp/where-i-was.jsonl",
  capturedAt: T0.toISOString(),
});

/** Drive a request to a state through the machine only, so no test ever
    hand-writes a state the machine could not actually produce. */
function drive(events: AttentionEvent[], start = request()): AttentionRequestV1 {
  return events.reduce((current, event) => {
    const transition = applyAttentionEvent(current, event, { now: T0 });
    if (!transition.ok) throw new Error(`setup transition ${event.kind} refused: ${transition.reason}`);
    return transition.request;
  }, start);
}

test("a rendered request becomes offered and names the device it reached", () => {
  const transition = applyAttentionEvent(request(), { kind: "offer", deviceId: "device-a" }, { now: T0 });

  expect(transition.ok).toBe(true);
  if (!transition.ok) return;
  expect(transition.request.state).toBe("offered");
  expect(transition.request.offeredTo).toEqual(["device-a"]);
  expect(transition.request.revision).toBe(1);
});

test("a second device rendering the same request adds itself without re-offering", () => {
  const offered = drive([{ kind: "offer", deviceId: "device-a" }]);

  const second = applyAttentionEvent(offered, { kind: "offer", deviceId: "device-b" }, { now: T0 });
  expect(second.ok && second.request.offeredTo).toEqual(["device-a", "device-b"]);

  const repeat = applyAttentionEvent(second.ok ? second.request : offered, { kind: "offer", deviceId: "device-b" }, { now: T0 });
  expect(repeat.ok && repeat.changed).toBe(false);
});

test("accept then arrive reaches following and carries the pre-move viewport", () => {
  const accepted = drive([{ kind: "offer", deviceId: "device-a" }, { kind: "accept", deviceId: "device-a" }]);
  expect(accepted.state).toBe("accepted");
  expect(accepted.acknowledgedBy).toBe("device-a");

  const arrived = applyAttentionEvent(accepted, {
    kind: "arrive",
    deviceId: "device-a",
    returnPoint: returnPoint("device-a"),
    resolution: "exact",
  }, { now: T0 });

  expect(arrived.ok).toBe(true);
  if (!arrived.ok) return;
  expect(arrived.request.state).toBe("following");
  expect(arrived.request.resolution).toBe("exact");
  expect(arrived.request.returnPoints).toEqual([returnPoint("device-a")]);
});

test("preview does not move the view, and dismissing after a look is a decline", () => {
  const previewing = drive([{ kind: "offer", deviceId: "device-a" }, { kind: "preview", deviceId: "device-a" }]);

  expect(previewing.state).toBe("previewing");
  /* "They looked and stayed put" is different information from silence, which
     is the whole reason previewing is a state rather than a UI detail. */
  expect(previewing.returnPoints).toEqual([]);

  const dismissed = applyAttentionEvent(previewing, { kind: "dismiss", deviceId: "device-a" }, { now: T0 });
  expect(dismissed.ok && dismissed.request.state).toBe("declined");
});

test("a manual pan during a follow ends the follow and records how it ended", () => {
  const following = drive([
    { kind: "offer", deviceId: "device-a" },
    { kind: "accept", deviceId: "device-a" },
    { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" },
  ]);

  const returned = applyAttentionEvent(following, { kind: "return", deviceId: "device-a", via: "manual-move" }, { now: T0 });

  expect(returned.ok).toBe(true);
  if (!returned.ok) return;
  expect(returned.request.state).toBe("returned");
  /* The record must never claim the operator is still looking at something
     they have already panned away from. */
  expect(returned.request.returnedVia).toBe("manual-move");
});

test.each<[string, AttentionEvent, AttentionState]>([
  ["arriving before anyone accepted", { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" }, "offered"],
  ["returning from an offer nobody accepted", { kind: "return", deviceId: "device-a", via: "control" }, "offered"],
  ["previewing something already accepted", { kind: "preview", deviceId: "device-a" }, "accepted"],
  ["declining something already accepted", { kind: "decline", deviceId: "device-a" }, "accepted"],
  ["expiring a request the view already moved for", { kind: "expire", cause: "ttl" }, "following"],
  ["superseding a request the view already moved for", { kind: "supersede", by: "attention_2" }, "following"],
])("out-of-order transition is refused: %s", (_label, event, state) => {
  const setup: Record<string, AttentionEvent[]> = {
    offered: [{ kind: "offer", deviceId: "device-a" }],
    accepted: [{ kind: "offer", deviceId: "device-a" }, { kind: "accept", deviceId: "device-a" }],
    following: [
      { kind: "offer", deviceId: "device-a" },
      { kind: "accept", deviceId: "device-a" },
      { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" },
    ],
  };
  const current = drive(setup[state]!);

  const transition = applyAttentionEvent(current, event, { now: T0 });

  expect(transition.ok).toBe(false);
  if (transition.ok) return;
  expect(transition.reason).toBe("invalid-transition");
  expect(transition.state).toBe(state);
});

test("a terminal request answers nothing, however late the click arrives", () => {
  const declined = drive([{ kind: "offer", deviceId: "device-a" }, { kind: "decline", deviceId: "device-a" }]);

  const late = applyAttentionEvent(declined, { kind: "accept", deviceId: "device-a" }, { now: later(1_000) });

  expect(late.ok).toBe(false);
  if (late.ok) return;
  expect(late.reason).toBe("invalid-transition");
});

test("a device that was never offered the request cannot answer it", () => {
  const offered = drive([{ kind: "offer", deviceId: "device-a" }]);

  const stranger = applyAttentionEvent(offered, { kind: "accept", deviceId: "device-b" }, { now: T0 });
  expect(stranger.ok === false && stranger.reason).toBe("not-offered");

  const accepted = drive([{ kind: "accept", deviceId: "device-a" }], offered);
  const wrongLander = applyAttentionEvent(accepted, {
    kind: "arrive",
    deviceId: "device-b",
    returnPoint: returnPoint("device-b"),
    resolution: "exact",
  }, { now: T0 });
  expect(wrongLander.ok === false && wrongLander.reason).toBe("not-acknowledger");
});

test("landing on a lost target is refused, and the device closes the request instead", () => {
  const accepted = drive([{ kind: "offer", deviceId: "device-a" }, { kind: "accept", deviceId: "device-a" }]);

  const transition = applyAttentionEvent(accepted, {
    kind: "arrive",
    deviceId: "device-a",
    returnPoint: returnPoint("device-a"),
    resolution: "lost",
  }, { now: T0 });

  expect(transition.ok).toBe(false);
  if (transition.ok) return;
  expect(transition.reason).toBe("lost-target");

  /* And that is the whole point of `abandon`: without it the request has no
     legal event left at all — every one of these is refused from `accepted` —
     so it stays the device's oldest live entry forever and every later request
     is offered behind it, rendered by nothing, and expires as if ignored. */
  for (const event of [
    { kind: "expire", cause: "ttl" },
    { kind: "decline", deviceId: "device-a" },
    { kind: "dismiss", deviceId: "device-a" },
    { kind: "return", deviceId: "device-a", via: "control" },
    { kind: "offer", deviceId: "device-a" },
    { kind: "supersede", by: "attention_2" },
  ] as const satisfies readonly AttentionEvent[]) {
    expect(applyAttentionEvent(accepted, event, { now: T0 }).ok).toBe(false);
  }

  const closed = applyAttentionEvent(accepted, { kind: "abandon", deviceId: "device-a" }, { now: T0 });
  expect(closed.ok).toBe(true);
  if (!closed.ok) return;
  expect(closed.request.state).toBe("expired");
  /* Its own cause: not a refusal, and not "they never answered". */
  expect(closed.request.expiredCause).toBe("lost");
  expect(isTerminalAttentionState(closed.request.state)).toBe(true);
});

test("only the device that agreed may abandon, and only from accepted", () => {
  const accepted = drive([
    { kind: "offer", deviceId: "device-a" },
    { kind: "offer", deviceId: "device-b" },
    { kind: "accept", deviceId: "device-a" },
  ]);

  const other = applyAttentionEvent(accepted, { kind: "abandon", deviceId: "device-b" }, { now: T0 });
  expect(other.ok).toBe(false);
  if (other.ok) return;
  expect(other.reason).toBe("not-acknowledger");

  /* A device that has not agreed to anything cannot close an offer it simply
     does not like — that is what `decline` is, and it is a different fact. */
  const offered = drive([{ kind: "offer", deviceId: "device-a" }]);
  const early = applyAttentionEvent(offered, { kind: "abandon", deviceId: "device-a" }, { now: T0 });
  expect(early.ok).toBe(false);
  if (early.ok) return;
  expect(early.reason).toBe("invalid-transition");
});

test("an agreed request that never lands is ended by the clock as lost, never as unseen", () => {
  const accepted = drive([{ kind: "offer", deviceId: "device-a" }, { kind: "accept", deviceId: "device-a" }]);

  /* The move is bounded by the board wait, so a request still `accepted` a
     minute later is a device that agreed and then went away — a closed tab, a
     crash. Nothing else could ever end it. */
  expect(expiryCauseByClock(accepted, later(ACCEPTED_LANDING_GRACE_MS - 1))).toBeNull();
  expect(expiryCauseByClock(accepted, later(ACCEPTED_LANDING_GRACE_MS))).toBe("lost");

  /* And a TTL is not a thing that may be said about it: "they never answered"
     is exactly the fact the record is there to keep straight. */
  const asUnseen = applyAttentionEvent(accepted, { kind: "expire", cause: "ttl" }, { now: later(ACCEPTED_LANDING_GRACE_MS) });
  expect(asUnseen.ok).toBe(false);
  const asLost = applyAttentionEvent(accepted, { kind: "expire", cause: "lost" }, { now: later(ACCEPTED_LANDING_GRACE_MS) });
  expect(asLost.ok).toBe(true);
  if (!asLost.ok) return;
  expect(asLost.request.expiredCause).toBe("lost");
});

test("a writer working from a revision that has moved is refused", () => {
  const offered = drive([{ kind: "offer", deviceId: "device-a" }]);

  const stale = applyAttentionEvent(offered, { kind: "accept", deviceId: "device-a" }, { now: T0, expectedRevision: 0 });

  expect(stale.ok).toBe(false);
  if (stale.ok) return;
  expect(stale.reason).toBe("stale-revision");
});

test("an unanswered request runs out on the TTL, and a followed one has no clock at all", () => {
  const pending = request();
  expect(expiryCauseByClock(pending, later(OFFER_TTL_MS - 1))).toBeNull();
  expect(expiryCauseByClock(pending, later(OFFER_TTL_MS))).toBe("ttl");
  expect(isExpiredByClock(pending, later(OFFER_TTL_MS))).toBe(true);

  const following = drive([
    { kind: "offer", deviceId: "device-a" },
    { kind: "accept", deviceId: "device-a" },
    { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" },
  ]);
  /* A timer taking the return point away after the view already moved would
     strand the operator wherever they landed. */
  expect(isExpiredByClock(following, later(OFFER_TTL_MS * 10))).toBe(false);
});

test("the return control names where you came from for its window, then stops", () => {
  const following = drive([
    { kind: "offer", deviceId: "device-a" },
    { kind: "accept", deviceId: "device-a" },
    { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" },
  ]);

  expect(returnControlIsLive(following, "device-a", later(RETURN_WINDOW_MS - 1))).toBe(true);
  expect(returnControlIsLive(following, "device-a", later(RETURN_WINDOW_MS))).toBe(false);
  expect(returnControlIsLive(following, "device-b", T0)).toBe(false);
});

test("the devices that did not accept read the record as withdrawn, with no second write", () => {
  const following = drive([
    { kind: "offer", deviceId: "device-a" },
    { kind: "offer", deviceId: "device-b" },
    { kind: "accept", deviceId: "device-a" },
    { kind: "arrive", deviceId: "device-a", returnPoint: returnPoint("device-a"), resolution: "exact" },
  ]);

  expect(offerStatusForDevice(following, "device-a")).toBe("following");
  expect(offerStatusForDevice(following, "device-b")).toBe("withdrawn");

  const offered = drive([{ kind: "offer", deviceId: "device-a" }]);
  expect(offerStatusForDevice(offered, "device-a")).toBe("actionable");
  expect(offerStatusForDevice(offered, "device-b")).toBe("none");
  /* A request no device has rendered is nobody's to answer yet. */
  expect(offerStatusForDevice(request(), "device-a")).toBe("none");
});
