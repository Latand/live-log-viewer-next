import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { directReviewFlows } from "@/components/flows/directReviewGroups";
import { type BranchGroup, buildBranchGroups } from "@/components/projectModel";

import { deckKey, groupRect } from "./agentLinks";
import { buildSchemeLayout, type SchemeLayout, type SchemeRect } from "./layout";

/*
 * Region geometry regressions for issue #531: every pipeline's colored halo is
 * the single ownership region of its conversations, and two regions never
 * intersect. The fixtures below are production-shaped: real branch groups, real
 * stage attempts, folded/unfolded review decks, quiet history, host-loss and
 * publish-to-scan (delayed materialization) gaps.
 */

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
    rounds: [],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

const round = (n: number, reviewerPath: string | null): Flow["rounds"][number] => ({
  n,
  reviewerPath,
  findingsPath: null,
  triggeredBy: "marker",
  readyNote: null,
  verdict: null,
  findingsCount: null,
  startedAt: "2026-07-05T00:00:00Z",
  reviewedAt: null,
  relayedAt: null,
  error: null,
});

const pipe = (over: Record<string, unknown>): Pipeline =>
  ({
    id: "p1", task: "Keep regions", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
    baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [{ id: "build", kind: "run", prompt: "", next: null }],
    runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null, srcPath: null,
    srcConversationId: null, createdAt: "1970", closedAt: null, ...over,
  }) as unknown as Pipeline;

/* Two rects are disjoint with at least `gap` unclaimed pixels between them. */
const disjointWithGap = (a: SchemeRect, b: SchemeRect, gap: number): boolean =>
  a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;

const contains = (outer: SchemeRect, inner: SchemeRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/* The stable visible corridor two neighboring regions must keep (world px). At
   62% lite zoom this still reads as a ~15px on-screen gap. */
const REGION_GAP = 24;

function expectRegionsSeparated(layout: SchemeLayout) {
  const regions = layout.groups;
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i]!;
      const b = regions[j]!;
      expect(
        disjointWithGap(a, b, REGION_GAP),
        `regions ${a.key} ${JSON.stringify({ x: a.x, y: a.y, w: a.w, h: a.h })} and ${b.key} ${JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h })} must keep a ${REGION_GAP}px gap`,
      ).toBe(true);
    }
  }
}

function haloOf(layout: SchemeLayout, pipelineId: string) {
  const halo = layout.groups.find((group) => group.kind === "pipeline" && group.id === pipelineId);
  expect(halo, `pipeline ${pipelineId} must own a colored region`).toBeTruthy();
  return halo!;
}

/* Every board surface of the pipeline — member cards plus their slots — must sit
   fully inside the pipeline's own region. */
function expectMembersContained(layout: SchemeLayout, pipelineId: string) {
  const halo = haloOf(layout, pipelineId);
  for (const key of halo.members) {
    const rect = layout.byPath.get(key);
    expect(rect, `member ${key} of ${pipelineId} must be a placed rect`).toBeTruthy();
    expect(
      contains(halo, rect!),
      `member ${key} ${JSON.stringify(rect)} escapes region ${JSON.stringify({ x: halo.x, y: halo.y, w: halo.w, h: halo.h })}`,
    ).toBe(true);
  }
  for (const slot of layout.slots.filter((candidate) => candidate.pipeline.id === pipelineId)) {
    expect(contains(halo, slot), `slot ${slot.key} escapes its pipeline region`).toBe(true);
  }
}

