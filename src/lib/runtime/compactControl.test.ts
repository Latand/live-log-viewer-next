import { expect, test } from "bun:test";

import { parseRuntimeCommand } from "./commands";
import { runtimeCompactCapability, type RuntimeCompactCommand } from "./contracts";
import { hostSupportsCompact, StructuredCompactError, type EngineHost } from "./engineHost";

function bareHost(): EngineHost {
  return {
    attach: () => ({ async *[Symbol.asyncIterator]() {} }),
    send: async () => ({ outcome: "rejected", reason: "dead-host" }),
    interrupt: async () => {},
    answer: async () => {},
    health: async () => { throw new Error("unused"); },
    release: async () => {},
  };
}

test("the compact command parses into a durable operation fenced to one owned generation", () => {
  const command = parseRuntimeCommand("compact", {
    conversationId: "conversation_one",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  }) as RuntimeCompactCommand;

  expect(command).toEqual({
    kind: "compact",
    conversationId: "conversation_one",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
});

test("a compact command carries an optional turn fence and never carries prompt text", () => {
  const fenced = parseRuntimeCommand("compact", {
    conversationId: "conversation_one",
    idempotencyKey: "compact-key",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
    turnId: "turn-seven",
    text: "/compact",
  }) as RuntimeCompactCommand;

  expect(fenced.turnId).toBe("turn-seven");
  /* A compact control is not a message: nothing the caller supplies may reach
     the engine as user input. */
  expect("text" in fenced).toBe(false);
  expect("images" in fenced).toBe(false);
});

test("a compact command without an owned session key is refused", () => {
  expect(() => parseRuntimeCommand("compact", {
    conversationId: "conversation_one",
    idempotencyKey: "compact-key",
  })).toThrow("sessionKey is invalid");
  expect(() => parseRuntimeCommand("compact", {
    conversationId: "conversation_one",
    idempotencyKey: "compact-key",
    sessionKey: { engine: "gemini", sessionId: "thread-one" },
  })).toThrow("sessionKey is invalid");
});

test("compact capability is engine-specific and truthful", () => {
  expect(runtimeCompactCapability("codex")).toEqual({
    control: "compact",
    engine: "codex",
    supported: true,
  });
  const claude = runtimeCompactCapability("claude");
  expect(claude.supported).toBe(false);
  expect(claude.engine).toBe("claude");
  expect(claude.reason).toContain("compact");
});

test("a host without a compact control is detected structurally", () => {
  const host = bareHost();
  expect(hostSupportsCompact(host)).toBe(false);
  expect(hostSupportsCompact(Object.assign(host, { compact: async () => ({ compactionId: null }) }))).toBe(true);
});

test("a compact failure states whether the engine outcome is known", () => {
  const rejected = new StructuredCompactError("thread/compact/start failed", "request");
  const unverified = new StructuredCompactError("evidence timed out", "evidence");
  expect(rejected.phase).toBe("request");
  expect(unverified.phase).toBe("evidence");
  expect(rejected).toBeInstanceOf(Error);
});
