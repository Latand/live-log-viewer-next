import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  buildSubagentTrays,
  classifyEngineChild,
  currentGenerationChildrenOf,
  engineChildNeedsAttention,
  rollUpState,
  type SubagentTrayInput,
} from "./subagentTray";

function entry(overrides: Partial<FileEntry> & { path: string; conversationId: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.name ?? overrides.path,
    project: "viewer",
    title: overrides.title ?? overrides.conversationId,
    engine: overrides.engine ?? "codex",
    kind: "session",
    fmt: "codex",
    parent: overrides.parent ?? null,
    mtime: overrides.mtime ?? 1,
    size: 1,
    activity: overrides.activity ?? "recent",
    proc: overrides.proc ?? null,
    pid: null,
    model: overrides.model ?? null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
    path: overrides.path,
    conversationId: overrides.conversationId,
  };
}

/** An engine-native child of `parent` with sensible engine defaults. */
function child(overrides: Partial<FileEntry> & { path: string; conversationId: string; parentId: string }): FileEntry {
  const { parentId, ...rest } = overrides;
  return entry({
    ...rest,
    spawnOrigin: "engine",
    durableLineage: {
      kind: "spawn",
      role: null,
      parentConversationId: parentId,
      reviewsConversationId: null,
      memberships: [],
    },
  });
}

function baseInput(entries: FileEntry[], hostParentIds: string[], overrides: Partial<SubagentTrayInput> = {}): SubagentTrayInput {
  return {
    entries,
    foldedEngineChildIds: new Set(),
    expandedTrayParentIds: new Set(),
    pinnedPaths: new Set(),
    hiddenPaths: new Set(),
    claimedPaths: new Set(),
    hostEligibleParentIds: new Set(hostParentIds),
    now: 1_000_000,
    ...overrides,
  };
}

// ── shared current-generation selector ──────────────────────────────────────

test("currentGenerationChildrenOf keeps the newest generation and drops archived predecessors", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const stale = entry({ path: "/c-gen1", conversationId: "c", parent: parent.path, generation: 1, mtime: 5 });
  const current = entry({ path: "/c-gen2", conversationId: "c", parent: parent.path, generation: 2, mtime: 6 });
  const archived = entry({ path: "/c-old", conversationId: "c", parent: parent.path, generation: 3, migratedTo: "/c-gen2" });
  const rows = currentGenerationChildrenOf("parent", [parent, stale, current, archived]);
  expect(rows.map((row) => row.path)).toEqual(["/c-gen2"]);
});

test("currentGenerationChildrenOf honours the provenance filter", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const viewerKid = entry({ path: "/viewer", conversationId: "viewer", parent: parent.path, spawnOrigin: "viewer" });
  const engineKid = child({ path: "/engine", conversationId: "engine", parentId: "parent", parent: parent.path });
  const rows = currentGenerationChildrenOf("parent", [parent, viewerKid, engineKid], (file) => file.spawnOrigin === "engine");
  expect(rows.map((row) => row.path)).toEqual(["/engine"]);
});

// ── roll-up ─────────────────────────────────────────────────────────────────

test("rollUpState returns the hottest state", () => {
  expect(rollUpState(["closed", "running", "dead"])).toBe("running");
  expect(rollUpState(["closed", "dead"])).toBe("closed");
  expect(rollUpState([])).toBe("dead");
});

// ── attention detection ─────────────────────────────────────────────────────

test("engineChildNeedsAttention fires on question, spawn failure and killed host", () => {
  const now = 1_000;
  expect(engineChildNeedsAttention(entry({ path: "/q", conversationId: "q", pendingQuestion: { toolUseId: "t", prompt: "?" } as never }), now)).toBe(true);
  expect(engineChildNeedsAttention(entry({ path: "/k", conversationId: "k", proc: "killed" }), now)).toBe(true);
  expect(engineChildNeedsAttention(entry({ path: "/ok", conversationId: "ok", activity: "idle" }), now)).toBe(false);
});

// ── precedence matrix (§1.2 / presence policy) ──────────────────────────────

const ctx = { folded: false, pinned: false, now: 1_000_000 };

test("attention promotes ahead of an explicit fold", () => {
  const c = entry({ path: "/a", conversationId: "a", pendingQuestion: { toolUseId: "t", prompt: "?" } as never });
  expect(classifyEngineChild(c, { ...ctx, folded: true })).toEqual({ presence: "promoted", reason: "attention" });
});

test("an explicit hand-fold folds a live child, overriding busy activity", () => {
  const c = entry({ path: "/a", conversationId: "a", activity: "live", proc: "running" });
  expect(classifyEngineChild(c, { ...ctx, folded: true })).toEqual({ presence: "folded", reason: "hand-fold" });
});

