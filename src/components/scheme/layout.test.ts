import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";

import { directReviewFlows } from "@/components/flows/directReviewGroups";
import { compactPipelineLayoutFlows } from "@/components/pipelines/pipelineModel";
import { type BranchGroup, buildBranchGroups } from "@/components/projectModel";
import { planRootReconciliation } from "@/components/projectBoardMutations";
import { applyBoardMutations } from "@/lib/board/mutations";
import { autoTaskSlotPosition } from "@/lib/tasks/lattice";

import { deckKey, flowLinkKey } from "./agentLinks";
import { REST_BAND_MAX_W, buildSchemeLayout } from "./layout";
import { TASK_W, taskWorldBounds } from "./taskGeometry";

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

const boardOf = (manual: string[] = []): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: { manual, hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
});

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
  test("an idle reconciled root excludes every descendant beyond a foreign project boundary", () => {
    const root = entry({ path: "/a-root", project: "project-a", activity: "live" });
    const foreignChild = entry({
      path: "/b-child",
      project: "project-b",
      parent: root.path,
      kind: "subagent",
      activity: "live",
    });
    const localLeaf = entry({
      path: "/a-leaf",
      project: "project-a",
      parent: foreignChild.path,
      kind: "subagent",
      activity: "idle",
    });
    const activeFiles = [root, foreignChild, localLeaf];
    const activeGroups = buildBranchGroups(activeFiles, "project-a");
    const catalog = new Map(activeFiles.map((file) => [file.path, file]));
    const activeBoard = applyBoardMutations(boardOf(), [planRootReconciliation({
      groups: activeGroups,
      manual: [],
      catalog,
    })]);
    expect(activeBoard.prefs.manual).toContain(root.path);

    const idleRoot = { ...root, activity: "idle" as const };
    const idleFiles = [idleRoot, foreignChild, localLeaf];
    const idleGroups = buildBranchGroups(idleFiles, "project-a");
    expect(idleGroups.map((group) => group.key)).toEqual([localLeaf.path]);
    const idleBoard = applyBoardMutations(activeBoard, [planRootReconciliation({
      groups: idleGroups,
      manual: activeBoard.prefs.manual,
      catalog: new Map(idleFiles.map((file) => [file.path, file])),
    })]);
    const autoPaths = new Set(idleGroups.flatMap((group) => group.columns.map((column) => column.file.path)));
    const manual = idleBoard.prefs.manual
      .filter((path) => !autoPaths.has(path))
      .flatMap((path) => idleFiles.filter((file) => file.path === path));
    const layout = buildSchemeLayout(idleGroups, manual, idleFiles);

    expect(layout.nodes.map((node) => node.file.path).sort()).toEqual([localLeaf.path, root.path].sort());
    const stackedPaths = layout.stacks.flatMap((stack) => stack.items.map((item) => item.file.path));
    expect(stackedPaths).toEqual([]);
    expect(layout.byPath.has(foreignChild.path)).toBeFalse();
    expect(layout.nodes.filter((node) => node.file.path === localLeaf.path)).toHaveLength(1);
    expect(stackedPaths.filter((path) => path === localLeaf.path)).toHaveLength(0);
  });

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

