import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { filesEvidence } from "./legacyScheduler";

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/example.jsonl",
    root: "claude-projects",
    name: "example.jsonl",
    project: "example",
    title: "Example",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 10,
    activity: "recent",
    activityReason: "jsonl_turn_completed",
    authoritativeTurn: { state: "busy", source: "assistant", terminalAt: null },
    proc: "running",
    pid: 321,
    model: "fable",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

test("structured host termination changes files evidence without a transcript write", () => {
  const running = entry();
  const terminal = entry({
    proc: "killed",
    pid: null,
    activityReason: "registry_terminal",
    authoritativeTurn: {
      state: "terminal",
      source: "lifecycle",
      terminalAt: "2026-07-17T21:51:01.625Z",
    },
  });

  expect(terminal.mtime).toBe(running.mtime);
  expect(terminal.size).toBe(running.size);
  expect(terminal.activity).toBe(running.activity);
  expect(filesEvidence([terminal])).not.toBe(filesEvidence([running]));
});

test("identical file projections keep stable files evidence", () => {
  expect(filesEvidence([entry()])).toBe(filesEvidence([entry()]));
});
