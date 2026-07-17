import path from "node:path";

import type { FileEntry } from "../types";
import { headRecordsResult, tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { readJson, recordValue, stringValue } from "./json";

export interface EntryModels {
  display: string | null;
  launch: string | null;
}

export interface EntryModelsResult {
  value: EntryModels;
  complete: boolean;
}

const modelCache = globalCache<[number, number, EntryModels]>("model");

function shortModel(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/^claude-/, "").replace(/-20\d{6}$/, "");
}

function pickModel(entry: FileEntry, obj: Record<string, unknown>): string | null {
  if (entry.root === "codex-sessions") {
    if (obj.type === "turn_context" || obj.type === "session_meta") {
      return stringValue(recordValue(obj.payload)?.model);
    }
  } else if (obj.type === "assistant") {
    const model = stringValue(recordValue(obj.message)?.model);
    if (model && model !== "<synthetic>") return model;
  }
  return null;
}

export function entryModelsResult(entry: FileEntry): EntryModelsResult {
  if (entry.root === "claude-projects" && entry.path.includes(path.sep + "subagents" + path.sep)) {
    const meta = readJson(entry.path.slice(0, -".jsonl".length) + ".meta.json") ?? {};
    const model = stringValue(meta.model);
    if (model) return { value: { display: shortModel(model), launch: model }, complete: true };
  }
  if ((entry.root !== "claude-projects" && entry.root !== "codex-sessions") || !entry.path.endsWith(".jsonl")) {
    return { value: { display: null, launch: null }, complete: true };
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = modelCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return { value: cached[2], complete: true };
  let model: string | null = null;
  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let complete = tail.complete;
  for (const obj of tail.records.reverse()) {
    model = pickModel(entry, obj);
    if (model) break;
  }
  if (!model) {
    const head = headRecordsResult(entry.path, entry.size, mtimeMs);
    complete &&= head.complete;
    for (const obj of head.records) {
      model = pickModel(entry, obj);
      if (model) break;
    }
  }
  const value = { display: shortModel(model), launch: model };
  if (complete) modelCache.set(entry.path, [entry.size, mtimeMs, value]);
  return { value, complete };
}

export function entryModels(entry: FileEntry): EntryModels {
  return entryModelsResult(entry).value;
}

export function entryModel(entry: FileEntry): string | null {
  return entryModels(entry).display;
}

export function entryLaunchModel(entry: FileEntry): string | null {
  return entryModels(entry).launch;
}
