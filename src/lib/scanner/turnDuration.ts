import type { FileEntry, TurnBoundary } from "../types";
import { turnStateFromRecords as structuredTurnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type RecordLike = Record<string, unknown>;

const turnBoundaryCache = globalCache<[number, number, TurnBoundary | null]>("last-turn-v3");

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

/** True when a record closes the active run for start-detection purposes: the
    next prompt after it INITIATES a new turn instead of steering the current
    one. Claude: the turn's final assistant message (`end_turn`/`stop_sequence`)
    or a headless `result` record. Codex: task/turn lifecycle completion. */
function isTurnClose(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const type = stringValue((recordValue(record.payload) ?? {}).type);
    return type === "task_complete" || type === "turn_complete" || type === "turn_completed" || type === "turn_aborted";
  }
  if (record.type === "result") return true;
  if (record.type !== "assistant") return false;
  const stop = stringValue((recordValue(record.message) ?? {}).stop_reason);
  return stop === "end_turn" || stop === "stop_sequence";
}

/** Turn boundaries for the most-recent turn from a chronological record slice.
    The turn opens at the prompt that INITIATED the work — the first prompt
    after the previous turn closed, whoever sent it (operator or a relaying
    agent). Prompts landing while the run is still open (steering, relayed
    follow-ups) must NOT reset the boundary: the reported span is «initiating
    prompt → last activity», never a single action's own duration (issue #268).
    The turn closes at the terminal assistant/tool output — but only once the
    turn is complete. While the agent is still working `endedAt` stays null so
    the UI can tick live elapsed. Returns null when no opening prompt survives
    in the tail window. Pure for testability. */
export function lastTurnFromRecords(records: RecordLike[], codex: boolean): TurnBoundary | null {
  let startedAt: number | null = null;
  let open = false;
  for (const record of records) {
    if (isTurnStart(record, codex)) {
      // A later steering prompt only fills in for an initiating prompt whose
      // own timestamp failed to parse — it never moves a valid boundary.
      if (!open || startedAt === null) startedAt = parseMillis(record.timestamp);
      open = true;
      continue;
    }
    if (isTurnClose(record, codex)) open = false;
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
