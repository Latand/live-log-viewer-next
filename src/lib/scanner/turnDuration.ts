import type { FileEntry, TurnBoundary } from "../types";
import { turnStateFromRecords as structuredTurnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { isClaudeTurnWindowMeta } from "@/lib/claudeProtocolUser";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type RecordLike = Record<string, unknown>;

// v5: meta/command user records no longer open windows (issue #406) — persisted
// v4 boundaries could start before the real initiating prompt.
const turnBoundaryCache = globalCache<[number, number, TurnBoundary | null]>("last-turn-v5");

function parseMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/** True when a transcript record is a prompt that opens a turn — a human or
    relayed user message, NOT a tool result echoed back as a user record and
    NOT harness metadata. Both engines are covered: Claude `type:"user"` with
    real prompt content, Codex `user_message` / `message`(role user) payloads.
    Tool-result user records carry only `tool_result`/`function_call_output`
    parts, so they yield no text and are correctly skipped. Claude journaled
    metadata (command echoes, caveats, task notifications, interrupts,
    compaction summaries) carries text but never initiates or steers a window;
    SDK and idle-delivered peer/coordinator prompts DO (issue #406). */
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
  if (isClaudeTurnWindowMeta(record)) return false;
  const content = recordValue(record.message)?.content;
  if (typeof content === "string") return content.trim().length > 0;
  // An image part is prompt content in its own right: a screenshot-only
  // prompt opens a window exactly like a typed one (feed renders it as user
  // content, not metadata).
  return recordsValue(content).some(
    (part) =>
      part.type === "image" ||
      (part.type === "text" && (stringValue(part.text) ?? "").trim().length > 0),
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

/** Authoritative failure evidence that ends the run WITHOUT a terminal record:
    the operator interrupted the turn (Claude appends a protocol user record —
    `interruptedMessageId` plus the bracket sentinel) or the run crashed on an
    API error surfaced as a flagged assistant message. The window must close on
    it so the next prompt INITIATES a new turn instead of steering a run that
    no longer exists (issue #268 review). Codex interruptions emit a real
    `turn_aborted` lifecycle record, so only the Claude shape needs this. */
function isTurnFailure(record: RecordLike, codex: boolean): boolean {
  if (codex) return false;
  if (record.type === "assistant") return record.isApiErrorMessage === true;
  if (record.type !== "user") return false;
  if ("interruptedMessageId" in record) return true;
  const content = recordValue(record.message)?.content;
  const text = typeof content === "string"
    ? content
    : recordsValue(content).map((part) => stringValue(part.text) ?? "").join("\n");
  return /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(text);
}

/** Turn boundaries for the most-recent turn from a chronological record slice.
    The turn opens at the prompt that INITIATED the work — the first prompt
    after the previous turn closed, whoever sent it (operator or a relaying
    agent). Prompts landing while the run is still open (steering, relayed
    follow-ups) must NOT reset the boundary: the reported span is «initiating
    prompt → last activity», never a single action's own duration (issue #268).
    The turn closes at the terminal assistant/tool output — or, when the run
    was interrupted or crashed and no terminal record exists, at the
    authoritative failure evidence. While the agent is still working `endedAt`
    stays null so the UI can tick live elapsed. Returns null when no opening
    prompt survives in the tail window. Pure for testability. */
export function lastTurnFromRecords(records: RecordLike[], codex: boolean): TurnBoundary | null {
  let startedAt: number | null = null;
  let open = false;
  let failed = false;
  let failedAt: number | null = null;
  for (const record of records) {
    // Failure evidence outranks the prompt shape: the interrupt sentinel is a
    // user record with real text and would otherwise register as a prompt.
    if (isTurnFailure(record, codex)) {
      if (open) {
        failed = true;
        failedAt = parseMillis(record.timestamp) ?? failedAt;
      }
      open = false;
      continue;
    }
    if (isTurnStart(record, codex)) {
      // A later steering prompt only fills in for an initiating prompt whose
      // own timestamp failed to parse — it never moves a valid boundary.
      if (!open || startedAt === null) {
        startedAt = parseMillis(record.timestamp);
        failed = false;
        failedAt = null;
      }
      open = true;
      continue;
    }
    if (isTurnClose(record, codex)) {
      open = false;
      failed = false;
      failedAt = null;
      continue;
    }
    // Assistant output after failure evidence proves the run survived it (a
    // retried API error): reopen so later prompts keep steering, not resetting.
    if (failed && record.type === "assistant") {
      failed = false;
      failedAt = null;
      open = true;
    }
  }
  if (startedAt === null) return null;

  // Journaled metadata is invisible to the terminal-state check too: a
  // trailing notification or command echo after `end_turn` must not flip a
  // finished turn back to busy and restart a dead timer (issue #406). Tool
  // results and genuine prompts — typed, SDK, peer — pass through untouched.
  const stateRecords = codex ? records : records.filter((record) => record.type !== "user" || !isClaudeTurnWindowMeta(record));
  const state = structuredTurnStateFromRecords(stateRecords, codex);
  // The turn is complete on a terminal lifecycle record, or — when none was
  // ever written — on authoritative failure evidence (interrupt sentinel,
  // API-error crash): the window closes there so the elapsed timer cannot run
  // forever on a dead turn (issue #268 review).
  const terminal = state.state === "terminal";
  if (!terminal && !failed) return { startedAt, endedAt: null };

  // A completed turn ends at the terminal lifecycle record's timestamp (the
  // last assistant/tool output) or, failure-closed, at the failure record's.
  // Fall back to the newest parseable timestamp in the slice if that record
  // carried none, and never let a clock skew push the end before the start.
  let endedAt = terminal ? parseMillis(state.terminalAt) : failedAt;
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
