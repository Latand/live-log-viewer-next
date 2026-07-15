import fs from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, ProjectCatalogEntry, RootKey } from "../types";
import { forEachCooperatively, mapCooperatively } from "../cooperative";
import { sessionProjectProjection } from "../session/titleProjection";
import { codexThreadIdFromPath, nativeCodexParentThreadId } from "./codexNative";
import { describe } from "./describe";
import type { ConversationCatalogEntry } from "./conversationCatalog";
import { beginProjectCatalogScan, projectCatalogSnapshotFromRaw, type ParsedFileSummary } from "./projectCatalog";
import { projectResolutionStateKey } from "./projectState";
import { EXTS, ROOTS, scanRootEntries } from "./roots";
import { selectSchemeWindow } from "./schemeWindow";

export function taskParts(root: string, pathname: string): [string, string, string] | null {
  const parts = path.relative(root, pathname).split(path.sep);
  if (parts.length === 4 && parts[2] === "tasks" && parts[3]?.endsWith(".output")) {
    return [parts[0] ?? "", parts[1] ?? "", parts[3].slice(0, -".output".length)];
  }
  return null;
}

export interface RawEntry {
  rootName: RootKey;
  root: string;
  path: string;
  st: fs.Stats;
}

type Roots = Record<RootKey, string>;
type RootEntries = [RootKey, string][];
type Limit = <T>(work: () => Promise<T>) => Promise<T>;
type Discovery = { raw: RawEntry[]; complete: boolean };
const DISCOVERY_DIAGNOSTIC_MS = 60_000;
let lastDiscoveryDiagnosticAt = Number.NEGATIVE_INFINITY;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function discoveryFailure(operation: string, target: string, error: unknown): boolean {
  if (isMissing(error)) return true;
  const now = Date.now();
  if (now - lastDiscoveryDiagnosticAt >= DISCOVERY_DIAGNOSTIC_MS) {
    lastDiscoveryDiagnosticAt = now;
    const detail = error instanceof Error ? `${error.message}${"code" in error && error.code ? ` (${String(error.code)})` : ""}` : String(error);
    console.error(`[scanner discovery] ${operation} failed for ${target}: ${detail}; retaining the last completed scan`);
  }
  return false;
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

async function walk(rootName: RootKey, roots: Roots, root: string, dir: string, limit: Limit): Promise<Discovery> {
  let entries: fs.Dirent[];
  try {
    entries = await limit(() => readdir(dir, { withFileTypes: true }));
  } catch (error) {
    return { raw: [], complete: discoveryFailure("read directory", dir, error) };
  }
  const chunks = await Promise.all(entries.map(async (entry): Promise<Discovery> => {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".git")) return { raw: [], complete: true };
      return walk(rootName, roots, root, path.join(dir, entry.name), limit);
    }
    if (!entry.isFile() || !EXTS.some((ext) => entry.name.endsWith(ext))) return { raw: [], complete: true };
    const pathname = path.join(dir, entry.name);
    if (rootName === "claude-projects" && pathname.includes(path.sep + "tool-results" + path.sep)) return { raw: [], complete: true };
    let st: fs.Stats;
    try {
      st = await limit(() => stat(pathname));
    } catch (error) {
      return { raw: [], complete: discoveryFailure("stat file", pathname, error) };
    }
    const isTask = rootName === "claude-tasks" ? taskParts(roots["claude-tasks"], pathname) : null;
    if (rootName === "claude-tasks" && !isTask) return { raw: [], complete: true };
    if (st.size === 0 && !isTask) return { raw: [], complete: true };
    if (isTask) {
      const [slug, sid, tid] = isTask;
      const twin = path.join(roots["claude-projects"], slug, sid, "subagents", "agent-" + tid + ".jsonl");
      try {
        await limit(() => fs.promises.access(twin));
        return { raw: [], complete: true };
      } catch (error) {
        if (!isMissing(error)) {
          return { raw: [], complete: discoveryFailure("access task-output twin", twin, error) };
        }
      }
    }
    return { raw: [{ rootName, root, path: pathname, st }], complete: true };
  }));
  return { raw: chunks.flatMap((chunk) => chunk.raw), complete: chunks.every((chunk) => chunk.complete) };
}

async function rootExists(root: string, limit: Limit): Promise<{ exists: boolean; complete: boolean }> {
  try {
    await limit(() => fs.promises.access(root));
    return { exists: true, complete: true };
  } catch (error) {
    return { exists: false, complete: discoveryFailure("access root", root, error) };
  }
}

function rootEntries(roots: Roots | RootEntries): RootEntries {
  return Array.isArray(roots) ? roots : Object.entries(roots) as RootEntries;
}

