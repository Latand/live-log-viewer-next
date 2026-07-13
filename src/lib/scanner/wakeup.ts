import { redactSecrets } from "../review";
import { parseScheduleWakeup } from "../wakeup";
import type { FileEntry, PendingWakeup } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { recordsValue, recordValue, stringValue } from "./json";

/* The board timer chip source (issue #161 §3): the newest successful
   `ScheduleWakeup` in a Claude transcript tail whose fire time is still ahead.
   Cached per (path, size) like the sibling question/plan probes, so the same
   tail read is shared. */

const wakeupCache = globalCache<[number, PendingWakeup | null]>("wakeup");
/* The chip's reason is redacted and bounded before it leaves the scanner, the
   same funnel every exported transcript field passes through (issue #161). */
const REASON_MAX = 300;

/** The paired tool_result for a given tool_use id, with its error flag, if
    present in the tail. `text` may be null while `isError` is still meaningful. */
function toolResultFor(obj: Record<string, unknown>, toolUseId: string): { text: string | null; isError: boolean } | null {
  const content = recordsValue(recordValue(obj.message)?.content);
  for (const block of content) {
    if (block.type !== "tool_result" || stringValue(block.tool_use_id) !== toolUseId) continue;
    const isError = block.is_error === true;
    const value = block.content;
    if (typeof value === "string") return { text: value, isError };
    if (Array.isArray(value)) {
      return { text: value.map((item) => (typeof item === "string" ? item : stringValue(recordValue(item)?.text) ?? "")).filter(Boolean).join("\n"), isError };
    }
    return { text: null, isError };
  }
  return null;
}

interface WakeupCall {
  id: string;
  input: Record<string, unknown>;
  ts: string | null;
}

/** Every `ScheduleWakeup` call in one assistant record, in block order (oldest
    first). A single record can carry several tool calls, so the caller scans
    them all to pick the newest (issue #161 review). */
function scheduleWakeupCalls(obj: Record<string, unknown>): WakeupCall[] {
  if (obj.type !== "assistant") return [];
  const ts = stringValue(obj.timestamp);
  const calls: WakeupCall[] = [];
  for (const block of recordsValue(recordValue(obj.message)?.content)) {
    if (block.type !== "tool_use" || stringValue(block.name) !== "ScheduleWakeup") continue;
    const id = stringValue(block.id);
    if (id) calls.push({ id, input: recordValue(block.input) ?? {}, ts });
  }
  return calls;
}

/**
 * The newest still-pending self-scheduled wakeup of a Claude conversation, or
 * null. Walks the tail newest-first — and, within a record, its tool calls
 * newest-first — for the newest `ScheduleWakeup` whose result succeeded; a
 * rejected call is skipped so the board never advertises a wakeup the harness
 * refused (issue #161 review). The chosen call's fire time comes from the
 * result's resolved schedule (else record timestamp + delaySeconds) and it
 * surfaces only while that time is still ahead.
 */
export function pendingWakeupFor(entry: FileEntry, now = Date.now()): PendingWakeup | null {
  if (entry.engine !== "claude" || !entry.path.endsWith(".jsonl")) return null;
  const cached = wakeupCache.get(entry.path);
  if (cached?.[0] === entry.size) {
    // An idle sleeping agent writes nothing until it wakes, so a cached pending
    // wakeup keeps the same file size after it fires. Re-check its fire time
    // against the live clock so an expired wakeup stops surfacing (issue #161
    // review).
    const value = cached[1];
    return value && value.fireAt <= now ? null : value;
  }

  const records = tailRecords(entry.path, entry.size);
  let pending: PendingWakeup | null = null;
  outer: for (let i = records.length - 1; i >= 0; i -= 1) {
    const calls = scheduleWakeupCalls(records[i]);
    for (let k = calls.length - 1; k >= 0; k -= 1) {
      const call = calls[k];
      let result: { text: string | null; isError: boolean } | null = null;
      for (let j = i + 1; j < records.length && result === null; j += 1) {
        result = toolResultFor(records[j], call.id);
      }
      // Skip a rejected scheduling call and keep looking back for a valid one.
      if (result?.isError) continue;
      const tsMs = call.ts ? Date.parse(call.ts) : NaN;
      const info = parseScheduleWakeup(call.input, Number.isFinite(tsMs) ? tsMs : null, result?.text ?? null);
      if (info.fireAt !== null && info.fireAt > now) {
        pending = { fireAt: info.fireAt, reason: redactSecrets(info.reason).slice(0, REASON_MAX) };
      }
      break outer;
    }
  }
  wakeupCache.set(entry.path, [entry.size, pending]);
  return pending;
}
