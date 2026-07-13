import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { readTailChunk } from "@/lib/logRead";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { ownerTranscriptMayExist, transcriptDeletionBlocker, type DeletionSafetyDependencies } from "@/lib/scanner/deleteSafety";
import { removeTranscriptFromDisk } from "@/lib/scanner/deleteTranscript";
import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import { claudeSubagentOwnerPath, transcriptProcessMayBeRunning } from "@/lib/scanner/transcripts";
import type { ApiError, LogChunk } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deletionSafetyDependencies: DeletionSafetyDependencies = {
  list: (pin) => listFiles({ pin }),
  ownerPath: (target) => claudeSubagentOwnerPath(target),
  ownerExists: (ownerPath) => ownerTranscriptMayExist(ownerPath, fs.stat),
  processMayBeRunning: (entry) => transcriptProcessMayBeRunning(entry),
};

/**
 * Chunked log reads. Two modes:
 *  - tail (default): `offset` continues a forward poll; the very first read
 *    of a large file jumps to the last MAX_CHUNK bytes;
 *  - history: `before` returns the chunk of bytes ENDING at that offset, so
 *    the client can walk backwards page by page to the file start.
 */
export async function GET(
  req: NextRequest,
): Promise<NextResponse<LogChunk | ApiError>> {
  const path = req.nextUrl.searchParams.get("path") ?? "";

  const beforeParam = req.nextUrl.searchParams.get("before");
  if (beforeParam !== null) {
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      stat = null;
    }
    if (!path || !stat?.isFile() || !pathAllowed(path)) {
      return NextResponse.json({ error: "path not allowed" }, { status: 403 });
    }
    const size = stat.size;
    let before = Number(beforeParam);
    if (!Number.isFinite(before) || before < 0) before = 0;
    if (before > size) before = size;
    const start = Math.max(0, before - MAX_CHUNK);
    const fh = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(before - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return NextResponse.json({
        offset: start,
        start,
        size,
        data: buf.subarray(0, bytesRead).toString("utf-8"),
      });
    } finally {
      await fh.close();
    }
  }

  const chunk = await readTailChunk(path, Number(req.nextUrl.searchParams.get("offset") ?? "0"));
  if (!chunk) return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  return NextResponse.json(chunk);
}

/**
 * Deletes a transcript/log file from disk. The client confirms before calling.
 * Only whitelisted-root paths qualify (same gate as GET), and a conversation
 * whose agent process is still running is refused — kill it first, otherwise
 * the CLI keeps writing into an unlinked inode and the entry resurrects in a
 * confusing half-alive state.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse<{ ok: true } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const target = req.nextUrl.searchParams.get("path") ?? "";

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    stat = null;
  }
  if (!target || !stat?.isFile() || !pathAllowed(target)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const blocker = await transcriptDeletionBlocker(target, deletionSafetyDependencies);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  try {
    await removeTranscriptFromDisk(target);
  } catch {
    return NextResponse.json({ error: "could not delete file" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
