import type { RuntimeEvent } from "./contracts";

export interface RuntimeConsumerPorts {
  flowReady(flowId: string, note: string | null): Promise<void> | void;
  workflowStageCompleted(workflowId: string, stage: number): Promise<void> | void;
  taskDeliveryAcknowledged(taskId: string, assignmentId: string): Promise<void> | void;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Event-only adaptation seam for legacy stores. It never scans files and has
 * no browser dependency, allowing a hosted turn to drive flow progression.
 */
export async function consumeRuntimeEvent(event: RuntimeEvent, ports: RuntimeConsumerPorts): Promise<void> {
  if (event.kind === "turn.completed") {
    const flowId = text(event.payload.flowId);
    if (flowId) await ports.flowReady(flowId, text(event.payload.readyNote));
    return;
  }
  if (event.kind === "workflow.stage.completed") {
    const workflowId = text(event.payload.workflowId);
    const stage = event.payload.stage;
    if (workflowId && typeof stage === "number" && Number.isInteger(stage) && stage >= 0) await ports.workflowStageCompleted(workflowId, stage);
    return;
  }
  if (event.kind === "task.delivery.acked") {
    const taskId = text(event.payload.taskId);
    const assignmentId = text(event.payload.assignmentId);
    if (taskId && assignmentId) await ports.taskDeliveryAcknowledged(taskId, assignmentId);
  }
}
