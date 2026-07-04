import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { globalCache } from "./caches";
import { taskParts } from "./discover";
import { readJson, recordValue, recordsValue, stringValue } from "./json";
import { fileHasNeedle, findNeedle } from "./needle";
import { readEnvVar, readPpid } from "./process";
import { ROOTS } from "./roots";

const sidSlugCache = globalCache<string>("sid-slug");
const bgcmdCache = globalCache<{ command: string; description: string; source: string } | null>("bgcmd");
const chainCache = globalCache<[number, string | null]>("chain-uuid");

const CHAIN_HEAD_BYTES = 512 * 1024;

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
      const predecessor =
        candidates.find((candidate) => fileHasNeedle(uuid, candidate.path)) ??
        (alive ? candidates.find((candidate) => candidate.activity !== "live") : undefined);
      if (predecessor && !chainsBack(successor, predecessor, mains)) predecessor.parent = successor.path;
    }
  }
}

function globWalk(dir: string, pred: (pathname: string) => boolean, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const pathname = path.join(dir, entry.name);
    if (entry.isDirectory()) globWalk(pathname, pred, out);
    else if (entry.isFile() && pred(pathname)) out.push(pathname);
  }
  return out;
}

function sessionTranscripts(sid: string, slug?: string | null): [string | null, string[]] {
  const base = ROOTS["claude-projects"];
  let realSlug = slug ?? sidSlugCache.get(sid) ?? null;
  if (!realSlug) {
    const hit = globWalk(base, (p) => path.basename(p) === sid + ".jsonl")[0];
    if (!hit) return [null, []];
    realSlug = path.basename(path.dirname(hit));
    sidSlugCache.set(sid, realSlug);
  }
  const main = path.join(base, realSlug, sid + ".jsonl");
  const subDir = path.join(base, realSlug, sid, "subagents");
  const subs = globWalk(subDir, (p) => path.basename(p).startsWith("agent-") && p.endsWith(".jsonl")).sort();
  return [fs.existsSync(main) ? main : null, subs];
}

