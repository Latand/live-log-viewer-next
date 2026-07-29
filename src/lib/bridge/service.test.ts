import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rememberAcknowledgedVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { mintBridgeConfirmation } from "./confirmation";
import {
  acknowledgeBridgeDelivery,
  authorizeBridgeDeploy,
  bridgeTurnStartPrelude,
  pendingBridgeDelivery,
  recordManagerReport,
} from "./service";
import { appendBridgeReports, drainBridgeReports, openBridgeChannel, readBridgeChannel } from "./store";

/**
 * The production orchestration — the layer the reviewer found missing.
 *
 * `store.ts` and `bridgeDelivery.ts` hold contracts; nothing shipped called them
 * in order. These tests drive the ordering itself: open the channel from the root
 * identity, drain, plan, hand the delivery over, acknowledge, heal. Each one fails
 * if a step is skipped rather than merely mis-implemented.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-service-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const ROOT_ID = "root_service_0001";
const NOW = new Date("2026-07-27T12:00:00.000Z");
const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

const rootIdentity = () => ROOT_ID;

test("the manager's report reaches a live call as one delivery, through one call", () => {
  sandbox();
  recordManagerReport({
    key: "stage-7-completed",
    class: "completed",
    at: NOW.toISOString(),
    body: "builder finished #726",
  });

  const pending = pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: null });
  expect(pending.kind).toBe("deliver");
  if (pending.kind !== "deliver") throw new Error("unreachable");
  expect(pending.delivery.responses[0]!.text).toContain("builder finished #726");
  expect(pending.throughSeq).toBe(1);

  /* Opening the channel is part of the production path, not something a caller
     has to remember: a first report on a fresh install must still be deliverable. */
  expect(readBridgeChannel()?.rootId).toBe(ROOT_ID);
});

test("acknowledging advances the durable cursor so the next call starts clean", () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: NOW.toISOString(), body: "one" });
  recordManagerReport({ key: "b", class: "status", at: NOW.toISOString(), body: "two" });

  const pending = pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: null });
  if (pending.kind !== "deliver") throw new Error("expected a delivery");
  acknowledgeBridgeDelivery(pending.throughSeq);

  expect(readBridgeChannel()?.managerReportCursor).toBe(2);
  expect(pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: null }).kind).toBe("idle");
});

test("a lost cursor write heals through the production path instead of wedging it", () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: NOW.toISOString(), body: "one" });

  const first = pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: null });
  if (first.kind !== "deliver") throw new Error("expected a delivery");
  const tombstones = rememberAcknowledgedVoiceDelivery([], first.delivery.deliveryId);
  /* Ack lost: the cursor never moved. */
  expect(readBridgeChannel()?.managerReportCursor).toBe(0);

  const healing = pendingBridgeDelivery({
    rootIdentity,
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  expect(healing).toEqual({ kind: "already-acknowledged", throughSeq: 1 });
  acknowledgeBridgeDelivery(healing.kind === "already-acknowledged" ? healing.throughSeq : 0);
  expect(readBridgeChannel()?.managerReportCursor).toBe(1);
});

test("the coalescing window is enforced on the production path, not just in the planner", () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: NOW.toISOString(), body: "one" });
  const justNow = new Date(NOW.getTime() - 1_000);
  expect(pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: justNow })).toEqual({ kind: "hold" });
});

test("a trim that outran the cursor delivers the gap notice rather than dropping it (§7.12)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  for (let index = 0; index < 520; index += 1) {
    appendBridgeReports([{ key: `r${index}`, class: "status", at: NOW.toISOString(), body: `report ${index}` }]);
  }

  const pending = pendingBridgeDelivery({ rootIdentity, now: NOW, lastBatchAt: null });
  if (pending.kind !== "deliver") throw new Error("expected a delivery");
  expect(pending.delivery.responses[0]!.text).toContain("no longer available");
  /* And it is acknowledgeable, so the gap is crossed once rather than every poll. */
  acknowledgeBridgeDelivery(pending.throughSeq);
  expect(readBridgeChannel()!.managerReportCursor).toBeGreaterThanOrEqual(20);
});

/* §4 deploy round trip, end to end through the production authorization path. */

test("a confirmed deploy authorizes exactly the confirmed SHA, once", () => {
  sandbox();
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: NOW });
  recordManagerReport({
    key: "confirm-726",
    class: "confirmation_request",
    at: NOW.toISOString(),
    body: "gates green",
    confirmation,
  });
  const seq = drainBridgeReports().reports[0]!.seq;
  const answeredAt = new Date(NOW.getTime() + 30_000);

  expect(authorizeBridgeDeploy({ ref: seq, nonce: confirmation.nonce, sha: SHA }, answeredAt))
    .toEqual({ ok: true, sha: SHA });

  /* Replay of the same authorization deploys nothing more. */
  expect(authorizeBridgeDeploy({ ref: seq, nonce: confirmation.nonce, sha: SHA }, answeredAt))
    .toEqual({ ok: false, reason: "consumed" });
});

