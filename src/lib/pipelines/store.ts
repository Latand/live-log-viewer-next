import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { Pipeline, PipelineStage } from "./types";

export const PIPELINES_SCHEMA_VERSION = 1;
const pipelinesFile = () => statePath("pipelines.json");
const artifactsRoot = () => statePath("pipelines");

type PipelineFile = { schemaVersion?: unknown; pipelines?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}
function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isStage(value: unknown): value is PipelineStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stage = value as Partial<PipelineStage>;
  const role = (value as { role?: unknown }).role;
  return (
    typeof stage.id === "string" &&
    (stage.kind === "run" || stage.kind === "review-loop") &&
    typeof stage.prompt === "string" &&
    (stage.next === null || typeof stage.next === "string") &&
    (role === undefined || Boolean(role && typeof role === "object" && !Array.isArray(role) && typeof (role as { roleId?: unknown }).roleId === "string")) &&
    (stage.engine === undefined || stage.engine === "claude" || stage.engine === "codex") &&
    (stage.model === undefined || stage.model === null || typeof stage.model === "string") &&
    (stage.effort === undefined || stage.effort === null || typeof stage.effort === "string") &&
    (stage.access === undefined || stage.access === "read-only" || stage.access === "read-write")
  );
}

function isPipeline(value: unknown): value is Pipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pipeline = value as Partial<Pipeline>;
  return (
    typeof pipeline.id === "string" &&
    typeof pipeline.task === "string" &&
    typeof pipeline.repoDir === "string" &&
    typeof pipeline.worktreeDir === "string" &&
    typeof pipeline.branch === "string" &&
    Array.isArray(pipeline.stages) &&
    pipeline.stages.every(isStage) &&
    Array.isArray(pipeline.runs)
  );
}

export function loadPipelines(): Pipeline[] {
  const raw = readJson(pipelinesFile()) as PipelineFile | null;
  const pipelines = Array.isArray(raw?.pipelines) ? raw.pipelines.filter(isPipeline) : [];
  return pipelines.map((pipeline) => ({
    ...pipeline,
    spec: typeof pipeline.spec === "string" ? pipeline.spec : undefined,
    baseBranch: pipeline.baseBranch ?? "",
    baseRef: pipeline.baseRef ?? "",
    lastPassedCommit: pipeline.lastPassedCommit ?? "",
    pausedState: pipeline.pausedState ?? null,
    stateDetail: pipeline.stateDetail ?? null,
    srcPath: pipeline.srcPath ?? null,
    srcConversationId: pipeline.srcConversationId ?? null,
    closedAt: pipeline.closedAt ?? null,
    runs: pipeline.runs.map((run) => ({
      ...run,
      attempts: Array.isArray(run.attempts)
        ? run.attempts.map((attempt) => ({
            ...attempt,
            launchId: attempt.launchId ?? null,
            conversationId: attempt.conversationId ?? null,
            sessionId: attempt.sessionId ?? null,
            agentPath: attempt.agentPath ?? null,
            paneId: attempt.paneId ?? null,
            flowId: attempt.flowId ?? null,
            startedAt: attempt.startedAt ?? null,
            completedAt: attempt.completedAt ?? null,
            output: attempt.output ?? null,
            verdict: attempt.verdict ?? null,
            error: attempt.error ?? null,
          }))
        : [],
    })),
  }));
}

export function savePipelines(pipelines: Pipeline[]): void {
  atomicWriteJson(pipelinesFile(), { schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

export function buildPipeline(input: {
  id: string;
  task: string;
  spec?: string;
  project: string;
  repoDir: string;
  stages: PipelineStage[];
  srcPath: string | null;
  srcConversationId: string | null;
  now: string;
}): Pipeline {
  const repoName = path.basename(input.repoDir);
  return {
    id: input.id,
    task: input.task,
    ...(input.spec ? { spec: input.spec } : {}),
    project: input.project,
    repoDir: input.repoDir,
    worktreeDir: path.join(path.dirname(input.repoDir), `${repoName}-pipeline-${input.id}`),
    branch: `pipeline/${slugify(input.task)}-${input.id}`,
    baseBranch: "",
    baseRef: "",
    lastPassedCommit: "",
    stages: JSON.parse(JSON.stringify(input.stages)) as PipelineStage[],
    runs: input.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: { stageId: input.stages[0]!.id, state: "pending" },
    state: "provisioning",
    pausedState: null,
    stateDetail: null,
    srcPath: input.srcPath,
    srcConversationId: input.srcConversationId,
    createdAt: input.now,
    closedAt: null,
  };
}

export function pipelineArtifactsDir(pipelineId: string): string {
  return path.join(artifactsRoot(), pipelineId);
}