describe("neighboring pipeline regions never intersect (#531)", () => {
  /* Production shape: one origin conversation spawned two pipeline builders.
     Each pipeline still has future stages, so each grows a slot row under its
     builder tip. The two rows are wider than the builder cards — without space
     reservation they collide and the two colored regions overlap. */
  const twoPipelineScene = (stageState: string, attemptOver: Record<string, unknown> = {}) => {
    const origin = entry({ path: "/origin", activity: "live" });
    const builderA = entry({ path: "/origin/a", parent: "/origin", kind: "subagent", activity: "live" });
    const builderB = entry({ path: "/origin/b", parent: "/origin", kind: "subagent", activity: "live" });
    const files = [origin, builderA, builderB];
    const stages = [
      { id: "build", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: "polish", onFail: { to: "build", maxRounds: 5 } },
      { id: "polish", kind: "run", prompt: "", next: null },
    ];
    const pipelineOf = (id: string, agentPath: string) => pipe({
      id,
      stages,
      cursor: { stageId: "build", state: stageState, input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: stageState, agentPath, flowId: null, ...attemptOver }] }],
    });
    const pipelines = [pipelineOf("pa", "/origin/a"), pipelineOf("pb", "/origin/b")];
    const groups = buildBranchGroups(files, "demo");
    return buildSchemeLayout(groups, [], files, [], [], pipelines, pipelines);
  };

  test("two live sibling pipelines with future-stage slot rows keep disjoint regions", () => {
    const layout = twoPipelineScene("running");
    expect(layout.slots.filter((slot) => slot.pipeline.id === "pa")).toHaveLength(2);
    expect(layout.slots.filter((slot) => slot.pipeline.id === "pb")).toHaveLength(2);
    expectRegionsSeparated(layout);
    expectMembersContained(layout, "pa");
    expectMembersContained(layout, "pb");
    /* The two slot rows themselves never intersect either. */
    for (const a of layout.slots.filter((slot) => slot.pipeline.id === "pa")) {
      for (const b of layout.slots.filter((slot) => slot.pipeline.id === "pb")) {
        expect(disjointWithGap(a, b, 0), `${a.key} intersects ${b.key}`).toBe(true);
      }
    }
  });

  test("parked (needs_decision) neighbors keep disjoint regions", () => {
    const layout = twoPipelineScene("needs_decision");
    expectRegionsSeparated(layout);
    expectMembersContained(layout, "pa");
    expectMembersContained(layout, "pb");
  });

  test("host loss / delayed materialization (published transcripts not yet scanned) keeps disjoint regions", () => {
    /* The builder attempts have published agentPaths, but the runtime host died
       before the scanner surfaced them: no scene node exists, every stage rides
       its placeholder. Both pipelines still own separated regions. */
    const origin = entry({ path: "/origin", activity: "live" });
    const files = [origin];
    const stages = [
      { id: "build", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ];
    const pipelineOf = (id: string, agentPath: string) => pipe({
      id,
      stages,
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath, flowId: null }] }],
    });
    const pipelines = [pipelineOf("pa", "/lost/a"), pipelineOf("pb", "/lost/b")];
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], pipelines, pipelines);
    expect(layout.slots.filter((slot) => slot.pipeline.id === "pa")).toHaveLength(2);
    expect(layout.slots.filter((slot) => slot.pipeline.id === "pb")).toHaveLength(2);
    expectRegionsSeparated(layout);
    expectMembersContained(layout, "pa");
    expectMembersContained(layout, "pb");
  });

  test("completed stages standing in as full cards keep neighboring regions disjoint", () => {
    /* Both pipelines finished build + review; the idle transcripts are not live
       nodes, so both stages stand in as completed cards — a two-card row under
       no tip for pa/pb still reads as two separated regions. */
    const origin = entry({ path: "/origin", activity: "live" });
    const builderA = entry({ path: "/origin/a", parent: "/origin", kind: "subagent", activity: "live" });
    const builderB = entry({ path: "/origin/b", parent: "/origin", kind: "subagent", activity: "live" });
    const files = [origin, builderA, builderB];
    const stages = [
      { id: "build", kind: "run", prompt: "", next: "verify" },
      { id: "verify", kind: "run", prompt: "", next: "polish" },
      { id: "polish", kind: "run", prompt: "", next: null },
    ];
    const pipelineOf = (id: string, livePath: string, historicPath: string) => pipe({
      id,
      stages,
      cursor: { stageId: "polish", state: "running", input: null, activatedBy: null },
      runs: [
        { stageId: "build", attempts: [{ n: 1, state: "passed", agentPath: historicPath, flowId: null }] },
        { stageId: "verify", attempts: [{ n: 1, state: "passed", agentPath: `${historicPath}-verify`, flowId: null }] },
        { stageId: "polish", attempts: [{ n: 1, state: "running", agentPath: livePath, flowId: null }] },
      ],
    });
    const pipelines = [pipelineOf("pa", "/origin/a", "/hist/a"), pipelineOf("pb", "/origin/b", "/hist/b")];
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], pipelines, pipelines);
    const completed = layout.slots.filter((slot) => slot.presentation === "completed");
    expect(completed.length).toBe(4);
    expectRegionsSeparated(layout);
    expectMembersContained(layout, "pa");
    expectMembersContained(layout, "pb");
  });

  test("a standalone review flow launched under a pipeline stage keeps its own separated region", () => {
    /* Screenshot shape (#531 comment): the pipeline halo and a review-flow zone
       overlap. A managed flow whose implementer hangs under the pipeline's
       builder must own a region beside/below the pipeline's — never inside it. */
    const builder = entry({ path: "/builder", activity: "live" });
    const codex = entry({ path: "/builder/codex", parent: "/builder", kind: "subagent", activity: "live" });
    const files = [builder, codex];
    const pipeline = pipe({
      stages: [
        { id: "build", kind: "run", prompt: "", next: "review" },
        { id: "review", kind: "review-loop", prompt: "", next: null },
      ],
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/builder", flowId: null }] }],
    });
    const sideFlow = flow({ id: "f-side", implementerPath: "/builder/codex", rounds: [round(1, null)] });
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [sideFlow], [], [pipeline], [pipeline]);

    const pipelineHalo = haloOf(layout, "p1");
    const flowHalo = layout.groups.find((group) => group.kind === "flow" && group.id === "f-side");
    expect(flowHalo).toBeTruthy();
    expect(
      disjointWithGap(pipelineHalo, flowHalo!, REGION_GAP),
      `pipeline region ${JSON.stringify({ x: pipelineHalo.x, y: pipelineHalo.y, w: pipelineHalo.w, h: pipelineHalo.h })} overlaps review-flow region ${JSON.stringify({ x: flowHalo!.x, y: flowHalo!.y, w: flowHalo!.w, h: flowHalo!.h })}`,
    ).toBe(true);
    expectMembersContained(layout, "p1");
  });
});

