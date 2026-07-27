import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adoptOrchestratorRecord,
  readOrchestratorRecord,
  replaceOrchestratorIncumbent,
} from "@/lib/orchestrator/store";
import { planBridgeReportDelivery } from "@/lib/runtime/bridgeDelivery";
import { rememberAcknowledgedVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { bridgeDirectiveId } from "./directive";
import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  bridgeChannelPath,
  drainBridgeReports,
  openBridgeChannel,
  readBridgeChannel,
} from "./store";
import type { BridgeReportInput } from "./types";

/**
 * §7.3/§7.4 and AC17/AC23 — either endpoint may die without costing a message.
 *
 * These drive the real durable files through the real store, because the property
 * under test is precisely that the files survive the processes: a test with an
 * in-memory double would pass while the shipped thing lost history.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-recovery-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const ROOT_ID = "root_9c2e5a1b7f04";
const NOW = new Date("2026-07-27T12:00:00.000Z");

function report(key: string, overrides: Partial<BridgeReportInput> = {}): BridgeReportInput {
  return { key, class: "status", at: NOW.toISOString(), body: `report ${key}`, ...overrides };
}

test("replacing the manager leaves the channel and its cursor untouched (§7.3, AC23)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  adoptOrchestratorRecord({ conversationId: "conversation_manager_a", path: null, createdAt: NOW.toISOString() });
  appendBridgeReports([report("a"), report("b")]);
  acknowledgeBridgeReports(1);
  const before = readBridgeChannel();

  /* The operator swaps the manager's model wholesale: a different engine, a
     different conversation, the same seat. */
  replaceOrchestratorIncumbent({
    conversationId: "conversation_manager_b",
    path: null,
    createdAt: "2026-07-27T13:00:00.000Z",
    engine: "codex",
    model: "sol",
  });

  expect(readOrchestratorRecord()).toMatchObject({ conversationId: "conversation_manager_b", engine: "codex" });
  expect(readBridgeChannel()).toEqual(before!);
  /* AC22 again, now against a channel that has outlived one incumbent. */
  expect(fs.readFileSync(bridgeChannelPath(), "utf8")).not.toContain("conversation_manager");

  /* The successor continues the report stream at the next seq — it does not
     restart it, so the gateway's cursor still means what it meant. */
  const { appended } = appendBridgeReports([report("c", { class: "completed" })]);
  expect(appended[0]!.seq).toBe(3);
  expect(drainBridgeReports().reports.map((entry) => entry.seq)).toEqual([2, 3]);
});

test("a root rollover resumes at the cursor and re-speaks nothing (§7.4)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b"), report("c")]);

  /* First root session takes delivery of the first batch and acknowledges it. */
  const firstBatch = drainBridgeReports();
  const firstPlan = planBridgeReportDelivery({ batch: firstBatch, now: NOW, lastBatchAt: null });
  if (firstPlan.kind !== "deliver") throw new Error("expected a delivery");
  let tombstones = rememberAcknowledgedVoiceDelivery([], firstPlan.delivery.deliveryId);
  acknowledgeBridgeReports(firstPlan.throughSeq);

  /* That session dies. The successor is a different conversation under the same
     minted root identity, so it opens the same channel. */
  const successor = openBridgeChannel(ROOT_ID);
  expect(successor.managerReportCursor).toBe(3);

  appendBridgeReports([report("d", { class: "blocked" })]);
  const resumed = drainBridgeReports();
  expect(resumed.reports.map((entry) => entry.seq)).toEqual([4]);

  const resumedPlan = planBridgeReportDelivery({
    batch: resumed,
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  if (resumedPlan.kind !== "deliver") throw new Error("expected a delivery");
  expect(resumedPlan.delivery.responses.map((response) => response.text.includes("report d"))).toEqual([true]);

  /* And the batch the predecessor already delivered stays delivered. */
  tombstones = rememberAcknowledgedVoiceDelivery(tombstones, resumedPlan.delivery.deliveryId);
  acknowledgeBridgeReports(resumedPlan.throughSeq);
  expect(drainBridgeReports().reports).toEqual([]);
});

test("a batch lost between drain and delivery arrives again rather than vanishing", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b")]);

  /* Drained, planned, and then the call dropped before the ack. */
  const batch = drainBridgeReports();
  planBridgeReportDelivery({ batch, now: NOW, lastBatchAt: null });

  /* Nothing was acknowledged, so nothing was consumed. */
  expect(readBridgeChannel()?.managerReportCursor).toBe(0);
  expect(drainBridgeReports().reports.map((entry) => entry.seq)).toEqual([1, 2]);
});

