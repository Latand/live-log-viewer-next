import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestScopeKey, pollLifecycleDigest, readDigestSubscriber, ROUTINE_DIGEST_INTERVAL_MS, seedLifecycleDigestCursor } from "./digest";
import { appendLifecycleEvents, LIFECYCLE_JOURNAL_CAPACITY, type LifecycleEventInput } from "./journal";

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

test("a payload that overflows its bound still relays the terminal event, and the cursor does not skip it", () => {
  sandbox();
  /* Six distinct routine shapes, then the one event the waiting agent cannot
     decide without. A bound of three cannot carry all seven. */
  appendLifecycleEvents([
    ...Array.from({ length: 6 }, (_, index) => routine(1, T0 + index * 1_000, `stage-${index}`)),
    {
      key: "pipeline:pipeline_a:stage:review:attempt:1:verdict:fail",
      type: "review_verdict",
      at: new Date(T0 + 7_000).toISOString(),
      project: "viewer",
      pipelineId: "pipeline_a",
      stageId: "review",
      attempt: 1,
      role: "reviewer",
      summary: "fail: the relay drops the event it exists to deliver",
    },
  ]);
  const verdictSeq = 7;

  const bounded = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 10_000, maxItems: 3 });
  expect(bounded.relay).not.toBeNull();
  expect(bounded.relay!.items).toHaveLength(3);
  expect(bounded.relay!.omitted).toBe(4);
  /* The terminal event is IN the bounded payload: trimming may drop routine
     progress, never the verdict. */
  expect(bounded.relay!.items.map((item) => item.type)).toContain("review_verdict");
  expect(bounded.relay!.reason).toBe("terminal");
  /* And the cursor stopped at the contiguous prefix it actually carried, well
     short of the verdict — so nothing between was skipped. */
  expect(bounded.cursor).toBeLessThan(verdictSeq);
  expect(readDigestSubscriber(SUBSCRIBER)!.cursorSeq).toBe(bounded.cursor);
  expect(bounded.pending).toBe(7 - bounded.cursor);

  /* Draining the rest reaches every routine event that did not fit, in order,
     and the cursor ends past the verdict having relayed it. */
  const seen: string[] = [...bounded.relay!.items.map((item) => item.stageId ?? "")];
  let cursor = bounded.cursor;
  for (let poll = 0; poll < 6 && cursor < verdictSeq; poll += 1) {
    const next = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 20_000 + poll * 1_000, maxItems: 3 });
    expect(next.relay).not.toBeNull();
    expect(next.cursor).toBeGreaterThan(cursor);
    cursor = next.cursor;
    seen.push(...next.relay!.items.map((item) => item.stageId ?? ""));
  }
  expect(cursor).toBe(verdictSeq);
  for (let index = 0; index < 6; index += 1) expect(seen).toContain(`stage-${index}`);
  expect(seen).toContain("review");
  expect(pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + 40_000 }).relay).toBeNull();
});

