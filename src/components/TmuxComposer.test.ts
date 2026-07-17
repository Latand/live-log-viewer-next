import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { translate } from "@/lib/i18n";

import { deliveryAttemptKey, mergeRuntimeReceipts, RuntimeComposerReceipts, structuredComposerSession } from "./TmuxComposer";

function runtimeSession(structuredControlsEnabled: boolean): RuntimeSessionView {
  return {
    structuredControlsEnabled,
    legacy: false,
    uiState: "idle",
    attentions: [],
    receipts: [],
    session: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      revision: 1,
      attentionIds: [],
      recentReceipts: [],
      accountId: "account-one",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/repo/thread-one.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
      drift: null,
    },
  };
}

test("the composer follows structured-host gate transitions", () => {
  const session = runtimeSession(true);
  expect(structuredComposerSession(session)?.session.conversationId).toBe("conv-one");
  session.structuredControlsEnabled = false;
  expect(structuredComposerSession(session)).toBeNull();
});

test("a failed durable receipt retries with its original delivery key", () => {
  expect(deliveryAttemptKey("fresh-key", "held-key")).toBe("held-key");
  expect(deliveryAttemptKey("fresh-key")).toBe("fresh-key");
});

test("an immediate retry receipt supersedes an older failed bus receipt", () => {
  const failed = {
    operationId: "op-retry",
    idempotencyKey: "key-retry",
    conversationId: "conv-one",
    kind: "send" as const,
    status: "failed" as const,
    reason: "engine write failed",
    text: "try this again",
    at: "2026-07-13T00:00:00.000Z",
    revision: 3,
  };
  const queued = { ...failed, status: "queued" as const, reason: null, revision: 4 };

  expect(mergeRuntimeReceipts([failed], [queued])).toEqual([queued]);
});

test("the highest receipt revision wins before wall-clock ordering", () => {
  const delivering: RuntimeReceipt = {
    operationId: "op-clock-rollback",
    idempotencyKey: "key-clock-rollback",
    conversationId: "conv-one",
    kind: "send",
    status: "delivering",
    reason: null,
    text: "keep the authoritative state",
    at: "2026-07-16T10:00:00.000Z",
    revision: 2,
  };
  const staleQueued: RuntimeReceipt = {
    ...delivering,
    status: "queued",
    at: "2026-07-16T10:00:01.000Z",
    revision: 1,
  };

  expect(mergeRuntimeReceipts([staleQueued], [delivering])).toEqual([delivering]);
  expect(mergeRuntimeReceipts([delivering], [staleQueued])).toEqual([delivering]);
});

test("a delivered durable retry leaf outlives its stale queued projection", () => {
  type RetryReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
  const parent: RetryReceipt = {
    operationId: "op-A",
    idempotencyKey: "key-A",
    conversationId: "conv-one",
    kind: "send",
    status: "failed",
    reason: "dead-host",
    text: "deliver exactly once",
    at: "2026-07-16T10:00:00.000Z",
    revision: 3,
  };
  // The immediate retry response projects the new attempt onto the parent
  // operation id with the fresh idempotency key and a bumped revision.
  const projection: RetryReceipt = {
    ...parent,
    idempotencyKey: "key-A2",
    status: "queued",
    reason: null,
    at: "2026-07-16T10:00:01.000Z",
    revision: 4,
    retryOfOperationId: parent.operationId,
  };
  // The durable bus later carries the real retry leaf under its own operation
  // id with its own (lower) per-scope revision counter.
  const leaf: RetryReceipt = {
    ...projection,
    operationId: "op-A-retry",
    status: "delivered",
    at: "2026-07-16T10:00:02.000Z",
    revision: 3,
  };

  expect(mergeRuntimeReceipts([parent, leaf], [projection])).toEqual([leaf]);
});

test("the receipt live status pluralizes pending and issue counts in both locales", () => {
  expect(translate("en", "runtime.receipt.statusPending", { count: 1 })).toBe("1 pending message");
  expect(translate("en", "runtime.receipt.statusPending", { count: 2 })).toBe("2 pending messages");
  expect(translate("en", "runtime.receipt.statusProblems", { count: 1 })).toBe("1 issue");
  expect(translate("en", "runtime.receipt.statusProblems", { count: 2 })).toBe("2 issues");
  expect(translate("uk", "runtime.receipt.statusPending", { count: 1 })).toBe("1 повідомлення очікує");
  expect(translate("uk", "runtime.receipt.statusPending", { count: 3 })).toBe("3 повідомлення очікують");
  expect(translate("uk", "runtime.receipt.statusPending", { count: 5 })).toBe("5 повідомлень очікують");
  expect(translate("uk", "runtime.receipt.statusProblems", { count: 1 })).toBe("1 проблема");
  expect(translate("uk", "runtime.receipt.statusProblems", { count: 2 })).toBe("2 проблеми");
  expect(translate("uk", "runtime.receipt.statusProblems", { count: 5 })).toBe("5 проблем");
});

