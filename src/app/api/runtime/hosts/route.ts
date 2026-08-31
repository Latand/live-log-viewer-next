import { NextRequest, NextResponse } from "next/server";

import { allowedStructuredHostTarget, consumeKillTarget } from "@/lib/resources";
import {
  structuredHostKillRefusal,
  terminateStructuredHostTree,
  type StructuredHostKillIntent,
} from "@/lib/runtime/structuredHostControl";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KillResponse {
  ok: true;
  target: string;
  /** How the host was ended: through the runtime that held it, by process
      group, or not at all because it had already exited. */
  via: "runtime" | "process-group" | "already-exited";
  /** Processes signalled. A successful kill leaves none behind. */
  killed: number;
}

/** The dialog's three gestures, each promising something different about the
    host it reaches. Anything else is refused rather than read as the mildest. */
function killIntent(action: unknown, hours: unknown): StructuredHostKillIntent | null {
  if (action === undefined || action === "row") return { kind: "row" };
  if (action === "all") return { kind: "all" };
  if (action !== "idle") return null;
  const value = typeof hours === "number" ? hours : Number.NaN;
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 7) return null;
  return { kind: "idle", hours: value };
}

/**
 * Terminates one structured host from the resources rail: POST with the
 * `target` the last /api/resources snapshot listed.
 *
 * The snapshot is the whole authority. A target it did not list has no entry
 * here and is refused, which is what keeps the operator's own shells, the
 * viewer, the runtime host and the account-migration workers out of reach — the
 * rail never lists them, so nothing can name them. A listed target still has to
 * pass the process fence (pid, start identity, and boot epoch), and
 * the promises the gesture makes — a settled turn and a quiet transcript for
 * "kill idle", an untouched orchestrator seat for either bulk kill — are
 * re-read from the registry here rather than trusted from a snapshot that may
 * be minutes old.
 */
export async function POST(req: NextRequest): Promise<NextResponse<KillResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { action?: unknown; target?: unknown; includeSeat?: unknown; intent?: unknown; idleHours?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "kill") return NextResponse.json({ error: "unsupported action" }, { status: 400 });
  const intent = killIntent(body.intent, body.idleHours);
  if (intent === null) return NextResponse.json({ error: "unsupported intent" }, { status: 400 });

  const target = typeof body.target === "string" ? body.target : "";
  const ref = allowedStructuredHostTarget(target);
  if (ref === null) {
    return NextResponse.json({ error: "unknown host — refresh the resource list" }, { status: 400 });
  }
  const refusal = structuredHostKillRefusal(ref, intent, body.includeSeat === true);
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });

  const outcome = await terminateStructuredHostTree(ref);
  if (!outcome.ok) {
    /* A stale target names a pid the kernel has moved on from: its authority
       is spent. A partial kill keeps its authority so the operator can retry
       the same row without waiting for the next poll. */
    if (outcome.stale) consumeKillTarget(target);
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  /* The pid belongs to the kernel again, so this target is spent. */
  consumeKillTarget(target);
  return NextResponse.json({ ok: true, target, via: outcome.via, killed: outcome.pids.length });
}