async function discoverRaw(roots: Roots | RootEntries, limit: Limit): Promise<Discovery> {
  const staticRoots = Array.isArray(roots) ? ROOTS : roots;
  const walked = await Promise.all(rootEntries(roots).map(async ([rootName, root]) => {
    const status = await rootExists(root, limit);
    if (!status.exists) return { raw: [], complete: status.complete };
    return walk(rootName, staticRoots, root, root, limit);
  }));
  const raw = walked.flatMap((result) => result.raw);
  /* Codex account roots follow the legacy root in registry order. A copied
     rollout therefore resolves to its managed-account copy before ranking. */
  const codexRollouts = new Map<string, RawEntry>();
  await forEachCooperatively(raw, (entry) => {
    const filename = path.basename(entry.path);
    if (entry.rootName !== "codex-sessions" || !filename.startsWith("rollout-") || !filename.endsWith(".jsonl")) return;
    const current = codexRollouts.get(filename);
    if (!current || current.root !== entry.root) codexRollouts.set(filename, entry);
  });
  const deduplicated: RawEntry[] = [];
  await forEachCooperatively(raw, (entry) => {
    const filename = path.basename(entry.path);
    if (entry.rootName !== "codex-sessions" || !filename.startsWith("rollout-") || !filename.endsWith(".jsonl") || codexRollouts.get(filename) === entry) {
      deduplicated.push(entry);
    }
  });
  return { raw: deduplicated, complete: walked.every((result) => result.complete) };
}

function cappedEntries(ranked: RawEntry[], projectByPath: ReadonlyMap<string, string>): RawEntry[] {
  return selectSchemeWindow(ranked, (entry) => projectByPath.get(entry.path) ?? "other");
}

async function canonicalProjectCatalog(
  projectByPath: ReadonlyMap<string, string>,
  conversationCatalog: readonly ConversationCatalogEntry[],
  excludedSummaryPaths?: ReadonlySet<string>,
  sourceCatalog: readonly ProjectCatalogEntry[] = [],
): Promise<{ projectByPath: Map<string, string>; projectCatalog: ProjectCatalogEntry[] }> {
  const canonicalByPath = new Map(projectByPath);
  await forEachCooperatively([...sessionProjectProjection(true).projectByPath], ([pathname, project]) => {
    if (canonicalByPath.has(pathname)) canonicalByPath.set(pathname, project);
  });
  const groups = new Map<string, ProjectCatalogEntry>();
  const sourceRoots = new Map<string, string | undefined>();
  await forEachCooperatively(sourceCatalog, (entry) => {
    sourceRoots.set(entry.project, entry.projectRoot);
  });
  await forEachCooperatively(conversationCatalog, (entry) => {
    if (excludedSummaryPaths?.has(entry.path)) return;
    const project = canonicalByPath.get(entry.path) ?? entry.project;
    const group = groups.get(project) ?? { project, smt: 0, conversations: 0 };
    group.smt = Math.max(group.smt, entry.mtime);
    group.conversations += 1;
    const sourceProject = projectByPath.get(entry.path) ?? entry.project;
    const projectRoot = sourceRoots.get(sourceProject);
    if (!group.projectRoot && projectRoot) group.projectRoot = projectRoot;
    groups.set(project, group);
  });
  return {
    projectByPath: canonicalByPath,
    projectCatalog: [...groups.values()].sort((a, b) => b.smt - a.smt || a.project.localeCompare(b.project)),
  };
}

