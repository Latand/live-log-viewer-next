import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  adoptOutbox,
  cancelOutbox,
  enqueueOutbox,
  markOutboxResponded,
  nextDispatch,
  outboxHistory,
  OUTBOX_DELIVERED_TTL_MS,
  OUTBOX_LIMIT,
  outboxStateForReceiptStatus,
  publishTranscriptEchoes,
  readOutbox,
  resetOutboxForTests,
  seedLaunchOutbox,
  transcriptEchoCount,
  updateOutbox,
  visibleOutbox,
  type OutboxEntry,
  type TranscriptEchoObservation,
} from "./outbox";

const dom = new Window();
Object.assign(globalThis, { window: dom, sessionStorage: dom.sessionStorage });

/** Build a transcript-echo count map (finding 2): each listed text counted once,
    or with an explicit [text, count] pair for identical-message occurrences. */
function echoes(...entries: (string | [string, number])[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const [text, count] = typeof entry === "string" ? [entry, 1] : entry;
    counts.set(text, (counts.get(text) ?? 0) + count);
  }
  return counts;
}

beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});

const submit = (cardId: string, id: string, text: string, images = 0) =>
  enqueueOutbox(cardId, { id, text, images, at: Date.now() });

test("a submitted draft becomes a queued entry immediately and survives a reload", () => {
  submit("conv", "k1", "first message");
  const queue = readOutbox("conv");
  expect(queue.map((entry) => [entry.id, entry.state])).toEqual([["k1", "queued"]]);

  /* A fresh module state (a page refresh) rehydrates the same queue. */
  resetOutboxForTests();
  expect(readOutbox("conv").map((entry) => entry.text)).toEqual(["first message"]);
});

test("the dispatcher is serial: one delivering entry at a time, oldest first", () => {
  submit("conv", "k1", "one");
  submit("conv", "k2", "two");
  submit("conv", "k3", "three");

  /* Nothing is on the wire yet → the oldest is next. */
  expect(nextDispatch(readOutbox("conv"))?.id).toBe("k1");

  updateOutbox("conv", "k1", { state: "delivering" });
  /* While one is delivering, the dispatcher yields nothing — no double-send. */
  expect(nextDispatch(readOutbox("conv"))).toBeNull();

  updateOutbox("conv", "k1", { state: "delivered", settledAt: Date.now() });
  expect(nextDispatch(readOutbox("conv"))?.id).toBe("k2");
});

test("cancel removes a queued or failed message but the model never removes a delivering one", () => {
  submit("conv", "k1", "cancel me");
  cancelOutbox("conv", "k1");
  expect(readOutbox("conv")).toHaveLength(0);
});

test("empty-composer history lists queued messages ahead of sent, newest first, de-duped", () => {
  const t0 = Date.now();
  enqueueOutbox("conv", { id: "s1", text: "old sent", images: 0, at: t0 });
  updateOutbox("conv", "s1", { state: "delivered", settledAt: t0 });
  enqueueOutbox("conv", { id: "s2", text: "newer sent", images: 0, at: t0 + 10 });
  updateOutbox("conv", "s2", { state: "delivered", settledAt: t0 + 10 });
  enqueueOutbox("conv", { id: "q1", text: "still queued", images: 0, at: t0 + 20 });
  enqueueOutbox("conv", { id: "q2", text: "still queued", images: 0, at: t0 + 30 }); // consecutive dup

  expect(outboxHistory(readOutbox("conv"))).toEqual(["still queued", "newer sent", "old sent"]);
});

test("a bubble retires only on ITS OWN transcript echo, not on an unrelated mtime bump (P1#4)", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "my message", images: 0, at, state: "delivered", settledAt: at };
  /* An unrelated earlier turn wrote to the transcript — the echo set carries
     someone else's text, NOT this bubble's. The bubble must stay. This is the
     exact premature-removal the mtime rule caused. */
  expect(visibleOutbox([entry], echoes("a reply from an earlier turn"), at + 3_000)).toHaveLength(1);
  /* This bubble's OWN text lands in the transcript → it retires. */
  expect(visibleOutbox([entry], echoes("my message"), at + 3_000)).toHaveLength(0);
  /* Trimming is applied so whitespace differences still match the echo. */
  expect(visibleOutbox([{ ...entry, text: "  my message  " }], echoes("my message"), at + 3_000)).toHaveLength(0);
});

test("a delivered bubble whose echo never arrives still retires at the hard TTL", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  expect(visibleOutbox([entry], echoes(), at + 3_000)).toHaveLength(1);
  expect(visibleOutbox([entry], echoes(), at + OUTBOX_DELIVERED_TTL_MS + 1)).toHaveLength(0);
});

test("queued / delivering / launch-owned bubbles stay until their echo lands, never by TTL", () => {
  const queued: OutboxEntry = { id: "k1", text: "waiting", images: 0, at: 1_000, state: "queued" };
  const delivering: OutboxEntry = { id: "k2", text: "in flight", images: 0, at: 1_000, state: "delivering" };
  const launch: OutboxEntry = { id: "k3", text: "the launch prompt", images: 0, at: 1_000, state: "delivering", launchOwned: true };
  const far = 1_000 + OUTBOX_DELIVERED_TTL_MS * 10;
  expect(visibleOutbox([queued, delivering, launch], echoes(), far)).toHaveLength(3);
  /* Each retires only on its own echo. */
  expect(visibleOutbox([queued, delivering, launch], echoes("the launch prompt"), far).map((e) => e.id)).toEqual(["k1", "k2"]);
});

test("assistant reply evidence settles and retires its delivering outbox bubble", () => {
  const submittedAt = 1_000_000;
  enqueueOutbox("conv", { id: "key-replied", text: "please inspect this", images: 0, at: submittedAt });
  updateOutbox("conv", "key-replied", { state: "delivering" });

  markOutboxResponded("conv", "key-replied", submittedAt + 2_000);

  const [responded] = readOutbox("conv");
  expect(responded).toMatchObject({
    id: "key-replied",
    state: "delivered",
    settledAt: submittedAt + 2_000,
    responseStartedAt: submittedAt + 2_000,
  });
  expect(visibleOutbox([responded!], echoes(), submittedAt + 2_001)).toEqual([]);
});

test("assistant reply evidence leaves an unrelated pending outbox bubble visible", () => {
  const submittedAt = 1_000_000;
  enqueueOutbox("conv", { id: "key-replied", text: "first turn", images: 0, at: submittedAt });
  updateOutbox("conv", "key-replied", { state: "delivering" });
  enqueueOutbox("conv", { id: "key-pending", text: "still waiting", images: 0, at: submittedAt + 1 });

  markOutboxResponded("conv", "key-replied", submittedAt + 2_000);

  expect(visibleOutbox(readOutbox("conv"), echoes(), submittedAt + 2_001).map((entry) => entry.id))
    .toEqual(["key-pending"]);
  expect(readOutbox("conv").find((entry) => entry.id === "key-pending")).toMatchObject({ state: "queued" });
});

