import { statePath } from "@/lib/configDir";
import { flowStateCollectionSeed, planFlowStateMigration } from "@/lib/flows/store";
import { pipelineStateCollectionSeeds, planPipelineStateMigration } from "@/lib/pipelines/store";
import { stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { planWorkflowStateMigration, workflowStateCollectionSeed } from "@/lib/workflows/store";

export interface HotStateMigrationPlan {
  flows: { records: number; keys: string[] };
  pipelines: { records: number; keys: string[] };
  pipelinesArchive: { records: number; keys: string[] };
  workflows: { records: number; keys: string[] };
}

/** A complete marker set is the durable, idempotent migration guard. */
export function hotStateMigrationApplied(): boolean {
  return stateCollectionsInitialized(statePath("state.sqlite"), [
    flowStateCollectionSeed(),
    ...pipelineStateCollectionSeeds(),
    workflowStateCollectionSeed(),
  ]);
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
