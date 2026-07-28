import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { readAttentionFile } from "./store";
import { answerAttentionRequest, attentionForDevice, autoFollowEligible, raiseAttentionRequest } from "./service";
import { AttentionRequestError, validateAttentionCreate, validateAttentionEvent } from "./validation";
import { FOLLOW_HOLD_MS, OFFER_TTL_MS, RETURN_WINDOW_MS, type FocusFrame, type ReturnPoint } from "./types";

let sandbox = "";
let previousStateDir: string | undefined;

const T0 = new Date("2026-07-01T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const DEVICE = "device-desktop";

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-service-"));
  process.env.LLV_STATE_DIR = sandbox;
  /* Presence decides who a request is offered to, so a view left over from
     another test would answer this one's question for it. */
  resetPresenceForTest();
});

afterEach(() => {
  resetPresenceForTest();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const frame: FocusFrame = { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 };

function raise(overrides: Record<string, unknown> = {}) {
  return raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The reviewer finished with request-changes.",
    ...overrides,
  }, { now: T0, id: "attention_1" });
}

const whereIWas: ReturnPoint = {
  deviceId: DEVICE,
  mode: "scheme",
  camera: { x: 120, y: 340, zoom: 0.55 },
  focusedPath: "/tmp/what-i-was-reading.jsonl",
  capturedAt: T0.toISOString(),
};

test("ask, accept, land, and go back — the whole loop at one device", () => {
  raise();

  /* Raised, but nothing has rendered it, so there is nothing to answer yet. */
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();

  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  const offered = attentionForDevice(DEVICE, { now: T0 });
  expect(offered.offer!.status).toBe("actionable");
  expect(offered.offer!.request.intent).toBe("show");

  answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", {
    kind: "arrive",
    deviceId: DEVICE,
    returnPoint: whereIWas,
    resolution: "exact",
  }, { now: T0 });

  const following = attentionForDevice(DEVICE, { now: T0 });
  expect(following.offer!.status).toBe("following");
  expect(following.offer!.returnAvailable).toBe(true);
  /* Return restores the exact viewport captured before the move — mode, camera
     and focused path — and it is recorded against this device, not the seat. */
  expect(following.offer!.request.returnPoints).toEqual([whereIWas]);

  const returned = answerAttentionRequest("attention_1", { kind: "return", deviceId: DEVICE, via: "control" }, { now: T0 });
  expect(returned.ok).toBe(true);
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();
});

test("declining is terminal and is reported as a refusal rather than as silence", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });

  answerAttentionRequest("attention_1", { kind: "decline", deviceId: DEVICE }, { now: T0 });

  expect(readAttentionFile().requests[0]!.state).toBe("declined");
  expect(attentionForDevice(DEVICE, { now: T0 }).live).toEqual([]);
});

test("the return control collapses after its window while the record stays put", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE }, { now: T0 });
  answerAttentionRequest("attention_1", { kind: "arrive", deviceId: DEVICE, returnPoint: whereIWas, resolution: "exact" }, { now: T0 });

  const after = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS + 1) });

  expect(after.offer!.returnAvailable).toBe(false);
  /* It collapses to a conversation line that still restores it, so the point
     itself must survive the control disappearing. */
  expect(after.offer!.request.returnPoints).toEqual([whereIWas]);
  expect(answerAttentionRequest("attention_1", { kind: "return", deviceId: DEVICE, via: "control" }, { now: later(RETURN_WINDOW_MS + 1) }).ok).toBe(true);
});

/** Drive one request all the way to `following` at this device. */
function followAt(id: string, now = T0) {
  answerAttentionRequest(id, { kind: "offer", deviceId: DEVICE }, { now });
  answerAttentionRequest(id, { kind: "accept", deviceId: DEVICE }, { now });
  answerAttentionRequest(id, {
    kind: "arrive",
    deviceId: DEVICE,
    returnPoint: { ...whereIWas, capturedAt: now.toISOString() },
    resolution: "exact",
  }, { now });
}

test("a follow the operator never closes stops being this device's only offer", () => {
  raise();
  followAt("attention_1");

  /* The whole defect, at the surface it is felt on. `following` admits no event
     but Return, so an operator who walks away instead leaves this request live
     forever; as the oldest live entry it is what the device renders, and the
     request raised after it never reaches a screen at all. */
  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/verifier.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now: later(RETURN_WINDOW_MS + 1), id: "attention_2" });

  /* Raising it is what collapses the stale follow: one speaker, and its way
     back had already gone. */
  expect(second.superseded).toEqual(["attention_1"]);

  /* And it reaches the screen — the device renders it exactly as the polling
     surface does, and the record moves pending → offered. */
  answerAttentionRequest("attention_2", { kind: "offer", deviceId: DEVICE }, { now: later(RETURN_WINDOW_MS + 1) });

  const view = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS + 1) });
  expect(view.offer!.request.id).toBe("attention_2");
  expect(view.offer!.status).toBe("actionable");
});

