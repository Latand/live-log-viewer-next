import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectForCwd, projectRootForCwd } from "./describe";

const PROJECT_DIR_ROOTS = ["Projects", path.join(".agents", "tools")];

function localProjectDirectories(): Array<{ cwd: string; project: string; projectRoot: string }> {
  const directories: Array<{ cwd: string; project: string; projectRoot: string }> = [];
  for (const rel of PROJECT_DIR_ROOTS) {
    const root = path.join(os.homedir(), rel);
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
  return directories;
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
