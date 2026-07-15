import { describe, expect, test } from "bun:test";

import { structuredSpawnGap, spawnTransport } from "./spawnTransport";

describe("spawnTransport", () => {
  test("keeps tmux as the default", () => {
    expect(spawnTransport({})).toBe("tmux");
  });

  test("selects structured transport explicitly", () => {
    expect(spawnTransport({ LLV_SPAWN_TRANSPORT: "structured" })).toBe("structured");
  });

  test("rejects unknown transport values", () => {
    expect(() => spawnTransport({ LLV_SPAWN_TRANSPORT: "screen" })).toThrow(
      "LLV_SPAWN_TRANSPORT must be tmux or structured",
    );
  });
});

describe("structuredSpawnGap", () => {
  const enabled = {
    LLV_SPAWN_TRANSPORT: "structured",
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  };

  test("accepts the supported pane-less shape", () => {
    expect(structuredSpawnGap({ engine: "codex", hasImages: false, fast: null }, enabled)).toBeNull();
  });

  test.each([
    [{ ...enabled, LLV_STRUCTURED_HOSTS: "0" }, "LLV_STRUCTURED_HOSTS=1"],
    [{ ...enabled, LLV_RUNTIME_EVENTS: "0" }, "LLV_RUNTIME_EVENTS=1"],
    [{ ...enabled, LLV_RUNTIME_HOST_SOCKET: "" }, "LLV_RUNTIME_HOST_SOCKET"],
    [{ ...enabled, NEXT_PUBLIC_RUNTIME_UI: "0" }, "NEXT_PUBLIC_RUNTIME_UI=1"],
  ] as const)("names missing runtime capability", (env, gap) => {
    expect(structuredSpawnGap({ engine: "claude", hasImages: false, fast: null }, env)).toContain(gap);
  });

  test("negotiates Claude images and keeps Codex gated for vertical two", () => {
    expect(structuredSpawnGap({ engine: "claude", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", hasImages: true, fast: null }, enabled)).toContain("vertical 2");
  });

  test("names Codex service-tier selection as an unsupported spawn feature", () => {
    expect(structuredSpawnGap({ engine: "codex", hasImages: false, fast: true }, enabled)).toContain("Codex service tier");
  });
});