test("finding 2: a pre-existing identical user message leaves a freshly queued bubble visible", () => {
  const at = 1_000_000;
  /* The operator earlier said "yes"; it is already an echo in the transcript.
     Now they queue a NEW "yes" — its baseline records that one pre-existing
     echo, so the new bubble (and its cancel affordance) must stay visible. */
  const fresh: OutboxEntry = { id: "k1", text: "yes", images: 0, at, state: "queued", echoBaseline: 1 };
  expect(visibleOutbox([fresh], echoes(["yes", 1]), at + 1_000)).toHaveLength(1);
  /* When the new message's OWN echo lands (a second occurrence), it retires. */
  expect(visibleOutbox([fresh], echoes(["yes", 2]), at + 1_000)).toHaveLength(0);
});

test("finding 2: each later echo retires exactly one matching queued entry, oldest first", () => {
  const at = 1_000_000;
  /* Two identical messages queued back-to-back, both watermarked at 0 echoes. */
  const first: OutboxEntry = { id: "k1", text: "go", images: 0, at, state: "delivering", echoBaseline: 0 };
  const second: OutboxEntry = { id: "k2", text: "go", images: 0, at: at + 1, state: "queued", echoBaseline: 0 };
  /* No echoes yet → both bubbles visible. */
  expect(visibleOutbox([first, second], echoes(), at + 1_000).map((e) => e.id)).toEqual(["k1", "k2"]);
  /* One echo lands → exactly the oldest retires, the newer stays. */
  expect(visibleOutbox([first, second], echoes(["go", 1]), at + 1_000).map((e) => e.id)).toEqual(["k2"]);
  /* A second echo lands → the second retires too. */
  expect(visibleOutbox([first, second], echoes(["go", 2]), at + 1_000)).toHaveLength(0);
});

test("finding 2: a reloaded entry with no watermark still retires once its text is present", () => {
  const at = 1_000_000;
  /* Legacy/reloaded entry — no echoBaseline field — preserves the prior reload
     retirement: the moment its text is in the transcript it is gone. */
  const legacy: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  expect(visibleOutbox([legacy], echoes("done"), at + 1_000)).toHaveLength(0);
});

test("finding 2: the composer watermark reads the feed-published echo count", () => {
  /* The feed publishes the transcript's user-echo counts; the composer stamps a
     new submission's baseline from them, so occurrence consumption is causal. */
  publishTranscriptEchoes("conv-wm", echoes(["ping", 2], "other"));
  expect(transcriptEchoCount("conv-wm", "ping")).toBe(2);
  expect(transcriptEchoCount("conv-wm", "  ping  ")).toBe(2); // trimmed key
  expect(transcriptEchoCount("conv-wm", "other")).toBe(1);
  expect(transcriptEchoCount("conv-wm", "absent")).toBe(0);
  expect(transcriptEchoCount("unknown-conv", "ping")).toBe(0);
});

test("issue 626: canonical echo retirement survives eviction, filters, identity adoption, refresh, and repeated text", () => {
  const launch = "spawn:launch_626";
  const conversation = "conversation_626";
  const repeated = "repeat this prompt";

  /* One historical occurrence is visible before the next identical submission.
     Its stable feed anchor becomes the new entry's occurrence baseline. */
  publishTranscriptEchoes(launch, [{ id: "row:4:0", text: repeated }]);
  enqueueOutbox(launch, {
    id: "repeat-1",
    text: repeated,
    images: 0,
    at: 1_000,
    echoBaseline: transcriptEchoCount(launch, repeated),
  });
  enqueueOutbox(launch, {
    id: "unrelated",
    text: "keep me queued",
    images: 0,
    at: 1_001,
    echoBaseline: transcriptEchoCount(launch, "keep me queued"),
  });

  /* Re-publishing the historical row after a filter toggle cannot retire the
     fresh occurrence. Its later canonical echo retires only that entry. */
  publishTranscriptEchoes(launch, [{ id: "row:4:0", text: repeated }]);
  expect(visibleOutbox(readOutbox(launch), echoes([repeated, 1]), 2_000).map((entry) => entry.id))
    .toEqual(["repeat-1", "unrelated"]);
  publishTranscriptEchoes(launch, [
    { id: "row:4:0", text: repeated },
    { id: "row:40:0", text: repeated },
  ]);
  expect(readOutbox(launch).find((entry) => entry.id === "repeat-1")).toMatchObject({
    retiredEchoId: "row:40:0",
  });

  /* The first echo leaves the capped tail, the filter temporarily hides every
     user row, and the launch adopts its canonical identity. Retirement remains
     monotonic while the unrelated queued entry stays visible. */
  publishTranscriptEchoes(launch, []);
  adoptOutbox(launch, conversation);
  resetOutboxForTests();
  expect(visibleOutbox(readOutbox(conversation), echoes(), 3_000).map((entry) => entry.id))
    .toEqual(["unrelated"]);
  expect(transcriptEchoCount(conversation, repeated)).toBe(2);
});

test("issue 626: successor transcript paths disambiguate identical row anchors across adoption and refresh", () => {
  type GenerationEcho = TranscriptEchoObservation & { generation: string };
  const echo = (generation: string, text: string): GenerationEcho => ({
    generation,
    id: "row:0:0",
    text,
  });
  const provisional = "spawn:launch_626_generation";
  const conversation = "conversation_626_generation";
  const firstPath = "/transcripts/626-generation-1.jsonl";
  const secondPath = "/transcripts/626-generation-2.jsonl";
  const repeated = "same row anchor in two transcript generations";

  publishTranscriptEchoes(provisional, [echo(firstPath, repeated)]);
  enqueueOutbox(provisional, {
    id: "second-generation-submission",
    text: repeated,
    images: 0,
    at: 1_000,
  });

  adoptOutbox(provisional, conversation);
  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  publishTranscriptEchoes(conversation, [echo(secondPath, repeated)]);

  const repaired = readOutbox(conversation).find((entry) => entry.id === "second-generation-submission");
  expect(repaired?.retiredEchoId).toBeDefined();
  expect(repaired?.retiredEchoId).not.toBe("row:0:0");
  expect(transcriptEchoCount(conversation, repeated)).toBe(2);

  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  expect(visibleOutbox(readOutbox(conversation), echoes(), 2_000)).toEqual([]);
});

test("issue 626: a refresh that observes the launch echo before seeding persists retirement", () => {
  const conversation = "conversation_626_refresh";
  const text = "canonical launch prompt";
  publishTranscriptEchoes(conversation, [{ id: "row:12:0", text }]);
  seedLaunchOutbox(conversation, {
    id: "launch_626_refresh",
    text,
    images: 0,
    at: 1_000,
  });
  expect(readOutbox(conversation)[0]).toMatchObject({ retiredEchoId: "row:12:0" });

  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  expect(visibleOutbox(readOutbox(conversation), echoes(), 2_000)).toEqual([]);
});

test("issue 626: adopting an echo ledger immediately retires a queue already on the canonical identity", () => {
  const provisional = "spawn:launch_626_split";
  const conversation = "conversation_626_split";
  const text = "queue and transcript began on different identities";

  enqueueOutbox(conversation, {
    id: "split-identity-entry",
    text,
    images: 0,
    at: 1_000,
  });
  publishTranscriptEchoes(provisional, [{ id: "row:18:0", text }]);

  adoptOutbox(provisional, conversation);

  expect(readOutbox(conversation)[0]).toMatchObject({
    retiredEchoId: "row:18:0",
  });
  expect(visibleOutbox(readOutbox(conversation), echoes(), 2_000)).toEqual([]);
});

