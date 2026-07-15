import fs from "node:fs";

import { globalCache } from "./caches";

const jsonCache = globalCache<[number, number, Record<string, unknown> | null]>("json-v3");

export interface JsonReadResult {
  value: Record<string, unknown> | null;
  complete: boolean;
}

export function readJsonResult(pathname: string): JsonReadResult {
  let mtime: number;
  let size: number;
  try {
    const st = fs.statSync(pathname);
    mtime = st.mtimeMs;
    size = st.size;
  } catch (error) {
    return { value: null, complete: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
  const cached = jsonCache.get(pathname);
  if (cached?.[0] === size && cached[1] === mtime) return { value: cached[2], complete: true };
  let obj: unknown;
  try {
    obj = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return { value: null, complete: false };
  }
  const val =
    obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  jsonCache.set(pathname, [size, mtime, val]);
  return { value: val, complete: true };
}

export function readJson(pathname: string): Record<string, unknown> | null {
  return readJsonResult(pathname).value;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function recordsValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}
