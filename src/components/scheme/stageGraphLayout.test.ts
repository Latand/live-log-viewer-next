import { expect, test } from "bun:test";

import type { PipelineStage, PipelineStageAttempt, PipelineStageRun } from "@/lib/pipelines/types";

import { layoutStageGraph } from "./stageGraphLayout";

const role = {
  roleId: "builder" as const,
  engine: "codex" as const,
  model: null,
  effort: null,
  access: "read-write" as const,
  promptScaffold: null,
};

function stage(id: string, next: string | null): PipelineStage {
  return { id, kind: "run", prompt: id, next, onFail: null, effectiveRole: role };
}

function reviewStage(id: string, next: string | null): PipelineStage {
  return {
    id, kind: "review-loop", prompt: id, next, onFail: null,
    effectiveRole: { ...role, roleId: "reviewer", access: "read-only" },
  };
}

const emptyRuns = (stages: PipelineStage[]): PipelineStageRun[] =>
  stages.map((candidate) => ({ stageId: candidate.id, attempts: [] }));

function attempt(
  n: number,
  state: PipelineStageAttempt["state"],
  activatedBy: PipelineStageAttempt["activatedBy"] = null,
): PipelineStageAttempt {
  return {
    n, state, effectiveRole: role, launchId: null, conversationId: `conversation-${n}`,
    sessionId: null, agentPath: `/attempt-${n}.jsonl`, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy, output: null,
    verdict: null, error: null,
  };
}

test("lays a sequential pipeline into ordered horizontal layers", () => {
  const stages = [stage("plan", "build"), stage("build", "ship"), stage("ship", null)];

  const graph = layoutStageGraph(stages, emptyRuns(stages));

  expect(graph.nodes.map((node) => [node.id, node.layer])).toEqual([
    ["plan", 0],
    ["build", 1],
    ["ship", 2],
  ]);
  expect(graph.nodes.map((node) => node.x)).toEqual([...graph.nodes.map((node) => node.x)].sort((a, b) => a - b));
  expect(graph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.returning])).toEqual([
    ["plan", "build", "pass", false],
    ["build", "ship", "pass", false],
  ]);
  expect(graph.size.width).toBeGreaterThan(graph.nodes.at(-1)!.x + graph.nodes.at(-1)!.width);
});

test("fans sibling builders out from their shared predecessor", () => {
  const root = stage("plan", "build-ui");
  root.onFail = { to: "build-api", maxRounds: 1 };
  const stages = [root, stage("build-ui", null), stage("build-api", null)];

  const graph = layoutStageGraph(stages, emptyRuns(stages));
  const ui = graph.nodes.find((node) => node.id === "build-ui")!;
  const api = graph.nodes.find((node) => node.id === "build-api")!;

  expect([ui.layer, api.layer]).toEqual([1, 1]);
  expect(ui.x).toBe(api.x);
  expect(ui.y).not.toBe(api.y);
  expect(graph.edges.map((edge) => [edge.from, edge.to, edge.kind])).toEqual([
    ["plan", "build-ui", "pass"],
    ["plan", "build-api", "fail"],
  ]);
});

test("marks a fail-loop as a bounded return edge and records its taken path", () => {
  const verify = stage("verify", null);
  verify.onFail = { to: "build", maxRounds: 3 };
  const stages = [stage("build", "verify"), verify];
  const runs: PipelineStageRun[] = [
    { stageId: "build", attempts: [attempt(1, "failed"), attempt(2, "running", { stageId: "verify", attempt: 1, edge: "fail" })] },
    { stageId: "verify", attempts: [attempt(1, "failed", { stageId: "build", attempt: 1, edge: "pass" })] },
  ];

  const graph = layoutStageGraph(stages, runs);

  expect(graph.nodes.map((node) => [node.id, node.layer])).toEqual([["build", 0], ["verify", 1]]);
  expect(graph.edges).toHaveLength(2);
  expect(graph.edges.find((edge) => edge.kind === "fail")).toMatchObject({
    from: "verify", to: "build", returning: true, taken: true,
  });
});

test("keeps a one-stage self-loop as one node and one return arrow", () => {
  const only = stage("build", null);
  only.onFail = { to: "build", maxRounds: 2 };

  const graph = layoutStageGraph([only], emptyRuns([only]));

  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]).toMatchObject({ id: "build", layer: 0 });
  expect(graph.edges).toEqual([expect.objectContaining({
    from: "build", to: "build", kind: "fail", returning: true,
  })]);
  expect(graph.size.width).toBeGreaterThan(graph.nodes[0]!.x + graph.nodes[0]!.width + 54);
  expect(graph.size.height).toBeGreaterThan(graph.nodes[0]!.height);
});

test("keeps skipped declared stages in the graph", () => {
  const stages = [stage("build", "verify"), stage("verify", null)];
  const graph = layoutStageGraph(stages, [
    { stageId: "build", attempts: [attempt(1, "passed")] },
    { stageId: "verify", attempts: [attempt(1, "skipped", { stageId: "build", attempt: 1, edge: "pass" })] },
  ]);

  expect(graph.nodes).toHaveLength(2);
  expect(graph.nodes.find((node) => node.id === "verify")).toMatchObject({ state: "skipped" });
});

test("nests review-loop stages under the run they review while preserving declared edges", () => {
  const review = reviewStage("review", "ship");
  review.onFail = { to: "build", maxRounds: 3 };
  const stages = [stage("build", "review"), review, stage("ship", null)];
  const runs = emptyRuns(stages);
  runs[1]!.attempts.push(attempt(1, "failed"), attempt(2, "reviewing"));

  const graph = layoutStageGraph(stages, runs);

  expect(graph.nodes.map((node) => node.id)).toEqual(["build", "review", "ship"]);
  expect(graph.nodes.find((node) => node.id === "review")).toMatchObject({ parentId: "build" });
  expect(graph.nodes[0]!.reviewGroups).toEqual([
    expect.objectContaining({ stage: expect.objectContaining({ id: "review" }), attempts: expect.any(Array) }),
  ]);
  expect(graph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.returning])).toEqual([
    ["build", "review", "pass", false],
    ["review", "ship", "pass", false],
    ["review", "build", "fail", true],
  ]);
});

test("a materialized review follows the run recorded by its activation edge across a merge", () => {
  const review = reviewStage("review", null);
  const stages = [stage("build-a", "review"), stage("build-b", "review"), review];
  const runs: PipelineStageRun[] = [
    { stageId: "build-a", attempts: [attempt(1, "passed")] },
    { stageId: "build-b", attempts: [attempt(1, "passed")] },
    { stageId: "review", attempts: [attempt(1, "reviewing", { stageId: "build-b", attempt: 1, edge: "pass" })] },
  ];

  const graph = layoutStageGraph(stages, runs);

  expect(graph.nodes.find((node) => node.id === "review")?.parentId).toBe("build-b");
  expect(graph.nodes.find((node) => node.id === "build-b")?.reviewGroups[0]?.stage.id).toBe("review");
  expect(graph.nodes.find((node) => node.id === "build-a")?.reviewGroups).toEqual([]);
});
