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

type CollectionMigrationPlan = { records: number; keys: string[] };

function validateMigrationPlan(collection: string, plan: CollectionMigrationPlan): CollectionMigrationPlan {
  const seen = new Set<string>();
  for (const key of plan.keys) {
    if (!key || seen.has(key)) throw new Error(`duplicate or empty ${collection} migration key: ${key}`);
    seen.add(key);
  }
  return plan;
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
    flows: validateMigrationPlan("flows", planFlowStateMigration()),
    pipelines: validateMigrationPlan("pipelines", pipelines.pipelines),
    pipelinesArchive: validateMigrationPlan("pipelines_archive", pipelines.archive),
    workflows: validateMigrationPlan("workflows", planWorkflowStateMigration()),
  };
}
