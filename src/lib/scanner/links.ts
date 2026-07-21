import fs from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { statePath } from "@/lib/configDir";

import {
  handoffParentForChild,
  handoffParentForPid,
  persistHandoffLineage,
  rememberHandoffChild,
} from "../handoffLineage";
import type { FileEntry } from "../types";
import { globalCache } from "./caches";
import { claudeSubagentLineage } from "./claudeNative";
import { codexThreadIdFromPath, nativeCodexParentThreadId } from "./codexNative";
import { persistWorktreeMap } from "./describe";
import { taskParts } from "./discover";
import { readJson, recordValue, recordsValue, stringValue } from "./json";
import { fileTailHasNeedle, findNeedle } from "./needle";
import { readPpid } from "./process";
import { ROOTS } from "./roots";

const sidSlugCache = globalCache<string>("sid-slug");
type BackgroundCommand = { command: string; description: string; source: string };
type BackgroundTranscriptIndex = {
  size: number;
  mtimeMs: number;
  offset: number;
  carry: Buffer;
  toolUses: Map<string, Omit<BackgroundCommand, "source">>;
  taskToolUses: Map<string, string>;
  commands: Map<string, Omit<BackgroundCommand, "source">>;
  complete: boolean;
};

const bgcmdCache = globalCache<BackgroundCommand>("bgcmd");
const backgroundIndexCache = globalCache<BackgroundTranscriptIndex>("background-index-v1");
const chainCache = globalCache<[number, string | null]>("chain-uuid");
const compactLinkCache = globalCache<string>("compact-links-v1");
const lineageStoreState = globalCache<{
  backgroundLoaded: boolean;
  backgroundDirty: boolean;
  compactLoaded: boolean;
  compactDirty: boolean;
}>("lineage-store-state-v1");

const CHAIN_HEAD_BYTES = 512 * 1024;
const BACKGROUND_SCAN_BUDGET_BYTES = 256 * 1024;
/* Nested Claude subagent ownership proofs scan sibling transcripts for a
   tool-use needle. One generation may spend at most this many fresh bytes on
   those forward scans; unresolved lineage keeps its path-derived parent and
   the recorded offsets resume in a later generation (#287). */
const NESTED_SUBAGENT_NEEDLE_BUDGET_BYTES = 256 * 1024;
const BACKGROUND_SCAN_CHUNK_BYTES = 64 * 1024;
const BACKGROUND_INDEX_ENTRY_CAP = 20_000;
const BACKGROUND_COMMANDS_FILE = "bg-commands.json";
const BACKGROUND_COMMANDS_VERSION = 1;
const COMPACT_CHAINS_FILE = "compact-chains.json";
const COMPACT_CHAINS_VERSION = 1;
type Limit = <T>(work: () => Promise<T>) => Promise<T>;
type ReadBudget = { remaining: number };

function currentLineageStoreState() {
  const filename = statePath(BACKGROUND_COMMANDS_FILE);
  let state = lineageStoreState.get(filename);
  if (!state) {
    state = {
      backgroundLoaded: false,
      backgroundDirty: false,
      compactLoaded: false,
      compactDirty: false,
    };
    lineageStoreState.set(filename, state);
  }
  return state;
}

function loadBackgroundCommands(): void {
  const state = currentLineageStoreState();
  if (state.backgroundLoaded) return;
  state.backgroundLoaded = true;
  const stored = readJson(statePath(BACKGROUND_COMMANDS_FILE));
  if (stored?.version !== BACKGROUND_COMMANDS_VERSION) return;
  const commands = recordValue(stored.commands);
  if (!commands) return;
  for (const [tid, value] of Object.entries(commands)) {
    const command = recordValue(value);
    if (!command || typeof command.command !== "string" || typeof command.description !== "string"
      || typeof command.source !== "string" || (!command.command && !command.description)) continue;
    if (!bgcmdCache.has(tid)) {
      cappedSet(bgcmdCache, tid, {
        command: command.command,
        description: command.description,
        source: command.source,
      });
    }
  }
}

