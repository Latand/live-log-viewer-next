/* Production-shaped pipeline registry for issue #863 profiling. Requires
   LLV_STATE_DIR to already point at an isolated sandbox. */
import fs from "node:fs";
import path from "node:path";

import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

function stages(): PipelineStage[] {
  return [
    {
      id: "build",
      kind: "run",
      role: { roleId: "builder" }, prompt: "build ".repeat(400),
      next: "review",
      effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "builder scaffold ".repeat(200) },
    },
    {
      id: "review",
      kind: "review-loop",
      role: { roleId: "reviewer" }, prompt: "review ".repeat(400),
      next: null,
      effectiveRole: { roleId: "reviewer", engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "reviewer scaffold ".repeat(200) },
    },
  ];
}

export function pipelineCorpus(count: number, attemptsPerStage = 6): Pipeline[] {
  const corpus: Pipeline[] = [];
  for (let index = 0; index < count; index += 1) {
    const pipeline = buildPipeline({
      id: `p${String(index).padStart(7, "0")}`,
      task: `task ${index}`,
      project: index % 3 === 0 ? "viewer" : `project-${index % 7}`,
      repoDir: "/repo",
      stages: stages(),
      srcPath: null,
      srcConversationId: null,
      now: new Date(Date.now() - index * 60_000).toISOString(),
    });
    pipeline.spec = "acceptance criteria ".repeat(500);
    if (index % 4 === 0) {
      pipeline.state = "closed";
      pipeline.cursor = null;
      pipeline.closedAt = new Date().toISOString();
    } else {
      pipeline.state = "running";
    }
    pipeline.runs = pipeline.stages.map((stage) => ({
      stageId: stage.id,
      attempts: Array.from({ length: attemptsPerStage }, (_value, attempt) => ({
        n: attempt + 1,
        state: "passed" as const,
        effectiveRole: stage.effectiveRole,
        launchId: null,
        conversationId: null,
        sessionId: null,
        agentPath: null,
        paneId: null,
        flowId: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        input: "prompt input ".repeat(600),
        activatedBy: null,
        output: "agent output transcript tail ".repeat(600),
        verdict: { status: "pass" as const },
        error: null,
      })),
    }));
    corpus.push(pipeline);
  }
  return corpus;
}

/** Seeds the sandbox registry and returns its on-disk size in bytes. */
export function seedPipelineCorpus(count: number, attemptsPerStage = 6): number {
  savePipelines(pipelineCorpus(count, attemptsPerStage));
  return fs.statSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json")).size;
}
