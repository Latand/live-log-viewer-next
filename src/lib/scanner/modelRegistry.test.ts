import { describe, expect, test } from "bun:test";

import { MODEL_REGISTRY_VERSION, normalizeModelKey, registryWindow, resolveRegistryKey } from "./modelRegistry";

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
    expect(MODEL_REGISTRY_VERSION).toBe("2026-09-01");
    expect(registryWindow("fable-5", "standard")).toBe(1_000_000);
    expect(registryWindow("opus-4-8", "standard")).toBe(1_000_000);
    expect(registryWindow("sonnet-4-5", "standard")).toBe(200_000);
    expect(registryWindow("sonnet-4-5", "1m")).toBe(1_000_000);
    expect(registryWindow("haiku-4-5", "standard")).toBe(200_000);
  });

  test("Fable 5.1 is known, and the launch alias resolves to it", () => {
    /* Claude Code resolves the `fable` launch alias to claude-fable-5-1, so a
       session reports that exact id. Without its own entry the window would
       read as unknown, and the alias would keep pointing at the superseded
       Fable 5 entry. Fable 5 stays registered — it is still selectable and
       still what the gateway provider resolves `fable` to. */
    expect(registryWindow("fable-5-1", "standard")).toBe(1_000_000);
    expect(normalizeModelKey("claude-fable-5-1")).toEqual({ key: "fable-5-1", mode: "standard" });
    expect(resolveRegistryKey("fable")).toBe("fable-5-1");
    expect(registryWindow("fable-5", "standard")).toBe(1_000_000);
  });
});
