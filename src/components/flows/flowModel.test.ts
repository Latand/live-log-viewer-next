import { describe, expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { buildBranchGroups } from "@/components/projectModel";
import { protectedInactiveReviewerPaths } from "@/components/scheme/workerCollapse";

import { claimedReviewerDescendantPaths, flowPresentation, foldClaimedReviewers, isActiveFlow } from "./flowModel";

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

  test("a pinned reviewer of an inactive flow stays on the board; an active one still folds (issue #112)", () => {
    const implementer = entry({ path: "/implementer" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer" });
    const closed = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "closed", closedAt: "2026-07-06T00:00:00Z" });
    const active = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer" }); // reviewing
    const pinned = new Set(["/reviewer"]);
    // Inactive flow + pinned → the reviewer survives folding (it has no deck).
    expect(foldClaimedReviewers([implementer, reviewer], [closed], pinned).map((file) => file.path)).toEqual(["/implementer", "/reviewer"]);
    // Not pinned → still folded off the board.
    expect(foldClaimedReviewers([implementer, reviewer], [closed]).map((file) => file.path)).toEqual(["/implementer"]);
    // Active flow + pinned → still folded; its round deck is the destination.
    expect(foldClaimedReviewers([implementer, reviewer], [active], pinned).map((file) => file.path)).toEqual(["/implementer"]);
  });

  test("an opened closed-flow reviewer has a renderable node destination (issue #112 finding)", () => {
    /* The dashboard integration the DOM test missed: after a click pins the
       reviewer, fold-keep leaves it in the file set, and buildBranchGroups
       promotes the expanded reviewer into a real column instead of dropping it. */
    const implementer = entry({ path: "/implementer", activity: "idle" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer", activity: "idle" });
    const closed = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "closed", closedAt: "2026-07-06T00:00:00Z" });
    const pinned = new Set(["/reviewer"]);

    const kept = foldClaimedReviewers([implementer, reviewer], [closed], pinned);
    const groups = buildBranchGroups(kept, "demo", { expandedConversationPaths: new Set(["/reviewer"]) });
    const columns = groups.flatMap((group) => group.columns.map((column) => column.file.path));
    expect(columns).toContain("/reviewer");
  });

  test("an owner-authored closed-flow reviewer is kept unfolded and stays materializable (issue #112 finding)", () => {
    /* Not manually pinned, but userAuthored — it must never vanish. The dashboard
       keeps it unfolded via protectedInactiveReviewerPaths and materializes it as
       a standalone node; here we prove fold-keep leaves it resolvable. */
    const implementer = entry({ path: "/implementer", activity: "idle" });
    const reviewer = entry({ path: "/reviewer", parent: "/implementer", activity: "idle", userAuthored: true });
    const closed = flow({ implementerPath: "/implementer", reviewerPath: "/reviewer", state: "closed", closedAt: "2026-07-06T00:00:00Z" });

    const protectedPaths = protectedInactiveReviewerPaths([implementer, reviewer], [closed]);
    expect(protectedPaths).toEqual(new Set(["/reviewer"]));

    // With no manual pin, plain folding would drop it; keeping the protected set
    // unfolded leaves it in the file set so a node can be materialized from it.
    expect(foldClaimedReviewers([implementer, reviewer], [closed]).map((file) => file.path)).toEqual(["/implementer"]);
    const kept = foldClaimedReviewers([implementer, reviewer], [closed], protectedPaths);
    expect(kept.map((file) => file.path)).toContain("/reviewer");
    expect(new Map(kept.map((file) => [file.path, file])).get("/reviewer")).toBeDefined();
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
