import fs from "node:fs";

import type { Activity, RootKey } from "../types";
import { globalCache } from "./caches";
import { numberValue, readJson, recordValue, recordsValue, stringValue } from "./json";
import { outputHolders, pidAlive } from "./process";

const turnCache = globalCache<[number, string | null]>("turn");

export function tailRecords(pathname: string, size: number, nbytes = 131_072) {
  let data: string;
  let seek = 0;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      seek = Math.max(0, size - nbytes);
      const buf = Buffer.alloc(Math.max(0, size - seek));
      fs.readSync(fd, buf, 0, buf.length, seek);
      data = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  let lines = data.split("\n");
  if (seek > 0 && lines.length) lines = lines.slice(1);
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
    } catch {
      /* skip malformed tail rows */
    }
  }
  return out;
}

function jsonlTurnState(pathname: string, size: number, codex: boolean) {
  /* Codex rollouts without task lifecycle events (≤ May 2026) fall back to
     the newest record kind: a final answer newer than all tool activity means
     the turn is over; tool activity newer than any message means it is open. */
  let codexFallback: "done" | "busy" | null = null;
  for (const obj of tailRecords(pathname, size).reverse()) {
    if (codex) {
      const payload = recordValue(obj.payload) ?? {};
      const pt = stringValue(payload.type);
      if (obj.type === "session_meta" || pt === "token_count" || pt === "reasoning" || pt === null) {
        continue;
      }
      /* Turn lifecycle events are the authoritative signal. Codex narrates
         with interim agent_message records mid-turn (dozens per long turn),
         so a message alone must never be read as «turn over» — that misread
         showed working agents as «закінчив хід — чекає відповіді». */
      if (pt === "task_complete" || pt === "turn_complete" || pt === "turn_aborted") return "done";
      if (pt === "task_started" || pt === "turn_started" || pt === "user_message") return "busy";
      if (pt === "agent_message" || (pt === "message" && payload.role === "assistant")) {
        codexFallback ??= "done";
        continue;
      }
      if (pt === "message") return "busy";
      /* Function calls, outputs, patch applications: mid-turn work. Only a
         provisional verdict — an even newer lifecycle event still wins. */
      codexFallback ??= "busy";
      continue;
    }
    const t = obj.type;
    if (t === "assistant") {
      const message = recordValue(obj.message) ?? {};
      /* stop_reason is definitive when present: interim narration inside a
         turn carries "tool_use" even on text-only chunks, and only the real
         final message ends with end_turn/stop_sequence. */
      const stop = stringValue(message.stop_reason);
      if (stop === "end_turn" || stop === "stop_sequence") return "done";
      if (stop) return "busy";
      const parts = recordsValue(message.content);
      if (parts.some((part) => part.type === "tool_use")) return "busy";
      if (parts.some((part) => part.type === "text" && (stringValue(part.text) ?? "").trim())) {
        return "done";
      }
      return "busy";
    }
    if (t === "user") return "busy";
  }
  return codexFallback;
}

/** Activity plus the machine-readable reason behind the judgement — surfaced
    in tooltips and the event log so a wrong idle/busy call is diagnosable
    instead of a mystery (the classic failure of pane-scraping orchestrators). */
export interface ActivityVerdict {
  state: Activity;
  reason: string;
}

export function activityVerdict(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
  job: Record<string, unknown> | null = null,
): ActivityVerdict {
  const age = Date.now() / 1000 - mtime;
  if (root === "codex-jobs") {
    const jobJson = job ?? readJson(pathname.replace(/\.log$/, ".json"));
    if (jobJson) {
      if (jobJson.status === "running") {
        const pid = numberValue(jobJson.pid);
        if (pid !== null && pidAlive(pid)) return { state: "live", reason: "job_pid_alive" };
        return { state: age < 900 ? "recent" : "idle", reason: "job_pid_dead" };
      }
      return { state: age < 900 ? "recent" : "idle", reason: "job_finished" };
    }
  }
  if (root === "claude-tasks" && pathname.endsWith(".output")) {
    if (outputHolders().has(pathname)) return { state: "live", reason: "output_held" };
    return { state: age < 900 ? "recent" : "idle", reason: "output_released" };
  }
  if (pathname.endsWith(".jsonl")) {
    const cached = turnCache.get(pathname);
    let state: string | null;
    if (cached?.[0] === size) state = cached[1];
    else {
      state = jsonlTurnState(pathname, size, root.startsWith("codex"));
      turnCache.set(pathname, [size, state]);
    }
    if (state === "busy") {
      return age < 180 ? { state: "live", reason: "jsonl_turn_open" } : { state: "stalled", reason: "jsonl_turn_stalled" };
    }
    if (state === "done") {
      return { state: age < 900 ? "recent" : "idle", reason: "jsonl_turn_completed" };
    }
  }
  if (age < 20) return { state: "live", reason: "mtime_fresh" };
  if (age < 900) return { state: "recent", reason: "mtime_recent" };
  return { state: "idle", reason: "mtime_old" };
}

export function activity(
  root: RootKey,
  pathname: string,
  mtime: number,
  size: number,
  job: Record<string, unknown> | null = null,
): Activity {
  return activityVerdict(root, pathname, mtime, size, job).state;
}
