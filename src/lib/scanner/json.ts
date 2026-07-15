import fs from "node:fs";

import { globalCache } from "./caches";

const jsonCache = globalCache<[number, number, Record<string, unknown> | null]>("json-v2");

export function readJson(pathname: string): Record<string, unknown> | null {
  let mtime: number;
  let size: number;
  try {
    const st = fs.statSync(pathname);
    mtime = st.mtimeMs;
    size = st.size;
  } catch {
    return null;
  }
  const cached = jsonCache.get(pathname);
  if (cached?.[0] === size && cached[1] === mtime) return cached[2];
  let obj: unknown = null;
  try {
    obj = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    obj = null;
  }
  const val =
    obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  jsonCache.set(pathname, [size, mtime, val]);
  return val;
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
