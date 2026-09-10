import { expect, test } from "bun:test";

import { nativeQueueProfile, projectNativeQueue, reorderedNativeQueue, type NativeQueueViewInput } from "./nativeQueueView";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";
import type { NativeQueuedSubmission } from "@/lib/runtime/nativeCodexQueue";

/**
 * What the queue panel shows and offers (#1629), decided without a browser.
 *
 * The rules under test are the runtime's own, restated where the operator can
 * see them: Codex owns the order, a dispatched payload is frozen, an entry Codex
 * has not acknowledged has no handle to change, and a message vanishing from the
 * queue settles nothing.
 */

const BINDING = { threadId: "thread-1", accountId: "acct-1" };

function entry(overrides: Partial<NativeQueueRecord> & { entryId: string }): NativeQueueRecord {
  return {
    conversationId: "conversation_queue",
    binding: BINDING,
    clientUserMessageId: `client-${overrides.entryId}`,
    nativeSubmissionId: `native-${overrides.entryId}`,
    revision: 1,
    versions: [{
      revision: 1,
      operationId: `op-${overrides.entryId}`,
      text: `message ${overrides.entryId}`,
      images: [],
      contentDigest: `digest-${overrides.entryId}`,
    }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
    ...overrides,
  };
}

function submission(entryId: string): NativeQueuedSubmission {
  return { id: `native-${entryId}`, clientUserMessageId: `client-${entryId}`, input: [{ type: "text", text: `message ${entryId}` }] };
}

function view(input: Partial<NativeQueueViewInput> & { entries: NativeQueueRecord[] }) {
  return projectNativeQueue({ native: null, turn: "idle", ...input });
}

test("the order shown is Codex's, not the order this Viewer admitted", () => {
  /* Codex holds the queue and decides what goes next, so a Viewer that renders
     its own admission order would be telling the operator something false the
     moment anything is reordered — by them or by Codex. */
  const projected = view({
    entries: [entry({ entryId: "a" }), entry({ entryId: "b" }), entry({ entryId: "c" })],
    native: { threadId: "thread-1", items: [submission("c"), submission("a"), submission("b")], stale: false },
  });
  expect(projected.rows.map((row) => row.entryId)).toEqual(["c", "a", "b"]);
  expect(projected.rows.every((row) => row.observedInNative)).toBeTrue();
});

test("an entry Codex has not acknowledged sorts last and offers nothing but waiting", () => {
  /* Update, delete and send now all name the native submission id. Offering a
     control that would be refused on the wire is worse than saying why. */
  const projected = view({
    entries: [entry({ entryId: "a" }), entry({ entryId: "new", nativeSubmissionId: null })],
    native: { threadId: "thread-1", items: [submission("a")], stale: false },
  });
  expect(projected.rows.map((row) => row.entryId)).toEqual(["a", "new"]);
  const pending = projected.rows[1]!;
  expect(pending.observedInNative).toBeFalse();
  expect(pending.actions).toEqual([]);
  expect(pending.blocked).toEqual({ code: "unacknowledged" });
  expect(projected.notice).toEqual({ code: "pending", count: 1 });
});

test("a dispatched entry can no longer be changed by anything", () => {
  const projected = view({
    entries: [entry({ entryId: "a", dispatchedRevision: 1, dispatchedTurnId: "turn-1", state: "dispatching" })],
    native: { threadId: "thread-1", items: [], stale: false },
  });
  expect(projected.rows[0]!.actions).toEqual([]);
  expect(projected.rows[0]!.blocked).toEqual({ code: "dispatched" });
});

test("an entry whose last change has an unknown outcome offers no retry", () => {
  /* The runtime keeps the original operation and its payload. A second mutation
     from here would be a blind retry of something nobody has the result of. */
  const projected = view({
    entries: [entry({ entryId: "a", state: "uncertain", reason: "native queue mutation outcome is unknown" })],
    native: { threadId: "thread-1", items: [submission("a")], stale: false },
  });
  expect(projected.rows[0]!.actions).toEqual([]);
  expect(projected.rows[0]!.blocked)
    .toEqual({ code: "uncertain", detail: "native queue mutation outcome is unknown" });
});

test("a withdrawn payload waits for an idle thread and then offers the one action the runtime admits", () => {
  const running = view({
    entries: [entry({ entryId: "a", state: "withdrawn" })],
    native: { threadId: "thread-1", items: [], stale: false },
    turn: "running",
  });
  expect(running.rows[0]!.actions).toEqual([]);
  expect(running.rows[0]!.blocked).toEqual({ code: "withdrawn-running" });

  /* START, and nothing else. The journal refuses every other action on a
     withdrawn entry ("withdrawn input requires an explicit idle start"), so
     offering `send-now` here offered the one control that could never be
     admitted and stranded the operator's words with no route back. */
  const idle = view({
    entries: [entry({ entryId: "a", state: "withdrawn" })],
    native: { threadId: "thread-1", items: [], stale: false },
  });
  expect(idle.rows[0]!.actions).toEqual(["start"]);
  /* And the queue-level notice does not describe it as waiting for an
     acknowledgement Codex is never going to give it. */
  expect(idle.notice).toBeNull();
});

test("a mutation in flight freezes its own row and nothing else", () => {
  const projected = view({
    entries: [entry({ entryId: "a" }), entry({ entryId: "b" })],
    native: { threadId: "thread-1", items: [submission("a"), submission("b")], stale: false },
    inFlight: new Set(["a"]),
  });
  expect(projected.rows[0]!.busy).toBeTrue();
  expect(projected.rows[0]!.actions).toEqual([]);
  expect(projected.rows[1]!.actions).toContain("edit");
});

test("a queue Codex could not be read from says so and offers no reorder", () => {
  /* Reorder names submission ids in an order this Viewer would be asserting. An
     order that may already be wrong must not be submitted as the intended one. */
  const projected = view({
    entries: [entry({ entryId: "a" })],
    native: { threadId: "thread-1", items: [submission("a")], stale: true },
  });
  expect(projected.nativeStale).toBeTrue();
  expect(projected.reorderable).toEqual([]);
  expect(projected.canStart).toBeFalse();
  expect(projected.notice).toEqual({ code: "stale" });
});

test("the queue can be started only from an idle thread with something in it", () => {
  const populated = { threadId: "thread-1", items: [submission("a")], stale: false };
  expect(view({ entries: [entry({ entryId: "a" })], native: populated }).canStart).toBeTrue();
  expect(view({ entries: [entry({ entryId: "a" })], native: populated, turn: "running" }).canStart).toBeFalse();
  expect(view({ entries: [], native: { threadId: "thread-1", items: [], stale: false } }).canStart).toBeFalse();
});

test("send now fences against the turn actually running", () => {
  const projected = view({
    entries: [entry({ entryId: "a" })],
    native: { threadId: "thread-1", items: [submission("a")], stale: false },
    turn: "running",
    activeTurnId: "turn-live",
  });
  expect(projected.activeTurnId).toBe("turn-live");
  /* Idle threads have no turn to fence against, and the runtime requires an
     explicit null rather than a guess. */
  expect(view({ entries: [entry({ entryId: "a" })], activeTurnId: "turn-live" }).activeTurnId).toBeNull();
});

test("a settled entry leaves the panel, delivered ones included", () => {
  const projected = view({
    entries: [
      entry({ entryId: "gone", state: "removed" }),
      entry({ entryId: "no", state: "refused", reason: "ownership changed" }),
      entry({ entryId: "done", state: "delivered" }),
      entry({ entryId: "live" }),
    ],
    native: { threadId: "thread-1", items: [submission("live")], stale: false },
  });
  expect(projected.rows.map((row) => row.entryId)).toEqual(["live"]);
});

test("the header counts the queue, leaving out the history the journal keeps", () => {
  /* The journal returns up to 128 settled rows so a reader can see what happened.
     Counting them into the panel above the composer read "129 messages" over a
     queue holding one, which is the opposite of what the operator needs from the
     one number on that line. */
  const projected = view({
    entries: [
      ...Array.from({ length: 128 }, (_, index) => entry({ entryId: `done-${index}`, state: "delivered" })),
      entry({ entryId: "live" }),
    ],
    native: { threadId: "thread-1", items: [submission("live")], stale: false },
  });
  expect(projected.rows).toHaveLength(1);
  expect(projected.rows[0]!.entryId).toBe("live");
});

test("a row carries the attachments an edit has to carry forward", () => {
  /* The Save control admits a whole new version, and its digest is computed over
     exactly what the command names. A row that could only say HOW MANY images it
     had left the control nothing to send, so editing the words of a message
     silently admitted a revision with none. */
  const projected = view({
    entries: [entry({
      entryId: "a",
      versions: [{
        revision: 1,
        operationId: "op-a",
        text: "look at this",
        images: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 12 }],
        contentDigest: "digest-a",
      }],
    })],
    native: { threadId: "thread-1", items: [submission("a")], stale: false },
  });
  expect(projected.rows[0]!.imageCount).toBe(1);
  expect(projected.rows[0]!.images).toEqual([{ sha256: "a".repeat(64), mime: "image/png", bytes: 12 }]);
});