function loadCompactChains(): void {
  const state = currentLineageStoreState();
  if (state.compactLoaded) return;
  state.compactLoaded = true;
  const stored = readJson(statePath(COMPACT_CHAINS_FILE));
  if (stored?.version !== COMPACT_CHAINS_VERSION) return;
  const links = recordValue(stored.links);
  if (!links) return;
  for (const [successor, predecessor] of Object.entries(links)) {
    if (typeof predecessor === "string" && predecessor !== successor && !compactLinkCache.has(successor)) {
      cappedSet(compactLinkCache, successor, predecessor);
    }
  }
}

function writeStateFile(filename: string, value: unknown): boolean {
  let temporary: string | null = null;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filename), 0o700);
    temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
    return true;
  } catch {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The temporary file may be absent when directory creation failed.
      }
    }
    return false;
  }
}

function persistBackgroundCommands(): void {
  const state = currentLineageStoreState();
  if (!state.backgroundDirty) return;
  const commands = Object.fromEntries(
    [...bgcmdCache].filter(([, info]) => info.command || info.description),
  );
  if (writeStateFile(statePath(BACKGROUND_COMMANDS_FILE), {
    version: BACKGROUND_COMMANDS_VERSION,
    commands,
  })) state.backgroundDirty = false;
}

function persistCompactChains(): void {
  const state = currentLineageStoreState();
  if (!state.compactDirty) return;
  if (writeStateFile(statePath(COMPACT_CHAINS_FILE), {
    version: COMPACT_CHAINS_VERSION,
    links: Object.fromEntries(compactLinkCache),
  })) state.compactDirty = false;
}

function rememberBackgroundCommand(tid: string, info: BackgroundCommand): void {
  if (bgcmdCache.get(tid)?.command === info.command
    && bgcmdCache.get(tid)?.description === info.description
    && bgcmdCache.get(tid)?.source === info.source) return;
  cappedSet(bgcmdCache, tid, info);
  currentLineageStoreState().backgroundDirty = true;
}

function rememberCompactChain(successor: string, predecessor: string): void {
  if (successor === predecessor || compactLinkCache.get(successor) === predecessor) return;
  cappedSet(compactLinkCache, successor, predecessor);
  currentLineageStoreState().compactDirty = true;
}

/**
 * Prime permanent lineage facts carried by a completed route snapshot. A
 * background command survives later source growth because the spawning tool
 * result is immutable append-only history, and it is only present in the
 * snapshot after an authoritative same-file extraction. Compaction edges are
 * deliberately not primed: a snapshot parent can also carry the nearest-older
 * fallback taken while the successor was live, and only needle-proven edges
 * (kept in the compact-chains sidecar) may bypass re-proof.
 */
export function primePersistedLineageFacts(entries: readonly FileEntry[]): void {
  for (const entry of entries) {
    if (entry.derivationComplete !== true) continue;
    if (entry.root !== "claude-tasks" || !entry.parent || (!entry.cmd && !entry.cmdDesc)) continue;
    const parts = taskParts(ROOTS["claude-tasks"], entry.path);
    const tid = parts?.[2];
    if (tid) {
      cappedSet(bgcmdCache, tid, {
        command: entry.cmd ?? "",
        description: entry.cmdDesc ?? "",
        source: entry.parent,
      });
    }
  }
}

function createLimiter(max: number): Limit {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function limit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

/**
 * A transcript created by compaction opens with a system record
 * `subtype: "compact_boundary"` whose logicalParentUuid is the tail uuid of
 * the predecessor transcript. The marker sits in the immutable head of the
 * file, so a scan is repeated only while the head is still shorter than the
 * scan window and nothing was found yet.
 */
function compactParentUuid(pathname: string, size: number): string | null {
  const cached = chainCache.get(pathname);
  if (cached && (cached[1] !== null || cached[0] >= CHAIN_HEAD_BYTES || cached[0] >= size)) {
    return cached[1];
  }
  let uuid: string | null = null;
  let read = 0;
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, CHAIN_HEAD_BYTES));
      read = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString("utf8", 0, read).split("\n")) {
        if (!line.includes('"compact_boundary"')) continue;
        uuid = line.match(/"logicalParentUuid"\s*:\s*"([0-9a-f-]{36})"/)?.[1] ?? null;
        break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  chainCache.set(pathname, [read, uuid]);
  return uuid;
}

