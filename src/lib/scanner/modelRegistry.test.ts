import { describe, expect, test } from "bun:test";

import { MODEL_REGISTRY_VERSION, normalizeModelKey, registryWindow } from "./modelRegistry";

describe("normalizeModelKey", () => {
  test("normalizes exact API, Bedrock, Vertex, dated, and 1M aliases", () => {
    expect(normalizeModelKey(" claude-opus-4-8 ")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("us.anthropic.claude-opus-4-8-v1:0")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("claude-opus-4-8@20251101")).toEqual({ key: "opus-4-8", mode: "standard" });
    expect(normalizeModelKey("claude-sonnet-4-5-20250929[1m]")).toEqual({ key: "sonnet-4-5", mode: "1m" });
  });

  test("keeps future versions exact so they miss the registry", () => {
    expect(normalizeModelKey("claude-opus-4-9")).toEqual({ key: "opus-4-9", mode: "standard" });
    expect(registryWindow("opus-4-9", "standard")).toBeNull();
    expect(registryWindow("sonnet-4-9", "standard")).toBeNull();
  });
});

describe("registryWindow", () => {
  test("contains the frozen documented registry seed", () => {
    expect(MODEL_REGISTRY_VERSION).toBe("2026-07-10");
    expect(registryWindow("fable-5", "standard")).toBe(1_000_000);
    expect(registryWindow("opus-4-8", "standard")).toBe(1_000_000);
    expect(registryWindow("sonnet-4-5", "standard")).toBe(200_000);
    expect(registryWindow("sonnet-4-5", "1m")).toBe(1_000_000);
    expect(registryWindow("haiku-4-5", "standard")).toBe(200_000);
  });
});
