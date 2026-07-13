import fs from "node:fs";

import type { FileEntry } from "@/lib/types";
import type { RegistryFile } from "@/lib/agent/registry";

import type { Pipeline } from "./types";

/* Per-project visibility lives client-side in
   src/components/pipelines/pipelineModel.ts — this module imports node:fs
   and cannot ship to the browser. */
export function filterPipelinesForFileScan(
  pipelines: readonly Pipeline[],
  files: readonly FileEntry[],
  context: { pinnedPaths: ReadonlySet<string>; memberships: RegistryFile["memberships"] } = { pinnedPaths: new Set(), memberships: {} },
): Pipeline[] {
  const scanned = new Set(files.map((file) => file.path));
  const pinnedConversationIds = new Set(files
    .filter((file) => context.pinnedPaths.has(file.path) && file.conversationId)
    .map((file) => file.conversationId!));
  const restoredPipelineIds = new Set<string>();
  for (const conversationId of pinnedConversationIds) {
    for (const membership of context.memberships[conversationId] ?? []) {
      if (membership.kind === "pipeline") restoredPipelineIds.add(membership.containerId);
    }
  }
  return pipelines.flatMap((pipeline) => {
    const restored = restoredPipelineIds.has(pipeline.id) || pipeline.runs.some((run) => run.attempts.some((attempt) =>
      Boolean((attempt.conversationId && pinnedConversationIds.has(attempt.conversationId)) || (attempt.agentPath && context.pinnedPaths.has(attempt.agentPath)))));
    if (pipeline.state === "closed" || pipeline.hiddenAt) return restored ? [{ ...pipeline, restored: true }] : [];
    if ((pipeline.repoDir && fs.existsSync(pipeline.repoDir)) || (pipeline.worktreeDir && fs.existsSync(pipeline.worktreeDir))) return [pipeline];
    return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && scanned.has(attempt.agentPath)))) ? [pipeline] : [];
  });
}
