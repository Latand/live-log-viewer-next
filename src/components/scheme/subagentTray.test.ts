import { expect, test } from "bun:test";

import { epochSeconds, type FileEntry } from "@/lib/types";

import {
  badgeState,
  buildSubagentTrays,
  classifyEngineChild,
  currentGenerationChildrenOf,
  engineChildNeedsAttention,
  rollUpState,
  SILENT_AFTER_SECONDS,
  transcriptSilence,
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
    now: epochSeconds(NOW),
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

// ── chip activity from transcript freshness (issue #669) ────────────────────

const NOW = 1_000_000;
/** A transcript record written `seconds` ago. */
const wrote = (seconds: number) => NOW - seconds;

test("badgeState reads a writing transcript as working however stale the snapshot verdict is", () => {
  /* The false-finished half of #669: the scan's own activity verdict has gone
     idle while the lane keeps appending records every few seconds. */
  const busy = entry({ path: "/a", conversationId: "a", proc: "running", activity: "idle", mtime: wrote(2) });
  expect(badgeState(busy, NOW)).toBe("running");
  const unmapped = entry({ path: "/b", conversationId: "b", proc: null, activity: "idle", mtime: wrote(13) });
  expect(badgeState(unmapped, NOW)).toBe("live");
});

test("badgeState keeps a thinking agent working right up to the silence threshold", () => {
  const thinking = (seconds: number) =>
    badgeState(entry({ path: "/a", conversationId: "a", proc: "running", activity: "live", mtime: wrote(seconds) }), NOW);
  expect(thinking(0)).toBe("running");
  expect(thinking(120)).toBe("running");
  expect(thinking(SILENT_AFTER_SECONDS - 1)).toBe("running");
  expect(thinking(SILENT_AFTER_SECONDS)).toBe("silent");
});

test("badgeState gives an alive-but-silent host its own state instead of working or finished", () => {
  /* The false-active half of #669: a closed pipeline's host never exits and
     never writes again. Its process is alive, so it is not finished either. */
  const wedged = entry({ path: "/a", conversationId: "a", proc: "running", activity: "stalled", mtime: wrote(7.5 * 3600) });
  expect(badgeState(wedged, NOW)).toBe("silent");
  const starting = entry({
    path: "/b",
    conversationId: "b",
    proc: null,
    mtime: wrote(7.5 * 3600),
    spawn: { launchId: "l", clientAttemptId: null, accountId: null, state: "binding", initialMessage: "pending", retrySafe: true, error: null },
  });
  expect(badgeState(starting, NOW)).toBe("silent");
});

test("badgeState closes a returned subagent whose turn ended, without waiting out the silence window", () => {
  /* A Claude in-harness child owns no process: freshness alone would keep its
     final answer pulsing for minutes. The turn's shape settles it — and being
     shape, not age, a stale snapshot cannot flip a busy turn to finished. */
  const returned = entry({
    path: "/a",
    conversationId: "a",
    proc: null,
    activity: "recent",
    mtime: wrote(4),
    authoritativeTurn: { state: "terminal", source: "assistant", terminalAt: "2026-07-25T00:00:00Z" },
  });
  expect(badgeState(returned, NOW)).toBe("closed");
  const stillOwned = entry({
    path: "/b",
    conversationId: "b",
    proc: "running",
    activity: "idle",
    mtime: wrote(4),
    authoritativeTurn: { state: "terminal", source: "assistant", terminalAt: "2026-07-25T00:00:00Z" },
  });
  expect(badgeState(stillOwned, NOW)).toBe("running");
});

test("badgeState keeps a busy in-harness subagent alive through a long tool call", () => {
  /* A Claude in-harness subagent is written by its PARENT's process and never
     owns a pid — the scanner's isTopLevelTranscript skips both `agent-`
     basenames and the subagents directory — so process evidence is absent for
     its whole life, and it writes nothing while a tool call runs. A six-minute
     test run must read silent, never finished. */
  const toolCall = (seconds: number) =>
    badgeState(entry({
      path: "/proj/parent/subagents/agent-abc.jsonl",
      conversationId: "a",
      engine: "claude",
      proc: null,
      activity: "stalled",
      mtime: wrote(seconds),
      authoritativeTurn: { state: "busy", source: "assistant", terminalAt: null },
    }), NOW);
  expect(toolCall(240)).toBe("live");
  expect(toolCall(600)).toBe("silent");
  /* Hours of silence stay silent: an open turn is evidence of a live owner,
     never a reason to claim work is still happening. */
  expect(toolCall(7.5 * 3600)).toBe("silent");
});

test("badgeState tells a finished agent from a wedged one while both keep a host attached", () => {
  /* An attached host is how a worker waits for follow-ups, so liveness cannot
     be what separates these two — the turn is. Side by side, an hour silent,
     same process state. */
  const finished = entry({
    path: "/a",
    conversationId: "a",
    proc: "running",
    mtime: wrote(3_600),
    authoritativeTurn: { state: "terminal", source: "assistant", terminalAt: "2026-07-25T00:00:00Z" },
  });
  const wedged = entry({
    path: "/b",
    conversationId: "b",
    proc: "running",
    mtime: wrote(3_600),
    authoritativeTurn: { state: "busy", source: "assistant", terminalAt: null },
  });
  expect(badgeState(finished, NOW)).toBe("closed");
  expect(badgeState(wedged, NOW)).toBe("silent");

  /* The scanner's completion reason carries the same shape for an entry whose
     authoritative projection did not complete — and it is fixed before any
     clock is consulted, so this stays a shape test, not an age test. */
  const scannerSaysCompleted = entry({
    path: "/c",
    conversationId: "c",
    proc: "running",
    mtime: wrote(3_600),
    activity: "recent",
    activityReason: "jsonl_turn_completed",
  });
  const scannerSaysStalled = entry({
    path: "/d",
    conversationId: "d",
    proc: "running",
    mtime: wrote(3_600),
    activity: "stalled",
    activityReason: "jsonl_turn_stalled",
  });
  expect(badgeState(scannerSaysCompleted, NOW)).toBe("closed");
  expect(badgeState(scannerSaysStalled, NOW)).toBe("silent");

  /* A clean turn still keeps its chip working while the transcript is fresh:
     completion is what silence MEANS here, not a state of its own. */
  expect(badgeState({ ...finished, mtime: wrote(4) }, NOW)).toBe("running");
});

test("a tray of finished children with attached hosts rolls up closed, not silent", () => {
  const now = epochSeconds(NOW);
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const done = (id: string) => child({
    path: `/${id}`,
    conversationId: id,
    parentId: "parent",
    parent: parent.path,
    proc: "running",
    mtime: wrote(3_600),
    authoritativeTurn: { state: "terminal", source: "assistant", terminalAt: "2026-07-25T00:00:00Z" },
  });
  const projection = buildSubagentTrays(baseInput([parent, done("one"), done("two")], ["parent"], {
    foldedEngineChildIds: new Set(["one", "two"]),
    now,
  }));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.members.map((member) => member.state)).toEqual(["closed", "closed"]);
  expect(tray.hottest).toBe("closed");
});

