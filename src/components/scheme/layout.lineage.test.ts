/**
 * Lineage direction on the scheme (issue #828).
 *
 * The reported frame drew ONE edge from a Builder down to the Codex session two
 * generations ABOVE it, with the Orchestrator between them missing — delegation
 * read backwards, so a worker looked like it had taken over coordination. The
 * follow-up showed the same region rendering correctly minutes later with no
 * code change: parentage was being re-derived at render time from several
 * disagreeing signals, so the hierarchy moved with transient process state.
 *
 * These cases drive `buildSchemeLayout` from fixtures shaped like those live
 * records — a chain whose recorded depth is 0 at every level, an intermediate
 * ancestor that comes and goes, and a scanner pointer that names a descendant
 * as the parent — and hold the rendered graph to the canonical lineage: parent
 * → child always, elided generations represented, one edge per pair.
 */
import { describe, expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildBranchGroups } from "@/components/projectModel";

import { buildSchemeLayout, type SchemeLayout } from "./layout";
import { buildSchemeLineage } from "./lineageModel";

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

/* Every live record in the report carried `depth: 0`, whatever its position. */
function lineage(parentConversationId: string | null, role: string | null = null, kind: "spawn" | "review" = "spawn") {
  return { kind, role, depth: 0, parentConversationId, reviewsConversationId: null, memberships: [] } as FileEntry["durableLineage"];
}

/* The chain from the issue: Voice Coordinator → Codex session → Orchestrator →
   Builder → reviewer, four generations deep across both engines. */
const coordinator = entry({
  path: "/coordinator", conversationId: "conversation_coordinator", root: "codex-sessions", engine: "codex",
  title: "Voice Coordinator", activity: "live",
});
const codexSession = entry({
  path: "/codex-session", conversationId: "conversation_codex", root: "codex-sessions", engine: "codex",
  title: "Codex session", activity: "live", parent: coordinator.path, durableLineage: lineage("conversation_coordinator"),
});
const orchestrator = entry({
  path: "/orchestrator", conversationId: "conversation_orchestrator", title: "Orchestrator", activity: "live",
  parent: codexSession.path, durableLineage: lineage("conversation_codex", "orchestrator"),
});
const builder = entry({
  path: "/builder", conversationId: "conversation_builder", title: "Builder — plain", activity: "live",
  parent: orchestrator.path, durableLineage: lineage("conversation_orchestrator", "builder"),
});
const reviewer = entry({
  path: "/reviewer", conversationId: "conversation_reviewer", root: "codex-sessions", engine: "codex",
  title: "reviewer", activity: "live", parent: builder.path,
  durableLineage: lineage("conversation_builder", "reviewer", "review"),
});

const boardOf = (files: FileEntry[]): SchemeLayout =>
  buildSchemeLayout(buildBranchGroups(files, "demo"), [], files);

const edgePairs = (layout: SchemeLayout): Array<[string | undefined, string]> =>
  layout.edges.filter((edge) => layout.nodes.some((node) => node.file.path === edge.to)).map((edge) => [edge.from, edge.to]);

const ancestryOf = (layout: SchemeLayout, path: string) =>
  layout.nodes.find((node) => node.file.path === path)?.ancestry;

/** Every drawn lineage edge leaves a genuine ancestor of the node it enters. */
function expectNoInvertedEdge(layout: SchemeLayout, files: FileEntry[]): void {
  const model = buildSchemeLineage(files);
  for (const [from, to] of edgePairs(layout)) {
    expect(from).toBeTruthy();
    expect({ from, to, ancestor: model.isAncestorOf(from!, to) }).toEqual({ from, to, ancestor: true });
  }
}

