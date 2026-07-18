import crypto from "node:crypto";

import { readSession, type SessionRecord } from "@/lib/session/reader";
import type { FileEntry } from "@/lib/types";
import { autoTaskPosition } from "./lattice";

import { createTask } from "./commands";
import { mutateTasks } from "./store";
import type { BoardTask, TaskSource } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = HOUR_MS;
const DEFAULT_CONTEXT_MESSAGES = 4;
const DEFAULT_MAX_INPUTS = 80;
const DEFAULT_MAX_PROPOSALS = 8;
const TASK_TITLE_LIMIT = 96;

export interface TaskCuratorContextLine {
  role: "user" | "assistant" | "system" | "tool";
  ts: string | null;
  text: string;
  current: boolean;
}

export interface TaskCuratorInput {
  id: string;
  project: string;
  session: {
    path: string;
    title: string;
    engine: "claude" | "codex";
    mtime: number;
    href: string;
  };
  source: TaskSource;
  context: TaskCuratorContextLine[];
  counts: {
    messages: number;
    reasoning: number;
    tools: number;
    traces: number;
  };
  hints: {
    likelyAgentInstruction: boolean;
  };
}

export interface TaskCuratorProposal {
  inputId?: unknown;
  title?: unknown;
}

export interface TaskCuratorApplyResult {
  created: BoardTask[];
  skipped: Array<{ inputId: string | null; title: string | null; reason: string }>;
}

interface CollectOptions {
  now?: Date;
  lookbackMs?: number;
  contextMessages?: number;
  maxInputs?: number;
  /** Scope to a single FileEntry.project; omit/null to capture all projects. */
  project?: string | null;
}

export interface TaskCuratorProject {
  project: string;
  /** Session files for this project touched within the window. */
  sessions: number;
}

