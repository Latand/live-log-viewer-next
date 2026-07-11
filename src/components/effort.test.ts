import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { effortMeter } from "./utils";

function entry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/x.jsonl",
    root: "codex-sessions",
    name: "x.jsonl",
    project: "demo",
    title: "x",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: "gpt-5.6-sol",
    effort: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

describe("effortMeter", () => {
  test("reads the entry's engine and model, so claude low is one bar of five", () => {
    const meter = effortMeter(entry({ root: "claude-projects", engine: "claude", fmt: "claude", model: "fable-5", effort: "low" }));
    expect(meter).toEqual({ level: 1, slots: 5 });
  });

  test("codex tiers position within the model's own scale", () => {
    expect(effortMeter(entry({ model: "gpt-5.6-sol", effort: "xhigh" }))).toEqual({ level: 4, slots: 6 });
    expect(effortMeter(entry({ model: "gpt-5.5", effort: "xhigh" }))).toEqual({ level: 4, slots: 4 });
  });

  test("returns level 0 for unknown, empty, or absent effort so the indicator hides", () => {
    expect(effortMeter(entry({ effort: null })).level).toBe(0);
    expect(effortMeter(entry({ effort: undefined })).level).toBe(0);
    expect(effortMeter(entry({ effort: "" })).level).toBe(0);
    expect(effortMeter(entry({ effort: "bogus" })).level).toBe(0);
  });
});
