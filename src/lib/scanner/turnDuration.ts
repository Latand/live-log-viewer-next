import type { FileEntry, TurnBoundary } from "../types";
import { classifyTurnRecord, turnRecordTimestamp } from "@/lib/turnRecords";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type RecordLike = Record<string, unknown>;

// v5: meta/command user records no longer open windows (issue #406) — persisted
// v4 boundaries could start before the real initiating prompt.
const turnBoundaryCache = globalCache<[number, number, TurnBoundary | null]>("last-turn-v5");
const recentTurnWindowsCache = globalCache<[number, number, RecentTurnWindows]>("recent-turn-windows-v3");

export interface RecentTurnWindows {
  windows: TurnBoundary[];
  assistantMessagesAtMs?: number[];
  prefixTruncated: boolean;
  complete: boolean;
}

/** A real assistant message the conversation renders as prose. Tool-only
    records are activity without an acknowledgment, and Claude's synthetic
    no-op is deliberately invisible in the feed. */
function visibleAssistantMessage(record: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = recordValue(record.payload) ?? {};
    const type = stringValue(payload.type);
    if (type === "agent_message") return (stringValue(payload.message) ?? "").trim().length > 0;
    if (type !== "message" || payload.role !== "assistant") return false;
    return recordsValue(payload.content).some(
      (part) => (stringValue(part.text) ?? stringValue(part.output_text) ?? "").trim().length > 0,
    );
  }
  if (record.type !== "assistant" || record.isApiErrorMessage === true) return false;
  const message = recordValue(record.message) ?? {};
  if (stringValue(message.model) === "<synthetic>") return false;
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return recordsValue(message.content).some(
    (part) => part.type === "text" && (stringValue(part.text) ?? "").trim().length > 0,
  );
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
export function recentTurnWindowsFromRecords(records: RecordLike[], codex: boolean): TurnBoundary[] {
  const windows: TurnBoundary[] = [];
  let startedAt: number | null = null;
  let open = false;
  let failedWindow: TurnBoundary | null = null;
  let latestTimestamp: number | null = null;
  for (const record of records) {
    const facts = classifyTurnRecord(record, codex);
    latestTimestamp = facts.timestampMs ?? latestTimestamp;
    // Failure evidence outranks the prompt shape: the interrupt sentinel is a
    // user record with real text and would otherwise register as a prompt.
    if (facts.fails) {
      if (open && startedAt !== null) {
        const endedAt = Math.max(facts.timestampMs ?? latestTimestamp ?? startedAt, startedAt);
        failedWindow = { startedAt, endedAt };
        windows.push(failedWindow);
      }
      open = false;
      continue;
    }
    if (facts.starts) {
      // A later steering prompt only fills in for an initiating prompt whose
      // own timestamp failed to parse — it never moves a valid boundary.
      if (!open || startedAt === null) {
        startedAt = facts.timestampMs;
        failedWindow = null;
      }
      open = true;
      continue;
    }
    if (facts.closes) {
      if (open && startedAt !== null) {
        const endedAt = Math.max(facts.timestampMs ?? latestTimestamp ?? startedAt, startedAt);
        windows.push({ startedAt, endedAt });
      }
      open = false;
      failedWindow = null;
      continue;
    }
    // Assistant output after failure evidence proves the run survived it (a
    // retried API error): reopen so later prompts keep steering, not resetting.
    if (failedWindow && facts.assistantRecord) {
      if (windows.at(-1) === failedWindow) windows.pop();
      failedWindow = null;
      open = true;
    }
  }
  if (open && startedAt !== null) windows.push({ startedAt, endedAt: null });
  return windows;
}

/** Turn windows and visible assistant acknowledgements derived from one record slice. */
export function recentTurnActivityFromRecords(
  records: RecordLike[],
  codex: boolean,
): Pick<RecentTurnWindows, "windows" | "assistantMessagesAtMs"> {
  const assistantMessages = new Set<number>();
  for (const record of records) {
    const atMs = turnRecordTimestamp(record.timestamp);
    if (atMs === null) continue;
    if (visibleAssistantMessage(record, codex)) assistantMessages.add(atMs);
  }
  return {
    windows: recentTurnWindowsFromRecords(records, codex),
    assistantMessagesAtMs: [...assistantMessages].sort((left, right) => left - right),
  };
}

export function lastTurnFromRecords(records: RecordLike[], codex: boolean): TurnBoundary | null {
  return recentTurnWindowsFromRecords(records, codex).at(-1) ?? null;
}

/** Every visible turn window for a conversation transcript tail. */
export function recentTurnWindowsFor(entry: FileEntry): RecentTurnWindows {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) {
    return { windows: [], prefixTruncated: false, complete: true };
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = recentTurnWindowsCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return structuredClone(cached[2]);
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  const activity = recentTurnActivityFromRecords(tail.records, entry.root === "codex-sessions");
  const result: RecentTurnWindows = {
    ...activity,
    prefixTruncated: tail.prefixTruncated,
    complete: tail.complete,
  };
  if (tail.complete) recentTurnWindowsCache.set(entry.path, [entry.size, mtimeMs, result]);
  return structuredClone(result);
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
  const recent = recentTurnWindowsFor(entry);
  const boundary = recent.windows.at(-1) ?? null;
  if (recent.complete) turnBoundaryCache.set(entry.path, [entry.size, mtimeMs, boundary]);
  return boundary;
}

/** Newest visible assistant acknowledgment carried by the same bounded,
    identity-keyed read as {@link lastTurnFor}. */
export function lastAssistantMessageAtFor(entry: FileEntry): number | null | undefined {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const recent = recentTurnWindowsFor(entry);
  const last = recent.assistantMessagesAtMs?.at(-1);
  if (typeof last === "number") return last;
  return recent.prefixTruncated ? undefined : null;
}
