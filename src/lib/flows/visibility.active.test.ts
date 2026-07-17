import { expect, test } from "bun:test";

import type { Flow } from "./types";
import { activeFlowTranscriptPaths } from "./visibility";

function flow(overrides: Partial<Flow>): Flow {
  return {
    id: "flow",
    template: "implement-review-loop",
    project: "viewer",
    cwd: "/repo",
    implementerPath: "/sessions/implementer.jsonl",
    implementerConversationId: null,
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 1,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-17T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

test("active flow participants remain present on their project board", () => {
  const active = flow({
    rounds: [{ reviewerPath: "/sessions/reviewer.jsonl" } as Flow["rounds"][number]],
  });
  const closed = flow({ id: "closed", implementerPath: "/sessions/closed.jsonl", state: "closed", closedAt: "2026-07-17T01:00:00.000Z" });
  const other = flow({ id: "other", project: "other", implementerPath: "/sessions/other.jsonl" });

  expect(activeFlowTranscriptPaths([active, closed, other], "viewer")).toEqual([
    "/sessions/implementer.jsonl",
    "/sessions/reviewer.jsonl",
  ]);
});
