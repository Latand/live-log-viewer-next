import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { readTailChunk } from "@/lib/logRead";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { listFiles } from "@/lib/scanner";
import { MAX_CHUNK, pathAllowed, ROOTS, scanRootEntries } from "@/lib/scanner/roots";
import type { ApiError, LogChunk } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * A claude root session `<projects>/<slug>/<sid>.jsonl` owns a sibling
 * directory `<projects>/<slug>/<sid>/` (subagent transcripts, tool-results).
 * Left behind, those subagent files would keep the deleted conversation in
 * the list as orphan branches.
 */
function companionDir(filePath: string): string | null {
  const rel = path.relative(ROOTS["claude-projects"], filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !filePath.endsWith(".jsonl")) return null;
  return filePath.slice(0, -".jsonl".length);
}

/**
 * Removes now-empty ancestor directories of a deleted file, stopping at the
 * owning root. Deleting a project's last transcript otherwise leaves an empty
 * `<projects>/<slug>/` (or codex `sessions/YYYY/MM/DD/`) shell behind — the
 * on-disk clutter the delete feature exists to remove. `rmdir` refuses
 * non-empty directories, so a sibling that appeared mid-walk just stops it.
 */
async function pruneEmptyDirs(filePath: string): Promise<void> {
  const root = scanRootEntries().map(([, candidate]) => candidate).find((candidate) => filePath.startsWith(candidate + path.sep));
  if (!root) return;
  let dir = path.dirname(filePath);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
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
  const entry = (await listFiles()).find((item) => item.path === target);
  if (entry?.proc === "running") {
    return NextResponse.json({ error: "agent is still running — stop the process first" }, { status: 409 });
  }
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return NextResponse.json({ error: "could not delete file" }, { status: 500 });
    }
  }
  const dir = companionDir(target);
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await pruneEmptyDirs(target);
  return NextResponse.json({ ok: true });
}
