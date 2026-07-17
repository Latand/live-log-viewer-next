import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { classifyWorker, shouldCollapseWorker } from "@/components/scheme/workerCollapse";

import { claimedReviewerPaths, foldClaimedReviewers } from "./flowModel";
import { directReviewFlows, isDirectReviewFlow } from "./directReviewGroups";

/*
 * Issue #325: Viewer-managed one-shot reviewers spawned directly through
 * /api/spawn (durable role=reviewer + reviewsConversationId, no flow/pipeline
 * membership) must enter the SAME review-deck projection managed flows use.
 * These fixtures are production-shaped: durable lineage as /api/files projects
 * it, board tasks as the tasks store serves them, alias maps as the registry
 * publishes them.
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

/** A direct /api/spawn reviewer exactly as /api/files projects it: a durable
    review edge, no flow/pipeline memberships. */
function directReviewer(
  path: string,
  opts: Partial<FileEntry> & { id: string; reviews: string },
): FileEntry {
  const { id, reviews, ...rest } = opts;
  return entry({
    path,
    parent: rest.parent ?? "/orchestrator",
    conversationId: id,
    durableLineage: {
      kind: "review",
      role: "reviewer",
      parentConversationId: "conversation-orchestrator",
      reviewsConversationId: reviews,
      memberships: [],
    },
    ...rest,
  });
}

