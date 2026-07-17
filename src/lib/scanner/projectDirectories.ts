import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectForCwd, projectRootForCwd } from "./describe";
import { globalCache } from "./caches";

const PROJECT_DIR_ROOTS = ["Projects", path.join(".agents", "tools")];

type ProjectDirectory = { cwd: string; project: string; projectRoot: string };
type ProjectDirectoryCacheEntry = {
  directories: ProjectDirectory[];
  rootsIdentity: string;
};

const projectDirectoryCache = globalCache<ProjectDirectoryCacheEntry>("project-directories-v1");

function projectDirectoryRoots(): string[] {
  return PROJECT_DIR_ROOTS.map((rel) => path.join(os.homedir(), rel));
}

/** A parent directory's metadata changes when a direct child is added,
    removed, or renamed. Reading two root stats keeps ordinary polling cheap
    while still discovering newly created project directories immediately. */
function projectDirectoryRootsIdentity(roots: string[]): string {
  return roots.map((root) => {
    try {
      const stat = fs.statSync(root);
      return `${root}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return `${root}:missing`;
    }
  }).join("|");
}

function localProjectDirectories(): ProjectDirectory[] {
  const roots = projectDirectoryRoots();
  const rootsIdentity = projectDirectoryRootsIdentity(roots);
  const cacheKey = os.homedir();
  const cached = projectDirectoryCache.get(cacheKey);
  if (cached && cached.rootsIdentity === rootsIdentity) {
    return cached.directories;
  }

  const directories: ProjectDirectory[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const cwd = path.join(root, name);
      try {
        if (!fs.statSync(cwd).isDirectory()) continue;
      } catch {
        continue;
      }
      const project = projectForCwd(cwd);
      const projectRoot = projectRootForCwd(cwd);
      if (project && projectRoot) directories.push({ cwd, project, projectRoot });
    }
  }
  projectDirectoryCache.set(cacheKey, {
    directories,
    rootsIdentity,
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
