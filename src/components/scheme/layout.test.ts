import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { type BranchGroup, buildBranchGroups } from "@/components/projectModel";

import { deckKey, flowLinkKey } from "./agentLinks";
import { INDENT, buildSchemeLayout } from "./layout";

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

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function flow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: "/reviewer",
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt: "2026-07-05T00:00:00Z",
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

describe("buildSchemeLayout byPath", () => {
  test("carries stacks and decks as glide/edge targets alongside nodes", () => {
    const root = entry({ path: "/root", activity: "live" });
    const quiet = entry({ path: "/root/quiet", parent: "/root", kind: "subagent" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [quiet],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root, quiet], [flow({ id: "f1", implementerPath: "/root" })], []);

    expect(layout.byPath.has("/root")).toBe(true);
    expect(layout.stacks).toHaveLength(1);
    expect(layout.byPath.get(layout.stacks[0]!.key)).toBe(layout.stacks[0]!);
    expect(layout.decks).toHaveLength(1);
    expect(layout.byPath.get(layout.decks[0]!.key)).toBe(layout.decks[0]!);
  });

  test("keeps failed and current reviewer bindings in the same round deck", () => {
    const root = entry({ path: "/implementer", activity: "live", conversationId: "conversation-implementer" });
    const reviewer = (pathname: string, conversationId: string, slot: string) => entry({
      path: pathname,
      conversationId,
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: root.conversationId!,
        reviewsConversationId: root.conversationId!,
        memberships: [{
          kind: "flow",
          containerId: "f-retry",
          role: "reviewer",
          slot,
          stageId: null,
          stageOrder: null,
          round: 1,
          parentConversationId: root.conversationId!,
        }],
      },
    });
    const failed = reviewer("/reviewer-failed", "conversation-reviewer-a", "reviewer:1:binding-a");
    const current = reviewer("/reviewer-current", "conversation-reviewer-b", "reviewer:1:binding-b");
    const group: BranchGroup = {
      key: root.path,
      columns: [{ file: root, tasks: [] }],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const reviewFlow = flow({
      id: "f-retry",
      implementerPath: root.path,
      rounds: [{
        n: 1,
        reviewerPath: current.path,
        reviewerConversationId: current.conversationId,
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt: "2026-07-05T00:00:00Z",
        reviewedAt: null,
        relayedAt: null,
        error: null,
      }],
    });

    const layout = buildSchemeLayout([group], [], [root, current, failed], [reviewFlow], []);

    expect(layout.decks[0]!.rounds.map((item) => item.file?.path)).toEqual([failed.path, current.path]);
  });

  test("derives a flow link whose endpoints resolve to placed board rects", () => {
    const root = entry({ path: "/root", activity: "live" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root], [flow({ id: "f1", implementerPath: "/root" })], []);

    expect(layout.links).toHaveLength(1);
    const link = layout.links[0]!;
    expect(link).toMatchObject({ key: flowLinkKey("f1"), kind: "flow", from: "/root", to: deckKey("f1") });
    /* Both endpoints must be drawable rects, or the link layer has nothing to anchor to. */
    expect(layout.byPath.has(link.from)).toBe(true);
    expect(layout.byPath.has(link.to)).toBe(true);
    expect(link.flow).toMatchObject({ round: 1, phase: "awaiting_verdict" });
  });

  test("a flow whose implementer is off the board derives no link", () => {
    const root = entry({ path: "/root", activity: "live" });
    const group: BranchGroup = {
      key: "/root",
      columns: [{ file: root, tasks: [] }],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root], [flow({ id: "f1", implementerPath: "/elsewhere" })], []);
    expect(layout.links).toHaveLength(0);
  });

  test("expanded reviewer children render as connected nodes below the implementer", () => {
    const root = entry({ path: "/implementer", activity: "live" });
    const reviewSubtask = entry({
      path: "/review-subtask",
      root: "codex-sessions",
      engine: "codex",
      fmt: "codex",
      parent: "/implementer",
      activity: "idle",
    });
    const group: BranchGroup = {
      key: "/implementer",
      columns: [
        { file: root, tasks: [] },
        { file: reviewSubtask, tasks: [] },
      ],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };

    const layout = buildSchemeLayout(
      [group],
      [],
      [root, reviewSubtask],
      [flow({ id: "f1", implementerPath: "/implementer" })],
      [],
    );
    const implementerNode = layout.nodes.find((node) => node.file.path === "/implementer")!;
    const subtaskNode = layout.nodes.find((node) => node.file.path === "/review-subtask")!;

    expect(subtaskNode.y).toBeGreaterThan(implementerNode.y + implementerNode.h);
    expect(subtaskNode.x).toBeGreaterThan(implementerNode.x);
    expect(layout.edges.some((edge) => edge.to === "/review-subtask" && !edge.dashed)).toBe(true);
    expect(layout.stacks).toHaveLength(0);
    expect(implementerNode.under.map((file) => file.path)).toEqual([]);
  });

  test("a standalone flow halo encloses the implementer + deck but not unrelated descendants (issue #118 review F3)", () => {
    const root = entry({ path: "/implementer", activity: "live" });
    /* A quiet child of the implementer, unrelated to the flow's review loop. */
    const child = entry({ path: "/implementer/child", parent: "/implementer", kind: "subagent", activity: "idle" });
    const group: BranchGroup = {
      key: "/implementer",
      columns: [
        { file: root, tasks: [] },
        { file: child, tasks: [] },
      ],
      returnable: [],
      finished: [],
      smt: root.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group], [], [root, child], [flow({ id: "f1", implementerPath: "/implementer" })], []);
    const halo = layout.groups.find((g) => g.kind === "flow")!;
    const implementer = layout.nodes.find((node) => node.file.path === "/implementer")!;
    const deck = layout.decks[0]!;
    const childNode = layout.nodes.find((node) => node.file.path === "/implementer/child")!;

    /* The halo covers the implementer and its reviewer deck (the pair). */
    expect(halo.x).toBeLessThanOrEqual(implementer.x);
    expect(halo.x + halo.w).toBeGreaterThanOrEqual(deck.x + deck.w);
    /* …but stops above the descendant child — the flow region is not stretched
       across the board by an unrelated agent spawned below the implementer. */
    expect(halo.y + halo.h).toBeLessThan(childNode.y);
  });

  test("a plain subagent of a live session renders as a connected node below it, not a mini-stack", () => {
    /* End-to-end for the "Verify MVP" case: a live claude session with an idle
       Task-tool subagent and no flow. buildBranchGroups must promote the
       subagent to a column and buildSchemeLayout must place it below the parent
       wired by a solid edge — never a detached right-side mini-stack. */
    const session = entry({ path: "/session", activity: "live" });
    const subagent = entry({ path: "/session/verify-mvp", parent: "/session", kind: "subagent", activity: "idle" });
    const files = [session, subagent];

    const groups = buildBranchGroups(files, "demo");
    expect(groups[0]!.columns.map((column) => column.file.path)).toEqual(["/session", "/session/verify-mvp"]);

    const layout = buildSchemeLayout(groups, [], files, [], []);
    const parentNode = layout.nodes.find((node) => node.file.path === "/session")!;
    const childNode = layout.nodes.find((node) => node.file.path === "/session/verify-mvp")!;
    expect(childNode.y).toBeGreaterThan(parentNode.y + parentNode.h);
    expect(layout.edges.some((edge) => edge.to === "/session/verify-mvp" && !edge.dashed)).toBe(true);
    expect(layout.stacks).toHaveLength(0);
  });
});

