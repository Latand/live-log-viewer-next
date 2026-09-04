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

  /* Every documented rollback must land on a transport that can actually spawn.
     The UI switch used to be excluded from the default while still failing the
     gap, so reaching for it turned every spawn — tmux included — into a 409. */
  test("each rollback switch sends the implicit choice back to a transport that can spawn", () => {
    const host = { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" };
    expect(spawnTransport({ ...host, NEXT_PUBLIC_RUNTIME_UI: "0" })).toBe("tmux");
    expect(spawnTransport({ ...host, LLV_STRUCTURED_HOSTS: "0" })).toBe("tmux");
    expect(spawnTransport({ ...host, LLV_RUNTIME_EVENTS: "0" })).toBe("tmux");
    for (const env of [
      { ...host, NEXT_PUBLIC_RUNTIME_UI: "0" },
      { ...host, LLV_STRUCTURED_HOSTS: "0" },
      { ...host, LLV_RUNTIME_EVENTS: "0" },
    ]) {
      const transport = spawnTransport(env);
      const gap = structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false, fast: null }, env);
      expect(transport === "tmux" || gap === null).toBeTrue();
    }
  });

  /* A rollback an operator can actually type: env files keep the padding and
     the quotes, and a switch that no-ops on those is worse than none. */
  test.each([
    ["0"],
    [" 0 "],
    ["\"0\""],
    ["'0'"],
    ["false"],
    ["OFF"],
    ["no"],
  ] as const)("a malformed rollback value still rolls the transport back (%p)", (value) => {
    const host = { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" };
    expect(spawnTransport({ ...host, LLV_STRUCTURED_HOSTS: value })).toBe("tmux");
    expect(spawnTransport({ ...host, LLV_RUNTIME_EVENTS: value })).toBe("tmux");
    expect(spawnTransport({ ...host, NEXT_PUBLIC_RUNTIME_UI: value })).toBe("tmux");
  });

  test.each([[undefined], [""], ["1"]] as const)("an absent or affirmative value keeps the default on (%p)", (value) => {
    const env = value === undefined
      ? { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" }
      : { LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock", LLV_STRUCTURED_HOSTS: value, LLV_RUNTIME_EVENTS: value, NEXT_PUBLIC_RUNTIME_UI: value };
    expect(spawnTransport(env)).toBe("structured");
  });

  test("an explicit transport always wins over the capability default", () => {
    expect(spawnTransport({ LLV_SPAWN_TRANSPORT: "tmux", LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBe("tmux");
    expect(spawnTransport({ LLV_SPAWN_TRANSPORT: "structured" })).toBe("structured");
    // An explicitly requested structured spawn is never downgraded — it keeps
    // failing with the gap that names the switch standing in its way.
    expect(spawnTransport({
      LLV_SPAWN_TRANSPORT: "structured",
      LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
      NEXT_PUBLIC_RUNTIME_UI: "0",
    })).toBe("structured");
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false, fast: null }, {
      LLV_SPAWN_TRANSPORT: "structured",
      LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock",
      NEXT_PUBLIC_RUNTIME_UI: "0",
    })).toContain("NEXT_PUBLIC_RUNTIME_UI=0");
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
    [{ ...enabled, LLV_STRUCTURED_HOSTS: " 0 " }, "LLV_STRUCTURED_HOSTS=0"],
    [{ ...enabled, LLV_RUNTIME_EVENTS: "false" }, "LLV_RUNTIME_EVENTS=0"],
    [{ ...enabled, NEXT_PUBLIC_RUNTIME_UI: "'0'" }, "NEXT_PUBLIC_RUNTIME_UI=0"],
  ] as const)("names the explicit rollback that blocks the spawn", (env, gap) => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: false, fast: null }, env)).toContain(gap);
  });

  test("negotiates Claude images and Codex image-capable models", () => {
    expect(structuredSpawnGap({ engine: "claude", model: "fable", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-6-astra", hasImages: true, fast: null }, enabled)).toBeNull();
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.3-codex-spark", hasImages: true, fast: null }, enabled))
      .toContain("does not advertise image input");
  });

  test("names Codex service-tier selection as an unsupported spawn feature", () => {
    expect(structuredSpawnGap({ engine: "codex", model: "gpt-5.6-sol", hasImages: false, fast: true }, enabled)).toContain("Codex service tier");
  });
});