async function entriesFromRaw(
  raw: RawEntry[],
  projectByPath?: ReadonlyMap<string, string>,
  demoted?: ReadonlySet<string>,
  pin?: ReadonlySet<string>,
  summaryByPath?: ReadonlyMap<string, ParsedFileSummary>,
): Promise<{ files: FileEntry[]; pinOverlayPaths?: string[] }> {
  const stateKey = projectResolutionStateKey();
  raw.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const rawByCodexThread = new Map<string, RawEntry>();
  await forEachCooperatively(raw, (entry) => {
    if (entry.rootName !== "codex-sessions" || !entry.path.endsWith(".jsonl")) return;
    const threadId = codexThreadIdFromPath(entry.path);
    if (threadId) rawByCodexThread.set(threadId, entry);
  });
  /* Demoted transcripts (archived migration predecessors — their conversation
     lives on under a successor path) rank below every current transcript for
     the recency cap: an account-migration wave must not eat half the cap and
     churn live conversations in and out of the feed on every poll. */
  const ranked = demoted?.size
    ? [...raw.filter((entry) => !demoted.has(entry.path)), ...raw.filter((entry) => demoted.has(entry.path))]
    : raw;
  const selected = cappedEntries(ranked, projectByPath ?? new Map());
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  const globalPaths = pin?.size ? new Set(selectedPaths) : undefined;
  const rawByPath = pin?.size ? new Map(raw.map((entry) => [entry.path, entry] as const)) : null;
  const includeNativeParents = async (entries: RawEntry[], paths: Set<string>) => {
    await forEachCooperatively(entries, (entry) => {
      if (entry.rootName !== "codex-sessions" || !entry.path.endsWith(".jsonl")) return;
      const parentThreadId = nativeCodexParentThreadId(entry.path, entry.st.size);
      const parent = parentThreadId ? rawByCodexThread.get(parentThreadId) : undefined;
      if (parent && !paths.has(parent.path)) {
        paths.add(parent.path);
        entries.push(parent);
      }
    });
  };
  if (globalPaths) await includeNativeParents([...selected], globalPaths);
  /* Deep-link targets ride along even when demotion or the cap excluded
     them: the client needs the requested entry and its current generation in
     one payload to resolve the conversation id and redirect the link. */
  for (const pinnedPath of pin ?? []) {
    if (selectedPaths.has(pinnedPath)) continue;
    const pinned = rawByPath?.get(pinnedPath);
    if (pinned) {
      selectedPaths.add(pinned.path);
      selected.push(pinned);
    }
  }
  await includeNativeParents(selected, selectedPaths);
  const files = await mapCooperatively<RawEntry, FileEntry>(selected, (entry) => {
    const meta = summaryByPath?.get(entry.path) ?? describe(entry.rootName, entry.root, entry.path, entry.st, stateKey);
    return {
      path: entry.path,
      root: entry.rootName,
      name: path.relative(entry.root, entry.path),
      project: projectByPath?.get(entry.path) ?? meta.project,
      worktree: meta.worktree,
      cwd: meta.cwd,
      projectRoot: meta.projectRoot,
      title: meta.title,
      engine: meta.engine,
      kind: meta.kind,
      fmt: meta.fmt,
      parent: null,
      mtime: entry.st.mtimeMs / 1000,
      size: entry.st.size,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    };
  });
  const pinOverlayPaths = globalPaths
    ? selected.filter((entry) => !globalPaths.has(entry.path)).map((entry) => entry.path)
    : [];
  return { files, ...(pinOverlayPaths.length ? { pinOverlayPaths } : {}) };
}

export async function discoverFilesWithProjectCatalog(
  roots: Roots | RootEntries = scanRootEntries(),
  _selectedProject?: string,
  options: { persist?: boolean; persistIndex?: boolean; demote?: ReadonlySet<string>; pin?: ReadonlySet<string> } = {},
): Promise<{
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
  pinOverlayPaths?: string[];
  complete: boolean;
}> {
  const scanToken = beginProjectCatalogScan(options.persist !== false || options.persistIndex === true);
  const limit = createLimiter(48);
  const discovery = await discoverRaw(roots, limit);
  const snapshot = await projectCatalogSnapshotFromRaw(discovery.raw, {
    persist: options.persist,
    persistIndex: options.persistIndex,
    excludedSummaryPaths: options.demote,
    scanToken,
    complete: discovery.complete,
  });
  const { projectCatalog, projectByPath } = await canonicalProjectCatalog(
    snapshot.projectByPath,
    snapshot.conversationCatalog,
    options.demote,
    snapshot.projectCatalog,
  );
  const entries = await entriesFromRaw(discovery.raw, projectByPath, options.demote, options.pin, snapshot.summaryByPath);
  return { ...entries, projectCatalog, complete: snapshot.complete };
}

export async function discoverFiles(
  roots: Roots | RootEntries = scanRootEntries(),
  demote?: ReadonlySet<string>,
  pin?: ReadonlySet<string>,
): Promise<FileEntry[]> {
  const scanToken = beginProjectCatalogScan(false);
  const limit = createLimiter(48);
  const discovery = await discoverRaw(roots, limit);
  const snapshot = await projectCatalogSnapshotFromRaw(discovery.raw, { persist: false, scanToken, complete: discovery.complete });
  const { projectByPath } = await canonicalProjectCatalog(
    snapshot.projectByPath,
    snapshot.conversationCatalog,
    undefined,
    snapshot.projectCatalog,
  );
  return (await entriesFromRaw(discovery.raw, projectByPath, demote, pin, snapshot.summaryByPath)).files;
}

/** Cold-start fallback for the list/search route. It builds only lightweight
 * catalog metadata and leaves the scheme processing pipeline untouched. */
export async function refreshConversationCatalog(roots: Roots | RootEntries = scanRootEntries()): Promise<void> {
  const scanToken = beginProjectCatalogScan(false);
  const discovery = await discoverRaw(roots, createLimiter(48));
  await projectCatalogSnapshotFromRaw(discovery.raw, { persist: false, scanToken, complete: discovery.complete });
}
