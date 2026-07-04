import fs from "node:fs";

import type { FileEntry } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { recordValue, stringValue } from "./json";
import { readArgv } from "./process";

const effortCache = globalCache<[number, string | null]>("effort");

/** Union of both CLI scales: codex minimal…xhigh, claude low…max. */
const TIERS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeEffort(value: string | null | undefined): string | null {
  const tier = value?.trim().toLowerCase() ?? "";
  return TIERS.has(tier) ? tier : null;
}

/** Codex rollouts: turn_context carries the turn's effort, top-level and
    (older CLIs) inside collaboration_mode settings. session_meta has none. */
function pickEffort(entry: FileEntry, obj: Record<string, unknown>): string | null {
  if (entry.root !== "codex-sessions" || obj.type !== "turn_context") return null;
  const payload = recordValue(obj.payload);
  const direct = stringValue(payload?.effort);
  if (direct) return direct;
  const settings = recordValue(recordValue(payload?.collaboration_mode)?.settings);
  return stringValue(settings?.reasoning_effort);
}

/** Live-process argv: codex `-c model_reasoning_effort=X`, claude `--effort X`.
    Claude transcripts never record the flag, so argv is its only source. */
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
 * Codex: newest turn_context in the tail, head lines as fallback, live argv
 * as the second source. Claude: live argv only — never guessed from the model.
 */
export function entryEffort(entry: FileEntry): string | null {
  if ((entry.root !== "claude-projects" && entry.root !== "codex-sessions") || !entry.path.endsWith(".jsonl")) {
    return null;
  }
  if (entry.root !== "codex-sessions") return normalizeEffort(argvEffort(entry));
  const cached = effortCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1] ?? normalizeEffort(argvEffort(entry));
  let effort: string | null = null;
  for (const obj of tailRecords(entry.path, entry.size).reverse()) {
    effort = normalizeEffort(pickEffort(entry, obj));
    if (effort) break;
  }
  if (!effort) {
    try {
      const lines = fs.readFileSync(entry.path, "utf8").split("\n").slice(0, 41);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            effort = normalizeEffort(pickEffort(entry, obj));
            if (effort) break;
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  effortCache.set(entry.path, [entry.size, effort]);
  return effort ?? normalizeEffort(argvEffort(entry));
}
