import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { readStateCollectionRevision, readStateCollectionRows } from "@/lib/state/sqliteStateStore";

import { globalCache } from "./caches";
import { projectForCwd, projectRootForCwd } from "./describe";

const PROJECT_STATE_FILES = [
  "project-catalog.json",
  "worktree-map.json",
] as const;
const PROJECT_DIRECTORY_CACHE_MS = 10_000;

type ProjectDirectory = { cwd: string; project: string; projectRoot: string };
type ProjectDirectoryCacheEntry = {
  directories: ProjectDirectory[];
  expiresAt: number;
  stateIdentity: string;
};

const projectDirectoryCache = globalCache<ProjectDirectoryCacheEntry>("project-directories-v2");

function projectStateIdentity(directory: string): string {
  const files = PROJECT_STATE_FILES.map((name) => {
    const filename = path.join(directory, name);
    try {
      const stat = fs.statSync(filename);
      return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  });
  const database = path.join(directory, "state.sqlite");
  for (const [collection, legacy] of [["flows", "flows.json"], ["pipelines", "pipelines.json"], ["workflows", "workflows.json"]] as const) {
    const revision = readStateCollectionRevision(database, collection);
    if (revision !== null) files.push(`${collection}:sqlite:${revision}`);
    else {
      const filename = path.join(directory, legacy);
      try {
        const stat = fs.statSync(filename);
        files.push(`${legacy}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
      } catch {
        files.push(`${legacy}:missing`);
      }
    }
  }
  return files.join("|");
}

function readObject(filename: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordPaths(
  value: unknown,
  fields: readonly string[],
  paths: Set<string>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim()) paths.add(candidate);
  }
}

function projectPathsFromState(directory: string): string[] {
  const paths = new Set<string>();
  const catalog = readObject(path.join(directory, "project-catalog.json"))?.files;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    for (const value of Object.values(catalog)) recordPaths(value, ["cwd", "projectRoot"], paths);
  }
  const database = path.join(directory, "state.sqlite");
  for (const [filename, collection, fields] of [
    ["flows.json", "flows", ["cwd"]],
    ["pipelines.json", "pipelines", ["repoDir", "worktreeDir"]],
    ["workflows.json", "workflows", ["repoDir", "worktreeDir"]],
  ] as const) {
    const authoritative = readStateCollectionRows(database, collection);
    const values = authoritative ?? readObject(path.join(directory, filename))?.[collection];
    if (!Array.isArray(values)) continue;
    for (const value of values) recordPaths(value, fields, paths);
  }
  const worktrees = readObject(path.join(directory, "worktree-map.json"));
  if (worktrees) {
    for (const [cwd, value] of Object.entries(worktrees)) {
      paths.add(cwd);
      recordPaths(value, ["repo"], paths);
    }
  }
  return [...paths];
}

function localProjectDirectories(): ProjectDirectory[] {
  const directory = stateDir();
  const stateIdentity = projectStateIdentity(directory);
  const cached = projectDirectoryCache.get(directory);
  if (cached && cached.expiresAt > Date.now() && cached.stateIdentity === stateIdentity) {
    return cached.directories;
  }

  const directories: ProjectDirectory[] = [];
  const seen = new Set<string>();
  for (const cwd of projectPathsFromState(directory)) {
    try {
      if (!fs.statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    const project = projectForCwd(cwd);
    /* A directory identity is minted from this cwd, which is also its launch
       root when no repository contains it. */
    const projectRoot = projectRootForCwd(cwd) ?? (project?.startsWith("dir-") ? cwd : undefined);
    const key = project ? `${project}\0${cwd}` : "";
    if (!project || !projectRoot || seen.has(key)) continue;
    seen.add(key);
    directories.push({ cwd, project, projectRoot });
  }
  projectDirectoryCache.set(directory, {
    directories,
    expiresAt: Date.now() + PROJECT_DIRECTORY_CACHE_MS,
    stateIdentity,
  });
  return directories;
}

/** Deterministic cache isolation for focused scanner tests. */
export function resetProjectDirectoryCacheForTests(): void {
  projectDirectoryCache.clear();
}

export function projectDirectoryCandidates(project: string, max = 10): string[] {
  if (!project) return [];
  return localProjectDirectories()
    .filter((entry) => entry.project === project)
    .slice(0, max)
    .map((entry) => entry.cwd);
}

export function projectDirectoryFallbacks(projects: Iterable<string>): Record<string, string> {
  const wanted = new Set([...projects].filter(Boolean));
  const fallbacks: Record<string, string> = {};
  for (const entry of localProjectDirectories()) {
    if (wanted.has(entry.project) && !fallbacks[entry.project]) fallbacks[entry.project] = entry.projectRoot;
  }
  return fallbacks;
}
