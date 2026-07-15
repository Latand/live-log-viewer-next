import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
