import { expect, test } from "bun:test";

import { parseRuntimeCommand } from "./commands";
import { structuredContent } from "./structuredContent";

const base = { conversationId: "conversation-one", idempotencyKey: "key-one", text: "remember this" };

test("an injection parses into its own kind with a frozen payload digest", () => {
  const command = parseRuntimeCommand("inject", base);
  expect(command.kind).toBe("inject");
  expect(command).toMatchObject({
    conversationId: "conversation-one",
    idempotencyKey: "key-one",
    text: "remember this",
    contentDigest: structuredContent("remember this", []).contentDigest,
  });
  /* No policy is invented for it: there is no interrupt to choose. */
  expect("policy" in command).toBe(false);
});

test("an image payload is refused by name, before anything can act on it", () => {
  expect(() => parseRuntimeCommand("inject", {
    ...base,
    images: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 10 }],
  })).toThrow(/cannot carry images/i);
});

test("an empty image list is not an image payload", () => {
  expect(parseRuntimeCommand("inject", { ...base, images: [] }).kind).toBe("inject");
});

test("a delivery policy is refused rather than silently honoured", () => {
  for (const policy of ["queue", "steer-if-active", "interrupt-active"]) {
    expect(() => parseRuntimeCommand("inject", { ...base, policy })).toThrow(/does not take a delivery policy/i);
  }
});

test("empty text is refused", () => {
  expect(() => parseRuntimeCommand("inject", { ...base, text: "   " })).toThrow(/text is required/i);
});

test("the turn fence is carried verbatim, including an explicit idle fence", () => {
  expect(parseRuntimeCommand("inject", { ...base, turnId: null })).toMatchObject({ turnId: null });
  expect(parseRuntimeCommand("inject", { ...base, turnId: "turn-live" })).toMatchObject({ turnId: "turn-live" });
  expect("turnId" in parseRuntimeCommand("inject", base)).toBe(false);
});

test("authorship is never read off the request body", () => {
  /* #1117: the admitting surface stamps authorship server-side. An injection
     that could name its own origin would let a caller post as the operator. */
  const command = parseRuntimeCommand("inject", { ...base, origin: { kind: "operator" } });
  expect("origin" in command).toBe(false);
});
