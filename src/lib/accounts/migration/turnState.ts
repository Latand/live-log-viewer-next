import { recordValue, stringValue } from "@/lib/scanner/json";

import type { TurnState } from "./contracts";

type RecordLike = Record<string, unknown>;

function timestamp(record: RecordLike): string | null {
  const value = record.timestamp;
  return typeof value === "string" ? value : null;
}

/** The newest authoritative lifecycle or tool event wins. Assistant prose
    cannot close an active turn because it commonly precedes tool work. */
export function turnStateFromRecords(records: RecordLike[], codex: boolean, authoritative = false): TurnState {
  if (codex) {
    let turnOpen = false;
    let terminalAt: string | null = null;
    let terminalSeen = false;
    const openTools = new Set<string>();
    let anonymousTools = 0;

    for (const record of records) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type);
      if (!type) continue;
      if (type === "task_started" || type === "turn_started" || type === "user_message") {
        turnOpen = true;
        terminalAt = null;
        terminalSeen = false;
        continue;
      }
      if (type === "task_complete" || type === "turn_complete" || type === "turn_completed" || type === "turn_aborted") {
        if (openTools.size === 0 && anonymousTools === 0) {
          turnOpen = false;
          terminalAt = timestamp(record);
          terminalSeen = true;
        } else {
          turnOpen = true;
          terminalAt = null;
          terminalSeen = false;
        }
        continue;
      }
      if (type === "agent_message" || type === "token_count" || type === "reasoning") continue;

      const isOutput = type.includes("output") || type.endsWith("_result");
      const isTool = type.includes("tool") || type.includes("function") || type.includes("command");
      if (!isTool) continue;
      const id = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? stringValue(payload.id);
      if (isOutput) {
        if (id) openTools.delete(id);
        else if (anonymousTools > 0) anonymousTools -= 1;
      } else if (id) {
        openTools.add(id);
      } else {
        anonymousTools += 1;
      }
      turnOpen = true;
      terminalAt = null;
      terminalSeen = false;
    }

    if (terminalSeen && !turnOpen && openTools.size === 0 && anonymousTools === 0) {
      return { state: "terminal", source: "lifecycle", terminalAt };
    }
    if (turnOpen || openTools.size > 0 || anonymousTools > 0) {
      return { state: "busy", source: openTools.size > 0 || anonymousTools > 0 ? "tool" : "lifecycle", terminalAt: null };
    }
    return { state: "unknown", source: "empty", terminalAt: null };
  }

  if (authoritative) {
    let state: TurnState = { state: "unknown", source: "empty", terminalAt: null };
    for (const record of records) {
      if (record.type === "result") {
        state = { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      } else if (record.type === "user") {
        state = { state: "busy", source: "lifecycle", terminalAt: null };
      } else if (record.type === "assistant") {
        state = { state: "busy", source: "assistant", terminalAt: null };
      }
    }
    return state;
  }

  for (const record of [...records].reverse()) {
    if (record.type === "assistant") {
      const stop = stringValue((recordValue(record.message) ?? {}).stop_reason);
      if (stop === "end_turn" || stop === "stop_sequence") return { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      return { state: "busy", source: "assistant", terminalAt: null };
    }
    if (record.type === "user") return { state: "busy", source: "lifecycle", terminalAt: null };
  }
  return { state: "unknown", source: "empty", terminalAt: null };
}
