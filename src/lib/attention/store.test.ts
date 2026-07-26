import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordRootSession } from "@/lib/root/store";

import {
  attentionFile,
  AttentionStoreError,
  AttentionValidationError,
  createAttentionRequest,
  liveAttentionRequests,
  readAttentionFile,
  sweepExpiredAttention,
  transitionAttentionRequest,
  type AttentionCreateInput,
} from "./store";
import { OFFER_TTL_MS, QUEUE_CAP, type FocusFrame } from "./types";

let sandbox = "";
let previousStateDir: string | undefined;

const T0 = new Date("2026-07-01T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-attention-store-"));
  /* Every write in this file lands in the sandbox, never the shared state dir. */
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const frame: FocusFrame = { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 };

function input(overrides: Partial<AttentionCreateInput> = {}): AttentionCreateInput {
  return {
    rootId: "root_fixed",
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: frame,
    intent: "show",
    reason: "The reviewer finished with request-changes.",
    ...overrides,
  };
}

test("a created request round-trips through the state file with a bumped file revision", () => {
  const { request } = createAttentionRequest(input(), { now: T0, id: "attention_1" });

  const file = readAttentionFile();
  expect(file.revision).toBe(1);
  expect(file.requests).toEqual([request]);
  expect(request.state).toBe("pending");
  expect(request.expiresAt).toBe(later(OFFER_TTL_MS).toISOString());
  /* Zoom follows intent rather than being asked for separately: `show` fits the
     frame with context, `open` zooms in until it is readable. */
  expect(request.zoom).toBe("situate");
  expect(createAttentionRequest(input({ intent: "open" }), { now: T0, id: "attention_2" }).request.zoom).toBe("inspect");
});

test("the file is replaced by rename, leaving no temp file behind", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  expect(fs.readdirSync(sandbox).filter((entry) => entry.includes(".tmp"))).toEqual([]);
});

test("a request outlives a root session rollover because it names the root, not the session", () => {
  const first = recordRootSession({ conversationId: "conversation_a", path: "/tmp/a.jsonl" }, { now: T0 });
  const { request } = createAttentionRequest(input({ rootId: first.lineage.rootId }), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  /* The root agent's context filled up; a fresh session took over. */
  const rolled = recordRootSession({ conversationId: "conversation_b", path: "/tmp/b.jsonl" }, { now: later(60_000), reason: "rollover" });
  expect(rolled.outcome).toBe("rolled-over");

  const survivor = readAttentionFile().requests.find((entry) => entry.id === request.id);
  expect(survivor).toBeDefined();
  expect(survivor!.state).toBe("offered");
  expect(survivor!.requestedBy.rootId).toBe(rolled.lineage.rootId);

  /* And it is still answerable afterwards — the point of the whole exercise. */
  const accepted = transitionAttentionRequest("attention_1", { kind: "accept", deviceId: "device-a" }, { now: later(120_000) });
  expect(accepted.ok).toBe(true);
});

test("an unacknowledged request expires on the clock and reports which ones did", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  expect(sweepExpiredAttention({ now: later(OFFER_TTL_MS - 1) })).toEqual([]);
  expect(sweepExpiredAttention({ now: later(OFFER_TTL_MS) })).toEqual(["attention_1"]);

  expect(readAttentionFile().requests[0]!.state).toBe("expired");
  /* One sweep, one expiry: a second pass has nothing left to say. */
  expect(sweepExpiredAttention({ now: later(OFFER_TTL_MS * 2) })).toEqual([]);
});

test("a request nobody ever rendered expires on the same clock", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });

  expect(sweepExpiredAttention({ now: later(OFFER_TTL_MS) })).toEqual(["attention_1"]);
  expect(readAttentionFile().requests[0]!.state).toBe("expired");
});

test("an out-of-order transition is refused and never reaches the file", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });

  const refused = transitionAttentionRequest("attention_1", { kind: "return", deviceId: "device-a", via: "control" }, { now: T0 });

  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.reason).toBe("invalid-transition");
  const file = readAttentionFile();
  expect(file.requests[0]!.state).toBe("pending");
  /* A refused write must not churn the file revision either. */
  expect(file.revision).toBe(1);
});

test("a transition against an unknown id is reported rather than thrown", () => {
  const missing = transitionAttentionRequest("attention_nope", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  expect(missing).toEqual({ ok: false, reason: "not-found" });
});

test("a newer root-agent request supersedes that root's unanswered one", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  const second = createAttentionRequest(input({ reason: "Actually, the deploy is the thing to look at." }), { now: later(1_000), id: "attention_2" });

  expect(second.superseded).toEqual(["attention_1"]);
  const file = readAttentionFile();
  expect(file.requests.find((entry) => entry.id === "attention_1")!.state).toBe("superseded");
  expect(file.requests.find((entry) => entry.id === "attention_1")!.supersededBy).toBe("attention_2");
  expect(liveAttentionRequests(file).map((entry) => entry.id)).toEqual(["attention_2"]);
});

