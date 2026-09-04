import fs from "node:fs/promises";

import { MAX_CHUNK, pathAllowed } from "@/lib/scanner/roots";
import type { LogChunk } from "@/lib/types";

const NEWLINE = 0x0a;
const SCAN_PIECE = 64 * 1024;

/* The absolute index of the first newline in [from, to), or null. Reads in
   small pieces so a bounded scan never allocates the whole span. */
async function firstNewline(fh: fs.FileHandle, from: number, to: number): Promise<number | null> {
  const piece = Buffer.alloc(Math.min(SCAN_PIECE, Math.max(0, to - from)));
  let at = from;
  while (at < to) {
    const { bytesRead } = await fh.read(piece, 0, Math.min(piece.length, to - at), at);
    if (bytesRead === 0) return null;
    const hit = piece.subarray(0, bytesRead).indexOf(NEWLINE);
    if (hit >= 0) return at + hit;
    at += bytesRead;
  }
  return null;
}

/* Whether `offset` begins a record: the file start, or the byte before it is
   the newline that closed the previous record. */
async function startsRecord(fh: fs.FileHandle, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const one = Buffer.alloc(1);
  const { bytesRead } = await fh.read(one, 0, 1, offset - 1);
  return bytesRead === 1 && one[0] === NEWLINE;
}

/**
 * Forward tail read shared by /api/log and the batched /api/logs: `offset`
 * continues a poll, the very first read of a large file jumps to the last
 * MAX_CHUNK bytes. `budget` caps how many bytes this read may return — a
 * batch response splits one byte budget across many files, and a file that
 * ran out of budget gets an idle chunk at its current offset so the client
 * simply catches up on the next tick. Returns null for a path outside the
 * whitelisted roots (or one that is not a file).
 *
 * The bounded catch-up only ever skips whole records (#1498). An agent
 * reading a rendered frame appends one record larger than the window — the
 * base64 sits in the transcript twice — and jumping into its middle handed
 * the client a partial line it could only drop, so the operator's feed lost
 * the picture. A record is served from its first byte however long it is,
 * and a subscriber already inside a record is handed the rest of it before
 * any jump; only a subscriber on a record boundary with ordinary records
 * behind it is jumped to the live window, as before.
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

  let want = Math.min(MAX_CHUNK, Math.max(0, budget), Math.max(0, size - offset));
  if (want === 0) return { offset, start: offset, size, data: "" };

  const fh = await fs.open(pathname, "r");
  try {
    /* A disconnected live subscriber can return with a very old offset. Bound
       every forward catch-up to the live tail window so reconnect churn cannot
       replay a multi-hundred-megabyte transcript through the Viewer event loop.
       Older feed pages remain available through the backward history route. */
    if (size - offset > MAX_CHUNK) {
      const target = size - MAX_CHUNK;
      const boundary = await firstNewline(fh, offset, Math.min(target, offset + MAX_CHUNK));
      if (boundary === null) {
        /* The record at `offset` spans the live window: serve it in sequence. */
      } else if (!(await startsRecord(fh, offset))) {
        /* The subscriber holds the head of this record: hand it the tail and
           stop at the boundary, so the partial line it carries stays whole.
           The next read starts on a record and jumps from there. */
        want = Math.min(want, boundary + 1 - offset);
      } else {
        offset = target;
        want = Math.min(MAX_CHUNK, Math.max(0, budget), size - offset);
      }
    }
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
