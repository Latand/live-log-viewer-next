import fs from "node:fs";
import path from "node:path";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { describe } from "@/lib/scanner/describe";
import { scanRootEntries } from "@/lib/scanner/roots";
import type { Engine, RootKey } from "@/lib/types";

import type { LifecycleTurnState } from "./vocabulary";

/**
 * The two transcript reads a liveness poll actually needs, each done once and
 * without a scan.
 *
 * A scheduled sweep is the whole point of #645, so the cost of one call has to
 * be the cost of the conversations it was asked about. The inventory scan pays
 * for root discovery, the process table, the tmux pane map and a tail read per
 * transcript before liveness reads the tail again — work a caller naming one
 * conversation has no use for.
 */

export interface LivenessTranscriptEvidence {
  turn: LifecycleTurnState;
  /**
   * Epoch milliseconds of the NEWEST durable record in the tail — tool calls,
   * tool results and every other row included, not just assistant prose.
   *
   * This is the whole liveness question. An agent grinding through a long tool
   * stretch writes records continuously while its last prose message ages; read
   * the prose timestamp instead and a perfectly live agent crosses the stall
   * threshold and is reported dead. Null when no record in the tail carries a
   * timestamp, which leaves the caller its file-mtime fallback.
   */
  lastRecordTs: number | null;
}

/** One transcript, described without a discovery sweep. */
export interface LivenessTranscript {
  path: string;
  project: string;
  title: string;
  engine: Engine;
  mtimeMs: number;
  /** The scan's own conversation attribution. Null for a targeted lookup, which
      resolves the owner from the registry snapshot it already holds. */
  conversationId: string | null;
  /** Scanner activity projection. Present only for entries that came out of an
      inventory scan; a targeted lookup never pays for one. */
  activity: string | null;
  activityReason: string | null;
}

/** Newest parseable record timestamp in a tail. Records are appended in order,
    but a resumed or repaired transcript can interleave, so this takes the
    maximum rather than trusting the last row. */
export function newestRecordTimestamp(records: Record<string, unknown>[]): number | null {
  let newest: number | null = null;
  for (const record of records) {
    const raw = record.timestamp;
    if (typeof raw !== "string") continue;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest;
}

/**
 * Turn state and record freshness from a single identity-verified tail read.
 * The durable evidence path used to answer these with two separate reads of the
 * same bytes; they come from one now.
 */
export async function readLivenessTranscriptEvidence(
  engine: "claude" | "codex",
  transcriptPath: string,
): Promise<LivenessTranscriptEvidence | null> {
  const read = await readStableTailRecords(transcriptPath);
  if (read.integrity !== "complete") return null;
  const turn = turnStateFromRecords(read.records, engine === "codex");
  return {
    turn: turn.state === "terminal" ? "idle" : turn.state === "busy" ? "busy" : "unknown",
    lastRecordTs: newestRecordTimestamp(read.records),
  };
}

/** The scanner root a transcript belongs to, by path prefix alone — no walk. */
function rootForPath(transcriptPath: string): [RootKey, string] | null {
  let best: [RootKey, string] | null = null;
  for (const [rootName, root] of scanRootEntries()) {
    if (transcriptPath !== root && !transcriptPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) continue;
    /* Account homes can nest; the longest matching root is the owning one. */
    if (!best || root.length > best[1].length) best = [rootName, root];
  }
  return best;
}

/**
 * Describes one transcript straight from its path: a stat and the same
 * project/title/engine derivation the scan uses, with no root walk, no process
 * table and no tmux subprocess. Returns null for a path outside every scanner
 * root or one that is not a readable file.
 */
export async function describeTranscriptPath(transcriptPath: string): Promise<LivenessTranscript | null> {
  const rootEntry = rootForPath(transcriptPath);
  if (!rootEntry) return null;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const description = describe(rootEntry[0], rootEntry[1], transcriptPath, stat);
  return {
    path: transcriptPath,
    project: description.project,
    title: description.title,
    engine: description.engine,
    mtimeMs: stat.mtimeMs,
    conversationId: null,
    activity: null,
    activityReason: null,
  };
}
