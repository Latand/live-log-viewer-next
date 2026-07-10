import { isoNow, newRound } from "@/lib/flows/engine";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { loadWorkflows, saveWorkflows } from "@/lib/workflows/store";

import type { RuntimeConsumerPorts } from "./consumers";

const READY = /^REVIEW_READY:\s*(.*)$/m;

function readyNote(value: string | null): string | null {
  if (!value) return null;
  const matched = READY.exec(value);
  return matched ? matched[1]!.trim().slice(0, 2_000) : null;
}

export function advanceFlowFromRuntime(flow: Flow, note: string | null): boolean {
  const ready = readyNote(note);
  if (!ready || (flow.state !== "waiting_ready" && flow.state !== "fixing")) return false;
  flow.rounds.push(newRound(flow, "marker", ready));
  flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
  flow.stateDetail = null;
  return true;
}

export function createServerRuntimeConsumers(): RuntimeConsumerPorts {
  return {
    flowReady(flowId, note) {
      const flows = loadFlows();
      const flow = flows.find((item) => item.id === flowId);
      if (!flow) return undefined;
      if (advanceFlowFromRuntime(flow, note)) saveFlows(flows);
      return flow;
    },
    workflowStageCompleted(workflowId, stage) {
      const workflows = loadWorkflows();
      const workflow = workflows.find((item) => item.id === workflowId);
      if (!workflow) return undefined;
      if (workflow.stageIndex !== stage) return workflow;
      const run = workflow.stageRuns[stage];
      if (!run || run.doneAt) return workflow;
      run.doneAt = isoNow();
      const next = workflow.template.stages[stage + 1];
      if (next) {
        workflow.stageIndex = stage + 1;
        workflow.state = next.kind === "review-loop" ? "reviewing" : "implementing";
      } else {
        workflow.state = "finishing";
      }
      workflow.stateDetail = null;
      saveWorkflows(workflows);
      return workflow;
    },
    taskDeliveryAcknowledged(taskId, assignmentId) {
      const tasks = loadTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return undefined;
      const assignment = task.assignments.find((item) => item.path === assignmentId || item.panePid === Number(assignmentId));
      if (!assignment) return task;
      assignment.state = "delivered";
      assignment.error = null;
      assignment.at = isoNow();
      task.updatedAt = isoNow();
      saveTasks(tasks);
      return task;
    },
  };
}