test("owner-authored and pinned children stay promoted during automatic classification", () => {
  const authored = entry({ path: "/a", conversationId: "a", activity: "idle", userAuthored: true });
  expect(classifyEngineChild(authored, ctx)).toEqual({ presence: "promoted", reason: "owner" });
  const unverified = entry({ path: "/b", conversationId: "b", activity: "idle", authorshipUnverified: true });
  expect(classifyEngineChild(unverified, ctx)).toEqual({ presence: "promoted", reason: "owner" });
  const quiet = entry({ path: "/c", conversationId: "c", activity: "idle" });
  expect(classifyEngineChild(quiet, { ...ctx, pinned: true })).toEqual({ presence: "promoted", reason: "owner" });
});

test("authoritative busy work stays promoted", () => {
  const c = entry({ path: "/a", conversationId: "a", activity: "recent", authoritativeTurn: { state: "busy", source: "assistant", terminalAt: null } });
  expect(classifyEngineChild(c, ctx)).toEqual({ presence: "promoted", reason: "busy" });
});

test("authoritative terminal or idle folds immediately regardless of transcript age", () => {
  const terminal = entry({ path: "/a", conversationId: "a", activity: "recent", authoritativeTurn: { state: "terminal", source: "lifecycle", terminalAt: "2026-07-20T00:00:00Z" } });
  expect(classifyEngineChild(terminal, ctx)).toEqual({ presence: "folded", reason: "quiet" });
  const idle = entry({ path: "/b", conversationId: "b", activity: "idle" });
  expect(classifyEngineChild(idle, ctx)).toEqual({ presence: "folded", reason: "quiet" });
});

test("conflicting or incomplete evidence stays fail-visible", () => {
  const c = entry({ path: "/a", conversationId: "a", activity: "recent" });
  expect(classifyEngineChild(c, ctx)).toEqual({ presence: "promoted", reason: "fail-visible" });
});

// ── projection ──────────────────────────────────────────────────────────────

test("buildSubagentTrays folds quiet engine children and promotes working ones under one parent", () => {
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const working = child({ path: "/work", conversationId: "work", parentId: "parent", parent: parent.path, activity: "live", proc: "running" });
  const quiet = child({ path: "/quiet", conversationId: "quiet", parentId: "parent", parent: parent.path, activity: "idle", proc: "done" });
  const projection = buildSubagentTrays(baseInput([parent, working, quiet], ["parent"]));

  expect(projection.promotedPaths).toEqual(new Set(["/work"]));
  expect(projection.foldedPaths).toEqual(new Set(["/quiet"]));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.count).toBe(1);
  expect(tray.members[0]!.id).toBe("quiet");
  expect(tray.hottest).toBe("closed");
  expect(tray.expanded).toBe(false);
});

test("buildSubagentTrays keeps a child visible when its parent cannot host a tray", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const quiet = child({ path: "/quiet", conversationId: "quiet", parentId: "parent", parent: parent.path, activity: "idle" });
  const projection = buildSubagentTrays(baseInput([parent, quiet], /* no eligible host */ []));
  expect(projection.promotedPaths).toEqual(new Set(["/quiet"]));
  expect(projection.foldedPaths.size).toBe(0);
  expect(projection.traysByParent.size).toBe(0);
});

test("buildSubagentTrays leaves viewer, hidden and claimed children to their own surfaces", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const viewerKid = entry({ path: "/viewer", conversationId: "viewer", parent: parent.path, spawnOrigin: "viewer", activity: "idle" });
  const hidden = child({ path: "/hidden", conversationId: "hidden", parentId: "parent", parent: parent.path, activity: "idle" });
  const claimed = child({ path: "/claimed", conversationId: "claimed", parentId: "parent", parent: parent.path, activity: "idle" });
  const projection = buildSubagentTrays(baseInput([parent, viewerKid, hidden, claimed], ["parent"], {
    hiddenPaths: new Set(["/hidden"]),
    claimedPaths: new Set(["/claimed"]),
  }));
  expect(projection.promotedPaths.size).toBe(0);
  expect(projection.foldedPaths.size).toBe(0);
});

test("buildSubagentTrays reflects the durable fold pin and tray-disclosure intent", () => {
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const live = child({ path: "/live", conversationId: "live", parentId: "parent", parent: parent.path, activity: "live", proc: "running" });
  const projection = buildSubagentTrays(baseInput([parent, live], ["parent"], {
    foldedEngineChildIds: new Set(["live"]),
    expandedTrayParentIds: new Set(["parent"]),
  }));
  expect(projection.foldedPaths).toEqual(new Set(["/live"]));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.hottest).toBe("running");
  expect(tray.expanded).toBe(true);
});

test("buildSubagentTrays orders tray members hottest first", () => {
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const doneOld = child({ path: "/done", conversationId: "done", parentId: "parent", parent: parent.path, activity: "idle", proc: "done", sessionStartedAt: "2026-07-19T08:00:00Z" });
  const liveFolded = child({ path: "/livef", conversationId: "livef", parentId: "parent", parent: parent.path, activity: "live", proc: "running", sessionStartedAt: "2026-07-19T09:00:00Z" });
  const projection = buildSubagentTrays(baseInput([parent, doneOld, liveFolded], ["parent"], {
    foldedEngineChildIds: new Set(["done", "livef"]),
  }));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.members.map((member) => member.id)).toEqual(["livef", "done"]);
});
