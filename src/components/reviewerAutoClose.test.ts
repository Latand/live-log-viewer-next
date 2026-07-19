import { describe, expect, test } from "bun:test";

import { applyBoardMutations } from "@/lib/board/mutations";
import type { Flow, ReviewVerdict } from "@/lib/flows/types";
import type { BoardProjectStateV1 } from "@/lib/view/types";
import type { FileEntry } from "@/lib/types";

import { reviewerCloseMutations, type ReviewerAutoCloseInput } from "./reviewerAutoClose";

/*
 * Issue #289: the durable close that releases a manually-pinned reviewer once
 * its terminal verdict is durably observed. Fail-closed by construction:
 * no verdict, live work, owner authorship, unverified authorship, and
 * already-hidden paths never emit; a second application is a no-op.
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
    parent: "/orchestrator",
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

function reviewer(
  path: string,
  opts: Partial<FileEntry> & { verdict?: ReviewVerdict | null } = {},
): FileEntry {
  const { verdict = "APPROVE", ...rest } = opts;
  return entry({
    path,
    conversationId: `conversation-${path}`,
    durableLineage: {
      kind: "review",
      role: "reviewer",
      parentConversationId: "conversation-orchestrator",
      reviewsConversationId: "conversation-builder",
      memberships: [],
    },
    ...(verdict ? { review: { verdict, findingsCount: 0, observedAt: "2026-07-18T02:00:00.000Z" } } : {}),
    ...rest,
  });
}

function baseInput(overrides: Partial<ReviewerAutoCloseInput>): ReviewerAutoCloseInput {
  return {
    files: [],
    flows: [],
    project: "demo",
    explicitManual: [],
    manual: [],
    expanded: [],
    hidden: [],
    ...overrides,
  };
}

function board(overrides: Partial<BoardProjectStateV1> = {}): BoardProjectStateV1 {
  return {
    prefs: { manual: [], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
    explicitManual: [],
    pathAliases: {},
    ...overrides,
  } as BoardProjectStateV1;
}

describe("reviewerCloseMutations", () => {
  test("a pinned verdict-complete reviewer emits exactly one close, for every verdict and engine", () => {
    for (const verdict of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const) {
      for (const engine of ["claude", "codex"] as const) {
        const file = reviewer("/reviewer-1", { verdict, engine });
        const closes = reviewerCloseMutations(baseInput({ files: [file], explicitManual: ["/reviewer-1"] }));
        expect(closes).toEqual([{ kind: "close", path: "/reviewer-1" }]);
      }
    }
  });

  test("an expanded pin and a manual root membership are released too; unpinned reviewers never emit", () => {
    const file = reviewer("/reviewer-1");
    expect(reviewerCloseMutations(baseInput({ files: [file], expanded: ["/reviewer-1"] }))).toHaveLength(1);
    expect(reviewerCloseMutations(baseInput({ files: [file], manual: ["/reviewer-1"] }))).toHaveLength(1);
    /* No pin: the projection folds it with zero mutations — nothing to close. */
    expect(reviewerCloseMutations(baseInput({ files: [file] }))).toHaveLength(0);
  });

  test("fail-closed exclusions: no verdict, fresh failure, live work, waiting input, owner authorship, unverified authorship, hidden", () => {
    const pinned = { explicitManual: ["/reviewer-1"] };
    const noVerdict = reviewer("/reviewer-1", { verdict: null });
    expect(reviewerCloseMutations(baseInput({ files: [noVerdict], ...pinned }))).toHaveLength(0);
    /* A failed-before-verdict reviewer (stopped, no outcome) is the same
       no-verdict case — the spec keeps it recoverable, never auto-closed. */
    const failed = reviewer("/reviewer-1", { verdict: null, activity: "recent", proc: "done" });
    expect(reviewerCloseMutations(baseInput({ files: [failed], ...pinned }))).toHaveLength(0);
    const live = reviewer("/reviewer-1", { activity: "live" });
    expect(reviewerCloseMutations(baseInput({ files: [live], ...pinned }))).toHaveLength(0);
    const waiting = reviewer("/reviewer-1", { waitingInput: { since: 1, screenTail: "…", target: "%1", menu: null } });
    expect(reviewerCloseMutations(baseInput({ files: [waiting], ...pinned }))).toHaveLength(0);
    const owned = reviewer("/reviewer-1", { userAuthored: true });
    expect(reviewerCloseMutations(baseInput({ files: [owned], ...pinned }))).toHaveLength(0);
    const unverified = reviewer("/reviewer-1", { authorshipUnverified: true });
    expect(reviewerCloseMutations(baseInput({ files: [unverified], ...pinned }))).toHaveLength(0);
    const hidden = reviewer("/reviewer-1");
    expect(reviewerCloseMutations(baseInput({ files: [hidden], ...pinned, hidden: ["/reviewer-1"] }))).toHaveLength(0);
    /* Another project's reviewer never leaks into this board's mutations. */
    const foreign = reviewer("/reviewer-1", { project: "other" });
    expect(reviewerCloseMutations(baseInput({ files: [foreign], ...pinned }))).toHaveLength(0);
  });

  test("a claimed flow round's durable verdict qualifies a reviewer without its own parsed outcome; an aborted round does not", () => {
    const roundBase = {
      n: 1,
      reviewerPath: "/reviewer-1",
      reviewerConversationId: "conversation-r1",
      findingsPath: null,
      triggeredBy: "button" as const,
      readyNote: null,
      findingsCount: null,
      startedAt: "2026-07-18T00:00:00.000Z",
      relayedAt: null,
    };
    const withVerdict = {
      id: "flow-1",
      implementerPath: "/builder",
      rounds: [{ ...roundBase, verdict: "APPROVE" as const, reviewedAt: "2026-07-18T01:00:00.000Z", terminalAt: "2026-07-18T01:00:00.000Z", error: null }],
    } as unknown as Flow;
    const noOutcome = reviewer("/reviewer-1", { verdict: null });
    expect(reviewerCloseMutations(baseInput({ files: [noOutcome], flows: [withVerdict], explicitManual: ["/reviewer-1"] }))).toHaveLength(1);

    const aborted = {
      ...withVerdict,
      rounds: [{ ...roundBase, verdict: null, reviewedAt: null, terminalAt: "2026-07-18T01:00:00.000Z", error: "no verdict" }],
    } as unknown as Flow;
    expect(reviewerCloseMutations(baseInput({ files: [noOutcome], flows: [aborted], explicitManual: ["/reviewer-1"] }))).toHaveLength(0);
  });

  test("applying the close releases every membership shape and the second application is empty (idempotent)", () => {
    const file = reviewer("/reviewer-1.jsonl");
    const before = board({
      prefs: { manual: ["/reviewer-1.jsonl"], hidden: [], expanded: ["/reviewer-1.jsonl"], favorites: [], viewMode: null, taskPanelOpen: false },
      explicitManual: ["/reviewer-1.jsonl"],
    });
    const closes = reviewerCloseMutations(baseInput({
      files: [file],
      explicitManual: before.explicitManual!,
      manual: before.prefs.manual,
      expanded: before.prefs.expanded,
      hidden: before.prefs.hidden,
    }));
    expect(closes).toHaveLength(1);
    const after = applyBoardMutations(before, closes);
    expect(after.prefs.hidden).toEqual(["/reviewer-1.jsonl"]);
    expect(after.prefs.manual).toHaveLength(0);
    expect(after.prefs.expanded).toHaveLength(0);
    expect(after.explicitManual).toHaveLength(0);
    /* Second application: the pin is gone and the path is hidden → no-op. */
    const again = reviewerCloseMutations(baseInput({
      files: [file],
      explicitManual: after.explicitManual!,
      manual: after.prefs.manual,
      expanded: after.prefs.expanded,
      hidden: after.prefs.hidden,
    }));
    expect(again).toHaveLength(0);
    /* Replaying the SAME mutation against the new state changes nothing. */
    expect(applyBoardMutations(after, closes)).toEqual(applyBoardMutations(after, []));
  });

  test("a generation-remapped pin still resolves: the close lands on the canonical path through the alias graph", () => {
    /* The pin was recorded against the predecessor path; the board carries the
       alias. The emitter sees the CURRENT path (resolveFlowMemberPaths
       canonicalizes member paths at the data boundary), and the server reducer
       resolves the old membership entries onto the same canonical path. */
    const current = reviewer("/reviewer-gen2.jsonl");
    const before = board({
      prefs: { manual: ["/reviewer-gen1.jsonl"], hidden: [], expanded: [], favorites: [], viewMode: null, taskPanelOpen: false },
      explicitManual: ["/reviewer-gen1.jsonl"],
      pathAliases: { "/reviewer-gen1.jsonl": "/reviewer-gen2.jsonl" },
    });
    /* Membership normalization resolves the pin to the canonical path. */
    const normalized = applyBoardMutations(before, []);
    expect(normalized.prefs.manual).toEqual(["/reviewer-gen2.jsonl"]);
    const closes = reviewerCloseMutations(baseInput({
      files: [current],
      explicitManual: normalized.explicitManual!,
      manual: normalized.prefs.manual,
      expanded: normalized.prefs.expanded,
      hidden: normalized.prefs.hidden,
    }));
    expect(closes).toEqual([{ kind: "close", path: "/reviewer-gen2.jsonl" }]);
    const after = applyBoardMutations(before, closes);
    expect(after.prefs.hidden).toEqual(["/reviewer-gen2.jsonl"]);
    expect(after.prefs.manual).toHaveLength(0);
    expect(after.explicitManual).toHaveLength(0);
  });
});
