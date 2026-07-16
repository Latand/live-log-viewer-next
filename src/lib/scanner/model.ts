import path from "node:path";

import type { FileEntry } from "../types";
import { headRecordsResult, tailRecords } from "./activity";
import { globalCache } from "./caches";
import { readJson, recordValue, stringValue } from "./json";

interface EntryModels {
  display: string | null;
  launch: string | null;
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

export function entryModels(entry: FileEntry): EntryModels {
  if (entry.root === "claude-projects" && entry.path.includes(path.sep + "subagents" + path.sep)) {
    const meta = readJson(entry.path.slice(0, -".jsonl".length) + ".meta.json") ?? {};
    const model = stringValue(meta.model);
    if (model) return { display: shortModel(model), launch: model };
  }
  if ((entry.root !== "claude-projects" && entry.root !== "codex-sessions") || !entry.path.endsWith(".jsonl")) {
    return { display: null, launch: null };
  }
  const mtimeMs = entry.mtime * 1000;
  const cached = modelCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];
  let model: string | null = null;
  for (const obj of tailRecords(entry.path, entry.size, 131_072, mtimeMs).reverse()) {
    model = pickModel(entry, obj);
    if (model) break;
  }
  let complete = true;
  if (!model) {
    const head = headRecordsResult(entry.path, entry.size, mtimeMs);
    complete = head.complete;
    for (const obj of head.records) {
      model = pickModel(entry, obj);
      if (model) break;
    }
  }
  const value = { display: shortModel(model), launch: model };
  if (complete) modelCache.set(entry.path, [entry.size, mtimeMs, value]);
  return value;
}

export function entryModel(entry: FileEntry): string | null {
  return entryModels(entry).display;
}

export function entryLaunchModel(entry: FileEntry): string | null {
  return entryModels(entry).launch;
}
