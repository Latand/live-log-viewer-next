import { NextRequest, NextResponse } from "next/server";

import {
  agentSpawnLineageError,
  authenticatedAgentSpawnCaller,
  isAgentInitiatedSpawn,
  mandatoryReviewsError,
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

/** One refusal shape for every branch `/api/spawn` refuses before it reserves
    anything. `fenced` reports what the shared compare-and-set actually did:
    false when a launch receipt already owns the key, or the key cannot carry a
    fence, so recovery keeps the original outcome unknown rather than reading a
    refusal that nothing durable backs. */
function refusal(
  body: Record<string, unknown>,
  reason: string,
  dependencies: SpawnValidationDependencies,
): NextResponse {
  const fence = fenceSpawnAdmissionRejection(body, 400, reason, dependencies);
  return NextResponse.json({
    admissible: false,
    fenced: fence?.kind === "fenced",
    reason,
    status: 400,
  });
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

  /* Establish the same caller identity as `/api/spawn` before this endpoint is
     allowed to write a fence. A stranger may learn only the ordinary refusal,
     never burn another caller's downstream key. This precedes the lineage
     refusal below, which now fences (#1641). */
  if (isAgentInitiatedSpawn(req)) {
    let caller: ReturnType<typeof authenticatedAgentSpawnCaller>;
    try {
      caller = authenticatedAgentSpawnCaller(req, body.src, dependencies.registry());
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
    }
    if ("error" in caller) return NextResponse.json({ error: caller.error }, { status: caller.status ?? 403 });
  }

  /* An agent-origin request that names no role, or a reviewer that names no
     `reviews`, is refused here exactly as `/api/spawn` refuses it — and the
     refusal is reported in the admissibility shape, so a recovery probe reads
     the fence instead of an unreadable transport error (#1641). */
  const lineageError = agentSpawnLineageError(req, body);
  if (lineageError) return refusal(body, lineageError, dependencies);

  const role = resolveSpawnRole(body);
  if (!role.ok) return refusal(body, role.error, dependencies);

  /* The same mandatory reviewer predicate the route applies. A same-origin
     reviewer request without `reviews` reaches this branch instead of the
     lineage one, and both must answer with the same durable fence. */
  const reviewsError = mandatoryReviewsError(role.value?.role ?? null, body);
  if (reviewsError) return refusal(body, reviewsError, dependencies);

  return NextResponse.json({ admissible: true, fenced: false });
}
