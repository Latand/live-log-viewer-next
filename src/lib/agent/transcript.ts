import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readHead } from "@/lib/scanner/head";

/**
 * The one home for "where does an agent conversation live on disk":
 * the claude project-slug transform, the transcript path a session with a
 * known id will write, and the head-of-transcript cwd reader. Every caller
 * that used to re-derive these (tmux spec building, flow engine, spawn
 * suggestions, scanner pid attribution) goes through this module.
 */

/** Claude project slugs encode the session cwd with every non-alphanumeric as "-". */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Transcript path a claude session with a pre-chosen id writes under ~/.claude/projects. */
export function claudeTranscriptPath(cwd: string, sessionId: string, projectsRoot = path.join(os.homedir(), ".claude", "projects")): string {
  return path.join(projectsRoot, slugifyCwd(cwd), sessionId + ".jsonl");
}

const HEAD_BYTES = 65_536;

export interface TranscriptFileIdentity {
  size: number;
  mtimeMs: number;
}

/** First `bytes` of a file decoded as utf-8, without reading the rest; "" when unreadable. */
export function readTranscriptHead(pathname: string, bytes = HEAD_BYTES, identity?: TranscriptFileIdentity): string {
  if (identity) {
    const head = readHead(pathname, identity.size, identity.mtimeMs, { maxBytes: bytes });
    return head.complete ? head.value?.text ?? "" : "";
  }
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export interface HeadCwdOptions {
  /** How much of the file head to read; the cwd always sits in the first records. */
  bytes?: number;
  /** Cap on how many head lines to inspect. */
  maxLines?: number;
  /** Only accept a cwd that still exists on disk — spawn/resume need a real
      directory to cd into, while lineage matching wants the recorded value
      even after the directory is gone. */
  requireDir?: boolean;
  /** Known scanner identity enables the shared bounded prefix cache. */
  identity?: TranscriptFileIdentity;
}

/**
 * Session working directory from the head of a transcript. Understands both
 * shapes: claude records carry `cwd` at the top level, codex rollouts nest it
 * as `payload.cwd` in the session_meta record. Malformed or partial head rows
 * are skipped and the scan continues.
 */
export function headCwd(pathname: string, options: HeadCwdOptions = {}): string | null {
  const head = readTranscriptHead(pathname, options.bytes ?? HEAD_BYTES, options.identity);
  if (!head) return null;
  let lines = head.split("\n");
  if (options.maxLines !== undefined) lines = lines.slice(0, options.maxLines);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
      const cwd = typeof obj.cwd === "string" ? obj.cwd : typeof obj.payload?.cwd === "string" ? obj.payload.cwd : null;
      if (!cwd) continue;
      if (options.requireDir && !fs.existsSync(cwd)) continue;
      return cwd;
    } catch {
      /* partial or non-JSON head row */
    }
  }
  return null;
}

/** Session creation time persisted in the transcript header. Codex stores it
    under session_meta.payload while Claude uses the top-level timestamp. */
export function headSessionStartedAt(pathname: string, identity?: TranscriptFileIdentity): string | null {
  const head = readTranscriptHead(pathname, HEAD_BYTES, identity);
  if (!head) return null;
  for (const line of head.split("\n").slice(0, 10)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { timestamp?: unknown; payload?: { timestamp?: unknown } };
      const timestamp = typeof obj.payload?.timestamp === "string"
        ? obj.payload.timestamp
        : typeof obj.timestamp === "string" ? obj.timestamp : null;
      if (timestamp && Number.isFinite(Date.parse(timestamp))) return new Date(timestamp).toISOString();
    } catch {
      /* partial or non-JSON head row */
    }
  }
  return null;
}