test("a request the operator already agreed to is not superseded out from under them", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });
  transitionAttentionRequest("attention_1", { kind: "accept", deviceId: "device-a" }, { now: T0 });

  const second = createAttentionRequest(input(), { now: later(1_000), id: "attention_2" });

  expect(second.superseded).toEqual([]);
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_1")!.state).toBe("accepted");
});

test("an operator command enters at accepted, skipping consent but still recorded", () => {
  const { request } = createAttentionRequest(input({ origin: "operator", offeredTo: ["device-a"] }), { now: T0, id: "attention_1" });

  expect(request.state).toBe("accepted");
  expect(request.acknowledgedBy).toBe("device-a");
  expect(request.acceptedVia).toBe("operator");
  /* Recorded means return, expiry and the multi-device rules apply uniformly. */
  expect(readAttentionFile().requests[0]!.expiresAt).toBe(later(OFFER_TTL_MS).toISOString());
});

test("an operator command does not supersede the root agent's pending offer", () => {
  createAttentionRequest(input(), { now: T0, id: "attention_1" });
  transitionAttentionRequest("attention_1", { kind: "offer", deviceId: "device-a" }, { now: T0 });

  const operator = createAttentionRequest(input({ origin: "operator", offeredTo: ["device-a"] }), { now: later(500), id: "attention_2" });

  expect(operator.superseded).toEqual([]);
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_1")!.state).toBe("offered");
});

test("the queue is capped, and an overflowing entry is named so it can be said aloud", () => {
  /* Distinct roots, because a single root superseding its own older request is
     the rule that normally keeps this queue at one. */
  for (let index = 0; index < QUEUE_CAP; index += 1) {
    createAttentionRequest(input({ rootId: `root_${index}` }), { now: T0, id: `attention_${index}` });
  }

  const overflow = createAttentionRequest(input({ rootId: "root_new" }), { now: later(1_000), id: "attention_new" });

  expect(overflow.dropped).toEqual(["attention_0"]);
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_0")!.state).toBe("expired");
  expect(liveAttentionRequests(readAttentionFile())).toHaveLength(QUEUE_CAP);
});

test("a request the operator already agreed to neither counts against the queue nor is evicted", () => {
  createAttentionRequest(input({ origin: "operator", offeredTo: ["device-a"] }), { now: T0, id: "attention_accepted" });
  for (let index = 0; index < QUEUE_CAP; index += 1) {
    createAttentionRequest(input({ rootId: `root_${index}` }), { now: T0, id: `attention_${index}` });
  }

  const overflow = createAttentionRequest(input({ rootId: "root_new" }), { now: later(1_000), id: "attention_new" });

  expect(overflow.dropped).toEqual(["attention_0"]);
  expect(readAttentionFile().requests.find((entry) => entry.id === "attention_accepted")!.state).toBe("accepted");
});

test("a geometric target may be shown but never opened", () => {
  const shown = createAttentionRequest(input({
    target: { kind: "point", project: "demo", x: 120, y: 340 },
    intent: "show",
  }), { now: T0, id: "attention_1" });
  expect(shown.request.target.kind).toBe("point");

  /* Refused at creation with a clear error rather than silently downgraded:
     the operator is told which of show/open they are agreeing to. */
  expect(() => createAttentionRequest(input({
    target: { kind: "region", project: "demo", rect: { x: 0, y: 0, w: 10, h: 10 } },
    intent: "open",
  }), { now: T0, id: "attention_2" })).toThrow(AttentionValidationError);
});

test.each([
  ["a request with no root identity", { rootId: "" }],
  ["a request with no reason", { reason: "   " }],
  ["a request whose reason is an essay", { reason: "x".repeat(1_000) }],
  ["a request with an unknown target kind", { target: { kind: "galaxy" } as never }],
  ["a request with no frame", { frameAtCreation: undefined as never }],
])("invalid input is refused: %s", (_label, overrides) => {
  expect(() => createAttentionRequest(input(overrides), { now: T0 })).toThrow(AttentionValidationError);
  /* Nothing invalid ever reaches the file. */
  expect(fs.existsSync(attentionFile())).toBe(false);
});

test("a malformed state file refuses to read rather than losing in-flight requests", () => {
  fs.mkdirSync(path.dirname(attentionFile()), { recursive: true });
  fs.writeFileSync(attentionFile(), "{ not json", "utf8");

  expect(() => readAttentionFile()).toThrow(AttentionStoreError);
});

test("state written by an unknown schema is refused", () => {
  fs.mkdirSync(path.dirname(attentionFile()), { recursive: true });
  fs.writeFileSync(attentionFile(), JSON.stringify({ schemaVersion: 99, revision: 0, updatedAt: "", requests: [] }), "utf8");

  expect(() => readAttentionFile()).toThrow(AttentionStoreError);
});