/**
 * Compaction rotates the session id while the conversation logically goes on,
 * so the old root and its subagents/tasks must land in the live successor's
 * tree. The predecessor is proven by finding the successor's compact-marker
 * uuid inside a candidate transcript; when the exact predecessor file is
 * already gone (middle hop of a longer chain), the nearest older non-live
 * session of the same slug stands in.
 */
function chainCompactedSessions(entries: FileEntry[]): void {
  const mainsBySlug = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    if (entry.root !== "claude-projects") continue;
    const parts = entry.name.split(path.sep);
    if (parts.length !== 2) continue;
    const slug = parts[0] ?? "";
    mainsBySlug.set(slug, (mainsBySlug.get(slug) ?? []).concat(entry));
  }
  const chainsBack = (from: FileEntry, target: FileEntry, mains: FileEntry[]): boolean => {
    const byPath = new Map(mains.map((main) => [main.path, main]));
    const seen = new Set<string>();
    for (let cur: FileEntry | undefined = from; cur?.parent && !seen.has(cur.path); cur = byPath.get(cur.parent)) {
      seen.add(cur.path);
      if (cur.parent === target.path) return true;
    }
    return false;
  };
  for (const mains of mainsBySlug.values()) {
    const ordered = [...mains].sort((a, b) => a.mtime - b.mtime);
    for (const successor of ordered) {
      const rememberedPath = compactLinkCache.get(successor.path);
      const remembered = rememberedPath
        ? ordered.find((candidate) => candidate.path === rememberedPath && candidate !== successor && !candidate.parent)
        : undefined;
      if (remembered && !chainsBack(successor, remembered, mains)) {
        remembered.parent = successor.path;
        continue;
      }
      const uuid = compactParentUuid(successor.path, successor.size);
      if (!uuid) continue;
      // Late system records (away_summary…) can bump the predecessor's mtime
      // above the successor's, so candidates are not mtime-gated: the marker
      // uuid proves direction and chainsBack blocks accidental cycles. The
      // unproven fallback stays limited to a still-alive successor.
      const candidates = ordered
        .filter((candidate) => candidate !== successor && !candidate.parent)
        .sort((a, b) => b.mtime - a.mtime);
      const alive = successor.activity === "live" || successor.activity === "recent";
      const proven = candidates.find((candidate) => fileTailHasNeedle(uuid, candidate.path));
      if (proven) rememberCompactChain(successor.path, proven.path);
      const predecessor = proven ?? (alive ? candidates.find((candidate) => candidate.activity !== "live") : undefined);
      if (predecessor && !chainsBack(successor, predecessor, mains)) predecessor.parent = successor.path;
    }
  }
}

async function globWalk(dir: string, pred: (pathname: string) => boolean, limit: Limit): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await limit(() => readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
  const chunks = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const pathname = path.join(dir, entry.name);
    if (entry.isDirectory()) return globWalk(pathname, pred, limit);
    if (entry.isFile() && pred(pathname)) return [pathname];
    return [];
  }));
  return chunks.flat();
}

async function sessionTranscripts(sid: string, limit: Limit, slug?: string | null): Promise<[string | null, string[]]> {
  const base = ROOTS["claude-projects"];
  let realSlug = slug ?? sidSlugCache.get(sid) ?? null;
  if (!realSlug) {
    const hit = (await globWalk(base, (p) => path.basename(p) === sid + ".jsonl", limit))[0];
    if (!hit) return [null, []];
    realSlug = path.basename(path.dirname(hit));
    sidSlugCache.set(sid, realSlug);
  }
  const main = path.join(base, realSlug, sid + ".jsonl");
  const subDir = path.join(base, realSlug, sid, "subagents");
  const subs = (await globWalk(subDir, (p) => path.basename(p).startsWith("agent-") && p.endsWith(".jsonl"), limit)).sort();
  return [fs.existsSync(main) ? main : null, subs];
}

