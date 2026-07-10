import { tickFlows } from "@/lib/flows/engine";
import { listFiles } from "@/lib/scanner";
import { tickTaskInbox } from "@/lib/tasks/inboxScanner";
import { LegacyRuntimeScheduler } from "@/lib/runtime/legacyScheduler";
import { tickWorkflows } from "@/lib/workflows/engine";

/** The host owns the legacy safety sweep until structured consumers replace it. */
export function createLegacyRuntimeScheduler(): LegacyRuntimeScheduler {
  return new LegacyRuntimeScheduler({ scan: listFiles, tickFlows, tickWorkflows, tickTaskInbox });
}
