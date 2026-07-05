import type { DeliveryOutcome } from "@/lib/delivery";

import type { AssignmentPatch } from "./commands";
import { taskDeliveryText } from "./helpers";

export interface TaskSendTargetOutcome {
  path: string;
  ok: boolean;
  target: string | null;
  error: string | null;
}

export interface TaskSendAssembly {
  message: string;
  results: TaskSendTargetOutcome[];
  patches: AssignmentPatch[];
  delivered: number;
  failed: number;
}

function isDeliverySuccess(outcome: DeliveryOutcome): outcome is Extract<DeliveryOutcome, { ok: true }> {
  return "ok" in outcome && outcome.ok === true;
}

export function assembleSendResults(
  task: { id: string; text: string },
  paths: string[],
  outcomes: DeliveryOutcome[],
  at: string,
): TaskSendAssembly {
  const results: TaskSendTargetOutcome[] = [];
  const patches: AssignmentPatch[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const targetPath = paths[index]!;
    const outcome = outcomes[index] ?? { error: "немає результату доставки", status: 500 };
    if (isDeliverySuccess(outcome)) {
      results.push({ path: targetPath, ok: true, target: outcome.target, error: null });
      patches.push({ path: targetPath, panePid: null, state: "delivered", error: null, at });
    } else {
      results.push({ path: targetPath, ok: false, target: null, error: outcome.error });
      patches.push({ path: targetPath, panePid: null, state: "failed", error: outcome.error, at });
    }
  }
  const delivered = results.filter((result) => result.ok).length;
  return {
    message: taskDeliveryText(task.id, task.text),
    results,
    patches,
    delivered,
    failed: results.length - delivered,
  };
}