test("badgeState closes a silent transcript with nothing alive behind it, and an exit wins over freshness", () => {
  const abandoned = entry({ path: "/a", conversationId: "a", proc: null, activity: "recent", mtime: wrote(SILENT_AFTER_SECONDS) });
  expect(badgeState(abandoned, NOW)).toBe("closed");
  const justExited = entry({ path: "/b", conversationId: "b", proc: "done", activity: "live", mtime: wrote(2) });
  expect(badgeState(justExited, NOW)).toBe("closed");
  const killed = entry({ path: "/c", conversationId: "c", proc: "killed", activity: "live", mtime: wrote(2) });
  expect(badgeState(killed, NOW)).toBe("closed");
});

test("badgeState keeps spawn placeholders and failed launches unavailable", () => {
  const placeholder = entry({ path: "spawn:launch-1", conversationId: "a", proc: "running", mtime: wrote(1) });
  expect(badgeState(placeholder, NOW)).toBe("dead");
  const failed = entry({
    path: "/b",
    conversationId: "b",
    mtime: wrote(1),
    spawn: { launchId: "l", clientAttemptId: null, accountId: null, state: "failed", initialMessage: "failed", retrySafe: false, error: "no host" },
  });
  expect(badgeState(failed, NOW)).toBe("dead");
});

test("badgeState leaves every chip undemoted while the client has no clock yet", () => {
  /* The server render and the first client render pass 0 (no hydration skew):
     an unknown age is not evidence of silence. */
  const wedged = entry({ path: "/a", conversationId: "a", proc: "running", mtime: wrote(7.5 * 3600) });
  expect(badgeState(wedged, 0)).toBe("running");
  expect(transcriptSilence(wedged, 0)).toBeNull();
  expect(transcriptSilence(wedged, NOW)).toBe(7.5 * 3600);
});

