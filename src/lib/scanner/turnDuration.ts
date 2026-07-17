import type { FileEntry, TurnBoundary } from "../types";
import { turnStateFromRecords as structuredTurnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type RecordLike = Record<string, unknown>;

const turnBoundaryCache = globalCache<[number, number, TurnBoundary | null]>("last-turn-v2");

function parseMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/** True when a transcript record is a prompt that opens a turn — a human or
    relayed user message, NOT a tool result echoed back as a user record. Both
    engines are covered: Claude `type:"user"` with real text content, Codex
    `user_message` / `message`(role user) payloads. Tool-result user records
    carry only `tool_result`/`function_call_output` parts, so they yield no text
    and are correctly skipped. */
function isTurnStart(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = recordValue(record.payload) ?? {};
    if (stringValue(payload.type) === "user_message") {
      return (stringValue(payload.message) ?? "").trim().length > 0;
    }
    if (stringValue(payload.type) === "message" && payload.role === "user") {
      return recordsValue(payload.content).some(
        (part) => (stringValue(part.text) ?? stringValue(part.input_text) ?? "").trim().length > 0,
      );
    }
    return false;
  }
  if (record.type !== "user") return false;
  const content = recordValue(record.message)?.content;
  if (typeof content === "string") return content.trim().length > 0;
  return recordsValue(content).some(
    (part) => part.type === "text" && (stringValue(part.text) ?? "").trim().length > 0,
  );
}

/** Turn boundaries for the most-recent turn from a chronological record slice.
    The turn opens at the LAST prompt in the slice (multi-turn transcripts show
    only the current turn) and closes at the terminal assistant/tool output —
    but only once the turn is complete. While the agent is still working
    `endedAt` stays null so the UI can tick live elapsed. Returns null when no
    opening prompt survives in the tail window. Pure for testability. */
export function lastTurnFromRecords(records: RecordLike[], codex: boolean): TurnBoundary | null {
  let startedAt: number | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isTurnStart(records[index]!, codex)) continue;
    startedAt = parseMillis(records[index]!.timestamp);
    break;
  }
  if (startedAt === null) return null;

  const state = structuredTurnStateFromRecords(records, codex);
  if (state.state !== "terminal") return { startedAt, endedAt: null };

  // A completed turn ends at the terminal lifecycle record's timestamp (the
  // last assistant/tool output). Fall back to the newest parseable timestamp in
  // the slice if the terminal record carried none, and never let a clock skew
  // push the end before the start.
  let endedAt = parseMillis(state.terminalAt);
  if (endedAt === null) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const millis = parseMillis(records[index]!.timestamp);
      if (millis !== null) {
        endedAt = millis;
        break;
      }
    }
  }
  if (endedAt === null) return { startedAt, endedAt: null };
  return { startedAt, endedAt: Math.max(endedAt, startedAt) };
}

/** Last-turn boundaries for a transcript entry, cached by file identity like the sibling
    tail derivations (context, effort). Only conversation transcripts carry the
    per-message timestamps this needs. */
export function lastTurnFor(entry: FileEntry): TurnBoundary | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const mtimeMs = entry.mtime * 1000;
  const cached = turnBoundaryCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  const boundary = lastTurnFromRecords(tail.records, entry.root === "codex-sessions");
  if (tail.complete) turnBoundaryCache.set(entry.path, [entry.size, mtimeMs, boundary]);
  return boundary;
}