describe("stage surfaces keep stable lineage anchors (#531 round 1)", () => {
  /* The pipeline was launched from /origin (srcPath lineage). Stage transcripts
     materialize as children of that conversation, in stage order. The stage
     chain must therefore anchor at the SAME world coordinates from the very
     first unscanned render: a stage's placeholder and the live pane that later
     replaces it share one anchor, and no other stage's surface moves when a
     neighbor materializes. */
  const anchorOfSurface = (layout: SchemeLayout, pipelineId: string, stageId: string, nodePath: string): { x: number; y: number } => {
    const node = layout.nodes.find((candidate) => candidate.file.path === nodePath);
    if (node) return { x: node.x, y: node.y };
    const slot = layout.slots.find((candidate) => candidate.pipeline.id === pipelineId && candidate.stage.id === stageId);
    expect(slot, `stage ${stageId} must own a surface`).toBeTruthy();
    return { x: slot!.x, y: slot!.y };
  };

  test("anchors are identical across unscanned → materialized → host-loss", () => {
    const origin = entry({ path: "/origin", activity: "live" });
    const buildFile = entry({ path: "/origin/build", parent: "/origin", kind: "subagent", activity: "live" });
    const stages = [
      { id: "build", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ];
    const pipeline = () => pipe({
      srcPath: "/origin",
      stages,
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/origin/build", flowId: null }] }],
    });
    const layoutOf = (files: FileEntry[]) => {
      const p = pipeline();
      return buildSchemeLayout(buildBranchGroups(files, "demo"), [], files, [], [], [p], [p]);
    };

    /* A: publish-to-scan gap (also the host-loss-before-scan shape): /origin/build
       is published but not yet a scene file. */
    const unscanned = layoutOf([origin]);
    /* B: the build transcript materialized as a child of the src conversation. */
    const materialized = layoutOf([origin, buildFile]);
    /* C: host loss after materialization: the transcript file survives idle. */
    const hostLost = layoutOf([origin, { ...buildFile, activity: "idle" as const }]);

    const buildA = anchorOfSurface(unscanned, "p1", "build", "/origin/build");
    const buildB = anchorOfSurface(materialized, "p1", "build", "/origin/build");
    const buildC = anchorOfSurface(hostLost, "p1", "build", "/origin/build");
    expect(materialized.nodes.map((node) => node.file.path)).toContain("/origin/build");
    expect(buildB).toEqual(buildA);
    expect(buildC).toEqual(buildA);

    const reviewA = anchorOfSurface(unscanned, "p1", "review", "/none");
    const reviewB = anchorOfSurface(materialized, "p1", "review", "/none");
    const reviewC = anchorOfSurface(hostLost, "p1", "review", "/none");
    expect(reviewB).toEqual(reviewA);
    expect(reviewC).toEqual(reviewA);
    /* The chain reads left→right in stage order on one band. */
    expect(reviewA.x).toBeGreaterThan(buildA.x);
    expect(reviewA.y).toBe(buildA.y);
    expectRegionsSeparated(materialized);
    expectMembersContained(materialized, "p1");
  });

  test("sequentially materializing stages land exactly on their reserved anchors", () => {
    const origin = entry({ path: "/origin", activity: "live" });
    const s1 = entry({ path: "/origin/s1", parent: "/origin", kind: "subagent", activity: "live" });
    const s2 = entry({ path: "/origin/s2", parent: "/origin", kind: "subagent", activity: "live" });
    const stages = [
      { id: "one", kind: "run", prompt: "", next: "two" },
      { id: "two", kind: "run", prompt: "", next: "three" },
      { id: "three", kind: "run", prompt: "", next: null },
    ];
    const pipelineAt = (materializedCount: number) => pipe({
      srcPath: "/origin",
      stages,
      cursor: { stageId: stages[materializedCount - 1]!.id, state: "running", input: null, activatedBy: null },
      runs: [
        { stageId: "one", attempts: [{ n: 1, state: materializedCount > 1 ? "passed" : "running", agentPath: "/origin/s1", flowId: null }] },
        ...(materializedCount > 1 ? [{ stageId: "two", attempts: [{ n: 1, state: "running", agentPath: "/origin/s2", flowId: null }] }] : []),
      ],
    });
    const layoutOf = (files: FileEntry[], p: Pipeline) =>
      buildSchemeLayout(buildBranchGroups(files, "demo"), [], files, [], [], [p], [p]);

    const first = layoutOf([origin, s1], pipelineAt(1));
    const second = layoutOf([origin, s1, s2], pipelineAt(2));

    const anchor = (layout: SchemeLayout, stageId: string, nodePath: string) => anchorOfSurface(layout, "p1", stageId, nodePath);
    /* Stage two's live pane lands exactly on its placeholder's coordinates. */
    expect(anchor(second, "two", "/origin/s2")).toEqual(anchor(first, "two", "/none"));
    /* Neither the already-live stage one nor the future stage three moves. */
    expect(anchor(second, "one", "/origin/s1")).toEqual(anchor(first, "one", "/origin/s1"));
    expect(anchor(second, "three", "/none")).toEqual(anchor(first, "three", "/none"));
  });

  test("completed stages read chronologically left of the live pane, future stages to its right", () => {
    /* Stage history must read left→right: completed cards, then the live
       cursor pane, then the future placeholders — never a completed card
       dropping BELOW the live conversation. */
    const origin = entry({ path: "/origin", activity: "live" });
    const live = entry({ path: "/origin/polish", parent: "/origin", kind: "subagent", activity: "live" });
    const files = [origin, live];
    const stages = [
      { id: "build", kind: "run", prompt: "", next: "verify" },
      { id: "verify", kind: "run", prompt: "", next: "polish" },
      { id: "polish", kind: "run", prompt: "", next: "ship" },
      { id: "ship", kind: "run", prompt: "", next: null },
    ];
    const pipeline = pipe({
      srcPath: "/origin",
      stages,
      cursor: { stageId: "polish", state: "running", input: null, activatedBy: null },
      runs: [
        { stageId: "build", attempts: [{ n: 1, state: "passed", agentPath: "/hist/build", flowId: null }] },
        { stageId: "verify", attempts: [{ n: 1, state: "passed", agentPath: "/hist/verify", flowId: null }] },
        { stageId: "polish", attempts: [{ n: 1, state: "running", agentPath: "/origin/polish", flowId: null }] },
      ],
    });
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], [pipeline], [pipeline]);

    const slotOf = (stageId: string) => layout.slots.find((candidate) => candidate.stage.id === stageId)!;
    const liveNode = layout.nodes.find((candidate) => candidate.file.path === "/origin/polish")!;
    const buildSlot = slotOf("build");
    const verifySlot = slotOf("verify");
    const shipSlot = slotOf("ship");
    expect(buildSlot.presentation).toBe("completed");
    expect(verifySlot.presentation).toBe("completed");
    expect(shipSlot.presentation).toBe("placeholder");
    /* One chain band, chronological order. */
    for (const rect of [buildSlot, verifySlot, shipSlot]) expect(rect.y).toBe(liveNode.y);
    expect(buildSlot.x).toBeLessThan(verifySlot.x);
    expect(verifySlot.x).toBeLessThan(liveNode.x);
    expect(liveNode.x).toBeLessThan(shipSlot.x);
    expectMembersContained(layout, "p1");
  });
});