// ── roll-up ─────────────────────────────────────────────────────────────────

test("rollUpState returns the hottest state", () => {
  expect(rollUpState(["closed", "running", "dead"])).toBe("running");
  expect(rollUpState(["closed", "dead"])).toBe("closed");
  expect(rollUpState([])).toBe("dead");
});

test("rollUpState ranks a silent-but-alive member above a closed one", () => {
  expect(rollUpState(["closed", "silent", "dead"])).toBe("silent");
  expect(rollUpState(["silent", "running"])).toBe("running");
});

// ── attention detection ─────────────────────────────────────────────────────

test("engineChildNeedsAttention fires on question, spawn failure and killed host", () => {
  const now = 1_000;
  expect(engineChildNeedsAttention(entry({ path: "/q", conversationId: "q", pendingQuestion: { toolUseId: "t", prompt: "?" } as never }), now)).toBe(true);
  expect(engineChildNeedsAttention(entry({ path: "/k", conversationId: "k", proc: "killed" }), now)).toBe(true);
  expect(engineChildNeedsAttention(entry({ path: "/ok", conversationId: "ok", activity: "idle" }), now)).toBe(false);
});

// ── precedence matrix (§1.2 / presence policy) ──────────────────────────────

const ctx = { folded: false, pinned: false, now: epochSeconds(NOW) };

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
  const quiet = child({ path: "/quiet", conversationId: "quiet", parentId: "parent", parent: parent.path, activity: "idle", mtime: NOW - 3_600 });
  const projection = buildSubagentTrays(baseInput([parent, quiet], /* no eligible host */ []));
  expect(projection.promotedPaths).toEqual(new Set(["/quiet"]));
  expect(projection.foldedPaths.size).toBe(0);
  expect(projection.traysByParent.size).toBe(0);
});

// ── automatic-placement age horizon ─────────────────────────────────────────

test("an aged child folds instead of holding a full node on never-expiring evidence", () => {
  /* A failed spawn and incomplete evidence promote at any age by rule; past the
     horizon that promotion is exactly what fills the map with weeks-old cards. */
  const failedSpawn = entry({
    path: "/a",
    conversationId: "a",
    activity: "stalled",
    mtime: NOW - 100 * 3_600,
    spawn: { launchId: "l", clientAttemptId: null, accountId: null, state: "failed", initialMessage: "failed", retrySafe: true, error: "boom" },
  });
  expect(classifyEngineChild(failedSpawn, ctx)).toEqual({ presence: "folded", reason: "aged" });
  const incomplete = entry({ path: "/b", conversationId: "b", activity: "stalled", mtime: NOW - 100 * 3_600 });
  expect(classifyEngineChild(incomplete, ctx)).toEqual({ presence: "folded", reason: "aged" });
  // Inside the horizon both still promote.
  expect(classifyEngineChild({ ...incomplete, mtime: NOW - 3_600 }, ctx)).toEqual({ presence: "promoted", reason: "fail-visible" });
});

test("age never folds live, running, owned or pinned children", () => {
  const ancient = { activity: "idle" as const, mtime: NOW - 100 * 3_600 };
  const live = entry({ path: "/a", conversationId: "a", ...ancient, activity: "live" });
  expect(classifyEngineChild(live, ctx)).toEqual({ presence: "promoted", reason: "busy" });
  const running = entry({ path: "/b", conversationId: "b", ...ancient, proc: "running" });
  expect(classifyEngineChild(running, ctx)).toEqual({ presence: "promoted", reason: "busy" });
  const owned = entry({ path: "/c", conversationId: "c", ...ancient, userAuthored: true });
  expect(classifyEngineChild(owned, ctx)).toEqual({ presence: "promoted", reason: "owner" });
  const pinned = entry({ path: "/d", conversationId: "d", ...ancient, proc: "killed" });
  expect(classifyEngineChild(pinned, { ...ctx, pinned: true })).toEqual({ presence: "promoted", reason: "owner" });
});

test("without a clock the age rule bounds nothing", () => {
  const killed = entry({ path: "/a", conversationId: "a", activity: "stalled", proc: "killed", mtime: 1 });
  expect(classifyEngineChild(killed, { ...ctx, now: epochSeconds(0) })).toEqual({ presence: "promoted", reason: "attention" });
});

