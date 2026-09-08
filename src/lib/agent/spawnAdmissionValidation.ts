import { NextRequest, NextResponse } from "next/server";

import {
  agentSpawnLineageError,
  authenticatedAgentSpawnCaller,
  isAgentInitiatedSpawn,
} from "@/app/api/spawn/admission";
import {
  fenceSpawnAdmissionRejection,
  productionSpawnCommandDependencies,
  type SpawnCommandDependencies,
} from "@/lib/agent/spawnCommand";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

type SpawnValidationDependencies = Pick<SpawnCommandDependencies, "registry">;

function recordBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Validate the role admission that can strand an MCP spawn claim. A refusal
    is useful to recovery only after the shared downstream fence is written. */
export async function executeSpawnAdmissionValidation(
  req: NextRequest,
  dependencies: SpawnValidationDependencies = productionSpawnCommandDependencies,
): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: Record<string, unknown>;
  try {
    const parsed = recordBody(await req.json());
    if (!parsed) return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const lineageError = agentSpawnLineageError(req, body);
  if (lineageError) return NextResponse.json({ error: lineageError }, { status: 400 });

  /* Establish the same caller identity as `/api/spawn` before this endpoint is
     allowed to write a fence. A stranger may learn only the ordinary refusal,
     never burn another caller's downstream key. */
  if (isAgentInitiatedSpawn(req)) {
    let caller: ReturnType<typeof authenticatedAgentSpawnCaller>;
    try {
      caller = authenticatedAgentSpawnCaller(req, body.src, dependencies.registry());
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
    if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 });
  }

  const role = resolveSpawnRole(body);
  if (!role.ok) {
    const fence = fenceSpawnAdmissionRejection(body, 400, role.error, dependencies);
    return NextResponse.json({
      admissible: false,
      fenced: fence?.kind === "fenced",
      reason: role.error,
      status: 400,
    });
  }

  return NextResponse.json({ admissible: true, fenced: false });
}
