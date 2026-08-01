import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildSchemeLineage, durableParentConversationId } from "./lineageModel";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

/** The durable record a spawn writes: parent + role, memberships unused here. */
function lineage(parentConversationId: string | null, role: string | null = null, kind: "spawn" | "review" = "spawn") {
  return { kind, role, parentConversationId, reviewsConversationId: null, memberships: [] } as FileEntry["durableLineage"];
}

/* The chain from issue #828, captured from `durableLineage` on live records:
   coordinator → codex session → orchestrator → builder → reviewer. */
const coordinator = entry({
  path: "/coordinator", conversationId: "conversation_coordinator", root: "codex-sessions", engine: "codex",
  title: "Voice Coordinator", activity: "live",
});
const codexSession = entry({
  path: "/codex-session", conversationId: "conversation_codex", root: "codex-sessions", engine: "codex",
  title: "Codex session", activity: "live", durableLineage: lineage("conversation_coordinator"),
});
const orchestrator = entry({
  path: "/orchestrator", conversationId: "conversation_orchestrator", title: "Orchestrator", activity: "stalled",
  durableLineage: lineage("conversation_codex", "orchestrator"),
});
const builder = entry({
  path: "/builder", conversationId: "conversation_builder", title: "Builder — plain", activity: "live",
  durableLineage: lineage("conversation_orchestrator", "builder"),
});
const reviewer = entry({
  path: "/reviewer", conversationId: "conversation_reviewer", root: "codex-sessions", engine: "codex",
  title: "reviewer", activity: "live", durableLineage: lineage("conversation_builder", "reviewer", "review"),
});

describe("buildSchemeLineage precedence", () => {
  test("a durable parent outranks a transcript pointer that inverts the chain", () => {
    /* The exact defect: the scanner's pointer named the DESCENDANT builder as
       the codex session's parent, so the board drew the grandparent as a child. */
    const inverted = { ...codexSession, parent: builder.path };
    const model = buildSchemeLineage([coordinator, inverted, orchestrator, builder, reviewer]);

    expect(model.parentPathOf(inverted.path)).toBe(coordinator.path);
    expect(model.isAncestorOf(inverted.path, builder.path)).toBe(true);
    expect(model.isAncestorOf(builder.path, inverted.path)).toBe(false);
    expect(model.ancestorsOf(builder.path)).toEqual([orchestrator.path, codexSession.path, coordinator.path]);
  });

  test("depth comes from the resolved chain, not from the recorded value", () => {
    /* Every live record in the report carried `depth: 0` regardless of its
       position, so the board must derive tiers from the chain itself. */
    const flattened = [coordinator, codexSession, orchestrator, builder, reviewer]
      .map((file) => (file.durableLineage ? { ...file, durableLineage: { ...file.durableLineage, depth: 0 } } : file));
    const model = buildSchemeLineage(flattened);

    expect(flattened.map((file) => model.depthOf(file.path))).toEqual([0, 1, 2, 3, 4]);
  });

  test("a record with no durable statement keeps the scanner's transcript pointer", () => {
    const main = entry({ path: "/main", conversationId: "conversation_main" });
    const subagent = entry({ path: "/main/subagents/agent-1", kind: "subagent", parent: "/main" });
    const model = buildSchemeLineage([main, subagent]);

    expect(model.linkOf(subagent.path)).toEqual({
      parentConversationId: "conversation_main",
      parentPath: "/main",
      source: "transcript",
    });
  });

  test("a transcript pointer at a conversation outside the scan is not a parent", () => {
    const orphan = entry({ path: "/orphan", parent: "/gone" });
    expect(buildSchemeLineage([orphan]).linkOf(orphan.path)).toBeNull();
  });

  test("a deleted parent worktree keeps its tombstone as the parent statement", () => {
    const child = entry({
      path: "/child", conversationId: "conversation_child",
      parentRemoved: { conversationId: "conversation_gone", path: "/gone" },
    });
    const stranger = entry({ path: "/stranger", conversationId: "conversation_stranger", activity: "live" });
    const model = buildSchemeLineage([stranger, child]);

    expect(durableParentConversationId(child)).toBe("conversation_gone");
    expect(model.parentPathOf(child.path)).toBeNull();
    expect(model.resolveHost(child.path, new Set([stranger.path]))).toEqual({
      host: null,
      elided: [],
      unresolvedParentId: "conversation_gone",
    });
  });

  test("a durable parent resolves through the successor of a migrated conversation", () => {
    const predecessor = entry({ path: "/parent-gen1", conversationId: "conversation_parent", migratedTo: "/parent-gen2" });
    const successor = entry({ path: "/parent-gen2", conversationId: "conversation_parent", generation: 2, predecessorPath: "/parent-gen1" });
    const child = entry({ path: "/child", conversationId: "conversation_child", durableLineage: lineage("conversation_parent") });
    const model = buildSchemeLineage([predecessor, successor, child]);

    expect(model.parentPathOf(child.path)).toBe(successor.path);
  });

  test("two disagreeing statements that close a cycle leave a forest", () => {
    const a = entry({ path: "/a", conversationId: "conversation_a", durableLineage: lineage("conversation_b") });
    const b = entry({ path: "/b", conversationId: "conversation_b", durableLineage: lineage("conversation_a") });
    const forward = buildSchemeLineage([a, b]);
    const reversed = buildSchemeLineage([b, a]);

    expect(forward.ancestorsOf("/a")).toEqual(reversed.ancestorsOf("/a"));
    expect(forward.ancestorsOf("/b")).toEqual(reversed.ancestorsOf("/b"));
    /* Whichever link is cut, neither node may end up its own ancestor. */
    expect(forward.isAncestorOf("/a", "/a")).toBe(false);
    expect(forward.isAncestorOf("/b", "/b")).toBe(false);
  });

  test("a record naming itself as its parent is a root", () => {
    const self = entry({ path: "/self", conversationId: "conversation_self", durableLineage: lineage("conversation_self") });
    expect(buildSchemeLineage([self]).linkOf("/self")).toBeNull();
  });
});

