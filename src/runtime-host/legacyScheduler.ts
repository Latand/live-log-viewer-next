import { createHash } from "node:crypto";

import { tickFlows } from "@/lib/flows/engine";
import { listFiles } from "@/lib/scanner";
import { tickTaskInbox } from "@/lib/tasks/inboxScanner";
import { LegacyRuntimeScheduler } from "@/lib/runtime/legacyScheduler";
import { tickWorkflows } from "@/lib/workflows/engine";

import { RuntimeJournal } from "./journal";

/** The host owns the legacy safety sweep until structured consumers replace it. */
export function createLegacyRuntimeScheduler(journal: RuntimeJournal): LegacyRuntimeScheduler {
  let previousEvidence: string | null = null;
  return new LegacyRuntimeScheduler({
    scan: listFiles,
    tickFlows,
    tickWorkflows,
    tickTaskInbox,
    publishFiles(entries) {
      const evidence = createHash("sha256").update(JSON.stringify(entries.map((entry) => ({
        path: entry.path,
        mtime: entry.mtime,
        size: entry.size,
        activity: entry.activity,
        pendingQuestion: entry.pendingQuestion?.toolUseId ?? null,
        waitingInput: entry.waitingInput?.since ?? null,
      })))).digest("hex");
      if (evidence === previousEvidence) return;
      previousEvidence = evidence;
      const filesRevision = journal.snapshot().filesRevision + 1;
      journal.append({
        scope: { type: "system", id: "files" },
        kind: "files.revision",
        payload: { filesRevision, evidenceHash: evidence },
        producer: { kind: "legacy-reconciliation" },
      });
    },
  });
}
