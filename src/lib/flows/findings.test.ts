import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import { fallbackReviewFromTranscript, lastAssistantMessage, parseFindings } from "./findings";
import type { Round } from "./types";

const FIXTURE = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");

function fixtureEntry(): FileEntry {
  const stat = fs.statSync(FIXTURE);
  return {
    path: FIXTURE,
    root: "codex-sessions",
    name: path.basename(FIXTURE),
    project: "repo",
    title: "reviewer",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1_000,
    size: stat.size,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function fixtureRound(): Round {
  return {
    n: 1,
    reviewerPath: FIXTURE,
    reviewerConversationId: null,
    reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
    accountId: "default",
    attemptedAccounts: ["codex:default"],
    autoRetryCount: 0,
    sessionId: "round-1-reviewer-session",
    reviewerPid: null,
    reviewerIdentity: null,
    reviewerPane: null,
    findingsPath: null,
    triggeredBy: "marker",
    readyNote: null,
    reviewHeadSha: null,
    verdict: null,
    findingsCount: null,
    startedAt: "2026-07-12T08:35:59.000Z",
    spawnStartedAt: "2026-07-12T08:35:59.000Z",
    relayStartedAt: null,
    relayDelivery: null,
    reviewedAt: null,
    terminalAt: null,
    relayedAt: null,
    error: null,
  };
}

test("parses current Codex field-labelled findings from final output", () => {
  const finalOutput = lastAssistantMessage(fixtureEntry())?.text;
  expect(finalOutput).toContain("VERDICT: REQUEST_CHANGES");
  expect(parseFindings(finalOutput ?? "")).toMatchObject({
    verdict: "REQUEST_CHANGES",
    findingsCount: 2,
  });
});

test("recovers a verdict directly from the persisted rollout path when the scanner entry is gone", () => {
  expect(fallbackReviewFromTranscript(fixtureRound(), new Map())).toMatchObject({
    verdict: "REQUEST_CHANGES",
    findingsCount: 2,
  });
});

test("recovers a managed Claude verdict from the frozen reviewer engine when scanner metadata is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-managed-claude-review-"));
  const transcriptPath = path.join(root, "accounts", "claude", "fable", "projects", "-repo", "review.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-12T09:40:00.000Z",
    message: { content: [{ type: "text", text: "VERDICT: APPROVE\n\nManaged Claude review completed." }] },
  }) + "\n");
  const round = fixtureRound();
  round.reviewerPath = transcriptPath;
  round.reviewerRole = { engine: "claude", model: "fable", effort: "high" };
  round.accountId = "fable";

  try {
    expect(fallbackReviewFromTranscript(round, new Map())).toMatchObject({
      verdict: "APPROVE",
      findingsCount: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovers a legacy managed Claude verdict from the engine resolved by its flow", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-managed-claude-review-"));
  const transcriptPath = path.join(root, "accounts", "claude", "legacy", "projects", "-repo", "review.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-12T10:50:00.000Z",
    message: { content: [{ type: "text", text: "VERDICT: APPROVE\n\nLegacy managed Claude review completed." }] },
  }) + "\n");
  const round = fixtureRound();
  round.reviewerPath = transcriptPath;
  round.reviewerRole = null;
  round.accountId = "legacy";

  try {
    expect(fallbackReviewFromTranscript(round, new Map(), "claude")).toMatchObject({
      verdict: "APPROVE",
      findingsCount: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("counts findings for reviewer formats that escape the bulleted-bold field contract (#930)", () => {
  const headingFields = `VERDICT: REQUEST_CHANGES

### Finding 1
**Severity:** High
**File:** src/example/alpha.ts
**Line:** 42
**Title:** Retry loop drops the deadline
**Explanation:** The helper rebuilds the deadline on every attempt.

### Finding 2
**Severity:** Medium
**File:** src/example/beta.ts
**Title:** Missing null guard
**Explanation:** The lookup assumes the map always holds the key.
`;
  const plainBulletFields = `VERDICT: REQUEST_CHANGES

- Severity: Medium
- File: src/example/alpha.ts
- Line: 42
- Title: Retry loop drops the deadline
- Explanation: The deadline is recomputed per attempt.

- Severity: Low
- File: src/example/beta.ts
- Title: Missing null guard
- Explanation: The lookup assumes the map always holds the key.
`;
  const proseBullets = `VERDICT: REQUEST_CHANGES

- **HIGH — src/example/alpha.ts:42 — Retry loop drops the deadline.** The helper recomputes the deadline per attempt.
- **MEDIUM — src/example/beta.ts:17 — Missing null guard.** The lookup assumes the map always holds the key.
- **LOW — src/example/gamma.ts:8 — Stale comment.** The comment describes the previous contract.
`;

  expect(parseFindings(headingFields)).toMatchObject({ verdict: "REQUEST_CHANGES", findingsCount: 2 });
  expect(parseFindings(plainBulletFields)).toMatchObject({ verdict: "REQUEST_CHANGES", findingsCount: 2 });
  expect(parseFindings(proseBullets)).toMatchObject({ verdict: "REQUEST_CHANGES", findingsCount: 3 });
});

test("keeps an approving prose review at zero findings", () => {
  const approval = `VERDICT: APPROVE

The parser change is scoped to the two files and the regression tests cover every observed format.
Residual risk is low: the fallback count only runs for a requested-changes verdict.
`;
  expect(parseFindings(approval)).toMatchObject({ verdict: "APPROVE", findingsCount: 0 });
});

/* Final messages of the two headless Claude Haiku reviewers in staging flow
   26d5fbcd (pipeline 064f250a, 2026-09-13). Both approved and the flow parked
   as needs_decision because neither bold verdict line parsed (#1682). The
   fixtures are byte-for-byte those messages with only the worktree path and
   conversation ids replaced; fixture b is the saved round-1-review.md. */
const HAIKU_REVIEWS = ["a", "b"].map((name) =>
  fs.readFileSync(path.join(import.meta.dir, "fixtures", `haiku-review-bold-verdict-${name}.md`), "utf8"));

test("both captured Haiku reviews with a bold verdict parse as an approval with zero findings (#1682)", () => {
  for (const review of HAIKU_REVIEWS) {
    expect(review).toContain("\n**VERDICT: APPROVE**\n");
    expect(parseFindings(review)).toMatchObject({ verdict: "APPROVE", findingsCount: 0 });
  }
});

test("a captured review stops approving when its bold verdict is quoted, fenced, negated or contradicted (#1682)", () => {
  for (const review of HAIKU_REVIEWS) {
    const withVerdictLine = (line: string) => review.replace("**VERDICT: APPROVE**", line);
    expect(parseFindings(withVerdictLine("> **VERDICT: APPROVE**"))).toBeNull();
    expect(parseFindings(withVerdictLine("```\n**VERDICT: APPROVE**\n```"))).toBeNull();
    expect(parseFindings(withVerdictLine("**VERDICT: NOT APPROVE**"))).toBeNull();
    expect(parseFindings(withVerdictLine("**VERDICT: APPROVE | REQUEST_CHANGES | COMMENT**"))).toBeNull();
    expect(parseFindings(withVerdictLine("I would approve this once tests pass."))).toBeNull();
    expect(parseFindings(`VERDICT: REQUEST_CHANGES\n\n${review}`)).toBeNull();
    expect(parseFindings(withVerdictLine("**VERDICT: REQUEST_CHANGES**"))).toMatchObject({ verdict: "REQUEST_CHANGES" });
  }
});
