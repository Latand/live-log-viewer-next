import { tailRecordsResult } from "./scanner/activity";
import { globalCache } from "./scanner/caches";
import type { ActionEvent, FileEntry } from "./types";
import { cleanTitle } from "./title";

const eventCache = globalCache<[number, number, ActionEvent[]]>("timeline-events-v2");

/** Files older than this carry no interesting "recent actions". */
const FRESH_WINDOW_S = 24 * 3600;
const FILES_CAP = 18;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recs(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
    : [];
}

function toTs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms / 1000;
}

const TMSG_SUMMARY = /<teammate-message\b[^>]*summary="([^"]*)"/;

function label(text: string, max = 72): string {
  return cleanTitle(text, max);
}

function claudeEvents(entry: FileEntry, actor: string, records: Record<string, unknown>[]): ActionEvent[] {
  const out: ActionEvent[] = [];
  for (const obj of records) {
    const ts = toTs(obj.timestamp);
    if (ts === null) continue;
    if (obj.type === "user") {
      const content = rec(obj.message).content;
      const text =
        typeof content === "string"
          ? content
          : recs(content)
              .filter((part) => part.type === "text")
              .map((part) => str(part.text))
              .join(" ")
              .trim();
      if (!text) continue;
      if (text.includes("<teammate-message")) {
        const summary = text.match(TMSG_SUMMARY)?.[1];
        /* Wrappers without a summary are service noise (idle notifications). */
        if (summary) out.push({ ts, file: entry.path, actor, kind: "msg", label: "from teammate: " + label(summary) });
        continue;
      }
      if (!text.startsWith("<") && !text.startsWith("[")) {
        out.push({ ts, file: entry.path, actor, kind: "user", label: label(text) });
      }
      continue;
    }
    if (obj.type === "assistant") {
      for (const part of recs(rec(obj.message).content)) {
        if (part.type === "text" && str(part.text).trim()) {
          out.push({ ts, file: entry.path, actor, kind: "turn", label: label(str(part.text)) });
        } else if (part.type === "tool_use") {
          const name = str(part.name);
          const input = rec(part.input);
          if (name === "Task" || name === "Agent") {
            out.push({
              ts,
              file: entry.path,
              actor,
              kind: "spawn",
              label: "started agent: " + label(str(input.description) || str(input.prompt), 56),
            });
          } else if (name === "SendMessage" && typeof input.message === "string") {
            out.push({
              ts,
              file: entry.path,
              actor,
              kind: "msg",
              label: `to ${str(input.to)}: ` + label(str(input.summary), 56),
            });
          }
        }
      }
    }
  }
  return out;
}

function codexEvents(entry: FileEntry, actor: string, records: Record<string, unknown>[]): ActionEvent[] {
  const out: ActionEvent[] = [];
  for (const obj of records) {
    const ts = toTs(obj.timestamp);
    if (ts === null) continue;
    const payload = rec(obj.payload);
    if (payload.type === "user_message" && str(payload.message)) {
      out.push({ ts, file: entry.path, actor, kind: "user", label: label(str(payload.message)) });
    } else if (payload.type === "agent_message" && str(payload.message)) {
      out.push({ ts, file: entry.path, actor, kind: "turn", label: label(str(payload.message)) });
    }
  }
  return out;
}

function fileEvents(entry: FileEntry): ActionEvent[] {
  const mtimeMs = entry.mtime * 1000;
  const cached = eventCache.get(entry.path);
  if (cached && cached[0] === entry.size && cached[1] === mtimeMs) return cached[2];
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  const actor = cleanTitle(entry.title, 36);
  const events = entry.fmt === "claude"
    ? claudeEvents(entry, actor, tail.records)
    : entry.fmt === "codex"
      ? codexEvents(entry, actor, tail.records)
      : [];
  if (tail.complete) eventCache.set(entry.path, [entry.size, mtimeMs, events]);
  return events;
}

/**
 * Recent actions of a project: agent turns, user messages, spawns and
 * inter-agent mail, read from the tails the scanner already touches. Parsing
 * is cached per file identity, so a poll only re-reads files that changed.
 */
export function projectTimeline(files: FileEntry[], project: string, limit: number): ActionEvent[] {
  const now = Date.now() / 1000;
  const sources = files
    .filter(
      (entry) =>
        entry.project === project &&
        entry.path.endsWith(".jsonl") &&
        now - entry.mtime < FRESH_WINDOW_S,
    )
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, FILES_CAP);
  const events = sources.flatMap((entry) => fileEvents(entry));
  return events.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
