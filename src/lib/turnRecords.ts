import { isClaudeTurnWindowMeta } from "@/lib/claudeProtocolUser";

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
}

function records(value: unknown): RecordLike[] {
  return Array.isArray(value)
    ? value.filter((item): item is RecordLike => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function turnRecordTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function startsTurn(entry: RecordLike, codex: boolean): boolean {
  if (codex) {
    const payload = record(entry.payload);
    if (text(payload.type) === "user_message") return text(payload.message).trim().length > 0;
    if (text(payload.type) === "message" && payload.role === "user") {
      return records(payload.content).some((part) => text(part.text ?? part.input_text).trim().length > 0);
    }
    return false;
  }
  if (entry.type !== "user" || isClaudeTurnWindowMeta(entry)) return false;
  const content = record(entry.message).content;
  if (typeof content === "string") return content.trim().length > 0;
  return records(content).some(
    (part) => part.type === "image" || (part.type === "text" && text(part.text).trim().length > 0),
  );
}

function closesTurn(entry: RecordLike, codex: boolean): boolean {
  if (codex) {
    const type = text(record(entry.payload).type);
    return type === "task_complete" || type === "turn_complete" || type === "turn_completed" || type === "turn_aborted";
  }
  if (entry.type === "result") return true;
  if (entry.type !== "assistant") return false;
  const stop = text(record(entry.message).stop_reason);
  return stop === "end_turn" || stop === "stop_sequence";
}

function failsTurn(entry: RecordLike, codex: boolean): boolean {
  if (codex) return false;
  if (entry.type === "assistant") return entry.isApiErrorMessage === true;
  if (entry.type !== "user") return false;
  if ("interruptedMessageId" in entry) return true;
  const content = record(entry.message).content;
  const value = typeof content === "string"
    ? content
    : records(content).map((part) => text(part.text)).join("\n");
  return /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(value);
}

export interface TurnRecordFacts {
  timestampMs: number | null;
  starts: boolean;
  closes: boolean;
  fails: boolean;
  assistantRecord: boolean;
}

export function classifyTurnRecord(entry: RecordLike, codex: boolean): TurnRecordFacts {
  return {
    timestampMs: turnRecordTimestamp(entry.timestamp),
    starts: startsTurn(entry, codex),
    closes: closesTurn(entry, codex),
    fails: failsTurn(entry, codex),
    assistantRecord: entry.type === "assistant",
  };
}
