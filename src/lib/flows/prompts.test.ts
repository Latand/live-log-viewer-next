import { expect, test } from "bun:test";

import type { Flow, Round } from "./types";

import { kickoffPrompt, reviewerPrompt } from "./prompts";

function flow(spec?: string): Flow {
  return {
    id: "flow-spec",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    ...(spec ? { spec } : {}),
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "now",
    closedAt: null,
  };
}

const round: Round = {
  n: 1,
  reviewerPath: null,
  findingsPath: null,
  triggeredBy: "marker",
  readyNote: "implementation is ready",
  verdict: null,
  findingsCount: null,
  startedAt: "now",
  reviewedAt: null,
  relayedAt: null,
  error: null,
};

test("reviewer prompt includes pinned specification and acceptance criteria", () => {
  const reviewHeadSha = "5".repeat(40);
  const prompt = reviewerPrompt(flow("Add flow specs\nAC1: Fresh reviewers receive the spec"), { ...round, reviewHeadSha });
  expect(prompt).toContain("Pinned flow specification and acceptance criteria:");
  expect(prompt).toContain("AC1: Fresh reviewers receive the spec");
  expect(prompt).toContain(`Exact review HEAD: ${reviewHeadSha}`);
});

test("kickoff requests spec.md before review when the flow has no pinned specification", () => {
  expect(kickoffPrompt()).toContain("Before your first REVIEW_READY, write spec.md");
});

test("kickoff carries a pinned specification into the implementer session", () => {
  expect(kickoffPrompt("Task\nAC1: Deliver context")).toContain("AC1: Deliver context");
});