function task(overrides: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    project: "demo",
    status: "assigned",
    text: "Fix the flaky deploy gate",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

const assignment = (conversationId: string, at = "2026-07-10T01:00:00.000Z") => ({
  path: null,
  conversationId,
  panePid: null,
  state: "delivered" as const,
  error: null,
  at,
});

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function managedFlow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
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

describe("directReviewFlows", () => {
  test("a direct one-shot reviewer projects into a synthetic review-deck flow", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const reviewer = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-builder", activity: "live", mtime: 2_000 });

    const projected = directReviewFlows({ files: [builder, reviewer], flows: [], tasks: [] });

    expect(projected).toHaveLength(1);
    const flow = projected[0]!;
    expect(flow.id).toBe("direct-review::subject::conversation-builder");
    expect(isDirectReviewFlow(flow)).toBe(true);
    expect(isDirectReviewFlow(managedFlow({ id: "f1", implementerPath: "/x" }))).toBe(false);
    expect(flow.implementerPath).toBe("/builder");
    expect(flow.implementerConversationId).toBe("conversation-builder");
    expect(flow.project).toBe("demo");
    expect(flow.state).toBe("reviewing");
    expect(flow.rounds).toHaveLength(1);
    expect(flow.rounds[0]!.n).toBe(1);
    expect(flow.rounds[0]!.reviewerPath).toBe("/reviewer-1");
    expect(flow.rounds[0]!.reviewerConversationId).toBe("conversation-r1");
    expect(flow.rounds[0]!.verdict).toBeNull();
    /* The synthetic flow claims its reviewers exactly like a managed flow, so
       the existing folding contract removes them from the board file set. */
    expect(claimedReviewerPaths(projected).has("/reviewer-1")).toBe(true);
    const folded = foldClaimedReviewers([builder, reviewer], projected);
    expect(folded.map((file) => file.path)).toEqual(["/builder"]);
  });

  test("repeated direct rounds stack into one deck with verdict-bearing history", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const r1 = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-builder",
      mtime: 1_000,
      review: { verdict: "REQUEST_CHANGES", findingsCount: 3, observedAt: "2026-07-10T02:00:00.000Z" },
    });
    const r2 = directReviewer("/reviewer-2", {
      id: "conversation-r2",
      reviews: "conversation-builder",
      mtime: 2_000,
      review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T03:00:00.000Z" },
    });
    const r3 = directReviewer("/reviewer-3", { id: "conversation-r3", reviews: "conversation-builder", mtime: 3_000, activity: "live" });

    // Input order shuffled on purpose: rounds order by transcript age.
    const projected = directReviewFlows({ files: [r3, builder, r1, r2], flows: [], tasks: [] });

    expect(projected).toHaveLength(1);
    const flow = projected[0]!;
    expect(flow.rounds.map((round) => round.n)).toEqual([1, 2, 3]);
    expect(flow.rounds.map((round) => round.reviewerPath)).toEqual(["/reviewer-1", "/reviewer-2", "/reviewer-3"]);
    expect(flow.rounds.map((round) => round.verdict)).toEqual(["REQUEST_CHANGES", "APPROVE", null]);
    expect(flow.rounds[0]!.findingsCount).toBe(3);
    expect(flow.rounds[0]!.reviewedAt).toBe("2026-07-10T02:00:00.000Z");
    expect(flow.state).toBe("reviewing");
    expect(flow.roundLimit).toBe(0);
  });

  test("a shared board task groups reviewers across distinct builder conversations and generations", () => {
    const builderA = entry({ path: "/builder-a-gen2", conversationId: "conversation-builder-a" });
    const builderAOld = entry({ path: "/builder-a-gen1", conversationId: "conversation-builder-a", migratedTo: "/builder-a-gen2" });
    const builderB = entry({ path: "/builder-b", conversationId: "conversation-builder-b", activity: "live", mtime: 5_000 });
    const r1 = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-builder-a",
      mtime: 1_000,
      review: { verdict: "REQUEST_CHANGES", findingsCount: 2, observedAt: "2026-07-10T02:00:00.000Z" },
    });
    const r2 = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder-b", mtime: 6_000, activity: "live" });
    const shared = task({
      id: "task-quota",
      assignments: [assignment("conversation-builder-a"), assignment("conversation-builder-b", "2026-07-10T04:00:00.000Z")],
    });

    const projected = directReviewFlows({ files: [builderA, builderAOld, builderB, r1, r2], flows: [], tasks: [shared] });

    expect(projected).toHaveLength(1);
    const flow = projected[0]!;
    expect(flow.id).toBe("direct-review::task::task-quota");
    /* The deck anchors beside the freshest reviewed conversation, its CURRENT
       generation — never an archived predecessor path. */
    expect(flow.implementerPath).toBe("/builder-b");
    expect(flow.rounds.map((round) => round.reviewerPath)).toEqual(["/reviewer-1", "/reviewer-2"]);
  });

  test("a delayed task assignment re-keys the group without losing rounds", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const r1 = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-builder",
      mtime: 1_000,
      review: { verdict: "REQUEST_CHANGES", findingsCount: 1, observedAt: "2026-07-10T02:00:00.000Z" },
    });
    const r2 = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder", mtime: 2_000, activity: "live" });

    const before = directReviewFlows({ files: [builder, r1, r2], flows: [], tasks: [] });
    expect(before).toHaveLength(1);
    expect(before[0]!.id).toBe("direct-review::subject::conversation-builder");
    expect(before[0]!.rounds).toHaveLength(2);

    const late = task({ id: "task-late", assignments: [assignment("conversation-builder")] });
    const after = directReviewFlows({ files: [builder, r1, r2], flows: [], tasks: [late] });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe("direct-review::task::task-late");
    expect(after[0]!.rounds.map((round) => round.reviewerPath)).toEqual(["/reviewer-1", "/reviewer-2"]);
  });

  test("distinct task ids isolate groups even when the reviewed conversation overlaps", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const r1 = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-builder", mtime: 1_000 });
    const r2 = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder", mtime: 2_000 });
    const t1 = task({ id: "task-one", assignments: [assignment("conversation-r1")] });
    const t2 = task({ id: "task-two", assignments: [assignment("conversation-r2")] });

    const projected = directReviewFlows({ files: [builder, r1, r2], flows: [], tasks: [t1, t2] });

    expect(projected.map((flow) => flow.id).sort()).toEqual([
      "direct-review::task::task-one",
      "direct-review::task::task-two",
    ]);
    for (const flow of projected) {
      expect(flow.rounds).toHaveLength(1);
      expect(flow.implementerPath).toBe("/builder");
    }
  });

  test("an alias-remapped reviewsConversationId joins the canonical subject group", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    /* r1 was spawned against a provisional id the registry later aliased. */
    const r1 = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-provisional",
      mtime: 1_000,
      review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T02:00:00.000Z" },
    });
    const r2 = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder", mtime: 2_000, activity: "live" });

    const projected = directReviewFlows({
      files: [builder, r1, r2],
      flows: [],
      tasks: [],
      conversationAliases: { "conversation-provisional": "conversation-builder" },
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]!.id).toBe("direct-review::subject::conversation-builder");
    expect(projected[0]!.implementerPath).toBe("/builder");
    expect(projected[0]!.rounds.map((round) => round.reviewerPath)).toEqual(["/reviewer-1", "/reviewer-2"]);
  });

  test("managed flow and pipeline reviewers never enter the direct projection", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder" });
    const flowMember = directReviewer("/reviewer-flow", { id: "conversation-rf", reviews: "conversation-builder" });
    flowMember.durableLineage!.memberships = [{
      kind: "flow",
      containerId: "flow-1",
      role: "reviewer",
      slot: "reviewer:1",
      stageId: null,
      stageOrder: null,
      round: 1,
      parentConversationId: "conversation-builder",
    }];
    const pipelineMember = directReviewer("/reviewer-pipe", { id: "conversation-rp", reviews: "conversation-builder" });
    pipelineMember.durableLineage!.memberships = [{
      kind: "pipeline",
      containerId: "pipe-1",
      role: "reviewer",
      slot: "review",
      stageId: "review",
      stageOrder: 1,
      round: null,
      parentConversationId: null,
    }];
    /* A legacy round claim (path recorded on a real flow) also excludes. */
    const claimed = directReviewer("/reviewer-claimed", { id: "conversation-rc", reviews: "conversation-builder" });
    const owner = managedFlow({
      id: "flow-real",
      implementerPath: "/builder",
      rounds: [{
        n: 1,
        reviewerPath: "/reviewer-claimed",
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

    const projected = directReviewFlows({ files: [builder, flowMember, pipelineMember, claimed], flows: [owner], tasks: [] });
    expect(projected).toHaveLength(0);
  });

  test("failed-before-verdict history rounds read as aborted while the latest stays actionable", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    /* r1 died without a verdict (idle, no review outcome), r2 is the retry. */
    const r1 = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-builder", mtime: 1_000 });
    const r2 = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder", mtime: 2_000, activity: "live" });

    const projected = directReviewFlows({ files: [builder, r1, r2], flows: [], tasks: [] });
    expect(projected).toHaveLength(1);
    const rounds = projected[0]!.rounds;
    expect(rounds[0]!.error).toBe("no verdict");
    expect(rounds[1]!.error).toBeNull();
    expect(projected[0]!.state).toBe("reviewing");

    /* A still-running earlier reviewer is NOT mislabelled as aborted. */
    const r1Live = { ...r1, activity: "live" as const };
    const live = directReviewFlows({ files: [builder, r1Live, r2], flows: [], tasks: [] });
    expect(live[0]!.rounds[0]!.error).toBeNull();
  });

  test("a terminal-only group parks as compact history instead of an actionable loop", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder" });
    const r1 = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-builder",
      mtime: 1_000,
      review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T02:00:00.000Z" },
    });

    const projected = directReviewFlows({ files: [builder, r1], flows: [], tasks: [] });
    expect(projected).toHaveLength(1);
    expect(projected[0]!.state).toBe("done_comment");
  });

  test("an active managed flow on the reviewed conversation keeps its deck — the direct group yields", () => {
    /* One node hosts one deck: a builder that is ALSO an implementer of a live
       managed loop keeps that loop's deck and controls; direct reviewers stay
       with today's worker-stack behavior. A CLOSED flow does not block. */
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const reviewer = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-builder", activity: "live" });
    const active = managedFlow({ id: "flow-live", implementerPath: "/builder" });
    expect(directReviewFlows({ files: [builder, reviewer], flows: [active], tasks: [] })).toHaveLength(0);

    const closed = managedFlow({ id: "flow-closed", implementerPath: "/builder", state: "closed", closedAt: "2026-07-09T00:00:00Z" });
    expect(directReviewFlows({ files: [builder, reviewer], flows: [closed], tasks: [] })).toHaveLength(1);
  });

  test("a reviewer whose reviewed conversation left the scan projects nothing", () => {
    const reviewer = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-gone" });
    expect(directReviewFlows({ files: [reviewer], flows: [], tasks: [] })).toHaveLength(0);
  });

  test("archived reviewer generations fold into their current generation's round", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const old = entry({ path: "/reviewer-gen1", conversationId: "conversation-r1", migratedTo: "/reviewer-gen2" });
    const current = directReviewer("/reviewer-gen2", { id: "conversation-r1", reviews: "conversation-builder", mtime: 2_000, activity: "live" });

    const projected = directReviewFlows({ files: [builder, old, current], flows: [], tasks: [] });
    expect(projected).toHaveLength(1);
    expect(projected[0]!.rounds).toHaveLength(1);
    expect(projected[0]!.rounds[0]!.reviewerPath).toBe("/reviewer-gen2");
  });

  test("a self-review edge never groups a conversation under itself", () => {
    const strange = directReviewer("/self", { id: "conversation-self", reviews: "conversation-self" });
    expect(directReviewFlows({ files: [strange], flows: [], tasks: [] })).toHaveLength(0);
  });

  test("composition: worker collapse treats the synthetic group like a managed flow", () => {
    const builder = entry({ path: "/builder", conversationId: "conversation-builder", activity: "live" });
    const done = directReviewer("/reviewer-1", {
      id: "conversation-r1",
      reviews: "conversation-builder",
      mtime: 1_000,
      review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T02:00:00.000Z" },
    });
    const live = directReviewer("/reviewer-2", { id: "conversation-r2", reviews: "conversation-builder", mtime: 2_000, activity: "live" });

    const projected = directReviewFlows({ files: [builder, done, live], flows: [], tasks: [] });
    const context = { flows: projected, pipelineStagePaths: new Set<string>(), nowMs: 2_000_000, idleMs: 900_000, pinnedPaths: new Set<string>() };

    expect(classifyWorker(done, context)).toBe("flow-reviewer");
    /* A verdict round folds immediately; the live latest never collapses. */
    expect(shouldCollapseWorker(done, context)).toBe(true);
    expect(shouldCollapseWorker(live, context)).toBe(false);
  });
});
