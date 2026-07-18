import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { protectedReviewerNodes } from "@/components/scheme/workerCollapse";

import {
  claimedReviewerDescendantPaths,
  flowPresentation,
  foldClaimedReviewers,
  isActiveFlow,
  reviewerBindingTargetsForRound,
  reviewerFileForRound,
  reviewerFilesForRound,
} from "./flowModel";

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
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

const roleConfig = { engine: "codex" as const, model: null, effort: null };

function flow(overrides: Partial<Flow> & { implementerPath: string; reviewerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    id: "flow-1",
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
        reviewerPath: overrides.reviewerPath,
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

describe("reviewer folding", () => {
  test("resolves a resumed reviewer through its stable durable edge", () => {
    const resumed = entry({
      path: "/reviewer-resumed",
      conversationId: "conversation-reviewer",
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "conversation-implementer",
        reviewsConversationId: "conversation-implementer",
        memberships: [{
          kind: "flow",
          containerId: "flow-1",
          slot: "reviewer:3",
          role: "reviewer",
          round: 3,
          stageId: null,
          stageOrder: null,
          parentConversationId: "conversation-implementer",
        }],
      },
    });
    const archived = entry({
      path: "/reviewer-rotated-away",
      conversationId: "conversation-reviewer",
      migratedTo: resumed.path,
    });
    const currentFlow = flow({
      implementerPath: "/implementer",
      reviewerPath: "/reviewer-rotated-away",
      rounds: [{
        n: 3,
        reviewerPath: "/reviewer-rotated-away",
        reviewerConversationId: "conversation-reviewer",
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

    expect(reviewerFileForRound(currentFlow, currentFlow.rounds[0]!, [archived, resumed])).toBe(resumed);
    expect(reviewerFilesForRound(currentFlow, currentFlow.rounds[0]!, [archived, resumed])).toEqual([resumed]);
    expect(reviewerBindingTargetsForRound(currentFlow, currentFlow.rounds[0]!, [archived, resumed]).map((target) => target.path))
      .toEqual([resumed.path]);
  });

  test("projects every immutable reviewer retry into one logical round", () => {
    const reviewer = (path: string, conversationId: string, slot: string) => entry({
      path,
      conversationId,
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: "conversation-implementer",
        reviewsConversationId: "conversation-implementer",
        memberships: [{
          kind: "flow",
          containerId: "flow-1",
          slot,
          role: "reviewer",
          round: 2,
          stageId: null,
          stageOrder: null,
          parentConversationId: "conversation-implementer",
        }],
      },
    });
    const failed = reviewer("/reviewer-failed", "conversation-reviewer-a", "reviewer:2:binding-a");
    const current = reviewer("/reviewer-current", "conversation-reviewer-b", "reviewer:2:binding-b");
    const currentFlow = flow({
      implementerPath: "/implementer",
      reviewerPath: current.path,
      rounds: [{
        n: 2,
        reviewerPath: current.path,
        reviewerConversationId: failed.conversationId,
        reviewerBindingId: "binding-b",
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

    expect(reviewerFilesForRound(currentFlow, currentFlow.rounds[0]!, [current, failed]).map((file) => file.path))
      .toEqual([failed.path, current.path]);
    expect(reviewerBindingTargetsForRound(currentFlow, currentFlow.rounds[0]!, [current, failed]).map((target) => target.path))
      .toEqual([failed.path, current.path]);
  });

  test("keeps descendants available for expanded scheme placement", () => {
    const implementer = entry({ path: "/implementer" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer" });
    const subtask = entry({ path: "/subtask", parent: "/reviewer" });
    const sidecar = entry({ path: "/sidecar", parent: "/subtask" });
    const flows = [flow({ implementerPath: "/implementer", reviewerPath: "/reviewer" })];

    expect([...claimedReviewerDescendantPaths([implementer, reviewer, subtask, sidecar], flows)].sort()).toEqual([
      "/sidecar",
      "/subtask",
    ]);
    expect(foldClaimedReviewers([implementer, reviewer, subtask, sidecar], flows).map((file) => [file.path, file.parent])).toEqual([
      ["/implementer", null],
      ["/subtask", "/implementer"],
      ["/sidecar", "/subtask"],
    ]);
  });

  test("re-homes reviewer descendants under the resumed implementer generation", () => {
    const implementer = entry({ path: "/implementer-resumed", conversationId: "conversation-implementer" });
    const archived = entry({
      path: "/implementer-archived",
      conversationId: implementer.conversationId,
      migratedTo: implementer.path,
    });
    const reviewer = entry({
      path: "/reviewer",
      durableLineage: {
        kind: "review",
        role: "reviewer",
        parentConversationId: implementer.conversationId!,
        reviewsConversationId: implementer.conversationId!,
        memberships: [{
          kind: "flow",
          containerId: "flow-1",
          slot: "reviewer:1:binding",
          role: "reviewer",
          round: 1,
          stageId: null,
          stageOrder: null,
          parentConversationId: implementer.conversationId!,
        }],
      },
    });
    const child = entry({ path: "/reviewer-child", parent: reviewer.path });

    const folded = foldClaimedReviewers([implementer, archived, reviewer, child], [flow({
      implementerPath: implementer.path,
      reviewerPath: reviewer.path,
    })]);

    expect(folded.find((file) => file.path === child.path)?.parent).toBe(implementer.path);
  });

  test("a closed flow stays folded but never expands its reviewer subtree into active nodes", () => {
    /* Regression: expandedFlowConversations must gate on active flows. A closed
       flow's reviewer is still claimed/folded off the board, but promoting its
       idle descendants would re-open the whole tree as an active group. */
    const implementer = entry({ path: "/implementer", activity: "idle" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer", activity: "idle" });
    const subtask = entry({ path: "/subtask", parent: "/reviewer", activity: "idle" });
    const files = [implementer, reviewer, subtask];
    const closed = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "closed", closedAt: "2026-07-06T00:00:00Z" });

    // The scheme builds its expand set from ACTIVE flows only — a closed flow
    // contributes nothing to expansion.
    const active = [closed].filter(isActiveFlow);
    expect(active).toHaveLength(0);
    expect(claimedReviewerDescendantPaths(files, active).size).toBe(0);
    // …but folding still consumes the full list, so the reviewer is re-homed.
    expect(foldClaimedReviewers(files, [closed]).map((file) => file.path)).toEqual(["/implementer", "/subtask"]);
  });

  test("a folded reviewer that must stay visible is recovered from the full file set (issue #112 finding)", () => {
    /* Folding is unconditional; an owner-authored reviewer OR one the owner
       opened out of a stack (a pin) is recovered by protectedReviewerNodes when
       its flow has no deck — a closed flow, or an active flow whose implementer
       is unplaced. */
    const implementer = entry({ path: "/implementer", activity: "idle" });
    const authored = entry({ path: "/reviewer", parent: "/implementer", activity: "idle", userAuthored: true });
    const closedFlow = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "closed", closedAt: "2026-07-06T00:00:00Z" });
    const activeFlow = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "reviewing" });

    // Folding removes the reviewer from the board's group file set…
    expect(foldClaimedReviewers([implementer, authored], [closedFlow]).map((file) => file.path)).toEqual(["/implementer"]);

    // …but it is recovered from the FULL file set for a closed flow, and for an
    // active flow with an unplaced implementer (renderedNodePaths empty).
    const base = { renderedNodePaths: new Set<string>(), hiddenPaths: new Set<string>(), pinnedPaths: new Set<string>() };
    expect(protectedReviewerNodes({ ...base, files: [implementer, authored], flows: [closedFlow] }).map((f) => f.path)).toEqual(["/reviewer"]);
    expect(protectedReviewerNodes({ ...base, files: [implementer, authored], flows: [activeFlow] }).map((f) => f.path)).toEqual(["/reviewer"]);

    // An unprotected reviewer the owner opened (pinned) of a deckless active flow
    // is recovered the same way — otherwise the click would make it vanish.
    const clean = entry({ path: "/reviewer", parent: "/implementer", activity: "idle" });
    expect(
      protectedReviewerNodes({ ...base, files: [implementer, clean], flows: [activeFlow], pinnedPaths: new Set(["/reviewer"]) }).map((f) => f.path),
    ).toEqual(["/reviewer"]);
  });
});

test("a quota-blocked flow presents the transient block and suppresses its pending action", () => {
  const limited = flow({
    implementerPath: "/implementer",
    reviewerPath: "/reviewer",
    state: "waiting_ready",
    block: {
      reason: "rate_limited",
      conversationId: "conversation_impl",
      accountId: "main",
      resetAt: 1_800_003_300,
    },
  });
  const t = (key: string) => key;

  expect(flowPresentation(t as never, limited, "en")).toEqual({
    label: "flowState.blocked_rate_limited",
    detail: "flowState.rate_limit_until",
    attention: true,
    pending: null,
  });
});
