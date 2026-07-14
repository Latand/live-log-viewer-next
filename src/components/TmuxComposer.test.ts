import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { deliveryAttemptKey, mergeRuntimeReceipts, RuntimeComposerReceipts } from "./TmuxComposer";
import { collapseReceipts } from "./runtime/runtimeModel";

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

test("the newest immediate operation surfaces over an older durable failure (finding 3)", () => {
  // Different operations: the durable failure is older, the immediate queued send
  // is newer. Insertion order alone would surface the stale failure; newest-first
  // timestamp ordering surfaces the queued receipt.
  const oldFailure = {
    operationId: "op-old", idempotencyKey: "k-old", conversationId: "c", kind: "send" as const,
    status: "failed" as const, reason: "dead-host", text: "first", at: "2026-07-13T00:00:00.000Z", revision: 5,
  };
  const newQueued = {
    operationId: "op-new", idempotencyKey: "k-new", conversationId: "c", kind: "send" as const,
    status: "queued" as const, reason: null, text: "second", at: "2026-07-13T00:05:00.000Z", revision: 1,
  };
  const merged = mergeRuntimeReceipts([oldFailure], [newQueued]);
  expect(merged.map((r) => r.operationId)).toEqual(["op-new", "op-old"]);
  expect(collapseReceipts(merged).current?.receipt.operationId).toBe("op-new");
});

test("a duplicate operation collapses to its highest revision, malformed timestamps sort last deterministically", () => {
  const base = { idempotencyKey: "k", conversationId: "c", kind: "send" as const, text: "t" };
  const lowRev = { ...base, operationId: "op-dup", status: "failed" as const, reason: "x", at: "2026-07-13T00:00:00.000Z", revision: 1 };
  const highRev = { ...base, operationId: "op-dup", status: "queued" as const, reason: null, at: "2026-07-13T00:00:00.000Z", revision: 2 };
  const malformed = { ...base, operationId: "op-bad", status: "failed" as const, reason: "y", at: "not-a-date", revision: 1 };
  const merged = mergeRuntimeReceipts([lowRev, malformed], [highRev]);
  // the higher revision wins the dedupe (one entry for op-dup) and leads the well-timed pair
  expect(merged.map((r) => r.operationId)).toEqual(["op-dup", "op-bad"]);
  expect(merged.find((r) => r.operationId === "op-dup")!.revision).toBe(2);
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
  expect(html.match(/min-h-11/g)?.length).toBe(2);
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
