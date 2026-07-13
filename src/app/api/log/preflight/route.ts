import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { ownerTranscriptMayExist, transcriptDeletionBlocker } from "@/lib/scanner/deleteSafety";
import { pathAllowed } from "@/lib/scanner/roots";
import { claudeSubagentOwnerPath, transcriptProcessMayBeRunning } from "@/lib/scanner/transcripts";
import { agentProcesses } from "@/lib/scanner/process";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PREFLIGHT_PATHS = 10_000;

type PreflightResponse = { ok: true } | ApiError;

export async function POST(req: NextRequest): Promise<NextResponse<PreflightResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PREFLIGHT_PATHS
    || paths.some((target) => typeof target !== "string" || target.length === 0 || target.length > 16_384)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const targets = [...new Set(paths as string[])];
  for (const target of targets) {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      stat = null;
    }
    if (!stat?.isFile() || !pathAllowed(target)) {
      return NextResponse.json({ error: "path not allowed" }, { status: 403 });
    }
  }

  const ownerExists = new Map<string, boolean>();
  for (const target of targets) {
    const owner = claudeSubagentOwnerPath(target);
    if (owner && !ownerExists.has(owner)) ownerExists.set(owner, await ownerTranscriptMayExist(owner, fs.stat));
  }
  const entries = await listFiles({ pins: [...targets, ...ownerExists.keys()] });
  const processes = agentProcesses(true);
  const dependencies = {
    list: async () => entries,
    ownerPath: claudeSubagentOwnerPath,
    ownerExists: async (owner: string) => ownerExists.get(owner) ?? false,
    processMayBeRunning: (entry: (typeof entries)[number]) => transcriptProcessMayBeRunning(entry, processes),
  };
  for (const target of targets) {
    const blocker = await transcriptDeletionBlocker(target, dependencies);
    if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
