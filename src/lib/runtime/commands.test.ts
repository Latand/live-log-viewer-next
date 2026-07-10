import { expect, test } from "bun:test";

import { parseRuntimeCommand } from "./commands";

test("dedicated runtime command parsers freeze the Opus request bodies", () => {
  expect(parseRuntimeCommand("send", {
    conversationId: "conv-one",
    text: "continue",
    images: ["image-one"],
    idempotencyKey: "send-one",
    policy: "steer-if-active",
  })).toEqual({
    kind: "send",
    conversationId: "conv-one",
    text: "continue",
    images: ["image-one"],
    idempotencyKey: "send-one",
    policy: "steer-if-active",
  });
  expect(parseRuntimeCommand("interrupt", {
    conversationId: "conv-one",
    operationId: "interrupt-one",
  })).toEqual({
    kind: "interrupt",
    conversationId: "conv-one",
    operationId: "interrupt-one",
    idempotencyKey: "interrupt-one",
  });
  expect(parseRuntimeCommand("answer", {
    conversationId: "conv-one",
    attentionId: "attention-one",
    resolution: { option: "allow" },
    operationId: "answer-one",
  })).toEqual({
    kind: "answer",
    conversationId: "conv-one",
    attentionId: "attention-one",
    resolution: { option: "allow" },
    operationId: "answer-one",
    idempotencyKey: "answer-one",
  });
});

test("runtime command parsing rejects malformed and oversized bodies", () => {
  expect(() => parseRuntimeCommand("send", { conversationId: "conv-one", text: "", idempotencyKey: "send-one" })).toThrow("text is required");
  expect(() => parseRuntimeCommand("interrupt", { conversationId: "conv one", operationId: "interrupt-one" })).toThrow("conversationId is invalid");
  expect(() => parseRuntimeCommand("interrupt", { conversationId: "conv-one", operationId: "interrupt-one", turnId: 42 })).toThrow("turnId is invalid");
  expect(() => parseRuntimeCommand("spawn", { conversationId: "conv-one", operationId: "spawn-one", engine: "codex", cwd: "/repo", prompt: "go", accountId: 42 })).toThrow("accountId is invalid");
  expect(() => parseRuntimeCommand("send", { conversationId: "conv-one", text: "x".repeat(256 * 1024), idempotencyKey: "send-one" })).toThrow("request body exceeds 256 KiB");
});
