import { parseScheduleWakeup } from "../wakeup";
import type { FileEntry, PendingWakeup } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { recordsValue, recordValue, stringValue } from "./json";

/* The board timer chip source (issue #161 §3): the newest `ScheduleWakeup` in a
   Claude transcript tail whose fire time is still ahead. Cached per (path, size)
   like the sibling question/plan probes, so the same tail read is shared. */

const wakeupCache = globalCache<[number, PendingWakeup | null]>("wakeup");

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

function scheduleWakeupCall(obj: Record<string, unknown>): { id: string; input: Record<string, unknown>; ts: string | null } | null {
  if (obj.type !== "assistant") return null;
  for (const block of recordsValue(recordValue(obj.message)?.content)) {
    if (block.type !== "tool_use" || stringValue(block.name) !== "ScheduleWakeup") continue;
    const id = stringValue(block.id);
    if (!id) continue;
    return { id, input: recordValue(block.input) ?? {}, ts: stringValue(obj.timestamp) };
  }
  return null;
}

/**
 * The newest still-pending self-scheduled wakeup of a Claude conversation, or
 * null. Walks the tail newest-first for the newest `ScheduleWakeup` whose result
 * did NOT error — a rejected call is skipped so the board never advertises a
 * wakeup the harness refused (issue #161 review) — resolves its fire time (the
 * result's resolved schedule, else record timestamp + delaySeconds), and returns
 * it only while that time is in the future. A fired or absent wakeup surfaces
 * nothing.
 */
export function pendingWakeupFor(entry: FileEntry, now = Date.now()): PendingWakeup | null {
  if (entry.engine !== "claude" || !entry.path.endsWith(".jsonl")) return null;
  const cached = wakeupCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1];

  const records = tailRecords(entry.path, entry.size);
  let pending: PendingWakeup | null = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const call = scheduleWakeupCall(records[i]);
    if (!call) continue;
    let result: { text: string | null; isError: boolean } | null = null;
    for (let j = i + 1; j < records.length && result === null; j += 1) {
      result = toolResultFor(records[j], call.id);
    }
    // A rejected scheduling call is not the active wakeup — keep looking back.
    if (result?.isError) continue;
    const tsMs = call.ts ? Date.parse(call.ts) : NaN;
    const info = parseScheduleWakeup(call.input, Number.isFinite(tsMs) ? tsMs : null, result?.text ?? null);
    if (info.fireAt !== null && info.fireAt > now) pending = { fireAt: info.fireAt, reason: info.reason };
    break;
  }
  wakeupCache.set(entry.path, [entry.size, pending]);
  return pending;
}