test("a follow is bounded even when nothing is ever raised after it", () => {
  raise();
  followAt("attention_1");

  /* Nothing supersedes it, nobody presses Return: the clock is the only thing
     left, and without it this record is live for the life of the file. */
  const view = attentionForDevice(DEVICE, { now: later(FOLLOW_HOLD_MS) });

  expect(view.expired).toEqual(["attention_1"]);
  expect(view.offer).toBeNull();
  expect(view.live).toEqual([]);
  /* Ended as what it was: seen, agreed to, and never closed. */
  expect(readAttentionFile().requests[0]!.expiredCause).toBe("follow-elapsed");
});

test("an operator still mid-handoff keeps the return control, and the newer request waits", () => {
  raise();
  followAt("attention_1");

  const second = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/verifier.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The verifier is blocked on you.",
  }, { now: later(RETURN_WINDOW_MS - 1), id: "attention_2" });

  /* Inside the window the way back is still the operator's, so nothing takes it
     from them — the newer request queues rather than evicting a live handoff. */
  expect(second.superseded).toEqual([]);
  answerAttentionRequest("attention_2", { kind: "offer", deviceId: DEVICE }, { now: later(RETURN_WINDOW_MS - 1) });

  const view = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS - 1) });
  expect(view.offer!.request.id).toBe("attention_1");
  expect(view.offer!.returnAvailable).toBe(true);

  /* And it is a wait, not a loss: the moment the control collapses the newer
     request is what this device is shown. */
  const after = attentionForDevice(DEVICE, { now: later(RETURN_WINDOW_MS) });
  expect(after.offer!.request.id).toBe("attention_2");
});

test("reading sweeps the clock, so an unacknowledged request cannot linger as a live card", () => {
  raise();
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });

  const view = attentionForDevice(DEVICE, { now: later(OFFER_TTL_MS) });

  expect(view.expired).toEqual(["attention_1"]);
  expect(view.offer).toBeNull();
  /* Reported exactly once: the caller writes one conversation line per id. */
  expect(attentionForDevice(DEVICE, { now: later(OFFER_TTL_MS + 1) }).expired).toEqual([]);
});

test("the root identity is resolved server-side, never taken from the caller", () => {
  const { request } = raise();

  expect(request.requestedBy.rootId).toStartWith("root_");
  expect(attentionForDevice(DEVICE, { now: T0 }).rootId).toBe(request.requestedBy.rootId);
});

test("a journal event is evidence on a request, never a request — and never moves the view", () => {
  /* #686 terminal events mark candidates; the root agent decides whether to
     raise one. There is no door here a journal event can come through on its
     own, which is what keeps D4 intact. */
  expect(() => validateAttentionCreate({
    origin: "journal",
    target: { kind: "conversation", path: "/tmp/a.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "A stage failed.",
  })).toThrow(AttentionRequestError);

  const { request } = raise({ candidates: [{ eventId: "event_1", kind: "stage-failed" }] });

  /* Carrying the evidence changes nothing about consent: it still starts at
     pending and still needs the operator's yes before anything moves. */
  expect(request.candidates).toEqual([{ eventId: "event_1", kind: "stage-failed" }]);
  expect(request.state).toBe("pending");
  expect(attentionForDevice(DEVICE, { now: T0 }).offer).toBeNull();
});

test("a client cannot expire or supersede somebody else's offer", () => {
  /* A device that could expire another device's offer is a device that can
     silence the agent, so those two events have no HTTP shape at all. */
  expect(() => validateAttentionEvent({ kind: "expire", cause: "ttl" })).toThrow(AttentionRequestError);
  expect(() => validateAttentionEvent({ kind: "supersede", by: "attention_2" })).toThrow(AttentionRequestError);
  expect(validateAttentionEvent({ kind: "accept", deviceId: DEVICE })).toEqual({ kind: "accept", deviceId: DEVICE });
});

test("a request body missing its frame or its reason is refused before it reaches the store", () => {
  expect(() => validateAttentionCreate({ origin: "root-agent", target: { kind: "conversation", path: "/tmp/a.jsonl" }, intent: "show", reason: "x" }))
    .toThrow(AttentionRequestError);
  expect(() => validateAttentionCreate({ origin: "root-agent", target: { kind: "conversation", path: "/tmp/a.jsonl" }, intent: "show", frameAtCreation: frame }))
    .toThrow(AttentionRequestError);
});

test("a phone in a pocket never auto-follows, even where consent exists", () => {
  expect(autoFollowEligible({ visibility: "visible", freshness: "active" })).toBe(true);
  expect(autoFollowEligible({ visibility: "hidden", freshness: "active" })).toBe(false);
  expect(autoFollowEligible({ visibility: "visible", freshness: "background" })).toBe(false);
  expect(autoFollowEligible(null)).toBe(false);
});

test("a conversation target resolves to the durable conversation's current transcript", () => {
  const abandonedFork = "/tmp/sessions/rollout-fork.jsonl";
  const currentPath = "/tmp/sessions/rollout-root.jsonl";
  const conversations = {
    conversationForPath: (artifactPath: string) => artifactPath === abandonedFork || artifactPath === currentPath
      ? { generations: [{ path: "/tmp/sessions/rollout-archived.jsonl" }, { path: currentPath }] } as never
      : null,
    canonicalConversationId: (id: never) => id,
    conversation: () => null,
  };

  const raised = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: abandonedFork },
    frameAtCreation: frame,
    intent: "open",
    reason: "The root conversation answered.",
  }, { now: T0, id: "attention_fork", conversations });

  expect(raised.request.target).toEqual({ kind: "conversation", path: currentPath });
});

