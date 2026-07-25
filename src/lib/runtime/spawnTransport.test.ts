import { describe, expect, test } from "bun:test";

import { structuredSpawnGap, spawnTransport } from "./spawnTransport";

describe("spawnTransport", () => {
  test("defaults to the pane-less transport once a runtime host is configured", () => {
    expect(spawnTransport({ LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBe("structured");
  });

  test("falls back to tmux where no runtime host can serve a structured spawn", () => {
    expect(spawnTransport({})).toBe("tmux");
    expect(spawnTransport({ LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock", LLV_STRUCTURED_HOSTS: "0" })).toBe("tmux");
    expect(spawnTransport({ LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock", LLV_RUNTIME_EVENTS: "0" })).toBe("tmux");
  });

  test("an explicit transport always wins over the capability default", () => {
    expect(spawnTransport({ LLV_SPAWN_TRANSPORT: "tmux", LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBe("tmux");
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
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: false, fast: null }, enabled)).toBeNull();
  });

  test("accepts a deployment that only declares its runtime socket", () => {
    expect(
      structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false, fast: null }, {
        LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
      }),
    ).toBeNull();
  });

  test.each([
    [{ ...enabled, LLV_STRUCTURED_HOSTS: "0" }, "LLV_STRUCTURED_HOSTS=0"],
    [{ ...enabled, LLV_RUNTIME_EVENTS: "0" }, "LLV_RUNTIME_EVENTS=0"],
    [{ ...enabled, LLV_RUNTIME_HOST_SOCKET: "" }, "runtime host socket"],
    [{ ...enabled, NEXT_PUBLIC_RUNTIME_UI: "0" }, "NEXT_PUBLIC_RUNTIME_UI=0"],
  ] as const)("names the explicit rollback that blocks the spawn", (env, gap) => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false, fast: null }, env)).toContain(gap);
  });

  test("negotiates Claude images and Codex image-capable models", () => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.3-codex-spark", hasImages: true, fast: null }, enabled))
      .toContain("does not advertise image input");
  });

  test("names Codex service-tier selection as an unsupported spawn feature", () => {
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: false, fast: true }, enabled)).toContain("Codex service tier");
  });
});
