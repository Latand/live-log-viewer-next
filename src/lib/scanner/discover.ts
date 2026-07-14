import fs from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, ProjectCatalogEntry, RootKey } from "../types";
import { forEachCooperatively, mapCooperatively } from "../cooperative";
import { sessionProjectProjection } from "../session/titleProjection";
import { codexThreadIdFromPath, nativeCodexParentThreadId } from "./codexNative";
import { describe } from "./describe";
import type { ConversationCatalogEntry } from "./conversationCatalog";
import { beginProjectCatalogScan, projectCatalogSnapshotFromRaw } from "./projectCatalog";
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

async function walk(rootName: RootKey, roots: Roots, root: string, dir: string, limit: Limit): Promise<RawEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await limit(() => readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
  const chunks = await Promise.all(entries.map(async (entry): Promise<RawEntry[]> => {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".git")) return [];
      return walk(rootName, roots, root, path.join(dir, entry.name), limit);
    }
    if (!entry.isFile() || !EXTS.some((ext) => entry.name.endsWith(ext))) return [];
    const pathname = path.join(dir, entry.name);
    if (rootName === "claude-projects" && pathname.includes(path.sep + "tool-results" + path.sep)) return [];
    let st: fs.Stats;
    try {
      st = await limit(() => stat(pathname));
    } catch {
      return [];
    }
    const isTask = rootName === "claude-tasks" ? taskParts(roots["claude-tasks"], pathname) : null;
    if (rootName === "claude-tasks" && !isTask) return [];
    if (st.size === 0 && !isTask) return [];
    if (isTask) {
      const [slug, sid, tid] = isTask;
      const twin = path.join(roots["claude-projects"], slug, sid, "subagents", "agent-" + tid + ".jsonl");
      try {
        await limit(() => access(twin));
        return [];
      } catch {
        /* no mirrored subagent */
      }
    }
    return [{ rootName, root, path: pathname, st }];
  }));
  return chunks.flat();
}

async function rootExists(root: string, limit: Limit): Promise<boolean> {
  try {
    await limit(() => access(root));
    return true;
  } catch {
    return false;
  }
}

function rootEntries(roots: Roots | RootEntries): RootEntries {
  return Array.isArray(roots) ? roots : Object.entries(roots) as RootEntries;
}

async function discoverRaw(roots: Roots | RootEntries, limit: Limit): Promise<RawEntry[]> {
  const staticRoots = Array.isArray(roots) ? ROOTS : roots;
  const raw = (await Promise.all(rootEntries(roots).map(async ([rootName, root]) => {
    if (!(await rootExists(root, limit))) return [];
    return walk(rootName, staticRoots, root, root, limit);
  }))).flat();
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
  return deduplicated;
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

async function entriesFromRaw(raw: RawEntry[], projectByPath?: ReadonlyMap<string, string>, demoted?: ReadonlySet<string>, pin?: ReadonlySet<string>): Promise<FileEntry[]> {
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
  const rawByPath = pin?.size ? new Map(raw.map((entry) => [entry.path, entry] as const)) : null;
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
  await forEachCooperatively(selected, (entry) => {
    if (entry.rootName !== "codex-sessions" || !entry.path.endsWith(".jsonl")) return;
    const parentThreadId = nativeCodexParentThreadId(entry.path, entry.st.size);
    const parent = parentThreadId ? rawByCodexThread.get(parentThreadId) : undefined;
    if (parent && !selectedPaths.has(parent.path)) {
      selectedPaths.add(parent.path);
      selected.push(parent);
    }
  });
  return mapCooperatively(selected, (entry) => {
    const meta = describe(entry.rootName, entry.root, entry.path, entry.st, stateKey);
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
}

export async function discoverFilesWithProjectCatalog(
  roots: Roots | RootEntries = scanRootEntries(),
  _selectedProject?: string,
  options: { persist?: boolean; demote?: ReadonlySet<string>; pin?: ReadonlySet<string> } = {},
): Promise<{
  files: FileEntry[];
  projectCatalog: ProjectCatalogEntry[];
}> {
  const scanToken = beginProjectCatalogScan(options.persist !== false);
  const limit = createLimiter(48);
  const raw = await discoverRaw(roots, limit);
  const snapshot = await projectCatalogSnapshotFromRaw(raw, {
    persist: options.persist,
    excludedSummaryPaths: options.demote,
    scanToken,
  });
  const { projectCatalog, projectByPath } = await canonicalProjectCatalog(
    snapshot.projectByPath,
    snapshot.conversationCatalog,
    options.demote,
    snapshot.projectCatalog,
  );
  return { files: await entriesFromRaw(raw, projectByPath, options.demote, options.pin), projectCatalog };
}

export async function discoverFiles(
  roots: Roots | RootEntries = scanRootEntries(),
  demote?: ReadonlySet<string>,
  pin?: ReadonlySet<string>,
): Promise<FileEntry[]> {
  const scanToken = beginProjectCatalogScan(false);
  const limit = createLimiter(48);
  const raw = await discoverRaw(roots, limit);
  const snapshot = await projectCatalogSnapshotFromRaw(raw, { persist: false, scanToken });
  const { projectByPath } = await canonicalProjectCatalog(
    snapshot.projectByPath,
    snapshot.conversationCatalog,
    undefined,
    snapshot.projectCatalog,
  );
  return entriesFromRaw(raw, projectByPath, demote, pin);
}

/** Cold-start fallback for the list/search route. It builds only lightweight
 * catalog metadata and leaves the scheme processing pipeline untouched. */
export async function refreshConversationCatalog(roots: Roots | RootEntries = scanRootEntries()): Promise<void> {
  const scanToken = beginProjectCatalogScan(false);
  const raw = await discoverRaw(roots, createLimiter(48));
  await projectCatalogSnapshotFromRaw(raw, { persist: false, scanToken });
}