test("a conversation target with no durable owner is left exactly as raised", () => {
  const unknown = "/tmp/sessions/rollout-unknown.jsonl";
  const conversations = {
    conversationForPath: () => null,
    canonicalConversationId: (id: never) => id,
    conversation: () => null,
  };

  const raised = raiseAttentionRequest({
    origin: "root-agent",
    target: { kind: "conversation", path: unknown },
    frameAtCreation: frame,
    intent: "show",
    reason: "An unregistered transcript still has a card.",
  }, { now: T0, id: "attention_unknown", conversations });

  expect(raised.request.target).toEqual({ kind: "conversation", path: unknown });
});

/* ── Who the request is put in front of ─────────────────────────────────── */

function view(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: DEVICE,
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "demo",
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: "/tmp/reviewer.jsonl",
    selectedPaths: [],
    visiblePaths: [],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
    ...overrides,
  };
}

test("a request names the desktop views that are open when it is raised", () => {
  /* The operator's symptom: the agent's tool answers synchronously and then
     speaks about what it asked for, so an `offeredTo` that only fills in on some
     browser's next poll told every caller that nobody was there. */
  upsertPresence(view(), T0.getTime());

  const raised = raise().request;

  expect(raised.offeredTo).toEqual([DEVICE]);
  /* Naming the device is not agreeing on its behalf: the request is still
     waiting for a surface to render it. */
  expect(raised.state).toBe("pending");
  expect(raised.acknowledgedBy).toBeUndefined();
});

test("the phone is never named: it cannot render an offer and cannot move its board", () => {
  upsertPresence(view({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([]);
});

test("a desktop reading the history list is not named: there is no board to move", () => {
  /* The silent failure this offer exists to remove, reappearing one level up. A
     board controller is registered by the scheme board and the phone's focus
     view and by nothing else, so a desktop sitting in the list has no camera and
     no anchors: the handoff finds no controller, resolves `lost`, and NOTHING
     ON SCREEN MOVES. Naming it anyway means the request is accepted, the agent
     is told which desktop is watching, and the operator is shown nothing. */
  upsertPresence(view({ viewSessionId: "view-list", deviceId: "device-list", mode: "list" }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([]);
});

test("a desktop on the overview is still named: landing there opens a project and mounts a board", () => {
  /* Not symmetric with the list, and the difference is the whole point. A
     handoff from the overview OPENS the target's project, which mounts the
     board, and the handoff already waits for that board to publish. The list is
     the mode the operator chose INSTEAD of a board, so no wait can produce one. */
  upsertPresence(view({ viewSessionId: "view-overview", deviceId: DEVICE, mode: "overview", project: null, camera: null }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([DEVICE]);
});

test("a backgrounded or long-silent view is not somewhere the operator can be taken", () => {
  upsertPresence(view({ viewSessionId: "view-hidden", deviceId: "device-hidden", visibility: "hidden" }), T0.getTime());
  /* Visible, but last heard from long enough ago that it may be a laptop that
     was shut. */
  upsertPresence(view({ viewSessionId: "view-stale", deviceId: "device-stale" }), T0.getTime() - 120_000);

  expect(raise().request.offeredTo).toEqual([]);
});

test("two tabs on one machine are one place to be taken", () => {
  upsertPresence(view({ viewSessionId: "view-a" }), T0.getTime());
  upsertPresence(view({ viewSessionId: "view-b" }), T0.getTime());

  expect(raise().request.offeredTo).toEqual([DEVICE]);
});

test("a device offered at creation may answer the request without any further ceremony", () => {
  upsertPresence(view(), T0.getTime());
  raise();

  /* The seeded list is the same list the machine checks, so the surface that was
     named can take the request through its whole life. */
  answerAttentionRequest("attention_1", { kind: "offer", deviceId: DEVICE }, { now: T0 });
  expect(attentionForDevice(DEVICE, { now: T0 }).offer!.status).toBe("actionable");
  expect(readAttentionFile().requests[0]!.offeredTo).toEqual([DEVICE]);

  const accepted = answerAttentionRequest("attention_1", { kind: "accept", deviceId: DEVICE, via: "auto-follow" }, { now: T0 });
  expect(accepted.ok).toBe(true);
});

test("an operator command still names its own device and nothing else", () => {
  /* An operator command is their own act on one surface; presence must never
     widen it, because the first named device is the one recorded as having
     accepted it. */
  upsertPresence(view({ viewSessionId: "view-other", deviceId: "device-elsewhere" }), T0.getTime());

  const raised = raiseAttentionRequest({
    origin: "operator",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "Take me to the reviewer.",
    offeredTo: [DEVICE],
  }, { now: T0, id: "attention_operator" }).request;

  expect(raised.offeredTo).toEqual([DEVICE]);
  expect(raised.acknowledgedBy).toBe(DEVICE);
});