test("issue 626: response evidence still reserves the first later identical user echo", () => {
  const conversation = "conversation_626_response_occurrence";
  const text = "repeat while the first response starts";

  enqueueOutbox(conversation, {
    id: "response-first",
    text,
    images: 0,
    at: 1_000,
  });
  enqueueOutbox(conversation, {
    id: "response-second",
    text,
    images: 0,
    at: 1_001,
  });
  markOutboxResponded(conversation, "response-first", 1_100);

  publishTranscriptEchoes(conversation, [{ id: "row:20:0", text }]);
  expect(readOutbox(conversation).find((entry) => entry.id === "response-first"))
    .toMatchObject({ retiredEchoId: "row:20:0" });
  expect(readOutbox(conversation).find((entry) => entry.id === "response-second")?.retiredEchoId)
    .toBeUndefined();
  expect(visibleOutbox(readOutbox(conversation), echoes([text, 1]), 1_200).map((entry) => entry.id))
    .toEqual(["response-second"]);

  publishTranscriptEchoes(conversation, [
    { id: "row:20:0", text },
    { id: "row:30:0", text },
  ]);
  expect(readOutbox(conversation).find((entry) => entry.id === "response-second"))
    .toMatchObject({ retiredEchoId: "row:30:0" });
});

test("issue 626: compacted response ownership reserves its delayed echo above the outbox limit across refresh", () => {
  const provisional = "spawn:launch_626_occurrence_tombstone";
  const conversation = "conversation_626_occurrence_tombstone";
  const generation = "/transcripts/626-occurrence-tombstone.jsonl";
  const repeated = "same text before delayed transcript publication";

  enqueueOutbox(provisional, {
    id: "older-response-settled",
    text: repeated,
    images: 0,
    at: 1_000,
  });
  markOutboxResponded(provisional, "older-response-settled", 1_100);
  enqueueOutbox(provisional, {
    id: "newer-still-pending",
    text: repeated,
    images: 0,
    at: 1_200,
  });
  for (let index = 0; index < OUTBOX_LIMIT - 1; index += 1) {
    enqueueOutbox(provisional, {
      id: `filler-${index}`,
      text: `filler ${index}`,
      images: 0,
      at: 2_000 + index,
    });
  }

  expect(readOutbox(provisional)).toHaveLength(OUTBOX_LIMIT);
  expect(readOutbox(provisional).some((entry) => entry.id === "older-response-settled")).toBe(false);
  adoptOutbox(provisional, conversation);
  resetOutboxForTests();

  const olderEcho = { generation, id: "row:10:0", text: repeated };
  publishTranscriptEchoes(conversation, [olderEcho]);
  let queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-still-pending")?.retiredEchoId).toBeUndefined();
  expect(visibleOutbox(queue, echoes([repeated, 1]), 3_000).some((entry) => entry.id === "newer-still-pending"))
    .toBe(true);

  resetOutboxForTests();
  publishTranscriptEchoes(conversation, [olderEcho]);
  queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-still-pending")?.retiredEchoId).toBeUndefined();

  publishTranscriptEchoes(conversation, [
    olderEcho,
    { generation, id: "row:20:0", text: repeated },
  ]);
  expect(readOutbox(conversation).find((entry) => entry.id === "newer-still-pending")?.retiredEchoId)
    .toBeDefined();
});

test("issue 626: compacted receipt delivery owns its delayed repeated-text echo across lifecycle churn", () => {
  const provisional = "spawn:launch_626_delivered_tombstone";
  const conversation = "conversation_626_delivered_tombstone";
  const generation = "/transcripts/626-delivered-tombstone.jsonl";
  const repeated = "same delivered text before delayed transcript publication";

  enqueueOutbox(provisional, {
    id: "older-receipt-delivered",
    text: repeated,
    images: 0,
    at: 1_000,
  });
  updateOutbox(provisional, "older-receipt-delivered", {
    state: outboxStateForReceiptStatus("delivered"),
    settledAt: 1_100,
  });
  const older = readOutbox(provisional).find((entry) => entry.id === "older-receipt-delivered");
  expect(older?.state).toBe("delivered");
  expect(older?.responseStartedAt).toBeUndefined();
  expect(older?.retiredEchoId).toBeUndefined();
  enqueueOutbox(provisional, {
    id: "newer-still-pending",
    text: repeated,
    images: 0,
    at: 1_200,
  });
  for (let index = 0; index < OUTBOX_LIMIT - 1; index += 1) {
    enqueueOutbox(provisional, {
      id: `delivered-filler-${index}`,
      text: `delivered filler ${index}`,
      images: 0,
      at: 2_000 + index,
    });
  }

  expect(readOutbox(provisional)).toHaveLength(OUTBOX_LIMIT);
  expect(readOutbox(provisional).some((entry) => entry.id === "older-receipt-delivered")).toBe(false);
  adoptOutbox(provisional, conversation);
  resetOutboxForTests();

  /* Empty publications model filters and capped-tail eviction. They cannot
     release the compacted occurrence reservation before its echo arrives. */
  publishTranscriptEchoes(conversation, []);
  const olderEcho = { generation, id: "row:10:0", text: repeated };
  publishTranscriptEchoes(conversation, [olderEcho]);
  let queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-still-pending")?.retiredEchoId).toBeUndefined();
  expect(visibleOutbox(queue, echoes([repeated, 1]), 3_000).some((entry) => entry.id === "newer-still-pending"))
    .toBe(true);

  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  publishTranscriptEchoes(conversation, [olderEcho]);
  queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-still-pending")?.retiredEchoId).toBeUndefined();

  publishTranscriptEchoes(conversation, [
    olderEcho,
    { generation, id: "row:20:0", text: repeated },
  ]);
  expect(readOutbox(conversation).find((entry) => entry.id === "newer-still-pending")?.retiredEchoId)
    .toBeDefined();
});

