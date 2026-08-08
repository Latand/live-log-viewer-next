import { planFlowStateMigration } from "@/lib/flows/store";
import { planPipelineStateMigration } from "@/lib/pipelines/store";
import { planWorkflowStateMigration } from "@/lib/workflows/store";

export interface HotStateMigrationPlan {
  flows: { records: number; keys: string[] };
  pipelines: { records: number; keys: string[] };
  pipelinesArchive: { records: number; keys: string[] };
  workflows: { records: number; keys: string[] };
}

/** Parse and normalize every legacy source without opening the SQLite database. */
export function hotStateMigrationDryRun(): HotStateMigrationPlan {
  const pipelines = planPipelineStateMigration();
  return {
    flows: planFlowStateMigration(),
    pipelines: pipelines.pipelines,
    pipelinesArchive: pipelines.archive,
    workflows: planWorkflowStateMigration(),
  };
}

