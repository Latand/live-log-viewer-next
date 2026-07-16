import type { FileEntry, PendingQuestion, PendingQuestionItem, PendingQuestionOption } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { recordValue, recordsValue, stringValue } from "./json";

type PendingQuestionDraft = Omit<PendingQuestion, "pid" | "paneTarget">;

globalCache<unknown>("questions").clear();
const questionCache = globalCache<[number, PendingQuestionDraft | null]>("questions-v2");

function timestampOf(obj: Record<string, unknown>): string {
  return stringValue(obj.timestamp) ?? stringValue(obj.created_at) ?? new Date().toISOString();
}

function normalizeOption(obj: Record<string, unknown>): PendingQuestionOption | null {
  const raw = stringValue(obj.label)?.trim();
  if (!raw) return null;
  const label = raw.replace(/\s*\(Recommended\)\s*$/i, "").trim();
  return {
    label: label || raw,
    description: stringValue(obj.description)?.trim() ?? "",
    recommended: /\(Recommended\)\s*$/i.test(raw),
  };
}

function normalizeQuestion(obj: Record<string, unknown>): PendingQuestionItem | null {
  const question = stringValue(obj.question)?.trim();
  if (!question) return null;
  const options = recordsValue(obj.options).map(normalizeOption).filter((item): item is PendingQuestionOption => item !== null);
  options.sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return {
    question,
    header: stringValue(obj.header)?.trim() ?? "Question",
    multiSelect: obj.multiSelect === true,
    options,
  };
}

function toolResultId(obj: Record<string, unknown>): string | null {
  const direct = stringValue(obj.tool_use_id);
  if (direct) return direct;
  const content = recordsValue(recordValue(obj.message)?.content);
  for (const block of content) {
    const id = stringValue(block.tool_use_id);
    if (block.type === "tool_result" && id) return id;
  }
  return null;
}

function toolResultText(obj: Record<string, unknown>, toolUseId: string): string | null {
  const direct = stringValue(obj.tool_use_id);
  if (direct === toolUseId) {
    const content = obj.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((item) => (typeof item === "string" ? item : stringValue(recordValue(item)?.text) ?? "")).filter(Boolean).join("\n");
    return JSON.stringify(obj);
  }
  const content = recordsValue(recordValue(obj.message)?.content);
  for (const block of content) {
    if (block.type !== "tool_result" || stringValue(block.tool_use_id) !== toolUseId) continue;
    const value = block.content;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : stringValue(recordValue(item)?.text) ?? "")).filter(Boolean).join("\n");
    return JSON.stringify(block);
  }
  return null;
}

function assistantToolUse(obj: Record<string, unknown>): { id: string; name: string; input: Record<string, unknown> } | null {
  if (obj.type !== "assistant") return null;
  for (const block of recordsValue(recordValue(obj.message)?.content)) {
    if (block.type !== "tool_use") continue;
    const id = stringValue(block.id);
    const name = stringValue(block.name);
    const input = recordValue(block.input) ?? {};
    if (id && (name === "AskUserQuestion" || name === "ExitPlanMode")) return { id, name, input };
  }
  return null;
}

export function recordedToolResult(pathname: string, size: number, toolUseId: string): string | null {
  for (const obj of tailRecords(pathname, size).reverse()) {
    const text = toolResultText(obj, toolUseId);
    if (text !== null) return text.trim() || "answer is recorded in the transcript";
  }
  return null;
}

export function pendingQuestionFor(entry: FileEntry): PendingQuestion | null {
  if (entry.root !== "claude-projects" || !entry.path.endsWith(".jsonl")) return null;
  const cached = questionCache.get(entry.path);
  let draft = cached?.[0] === entry.size ? cached[1] : undefined;

  if (draft === undefined) {
    draft = null;
    const answered = new Set<string>();
    for (const obj of tailRecords(entry.path, entry.size).reverse()) {
      const result = toolResultId(obj);
      if (result) {
        answered.add(result);
        continue;
      }
      const use = assistantToolUse(obj);
      if (!use || answered.has(use.id)) break;
      if (use.name === "AskUserQuestion") {
        const questions = recordsValue(use.input.questions).map(normalizeQuestion).filter((item): item is PendingQuestionItem => item !== null);
        if (!questions.length) break;
        draft = {
          kind: "question",
          toolUseId: use.id,
          transcriptPath: entry.path,
          askedAt: timestampOf(obj),
          questions,
        };
        break;
      }
      const plan = stringValue(use.input.plan)?.trim();
      if (!plan) break;
      draft = {
        kind: "plan",
        toolUseId: use.id,
        transcriptPath: entry.path,
        askedAt: timestampOf(obj),
        plan,
      };
      break;
    }
    questionCache.set(entry.path, [entry.size, draft]);
  }
  if (!draft || entry.proc !== "running" || entry.pid === null) return null;
  return { ...draft, pid: entry.pid, paneTarget: null };
}
