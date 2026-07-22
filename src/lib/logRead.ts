import fs from "node:fs/promises";

import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import type { LogChunk } from "@/lib/types";

/**
 * Forward tail read shared by /api/log and the batched /api/logs: `offset`
 * continues a poll, the very first read of a large file jumps to the last
 * MAX_CHUNK bytes. `budget` caps how many bytes this read may return — a
 * batch response splits one byte budget across many files, and a file that
 * ran out of budget gets an idle chunk at its current offset so the client
 * simply catches up on the next tick. Returns null for a path outside the
 * whitelisted roots (or one that is not a file).
 */
export async function readTailChunk(pathname: string, offsetInput: number, budget = MAX_CHUNK): Promise<LogChunk | null> {
  let stat;
  try {
    stat = await fs.stat(pathname);
  } catch {
    stat = null;
  }
  if (!pathname || !stat?.isFile() || !pathAllowed(pathname)) return null;
  const size = stat.size;

  let offset = offsetInput;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (offset > size) offset = 0;
  /* A disconnected live subscriber can return with a very old offset. Bound
     every forward catch-up to the live tail window so reconnect churn cannot
     replay a multi-hundred-megabyte transcript through the Viewer event loop.
     Older feed pages remain available through the backward history route. */
  if (size - offset > MAX_CHUNK) offset = size - MAX_CHUNK;

  const want = Math.min(MAX_CHUNK, Math.max(0, budget), Math.max(0, size - offset));
  if (want === 0) return { offset, start: offset, size, data: "" };

  const fh = await fs.open(pathname, "r");
  try {
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return {
      offset: offset + bytesRead,
      start: offset,
      size,
      data: buf.subarray(0, bytesRead).toString("utf-8"),
    };
  } finally {
    await fh.close();
  }
}