const FALLBACK_TRANSCRIPT_CAP = 8;
const FALLBACK_BYTES_CAP = 64 * 1024 * 1024;

/**
 * Main transcripts of other sessions in the same project slug, newest first.
 * A compacted/resumed session keeps writing task output under its original
 * sid while the spawning Bash tool call lives in a successor transcript, so
 * the needle search must be able to leave the task's own sid.
 */
function slugMainTranscripts(slug: string, excludeSid: string): string[] {
  const dir = path.join(ROOTS["claude-projects"], slug);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: { pathname: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name === excludeSid + ".jsonl") continue;
    const pathname = path.join(dir, entry.name);
    try {
      const st = fs.statSync(pathname);
      if (st.size > FALLBACK_BYTES_CAP) continue;
      candidates.push({ pathname, mtime: st.mtimeMs });
    } catch {
      continue;
    }
  }
  return candidates
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, FALLBACK_TRANSCRIPT_CAP)
    .map((candidate) => candidate.pathname);
}

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > BACKGROUND_INDEX_ENTRY_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function resolveIndexedBackgroundCommands(index: BackgroundTranscriptIndex): void {
  for (const [tid, toolUseId] of index.taskToolUses) {
    const toolUse = index.toolUses.get(toolUseId);
    if (toolUse && (toolUse.command || toolUse.description)) cappedSet(index.commands, tid, toolUse);
  }
}

function indexBackgroundLine(index: BackgroundTranscriptIndex, line: string): void {
  if (line.includes('"tool_use"')) {
    try {
      const obj = JSON.parse(line);
      const content = recordsValue(recordValue(obj.message)?.content);
      for (const part of content) {
        if (part.type !== "tool_use" || typeof part.id !== "string") continue;
        const input = recordValue(part.input) ?? {};
        const command = typeof input.command === "string" ? input.command : "";
        const description = typeof input.description === "string" ? input.description : "";
        if (command || description) cappedSet(index.toolUses, part.id, { command, description });
      }
    } catch {
      // A malformed or incomplete record remains eligible after the file grows.
    }
  }

  if (line.includes("background with ID: ")) {
    const toolUseId = line.match(/"tool_use_id"\s*:\s*"([^"]+)"/)?.[1];
    if (toolUseId) {
      for (const match of line.matchAll(/background with ID: ([A-Za-z0-9_-]+)/g)) {
        const tid = match[1];
        if (tid) cappedSet(index.taskToolUses, tid, toolUseId);
      }
    }
  }
  resolveIndexedBackgroundCommands(index);
}

function consumeBackgroundChunk(index: BackgroundTranscriptIndex, chunk: Buffer): void {
  const bytes = index.carry.length ? Buffer.concat([index.carry, chunk]) : chunk;
  let lineStart = 0;
  for (let newline = bytes.indexOf(0x0a, lineStart); newline >= 0; newline = bytes.indexOf(0x0a, lineStart)) {
    indexBackgroundLine(index, bytes.toString("utf8", lineStart, newline));
    lineStart = newline + 1;
  }
  index.carry = lineStart < bytes.length ? Buffer.from(bytes.subarray(lineStart)) : Buffer.alloc(0);
}

function freshBackgroundIndex(size: number, mtimeMs: number): BackgroundTranscriptIndex {
  return {
    size,
    mtimeMs,
    offset: 0,
    carry: Buffer.alloc(0),
    toolUses: new Map(),
    taskToolUses: new Map(),
    commands: new Map(),
    complete: size === 0,
  };
}