describe("surface pipelines — memberless active pipelines keep a scheme surface (#136)", () => {
  const pipeline = (over: Record<string, unknown>): Pipeline =>
    ({
      id: "p1", task: "Ship it", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
      baseRef: "a", lastPassedCommit: "a", stages: [{ id: "build", kind: "run", prompt: "", next: null }],
      runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null, srcPath: null,
      srcConversationId: null, createdAt: "1970", closedAt: null, ...over,
    }) as unknown as Pipeline;

  test("a provisioning pipeline with no stage node yet gets placeholder slots and a halo enclosing them (#196)", () => {
    const layout = buildSchemeLayout([], [], [], [], [], [], [pipeline({})]);
    const halo = layout.groups.find((group) => group.kind === "pipeline" && group.id === "p1");
    expect(halo).toBeTruthy();
    expect(halo!.pipeline?.id).toBe("p1");
    /* Every planned stage renders as a dashed placeholder window (#196), and the
       halo members ARE those slots, so the region wraps the whole staged row. */
    expect(layout.slots.map((slot) => slot.stage.id)).toEqual(["build"]);
    const slot = layout.slots[0]!;
    expect(halo!.members).toEqual([slot.key]);
    expect(slot.x).toBeGreaterThanOrEqual(halo!.x);
    expect(slot.x + slot.w).toBeLessThanOrEqual(halo!.x + halo!.w);
    expect(slot.y + slot.h).toBeLessThanOrEqual(halo!.y + halo!.h);
    /* The placeholder is inside the world box so the camera/minimap can reach it. */
    expect(halo!.x + halo!.w).toBeLessThanOrEqual(layout.width);
    expect(halo!.y + halo!.h).toBeLessThanOrEqual(layout.height);
  });

  test("a pipeline already framed by a materialized stage node gets no duplicate placeholder", () => {
    const root = entry({ path: "/stage" });
    const group: BranchGroup = { key: "/stage", columns: [{ file: root, tasks: [] }], returnable: [], finished: [], smt: root.mtime, orphanTask: false };
    const withNode = pipeline({ runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/stage", flowId: null } as unknown as Record<string, unknown>] }] });
    const layout = buildSchemeLayout([group], [], [root], [], [], [withNode], [withNode]);
    const halos = layout.groups.filter((g) => g.kind === "pipeline" && g.id === "p1");
    expect(halos).toHaveLength(1);
  });
});

describe("sibling pipeline halos never overlap (#136 finding 1)", () => {
  const pipe = (id: string, agentPath: string): Pipeline =>
    ({
      id, task: id, project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
      baseRef: "a", lastPassedCommit: "a", stages: [{ id: "build", kind: "run", prompt: "", next: null }],
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath, flowId: null }] }],
      cursor: { stageId: "build", state: "running" }, state: "running", pausedState: null, stateDetail: null,
      srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
    }) as unknown as Pipeline;

  test("two pipelines spawned from one origin keep disjoint dashed outlines", () => {
    /* The origin conversation spawns two pipelines; their stage-0 nodes are
       adjacent siblings. With only GAP_X (48) between them each halo's 46px pad
       overlapped by 44px — group-aware spacing must separate them. */
    const origin = entry({ path: "/origin", activity: "live" });
    const a = entry({ path: "/origin/a", parent: "/origin", kind: "subagent" });
    const b = entry({ path: "/origin/b", parent: "/origin", kind: "subagent" });
    const files = [origin, a, b];
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], [pipe("p1", "/origin/a"), pipe("p2", "/origin/b")]);
    const halos = layout.groups.filter((group) => group.kind === "pipeline");
    expect(halos).toHaveLength(2);
    const [left, right] = [...halos].sort((x, y) => x.x - y.x);
    /* The right halo starts at or past the left halo's outer edge — no overlap. */
    expect(left!.x + left!.w).toBeLessThanOrEqual(right!.x);
  });

  test("a pipeline nested deep under an ungrouped sibling still clears an adjacent pipeline (#136 finding 2)", () => {
    /* p1's stage sits DEEP inside an otherwise-ungrouped child; the boundary must
       see the group carried by the whole subtree, not just the child's own path. */
    const origin = entry({ path: "/o", activity: "live" });
    const ungrouped = entry({ path: "/o/u", parent: "/o", kind: "subagent" });
    const p1stage = entry({ path: "/o/u/s1", parent: "/o/u", kind: "subagent" });
    const p2stage = entry({ path: "/o/s2", parent: "/o", kind: "subagent" });
    const files = [origin, ungrouped, p1stage, p2stage];
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], [pipe("p1", "/o/u/s1"), pipe("p2", "/o/s2")]);
    const halos = layout.groups.filter((group) => group.kind === "pipeline");
    expect(halos).toHaveLength(2);
    const [left, right] = [...halos].sort((x, y) => x.x - y.x);
    expect(left!.x + left!.w).toBeLessThanOrEqual(right!.x);
  });
});