test("a terminal event older than the bounded window is still relayed, never trimmed away", () => {
  sandbox();
  /* The verdict arrives FIRST, then six routine shapes bury it. A payload that
     keeps only its newest items drops the verdict and advances the cursor past
     it in the same breath — relayed zero times, forever. */
  appendLifecycleEvents([{
    key: "pipeline:pipeline_b:stage:review:attempt:1:verdict:fail",
    type: "review_verdict",
    at: new Date(T0).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_b",
    stageId: "review",
    attempt: 1,
    role: "reviewer",
    summary: "fail: three findings block the merge",
  }]);
  appendLifecycleEvents(Array.from({ length: 6 }, (_, index) => routine(1, T0 + (index + 1) * 1_000, `late-${index}`)));

  const bounded = pollLifecycleDigest({ subscriberId: "conversation_buried", now: T0 + 10_000, maxItems: 3 });
  const relayed = bounded.relay!.items;
  expect(relayed.map((item) => item.type)).toContain("review_verdict");
  expect(relayed.find((item) => item.type === "review_verdict")!.summary).toBe("fail: three findings block the merge");
  /* The verdict is seq 1, so relaying it is exactly what lets the cursor move
     at all; everything it did not carry stays pending. */
  expect(bounded.cursor).toBeGreaterThanOrEqual(1);
  expect(bounded.cursor).toBeLessThan(7);
  expect(bounded.pending).toBe(7 - bounded.cursor);
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

test("two subscribers with the same id but different scope filters track independent cursors", () => {
  sandbox();
  appendLifecycleEvents([
    routine(1, T0, "deploy"),
    {
      key: "pipeline:pipeline_b:stage:review:attempt:1:started",
      type: "stage_started",
      at: new Date(T0 + 1_000).toISOString(),
      project: "other",
      pipelineId: "pipeline_b",
      stageId: "review",
      attempt: 1,
      conversationId: "conversation_other",
      summary: "review started",
    },
  ]);

  const scopeA = { subscriberId: SUBSCRIBER, project: "viewer", now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 1_000 };
  const scopeB = { subscriberId: SUBSCRIBER, project: "other", now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 1_000 };

  const relayA = pollLifecycleDigest(scopeA);
  const relayB = pollLifecycleDigest(scopeB);

  expect(relayA.relay?.items).toHaveLength(1);
  expect(relayA.relay?.items[0]?.stageId).toBe("deploy");
  expect(relayB.relay?.items).toHaveLength(1);
  expect(relayB.relay?.items[0]?.stageId).toBe("review");

  expect(pollLifecycleDigest(scopeA).relay).toBeNull();
  expect(pollLifecycleDigest(scopeB).relay).toBeNull();
});

test("a terminal event beyond the first page still triggers immediate relay", () => {
  sandbox();
  const events: LifecycleEventInput[] = [];
  for (let index = 0; index < 201; index += 1) {
    events.push(routine(index + 1, T0 + index * 100, `step-${index}`));
  }
  events.push({
    key: "pipeline:pipeline_a:stage:review:attempt:1:verdict:fail",
    type: "review_verdict",
    at: new Date(T0 + 201 * 100).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    role: "reviewer",
    summary: "fail: findings block the merge",
  });
  appendLifecycleEvents(events);

  const result = pollLifecycleDigest({ subscriberId: "sub_overflow", now: T0 + 1_000 });
  expect(result.relay).not.toBeNull();
  expect(result.pending).toBeGreaterThan(0);
});

/** `count` routine events, then one terminal verdict last — so the verdict sits
    at pending position `count + 1` however deep that is. */
function routinesThenVerdict(count: number): LifecycleEventInput[] {
  const events: LifecycleEventInput[] = [];
  for (let index = 0; index < count; index += 1) events.push(routine(index + 1, T0 + index * 100, `step-${index}`));
  events.push({
    key: "pipeline:pipeline_a:stage:review:attempt:1:verdict:fail",
    type: "review_verdict",
    at: new Date(T0 + count * 100).toISOString(),
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    role: "reviewer",
    summary: "fail: findings block the merge",
  });
  return events;
}

test.each([
  ["the first page boundary", 200],
  ["the second page boundary", 400],
  ["the journal's retention capacity", LIFECYCLE_JOURNAL_CAPACITY - 1],
])("a terminal event past %s still releases the relay immediately", (_where, routineCount) => {
  sandbox();
  appendLifecycleEvents(routinesThenVerdict(routineCount));

  /* Well inside the routine hold window: without the terminal event this poll
     would be held, so a relay here is only explainable by the verdict having
     been found. Paging the search stopped at 400 and put a blocking verdict
     behind a five-minute timer on exactly the busy projects that produce one. */
  const result = pollLifecycleDigest({ subscriberId: `sub_${routineCount}`, now: T0 + 1_000 });

  expect(result.heldUntil).toBeNull();
  expect(result.relay).not.toBeNull();
  /* Released immediately, yet still bounded: the payload is the head of the
     queue rather than the whole retained range. */
  expect(result.relay!.items.length).toBeLessThanOrEqual(10);
  expect(result.pending).toBeGreaterThan(0);
  /* And contiguous — the cursor never jumps over an event that was not carried. */
  expect(result.cursor).toBeLessThan(routineCount + 1);
  expect(result.relay!.through).toBe(result.cursor);
});

test("polling a deep terminal event walks the cursor forward until it arrives", () => {
  sandbox();
  appendLifecycleEvents(routinesThenVerdict(400));

  /* Each poll is inside the routine window, so every one of them is released
     only because the verdict is still pending somewhere ahead. */
  let cursor = 0;
  let delivered = false;
  for (let poll = 0; poll < 60 && !delivered; poll += 1) {
    const result = pollLifecycleDigest({ subscriberId: "sub_walk", now: T0 + 1_000 + poll });
    expect(result.relay).not.toBeNull();
    expect(result.cursor).toBeGreaterThan(cursor);
    cursor = result.cursor;
    delivered = result.relay!.items.some((item) => item.type === "review_verdict");
  }

  expect(delivered).toBeTrue();
});

test("a dry run reports the cursor the acknowledging poll actually holds", () => {
  sandbox();
  appendLifecycleEvents([routine(1, T0), routine(2, T0 + 1_000)]);

  const real = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 1_000 });
  expect(real.cursor).toBeGreaterThan(0);

  const dry = pollLifecycleDigest({ subscriberId: SUBSCRIBER, now: T0 + ROUTINE_DIGEST_INTERVAL_MS + 2_000, acknowledge: false });

  /* The diagnostic read has to resolve the same scope key the acknowledging
     write used. Scoping an already-scoped key looked under one nothing writes,
     so the dry run reported a fresh subscriber at 0 and offered to replay the
     entire history of a subscriber that is fully caught up. */
  expect(dry.cursor).toBe(real.cursor);
  expect(dry.relay).toBeNull();
  expect(dry.pending).toBe(0);
  /* Still a dry run: nothing moved. */
  expect(readDigestSubscriber(SUBSCRIBER)!.cursorSeq).toBe(real.cursor);
});

test("no two distinct subscriptions serialize to the same durable cursor key", () => {
  /* `subscriberId` is whatever the calling agent passed, so any separator the
     key joins on is a character it can supply. Each pair below joins to one
     identical string under a separator-joined key, which means two unrelated
     subscriptions sharing — and advancing — one durable cursor: whichever polls
     first marks the other caught up on events it never saw. Written as an
     escape, because a raw NUL byte would mark this whole file binary. */
  const NUL = "\u0000";
  const collidingPairs = [
    [{ subscriberId: `a${NUL}b`, project: "c" }, { subscriberId: "a", project: `b${NUL}c` }],
    [{ subscriberId: `a${NUL}b` }, { subscriberId: "a", project: `b${NUL}` }],
    [{ subscriberId: "sub", project: `p${NUL}q` }, { subscriberId: "sub", project: "p", pipelineId: `q${NUL}` }],
  ] as const;

  for (const [left, right] of collidingPairs) {
    expect(digestScopeKey(left)).not.toBe(digestScopeKey(right));
  }

  /* And ordinary scopes still each get their own stable key. */
  expect(digestScopeKey({ subscriberId: SUBSCRIBER })).not.toBe(digestScopeKey({ subscriberId: SUBSCRIBER, project: "viewer" }));
  expect(digestScopeKey({ subscriberId: SUBSCRIBER })).toBe(digestScopeKey({ subscriberId: SUBSCRIBER }));
});