describe("memberless pipelines stay outside world geometry (#388)", () => {
  const pipeline = (over: Record<string, unknown>): Pipeline =>
    ({
      id: "p1", task: "Ship it", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
      baseRef: "a", lastPassedCommit: "a", stages: [{ id: "build", kind: "run", prompt: "", next: null }],
      runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null, srcPath: null,
      srcConversationId: null, createdAt: "1970", closedAt: null, ...over,
    }) as unknown as Pipeline;

  test("1, 3, and 10 memberless pipelines add zero groups, slots, or world bounds", () => {
    const empty = buildSchemeLayout([], [], []);
    for (const count of [1, 3, 10]) {
      const rows = Array.from({ length: count }, (_, index) => pipeline({ id: `p${index + 1}` }));
      const layout = buildSchemeLayout([], [], [], [], [], rows, rows);
      expect(layout.groups, String(count)).toEqual([]);
      expect(layout.slots, String(count)).toEqual([]);
      expect({ width: layout.width, height: layout.height }, String(count)).toEqual({ width: empty.width, height: empty.height });
    }
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
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null }, state: "running", pausedState: null, stateDetail: null,
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

describe("pipeline world ownership (#353/#388)", () => {
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

  test("a template draft stays out of world geometry", () => {
    const pipeline = staged({});
    const empty = buildSchemeLayout([], [], []);
    const layout = buildSchemeLayout([], [], [], [], [], [pipeline], [pipeline]);
    expect(layout.slots).toHaveLength(0);
    expect(layout.groups.filter((group) => group.kind === "pipeline")).toHaveLength(0);
    expect({ width: layout.width, height: layout.height }).toEqual({ width: empty.width, height: empty.height });
  });

  test("a materialized current stage stays as the group's single full pane", () => {
    const root = entry({ path: "/arch", activity: "live" });
    const group: BranchGroup = { key: "/arch", columns: [{ file: root, tasks: [] }], returnable: [], finished: [], smt: root.mtime, orphanTask: false };
    const running = staged({
      state: "running",
      cursor: { stageId: "builder", state: "spawning", input: null, activatedBy: null },
      runs: [{ stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] }],
    });
    const layout = buildSchemeLayout([group], [], [root], [], [], [running], [running]);
    expect(layout.slots).toHaveLength(0);
    const node = layout.nodes.find((candidate) => candidate.file.path === "/arch")!;
    const halos = layout.groups.filter((candidate) => candidate.kind === "pipeline" && candidate.id === "p9");
    expect(halos).toHaveLength(1);
    const halo = halos[0]!;
    expect(node.x).toBeGreaterThanOrEqual(halo.x);
    expect(node.x + node.w).toBeLessThanOrEqual(halo.x + halo.w);
    expect(node.y + node.h).toBeLessThanOrEqual(halo.y + halo.h);
  });

  test("an active review stage keeps one conversation pane and folds its review deck", () => {
    const implementer = entry({ path: "/builder", activity: "live" });
    const reviewer = entry({ path: "/reviewer", parent: "/builder", kind: "subagent", activity: "live" });
    const group: BranchGroup = { key: "/builder", columns: [{ file: implementer, tasks: [] }], returnable: [], finished: [], smt: implementer.mtime, orphanTask: false };
    const reviewing = staged({
      state: "reviewing",
      cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
      runs: [
        { stageId: "builder", attempts: [{ n: 1, state: "passed", agentPath: "/builder", flowId: null }] },
        { stageId: "review", attempts: [{ n: 1, state: "reviewing", agentPath: "/reviewer", flowId: "flow-1" }] },
      ],
    });
    const reviewFlow = flow({ id: "flow-1", implementerPath: "/builder" });
    const layoutFlows = compactPipelineLayoutFlows([reviewing], [reviewFlow]);
    const layout = buildSchemeLayout([group], [], [implementer, reviewer], layoutFlows, [], [reviewing], [reviewing]);

    expect(layout.nodes.map((node) => node.file.path)).toEqual(["/builder"]);
    expect(layout.decks).toHaveLength(0);
    expect(layout.groups.filter((candidate) => candidate.kind === "pipeline" && candidate.id === "p9")).toHaveLength(1);
  });

  test("an inspected compact transcript stays isolated from its descendant history", () => {
    const earlier = entry({ path: "/earlier", activity: "idle" });
    const later = entry({ path: "/later", parent: earlier.path, kind: "subagent", activity: "idle" });
    const layout = buildSchemeLayout(
      [],
      [earlier],
      [earlier, later],
      [],
      [],
      [],
      [],
      new Set(),
      new Set([earlier.path]),
    );

    expect(layout.nodes.map((node) => node.file.path)).toEqual([earlier.path]);
    expect(layout.stacks).toHaveLength(0);
    expect(layout.nodes[0]?.under).toHaveLength(0);
    expect(layout.byPath.has(later.path)).toBe(false);
  });

  test("a foreign project's memberless draft never grows slots or a halo on this canvas (round-1 finding 2)", () => {
    /* Global list carries another project's draft; the project-scoped surface
       list does not include it — nothing of it may render here. */
    const foreign = staged({ id: "px", project: "other" });
    const layout = buildSchemeLayout([], [], [], [], [], [foreign], []);
    expect(layout.slots).toHaveLength(0);
    expect(layout.groups.filter((group) => group.kind === "pipeline")).toHaveLength(0);
    /* Project-scoped surface membership is owned by the screen-space shelf. */
    const local = buildSchemeLayout([], [], [], [], [], [foreign], [foreign]);
    expect(local.slots).toHaveLength(0);
    expect(local.groups.filter((group) => group.kind === "pipeline")).toHaveLength(0);
  });

  for (const count of [1, 3, 10]) {
    test(`${count} memberless pipeline${count === 1 ? "" : "s"} leave every zoom and Fit All unchanged`, () => {
      const pipelines = Array.from({ length: count }, (_, index) => staged({ id: `p${index}` }));
      const empty = buildSchemeLayout([], [], []);
      const layout = buildSchemeLayout([], [], [], [], [], pipelines, pipelines);
      const pipelineGroups = layout.groups.filter((group) => group.kind === "pipeline");
      expect(pipelineGroups).toHaveLength(0);
      expect(layout.nodes).toHaveLength(0);
      expect(layout.slots).toHaveLength(0);
      expect({ width: layout.width, height: layout.height }).toEqual({ width: empty.width, height: empty.height });
      expect(layout.byPath.size).toBe(0);
    });
  }
});

describe("buildSchemeLayout favorites band (issue #224)", () => {
  const soloGroup = (path: string, mtime: number): { group: BranchGroup; file: FileEntry } => {
    const file = entry({ path, mtime, activity: "live" });
    return {
      file,
      group: { key: path, columns: [{ file, tasks: [] }], returnable: [], finished: [], smt: mtime, orphanTask: false },
    };
  };

  test("crowned roots pin to the top band above everything else, freshest-first", () => {
    const a = soloGroup("/fav-a", 3_000);
    const b = soloGroup("/fav-b", 5_000);
    const c = soloGroup("/plain-c", 4_000);
    const files = [a.file, b.file, c.file];
    const favorites = new Set(["/fav-a", "/fav-b"]);
    const layout = buildSchemeLayout([a.group, b.group, c.group], [], files, [], [], [], [], favorites);

    const nodeFor = (path: string) => layout.nodes.find((node) => node.file.path === path)!;
    const favA = nodeFor("/fav-a");
    const favB = nodeFor("/fav-b");
    const plainC = nodeFor("/plain-c");

    /* Both favorites share the top row; the plain group starts strictly below. */
    expect(favA.y).toBe(favB.y);
    expect(plainC.y).toBeGreaterThan(favA.y + favA.h);
    /* Within the band, the freshest (b, mtime 5000) sits left of the older (a). */
    expect(favB.x).toBeLessThan(favA.x);
  });

  test("no favorites lays the board out in a single band, unchanged", () => {
    const a = soloGroup("/a", 3_000);
    const b = soloGroup("/b", 5_000);
    const files = [a.file, b.file];
    const base = buildSchemeLayout([a.group, b.group], [], files, [], [], [], []);
    const withEmpty = buildSchemeLayout([a.group, b.group], [], files, [], [], [], [], new Set());
    const topY = (layout: ReturnType<typeof buildSchemeLayout>, path: string) =>
      layout.nodes.find((node) => node.file.path === path)!.y;
    expect(topY(base, "/a")).toBe(topY(base, "/b"));
    expect(topY(withEmpty, "/a")).toBe(topY(base, "/a"));
  });

  test("a favorited manual root lifts into the band too", () => {
    const fav = entry({ path: "/manual-fav", mtime: 9_000, activity: "live" });
    const plain = soloGroup("/plain", 1_000);
    const layout = buildSchemeLayout([plain.group], [fav], [fav, plain.file], [], [], [], [], new Set(["/manual-fav"]));
    const favNode = layout.nodes.find((node) => node.file.path === "/manual-fav")!;
    const plainNode = layout.nodes.find((node) => node.file.path === "/plain")!;
    expect(plainNode.y).toBeGreaterThan(favNode.y + favNode.h);
  });
});

describe("bounded attention-first rest bands (#343)", () => {
  const solo = (index: number, activity: FileEntry["activity"] = "idle") => {
    const file = entry({ path: `/rest-${index}`, activity, mtime: index });
    const group: BranchGroup = {
      key: file.path,
      columns: [{ file, tasks: [] }],
      returnable: [],
      finished: [],
      smt: file.mtime,
      orphanTask: false,
    };
    return { file, group };
  };

  test("wraps a long quiet row while keeping live work at the band head", () => {
    const rows = Array.from({ length: 40 }, (_, index) => solo(index));
    const live = solo(99, "live");
    const layout = buildSchemeLayout([...rows.map((row) => row.group), live.group], [], [...rows.map((row) => row.file), live.file]);
    const liveNode = layout.nodes.find((node) => node.file.path === live.file.path)!;

    expect(liveNode.x).toBe(100);
    expect(layout.nodes.some((node) => node.y > liveNode.y)).toBe(true);
    expect(Math.max(...layout.nodes.map((node) => node.x + node.w))).toBeLessThanOrEqual(REST_BAND_MAX_W + 100);
  });

  test("a fresh memberless pipeline leaves the rest-band head unchanged", () => {
    const row = solo(1);
    const pipeline = ({
      id: "fresh-pipeline", task: "Fresh pipeline", project: "demo", repoDir: "/r", worktreeDir: "/w",
      branch: "fresh", baseBranch: "main", baseRef: "a", lastPassedCommit: "a", stages: [], runs: [],
      cursor: null, state: "draft", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
      createdAt: "1970", closedAt: null,
    }) as unknown as Pipeline;
    const layout = buildSchemeLayout([row.group], [], [row.file], [], [], [pipeline], [pipeline]);

    expect(layout.groups.some((group) => group.id === pipeline.id)).toBe(false);
    expect(layout.nodes[0]!.x).toBe(100);
    expect(layout.nodes[0]!.y).toBe(100);
    expect(layout.slots).toHaveLength(0);
  });

  test("a pipeline whose only transcript is folded into an under-deck moves to the shelf", () => {
    const host = entry({ path: "/host", activity: "live" });
    const folded = entry({ path: "/host/old", parent: "/host" });
    const group: BranchGroup = { key: "/host", columns: [{ file: host, tasks: [] }], returnable: [], finished: [folded], smt: host.mtime, orphanTask: false };
    const pipeline = ({
      id: "folded-pipe", task: "Folded attempt", project: "demo", repoDir: "/r", worktreeDir: "/w",
      branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
      stages: [{ id: "build", kind: "run", prompt: "", next: null }],
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", agentPath: "/host/old", flowId: null }] }],
      cursor: { stageId: "build", state: "failed" }, state: "running", pausedState: null, stateDetail: null,
      srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
    }) as unknown as Pipeline;
    const layout = buildSchemeLayout([group], [], [host, folded], [], [], [pipeline], [pipeline]);

    expect(layout.nodes.map((node) => node.file.path)).toEqual(["/host"]);
    expect(layout.nodes[0]!.under.map((file) => file.path)).toEqual(["/host/old"]);
    expect(layout.groups.some((candidate) => candidate.kind === "pipeline" && candidate.id === "folded-pipe")).toBe(false);
  });

  test("audit-scale 100-card layout plus 150 auto cards fits above the 12% floor", () => {
    const rows = Array.from({ length: 100 }, (_, index) => solo(index));
    const board = buildSchemeLayout(rows.map((row) => row.group), [], rows.map((row) => row.file));
    const autoCards = Array.from({ length: 150 }, (_, index) => ({
      ...autoTaskSlotPosition(index),
      w: TASK_W,
      h: 184,
    }));
    const world = taskWorldBounds(board.width, board.height, autoCards);
    const fitAll = Math.min((1920 - 48) / world.w, (1080 - 48) / world.h, 1);

    expect(fitAll).toBeGreaterThan(0.12);
  });
});

describe("direct one-shot review groups on the scheme (issue #325)", () => {
  const directReviewer = (pathname: string, id: string, mtime: number, verdict: "APPROVE" | "REQUEST_CHANGES" | null = null): FileEntry => entry({
    path: pathname,
    parent: "/orchestrator",
    conversationId: id,
    mtime,
    activity: verdict ? "idle" : "live",
    durableLineage: {
      kind: "review",
      role: "reviewer",
      parentConversationId: "conversation-orchestrator",
      reviewsConversationId: "conversation-builder",
      memberships: [],
    },
    ...(verdict ? { review: { verdict, findingsCount: verdict === "APPROVE" ? 0 : 2, observedAt: "2026-07-10T02:00:00.000Z" } } : {}),
  });

  function directLayoutFixture() {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const done = directReviewer("/reviewer-1", "conversation-r1", 1_000, "REQUEST_CHANGES");
    const live = directReviewer("/reviewer-2", "conversation-r2", 2_000);
    const files = [builder, done, live];
    const projected = directReviewFlows({ files, flows: [], tasks: [] });
    const group: BranchGroup = {
      key: builder.path,
      columns: [{ file: builder, tasks: [] }],
      returnable: [],
      finished: [],
      smt: builder.mtime,
      orphanTask: false,
    };
    return { files, projected, group };
  }

  test("the synthetic group places a round deck beside the reviewed conversation", () => {
    const { files, projected, group } = directLayoutFixture();
    expect(projected).toHaveLength(1);
    const layout = buildSchemeLayout([group], [], files, projected, []);

    expect(layout.decks).toHaveLength(1);
    const deck = layout.decks[0]!;
    expect(deck.key).toBe(deckKey(projected[0]!.id));
    expect(deck.rounds.map((round) => round.file?.path)).toEqual(["/reviewer-1", "/reviewer-2"]);
    /* Deck geometry mirrors the managed review-loop pair: beside the node. */
    const node = layout.nodes.find((candidate) => candidate.file.path === "/builder")!;
    expect(deck.x).toBeGreaterThan(node.x + node.w);
    expect(deck.y).toBe(node.y);
    expect(layout.loops).toHaveLength(1);
    expect(layout.byPath.get(deck.key)).toBe(deck);
  });

  test("a direct group never grows an interactive flow hub or a flow halo", () => {
    const { files, projected, group } = directLayoutFixture();
    const layout = buildSchemeLayout([group], [], files, projected, []);

    /* No PATCH-backed control surface may exist for a synthetic id: no flow
       link (the FlowHub host) and no flow group halo (the override panel host). */
    expect(layout.links.some((link) => link.key === flowLinkKey(projected[0]!.id))).toBe(false);
    expect(layout.groups.some((halo) => halo.id === projected[0]!.id)).toBe(false);
  });

  test("a managed flow on the same board keeps its hub and halo beside a direct group", () => {
    const { files, projected, group } = directLayoutFixture();
    const impl = entry({ path: "/impl", activity: "live" });
    const managed = flow({ id: "flow-managed", implementerPath: "/impl" });
    const managedGroup: BranchGroup = {
      key: impl.path,
      columns: [{ file: impl, tasks: [] }],
      returnable: [],
      finished: [],
      smt: impl.mtime,
      orphanTask: false,
    };
    const layout = buildSchemeLayout([group, managedGroup], [], [...files, impl], [...projected, managed], []);

    expect(layout.decks).toHaveLength(2);
    expect(layout.links.some((link) => link.key === flowLinkKey("flow-managed"))).toBe(true);
    expect(layout.groups.some((halo) => halo.id === "flow-managed")).toBe(true);
    expect(layout.groups.some((halo) => halo.id === projected[0]!.id)).toBe(false);
  });
});
