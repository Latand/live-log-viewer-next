import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";

import { advanceFlowFromRuntime } from "./serverConsumers";

function flow(): Flow {
  return {
    id: "flow-one",
    template: "implement-review-loop",
    project: "project",
    cwd: "/repo",
    implementerPath: "/sessions/implementer.jsonl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "abc123",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 1,
    state: "waiting_ready",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    closedAt: null,
  };
}

test("terminal readiness advances a flow once under server ownership", () => {
  const value = flow();
  expect(advanceFlowFromRuntime(value, "REVIEW_READY: contract fixed")).toBe(true);
  expect(value).toMatchObject({
    state: "spawn_pending",
    rounds: [{ n: 1, triggeredBy: "marker", readyNote: "contract fixed" }],
  });
  expect(advanceFlowFromRuntime(value, "REVIEW_READY: contract fixed")).toBe(false);
  expect(value.rounds).toHaveLength(1);
});