test("issue 626: unresolved delivery ownership survives completed history beyond 512 entries", () => {
  const provisional = "spawn:launch_626_priority_retention";
  const conversation = "conversation_626_priority_retention";
  const firstGeneration = "/transcripts/626-priority-retention-1.jsonl";
  const secondGeneration = "/transcripts/626-priority-retention-2.jsonl";
  const repeated = "same delayed text beyond the completed-history bound";

  enqueueOutbox(provisional, {
    id: "older-unresolved-delivery",
    text: repeated,
    images: 0,
    at: 1_000,
  });
  updateOutbox(provisional, "older-unresolved-delivery", {
    state: outboxStateForReceiptStatus("delivered"),
    settledAt: 1_100,
  });

  const completedChurn = 512 + OUTBOX_LIMIT + 1;
  for (let index = 0; index < completedChurn; index += 1) {
    const id = `completed-churn-${index}`;
    const text = `completed churn ${index}`;
    enqueueOutbox(provisional, {
      id,
      text,
      images: 0,
      at: 2_000 + index,
    });
    updateOutbox(provisional, id, {
      state: outboxStateForReceiptStatus("delivered"),
      settledAt: 2_000 + index,
    });
    publishTranscriptEchoes(provisional, [{
      generation: index < 256 ? firstGeneration : secondGeneration,
      id: `row:${index}:0`,
      text,
    }]);
  }

  adoptOutbox(provisional, conversation);
  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();

  enqueueOutbox(conversation, {
    id: "newer-identical-pending",
    text: repeated,
    images: 0,
    at: 10_000,
  });
  enqueueOutbox(conversation, {
    id: "unrelated-pending",
    text: "keep this unrelated pending entry",
    images: 0,
    at: 10_001,
  });
  resetOutboxForTests();

  const delayedEcho = {
    generation: secondGeneration,
    id: "row:9000:0",
    text: repeated,
  };
  publishTranscriptEchoes(conversation, [delayedEcho]);

  let queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-identical-pending")?.retiredEchoId)
    .toBeUndefined();
  expect(queue.find((entry) => entry.id === "unrelated-pending")?.state).toBe("queued");
  expect(queue.find((entry) => entry.id === "unrelated-pending")?.retiredEchoId)
    .toBeUndefined();
  expect(visibleOutbox(queue, echoes([repeated, 1]), 11_000).map((entry) => entry.id))
    .toEqual(["newer-identical-pending", "unrelated-pending"]);

  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  publishTranscriptEchoes(conversation, [delayedEcho]);
  queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "newer-identical-pending")?.retiredEchoId)
    .toBeUndefined();
  expect(queue.find((entry) => entry.id === "unrelated-pending")?.retiredEchoId)
    .toBeUndefined();
});

test("issue 626: the unresolved-owner cap deterministically preserves the oldest 512 occurrences", () => {
  const conversation = "conversation_626_active_tier_cap";
  const generation = "/transcripts/626-active-tier-cap.jsonl";
  const activeOwnerCount = 513;

  for (let index = 0; index < activeOwnerCount; index += 1) {
    const id = `active-owner-${index}`;
    enqueueOutbox(conversation, {
      id,
      text: `active owner text ${index}`,
      images: 0,
      at: 1_000 + index,
    });
    updateOutbox(conversation, id, {
      state: outboxStateForReceiptStatus("delivered"),
      settledAt: 2_000 + index,
    });
  }
  for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
    enqueueOutbox(conversation, {
      id: `active-cap-filler-${index}`,
      text: `active cap filler ${index}`,
      images: 0,
      at: 10_000 + index,
    });
  }

  enqueueOutbox(conversation, {
    id: "pending-oldest-active-text",
    text: "active owner text 0",
    images: 0,
    at: 20_000,
  });
  enqueueOutbox(conversation, {
    id: "pending-newest-active-text",
    text: "active owner text 512",
    images: 0,
    at: 20_001,
  });
  resetOutboxForTests();

  publishTranscriptEchoes(conversation, [
    { generation, id: "row:oldest:0", text: "active owner text 0" },
    { generation, id: "row:newest:0", text: "active owner text 512" },
  ]);

  const queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "pending-oldest-active-text")?.retiredEchoId)
    .toBeUndefined();
  expect(queue.find((entry) => entry.id === "pending-newest-active-text")?.retiredEchoId)
    .toBeDefined();
});

test("issue 626: the completed-owner cap deterministically preserves the newest 512 occurrences", () => {
  const conversation = "conversation_626_completed_tier_cap";
  const generation = "/transcripts/626-completed-tier-cap.jsonl";
  const completedOwnerCount = 513;

  for (let index = 0; index < completedOwnerCount; index += 1) {
    const id = `completed-owner-${index}`;
    const text = `completed owner text ${index}`;
    enqueueOutbox(conversation, {
      id,
      text,
      images: 0,
      at: 1_000 + index,
    });
    updateOutbox(conversation, id, {
      state: outboxStateForReceiptStatus("delivered"),
      settledAt: 2_000 + index,
    });
    publishTranscriptEchoes(conversation, [{
      generation,
      id: `row:completed:${index}`,
      text,
    }]);
  }
  for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
    enqueueOutbox(conversation, {
      id: `completed-cap-filler-${index}`,
      text: `completed cap filler ${index}`,
      images: 0,
      at: 10_000 + index,
    });
  }

  publishTranscriptEchoes(conversation, Array.from({ length: 513 }, (_, index) => ({
    generation: "/transcripts/626-completed-ledger-churn.jsonl",
    id: `row:ledger-churn:${index}`,
    text: `ledger churn text ${index}`,
  })));
  enqueueOutbox(conversation, {
    id: "pending-oldest-completed-text",
    text: "completed owner text 0",
    images: 0,
    at: 20_000,
  });
  enqueueOutbox(conversation, {
    id: "pending-newest-completed-text",
    text: "completed owner text 512",
    images: 0,
    at: 20_001,
  });
  resetOutboxForTests();

  publishTranscriptEchoes(conversation, [
    { generation, id: "row:completed:0", text: "completed owner text 0" },
    { generation, id: "row:completed:512", text: "completed owner text 512" },
  ]);

  const queue = readOutbox(conversation);
  expect(queue.find((entry) => entry.id === "pending-oldest-completed-text")?.retiredEchoId)
    .toBeDefined();
  expect(queue.find((entry) => entry.id === "pending-newest-completed-text")?.retiredEchoId)
    .toBeUndefined();
});

test("issue 626: an active claim advances pending ownership when the completed tier is full", () => {
  const originalDateNow = Date.now;
  Date.now = () => 50_000;
  try {
    const conversation = "conversation_626_full_completed_transition";
    const generation = "/transcripts/626-full-completed-transition.jsonl";
    const repeated = "same text while the completed tier is full";

    enqueueOutbox(conversation, {
      id: "active-owner-before-full-completed-tier",
      text: repeated,
      images: 0,
      at: 1_000,
    });
    updateOutbox(conversation, "active-owner-before-full-completed-tier", {
      state: outboxStateForReceiptStatus("delivered"),
      settledAt: 1_001,
    });
    for (let index = 0; index < 512 + OUTBOX_LIMIT; index += 1) {
      const id = `full-completed-owner-${index}`;
      const text = `full completed owner text ${index}`;
      enqueueOutbox(conversation, {
        id,
        text,
        images: 0,
        at: 2_000 + index,
      });
      updateOutbox(conversation, id, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: 2_000 + index,
      });
      publishTranscriptEchoes(conversation, [{
        generation,
        id: `row:full-completed:${index}`,
        text,
      }]);
    }
    enqueueOutbox(conversation, {
      id: "pending-after-full-completed-tier",
      text: repeated,
      images: 0,
      at: 10_000,
    });

    const delayedEcho = {
      generation,
      id: "row:delayed-active-owner:0",
      text: repeated,
    };
    publishTranscriptEchoes(conversation, [delayedEcho]);
    expect(readOutbox(conversation).find(
      (entry) => entry.id === "pending-after-full-completed-tier",
    )?.retiredEchoId).toBeUndefined();

    resetOutboxForTests();
    publishTranscriptEchoes(conversation, [delayedEcho]);
    const refreshed = readOutbox(conversation).find(
      (entry) => entry.id === "pending-after-full-completed-tier",
    );
    expect(refreshed?.retiredEchoId).toBeUndefined();
    expect(refreshed?.echoBaselineIds).toContain(
      JSON.stringify([generation, delayedEcho.id]),
    );
  } finally {
    Date.now = originalDateNow;
  }
});

