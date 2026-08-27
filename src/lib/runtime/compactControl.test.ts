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

test("a compact command drops every field the engine could read as input or as a turn fence", () => {
  const parsed = parseRuntimeCommand("compact", {
    conversationId: "conversation_one",
    idempotencyKey: "compact-key",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
    turnId: "turn-seven",
    text: "/compact",
  }) as RuntimeCompactCommand;

  /* A compact control is not a message: nothing the caller supplies may reach
     the engine as user input. A turn fence is equally meaningless — admission
     only ever accepts an idle generation, so a named turn could only ever be a
     busy-turn rejection. */
  expect("text" in parsed).toBe(false);
  expect("images" in parsed).toBe(false);
  expect("turnId" in parsed).toBe(false);
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

test("compact capability is supported on both engines and truthful about confirmation", () => {
  /* Codex reports completion on its own channel, so the receipt terminalizes
     on the engine's evidence. */
  expect(runtimeCompactCapability("codex")).toEqual({
    control: "compact",
    engine: "codex",
    supported: true,
    confirmation: "observed",
  });
  /* Claude has no compact subtype in its transport, so its host types
     `/compact` into the conversation (#1214). The control is supported; what
     is qualified is the confirmation, never the engine's ability. */
  expect(runtimeCompactCapability("claude")).toEqual({
    control: "compact",
    engine: "claude",
    supported: true,
    confirmation: "best-effort",
  });
});

test("a host without a compact control is detected structurally", () => {
  const host = bareHost();
  expect(hostSupportsCompact(host)).toBe(false);
  expect(hostSupportsCompact(Object.assign(host, { compact: async () => ({ compactionId: null }) }))).toBe(true);
});

test("a compact failure states whether the engine outcome is known", () => {
  const refused = new StructuredCompactError("thread/compact/start failed", "refused");
  const unverified = new StructuredCompactError("evidence timed out", "unverified");
  expect(refused.phase).toBe("refused");
  expect(unverified.phase).toBe("unverified");
  expect(refused).toBeInstanceOf(Error);
});