test("an aged child whose parent cannot host a tray claims no board surface", () => {
  const parent = entry({ path: "/parent", conversationId: "parent" });
  const aged = child({ path: "/aged", conversationId: "aged", parentId: "parent", parent: parent.path, activity: "idle", proc: "killed", mtime: NOW - 100 * 3_600 });
  const projection = buildSubagentTrays(baseInput([parent, aged], /* no eligible host */ []));
  // No host card means no tray to fold into, so the projection claims nothing
  // and the board's own age rule decides — it stays in «All conversations».
  expect(projection.promotedPaths.size).toBe(0);
  expect(projection.foldedPaths.size).toBe(0);
  // A pin is owner intent: it survives at any age.
  const pinned = buildSubagentTrays(baseInput([parent, aged], [], { pinnedPaths: new Set(["/aged"]) }));
  expect(pinned.promotedPaths).toEqual(new Set(["/aged"]));
});

test("an aged attention child folds into its parent's tray and stays reachable there", () => {
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const aged = child({ path: "/aged", conversationId: "aged", parentId: "parent", parent: parent.path, activity: "idle", proc: "killed", mtime: NOW - 100 * 3_600 });
  const projection = buildSubagentTrays(baseInput([parent, aged], ["parent"]));
  expect(projection.promotedPaths.size).toBe(0);
  expect(projection.foldedPaths).toEqual(new Set(["/aged"]));
  expect(projection.traysByParent.get("parent")!.members.map((member) => member.id)).toEqual(["aged"]);
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
  const live = child({ path: "/live", conversationId: "live", parentId: "parent", parent: parent.path, activity: "live", proc: "running", mtime: 999_990 });
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
  const liveFolded = child({ path: "/livef", conversationId: "livef", parentId: "parent", parent: parent.path, activity: "live", proc: "running", mtime: 999_990, sessionStartedAt: "2026-07-19T09:00:00Z" });
  const projection = buildSubagentTrays(baseInput([parent, doneOld, liveFolded], ["parent"], {
    foldedEngineChildIds: new Set(["done", "livef"]),
  }));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.members.map((member) => member.id)).toEqual(["livef", "done"]);
});

test("buildSubagentTrays reads its clock in epoch seconds, the unit `mtime` and attention TTLs use", () => {
  const now = 1_800_000_000;
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  /* Alive, no attention signal, and silent for an hour — a folded row that
     must read silent rather than working. */
  const wedged = child({
    path: "/wedged",
    conversationId: "wedged",
    parentId: "parent",
    parent: parent.path,
    activity: "recent",
    proc: "running",
    mtime: now - 3_600,
  });
  const writing = child({
    path: "/writing",
    conversationId: "writing",
    parentId: "parent",
    parent: parent.path,
    /* The scan verdict has gone stale; the transcript says otherwise. */
    activity: "idle",
    proc: "running",
    mtime: now - 2,
  });
  const projection = buildSubagentTrays(baseInput([parent, wedged, writing], ["parent"], {
    foldedEngineChildIds: new Set(["wedged", "writing"]),
    now: epochSeconds(now),
  }));
  const tray = projection.traysByParent.get("parent")!;
  expect(tray.members.map((member) => [member.id, member.state])).toEqual([
    ["writing", "running"],
    ["wedged", "silent"],
  ]);
  expect(tray.hottest).toBe("running");
});

test("buildSubagentTrays promotes a stalled live child inside the attention TTL (seconds, not milliseconds)", () => {
  /* Feeding this clock milliseconds put every child hours past the attention
     TTL, so an interrupted agent could never surface out of the tray. */
  const now = 1_800_000_000;
  const parent = entry({ path: "/parent", conversationId: "parent", activity: "live" });
  const stalled = child({
    path: "/stalled",
    conversationId: "stalled",
    parentId: "parent",
    parent: parent.path,
    activity: "stalled",
    proc: "running",
    mtime: now - 600,
  });
  const projection = buildSubagentTrays(baseInput([parent, stalled], ["parent"], {
    foldedEngineChildIds: new Set(["stalled"]),
    now: epochSeconds(now),
  }));
  expect(projection.promotedPaths).toEqual(new Set(["/stalled"]));
  expect(projection.foldedPaths.size).toBe(0);
});
