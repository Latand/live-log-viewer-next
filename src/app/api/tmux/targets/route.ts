import { NextRequest, NextResponse } from "next/server";

import { resolveRequestedTmuxTarget } from "@/lib/tmux";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQS = 64;

interface TargetBatchReq {
  id: string;
  pid: number | null;
  path: string;
}

interface TargetBatchResponse {
  targets: Record<string, string | null>;
}

function parseReqs(body: unknown): TargetBatchReq[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { reqs?: unknown }).reqs;
  if (!Array.isArray(raw) || raw.length > MAX_REQS) return null;
  const reqs: TargetBatchReq[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { id, pid: rawPid, path: rawPath } = entry as Record<string, unknown>;
    if (typeof id !== "string") return null;
    const pid = typeof rawPid === "number" && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
    const path = typeof rawPath === "string" ? rawPath : "";
    reqs.push({ id, pid, path });
  }
  return reqs;
}

export async function POST(req: NextRequest): Promise<NextResponse<TargetBatchResponse | { error: string }>> {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
  const reqs = parseReqs(body);
  if (reqs === null) return NextResponse.json({ error: "некоректний список запитів" }, { status: 400 });

  const pairs = await Promise.all(
    reqs.map(async ({ id, pid, path }) => [id, pid === null && !path ? null : await resolveRequestedTmuxTarget(pid, path)] as const),
  );
  return NextResponse.json({ targets: Object.fromEntries(pairs) });
}
