import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { loadFlow, loadFlowsForTick, saveFlowRows, saveFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { buildPipeline, loadPipelinesForList, savePipelines, withPipelineControllerMutation } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { projectResolutionStateKey } from "@/lib/scanner/projectState";
import { resetStateReadonlyConnectionCountForTests, stateReadonlyConnectionCountForTests } from "@/lib/state/sqliteStateStore";

const stages: PipelineStage[] = [{
  id: "build",
  kind: "run",
  "prompt": "build",
  next: null,
  effectiveRole: {
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    access: "read-write",
    promptScaffold: null,
  },
}];

function pipelines(count: number): Pipeline[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `bench-${String(index).padStart(4, "0")}`;
    const pipeline = buildPipeline({
      id,
      task: `benchmark task ${index}`,
      project: "benchmark",
      repoDir: "/repo",
      stages,
      srcPath: null,
      srcConversationId: null,
      now: "2026-08-01T00:00:00.000Z",
    });
    if (index > 0) {
      pipeline.state = "closed";
      pipeline.closedAt = "2026-08-02T00:00:00.000Z";
      pipeline.cursor = null;
      pipeline.stateDetail = `settled pipeline ${index} with retained evidence`;
    }
    return pipeline;
  });
}

function flows(count: number): Flow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bench-flow-${String(index).padStart(4, "0")}`,
    template: "implement-review-loop",
    project: "benchmark",
    cwd: "/repo",
    implementerPath: `/sessions/flow-${index}.jsonl`,
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 3,
    state: index === 0 ? "waiting_ready" : "closed",
    stateDetail: index === 0 ? null : `settled flow ${index}`,
    rounds: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: index === 0 ? null : "2026-08-02T00:00:00.000Z",
  }));
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

async function measure(operation: (iteration: number) => Promise<void> | void): Promise<number> {
  await operation(-1);
  const durations: number[] = [];
  for (let iteration = 0; iteration < 9; iteration += 1) {
    const startedAt = performance.now();
    await operation(iteration);
    durations.push(performance.now() - startedAt);
  }
  return median(durations);
}

async function sqliteCycle(pipelineCount: number, flowCount: number): Promise<number> {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-benchmark-sqlite-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    savePipelines(pipelines(pipelineCount));
    saveFlows(flows(flowCount));
    return await measure(async (iteration) => {
      await withPipelineControllerMutation((records, persist) => {
        for (const record of records) {
          record.stateDetail = `iteration ${iteration}`;
          persist([record]);
        }
      });
      const activeFlows = loadFlowsForTick();
      activeFlows[0]!.stateDetail = `iteration ${iteration}`;
      saveFlowRows([activeFlows[0]!]);
      expect(loadPipelinesForList()[0]?.stateDetail).toBe(`iteration ${iteration}`);
      expect(loadFlow("bench-flow-0000")?.stateDetail).toBe(`iteration ${iteration}`);
    });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function jsonCycle(pipelineCount: number, flowCount: number): Promise<number> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-benchmark-json-"));
  const pipelineFile = path.join(sandbox, "pipelines.json");
  const flowFile = path.join(sandbox, "flows.json");
  fs.writeFileSync(pipelineFile, JSON.stringify({ schemaVersion: 4, pipelines: pipelines(pipelineCount) }));
  fs.writeFileSync(flowFile, JSON.stringify({ schemaVersion: 3, flows: flows(flowCount) }));
  try {
    return await measure((iteration) => {
      const pipelineDocument = JSON.parse(fs.readFileSync(pipelineFile, "utf8")) as { pipelines: Pipeline[] };
      pipelineDocument.pipelines[0]!.stateDetail = `iteration ${iteration}`;
      fs.writeFileSync(pipelineFile, JSON.stringify({ schemaVersion: 4, pipelines: pipelineDocument.pipelines }));
      const flowDocument = JSON.parse(fs.readFileSync(flowFile, "utf8")) as { flows: Flow[] };
      flowDocument.flows[0]!.stateDetail = `iteration ${iteration}`;
      fs.writeFileSync(flowFile, JSON.stringify({ schemaVersion: 3, flows: flowDocument.flows }));
      const readPipelines = JSON.parse(fs.readFileSync(pipelineFile, "utf8")) as { pipelines: Pipeline[] };
      const readFlows = JSON.parse(fs.readFileSync(flowFile, "utf8")) as { flows: Flow[] };
      expect(readPipelines.pipelines[0]?.stateDetail).toBe(`iteration ${iteration}`);
      expect(readFlows.flows[0]?.stateDetail).toBe(`iteration ${iteration}`);
    });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function scannerCycleUnderPipelineChurn(): Promise<number> {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-benchmark-scanner-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    savePipelines(pipelines(500));
    saveFlows(flows(200));
    const projectKey = projectResolutionStateKey();
    return await measure(async (iteration) => {
      await withPipelineControllerMutation((records, persist) => {
        records[0]!.stateDetail = `scanner iteration ${iteration}`;
        persist([records[0]!]);
      });
      expect(projectResolutionStateKey()).toBe(projectKey);
    });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function projectFactCorpusRequest(): Promise<{ milliseconds: number; readonlyConnections: number }> {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-benchmark-project-facts-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    savePipelines(pipelines(500));
    saveFlows(flows(200));
    await withPipelineControllerMutation((records, persist) => {
      records[0]!.stateDetail = "unrelated pipeline heartbeat";
      persist([records[0]!]);
    });
    resetStateReadonlyConnectionCountForTests();
    const startedAt = performance.now();
    const stateKey = projectResolutionStateKey();
    for (let index = 0; index < 7_700; index += 1) {
      projectInfoFromCwd(path.join(sandbox, "synthetic-cwds", String(index)), stateKey);
    }
    return {
      milliseconds: performance.now() - startedAt,
      readonlyConnections: stateReadonlyConnectionCountForTests(),
    };
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test("SQLite mutation cost stays bounded on a 500-pipeline and 200-flow corpus", async () => {
  const sqliteSmallMs = await sqliteCycle(1, 1);
  const sqliteCorpusMs = await sqliteCycle(500, 200);
  const jsonCorpusMs = await jsonCycle(500, 200);
  const scannerRequestMs = await scannerCycleUnderPipelineChurn();
  const projectFactRequest = await projectFactCorpusRequest();
  const settledScale = sqliteCorpusMs / Math.max(sqliteSmallMs, 0.01);
  console.log(JSON.stringify({
    benchmark: "hot-state-mutation-read",
    corpus: { pipelines: 500, flows: 200 },
    medianMs: {
      json: Number(jsonCorpusMs.toFixed(3)),
      sqlite: Number(sqliteCorpusMs.toFixed(3)),
      sqliteSmall: Number(sqliteSmallMs.toFixed(3)),
      scannerUnderPipelineChurn: Number(scannerRequestMs.toFixed(3)),
      projectFactCorpus: Number(projectFactRequest.milliseconds.toFixed(3)),
    },
    projectFactReadonlyConnections: projectFactRequest.readonlyConnections,
    settledScale: Number(settledScale.toFixed(3)),
  }));
  expect(settledScale).toBeLessThan(2.5);
  expect(sqliteCorpusMs).toBeLessThan(jsonCorpusMs);
  expect(scannerRequestMs).toBeLessThan(50);
  expect(projectFactRequest.milliseconds).toBeLessThan(3_000);
  expect(projectFactRequest.readonlyConnections).toBeLessThanOrEqual(3);
});