interface ApplyOptions extends CollectOptions {
  maxProposals?: number;
  tasksFile?: string;
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

function normalizeText(text: string): string {
  return stripInjectedContext(text)
    .replace(/(?:э[-\s]*э[-\s]*э|эээ|ээ|ем|эм|ммм)/giu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isServiceInput(text: string): boolean {
  const trimmed = text.trim();
  return (
    !trimmed ||
    trimmed.length < 8 ||
    /^(?:<|Caveat:|\[Request interrupted|This came from another Claude session|# AGENTS\.md instructions)/.test(trimmed)
  );
}

function likelyAgentInstruction(text: string): boolean {
  return /(?:^Read `?\.tmux-multi-agent|Write your handoff|Own only|You are the .*owner|Do not touch)/iu.test(text);
}

function messageTimeMs(message: SessionRecord): number | null {
  if (!message.ts) return null;
  const time = new Date(message.ts).getTime();
  return Number.isFinite(time) ? time : null;
}

function isSessionEntry(entry: FileEntry): entry is FileEntry & { engine: "claude" | "codex" } {
  return entry.path.endsWith(".jsonl") && (entry.engine === "claude" || entry.engine === "codex");
}

function sourceFor(entry: FileEntry & { engine: "claude" | "codex" }, message: SessionRecord, index: number, text: string): TaskSource {
  return {
    path: entry.path,
    ts: message.ts,
    text,
    fingerprint: hash([entry.path, message.ts ?? String(index), text]),
    engine: entry.engine,
  };
}

function contextAround(messages: SessionRecord[], index: number, radius: number): TaskCuratorContextLine[] {
  return messages
    .slice(Math.max(0, index - radius), Math.min(messages.length, index + radius + 1))
    .map((message) => ({
      role: message.role,
      ts: message.ts,
      text: normalizeText(message.text).slice(0, 1800),
      current: message === messages[index],
    }))
    .filter((line) => line.text.length > 0);
}

function sourceHref(pathname: string): string {
  return "/#f=" + encodeURIComponent(pathname);
}

export function collectTaskCuratorInputs(files: FileEntry[], options: CollectOptions = {}): TaskCuratorInput[] {
  const now = options.now ?? new Date();
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const sinceMs = now.getTime() - lookbackMs;
  const contextMessages = options.contextMessages ?? DEFAULT_CONTEXT_MESSAGES;
  const maxInputs = options.maxInputs ?? DEFAULT_MAX_INPUTS;
  const project = options.project?.trim() || null;
  const inputs: TaskCuratorInput[] = [];

  const sources = files
    .filter(
      (entry): entry is FileEntry & { engine: "claude" | "codex" } =>
        isSessionEntry(entry) && entry.mtime * 1000 >= sinceMs && (!project || entry.project === project),
    )
    .sort((a, b) => a.mtime - b.mtime);

  for (const entry of sources) {
    const session = readSession(entry.path, entry.engine);
    session.messages.forEach((message, index) => {
      if (message.role !== "user") return;
      const time = messageTimeMs(message);
      if (time !== null && time < sinceMs) return;
      const text = normalizeText(message.text);
      if (isServiceInput(text)) return;
      const source = sourceFor(entry, message, index, text);
      inputs.push({
        id: source.fingerprint,
        project: entry.project,
        session: {
          path: entry.path,
          title: entry.title,
          engine: entry.engine,
          mtime: entry.mtime,
          href: sourceHref(entry.path),
        },
        source,
        context: contextAround(session.messages, index, contextMessages),
        counts: {
          messages: session.messages.length,
          reasoning: session.reasoning.length,
          tools: session.tools.length,
          traces: session.traces.length,
        },
        hints: {
          likelyAgentInstruction: likelyAgentInstruction(text),
        },
      });
    });
  }

  return inputs.slice(-maxInputs);
}

/**
 * The projects that have session activity in the window, so an automation can
 * choose to capture all of them or scope to one via `?project=`. Counts session
 * files touched — cheap metadata only, no session bodies are read here.
 */
export function collectTaskCuratorProjects(files: FileEntry[], options: CollectOptions = {}): TaskCuratorProject[] {
  const now = options.now ?? new Date();
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const sinceMs = now.getTime() - lookbackMs;
  const counts = new Map<string, number>();

  for (const entry of files) {
    if (!isSessionEntry(entry) || entry.mtime * 1000 < sinceMs) continue;
    counts.set(entry.project, (counts.get(entry.project) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([project, sessions]) => ({ project, sessions }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title || title.length > TASK_TITLE_LIMIT) return null;
  if (/(?:э[-\s]*э|ээ|ммм|бляд|хуй|сука)/iu.test(title)) return null;
  return title;
}

function curatedFingerprint(input: TaskCuratorInput, title: string): string {
  return hash(["curated", input.source.fingerprint, title.toLocaleLowerCase()]);
}

function existingTitleKey(task: BoardTask): string {
  return `${task.project}\u0000${task.text.trim().toLocaleLowerCase()}`;
}

export function applyTaskCuratorProposals(
  files: FileEntry[],
  proposals: TaskCuratorProposal[],
  options: ApplyOptions = {},
): TaskCuratorApplyResult {
  const inputs = collectTaskCuratorInputs(files, {
    ...options,
    lookbackMs: options.lookbackMs ?? 6 * HOUR_MS,
  });
  const byId = new Map(inputs.map((input) => [input.id, input]));
  const limited = proposals.slice(0, options.maxProposals ?? DEFAULT_MAX_PROPOSALS);
  const skipped: TaskCuratorApplyResult["skipped"] = [];
  const created: BoardTask[] = [];

  mutateTasks((tasks) => {
    let next = tasks;
    const fingerprints = new Set(next.flatMap((task) => (task.source?.fingerprint ? [task.source.fingerprint] : [])));
    const titles = new Set(next.map(existingTitleKey));

    for (const proposal of limited) {
      const inputId = typeof proposal.inputId === "string" ? proposal.inputId : null;
      const title = normalizeTitle(proposal.title);
      if (!inputId) {
        skipped.push({ inputId, title, reason: "missing inputId" });
        continue;
      }
      const input = byId.get(inputId);
      if (!input) {
        skipped.push({ inputId, title, reason: "unknown inputId" });
        continue;
      }
      if (!title) {
        skipped.push({ inputId, title, reason: "title must be short and clean" });
        continue;
      }

      const fingerprint = curatedFingerprint(input, title);
      const titleKey = `${input.project}\u0000${title.toLocaleLowerCase()}`;
      if (fingerprints.has(fingerprint) || titles.has(titleKey)) {
        skipped.push({ inputId, title, reason: "duplicate" });
        continue;
      }

      const projectTasks = next.filter((task) => task.project === input.project);
      const outcome = createTask(next, {
        project: input.project,
        text: title,
        pos: autoTaskPosition(projectTasks),
        source: {
          ...input.source,
          fingerprint,
        },
      });
      if (!outcome.ok) {
        skipped.push({ inputId, title, reason: outcome.error });
        continue;
      }
      next = outcome.tasks;
      created.push(outcome.task);
      fingerprints.add(fingerprint);
      titles.add(titleKey);
    }

    return { tasks: next === tasks ? undefined : next, result: undefined };
  }, options.tasksFile);

  return { created, skipped };
}
