import { NextRequest, NextResponse } from "next/server";

import { readTranscriptHosts, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { pathAllowed } from "@/lib/scanner/roots";
import { resolveRequestedTmuxTarget } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

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

async function targetForRequest(
  snapshot: TranscriptHostSnapshot,
  files: readonly FileEntry[],
  pid: number | null,
  pathname: string,
): Promise<string | null> {
  if (pathname && pathAllowed(pathname)) {
    /* Paths carry the conversation identity. A supplied pid may already name
       another process, so it is used only when the request has no path. */
    return snapshot.canonicalFor(pathname)?.display ?? null;
  }
  return pid === null ? null : resolveRequestedTmuxTarget(pid, files);
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const reqs = parseReqs(body);
  if (reqs === null) return NextResponse.json({ error: "invalid request list" }, { status: 400 });

  /* Every path in this batch projects one observation. This keeps the feed's
     target badges internally consistent while panes are being created or
     closed. PID-only compatibility requests retain their own lookup. */
  const files = (await completedFileScan()).snapshot.files;
  const snapshot = await readTranscriptHosts(true, files);
  const pairs = await Promise.all(reqs.map(async ({ id, pid, path }) => [id, await targetForRequest(snapshot, files, pid, path)] as const));
  return NextResponse.json({ targets: Object.fromEntries(pairs) });
}
