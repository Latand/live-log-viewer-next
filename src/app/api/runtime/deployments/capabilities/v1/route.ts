import { sqliteModeFromEnvironment } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { HOT_STATE_BACKEND, readHotStateAuthority, readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function viewerReleaseStartupReady(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const directory = env.LLV_STATE_DIR?.trim() || statePath(".");
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return true;
  if (target.hotStateBackend !== HOT_STATE_BACKEND) return true;
  const port = env.PORT?.trim();
  if (!port || new URL(target.endpoint).port !== port) return true;
  const authority = readHotStateAuthority(directory);
  return authority?.mode === "sqlite"
    && authority.releaseRevision === target.revision
    && typeof authority.releaseReadyAt === "string";
}

/* The deployment readiness gate probes this route with a 5s budget. It reads
   two small handoff records and still avoids instantiating the agent registry,
   whose first probe would otherwise pay a multi-MB parse. Passive candidates
   stay probeable; the promoted endpoint waits for complete release startup. */
export function GET(): Response {
  if (!viewerReleaseStartupReady()) {
    return Response.json(
      { error: "Viewer release startup is incomplete" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    { capability: "viewer-deployments", version: 1, registryBackendMode: sqliteModeFromEnvironment() },
    { headers: { "cache-control": "no-store" } },
  );
}
