import { describe, expect, test } from "bun:test";

import { directReviewFlows } from "@/components/flows/directReviewGroups";
import { foldClaimedReviewers } from "@/components/flows/flowModel";
import { buildBranchGroups } from "@/components/projectModel";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { buildSchemeLayout } from "./layout";
import { stackDotsFor } from "./Minimap";
import { collapsibleWorkerFiles, groupWorkerStacks } from "./workerCollapse";

/*
 * Board composition for grouped review conversations (#289 + #325), following
 * the exact derivation chain ProjectDashboard runs: direct groups project into
 * deck flows, claimed reviewers fold out of branch groups, the layout places
 * one deck per placed anchor, and whatever the layout does NOT draw parks in
 * per-group worker stacks. The invariant under test: every reviewer transcript
 * appears in EXACTLY ONE surface (a deck or a stack), never as a standalone
 * board card, and the scene / minimap / stack counts always agree.
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

function directReviewer(path: string, opts: Partial<FileEntry> & { id: string; reviews: string }): FileEntry {
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

function task(id: string, conversationId: string): BoardTask {
  return {
    id,
    project: "demo",
    status: "assigned",
    text: `Task ${id}`,
    placement: "unplaced",
    assignments: [{ path: null, conversationId, panePid: null, state: "delivered", error: null, at: "2026-07-10T01:00:00.000Z" }],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  } as BoardTask;
}

const builder1 = entry({ path: "/builder-1", title: "Builder one", conversationId: "conversation-b1", activity: "live", mtime: 9_000 });
const builder2 = entry({ path: "/builder-2", title: "Builder two", conversationId: "conversation-b2", mtime: 8_000 });
const r1 = directReviewer("/reviewer-1", { id: "conversation-r1", reviews: "conversation-b1", activity: "live", mtime: 9_500 });
const r2 = directReviewer("/reviewer-2", {
  id: "conversation-r2",
  reviews: "conversation-b2",
  mtime: 2_000,
  review: { verdict: "REQUEST_CHANGES", findingsCount: 1, observedAt: "2026-07-10T02:00:00.000Z" },
});
const r3 = directReviewer("/reviewer-3", {
  id: "conversation-r3",
  reviews: "conversation-b2",
  mtime: 3_000,
  review: { verdict: "APPROVE", findingsCount: 0, observedAt: "2026-07-10T03:00:00.000Z" },
});
const files = [builder1, builder2, r1, r2, r3];
const tasks = [task("task-one", "conversation-b1"), task("task-two", "conversation-b2")];

describe("direct review board composition (#289 + #325)", () => {
  test("two tasks build two isolated groups; every reviewer lives in exactly one surface with a placed anchor", () => {
    const deckFlows = directReviewFlows({ files, flows: [], tasks, nowMs: 10_000_000 });
    expect(deckFlows.map((flow) => flow.id).sort()).toEqual([
      "direct-review::task::task-one",
      "direct-review::task::task-two",
    ]);
    expect(deckFlows.map((flow) => flow.state).sort()).toEqual(["done_comment", "reviewing"]);

    /* Claimed reviewers fold out of the branch groups (never standalone). */
    const groupFiles = foldClaimedReviewers(files, deckFlows);
    expect(groupFiles.map((file) => file.path).sort()).toEqual(["/builder-1", "/builder-2"]);
    const groups = buildBranchGroups(groupFiles, "demo", { expandedConversationPaths: new Set(["/builder-1"]) });

    /* Both anchors placed (the quiet one as a manual node): BOTH groups place
       a deck — the terminal one renders collapsed, but board presence, deck
       count and minimap agree. */
    const layout = buildSchemeLayout(groups, [builder2], files, deckFlows, []);
    expect(layout.decks).toHaveLength(2);
    const deckReviewerPaths = new Set(
      layout.decks.flatMap((deck) => deck.rounds.map((round) => round.file?.path)).filter(Boolean),
    );
    expect([...deckReviewerPaths].sort()).toEqual(["/reviewer-1", "/reviewer-2", "/reviewer-3"]);
    /* No reviewer is ever a standalone scheme node. */
    expect(layout.nodes.map((node) => node.file.path).sort()).toEqual(["/builder-1", "/builder-2"]);

    /* Everything drawn in a deck stays OUT of the worker stacks — zero
       double-listing, zero leakage. */
    const collapsible = collapsibleWorkerFiles({
      files,
      project: "demo",
      flows: deckFlows,
      pinnedPaths: new Set(),
      nowMs: 10_000_000,
      idleMs: 900_000,
    });
    const stacks = groupWorkerStacks(collapsible, deckFlows, deckReviewerPaths as ReadonlySet<string>);
    expect(stacks).toHaveLength(0);
  });

  test("with the terminal anchor unplaced the group parks as ONE per-group stack and one minimap dot", () => {
    const deckFlows = directReviewFlows({ files, flows: [], tasks, nowMs: 10_000_000 });
    const groupFiles = foldClaimedReviewers(files, deckFlows);
    const groups = buildBranchGroups(groupFiles, "demo", { expandedConversationPaths: new Set(["/builder-1"]) });

    /* Only the active anchor is on the board. */
    const layout = buildSchemeLayout(groups, [], files, deckFlows, []);
    expect(layout.decks).toHaveLength(1);
    expect(layout.decks[0]!.flow.id).toBe("direct-review::task::task-one");
    const deckReviewerPaths = new Set(
      layout.decks.flatMap((deck) => deck.rounds.map((round) => round.file?.path as string)).filter(Boolean),
    );

    const collapsible = collapsibleWorkerFiles({
      files,
      project: "demo",
      flows: deckFlows,
      pinnedPaths: new Set(),
      nowMs: 10_000_000,
      idleMs: 900_000,
    });
    const stacks = groupWorkerStacks(collapsible, deckFlows, deckReviewerPaths as ReadonlySet<string>);
    /* One stack for the WHOLE terminal group — keyed by the durable group id —
       holding both of its rounds; one minimap dot for it. */
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.key).toBe("wstack::flow::direct-review::task::task-two");
    expect(stacks[0]!.items.map((file) => file.path).sort()).toEqual(["/reviewer-2", "/reviewer-3"]);
    expect(stackDotsFor(stacks)).toHaveLength(1);
  });

  test("a closed reviewer never resurfaces: hidden paths stay out of stacks while the deck retains the evidence spine", () => {
    const deckFlows = directReviewFlows({ files, flows: [], tasks, nowMs: 10_000_000 });
    const hidden = new Set(["/reviewer-2"]);

    /* Off the board: the tombstoned round is excluded from the stack, its
       sibling remains — nothing resurfaces as a standalone card (#325
       2026-07-18 regression). */
    const collapsible = collapsibleWorkerFiles({
      files,
      project: "demo",
      flows: deckFlows,
      pinnedPaths: new Set(),
      nowMs: 10_000_000,
      idleMs: 900_000,
    });
    const stacks = groupWorkerStacks(collapsible, deckFlows, hidden as ReadonlySet<string>);
    const stackPaths = stacks.flatMap((stack) => stack.items.map((file) => file.path));
    expect(stackPaths).not.toContain("/reviewer-2");

    /* On the board: the deck resolves spine files from the FULL scan
       independent of hidden state — the verdict evidence stays reachable. */
    const groupFiles = foldClaimedReviewers(files, deckFlows);
    const groups = buildBranchGroups(groupFiles, "demo", { expandedConversationPaths: new Set(["/builder-1"]) });
    const layout = buildSchemeLayout(groups, [builder2], files, deckFlows, []);
    const terminalDeck = layout.decks.find((deck) => deck.flow.id === "direct-review::task::task-two");
    expect(terminalDeck).toBeDefined();
    expect(terminalDeck!.rounds.map((round) => round.file?.path)).toContain("/reviewer-2");
  });
});
