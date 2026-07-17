import { expect, test } from "bun:test";

import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";

import { isHistoricalLaunchReceipt, LAUNCH_HISTORY_HORIZON_MS, launchHistoryFor } from "./launchHistoryModel";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function spawnState(overrides: Partial<StructuredSpawnCardState>): StructuredSpawnCardState {
  return {
    launchId: "86b16558-cf8b-4049-aff4-f7e2c4133366",
    clientAttemptId: null,
    accountId: "default",
    state: "failed",
    initialMessage: "failed",
    retrySafe: true,
    error: "structured spawn failed before host binding",
    ...overrides,
  };
}

function receipt(ageMs: number, overrides: Partial<FileEntry> = {}, spawn: Partial<StructuredSpawnCardState> = {}): FileEntry {
  return {
    path: `spawn:${spawn.launchId ?? "86b16558"}`,
    root: "claude-projects",
    name: "spawn:86b16558",
    project: "-agents-tools-live-log-viewer-next",
    title: "Claude",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: (NOW - ageMs) / 1000,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    pendingQuestion: null,
    waitingInput: null,
    spawn: spawnState(spawn),
    ...overrides,
  } as FileEntry;
}

test("a terminal receipt older than the horizon is launch history", () => {
  expect(isHistoricalLaunchReceipt(receipt(LAUNCH_HISTORY_HORIZON_MS), NOW)).toBe(true);
  expect(isHistoricalLaunchReceipt(receipt(2 * 24 * 3_600_000, {}, { state: "recovered", initialMessage: "delivered", error: null }), NOW)).toBe(true);
});

test("a fresh terminal receipt keeps its prominent card", () => {
  expect(isHistoricalLaunchReceipt(receipt(LAUNCH_HISTORY_HORIZON_MS - 60_000), NOW)).toBe(false);
});

test("a moving launch never parks as history regardless of age", () => {
  for (const state of ["starting", "binding", "queued"] as const) {
    expect(isHistoricalLaunchReceipt(receipt(3_600_000, {}, { state, error: null }), NOW)).toBe(false);
  }
});

test("an ordinary conversation entry is never launch history", () => {
  const conversation = receipt(3_600_000, { path: "/sessions/a.jsonl", spawn: undefined });
  expect(isHistoricalLaunchReceipt(conversation, NOW)).toBe(false);
});

test("launchHistoryFor scopes to the project and orders freshest first", () => {
  const files = [
    receipt(3_600_000, {}, { launchId: "aaaa" }),
    receipt(1_800_000, {}, { launchId: "bbbb" }),
    receipt(3_600_000, { project: "other" }, { launchId: "cccc" }),
    receipt(60_000, {}, { launchId: "dddd" }),
  ];
  const rows = launchHistoryFor(files, "-agents-tools-live-log-viewer-next", NOW);
  expect(rows.map((row) => row.spawn!.launchId)).toEqual(["bbbb", "aaaa"]);
});