test("moving an entry rewrites only the order Codex acknowledged", () => {
  const projected = view({
    entries: [entry({ entryId: "a" }), entry({ entryId: "b" }), entry({ entryId: "pending", nativeSubmissionId: null })],
    native: { threadId: "thread-1", items: [submission("a"), submission("b")], stale: false },
  });
  expect(reorderedNativeQueue(projected, "native-b", "up")).toEqual(["native-b", "native-a"]);
  expect(reorderedNativeQueue(projected, "native-a", "up")).toBeNull();
  expect(reorderedNativeQueue(projected, "native-b", "down")).toBeNull();
  /* An entry with no submission id cannot be named in a reorder at all. */
  expect(reorderedNativeQueue(projected, "native-pending", "up")).toBeNull();
});

test("the profile names what the thread was OBSERVED on, and the request as a request", () => {
  /* Native's queue parameters carry no model or effort, so nobody can say what
     a queued message WILL run on. The observed value is the thread's current
     settings and the requested one is a pending preference; presenting either as
     the other invents a guarantee the protocol does not have. */
  expect(nativeQueueProfile({ requestedRuntime: null }, { model: "gpt-6-astra", effort: "high" }))
    .toEqual({ observed: "gpt-6-astra · high", requested: null });

  expect(nativeQueueProfile(
    { requestedRuntime: { model: "gpt-6-astra", effort: "low" } },
    { model: "gpt-6-astra", effort: "high" },
  )).toEqual({ observed: "gpt-6-astra · high", requested: "gpt-6-astra · low" });

  /* A request that matches what will run is not worth saying twice. */
  expect(nativeQueueProfile(
    { requestedRuntime: { model: "gpt-6-astra", effort: "high" } },
    { model: "gpt-6-astra", effort: "high" },
  )).toEqual({ observed: "gpt-6-astra · high", requested: null });

  /* And a thread the Viewer has observed nothing about says so rather than
     substituting the request, which is the only other value in reach. */
  expect(nativeQueueProfile({ requestedRuntime: null }, { model: null, effort: null }))
    .toEqual({ observed: null, requested: null });
  expect(nativeQueueProfile(
    { requestedRuntime: { model: "gpt-6-astra", effort: "low" } },
    { model: null, effort: null },
  )).toEqual({ observed: null, requested: "gpt-6-astra · low" });
});
