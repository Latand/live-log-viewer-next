import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { outputHolders, pidAlive, pidHoldsPath } from "@/lib/scanner/process";
import { pathAllowed, ROOTS } from "@/lib/scanner/roots";
import { transcriptEngine, verifyTranscriptPid } from "@/lib/scanner/transcripts";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface KillResponse {
  ok: true;
  pid: number;
}

function isUnder(pathname: string, root: string): boolean {
  const rel = path.relative(root, pathname);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function derivePid(pathname: string): Promise<number | null | "invalid" | "stale"> {
  if (isUnder(pathname, ROOTS["claude-tasks"]) && pathname.endsWith(".output")) {
    const pid = outputHolders(true).get(pathname) ?? null;
    if (pid === null || !pidAlive(pid)) return null;
    return pidHoldsPath(pid, pathname) ? pid : "stale";
  }
  if (transcriptEngine(pathname) !== null) {
    // The pid always comes from the scanner's own attribution; client-supplied
    // pids are ignored. verifyTranscriptPid then re-checks /proc at kill time
    // so a recycled pid is rejected instead of signalled.
    const entry = (await listFiles()).find((candidate) => candidate.path === pathname);
    const pid = entry?.pid ?? null;
    if (pid === null || !pidAlive(pid)) return null;
    return verifyTranscriptPid(pathname, pid) ? pid : "stale";
  }
  return "invalid";
}

export async function POST(req: NextRequest): Promise<NextResponse<KillResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { path?: unknown; force?: unknown };
  try {
    body = (await req.json()) as { path?: unknown; force?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const pathname = typeof body.path === "string" ? body.path : "";
  if (!pathname || !pathAllowed(pathname)) {
    return NextResponse.json({ error: "path is outside allowed roots" }, { status: 400 });
  }

  const pid = await derivePid(pathname);
  if (pid === "invalid") {
    return NextResponse.json({ error: "not a process entry" }, { status: 400 });
  }
  if (pid === null || pid === "stale" || !pidAlive(pid)) {
    return NextResponse.json({ error: "process is no longer running" }, { status: 409 });
  }

  try {
    process.kill(pid, body.force ? "SIGKILL" : "SIGTERM");
    return NextResponse.json({ ok: true, pid });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
