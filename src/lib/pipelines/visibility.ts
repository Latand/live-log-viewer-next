import fs from "node:fs";

import type { FileEntry } from "@/lib/types";

import type { Pipeline } from "./types";

/* Per-project visibility lives client-side in
   src/components/pipelines/pipelineModel.ts — this module imports node:fs
   and cannot ship to the browser. */
export function filterPipelinesForFileScan(pipelines: readonly Pipeline[], files: readonly FileEntry[]): Pipeline[] {
  const scanned = new Set(files.map((file) => file.path));
  return pipelines.filter((pipeline) => {
    if (pipeline.state === "closed") return false;
    if ((pipeline.repoDir && fs.existsSync(pipeline.repoDir)) || (pipeline.worktreeDir && fs.existsSync(pipeline.worktreeDir))) return true;
    return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && scanned.has(attempt.agentPath))));
  });
}
