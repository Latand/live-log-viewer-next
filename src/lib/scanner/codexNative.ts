import fs from "node:fs";
import path from "node:path";

import { globalCache } from "./caches";
import { readHead } from "./head";
import { recordValue, stringValue } from "./json";

globalCache<unknown>("codex-native-parent-thread").clear();
type CachedNativeParent = { size: number; mtimeMs: number; parent: string | null };
const codexNativeParentCache = globalCache<CachedNativeParent>("codex-native-parent-thread-v2");

export const CODEX_NATIVE_HEAD_BYTES = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function codexThreadIdFromPath(pathname: string): string | null {
  return path.basename(pathname).match(UUID_RE)?.[0] ?? null;
}

export interface NativeCodexParentResult {
  value: string | null;
  complete: boolean;
}

export function nativeCodexParentThreadIdResult(pathname: string, size: number, mtimeMs: number): NativeCodexParentResult {
  const cached = codexNativeParentCache.get(pathname);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return { value: cached.parent, complete: true };

  let parent: string | null = null;
  const head = readHead(pathname, size, mtimeMs, { maxBytes: CODEX_NATIVE_HEAD_BYTES });
  if (!head.complete || !head.value) return { value: cached?.parent ?? null, complete: false };
  for (const line of head.value.text.split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const obj = JSON.parse(line) as {
        payload?: {
          parent_thread_id?: unknown;
          source?: { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } };
        };
      };
      const payload = recordValue(obj.payload);
      if (!payload) continue;
      const source = recordValue(payload.source);
      const subagent = recordValue(source?.subagent);
      const threadSpawn = recordValue(subagent?.thread_spawn);
      const direct = stringValue(payload.parent_thread_id);
      const nested = stringValue(threadSpawn?.parent_thread_id);
      parent = direct ?? nested;
      break;
    } catch {
      continue;
    }
  }
  codexNativeParentCache.set(pathname, { size, mtimeMs, parent });
  return { value: parent, complete: true };
}

export function nativeCodexParentThreadId(pathname: string, size: number, mtimeMs?: number): string | null {
  let identityMtime = mtimeMs;
  if (identityMtime === undefined) {
    try {
      identityMtime = fs.statSync(pathname).mtimeMs;
    } catch {
      return null;
    }
  }
  return nativeCodexParentThreadIdResult(pathname, size, identityMtime).value;
}

export function isNativeCodexSubagentTranscript(pathname: string, size: number, mtimeMs?: number): boolean {
  return nativeCodexParentThreadId(pathname, size, mtimeMs) !== null;
}
