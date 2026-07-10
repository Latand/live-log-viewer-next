import fs from "node:fs";

import { redactSecrets } from "@/lib/review";
import type { FileEntry } from "@/lib/types";

import type { SnapshotConversation } from "./types";

const SCAN_BYTES = 1024 * 1024;

export function hardenedRedact(text: string): string {
  return redactSecrets(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/(^|\n)(\s*(?:proxy-)?authorization\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]")
    .replace(/(^|\n)(\s*(?:set-)?cookie\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/(?<=Bearer\s)[A-Za-z0-9._-]{12,}/gi, "[redacted]");
}

type CompactMessage = { role: "user" | "assistant"; at: string | null; text: string };
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object" && !Array.isArray(part)).filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
}
function tailMessages(entry: FileEntry): { messages: CompactMessage[]; scannedBytes: number; error: boolean } {
  let data: string; let scannedBytes: number;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("transcript is not a regular file");
    const pathStat = fs.lstatSync(entry.path);
    if (!pathStat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) throw new Error("transcript identity changed");
    const start = Math.max(0, stat.size - SCAN_BYTES); scannedBytes = stat.size - start;
    const buffer = Buffer.alloc(scannedBytes); fs.readSync(descriptor, buffer, 0, buffer.length, start); data = buffer.toString("utf8");
    if (start > 0) data = data.slice(data.indexOf("\n") + 1);
  } catch { return { messages: [], scannedBytes: 0, error: true }; }
  finally { if (descriptor !== null) fs.closeSync(descriptor); }
  const messages: CompactMessage[] = [];
  for (const line of data.split("\n")) {
    try {
      const row = object(JSON.parse(line)); const at = text(row.timestamp) || text(row.ts) || null;
      if (entry.engine === "claude") {
        const role = row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : null;
        const value = contentText(object(row.message).content);
        if (role && value.trim()) messages.push({ role, at, text: value });
      } else {
        const payload = object(row.payload); const type = text(payload.type);
        const role = type === "user_message" ? "user" : type === "agent_message" ? "assistant" : null;
        const value = text(payload.message);
        if (role && value.trim()) messages.push({ role, at, text: value });
      }
    } catch { /* malformed transcript tail */ }
  }
  return { messages, scannedBytes, error: false };
}

function truncateUtf8(value: string, maxCodePoints: number, maxBytes: number): { value: string; truncated: boolean } {
  let bytes = 0; let points = 0; let output = "";
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (points >= maxCodePoints || bytes + pointBytes > maxBytes) return { value: output, truncated: true };
    output += point; bytes += pointBytes; points += 1;
  }
  return { value: output, truncated: false };
}

export function compactText(entry: FileEntry, lastMessages: number, maxChars: number, remainingBytes: number): NonNullable<SnapshotConversation["text"]> {
  const tail = tailMessages(entry);
  const messages = tail.messages.slice(-lastMessages);
  let usedCodePoints = 0;
  let usedBytes = 0;
  let truncated = false;
  const output: NonNullable<SnapshotConversation["text"]>["messages"] = [];
  for (const message of messages) {
    const clean = hardenedRedact(message.text).replace(/\s+/g, " ").trim();
    const availablePoints = Math.max(0, maxChars - usedCodePoints);
    const availableBytes = Math.max(0, remainingBytes - usedBytes);
    if (availablePoints <= 0 || availableBytes <= 0) { truncated = true; break; }
    const bounded = truncateUtf8(clean, availablePoints, availableBytes);
    truncated ||= bounded.truncated;
    usedCodePoints += [...bounded.value].length;
    usedBytes += Buffer.byteLength(bounded.value, "utf8");
    if (bounded.value) output.push({ role: message.role, at: message.at, text: bounded.value });
  }
  return { messages: output, truncated: truncated || tail.error, scannedBytes: tail.scannedBytes, ...(tail.error ? { error: "unavailable" as const } : {}) };
}
