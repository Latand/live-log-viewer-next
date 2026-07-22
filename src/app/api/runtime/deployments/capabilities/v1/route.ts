import { sqliteModeFromEnvironment } from "@/lib/agent/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The deployment readiness gate probes this route with a 5s budget. It must
   answer from configuration alone: instantiating the agent registry here made
   the first probe pay a multi-MB JSON parse and time out, failing every
   deploy with "capability gate failed" while the candidate was healthy. */
export function GET(): Response {
  return Response.json(
    { capability: "viewer-deployments", version: 1, registryBackendMode: sqliteModeFromEnvironment() },
    { headers: { "cache-control": "no-store" } },
  );
}
