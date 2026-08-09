import { sqliteModeFromEnvironment } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { HOT_STATE_BACKEND, readHotStateAuthority, readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function viewerReleaseStartupState(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { activationReady: boolean; releaseReady: boolean } {
  const directory = env.LLV_STATE_DIR?.trim() || statePath(".");
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return { activationReady: true, releaseReady: true };
  if (target.hotStateBackend !== HOT_STATE_BACKEND) return { activationReady: true, releaseReady: true };
  const port = env.PORT?.trim();
  if (!port || new URL(target.endpoint).port !== port) return { activationReady: true, releaseReady: true };
  const authority = readHotStateAuthority(directory);
  const ownsActivatedState = authority?.mode === "sqlite"
    && authority.releaseRevision === target.revision
    && typeof authority.activationReadyAt === "string";
  return {
    activationReady: ownsActivatedState,
    releaseReady: ownsActivatedState && typeof authority.releaseReadyAt === "string",
  };
}

/* The deployment readiness gate probes this route with a 5s budget. It reads
   two small handoff records and still avoids instantiating the agent registry,
   whose first probe would otherwise pay a multi-MB parse. The activation gate
   remains compatible with the deployed predecessor adapter; newer adapters
   also consume releaseReady while structured-host startup finishes. */
export function GET(): Response {
  const startup = viewerReleaseStartupState();
  if (!startup.activationReady) {
    return Response.json(
      { error: "Viewer hot-state activation is incomplete" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    {
      capability: "viewer-deployments",
      version: 1,
      registryBackendMode: sqliteModeFromEnvironment(),
      releaseReady: startup.releaseReady,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
