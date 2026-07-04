import fs from "node:fs";
import path from "node:path";

import type { FileEntry, RootKey } from "../types";
import { describe } from "./describe";
import { EXTS, FILE_CAP, ROOTS } from "./roots";

export function taskParts(root: string, pathname: string): [string, string, string] | null {
  const parts = path.relative(root, pathname).split(path.sep);
  if (parts.length === 4 && parts[2] === "tasks" && parts[3]?.endsWith(".output")) {
    return [parts[0] ?? "", parts[1] ?? "", parts[3].slice(0, -".output".length)];
  }
  return null;
}

interface RawEntry {
  rootName: RootKey;
  root: string;
  path: string;
  st: fs.Stats;
}

function walk(rootName: RootKey, root: string, dir: string, out: RawEntry[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".git")) continue;
      walk(rootName, root, path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile() || !EXTS.some((ext) => entry.name.endsWith(ext))) continue;
    const pathname = path.join(dir, entry.name);
    if (rootName === "claude-projects" && pathname.includes(path.sep + "tool-results" + path.sep)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(pathname);
    } catch {
      continue;
    }
    const isTask = rootName === "claude-tasks" ? taskParts(ROOTS["claude-tasks"], pathname) : null;
    if (rootName === "claude-tasks" && !isTask) continue;
    if (st.size === 0 && !isTask) continue;
    if (isTask) {
      const [slug, sid, tid] = isTask;
      const twin = path.join(ROOTS["claude-projects"], slug, sid, "subagents", "agent-" + tid + ".jsonl");
      if (fs.existsSync(twin)) continue;
    }
    out.push({ rootName, root, path: pathname, st });
  }
}

export function discoverFiles(): FileEntry[] {
  const raw: RawEntry[] = [];
  for (const [rootName, root] of Object.entries(ROOTS) as [RootKey, string][]) {
    if (fs.existsSync(root)) walk(rootName, root, root, raw);
  }
  // describe() reads file heads, so it runs only on the capped shortlist; the
  // walk stays a cheap stat pass over every candidate.
  raw.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  return raw.slice(0, FILE_CAP).map((entry) => {
    const meta = describe(entry.rootName, entry.root, entry.path, entry.st);
    return {
      path: entry.path,
      root: entry.rootName,
      name: path.relative(entry.root, entry.path),
      project: meta.project,
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