describe("pipeline stage placeholder slots (issue #196)", () => {
  const staged = (over: Record<string, unknown>): Pipeline =>
    ({
      id: "p9", task: "Template draft", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
      baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
      stages: [
        { id: "architect", kind: "run", role: { roleId: "architect" }, prompt: "plan", next: "builder" },
        { id: "builder", kind: "run", role: { roleId: "builder" }, prompt: "build", next: "review" },
        { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
      ],
      runs: [], cursor: null, state: "draft", pausedState: null, stateDetail: null, srcPath: null,
      srcConversationId: null, createdAt: "1970", closedAt: null, ...over,
    }) as unknown as Pipeline;

  test("a template draft renders EVERY role stage as a placeholder slot, in stage order, under one halo", () => {
    const layout = buildSchemeLayout([], [], [], [], [], [staged({})], [staged({})]);
    expect(layout.slots.map((slot) => slot.stage.id)).toEqual(["architect", "builder", "review"]);
    /* Left-to-right in stage order, node-width footprints. */
    const [a, b, c] = layout.slots;
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    expect(a!.y).toBe(b!.y);
    /* Chain-adjacent slots carry the incoming handoff badge; the head does not. */
    expect(a!.incoming).toBeUndefined();
    expect(b!.incoming).toBe("run");
    expect(c!.incoming).toBe("review-loop");
    /* One halo wraps the full dashed row. */
    const halo = layout.groups.find((group) => group.kind === "pipeline" && group.id === "p9")!;
    for (const slot of layout.slots) {
      expect(slot.x).toBeGreaterThanOrEqual(halo.x);
      expect(slot.x + slot.w).toBeLessThanOrEqual(halo.x + halo.w);
      expect(slot.y + slot.h).toBeLessThanOrEqual(halo.y + halo.h);
    }
    /* Slots are camera-reachable board citizens. */
    for (const slot of layout.slots) expect(layout.byPath.get(slot.key)).toBe(slot);
    expect(layout.width).toBeGreaterThanOrEqual(c!.x + c!.w);
    expect(layout.height).toBeGreaterThanOrEqual(c!.y + c!.h);
  });

  test("a materialized stage dissolves exactly its slot; the next slot sits where the tree drops the tip's child (attach IN PLACE)", () => {
    const root = entry({ path: "/arch" });
    const group: BranchGroup = { key: "/arch", columns: [{ file: root, tasks: [] }], returnable: [], finished: [], smt: root.mtime, orphanTask: false };
    const running = staged({
      state: "running",
      cursor: { stageId: "builder", state: "spawning" },
      runs: [{ stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] }],
    });
    const layout = buildSchemeLayout([group], [], [root], [], [], [running], [running]);
    /* The architect window is live — only builder + review keep placeholders. */
    expect(layout.slots.map((slot) => slot.stage.id)).toEqual(["builder", "review"]);
    const node = layout.nodes.find((candidate) => candidate.file.path === "/arch")!;
    /* Review round-1 finding 3: the next stage's live window lands as the tip's
       child at (tip.x + INDENT, one generation below) — the slot must sit on
       EXACTLY those coordinates so the dashed card becomes the solid window in
       place, with no relocation. */
    const next = layout.slots[0]!;
    expect(next.x).toBe(node.x + INDENT);
    expect(next.y).toBeGreaterThanOrEqual(node.y + node.h);
    const attached = buildSchemeLayout(
      [
        group,
        {
          key: "/builder",
          columns: [{ file: entry({ path: "/builder", parent: "/arch" }), tasks: [] }],
          returnable: [],
          finished: [],
          smt: 1_000,
          orphanTask: false,
        },
      ],
      [],
      [root, entry({ path: "/builder", parent: "/arch" })],
      [],
      [],
      [staged({
        state: "running",
        cursor: { stageId: "review", state: "spawning" },
        runs: [
          { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] },
          { stageId: "builder", attempts: [{ n: 1, state: "running", agentPath: "/builder", flowId: null }] },
        ],
      })],
      [],
    );
    /* Note: whether the builder lands as /arch's tree child or its own column,
       the invariant under test is positional: its window must take the slot's
       coordinates from the previous poll's layout when the topology matches
       (child-of-tip), which the INDENT/GAP_Y anchor above encodes. */
    expect(attached.slots.map((slot) => slot.stage.id)).toEqual(["review"]);
    /* Exactly one halo encloses both the live node and the remaining slots. */
    const halos = layout.groups.filter((candidate) => candidate.kind === "pipeline" && candidate.id === "p9");
    expect(halos).toHaveLength(1);
    const halo = halos[0]!;
    expect(node.x).toBeGreaterThanOrEqual(halo.x);
    for (const slot of layout.slots) {
      expect(slot.x + slot.w).toBeLessThanOrEqual(halo.x + halo.w);
      expect(slot.y + slot.h).toBeLessThanOrEqual(halo.y + halo.h);
    }
  });

  test("a foreign project's memberless draft never grows slots or a halo on this canvas (round-1 finding 2)", () => {
    /* Global list carries another project's draft; the project-scoped surface
       list does not include it — nothing of it may render here. */
    const foreign = staged({ id: "px", project: "other" });
    const layout = buildSchemeLayout([], [], [], [], [], [foreign], []);
    expect(layout.slots).toHaveLength(0);
    expect(layout.groups.filter((group) => group.kind === "pipeline")).toHaveLength(0);
    /* The same pipeline offered through the surface list (this project) renders. */
    const local = buildSchemeLayout([], [], [], [], [], [foreign], [foreign]);
    expect(local.slots.length).toBeGreaterThan(0);
  });
});
