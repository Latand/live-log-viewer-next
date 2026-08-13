import { NextResponse } from "next/server";

import { orchestratorRecordExists, readOrchestratorRecord, type OrchestratorRecord } from "@/lib/orchestrator/store";

/* PRD #976 slice D (issue #980) — THE LEGACY GLOBAL ENTRY IS GONE. `POST
   /api/orchestrator` was the designation/adoption half of the Overview chat
   button: it spawned a hardcoded global orchestrator with no engine, model or
   account choice, competing with the per-project seat layer. Creation now
   happens only through `/api/orchestrator/seat`, `/api/orchestrator/rotate` and
   MCP `create_orchestrator`.

   What survives is this READ. The legacy record stays write-only (seat
   activation mirrors the newest seat into it via `syncLegacyRecord`) until
   slice E (#981) migrates its readers, and one of those readers is a BROWSER:
   `src/components/voice/managerIdentity.ts` asks this route which conversation
   is the designated manager, which is what scopes the viewer-context prelude in
   `TmuxComposer` to the manager alone. It fails closed, so dropping this GET
   would not raise an error anywhere — it would silently stop prepending the
   operator's view for every conversation. Retiring it belongs with that
   reader's migration, in slice E. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface OrchestratorStatus {
  record: OrchestratorRecord | null;
  /** Whether the recorded transcript is still on disk. */
  exists: boolean;
  /** The viewer's own checkout — retained in the response shape because the
      record is still read by name; nothing spawns from it any more. */
  defaultCwd: string;
}

export async function GET(): Promise<NextResponse<OrchestratorStatus>> {
  const record = readOrchestratorRecord();
  return NextResponse.json({
    record,
    exists: record !== null && orchestratorRecordExists(record),
    /* `process.cwd()` is only right when the server runs from the checkout. A
       containerized deployment's cwd is container-internal (the stage's `/app`),
       and a manager spawned there lands in a bogus path-encoded project
       (`-app`) with a fallback working directory. Deployments that do not run
       from the checkout must pin the manager's home explicitly. */
    defaultCwd: process.env.LLV_ORCHESTRATOR_CWD?.trim() || process.cwd(),
  });
}
