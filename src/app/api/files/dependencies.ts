import { loadFlows } from "@/lib/flows/store";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { filterPipelinesForFileScan } from "@/lib/pipelines/visibility";
import { loadTasks } from "@/lib/tasks/store";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import { tmuxEndpointHealth } from "@/lib/tmux";

export interface FilesResponseDependencies {
  loadFlows: typeof loadFlows;
  loadPipelinesForProjection: typeof loadPipelinesForProjection;
  filterPipelinesForFileScan: typeof filterPipelinesForFileScan;
  loadTasks: typeof loadTasks;
  loadWorkflows: typeof loadWorkflows;
  filterWorkflowsForFileScan: typeof filterWorkflowsForFileScan;
  tmuxEndpointHealth: typeof tmuxEndpointHealth;
}

const productionDependencies: FilesResponseDependencies = {
  loadFlows,
  loadPipelinesForProjection,
  filterPipelinesForFileScan,
  loadTasks,
  loadWorkflows,
  filterWorkflowsForFileScan,
  tmuxEndpointHealth,
};

let testDependencies: Partial<FilesResponseDependencies> | null = null;

export function filesResponseDependencies(): FilesResponseDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

export function setFilesResponseDependenciesForTests(
  dependencies: Partial<FilesResponseDependencies> | null,
): void {
  testDependencies = dependencies;
}