function jobMeta(logPath: string) {
  return readJson(logPath.replace(/\.log$/, ".json"));
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

function extractBgInfo(needle: string, src: string): { command: string; description: string } | null {
  let toolId: string | null = null;
  try {
    for (const line of fs.readFileSync(src, "utf8").split("\n")) {
      if (!line.includes(needle)) continue;
      toolId = line.match(/"tool_use_id"\s*:\s*"([^"]+)"/)?.[1] ?? null;
      break;
    }
    if (!toolId) return null;
    for (const line of fs.readFileSync(src, "utf8").split("\n")) {
      if (!line.includes(toolId) || !line.includes('"tool_use"')) continue;
      try {
        const obj = JSON.parse(line);
        const content = recordsValue(recordValue(obj.message)?.content);
        for (const part of content) {
          if (part.type === "tool_use" && part.id === toolId) {
            const input = recordValue(part.input) ?? {};
            return {
              command: String(input.command ?? ""),
              description: String(input.description ?? ""),
            };
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return null;
}

function bgCommand(tid: string, transcripts: (string | null)[], fallbackTranscripts: string[]) {
  if (bgcmdCache.has(tid)) return bgcmdCache.get(tid) ?? null;
  const needle = "background with ID: " + tid;
  // A transcript may quote the needle without owning the task (a grep over
  // logs, a pasted excerpt), so a hit only counts as authoritative when the
  // spawning tool_use with its command is recovered from the same file.
  let weak: { command: string; description: string; source: string } | null = null;
  for (const src of [...transcripts, ...fallbackTranscripts]) {
    if (!src || !fileHasNeedle(needle, src)) continue;
    const info = extractBgInfo(needle, src);
    if (info && (info.command || info.description)) {
      const full = { ...info, source: src };
      bgcmdCache.set(tid, full);
      return full;
    }
    weak ??= { command: "", description: "", source: src };
  }
  if (weak) bgcmdCache.set(tid, weak);
  return weak;
}

const COMPANION_TRANSCRIPT_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
const ANCESTRY_MAX_DEPTH = 15;

/**
 * Spawn parentage of a codex rollout is a permanent fact, but it can only be
 * proven from /proc while the process is alive. Once the process exits its pid
 * is gone and the ancestry walk finds nothing, so the rollout would fall back
 * to a top-level orphan and visually detach from the thread that started it.
 * The link observed while live is remembered — in-process for the session and
 * on disk so it also survives a server restart.
 */
const LINEAGE_FILE = path.join(os.homedir(), ".claude", "viewer-state", "codex-lineage.json");
const lineageCache = globalCache<string>("codex-lineage");
let lineageLoaded = false;
let lineageDirty = false;

function loadLineage(): void {
  if (lineageLoaded) return;
  lineageLoaded = true;
  const data = readJson(LINEAGE_FILE);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [child, parent] of Object.entries(data)) {
      if (typeof parent === "string" && !lineageCache.has(child)) lineageCache.set(child, parent);
    }
  }
}

function rememberLineage(child: string, parent: string): void {
  if (lineageCache.get(child) === parent) return;
  lineageCache.set(child, parent);
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

/**
 * Live rollouts without a job-state link still prove their spawner through
 * /proc. The codex plugin hook exports the Claude transcript path into every
 * Bash environment, and children keep it across exec — including the
 * app-server broker whose ppid chain detaches to systemd, where walking
 * ancestry alone would dead-end. A pid already attributed to a Claude
 * transcript among the ancestors is the equivalent proof for direct spawns
 * without the hook. Both are spawn-lineage facts; no mtime or project
 * heuristics participate.
 */
function attachLiveCodexParents(entries: FileEntry[]): void {
  loadLineage();
  const orphans = entries.filter((entry) => entry.root === "codex-sessions" && !entry.parent);
  if (orphans.length === 0) return;
  const claudeByPid = new Map<number, string>();
  for (const entry of entries) {
    if (entry.root === "claude-projects" && entry.pid !== null) claudeByPid.set(entry.pid, entry.path);
  }
  for (const rollout of orphans) {
    let resolved: string | null = null;
    const seen = new Set<number>();
    for (let pid: number | null = rollout.pid; pid !== null && !seen.has(pid); pid = readPpid(pid)) {
      seen.add(pid);
      if (seen.size > ANCESTRY_MAX_DEPTH) break;
      // The nearest Claude ancestor wins over the env value: a teammate agent
      // spawned from another session re-exports the hook variable, but its own
      // environ still carries the grandparent's transcript.
      const owner = claudeByPid.get(pid);
      const transcript = owner ?? readEnvVar(pid, COMPANION_TRANSCRIPT_ENV);
      if (transcript) {
        resolved = transcript;
        break;
      }
    }
    if (resolved) {
      rollout.parent = resolved;
      rememberLineage(rollout.path, resolved);
    } else {
      // pid is gone or ancestry dead-ended: reuse the parent proven while live.
      const remembered = lineageCache.get(rollout.path);
      if (remembered) rollout.parent = remembered;
    }
  }
  persistLineage();
}

export function linkEntries(entries: FileEntry[]): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const threadMap = new Map<string, string>();
  if (fs.existsSync(ROOTS["codex-jobs"])) {
    for (const jsonPath of globWalk(
      ROOTS["codex-jobs"],
      (p) => path.basename(p).startsWith("task-") && p.endsWith(".json"),
    )) {
      const job = readJson(jsonPath);
      const threadId = stringValue(job?.threadId);
      if (threadId) threadMap.set(threadId, jsonPath.slice(0, -".json".length) + ".log");
    }
  }
  for (const entry of entries) {
    if (entry.root === "claude-projects") {
      const parts = entry.name.split(path.sep);
      if (parts.length >= 3 && parts.at(-2) === "subagents") {
        const slug = parts[0] ?? "";
        const sid = parts.at(-3) ?? "";
        const [main, subs] = sessionTranscripts(sid, slug);
        entry.parent = main;
        const meta = readJson(entry.path.slice(0, -".jsonl".length) + ".meta.json") ?? {};
        const toolUse = stringValue(meta.toolUseId);
        const spawnDepth = Number(meta.spawnDepth ?? 0);
        if (toolUse && spawnDepth >= 1) {
          const found = findNeedle(
            toolUse,
            subs.filter((item) => item !== entry.path).concat(main ? [main] : []),
          );
          if (found) entry.parent = found;
        }
      }
    } else if (entry.root === "codex-jobs") {
      const job = jobMeta(entry.path) ?? {};
      const sid = stringValue(job.sessionId);
      if (sid) {
        const ws = stringValue(job.workspaceRoot) ?? "";
        const slug = ws ? ws.replace(/[^A-Za-z0-9-]/g, "-") : null;
        let [main, subs] = sessionTranscripts(sid, slug);
        if (!main && slug) [main, subs] = sessionTranscripts(sid, null);
        const jobId = path.basename(entry.path).slice(0, -".log".length);
        const found = findNeedle(jobId, subs);
        entry.parent = found ?? main;
      }
    } else if (entry.root === "codex-sessions") {
      const threadId = entry.path.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
      if (threadId && threadMap.has(threadId)) entry.parent = threadMap.get(threadId) ?? null;
    } else if (entry.root === "claude-tasks") {
      const parts = taskParts(ROOTS["claude-tasks"], entry.path);
      if (!parts) continue;
      const [slug, sid, tid] = parts;
      const [main, subs] = sessionTranscripts(sid, slug);
      const info = bgCommand(tid, (main ? [main] : []).concat(subs), slugMainTranscripts(slug, sid));
      if (info) {
        entry.parent = info.source;
        entry.cmd = info.command;
        entry.cmdDesc = info.description;
        const base = info.description || info.command;
        if (base) entry.title = base.split(/\s+/).join(" ").slice(0, 120);
      } else {
        entry.title = "Фонова задача " + tid;
        entry.cmd = "";
        entry.cmdDesc = "";
      }
    }
  }
  attachLiveCodexParents(entries);
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
}