test("an expired, mismatched or unknown authorization deploys nothing", () => {
  sandbox();
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: NOW });
  recordManagerReport({
    key: "confirm-expiry",
    class: "confirmation_request",
    at: NOW.toISOString(),
    confirmation,
  });
  const seq = drainBridgeReports().reports[0]!.seq;

  expect(authorizeBridgeDeploy({ ref: seq, nonce: confirmation.nonce, sha: "b".repeat(40) }, NOW))
    .toEqual({ ok: false, reason: "sha_mismatch" });
  expect(authorizeBridgeDeploy({ ref: seq, nonce: "wrong", sha: SHA }, NOW))
    .toEqual({ ok: false, reason: "nonce_mismatch" });
  expect(authorizeBridgeDeploy({ ref: 9_999, nonce: confirmation.nonce, sha: SHA }, NOW))
    .toEqual({ ok: false, reason: "no_confirmation" });

  const late = new Date(NOW.getTime() + 11 * 60_000);
  expect(authorizeBridgeDeploy({ ref: seq, nonce: confirmation.nonce, sha: SHA }, late))
    .toEqual({ ok: false, reason: "expired" });

  /* Nothing above consumed the confirmation, so the real answer still works. */
  expect(authorizeBridgeDeploy({ ref: seq, nonce: confirmation.nonce, sha: SHA }, NOW))
    .toEqual({ ok: true, sha: SHA });
});

test("a report body is bounded and redacted on the production append path too", () => {
  sandbox();
  const secretShaped = ["sk", "0123456789abcdef"].join("-");
  recordManagerReport({
    key: "leaky",
    class: "failed",
    at: NOW.toISOString(),
    body: `deploy failed with token ${secretShaped}`,
  });
  const stored = drainBridgeReports().reports[0]!;
  expect(stored.body).toContain("[redacted]");
  expect(stored.body).not.toContain(secretShaped);
});

/* §4, the no-call path: with nothing live, the root's NEXT TURN drains the cursor. */

test("a turn opened after a quiet night carries one bounded batch, once", () => {
  sandbox();
  for (let index = 0; index < 9; index += 1) {
    recordManagerReport({ key: `r${index}`, class: "completed", at: NOW.toISOString(), body: `finished ${index}` });
  }

  const prelude = bridgeTurnStartPrelude({ rootIdentity, now: NOW });
  expect(prelude).not.toBeNull();
  expect(prelude!.text).toContain("finished 0");
  expect(prelude!.text).toContain("finished 4");
  /* Bounded: the sixth report is not in this turn. */
  expect(prelude!.text).not.toContain("finished 5");
  expect(prelude!.text).toContain("4 more waiting");
  expect(prelude!.throughSeq).toBe(5);

  /* The gateway is told to speak, not to recite. */
  expect(prelude!.text).toContain("Do not read this list aloud");
});

test("the turn-start drain does not consume anything by itself", () => {
  sandbox();
  recordManagerReport({ key: "a", class: "status", at: NOW.toISOString(), body: "one" });
  bridgeTurnStartPrelude({ rootIdentity, now: NOW });

  /* A turn that never reached the agent must not have eaten the report. */
  expect(readBridgeChannel()?.managerReportCursor).toBe(0);
  expect(bridgeTurnStartPrelude({ rootIdentity, now: NOW })).not.toBeNull();
});

test("an acknowledged turn-start batch never arrives a second time", () => {
  sandbox();
  recordManagerReport({ key: "a", class: "blocked", at: NOW.toISOString(), body: "needs a decision" });
  const prelude = bridgeTurnStartPrelude({ rootIdentity, now: NOW })!;
  acknowledgeBridgeDelivery(prelude.throughSeq);

  expect(bridgeTurnStartPrelude({ rootIdentity, now: NOW })).toBeNull();
});

test("a turn with an empty inbox opens with nothing at all", () => {
  sandbox();
  expect(bridgeTurnStartPrelude({ rootIdentity, now: NOW })).toBeNull();
});

/* ── HIGH 3 (#758 review): the delivery composer must READ origin ────────── */

test("a mixed batch never covers a non-manager row with the manager-voice header", () => {
  sandbox();
  recordManagerReport({
    key: "mgr-progress",
    class: "status",
    at: NOW.toISOString(),
    body: "merge queue is moving",
    origin: { kind: "manager", conversationId: "conversation_mgr", role: "orchestrator" },
  });
  recordManagerReport({
    key: "builder-note",
    class: "status",
    at: NOW.toISOString(),
    body: "builder wants attention",
    origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" },
  });

  const prelude = bridgeTurnStartPrelude({ rootIdentity, now: NOW });
  expect(prelude).not.toBeNull();
  const text = prelude!.text;

  /* The manager framing exists and covers the manager's own row… */
  const managerHeader = text.indexOf("the manager reported");
  expect(managerHeader).toBeGreaterThan(-1);
  expect(text.indexOf("merge queue is moving")).toBeGreaterThan(managerHeader);

  /* …and the agent row sits under its OWN explicit non-manager framing, after
     the manager section, never inside it. The origin field on the row — not
     the caller-owned body text — is what decides the framing. */
  const otherHeader = text.indexOf("NOT the manager");
  expect(otherHeader).toBeGreaterThan(managerHeader);
  expect(text.indexOf("builder wants attention")).toBeGreaterThan(otherHeader);
  expect(text).toContain("builder conversation_builder");
});

test("a batch of only non-manager rows carries no manager-voice header at all", () => {
  sandbox();
  recordManagerReport({
    key: "builder-only",
    class: "status",
    at: NOW.toISOString(),
    body: "just the builder",
    origin: { kind: "agent", conversationId: "conversation_builder", role: "builder" },
  });

  const prelude = bridgeTurnStartPrelude({ rootIdentity, now: NOW });
  expect(prelude!.text).not.toContain("the manager reported");
  expect(prelude!.text).toContain("NOT the manager");
});