describe("resolveHost", () => {
  const files = [coordinator, codexSession, orchestrator, builder, reviewer];

  test("an unrendered ancestor is elided, never reversed: the host stays above", () => {
    const model = buildSchemeLineage(files);
    const visible = new Set([coordinator.path, codexSession.path, builder.path, reviewer.path]);

    expect(model.resolveHost(builder.path, visible)).toEqual({
      host: codexSession.path,
      elided: [orchestrator.path],
      unresolvedParentId: null,
    });
    expect(model.resolveHost(codexSession.path, visible).host).toBe(coordinator.path);
  });

  test("hosting is identical whether the intermediate ancestor is live or stalled", () => {
    const stalled = buildSchemeLineage(files);
    const live = buildSchemeLineage(files.map((file) => ({ ...file, activity: "live" as const })));
    const visible = new Set([coordinator.path, codexSession.path, builder.path]);

    expect(live.resolveHost(builder.path, visible)).toEqual(stalled.resolveHost(builder.path, visible));
  });

  test("a child whose whole chain is off the board reports an unresolved ancestor", () => {
    /* Only the builder and the codex session survive the scan window: the
       builder's parent is unknown here, so it must NOT borrow the codex
       session — which is its grandparent — as a spawner. */
    const model = buildSchemeLineage([codexSession, builder]);
    const visible = new Set([codexSession.path, builder.path]);

    expect(model.resolveHost(builder.path, visible)).toEqual({
      host: null,
      elided: [],
      unresolvedParentId: "conversation_orchestrator",
    });
  });
});

describe("orderKey", () => {
  test("lists a generation before the one it spawned, whatever the activity", () => {
    const files = [reviewer, builder, orchestrator, codexSession, coordinator];
    const model = buildSchemeLineage(files);
    const order = (input: FileEntry[]) =>
      [...input].sort((a, b) => (model.orderKey(a.path) < model.orderKey(b.path) ? -1 : 1)).map((file) => file.path);

    expect(order(files)).toEqual([coordinator.path, codexSession.path, orchestrator.path, builder.path, reviewer.path]);
    expect(order(files.map((file) => ({ ...file, activity: "idle" as const, mtime: 5 })))).toEqual(order(files));
  });
});