describe("scheme lineage direction", () => {
  test("the whole chain draws one downward edge per generation", () => {
    const files = [coordinator, codexSession, orchestrator, builder, reviewer];
    const layout = boardOf(files);

    expect(edgePairs(layout).sort()).toEqual([
      [builder.path, reviewer.path],
      [codexSession.path, orchestrator.path],
      [coordinator.path, codexSession.path],
      [orchestrator.path, builder.path],
    ]);
    expectNoInvertedEdge(layout, files);
    expect(layout.nodes.map((node) => node.ancestry?.depth)).toEqual(layout.nodes.map((node) => buildSchemeLineage(files).depthOf(node.file.path)));
  });

  test("a scanner pointer naming a DESCENDANT as the parent never draws a builder over its own ancestor", () => {
    /* The reported frame: the codex session's transcript pointer named the
       builder — two generations below it — as its parent. */
    const inverted = { ...codexSession, parent: builder.path };
    const files = [{ ...builder, parent: null }, inverted, reviewer];
    const layout = boardOf(files);

    expect(edgePairs(layout)).toEqual([[builder.path, reviewer.path]]);
    expect(edgePairs(layout)).not.toContainEqual([builder.path, inverted.path]);
    expectNoInvertedEdge(layout, files);
    /* Both survivors keep their real parent named, unrendered — neither borrows
       the other as a spawner. */
    expect(ancestryOf(layout, inverted.path)).toMatchObject({ hostPath: null, unresolvedParentId: "conversation_coordinator" });
    expect(ancestryOf(layout, builder.path)).toMatchObject({ hostPath: null, unresolvedParentId: "conversation_orchestrator" });
  });

  test("an ancestor the board does not draw is elided on the edge, not skipped in silence", () => {
    /* The Orchestrator goes quiet and leaves the column set; the Builder keeps
       hanging under the generation above it, and the edge reports the gap. */
    const quiet = { ...orchestrator, activity: "idle" as const };
    const files = [coordinator, codexSession, quiet, builder, reviewer];
    const layout = boardOf(files);

    expect(layout.nodes.some((node) => node.file.path === quiet.path)).toBe(false);
    expect(edgePairs(layout)).toContainEqual([codexSession.path, builder.path]);
    expect(ancestryOf(layout, builder.path)).toMatchObject({ hostPath: codexSession.path, unresolvedParentId: null });
    expect(ancestryOf(layout, builder.path)?.elided.map((file) => file.path)).toEqual([quiet.path]);
    const spanning = layout.edges.find((edge) => edge.to === builder.path);
    expect(spanning?.via?.map((file) => file.path)).toEqual([quiet.path]);
    expect(spanning?.dashed).toBe(true);
    expectNoInvertedEdge(layout, files);
  });

  test("direction survives the intermediate ancestor moving through live, stalled and idle", () => {
    const model = buildSchemeLineage([coordinator, codexSession, orchestrator, builder, reviewer]);
    const chain = [orchestrator.path, codexSession.path, coordinator.path];

    for (const activity of ["live", "stalled", "recent", "idle"] as const) {
      const files = [coordinator, codexSession, { ...orchestrator, activity }, builder, reviewer];
      const layout = boardOf(files);
      expectNoInvertedEdge(layout, files);
      /* Whatever the board can draw, the builder's ancestors stay the same
         ordered chain — the visible host plus the elided prefix above it. */
      const ancestry = ancestryOf(layout, builder.path)!;
      expect([...ancestry.elided.map((file) => file.path), ancestry.hostPath])
        .toEqual(chain.slice(0, chain.indexOf(ancestry.hostPath!) + 1));
      expect(model.isAncestorOf(ancestry.hostPath!, builder.path)).toBe(true);
    }
  });

  test("the same scan renders the same graph twice — a refresh never reshuffles lineage", () => {
    const files = [coordinator, codexSession, { ...orchestrator, activity: "stalled" as const }, builder, reviewer];
    const first = boardOf(files);
    const second = boardOf([...files].reverse());

    expect(edgePairs(second).sort()).toEqual(edgePairs(first).sort());
    expect(second.nodes.map((node) => node.lineageOrderKey).sort()).toEqual(first.nodes.map((node) => node.lineageOrderKey).sort());
  });

  test("every node has at most one incoming lineage edge", () => {
    const files = [coordinator, codexSession, orchestrator, builder, reviewer];
    const targets = edgePairs(boardOf(files)).map(([, to]) => to);

    expect(new Set(targets).size).toBe(targets.length);
  });

  test("a deleted parent worktree leaves an explicit continuation, not a borrowed parent", () => {
    /* The parent transcript is gone with its checkout; the tombstone is the
       only statement left, and it must not be replaced by the nearest card. */
    const survivor = entry({
      path: "/survivor", conversationId: "conversation_survivor", title: "Builder — plain", activity: "live",
      parentRemoved: { conversationId: "conversation_gone", path: "/gone" },
    });
    const files = [coordinator, codexSession, survivor];
    const layout = boardOf(files);

    expect(layout.nodes.map((node) => node.file.path)).toContain(survivor.path);
    expect(edgePairs(layout)).not.toContainEqual([codexSession.path, survivor.path]);
    expect(ancestryOf(layout, survivor.path)).toMatchObject({ hostPath: null, unresolvedParentId: "conversation_gone" });
  });

  test("a restored conversation keeps its children after the transcript generation changes", () => {
    /* An account migration re-homes the parent onto a new transcript; the
       durable edge names the conversation, so the child follows the successor. */
    const archived = entry({ path: "/parent-gen1", conversationId: "conversation_parent", title: "Orchestrator", migratedTo: "/parent-gen2" });
    const successor = entry({ path: "/parent-gen2", conversationId: "conversation_parent", generation: 2, predecessorPath: "/parent-gen1", title: "Orchestrator", activity: "live" });
    const child = entry({
      path: "/child", conversationId: "conversation_child", title: "Builder — plain", activity: "live",
      kind: "subagent", parent: successor.path, durableLineage: lineage("conversation_parent", "builder"),
    });
    const files = [archived, successor, child];
    const layout = boardOf(files);

    expect(edgePairs(layout)).toContainEqual([successor.path, child.path]);
    expect(ancestryOf(layout, child.path)).toMatchObject({ hostPath: successor.path, unresolvedParentId: null });
  });

  test("a pipeline's stage conversations keep the chain that spawned them", () => {
    /* Stage windows are placed by the pipeline's own chain geometry; their
       lineage must still read builder-under-architect, and the halo that
       encloses them must not become the parent of everything inside it. */
    const stages = [
      { id: "architect", kind: "run", prompt: "", next: "builder" },
      { id: "builder", kind: "run", prompt: "", next: null },
    ];
    const pipeline = {
      id: "p828", task: "Ship it", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
      baseRef: "a", lastPassedCommit: "a", stages,
      runs: [
        { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/architect", flowId: null }] },
        { stageId: "builder", attempts: [{ n: 1, state: "running", agentPath: "/stage-builder", flowId: null }] },
      ],
      cursor: { stageId: "builder" }, state: "running", pausedState: null, stateDetail: null, srcPath: null,
      srcConversationId: null, createdAt: "1970", closedAt: null,
    } as unknown as Pipeline;

    const architect = entry({ path: "/architect", conversationId: "conversation_architect", title: "Architect", activity: "live" });
    const stageBuilder = entry({
      path: "/stage-builder", conversationId: "conversation_stage_builder", title: "Builder", activity: "live",
      kind: "subagent", parent: architect.path, durableLineage: lineage("conversation_architect", "builder"),
    });
    const files = [architect, stageBuilder];
    const layout = buildSchemeLayout(buildBranchGroups(files, "demo"), [], files, [], [], [pipeline], [pipeline]);

    expect(edgePairs(layout)).toEqual([[architect.path, stageBuilder.path]]);
    expectNoInvertedEdge(layout, files);
  });

  test("a descendant drawn in another tree is still owned by its ancestor, in one edge", () => {
    /* The builder's own group lost its root (its parent pointer never resolved),
       so it opens a separate tree — the ancestor edge crosses to it instead of
       leaving the card reading as a root of its own lineage. */
    const detached = { ...builder, parent: null };
    const files = [coordinator, codexSession, orchestrator, detached, reviewer];
    const layout = boardOf(files);
    const incoming = layout.edges.filter((edge) => edge.to === detached.path);

    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.from).toBe(orchestrator.path);
    expectNoInvertedEdge(layout, files);
  });
});
