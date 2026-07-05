import { NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import { pidAlive, readPpid } from "@/lib/scanner/process";
import { loadFlows } from "@/lib/flows/store";
import { pathForPanePid, reconcileTasks } from "@/lib/tasks/reconcile";
import { mutateTasks } from "@/lib/tasks/store";
import type { FilesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<FilesResponse>> {
  const files = await listFiles();
  /* Reconciliation runs inside the serialized read-modify-write: the file
     scan above is the slow part, so a task edit landing during it is picked
     up by this fresh load instead of being overwritten by a stale snapshot. */
  const tasks = mutateTasks((current) => {
    const reconciled = reconcileTasks(files, current, {
      pathForPanePid: (panePid, entries) => pathForPanePid(entries, panePid, readPpid),
      panePidAlive: pidAlive,
    });
    return { tasks: reconciled.dirty ? reconciled.tasks : undefined, result: reconciled.tasks };
  });
  return NextResponse.json({ files, flows: loadFlows(), tasks });
}
