import fs from "node:fs";

import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

/**
 * Resolving a selected-card reference (#844 §6/§7).
 *
 * The whole point of putting a `conversationId` on the turn is that reading it
 * back costs nothing. A reference resolved by walking transcripts, or by asking
 * for an `operator_snapshot`, would inherit exactly the unhealthy-scan latency
 * this feature is supposed to route around: the operator says "look at that
 * one", the scan is degraded, and the agent stalls on the very lookup that was
 * meant to be free.
 *
 * So resolution is TWO bounded steps and nothing else:
 *
 * 1. IDENTITY — one process-scoped map lookup through `ConversationLookup`,
 *    which is a keyed read of the registry snapshot. No path walk, no
 *    `observeFiles()`, no scan coordinator. The resolver is handed the lookup so
 *    a test can supply one whose scan-shaped methods THROW and still see the
 *    answer come back.
 * 2. CONTENT — an explicit tail read of the named transcript, bounded in both
 *    lines and bytes, with hard ceilings the caller cannot raise. Reading the
 *    transcript is never implicit: a caller that only needs the identity pays
 *    for no I/O at all.
 *
 * The scanner/cache work that makes the FULL snapshot path fast again is a
 * separate lane (#798/#830). This module is what keeps the selected card
 * answerable while that path is still sick.
 */

/** Hard ceilings. `readTail` clamps to these however large the request is: an
    unbounded tail of a multi-gigabyte transcript is the failure mode, and a
    caller asking for one has made a mistake, not a policy decision. */
export const SELECTED_TAIL_MAX_LINES = 200;
export const SELECTED_TAIL_MAX_BYTES = 256 * 1024;

const CONVERSATION_ID = /^conversation_[A-Za-z0-9_-]{1,180}$/;

export interface SelectedConversationRecord {
  conversationId: string;
  engine: "claude" | "codex";
  /** Current generation transcript, or null when the conversation has none. */
  path: string | null;
  project: string | null;
}

export interface BoundedTranscriptTail {
  path: string;
  /** Whole lines only — a tail never hands back a half-record. */
  lines: string[];
  bytes: number;
  /** True when the transcript continues above what was returned. */
  truncated: boolean;
}

export interface SelectedTailOptions {
  maxLines: number;
  maxBytes?: number;
}

export interface SelectedConversationResolver {
  /** Bounded identity resolution: one keyed lookup, no filesystem access. */
  resolve(conversationId: string): SelectedConversationRecord | null;
  /** Explicit bounded tail of the resolved transcript; null when unreadable. */
  readTail(conversationId: string, options: SelectedTailOptions): BoundedTranscriptTail | null;
}

/** The bytes at the end of a file, at most `maxBytes`, plus whether more precede
    them. Opens once and reads one window — the cost does not grow with the file.

    `O_NOFOLLOW` and the regular-file check are what keep this read on the
    artifact the registry named: the path is registry-minted, but the leaf is
    still something outside this process can replace between the scan that
    recorded it and the tail an agent asks for. */
function readTailBytes(pathname: string, maxBytes: number): { buffer: Buffer; precededByMore: boolean } | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(handle);
    if (!opened.isFile()) return null;
    const size = opened.size;
    const window = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(window);
    const read = fs.readSync(handle, buffer, 0, window, size - window);
    return { buffer: buffer.subarray(0, read), precededByMore: window < size };
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already closed — nothing to release */
      }
    }
  }
}

export function selectedConversationResolver(lookup: ConversationLookup = agentRegistry()): SelectedConversationResolver {
  const resolve = (conversationId: string): SelectedConversationRecord | null => {
    if (!CONVERSATION_ID.test(conversationId)) return null;
    const conversation = lookup.conversation(conversationId as ViewerConversationId);
    if (!conversation) return null;
    const generation = conversation.generations.at(-1) ?? null;
    return {
      conversationId: conversation.id,
      engine: conversation.engine,
      path: generation?.path ?? null,
      project: conversation.projectOwnership?.project ?? null,
    };
  };
  return {
    resolve,
    readTail(conversationId, options) {
      const record = resolve(conversationId);
      if (!record?.path) return null;
      const maxLines = Math.max(1, Math.min(SELECTED_TAIL_MAX_LINES, Math.floor(options.maxLines) || 1));
      const maxBytes = Math.max(1, Math.min(SELECTED_TAIL_MAX_BYTES, Math.floor(options.maxBytes ?? SELECTED_TAIL_MAX_BYTES) || 1));
      const read = readTailBytes(record.path, maxBytes);
      if (!read) return null;
      const text = read.buffer.toString("utf8");
      const rows = text.split("\n");
      /* The window may have started mid-record, and a trailing newline leaves an
         empty last element. Dropping both is what keeps every returned line a
         whole one. */
      if (read.precededByMore && rows.length > 0) rows.shift();
      while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
      const lines = rows.slice(-maxLines);
      return {
        path: record.path,
        lines,
        bytes: Buffer.byteLength(lines.join("\n"), "utf8"),
        truncated: read.precededByMore || lines.length < rows.length,
      };
    },
  };
}
