import { agentRegistry } from "@/lib/agent/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const registryBackendMode = agentRegistry().storageDiagnostics().backendMode;
  return Response.json(
    { capability: "viewer-deployments", version: 1, registryBackendMode },
    { headers: { "cache-control": "no-store" } },
  );
}
