import { expect, test } from "bun:test";

import { normalizeCodexNotification, normalizeCodexRequest } from "./codex";
import { runtimeScope } from "./contracts";

test("Codex lifecycle notifications map onto canonical product event kinds", () => {
  const scope = runtimeScope("session", "conv-one");
  expect(normalizeCodexNotification(scope, {
    method: "turn/completed",
    params: { threadId: "thread-one", turn: { id: "turn-one", status: "completed" } },
  })).toMatchObject({
    scope,
    kind: "turn-ended",
    payload: { threadId: "thread-one", turn: { id: "turn-one", status: "completed" } },
  });
  expect(normalizeCodexNotification(scope, {
    method: "item/completed",
    params: { threadId: "thread-one", turnId: "turn-one", item: { id: "item-one", type: "commandExecution" } },
  })).toMatchObject({ kind: "item", payload: { phase: "completed" } });
});

test("Codex server requests become stable structured attention records", () => {
  const scope = runtimeScope("session", "conv-one");
  expect(normalizeCodexRequest(scope, {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-one", turnId: "turn-one", itemId: "item-one", command: "bun test" },
  })).toMatchObject({
    scope,
    kind: "attention",
    payload: {
      id: "codex-conv-one-42",
      conversationId: "conv-one",
      kind: "approval",
      state: "open",
      request: { command: "bun test" },
      turnId: "turn-one",
    },
  });
  const other = normalizeCodexRequest(runtimeScope("session", "conv-two"), {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { turnId: "turn-two", command: "bun test" },
  });
  expect(other.payload.id).toBe("codex-conv-two-42");
  expect(other.producer?.eventKey).not.toBe(normalizeCodexRequest(scope, {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { turnId: "turn-one", command: "bun test" },
  }).producer?.eventKey);
});

test("Codex status snapshots retain repeated state transitions and seed hosted identity", () => {
  const scope = runtimeScope("session", "conv-one");
  const started = normalizeCodexNotification(scope, {
    method: "thread/started",
    params: { thread: { id: "thread-one" } },
  });
  expect(started).toMatchObject({
    kind: "session-status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
    },
  });
  const status = normalizeCodexNotification(scope, {
    method: "thread/status/changed",
    params: { threadId: "thread-one", status: "idle" },
  });
  expect(status?.producer?.eventKey).toBeUndefined();
});