describe("every pipeline conversation surface stays inside its colored region (#531)", () => {
  test("quiet history and a direct one-shot review deck stay inside the pipeline region", () => {
    /* Production shape: the builder conversation of a live pipeline carries a
       quiet finished child (folded history) and a direct Codex one-shot review
       deck. Both belong to the pipeline's story and must sit inside its colored
       region. */
    const builder = entry({ path: "/builder", conversationId: "c-build", activity: "live" });
    const quiet = entry({ path: "/builder/quiet", parent: "/builder", kind: "subagent" });
    const reviewer = entry({
      path: "/builder/review-1",
      parent: "/builder",
      conversationId: "c-r1",
      activity: "live",
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "c-build",
        reviewsConversationId: "c-build",
        memberships: [],
      },
    });
    const files = [builder, quiet, reviewer];
    const projected = directReviewFlows({ files, flows: [], tasks: [] });
    expect(projected).toHaveLength(1);
    const group: BranchGroup = {
      key: builder.path,
      columns: [{ file: builder, tasks: [] }],
      returnable: [quiet],
      finished: [],
      smt: builder.mtime,
      orphanTask: false,
    };
    const pipeline = pipe({
      stages: [
        { id: "build", kind: "run", prompt: "", next: "review" },
        { id: "review", kind: "review-loop", prompt: "", next: null },
      ],
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/builder", flowId: null }] }],
    });
    const layout = buildSchemeLayout([group], [], files, projected, [], [pipeline], [pipeline]);

    const halo = haloOf(layout, "p1");
    const stack = layout.stacks.find((candidate) => candidate.parent === "/builder");
    expect(stack).toBeTruthy();
    expect(contains(halo, stack!), "the builder's quiet-history stack escapes the pipeline region").toBe(true);
    const deck = layout.decks.find((candidate) => candidate.key === deckKey(projected[0]!.id));
    expect(deck).toBeTruthy();
    expect(contains(halo, deck!), "the direct review deck escapes the pipeline region").toBe(true);
    expectMembersContained(layout, "p1");
  });

  test("an expanded review history (many-round deck) stays inside the pipeline region", () => {
    /* The pipeline's embedded review flow accumulated 7 rounds; its deck grows
       spines below the front card. The whole deck — collapsed or expanded — must
       stay a contained surface of the pipeline region. */
    const builder = entry({ path: "/builder", activity: "live" });
    const files = [builder];
    const rounds = Array.from({ length: 7 }, (_, index) => round(index + 1, null));
    const reviewFlow = flow({ id: "f-loop", implementerPath: "/builder", rounds });
    const pipeline = pipe({
      stages: [
        { id: "build", kind: "run", prompt: "", next: "review" },
        { id: "review", kind: "review-loop", prompt: "", next: null },
      ],
      cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
      state: "running",
      runs: [
        { stageId: "build", attempts: [{ n: 1, state: "passed", agentPath: "/builder", flowId: null }] },
        { stageId: "review", attempts: [{ n: 1, state: "reviewing", agentPath: null, flowId: "f-loop" }] },
      ],
    });
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [reviewFlow], [], [pipeline], [pipeline]);

    const halo = haloOf(layout, "p1");
    const deck = layout.decks.find((candidate) => candidate.key === deckKey("f-loop"));
    expect(deck).toBeTruthy();
    expect(contains(halo, deck!), "the review deck escapes the pipeline region").toBe(true);
    expectMembersContained(layout, "p1");
    expectRegionsSeparated(layout);
  });

  test("a task card linked to the pipeline is owned by the pipeline region (#531 round 1)", () => {
    /* The pipeline's board task (its work item) is a first-class member of the
       colored region: the layout places it inside the pipeline chain and the
       halo contains it, instead of leaving the sticky note wherever the lattice
       dropped it. */
    const builder = entry({ path: "/builder", activity: "live" });
    const files = [builder];
    const pipeline = pipe({
      taskIds: ["t-1"],
      stages: [
        { id: "build", kind: "run", prompt: "", next: "review" },
        { id: "review", kind: "review-loop", prompt: "", next: null },
      ],
      cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", agentPath: "/builder", flowId: null }] }],
    });
    const task: BoardTask = {
      id: "t-1",
      project: "demo",
      status: "assigned",
      text: "P0 #531 keep pipeline regions stable",
      placement: "pinned",
      pos: { x: 4000, y: 4000 },
      assignments: [],
      createdAt: "2026-07-05T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    } as unknown as BoardTask;
    const groups = buildBranchGroups(files, "demo");
    const layout = buildSchemeLayout(groups, [], files, [], [], [pipeline], [pipeline], new Set(), new Set(), [task]);

    const region = layout.regionTasks.find((candidate) => candidate.taskId === "t-1");
    expect(region, "the linked task must be placed by the pipeline region").toBeTruthy();
    expect(region!.pipelineId).toBe("p1");
    const halo = haloOf(layout, "p1");
    expect(contains(halo, region!), "the linked task card escapes the pipeline region").toBe(true);
    expect(layout.byPath.get("task::t-1")).toBe(region!);
    expect(halo.members).toContain("task::t-1");
    expectRegionsSeparated(layout);
  });

  test("groupRect stays a padded union of its member rects", () => {
    const rects = new Map<string, SchemeRect>([
      ["a", { x: 100, y: 100, w: 50, h: 50 }],
      ["b", { x: 300, y: 200, w: 40, h: 40 }],
    ]);
    const rect = groupRect(["a", "b", "missing"], (key) => rects.get(key) ?? null, 10);
    expect(rect).toEqual({ x: 90, y: 90, w: 260, h: 160 });
  });
});
