import type { RuntimeEvent, RuntimeEventInput } from "./contracts";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { Workflow } from "@/lib/workflows/types";

export interface RuntimeConsumerPorts {
  flowReady(flowId: string, note: string | null): Promise<Flow | void> | Flow | void;
  workflowStageCompleted(workflowId: string, stage: number): Promise<Workflow | void> | Workflow | void;
  taskDeliveryAcknowledged(taskId: string, assignmentId: string): Promise<BoardTask | void> | BoardTask | void;
}

function text(...values: unknown[]): string | null {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Event-only adaptation seam for legacy stores. It never scans files and has
 * no browser dependency, allowing a hosted turn to drive flow progression.
 */
function projection(kind: "flow" | "workflow" | "task", id: string, value: unknown, event: RuntimeEvent): RuntimeEventInput[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return [{
    scope: { type: kind, id },
    kind: `${kind}.state`,
    payload: value as Record<string, unknown>,
    producer: { kind: "runtime-consumer", eventKey: `consumer:${event.eventId}:${kind}:${id}` },
    causationId: event.eventId,
    correlationId: kind === "flow" ? id : event.correlationId,
  }];
}

export async function consumeRuntimeEvent(event: RuntimeEvent, ports: RuntimeConsumerPorts): Promise<RuntimeEventInput[]> {
  if (event.kind === "turn-ended") {
    const flowId = text(event.payload.flowId);
    if (flowId) return projection("flow", flowId, await ports.flowReady(flowId, text(event.payload.readyNote, event.payload.finalAssistantOutput)), event);
    return [];
  }
  if (event.kind === "workflow.stage.completed") {
    const workflowId = text(event.payload.workflowId);
    const stage = event.payload.stage;
    if (workflowId && typeof stage === "number" && Number.isInteger(stage) && stage >= 0) return projection("workflow", workflowId, await ports.workflowStageCompleted(workflowId, stage), event);
    return [];
  }
  if (event.kind === "task.delivery.acked") {
    const taskId = text(event.payload.taskId);
    const assignmentId = text(event.payload.assignmentId);
    if (taskId && assignmentId) return projection("task", taskId, await ports.taskDeliveryAcknowledged(taskId, assignmentId), event);
  }
  return [];
}
