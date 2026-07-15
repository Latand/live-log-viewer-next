import { expect, test } from "bun:test";

import { parseRuntimeCommand } from "./commands";
import { structuredContentDigest, type StructuredImageRef } from "./structuredContent";

const IMAGE_REF: StructuredImageRef = {
  sha256: "a".repeat(64),
  mime: "image/png",
  bytes: 67,
};

test("dedicated runtime command parsers freeze the Opus request bodies", () => {
  expect(parseRuntimeCommand("send", {
    conversationId: "conv-one",
    text: "continue",
    images: [IMAGE_REF],
    idempotencyKey: "send-one",
    policy: "steer-if-active",
  })).toEqual({
    kind: "send",
    conversationId: "conv-one",
    text: "continue",
    images: [IMAGE_REF],
    contentDigest: structuredContentDigest({ text: "continue", images: [IMAGE_REF] }),
    idempotencyKey: "send-one",
    policy: "steer-if-active",
  });
  expect(parseRuntimeCommand("send", {
    conversationId: "conv-one",
    text: "replace the current turn",
    idempotencyKey: "send-two",
    policy: "interrupt-active",
  })).toMatchObject({ policy: "interrupt-active" });
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
  expect(parseRuntimeCommand("spawn", {
    conversationId: "conv-empty",
    operationId: "spawn-empty",
    engine: "codex",
    cwd: "/repo",
    prompt: "",
  })).toMatchObject({ kind: "spawn", cwd: "/repo", prompt: "" });
  expect(parseRuntimeCommand("kill", {
    conversationId: "conv-kill",
    operationId: "kill-one",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  })).toMatchObject({
    kind: "kill",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
});

test("runtime command parsing rejects malformed and oversized bodies", () => {
  expect(() => parseRuntimeCommand("send", { conversationId: "conv-one", text: "", idempotencyKey: "send-one" })).toThrow("message content is required");
  expect(() => parseRuntimeCommand("interrupt", { conversationId: "conv one", operationId: "interrupt-one" })).toThrow("conversationId is invalid");
  expect(() => parseRuntimeCommand("interrupt", { conversationId: "conv-one", operationId: "interrupt-one", turnId: 42 })).toThrow("turnId is invalid");
  expect(() => parseRuntimeCommand("spawn", { conversationId: "conv-one", operationId: "spawn-one", engine: "codex", cwd: "/repo", prompt: "go", accountId: 42 })).toThrow("accountId is invalid");
  expect(() => parseRuntimeCommand("spawn", { conversationId: "conv-one", operationId: "spawn-missing", engine: "codex", cwd: "/repo" })).toThrow("prompt is required");
  expect(() => parseRuntimeCommand("kill", { conversationId: "conv-one", operationId: "kill-missing" })).toThrow("sessionKey is invalid");
  expect(() => parseRuntimeCommand("send", { conversationId: "conv-one", text: "x".repeat(256 * 1024), idempotencyKey: "send-one" })).toThrow("request body exceeds 256 KiB");
});

test("runtime command parsing admits image-only content with a canonical digest", () => {
  const command = parseRuntimeCommand("send", {
    conversationId: "conv-images",
    text: "",
    images: [IMAGE_REF],
    idempotencyKey: "send-images",
  });

  expect(command).toEqual({
    kind: "send",
    conversationId: "conv-images",
    text: "",
    images: [IMAGE_REF],
    contentDigest: structuredContentDigest({ text: "", images: [IMAGE_REF] }),
    idempotencyKey: "send-images",
  });
  expect(() => parseRuntimeCommand("send", {
    conversationId: "conv-images",
    text: "same text",
    images: [{ ...IMAGE_REF, sha256: "../escape" }],
    idempotencyKey: "send-images-invalid",
  })).toThrow("images are invalid");
});