test("issue 626: identity adoption preserves submission order for identical occurrences", () => {
  const provisional = "spawn:launch_626_order";
  const conversation = "conversation_626_order";
  const text = "same text across identity adoption";

  enqueueOutbox(provisional, {
    id: "older-provisional",
    text,
    images: 0,
    at: 1_000,
  });
  enqueueOutbox(conversation, {
    id: "newer-canonical",
    text,
    images: 0,
    at: 2_000,
  });

  adoptOutbox(provisional, conversation);
  expect(readOutbox(conversation).map((entry) => entry.id))
    .toEqual(["older-provisional", "newer-canonical"]);

  publishTranscriptEchoes(conversation, [{ id: "row:40:0", text }]);
  expect(readOutbox(conversation).find((entry) => entry.id === "older-provisional"))
    .toMatchObject({ retiredEchoId: "row:40:0" });
  expect(readOutbox(conversation).find((entry) => entry.id === "newer-canonical")?.retiredEchoId)
    .toBeUndefined();
});

describe("outboxStateForReceiptStatus (P1#4)", () => {
  test("admitted-but-not-delivered stays delivering; only a delivered receipt reads delivered", () => {
    expect(outboxStateForReceiptStatus("queued")).toBe("delivering");
    expect(outboxStateForReceiptStatus("delivering")).toBe("delivering");
    expect(outboxStateForReceiptStatus("delivered")).toBe("delivered");
    expect(outboxStateForReceiptStatus("applied")).toBe("delivered");
    expect(outboxStateForReceiptStatus("rejected")).toBe("failed");
    expect(outboxStateForReceiptStatus("failed")).toBe("failed");
  });
});