function indexedBackgroundCommand(tid: string, source: string, budget: ReadBudget): BackgroundCommand | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    return null;
  }
  let index = backgroundIndexCache.get(source);
  if (!index || stat.size < index.size || (stat.size === index.size && stat.mtimeMs !== index.mtimeMs)) {
    index = freshBackgroundIndex(stat.size, stat.mtimeMs);
    backgroundIndexCache.set(source, index);
  } else {
    index.size = stat.size;
    index.mtimeMs = stat.mtimeMs;
    index.complete = index.offset >= stat.size;
  }

  const cached = index.commands.get(tid);
  if (cached) return { ...cached, source };
  if (!index.complete && budget.remaining > 0) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(source, "r");
      while (index.offset < stat.size && budget.remaining > 0 && !index.commands.has(tid)) {
        const requested = Math.min(
          BACKGROUND_SCAN_CHUNK_BYTES,
          budget.remaining,
          stat.size - index.offset,
        );
        const chunk = Buffer.allocUnsafe(requested);
        const read = fs.readSync(fd, chunk, 0, requested, index.offset);
        if (read === 0) break;
        index.offset += read;
        budget.remaining -= read;
        consumeBackgroundChunk(index, read === chunk.length ? chunk : Buffer.from(chunk.subarray(0, read)));
      }
      index.complete = index.offset >= stat.size;
      if (index.complete && index.carry.length > 0) indexBackgroundLine(index, index.carry.toString("utf8"));
    } catch {
      // The next refresh resumes from the last completely consumed byte.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  const resolved = index.commands.get(tid);
  if (resolved) return { ...resolved, source };
  return index.taskToolUses.has(tid) ? { command: "", description: "", source } : null;
}

function bgCommand(
  tid: string,
  transcripts: (string | null)[],
  fallbackTranscripts: string[],
  budget: ReadBudget,
): BackgroundCommand | null {
  const cached = bgcmdCache.get(tid);
  if (cached) return cached;
  let weak: BackgroundCommand | null = null;
  for (const source of new Set([...transcripts, ...fallbackTranscripts])) {
    if (!source) continue;
    const info = indexedBackgroundCommand(tid, source, budget);
    if (!info) continue;
    if (info.command || info.description) {
      rememberBackgroundCommand(tid, info);
      return info;
    }
    weak ??= info;
  }
  return weak;
}

const ANCESTRY_MAX_DEPTH = 15;

/**
 * Spawn parentage of a codex rollout is a permanent fact. Live /proc ancestry
 * can prove native spawns while both processes still exist; each proven edge is
 * kept in memory and on disk so later scans reuse it.
 */
const LINEAGE_FILE = statePath("codex-lineage.json");
const LINEAGE_MAX_ENTRIES = 20_000;
const lineageCache = globalCache<string>("codex-lineage");
let lineageLoaded = false;
let lineageDirty = false;

function loadLineage(): void {
  if (lineageLoaded) return;
  lineageLoaded = true;
  const data = readJson(LINEAGE_FILE);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [child, parent] of Object.entries(data)) {
      if (typeof parent === "string" && !lineageCache.has(child)) {
        lineageCache.set(child, parent);
      }
    }
    if (lineageCache.size !== Object.keys(data).length) lineageDirty = true;
  }
}

function rememberLineage(child: string, parent: string): void {
  if (lineageCache.get(child) === parent) return;
  lineageCache.set(child, parent);
  /* Backstop cap: Map keeps insertion order, so the oldest links — rollouts
     that stopped being scanned long ago — fall out first. */
  while (lineageCache.size > LINEAGE_MAX_ENTRIES) {
    const oldest = lineageCache.keys().next().value;
    if (oldest === undefined) break;
    lineageCache.delete(oldest);
  }
  lineageDirty = true;
}

function persistLineage(): void {
  if (!lineageDirty) return;
  lineageDirty = false;
  try {
    fs.mkdirSync(path.dirname(LINEAGE_FILE), { recursive: true });
    fs.writeFileSync(LINEAGE_FILE, JSON.stringify(Object.fromEntries(lineageCache)));
  } catch {
    /* best-effort: a missing cache only costs a re-resolve while live */
  }
}

