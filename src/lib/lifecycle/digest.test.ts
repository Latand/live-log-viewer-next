import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pollLifecycleDigest, readDigestSubscriber, ROUTINE_DIGEST_INTERVAL_MS, seedLifecycleDigestCursor } from "./digest";
import { appendLifecycleEvents, type LifecycleEventInput } from "./journal";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-digest-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const T0 = Date.parse("2026-07-26T09:00:00.000Z");
const SUBSCRIBER = "conversation_operator";

function routine(index: number, atMs: number, stageId = "build"): LifecycleEventInput {
  return {
    key: `pipeline:pipeline_a:stage:${stageId}:attempt:${index}:started`,
    type: "stage_started",
    at: new Date(atMs).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId,
    attempt: index,
    conversationId: "conversation_stage",
    summary: `${stageId} started (attempt ${index})`,
  };
}

test("several routine events inside five minutes coalesce into one digest", () => {
  sandbox();
  appendLifecycleEvents([routine(1, T0), routine(2, T0 + 60_000), routine(3, T0 + 120_000)]);

  /* Inside the window the batch is held — no relay, no cursor movement. */
  const held = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 150_000 });
  expect(held.relay).toBeNull();
  expect(held.pending).toBe(3);
  expect(held.cursor).toBe(0);
  expect(held.heldUntil).toBe(new Date(T0 + ROUTINE_DIGEST_INTERVAL_MS).toISOString());

  /* Past the window all three arrive as ONE digest, coalesced to one item. */
  const released = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 1_000 });
  expect(released.relay?.reason).toBe("batched");
  expect(released.relay?.items).toHaveLength(1);
  expect(released.relay?.items[0]).toMatchObject({
    type: "stage_started",
    pipelineId: "pipeline_a",
    stageId: "build",
    count: 3,
  });
  expect(released.cursor).toBe(3);

  /* A second poll with nothing new relays nothing. */
  const quiet = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 2_000 });
  expect(quiet.relay).toBeNull();
  expect(quiet.pending).toBe(0);
});

test("a terminal failure and a review verdict bypass the routine delay", () => {
  sandbox();
  appendLifecycleEvents([routine(1, T0), routine(2, T0 + 30_000)]);
  expect(pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 60_000 }).relay).toBeNull();

  appendLifecycleEvents([{
    key: "pipeline:pipeline_a:stage:build:attempt:2:failed",
    type: "stage_failed",
    at: new Date(T0 + 90_000).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "build",
    attempt: 2,
    conversationId: "conversation_stage",
    role: "builder",
    summary: "typecheck failed on 3 files",
  }]);

  /* Still well inside the five-minute window, yet it relays immediately and
     carries the held routine batch with it. */
  const terminal = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 95_000 });
  expect(terminal.relay?.reason).toBe("terminal");
  expect(terminal.relay?.items.map((item) => item.type)).toEqual(["stage_started", "stage_failed"]);
  expect(terminal.relay?.items.find((item) => item.type === "stage_failed")).toMatchObject({
    state: "failed",
    stageId: "build",
    summary: "typecheck failed on 3 files",
    count: 1,
  });
  expect(terminal.cursor).toBe(3);

  /* A review verdict inside the same window does not wait either. */
  appendLifecycleEvents([{
    key: "pipeline:pipeline_a:stage:review:attempt:1:verdict:fail",
    type: "review_verdict",
    at: new Date(T0 + 120_000).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    role: "reviewer",
    summary: "fail: the stall path is untested",
  }]);
  const verdict = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 125_000 });
  expect(verdict.relay?.reason).toBe("terminal");
  expect(verdict.relay?.items.map((item) => item.type)).toEqual(["review_verdict"]);
  expect(verdict.relay?.items[0]!.summary).toBe("fail: the stall path is untested");

  /* And a routine event right after the terminal relay is rate-limited again. */
  appendLifecycleEvents([routine(3, T0 + 130_000)]);
  const throttled = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 140_000 });
  expect(throttled.relay).toBeNull();
  /* The batch reopens at the first pending routine event, a full interval on. */
  expect(throttled.heldUntil).toBe(new Date(T0 + 130_000 + ROUTINE_DIGEST_INTERVAL_MS).toISOString());
});

test("the cursor survives a restart and a reconnect does not replay relayed events", () => {
  sandbox();
  appendLifecycleEvents([{
    key: "pipeline:pipeline_a:stage:review:attempt:1:passed",
    type: "stage_completed",
    at: new Date(T0).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    role: "reviewer",
    summary: "APPROVE",
  }]);
  const first = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 1_000 });
  expect(first.relay?.items).toHaveLength(1);
  expect(first.cursor).toBe(1);

  /* Simulated Viewer restart: the durable subscriber record is all that is left. */
  const persisted = readDigestSubscriber(SUBSCRIBER);
  expect(persisted?.cursorSeq).toBe(1);

  const reconnect = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 3_600_000 });
  expect(reconnect.relay).toBeNull();
  expect(reconnect.cursor).toBe(1);

  /* Only work that happened after the last relay reaches the agent. */
  appendLifecycleEvents([{
    key: "pipeline:pipeline_a:stage:deploy:attempt:1:passed",
    type: "stage_completed",
    at: new Date(T0 + 3_700_000).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "deploy",
    attempt: 1,
    summary: "deploy stage passed",
  }]);
  const afterReconnect = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 3_701_000 });
  expect(afterReconnect.relay?.items.map((item) => item.stageId)).toEqual(["deploy"]);
  expect(afterReconnect.cursor).toBe(2);
});

test("a seeded subscriber starts at the journal head and never relays history", () => {
  sandbox();
  appendLifecycleEvents([routine(1, T0), routine(2, T0 + 1_000)]);
  const seeded = seedLifecycleDigestCursor("conversation_late", T0 + 2_000);
  expect(seeded.cursorSeq).toBe(2);
  expect(pollLifecycleDigest({ subscriberId: "conversation_late", now: T0 + 3_600_000 }).relay).toBeNull();
});

test("acknowledge=false polls without moving the durable cursor", () => {
  sandbox();
  appendLifecycleEvents([{
    key: "pipeline:pipeline_a:stage:build:attempt:1:failed",
    type: "stage_failed",
    at: new Date(T0).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "build",
    summary: "build failed",
  }]);
  const dry = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 1_000, acknowledge: false });
  expect(dry.relay?.items).toHaveLength(1);
  expect(readDigestSubscriber(SUBSCRIBER)).toBeNull();
  expect(pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 2_000 }).relay?.items).toHaveLength(1);
});