describe("seedLaunchOutbox (P1#2)", () => {
  test("seeds the initial launch prompt as a launch-owned delivering bubble, idempotently", () => {
    seedLaunchOutbox("conversation_live", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    const queue = readOutbox("conversation_live");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: "launch_1", text: "the launch prompt", state: "delivering", launchOwned: true });
    /* A re-seed (re-render / reload replay) is a no-op — the state is preserved. */
    updateOutbox("conversation_live", "launch_1", { state: "delivered" });
    seedLaunchOutbox("conversation_live", { id: "launch_1", text: "the launch prompt", images: 0, at: 2_000 });
    expect(readOutbox("conversation_live")[0]!.state).toBe("delivered");
  });

  test("a launch-owned bubble never dispatches and never blocks the operator's follow-up messages", () => {
    seedLaunchOutbox("conv", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    // The dispatcher ignores the launch-owned entry entirely.
    expect(nextDispatch(readOutbox("conv"))).toBeNull();
    // A follow-up the operator queues dispatches immediately, despite the
    // launch-owned bubble still being "delivering".
    submit("conv", "k2", "follow-up message");
    expect(nextDispatch(readOutbox("conv"))?.id).toBe("k2");
  });

  test("a launch-owned bubble survives a refresh unchanged (never re-queued or re-dispatched)", () => {
    seedLaunchOutbox("conv", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    resetOutboxForTests();
    const restored = readOutbox("conv");
    expect(restored[0]).toMatchObject({ state: "delivering", launchOwned: true });
    expect(nextDispatch(restored)).toBeNull();
  });

  test("issue 626: a compacted terminal launch cannot be reseeded after adoption and refresh", () => {
    const provisional = "spawn:launch_626_terminal";
    const conversation = "conversation_626_terminal";
    const text = "terminal launch prompt";
    const echo = {
      generation: "/transcripts/626-terminal-launch.jsonl",
      id: "row:0:0",
      text,
    };

    seedLaunchOutbox(provisional, {
      id: "launch_626_terminal",
      text,
      images: 0,
      at: 1_000,
    });
    publishTranscriptEchoes(provisional, [echo]);
    expect(readOutbox(provisional)[0]?.id).toBe("launch_626_terminal");
    expect(typeof readOutbox(provisional)[0]?.retiredEchoId).toBe("string");

    for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
      enqueueOutbox(provisional, {
        id: `terminal-launch-filler-${index}`,
        text: `terminal launch filler ${index}`,
        images: 0,
        at: 2_000 + index,
      });
    }
    expect(readOutbox(provisional).some((entry) => entry.id === "launch_626_terminal")).toBe(false);

    adoptOutbox(provisional, conversation);
    resetOutboxForTests();
    publishTranscriptEchoes(conversation, []);
    seedLaunchOutbox(conversation, {
      id: "launch_626_terminal",
      text,
      images: 0,
      at: 1_000,
    });

    const refreshed = readOutbox(conversation);
    expect(refreshed).toHaveLength(OUTBOX_LIMIT);
    expect(refreshed.some((entry) => entry.id === "launch_626_terminal")).toBe(false);
    expect(refreshed[0]?.id).toBe("terminal-launch-filler-0");
  });

  test("issue 626: response-started launch retirement survives ledger rollover, adoption, and recurring seeds", () => {
    const provisional = "spawn:launch_626_response_terminal";
    const conversation = "conversation_626_response_terminal";
    const launchId = "launch_626_response_terminal";
    const text = "response-started launch without a transcript echo";

    seedLaunchOutbox(provisional, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });
    markOutboxResponded(provisional, launchId, 1_100);
    expect(visibleOutbox(readOutbox(provisional), echoes(), 1_101)).toEqual([]);

    for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
      enqueueOutbox(provisional, {
        id: `response-terminal-warm-${index}`,
        text: `response terminal warm ${index}`,
        images: 0,
        at: 2_000 + index,
      });
    }
    expect(readOutbox(provisional).some((entry) => entry.id === launchId)).toBe(false);

    adoptOutbox(provisional, conversation);
    for (let index = 0; index < 512 + OUTBOX_LIMIT + 1; index += 1) {
      const id = `response-terminal-churn-${index}`;
      const churnText = `response terminal churn ${index}`;
      enqueueOutbox(conversation, {
        id,
        text: churnText,
        images: 0,
        at: 3_000 + index,
      });
      updateOutbox(conversation, id, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: 3_000 + index,
      });
      publishTranscriptEchoes(conversation, [{
        generation: index < 256
          ? "/transcripts/626-response-terminal-1.jsonl"
          : "/transcripts/626-response-terminal-2.jsonl",
        id: `row:response-terminal:${index}`,
        text: churnText,
      }]);
    }
    enqueueOutbox(conversation, {
      id: "response-terminal-unrelated-pending",
      text: "unrelated pending survives response terminal churn",
      images: 0,
      at: 10_000,
    });

    resetOutboxForTests();
    seedLaunchOutbox(conversation, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });
    resetOutboxForTests();
    seedLaunchOutbox(conversation, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });

    const refreshed = readOutbox(conversation);
    expect(refreshed.some((entry) => entry.id === launchId)).toBe(false);
    expect(refreshed.find((entry) => entry.id === "response-terminal-unrelated-pending")?.state)
      .toBe("queued");
    expect(visibleOutbox(refreshed, echoes(), 11_000).some((entry) => entry.id === launchId))
      .toBe(false);
  });

  test("issue 626: delivered-TTL launch retirement survives ledger rollover, adoption, and recurring seeds", () => {
    const originalDateNow = Date.now;
    const settledAt = 1_100;
    Date.now = () => settledAt + OUTBOX_DELIVERED_TTL_MS;
    try {
      const provisional = "spawn:launch_626_ttl_terminal";
      const conversation = "conversation_626_ttl_terminal";
      const launchId = "launch_626_ttl_terminal";
      const text = "delivered launch whose transcript echo never arrives";

      seedLaunchOutbox(provisional, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      updateOutbox(provisional, launchId, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt,
      });
      expect(visibleOutbox(readOutbox(provisional), echoes(), Date.now())).toEqual([]);

      for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
        enqueueOutbox(provisional, {
          id: `ttl-terminal-warm-${index}`,
          text: `ttl terminal warm ${index}`,
          images: 0,
          at: 2_000 + index,
        });
      }
      expect(readOutbox(provisional).some((entry) => entry.id === launchId)).toBe(false);

      adoptOutbox(provisional, conversation);
      for (let index = 0; index < 512 + OUTBOX_LIMIT + 1; index += 1) {
        const id = `ttl-terminal-churn-${index}`;
        const churnText = `ttl terminal churn ${index}`;
        enqueueOutbox(conversation, {
          id,
          text: churnText,
          images: 0,
          at: 3_000 + index,
        });
        updateOutbox(conversation, id, {
          state: outboxStateForReceiptStatus("delivered"),
          settledAt: 3_000 + index,
        });
        publishTranscriptEchoes(conversation, [{
          generation: index < 256
            ? "/transcripts/626-ttl-terminal-1.jsonl"
            : "/transcripts/626-ttl-terminal-2.jsonl",
          id: `row:ttl-terminal:${index}`,
          text: churnText,
        }]);
      }
      enqueueOutbox(conversation, {
        id: "ttl-terminal-unrelated-pending",
        text: "unrelated pending survives TTL terminal churn",
        images: 0,
        at: 10_000,
      });

      resetOutboxForTests();
      seedLaunchOutbox(conversation, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      resetOutboxForTests();
      seedLaunchOutbox(conversation, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });

      const refreshed = readOutbox(conversation);
      expect(refreshed.some((entry) => entry.id === launchId)).toBe(false);
      expect(refreshed.find((entry) => entry.id === "ttl-terminal-unrelated-pending")?.state)
        .toBe("queued");
      expect(visibleOutbox(refreshed, echoes(), Date.now()).some((entry) => entry.id === launchId))
        .toBe(false);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("issue 626: a delivered launch compacted inside the TTL reseeds as delivered and still retires at the TTL", () => {
    const originalDateNow = Date.now;
    const settledAt = 1_100;
    /* Inside the TTL window: the launch settled recently and its echo has not
       arrived yet. */
    let now = settledAt + 60_000;
    Date.now = () => now;
    try {
      const provisional = "spawn:launch_626_ttl_reseed";
      const conversation = "conversation_626_ttl_reseed";
      const launchId = "launch_626_ttl_reseed";
      const text = "delivered launch compacted before its TTL elapses";

      seedLaunchOutbox(provisional, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      updateOutbox(provisional, launchId, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt,
      });
      expect(visibleOutbox(readOutbox(provisional), echoes(), now).map((entry) => entry.id))
        .toEqual([launchId]);

      /* Compaction evicts the delivered entry from the recent queue BEFORE the
         TTL elapses; its settlement survives only in the current-launch slot. */
      for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
        enqueueOutbox(provisional, {
          id: `ttl-reseed-warm-${index}`,
          text: `ttl reseed warm ${index}`,
          images: 0,
          at: 2_000 + index,
        });
      }
      expect(readOutbox(provisional).some((entry) => entry.id === launchId)).toBe(false);

      /* The recurring LogFeed seed fires once inside the TTL window. The bubble
         must come back visibly DELIVERED with its original settlement — never as
         a fresh delivering entry that no echo or TTL could ever retire. */
      seedLaunchOutbox(provisional, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      const reseeded = readOutbox(provisional).find((entry) => entry.id === launchId);
      expect(reseeded?.state).toBe("delivered");
      expect(reseeded?.settledAt).toBe(settledAt);
      expect(visibleOutbox(readOutbox(provisional), echoes(), now).some((entry) => entry.id === launchId))
        .toBe(true);

      /* Past the TTL the launch retires and a recurring seed cannot revive it. */
      now = settledAt + OUTBOX_DELIVERED_TTL_MS;
      expect(visibleOutbox(readOutbox(provisional), echoes(), now).some((entry) => entry.id === launchId))
        .toBe(false);
      seedLaunchOutbox(provisional, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      expect(visibleOutbox(readOutbox(provisional), echoes(), now).some((entry) => entry.id === launchId))
        .toBe(false);

      /* Adoption, generation rollover past both retention bounds, and tail
         eviction leave the launch retired. */
      adoptOutbox(provisional, conversation);
      for (let index = 0; index < 512 + OUTBOX_LIMIT + 1; index += 1) {
        const id = `ttl-reseed-churn-${index}`;
        const churnText = `ttl reseed churn ${index}`;
        enqueueOutbox(conversation, {
          id,
          text: churnText,
          images: 0,
          at: 3_000 + index,
        });
        updateOutbox(conversation, id, {
          state: outboxStateForReceiptStatus("delivered"),
          settledAt: 3_000 + index,
        });
        publishTranscriptEchoes(conversation, [{
          generation: index < 256
            ? "/transcripts/626-ttl-reseed-1.jsonl"
            : "/transcripts/626-ttl-reseed-2.jsonl",
          id: `row:ttl-reseed:${index}`,
          text: churnText,
        }]);
      }
      enqueueOutbox(conversation, {
        id: "ttl-reseed-unrelated-pending",
        text: "unrelated pending survives the TTL reseed retirement",
        images: 0,
        at: 10_000,
      });

      /* Refresh/reconnect plus further recurring seeds never resurrect it. */
      resetOutboxForTests();
      publishTranscriptEchoes(conversation, []);
      seedLaunchOutbox(conversation, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });
      resetOutboxForTests();
      seedLaunchOutbox(conversation, {
        id: launchId,
        text,
        images: 0,
        at: 1_000,
      });

      const refreshed = readOutbox(conversation);
      expect(refreshed.some((entry) => entry.id === launchId)).toBe(false);
      expect(refreshed.find((entry) => entry.id === "ttl-reseed-unrelated-pending")?.state)
        .toBe("queued");
      expect(visibleOutbox(refreshed, echoes(), now).some((entry) => entry.id === launchId))
        .toBe(false);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("issue 626: terminal launch retirement survives both ledgers churning beyond 512 entries", () => {
    const provisional = "spawn:launch_626_terminal_priority";
    const conversation = "conversation_626_terminal_priority";
    const launchId = "launch_626_terminal_priority";
    const text = "terminal launch prompt beyond both retention bounds";
    const firstGeneration = "/transcripts/626-terminal-priority-1.jsonl";
    const secondGeneration = "/transcripts/626-terminal-priority-2.jsonl";

    seedLaunchOutbox(provisional, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });
    publishTranscriptEchoes(provisional, [{
      generation: firstGeneration,
      id: "row:launch:0",
      text,
    }]);
    expect(readOutbox(provisional)[0]?.retiredEchoId).toBeDefined();

    for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
      const id = `terminal-priority-warm-${index}`;
      const churnText = `terminal priority warm ${index}`;
      enqueueOutbox(provisional, {
        id,
        text: churnText,
        images: 0,
        at: 2_000 + index,
      });
      updateOutbox(provisional, id, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: 2_000 + index,
      });
      publishTranscriptEchoes(provisional, [{
        generation: firstGeneration,
        id: `row:warm:${index}`,
        text: churnText,
      }]);
    }
    expect(readOutbox(provisional).some((entry) => entry.id === launchId)).toBe(false);

    adoptOutbox(provisional, conversation);
    publishTranscriptEchoes(conversation, []);
    resetOutboxForTests();

    for (let index = 0; index < 512 + OUTBOX_LIMIT + 1; index += 1) {
      const id = `terminal-priority-churn-${index}`;
      const churnText = `terminal priority churn ${index}`;
      enqueueOutbox(conversation, {
        id,
        text: churnText,
        images: 0,
        at: 3_000 + index,
      });
      updateOutbox(conversation, id, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: 3_000 + index,
      });
      publishTranscriptEchoes(conversation, [{
        generation: index < 256 ? firstGeneration : secondGeneration,
        id: `row:churn:${index}`,
        text: churnText,
      }]);
    }
    enqueueOutbox(conversation, {
      id: "terminal-priority-unrelated-pending",
      text: "keep unrelated pending after launch retirement",
      images: 0,
      at: 10_000,
    });
    publishTranscriptEchoes(conversation, []);
    resetOutboxForTests();

    seedLaunchOutbox(conversation, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });
    let refreshed = readOutbox(conversation);
    expect(refreshed.some((entry) => entry.id === launchId)).toBe(false);
    expect(refreshed.find((entry) => entry.id === "terminal-priority-unrelated-pending")?.state)
      .toBe("queued");

    resetOutboxForTests();
    seedLaunchOutbox(conversation, {
      id: launchId,
      text,
      images: 0,
      at: 1_000,
    });
    refreshed = readOutbox(conversation);
    expect(refreshed.some((entry) => entry.id === launchId)).toBe(false);
    expect(visibleOutbox(refreshed, echoes(), 11_000).some((entry) => entry.id === launchId))
      .toBe(false);
  });

  test("issue 626: the current-launch slot deterministically preserves the newest terminal launch", () => {
    const conversation = "conversation_626_current_launch_cap";
    const generation = "/transcripts/626-current-launch-cap.jsonl";

    seedLaunchOutbox(conversation, {
      id: "older-terminal-launch",
      text: "older terminal launch text",
      images: 0,
      at: 1_000,
    });
    publishTranscriptEchoes(conversation, [{
      generation,
      id: "row:older-launch:0",
      text: "older terminal launch text",
    }]);
    for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
      enqueueOutbox(conversation, {
        id: `current-launch-filler-${index}`,
        text: `current launch filler ${index}`,
        images: 0,
        at: 2_000 + index,
      });
    }

    seedLaunchOutbox(conversation, {
      id: "newer-terminal-launch",
      text: "newer terminal launch text",
      images: 0,
      at: 3_000,
    });
    publishTranscriptEchoes(conversation, [{
      generation,
      id: "row:newer-launch:0",
      text: "newer terminal launch text",
    }]);

    for (let index = 0; index < 512 + OUTBOX_LIMIT + 1; index += 1) {
      const id = `current-launch-churn-${index}`;
      const text = `current launch churn ${index}`;
      enqueueOutbox(conversation, {
        id,
        text,
        images: 0,
        at: 4_000 + index,
      });
      updateOutbox(conversation, id, {
        state: outboxStateForReceiptStatus("delivered"),
        settledAt: 4_000 + index,
      });
      publishTranscriptEchoes(conversation, [{
        generation,
        id: `row:current-launch-churn:${index}`,
        text,
      }]);
    }
    publishTranscriptEchoes(conversation, []);
    resetOutboxForTests();

    seedLaunchOutbox(conversation, {
      id: "older-terminal-launch",
      text: "older terminal launch text",
      images: 0,
      at: 1_000,
    });
    seedLaunchOutbox(conversation, {
      id: "newer-terminal-launch",
      text: "newer terminal launch text",
      images: 0,
      at: 3_000,
    });

    const queue = readOutbox(conversation);
    expect(queue.some((entry) => entry.id === "older-terminal-launch")).toBe(true);
    expect(queue.some((entry) => entry.id === "newer-terminal-launch")).toBe(false);
  });

  test("issue 626: delayed-echo and no-echo terminal reasons coexist for one current launch", () => {
    const originalDateNow = Date.now;
    const conversation = "conversation_626_current_launch_reasons";
    Date.now = () => 1_100;
    try {
      seedLaunchOutbox(conversation, {
        id: "launch-with-both-terminal-reasons",
        text: "launch with delayed echo and response evidence",
        images: 0,
        at: 1_000,
      });
      publishTranscriptEchoes(conversation, [{
        generation: "/transcripts/626-current-launch-reasons.jsonl",
        id: "row:launch:0",
        text: "launch with delayed echo and response evidence",
      }]);
      markOutboxResponded(conversation, "launch-with-both-terminal-reasons", 1_200);

      expect(JSON.parse(
        dom.sessionStorage.getItem(`llvOutboxCurrentLaunch:${conversation}`) ?? "null",
      )).toMatchObject({
        retiredEchoId: expect.any(String),
        terminalReason: "response-started",
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test.each(["response-started", "delivered-ttl"] as const)(
    "issue 626: the current-launch slot deterministically replaces an older %s retirement",
    (reason) => {
      const originalDateNow = Date.now;
      Date.now = () => 1_000_000;
      try {
        const conversation = `conversation_626_current_launch_${reason}`;
        const retire = (id: string, at: number) => {
          if (reason === "response-started") {
            markOutboxResponded(conversation, id, at);
            return;
          }
          updateOutbox(conversation, id, {
            state: outboxStateForReceiptStatus("delivered"),
            settledAt: at,
          });
        };

        seedLaunchOutbox(conversation, {
          id: "older-no-echo-launch",
          text: "older no-echo launch text",
          images: 0,
          at: 1_000,
        });
        retire("older-no-echo-launch", 1_100);
        for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
          enqueueOutbox(conversation, {
            id: `older-no-echo-filler-${reason}-${index}`,
            text: `older no-echo filler ${reason} ${index}`,
            images: 0,
            at: 2_000 + index,
          });
        }

        seedLaunchOutbox(conversation, {
          id: "newer-no-echo-launch",
          text: "newer no-echo launch text",
          images: 0,
          at: 3_000,
        });
        retire("newer-no-echo-launch", 3_100);
        for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
          enqueueOutbox(conversation, {
            id: `newer-no-echo-filler-${reason}-${index}`,
            text: `newer no-echo filler ${reason} ${index}`,
            images: 0,
            at: 4_000 + index,
          });
        }

        resetOutboxForTests();
        seedLaunchOutbox(conversation, {
          id: "older-no-echo-launch",
          text: "older no-echo launch text",
          images: 0,
          at: 1_000,
        });
        seedLaunchOutbox(conversation, {
          id: "newer-no-echo-launch",
          text: "newer no-echo launch text",
          images: 0,
          at: 3_000,
        });

        const queue = readOutbox(conversation);
        expect(queue.some((entry) => entry.id === "older-no-echo-launch")).toBe(true);
        expect(queue.some((entry) => entry.id === "newer-no-echo-launch")).toBe(false);
      } finally {
        Date.now = originalDateNow;
      }
    },
  );

  test("the seeded launch bubble is adopted into the materialized conversation identity", () => {
    // Seeded under the launch placeholder, then the composer adopts it forward.
    seedLaunchOutbox("spawn:launch_1", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    adoptOutbox("spawn:launch_1", "conversation_live");
    expect(readOutbox("spawn:launch_1")).toHaveLength(0);
    expect(readOutbox("conversation_live")[0]).toMatchObject({ id: "launch_1", launchOwned: true });
  });

  test.each([
    ["builder", "You are a Builder in TDD mode.\n\nLLV615_RAW_PROMPT"],
    ["reviewer", "You are a Reviewer.\nSafety fences:\n- stay in scope\n\nLLV615_RAW_PROMPT"],
  ])("issue 615 HIGH2: a %s role launch displays the raw draft but retires on the canonical scaffolded echo", (_role, scaffolded) => {
    const raw = "LLV615_RAW_PROMPT";
    /* The composer seeds the RAW operator draft (no scaffold — the server adds
       it), so the bubble is user-facing. Its canonical echo identity is the
       delivered scaffolded text the transcript will actually record. */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 1, at: 1_000, echoText: scaffolded });
    const queue = readOutbox("conversation_615");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ text: raw, echoText: scaffolded, launchOwned: true });

    /* Exact-text matching on the RAW draft can NEVER retire it — the transcript
       echoes the scaffolded text, not the raw draft. The bubble stays visible. */
    expect(visibleOutbox(queue, echoes(raw), 5_000).map((e) => e.id)).toEqual(["launch_615"]);
    /* The canonical scaffolded echo landing in the transcript retires it. */
    expect(visibleOutbox(queue, echoes(scaffolded), 5_000)).toEqual([]);
  });

  test("issue 615 HIGH2: identical launch id reconciliation attaches the canonical echo identity while preserving the raw draft; refresh, images and zero duplicate hold", () => {
    const raw = "LLV615_RAW_PROMPT";
    const scaffolded = "You are a Builder in TDD mode.\n\nLLV615_RAW_PROMPT";
    /* DraftAgentPane seeds first, immediately, with the RAW draft and no echo
       identity (the client never composes the scaffold). */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 3, at: 1_000 });
    expect(readOutbox("conversation_615")[0]).toMatchObject({ text: raw, images: 3, launchOwned: true });
    /* Exact-text matching cannot retire it yet — this is the reported bug. */
    expect(visibleOutbox(readOutbox("conversation_615"), echoes(scaffolded), 5_000).map((e) => e.id)).toEqual(["launch_615"]);

    /* The next /api/files poll carries the server-projected launch: LogFeed
       re-seeds the SAME launch id WITH the canonical echo identity. Reconciliation
       attaches it to the existing bubble — one bubble, RAW draft preserved. */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 3, at: 2_000, echoText: scaffolded });
    const merged = readOutbox("conversation_615");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: raw, images: 3, echoText: scaffolded, launchOwned: true });

    /* A refresh rehydrates the one reconciled bubble, echo identity intact. */
    resetOutboxForTests();
    const refreshed = readOutbox("conversation_615");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ text: raw, images: 3, echoText: scaffolded });

    /* The live scaffolded echo retires it — zero duplicate, zero lingering. */
    expect(visibleOutbox(refreshed, echoes(scaffolded), 5_000)).toEqual([]);
  });

  test("issue 614: a server-projected seed and the composer's own seed (identical launch id and text) are ONE bubble that survives a refresh and retires on its own echo — never a duplicate", () => {
    const identical = "LLV614_CANONICAL_PROBE_20260723";
    /* The board that ran the composer seeds under the canonical identity. */
    seedLaunchOutbox("conversation_614", { id: "launch_614", text: identical, images: 0, at: 1_000 });
    /* A later /api/files poll carries the server-projected launch prompt; LogFeed
       re-seeds by the SAME launch id with the SAME text — idempotent, no second
       bubble. This is also the ONLY seed a surface that never ran the composer
       (an MCP spawn observer, a second tab) receives. */
    seedLaunchOutbox("conversation_614", { id: "launch_614", text: identical, images: 0, at: 2_000 });
    expect(readOutbox("conversation_614")).toHaveLength(1);

    /* A page refresh (fresh module state) rehydrates exactly one launch-owned
       bubble from sessionStorage — the prompt is preserved, never re-queued. */
    resetOutboxForTests();
    const refreshed = readOutbox("conversation_614");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ id: "launch_614", text: identical, state: "delivering", launchOwned: true });

    /* Before the transcript flush the bubble is the only representation of the
       prompt (visible). */
    expect(visibleOutbox(refreshed, echoes(), 5_000).map((entry) => entry.id)).toEqual(["launch_614"]);
    /* Transcript adoption: the flushed transcript echoes the prompt exactly once,
       which retires the launch-owned bubble — one window, zero duplicate. */
    expect(visibleOutbox(refreshed, echoes(identical), 5_000)).toEqual([]);
  });
});

