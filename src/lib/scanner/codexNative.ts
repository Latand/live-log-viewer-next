import fs from "node:fs";
import path from "node:path";

import { globalCache } from "./caches";
import { readHead } from "./head";
import { recordValue, stringValue } from "./json";

globalCache<unknown>("codex-native-parent-thread").clear();
globalCache<unknown>("codex-native-parent-thread-v2").clear();
type CachedNativeSessionMeta = { size: number; mtimeMs: number; parent: string | null; forkedFrom: string | null };
const codexNativeSessionMetaCache = globalCache<CachedNativeSessionMeta>("codex-native-session-meta-v1");

export const CODEX_NATIVE_HEAD_BYTES = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function codexThreadIdFromPath(pathname: string): string | null {
  return path.basename(pathname).match(UUID_RE)?.[0] ?? null;
}

export interface NativeCodexParentResult {
  value: string | null;
  complete: boolean;
}

export interface NativeCodexSessionMetaResult {
  /** Engine-native subagent parent thread (issue #339). */
  parent: string | null;
  /** Source thread of a provider `thread/fork` artifact, from the FIRST
      `session_meta` row's `forked_from_id` (issue #708). */
  forkedFrom: string | null;
  complete: boolean;
}

/**
 * The one reader of a Codex rollout's identity header.
 *
 * Only the FIRST `session_meta` row is authoritative, and that is load-bearing
 * for `forked_from_id`: a fork replays its ancestor's own `session_meta` as row
 * two, so a reader that kept scanning would attribute the fork to itself and
 * lose the edge back to the source thread.
 */
export function nativeCodexSessionMetaResult(pathname: string, size: number, mtimeMs: number): NativeCodexSessionMetaResult {
  const cached = codexNativeSessionMetaCache.get(pathname);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return { parent: cached.parent, forkedFrom: cached.forkedFrom, complete: true };
  }

  let parent: string | null = null;
  let forkedFrom: string | null = null;
  const head = readHead(pathname, size, mtimeMs, { maxBytes: CODEX_NATIVE_HEAD_BYTES });
  if (!head.complete || !head.value) {
    return { parent: cached?.parent ?? null, forkedFrom: cached?.forkedFrom ?? null, complete: false };
  }
  for (const line of head.value.text.split("\n")) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const obj = JSON.parse(line) as {
        payload?: {
          parent_thread_id?: unknown;
          forked_from_id?: unknown;
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
      forkedFrom = stringValue(payload.forked_from_id);
      break;
    } catch {
      continue;
    }
  }
  codexNativeSessionMetaCache.set(pathname, { size, mtimeMs, parent, forkedFrom });
  return { parent, forkedFrom, complete: true };
}

export function nativeCodexParentThreadIdResult(pathname: string, size: number, mtimeMs: number): NativeCodexParentResult {
  const meta = nativeCodexSessionMetaResult(pathname, size, mtimeMs);
  return { value: meta.parent, complete: meta.complete };
}

function identityMtimeOf(pathname: string, mtimeMs: number | undefined): number | null {
  if (mtimeMs !== undefined) return mtimeMs;
  try {
    return fs.statSync(pathname).mtimeMs;
  } catch {
    return null;
  }
}

export function nativeCodexParentThreadId(pathname: string, size: number, mtimeMs?: number): string | null {
  const identityMtime = identityMtimeOf(pathname, mtimeMs);
  if (identityMtime === null) return null;
  return nativeCodexParentThreadIdResult(pathname, size, identityMtime).value;
}

/**
 * The thread a provider fork was taken from — PROVIDER-FORK HISTORY ONLY.
 *
 * `forked_from_id` is written by Codex when the migration provider calls
 * `thread/fork`, and it says nothing about operator intent. A deliberate
 * "branch this conversation from here" feature must carry its own intent
 * marker; it must not be read out of this edge.
 */
export function nativeCodexForkSourceThreadId(pathname: string, size: number, mtimeMs?: number): string | null {
  const identityMtime = identityMtimeOf(pathname, mtimeMs);
  if (identityMtime === null) return null;
  return nativeCodexSessionMetaResult(pathname, size, identityMtime).forkedFrom;
}

export function isNativeCodexSubagentTranscript(pathname: string, size: number, mtimeMs?: number): boolean {
  return nativeCodexParentThreadId(pathname, size, mtimeMs) !== null;
}