function attachNativeCodexSubagentParents(entries: FileEntry[], persist: boolean): void {
  loadLineage();
  const pathByThreadId = new Map<string, string>();
  for (const entry of entries) {
    if (entry.root !== "codex-sessions" || !entry.path.endsWith(".jsonl")) continue;
    const id = codexThreadIdFromPath(entry.path);
    if (id) pathByThreadId.set(id, entry.path);
  }
  for (const entry of entries) {
    if (entry.root !== "codex-sessions" || entry.parent) continue;
    const parentThreadId = entry.nativeParentThreadId === undefined
      ? nativeCodexParentThreadId(entry.path, entry.size, entry.mtime * 1000)
      : entry.nativeParentThreadId;
    const parent = parentThreadId ? (pathByThreadId.get(parentThreadId) ?? null) : null;
    if (parent && parent !== entry.path) {
      entry.parent = parent;
      if (persist) rememberLineage(entry.path, parent);
    }
  }
  if (persist) persistLineage();
}

/**
 * Live rollouts without a recorded parent still prove their spawner through
 * /proc. A pid already attributed to a transcript among the rollout's ancestors
 * is the spawner: the nearest Claude or Codex ancestor owns the child rollout.
 * This is a spawn-lineage fact; no mtime or project heuristics participate.
 */
function attachLiveCodexParents(entries: FileEntry[], persist: boolean): void {
  loadLineage();
  const orphans = entries.filter((entry) => entry.root === "codex-sessions" && !entry.parent);
  if (orphans.length === 0) return;
  const ownerByPid = new Map<number, string>();
  for (const entry of entries) {
    if ((entry.root === "claude-projects" || entry.root === "codex-sessions") && entry.pid !== null) {
      ownerByPid.set(entry.pid, entry.path);
    }
  }
  for (const rollout of orphans) {
    let resolved: string | null = null;
    const seen = new Set<number>();
    for (let pid: number | null = rollout.pid; pid !== null && !seen.has(pid); pid = readPpid(pid)) {
      seen.add(pid);
      if (seen.size > ANCESTRY_MAX_DEPTH) break;
      const owner = ownerByPid.get(pid);
      if (owner && owner !== rollout.path) {
        resolved = owner;
        break;
      }
    }
    if (resolved) {
      rollout.parent = resolved;
      if (persist) rememberLineage(rollout.path, resolved);
    } else {
      // pid is gone or ancestry dead-ended: reuse the parent proven while live.
      const remembered = lineageCache.get(rollout.path);
      if (remembered) rollout.parent = remembered;
    }
  }
  if (persist) persistLineage();
}

/**
 * Links a conversation born from a handoff to its source. The spawn recorded
 * «pane pid → source transcript»; a still-orphan conversation whose /proc
 * ancestry reaches that pane pid is the agent booted in it. The proven link
 * persists by path, so it holds after the process (and the pane) are gone.
 * The `handoff` flag makes the UI treat the child as a branch of its source
 * rather than a compaction predecessor.
 */
function attachHandoffParents(entries: FileEntry[], persist: boolean): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.parent) continue;
    if (entry.root !== "claude-projects" && entry.root !== "codex-sessions") continue;
    if (!entry.path.endsWith(".jsonl") || entry.path.includes(path.sep + "subagents" + path.sep)) continue;
    let parent = handoffParentForChild(entry.path);
    if (!parent && entry.pid !== null) {
      const seen = new Set<number>();
      for (let pid: number | null = entry.pid; pid !== null && !seen.has(pid); pid = readPpid(pid)) {
        seen.add(pid);
        if (seen.size > ANCESTRY_MAX_DEPTH) break;
        parent = handoffParentForPid(pid);
        if (parent) break;
      }
      if (persist && parent && parent !== entry.path) rememberHandoffChild(entry.path, parent);
    }
    if (parent && parent !== entry.path && byPath.has(parent)) {
      entry.parent = parent;
      entry.handoff = true;
    }
  }
  if (persist) persistHandoffLineage();
}

