import fs from "node:fs";

import { loadFlows, saveFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { buildPipeline, withPipelineMutation } from "@/lib/pipelines/store";
import type { PipelineStage } from "@/lib/pipelines/types";
import { buildWorkflow, loadWorkflows, normalizeTemplate, saveWorkflows } from "@/lib/workflows/store";

const [collection, label, readyFile, releaseFile] = process.argv.slice(2);
if (!collection || !label || !readyFile || !releaseFile) throw new Error("hot state child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(5);
}

function flow(id: string): Flow {
  return {
    id,
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: `/${id}.jsonl`,
    roles: {
      implementer: { engine: "codex", model: null, effort: "medium" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 3,
    state: "waiting_ready",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    closedAt: null,
  };
}

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

fs.writeFileSync(readyFile, "ready");
waitFor(releaseFile);

if (collection === "flows") {
  const records = loadFlows();
  records.push(flow(`flow-${label}`));
  saveFlows(records);
} else if (collection === "pipelines") {
  await withPipelineMutation((records, persist) => {
    records.push(buildPipeline({
      id: `pipe-${label}`,
      task: `task ${label}`,
      project: "repo",
      repoDir: "/repo",
      stages,
      srcPath: null,
      srcConversationId: null,
      now: "2026-08-06T00:00:00.000Z",
    }));
    persist();
  });
} else if (collection === "workflows") {
  const template = normalizeTemplate({
    name: "contention",
    stages: [
      { kind: "implement", agent: { engine: "codex", model: null, effort: "medium" }, scope: "store" },
      { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "xhigh" } },
    ],
  });
  if (!template) throw new Error("contention workflow template is invalid");
  const records = loadWorkflows();
  records.push(buildWorkflow({
    id: `work-${label}`,
    name: `workflow ${label}`,
    task: `task ${label}`,
    project: "repo",
    repoDir: "/repo",
    template,
    mode: "manual",
    now: "2026-08-06T00:00:00.000Z",
  }));
  saveWorkflows(records);
} else {
  throw new Error(`unknown hot state collection: ${collection}`);
}