test("a directive retried after a lost receipt carries the same id, never a fresh one (§7.1)", () => {
  /* The exactly-once property belongs to `send_message`'s durable receipt, which
     only recognizes a retry that presents the original clientRequestId. Deriving
     the id from the root turn is what makes that possible without any bridge
     state at all. */
  const first = bridgeDirectiveId("turn_0199", 0);
  const retry = bridgeDirectiveId("turn_0199", 0);
  expect(retry).toBe(first);
  expect(bridgeDirectiveId("turn_0199", 1)).not.toBe(first);
});

test("the manager appending the same report through two hosts yields one delivery (§7.5, AC16)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);

  /* Host A appends and dies before its receipt lands; host B retries. */
  appendBridgeReports([report("stage-42-completed", { class: "completed", body: "builder finished" })]);
  appendBridgeReports([report("stage-42-completed", { class: "completed", body: "builder finished" })]);

  const batch = drainBridgeReports();
  expect(batch.reports).toHaveLength(1);
  const plan = planBridgeReportDelivery({ batch, now: NOW, lastBatchAt: null });
  if (plan.kind !== "deliver") throw new Error("expected a delivery");
  expect(plan.delivery.responses).toHaveLength(1);
});

test("a channel opened for a different root identity does not inherit the old cursor", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a")]);
  acknowledgeBridgeReports(1);

  /* Not a rollover — a genuinely different minted root identity. Its position in
     the manager's stream was never established, so it starts from the top. */
  const other = openBridgeChannel("root_0000deadbeef");
  expect(other.managerReportCursor).toBe(0);
  expect(drainBridgeReports().reports.map((entry) => entry.seq)).toEqual([1]);
});

test("a lost cursor write cannot hide every later report behind a batch already spoken", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b")]);

  /* Delivered and acknowledged in the call; the durable cursor write is lost. */
  const first = planBridgeReportDelivery({ batch: drainBridgeReports(), now: NOW, lastBatchAt: null });
  if (first.kind !== "deliver") throw new Error("expected a delivery");
  const tombstones = rememberAcknowledgedVoiceDelivery([], first.delivery.deliveryId);
  expect(readBridgeChannel()?.managerReportCursor).toBe(0);

  /* The manager keeps working. Without cursor healing these never reach the user:
     the drain returns 1..3, the plan recognizes seqs 1-2 as already spoken, and
     report 3 waits behind them forever. */
  appendBridgeReports([report("c", { class: "blocked", body: "needs a decision" })]);

  const next = planBridgeReportDelivery({
    batch: drainBridgeReports(),
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });

  /* The blocker reaches the user, and reports 1-2 are NOT spoken a second time —
     the batch id changed when report 3 arrived, so only per-report suppression can
     tell the difference. */
  if (next.kind !== "deliver") throw new Error(`expected the blocker to be delivered, got ${next.kind}`);
  expect(next.delivery.responses).toHaveLength(1);
  expect(next.delivery.responses[0]!.text).toContain("needs a decision");
  expect(next.throughSeq).toBe(3);

  /* And acknowledging it heals the cursor past everything, including the reports
     whose own acknowledgement was lost. */
  acknowledgeBridgeReports(next.throughSeq);
  expect(readBridgeChannel()?.managerReportCursor).toBe(3);
  expect(drainBridgeReports().reports).toEqual([]);
});

test("a batch entirely below the ceiling reports the seq to heal to rather than silence", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b")]);

  const first = planBridgeReportDelivery({ batch: drainBridgeReports(), now: NOW, lastBatchAt: null });
  if (first.kind !== "deliver") throw new Error("expected a delivery");
  const tombstones = rememberAcknowledgedVoiceDelivery([], first.delivery.deliveryId);

  /* Cursor write lost, nothing new appended: the drain still offers 1-2. */
  const replay = planBridgeReportDelivery({
    batch: drainBridgeReports(),
    now: new Date(NOW.getTime() + 60_000),
    lastBatchAt: null,
    acknowledgedDeliveryIds: tombstones,
  });
  expect(replay).toEqual({ kind: "already-acknowledged", throughSeq: 2 });

  acknowledgeBridgeReports(2);
  expect(readBridgeChannel()?.managerReportCursor).toBe(2);
});
