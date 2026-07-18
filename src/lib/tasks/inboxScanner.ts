import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { readSession, type SessionRecord } from "@/lib/session/reader";
import type { FileEntry } from "@/lib/types";
import { autoTaskPosition } from "./lattice";

import { createTask } from "./commands";
import { mutateTasks } from "./store";
import type { TaskSource } from "./types";

const SCAN_STATE_FILE = statePath("task-inbox-scan.json");
const HOUR_MS = 60 * 60 * 1000;
const MAX_SEEN = 5000;
const MAX_CREATED_PER_SCAN = 25;
const TASK_TITLE_LIMIT = 96;

interface ScanState {
  lastRunAt?: string;
  seen?: unknown;
}

export interface TaskCandidate {
  project: string;
  text: string;
  source: TaskSource;
  mtime: number;
}

let lastTickMs = 0;

export function taskInboxEnabled(): boolean {
  return process.env.LLV_ENABLE_AUTO_TASK_INBOX === "1";
}

function readScanState(filePath = SCAN_STATE_FILE): { lastRunAt: string | null; seen: string[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ScanState;
    return {
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { lastRunAt: null, seen: [] };
  }
}

function writeScanState(state: { lastRunAt: string; seen: string[] }, filePath = SCAN_STATE_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: state.lastRunAt, seen: state.seen.slice(-MAX_SEEN) }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function hash(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

function stripInjectedContext(text: string): string {
  let out = text;
  const envEnd = out.lastIndexOf("</environment_context>");
  if (envEnd >= 0) out = out.slice(envEnd + "</environment_context>".length);
  const instructionsEnd = out.lastIndexOf("</INSTRUCTIONS>");
  if (instructionsEnd >= 0) out = out.slice(instructionsEnd + "</INSTRUCTIONS>".length);
  return out.trim();
}

function normalizePrompt(text: string): string {
  return stripInjectedContext(text)
    .replace(/(?:э[-\s]*э[-\s]*э|эээ|ээ|эм|ммм)/giu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isServicePrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^(?:<|Caveat:|\[Request interrupted|This came from another Claude session|# AGENTS\.md instructions)/.test(trimmed)) return true;
  if (trimmed.length < 18) return true;
  return false;
}

const TASKISH =
  /(?:созда(?:й|ть|л)|сдела(?:й|ть)|добав(?:ь|ить)|исправ(?:ь|ить)|почин(?:и|ить)|проверь|разберись|найди|напиши|реализ(?:уй|овать)|запусти|подготовь|обнови|перенеси|удали|отрефактори|проанализируй|\b(?:create|add|fix|implement|build|write|review|check|investigate|run|update|refactor|deploy|make|set up|setup)\b)/i;

function trimRequestLead(text: string): string {
  return text
    .replace(/^(?:я\s+бы\s+хотел(?:а)?|хочу|нужно|надо)(?:,?\s+чтобы\s+ты)?\s+/iu, "")
    .replace(/^(?:пожалуйста|pls|please),?\s+/iu, "")
    .replace(/^(?:i(?:'d| would)\s+like\s+(?:you\s+)?to|can you|could you)\s+/iu, "")
    .trim();
}

function normalizeLeadingVerb(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/^создал[а]?\s+/iu, "создать "],
    [/^сделал[а]?\s+/iu, "сделать "],
    [/^написал[а]?\s+/iu, "написать "],
    [/^добавил[а]?\s+/iu, "добавить "],
    [/^исправил[а]?\s+/iu, "исправить "],
    [/^проверил[а]?\s+/iu, "проверить "],
    [/^запустил[а]?\s+/iu, "запустить "],
    [/^подготовил[а]?\s+/iu, "подготовить "],
    [/^обновил[а]?\s+/iu, "обновить "],
    [/^реализовал[а]?\s+/iu, "реализовать "],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

function sentenceHead(text: string): string {
  const firstParagraph = text.split(/\n\s*\n/, 1)[0] ?? text;
  const firstSentence = firstParagraph.match(/^(.{18,}?[.!?。！？])(?:\s|$)/u)?.[1] ?? firstParagraph;
  return firstSentence
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
}

function titleCaseFirst(text: string): string {
  const first = text.charAt(0);
  return first ? first.toLocaleUpperCase() + text.slice(1) : text;
}

export function taskTextFromPrompt(raw: string): string | null {
  const prompt = normalizePrompt(raw);
  if (isServicePrompt(prompt) || !TASKISH.test(prompt)) return null;
  const title = titleCaseFirst(normalizeLeadingVerb(trimRequestLead(sentenceHead(prompt)))).slice(0, TASK_TITLE_LIMIT).trim();
  return title || null;
}

function sourceFor(entry: FileEntry, message: SessionRecord, index: number): TaskSource {
  const text = normalizePrompt(message.text);
  return {
    path: entry.path,
    ts: message.ts,
    text,
    fingerprint: hash([entry.path, message.ts ?? String(index), text]),
    engine: entry.engine === "codex" ? "codex" : "claude",
  };
}

function isSessionEntry(entry: FileEntry): entry is FileEntry & { engine: "claude" | "codex" } {
  return entry.path.endsWith(".jsonl") && (entry.engine === "claude" || entry.engine === "codex");
}

export function collectTaskCandidates(files: FileEntry[], sinceMs: number, seen: ReadonlySet<string>): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];
  const sources = files
    .filter((entry): entry is FileEntry & { engine: "claude" | "codex" } => isSessionEntry(entry) && entry.mtime * 1000 >= sinceMs)
    .sort((a, b) => a.mtime - b.mtime);
  for (const entry of sources) {
    const session = readSession(entry.path, entry.engine);
    session.messages.forEach((message, index) => {
      if (message.role !== "user") return;
      const source = sourceFor(entry, message, index);
      if (seen.has(source.fingerprint)) return;
      const text = taskTextFromPrompt(source.text);
      if (!text) return;
      candidates.push({ project: entry.project, text, source, mtime: entry.mtime });
    });
  }
  return candidates.slice(-MAX_CREATED_PER_SCAN);
}

export function tickTaskInbox(files: FileEntry[], deps: { now?: () => Date; stateFile?: string } = {}): void {
  if (!taskInboxEnabled()) return;
  const now = deps.now?.() ?? new Date();
  if (now.getTime() - lastTickMs < HOUR_MS) return;
  lastTickMs = now.getTime();
  const stateFile = deps.stateFile ?? SCAN_STATE_FILE;
  const state = readScanState(stateFile);
  const seen = new Set(state.seen);
  const sinceMs = Math.max(now.getTime() - HOUR_MS, state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0);
  const existingFingerprints = new Set<string>();
  const createdFingerprints: string[] = [];
  mutateTasks((tasks) => {
    for (const task of tasks) {
      if (task.source?.fingerprint) existingFingerprints.add(task.source.fingerprint);
    }
    const candidates = collectTaskCandidates(files, sinceMs, new Set([...seen, ...existingFingerprints]));
    let next = tasks;
    for (const candidate of candidates) {
      const projectTasks = next.filter((task) => task.project === candidate.project);
      const outcome = createTask(next, {
        project: candidate.project,
        text: candidate.text,
        pos: autoTaskPosition(projectTasks),
        source: candidate.source,
      });
      if (!outcome.ok) continue;
      next = outcome.tasks;
      createdFingerprints.push(candidate.source.fingerprint);
      seen.add(candidate.source.fingerprint);
    }
    return { tasks: next === tasks ? undefined : next, result: undefined };
  });
  writeScanState({ lastRunAt: now.toISOString(), seen: [...seen, ...createdFingerprints] }, stateFile);
}
