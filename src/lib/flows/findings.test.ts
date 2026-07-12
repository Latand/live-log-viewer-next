import { expect, test } from "bun:test";
import fs from "node:fs";
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
    sessionId: "11111111-2222-4333-8444-555555555555",
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