export async function linkEntries(entries: FileEntry[], options: { persist?: boolean } = {}): Promise<void> {
  const persist = options.persist !== false;
  loadBackgroundCommands();
  loadCompactChains();
  const limit = createLimiter(48);
  const backgroundReadBudget = { remaining: BACKGROUND_SCAN_BUDGET_BYTES };
  const nestedNeedleBudget = { remaining: NESTED_SUBAGENT_NEEDLE_BUDGET_BYTES };
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const backgroundTasks = new Map<FileEntry, [string, string, string]>();
  for (const entry of entries) {
    if (entry.root !== "claude-tasks") continue;
    const parts = taskParts(ROOTS["claude-tasks"], entry.path);
    if (parts) backgroundTasks.set(entry, parts);
  }
  let remainingBackgroundTasks = backgroundTasks.size;
  for (const entry of entries) {
    if (entry.root === "claude-projects") {
      // Both the direct `subagents/agent-*.jsonl` layout and the nested Workflow
      // `subagents/**​/agent-*.jsonl` layout resolve to the same root parent
      // transcript (issue #339). Path-derived, so lineage holds even when the
      // parent transcript is absent from this scan.
      const lineage = claudeSubagentLineage(entry.name);
      if (lineage) {
        const [main, subs] = await sessionTranscripts(lineage.parentSessionId, limit, lineage.slug);
        entry.parent = main;
        const meta = readJson(entry.path.slice(0, -".jsonl".length) + ".meta.json") ?? {};
        const toolUse = stringValue(meta.toolUseId);
        const spawnDepth = Number(meta.spawnDepth ?? 0);
        if (toolUse && spawnDepth >= 1) {
          const found = findNeedle(
            toolUse,
            subs.filter((item) => item !== entry.path).concat(main ? [main] : []),
            nestedNeedleBudget,
          );
          if (found) entry.parent = found;
        }
      }
    } else if (entry.root === "claude-tasks") {
      const parts = backgroundTasks.get(entry);
      if (!parts) continue;
      const [slug, sid, tid] = parts;
      const [main, subs] = await sessionTranscripts(sid, limit, slug);
      /* Reserve each pending task a share of this generation's remaining
         allowance. An unresolved transcript advances only to its share, so
         later candidates retain bytes for their first proof attempt. Cached
         hits consume no share and leave those bytes for unresolved tasks. */
      const allowance = Math.ceil(backgroundReadBudget.remaining / remainingBackgroundTasks);
      const taskBudget = { remaining: allowance };
      const info = bgCommand(
        tid,
        (main ? [main] : []).concat(subs),
        slugMainTranscripts(slug, sid),
        taskBudget,
      );
      backgroundReadBudget.remaining -= allowance - taskBudget.remaining;
      remainingBackgroundTasks -= 1;
      if (info) {
        entry.parent = info.source;
        entry.cmd = info.command;
        entry.cmdDesc = info.description;
        const base = info.description || info.command;
        if (base) entry.title = base.split(/\s+/).join(" ").slice(0, 120);
      } else {
        /* No launch banner recovered — the spawning tool_result was never
           persisted (interrupted/unflushed) or the output file is a stale
           leftover. The task's own path still names its owner
           (`…/<sid>/tasks/<tid>.output`), so bind it to that session's main
           transcript instead of leaving it a floating orphan; the command just
           stays unknown. */
        entry.parent = main;
        entry.title = "Background task " + tid;
        entry.cmd = "";
        entry.cmdDesc = "";
      }
    }
  }
  attachNativeCodexSubagentParents(entries, persist);
  attachLiveCodexParents(entries, persist);
  attachHandoffParents(entries, persist);
  chainCompactedSessions(entries);
  const rootProject = (entry: FileEntry): string => {
    const seen = new Set<string>();
    let cur: FileEntry = entry;
    while (!seen.has(cur.path)) {
      seen.add(cur.path);
      const parent = byPath.get(cur.parent ?? "");
      if (!parent) return cur.project;
      cur = parent;
    }
    return entry.project;
  };
  for (const entry of entries) {
    if (!entry.parent || !byPath.has(entry.parent)) entry.parent = null;
    else entry.project = rootProject(entry);
  }
  if (persist) {
    persistBackgroundCommands();
    persistCompactChains();
    persistWorktreeMap();
  }
}
