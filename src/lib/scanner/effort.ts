import type { FileEntry } from "../types";
import { headRecordsResult, tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";
import { readArgv } from "./process";

const effortCache = globalCache<[number, number, string | null]>("effort");

/** Union of both CLI scales: codex minimal…ultra, claude low…max. */
const TIERS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function normalizeEffort(value: string | null | undefined): string | null {
  const tier = value?.trim().toLowerCase() ?? "";
  return TIERS.has(tier) ? tier : null;
}

function pickEffort(entry: FileEntry, obj: Record<string, unknown>): string | null {
  if (entry.root === "codex-sessions" && obj.type === "turn_context") {
    const payload = recordValue(obj.payload);
    const direct = stringValue(payload?.effort);
    if (direct) return direct;
    const settings = recordValue(recordValue(payload?.collaboration_mode)?.settings);
    return stringValue(settings?.reasoning_effort);
  }
  if (entry.root === "claude-projects" && obj.type === "assistant") {
    const message = recordValue(obj.message);
    const content = recordsValue(message?.content);
    if (content.some((item) => stringValue(item.type) === "thinking")) return "high";
  }
  return null;
}

/** Live-process argv: codex `-c model_reasoning_effort=X`, claude `--effort X`.
    Claude JSONL can still prove thinking use through assistant content blocks. */
function argvEffort(entry: FileEntry): string | null {
  if (entry.pid === null) return null;
  const argv = readArgv(entry.pid);
  for (let i = 0; i < argv.length - 1; i++) {
    if (entry.engine === "codex" && (argv[i] === "-c" || argv[i] === "--config")) {
      const match = argv[i + 1].match(/^model_reasoning_effort\s*=\s*"?([a-z]+)"?$/i);
      if (match) return match[1];
    }
    if (entry.engine === "claude" && argv[i] === "--effort") return argv[i + 1];
  }
  return null;
}

/**
 * Reasoning-effort tier of a transcript entry, or null when undetectable.
 * Codex uses turn_context. Claude uses explicit argv first, then JSONL thinking
 * blocks as a transcript-backed fallback.
 */
export function entryEffort(entry: FileEntry): string | null {
  return entryEffortResult(entry).value;
}

export interface EntryEffortResult {
  value: string | null;
  complete: boolean;
}

export function entryEffortResult(entry: FileEntry): EntryEffortResult {
  if ((entry.root !== "claude-projects" && entry.root !== "codex-sessions") || !entry.path.endsWith(".jsonl")) {
    return { value: null, complete: true };
  }
  const argv = normalizeEffort(argvEffort(entry));
  if (entry.root === "claude-projects" && argv) return { value: argv, complete: true };
  const mtimeMs = entry.mtime * 1000;
  const cached = effortCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return { value: cached[2] ?? argv, complete: true };
  let effort: string | null = null;
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let complete = tail.complete;
  for (const obj of tail.records.reverse()) {
    effort = normalizeEffort(pickEffort(entry, obj));
    if (effort) break;
  }
  if (!effort) {
    const head = headRecordsResult(entry.path, entry.size, mtimeMs);
    complete &&= head.complete;
    for (const obj of head.records) {
      effort = normalizeEffort(pickEffort(entry, obj));
      if (effort) break;
    }
  }
  if (complete) effortCache.set(entry.path, [entry.size, mtimeMs, effort]);
  return { value: effort ?? argv, complete };
}

/** Codex speed tier from the live process argv. Transcript records currently
    do not carry a stable service-tier field, so unknown and stopped sessions
    remain null. */
export function entryFast(entry: FileEntry): boolean | null {
  if (entry.engine !== "codex" || entry.pid === null) return null;
  const argv = readArgv(entry.pid);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-c" && argv[i] !== "--config") continue;
    const match = argv[i + 1].match(/^service_tier\s*=\s*"?(priority|standard)"?$/i);
    if (match) return match[1].toLowerCase() === "priority";
  }
  return null;
}