test("adoption moves a queue onto the materialized conversation identity idempotently", () => {
  submit("spawn:launch", "k1", "queued into the launch window");
  /* The launch materializes into its conversation; the queue rides along. */
  adoptOutbox("spawn:launch", "conversation_live");
  expect(readOutbox("spawn:launch")).toHaveLength(0);
  expect(readOutbox("conversation_live").map((entry) => entry.id)).toEqual(["k1"]);
  /* A second adoption is a no-op — records already under the new id win. */
  adoptOutbox("spawn:launch", "conversation_live");
  expect(readOutbox("conversation_live")).toHaveLength(1);
});

test("an image-bearing entry that could not survive a refresh is held for re-attachment, not sent blind", () => {
  enqueueOutbox("conv", { id: "k1", text: "see screenshot", images: 2, at: Date.now() });
  updateOutbox("conv", "k1", { state: "delivering" });
  /* A refresh: module state is gone, only sessionStorage remains. */
  resetOutboxForTests();
  const restored = readOutbox("conv");
  expect(restored[0]!.state).toBe("failed");
  expect(restored[0]!.needsReattach).toBe(true);
  /* It is NOT re-dispatched (that would send text with no image). */
  expect(nextDispatch(restored)).toBeNull();
});

test("a text-only delivering entry returns to the queue for replay after a refresh", () => {
  submit("conv", "k1", "text only");
  updateOutbox("conv", "k1", { state: "delivering" });
  resetOutboxForTests();
  const restored = readOutbox("conv");
  expect(restored[0]!.state).toBe("queued");
  expect(nextDispatch(restored)?.id).toBe("k1");
});