test("retry supersession is independent of input and timestamp order", () => {
  type RetryReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
  const parent: RetryReceipt = {
    operationId: "op-parent",
    idempotencyKey: "key-parent",
    conversationId: "conv-one",
    kind: "send",
    status: "failed",
    reason: "dead-host",
    text: "retry me",
    at: "2026-07-16T10:00:02.000Z",
    revision: 3,
  };
  const child: RetryReceipt = {
    ...parent,
    operationId: "op-child",
    idempotencyKey: "key-child",
    retryOfOperationId: parent.operationId,
    status: "queued",
    reason: null,
    at: "2026-07-16T10:00:01.000Z",
    revision: 1,
  };

  expect(mergeRuntimeReceipts([parent, child], [])).toEqual([child]);
  expect(mergeRuntimeReceipts([child], [parent])).toEqual([child]);
});

test("cyclic and missing retry ancestry remain visible without looping", () => {
  type RetryReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
  const base: RetryReceipt = {
    operationId: "op-cycle-a",
    idempotencyKey: "key-cycle-a",
    conversationId: "conv-one",
    kind: "send",
    status: "failed",
    reason: "delivery failed",
    text: "preserve corrupt lineage evidence",
    at: "2026-07-16T10:00:04.000Z",
    revision: 1,
    retryOfOperationId: "op-cycle-b",
  };
  const cyclePeer: RetryReceipt = {
    ...base,
    operationId: "op-cycle-b",
    idempotencyKey: "key-cycle-b",
    at: "2026-07-16T10:00:03.000Z",
    revision: 4,
    retryOfOperationId: base.operationId,
  };
  const missingParent: RetryReceipt = {
    ...base,
    operationId: "op-missing-parent",
    idempotencyKey: "key-missing-parent",
    at: "2026-07-16T10:00:02.000Z",
    retryOfOperationId: "op-absent",
  };
  const independent: RetryReceipt = {
    ...base,
    operationId: "op-independent",
    idempotencyKey: "key-independent",
    at: "2026-07-16T10:00:01.000Z",
    retryOfOperationId: null,
  };

  expect(mergeRuntimeReceipts([cyclePeer, missingParent], [independent, base])
    .map((receipt) => receipt.operationId))
    .toEqual(["op-cycle-a", "op-cycle-b", "op-missing-parent", "op-independent"]);
});

test("the production runtime receipt list exposes recovery actions for failures", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeComposerReceipts, {
      receipts: [{
        operationId: "op-failed",
        idempotencyKey: "key-failed",
        conversationId: "conv-one",
        kind: "send",
        status: "failed",
        reason: "engine write failed",
        text: "try this again",
        at: "2026-07-13T00:00:00.000Z",
        revision: 3,
      }],
      onRetry: () => {},
      onEdit: () => {},
    }),
  );

  expect(html).toContain("engine write failed");
  expect(html).toContain(">Retry<");
  expect(html).toContain("Edit &amp; resend");
  expect(html.match(/min-h-11/g)?.length).toBe(3);
});

test("a queued structured send renders as a quiet optimistic user message", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeComposerReceipts, {
      receipts: [{
        operationId: "op-pending",
        idempotencyKey: "key-pending",
        conversationId: "conv-one",
        kind: "send",
        status: "queued",
        text: "keep going",
        at: "2026-07-13T00:00:00.000Z",
        revision: 1,
      }],
      onRetry: () => {},
      onEdit: () => {},
    }),
  );

  expect(html).toContain('data-optimistic-message="true"');
  expect(html).toContain("keep going");
  expect(html).toContain("animate-pulse");
  expect(html).not.toContain("Queued for durable delivery");
});

