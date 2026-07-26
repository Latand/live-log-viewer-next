import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
});

afterEach(() => {
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
