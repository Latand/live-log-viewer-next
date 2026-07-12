import fs from "node:fs";

import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import type { FileEntry } from "@/lib/types";

import { isRenameableSessionPath } from "./titleStore";

/**
 * Whether an entry is a rename-eligible main session (issue #33, AC9). Server
 * only — native Codex subagents use ordinary `rollout-*.jsonl` names and the
 * scanner marks them `kind = "session"`, so they can only be told apart by the
 * `parent_thread_id` in their transcript's `session_meta`. Kept out of the
 * client bundle; the files response projects the result onto
 * {@link FileEntry.renamable}.
 */
export function isRenameableSessionEntry(entry: Pick<FileEntry, "engine" | "path" | "size"> & { kind?: string }): boolean {
  if (entry.engine !== "claude" && entry.engine !== "codex") return false;
  if (entry.kind && entry.kind !== "session") return false;
  if (!isRenameableSessionPath(entry.path)) return false;
  if (entry.engine === "codex" && isNativeCodexSubagentTranscript(entry.path, entry.size)) return false;
  return true;
}

/**
 * Path-only eligibility for the PATCH boundary, which resolves a transcript
 * without a scanned size. Stats the file for the Codex-subagent head read and
 * treats it as a main session for the kind check.
 */
export function isRenameableTranscriptPath(engine: "claude" | "codex", pathname: string): boolean {
  let size = 0;
  try {
    size = fs.statSync(pathname).size;
  } catch {
    size = 0;
  }
  return isRenameableSessionEntry({ engine, path: pathname, size });
}