test("an optimistic automatic retry shows human busy feedback", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeComposerReceipts, {
      receipts: [{
        operationId: "op-auto-retry",
        idempotencyKey: "key-auto-retry",
        conversationId: "conv-one",
        kind: "steer",
        status: "queued",
        reason: "delivery-auto-retry",
        text: "keep going",
        at: "2026-07-13T00:00:00.000Z",
        revision: 3,
      }],
      onRetry: () => {},
      onEdit: () => {},
    }),
  );

  expect(html).toContain("animate-pulse");
  expect(html).toContain("agent is busy");
  expect(translate("en", "runtime.receipt.busyRetry")).toBe("Couldn’t deliver — agent is busy, we’ll retry");
  expect(translate("uk", "runtime.receipt.busyRetry")).toBe("Не вдалося доставити — агент зайнятий, повторимо");
  expect(html).not.toContain("delivery-auto-retry");
  expect(html).not.toContain("thread/read");
});

test("a bounded receipt summary keeps retry while withholding lossy edit", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeComposerReceipts, {
      receipts: [{
        operationId: "op-long",
        idempotencyKey: "key-long",
        conversationId: "conv-one",
        kind: "send",
        status: "failed",
        text: "x".repeat(240),
        at: "2026-07-13T00:00:00.000Z",
        revision: 3,
      }],
      onRetry: () => {},
      onEdit: () => {},
    }),
  );

  expect(html).toContain(">Retry<");
  expect(html).not.toContain("Edit &amp; resend");
});

/* ── Exact draft clearing on accepted delivery ──────────────────────────── */

import { draftAfterDelivery, settlePendingDeliveries, type PendingDelivery } from "./TmuxComposer";

function deliveredReceipt(key: string, status: RuntimeReceipt["status"] = "delivered", text?: string): RuntimeReceipt {
  return {
    operationId: "op-" + key,
    idempotencyKey: key,
    conversationId: "conv-one",
    kind: "send",
    status,
    ...(text === undefined ? {} : { text }),
    at: "2026-07-17T00:00:00.000Z",
    revision: 1,
  };
}

test("draftAfterDelivery clears a draft that exactly matches the delivered text", () => {
  expect(draftAfterDelivery("ship the fix", "ship the fix")).toBe("");
  expect(draftAfterDelivery("  ship the fix \n", "ship the fix")).toBe("");
});

test("draftAfterDelivery keeps text typed while the send was in flight", () => {
  expect(draftAfterDelivery("ship the fix\n\nalso add tests", "ship the fix")).toBe("also add tests");
});

test("draftAfterDelivery leaves a rewritten draft untouched on a stale delivery", () => {
  expect(draftAfterDelivery("a completely new ask", "ship the fix")).toBe("a completely new ask");
  expect(draftAfterDelivery("", "ship the fix")).toBe("");
  expect(draftAfterDelivery("ship the fix", "")).toBe("ship the fix");
});

test("settlePendingDeliveries clears exactly the delivered keys and keeps the rest", () => {
  const pending: PendingDelivery[] = [
    { key: "key-a", text: "first ask" },
    { key: "key-b", text: "second ask" },
  ];
  const { deliveredTexts, remaining } = settlePendingDeliveries(pending, [deliveredReceipt("key-a")]);
  expect(deliveredTexts).toEqual(["first ask"]);
  expect(remaining).toEqual([{ key: "key-b", text: "second ask" }]);
});

test("settlePendingDeliveries ignores non-delivered and unknown receipts", () => {
  const pending: PendingDelivery[] = [{ key: "key-a", text: "first ask" }];
  const { deliveredTexts, remaining } = settlePendingDeliveries(pending, [
    deliveredReceipt("key-a", "queued"),
    deliveredReceipt("key-a", "failed"),
    deliveredReceipt("key-unknown"),
  ]);
  expect(deliveredTexts).toEqual([]);
  expect(remaining).toEqual(pending);
});

test("settlePendingDeliveries prefers the receipt's own delivered text over the attempt's", () => {
  /* A replayed key can deliver the ORIGINAL turn's text while the local
     attempt carried a rewritten draft — the server's record is what actually
     reached the agent, so clearing keys off the receipt text. */
  const pending: PendingDelivery[] = [{ key: "key-a", text: "rewritten draft" }];
  const { deliveredTexts } = settlePendingDeliveries(pending, [deliveredReceipt("key-a", "delivered", "old turn ask")]);
  expect(deliveredTexts).toEqual(["old turn ask"]);
});

test("settlePendingDeliveries is idempotent across repeated delivered receipts", () => {
  const pending: PendingDelivery[] = [{ key: "key-a", text: "first ask" }];
  const first = settlePendingDeliveries(pending, [deliveredReceipt("key-a")]);
  const second = settlePendingDeliveries(first.remaining, [deliveredReceipt("key-a")]);
  expect(first.deliveredTexts).toEqual(["first ask"]);
  expect(second.deliveredTexts).toEqual([]);
  expect(second.remaining).toEqual([]);
});
