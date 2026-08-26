import { NextRequest, NextResponse } from "next/server";

import { allowedStructuredHostTarget, consumeStructuredHostTarget } from "@/lib/resources";
import { terminateStructuredHostTree } from "@/lib/runtime/structuredHostControl";
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
  /** Processes signalled, and how many outlived the whole ladder. */
  killed: number;
  remaining: number;
}

/**
 * Terminates one structured host from the resources rail: POST with the
 * `target` the last /api/resources snapshot listed.
 *
 * The snapshot is the whole authority. A target it did not list has no entry
 * here and is refused, which is what keeps the operator's own shells, the
 * viewer, the runtime host and the account-migration workers out of reach — the
 * rail never lists them, so nothing can name them. A listed target still has to
 * pass the process fence (pid plus start identity) before a signal is composed,
 * and a live orchestrator seat needs `includeSeat` on top of that.
 */
export async function POST(req: NextRequest): Promise<NextResponse<KillResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { action?: unknown; target?: unknown; includeSeat?: unknown };
  try {
    body = (await req.json()) as { action?: unknown; target?: unknown; includeSeat?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "kill") return NextResponse.json({ error: "unsupported action" }, { status: 400 });

  const target = typeof body.target === "string" ? body.target : "";
  const ref = allowedStructuredHostTarget(target);
  if (ref === null) {
    return NextResponse.json({ error: "unknown host — refresh the resource list" }, { status: 400 });
  }
  if (ref.seat && body.includeSeat !== true) {
    return NextResponse.json({
      error: "this host is a live orchestrator seat — tick it to include it",
    }, { status: 409 });
  }

  const outcome = await terminateStructuredHostTree(ref);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  /* The pid belongs to the kernel again, so the authority this target carried
     is spent whatever the sweep found. */
  consumeStructuredHostTarget(target);
  return NextResponse.json({
    ok: true,
    target,
    via: outcome.via,
    killed: outcome.pids.length,
    remaining: outcome.remaining.length,
  });
}
