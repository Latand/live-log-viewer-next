import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { ProjectCatalogEntry } from "../types";
import { describe } from "./describe";
import type { RawEntry } from "./discover";
import { projectResolutionStateKey } from "./projectState";

type CachedProjectFile = {
  rootName: RawEntry["rootName"];
  size: number;
  mtimeMs: number;
  stateKey: string;
  project: string;
  kind: string;
  session: boolean;
};

type ProjectCatalogFile = CachedProjectFile & { path: string };

type ProjectCatalogState = {
  version: 1;
  files: Record<string, CachedProjectFile>;
};

const CATALOG_FILE = "project-catalog.json";

function catalogPath(): string {
  return statePath(CATALOG_FILE);
}

function readState(): ProjectCatalogState {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath(), "utf8")) as Partial<ProjectCatalogState>;
    if (raw.version !== 1 || !raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) {
      return { version: 1, files: {} };
    }
    const files: Record<string, CachedProjectFile> = {};
    for (const [pathname, value] of Object.entries(raw.files)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const file = value as Partial<CachedProjectFile>;
      if (
        (file.rootName !== "codex-sessions" && file.rootName !== "claude-projects" && file.rootName !== "claude-tasks") ||
        typeof file.size !== "number" ||
        typeof file.mtimeMs !== "number" ||
        typeof file.stateKey !== "string" ||
        typeof file.project !== "string" ||
        typeof file.kind !== "string" ||
        typeof file.session !== "boolean"
      ) {
        continue;
      }
      files[pathname] = {
        rootName: file.rootName,
        size: file.size,
        mtimeMs: file.mtimeMs,
        stateKey: file.stateKey,
        project: file.project,
        kind: file.kind,
        session: file.session,
      };
    }
    return { version: 1, files };
  } catch {
    return { version: 1, files: {} };
  }
}

function writeState(state: ProjectCatalogState): void {
  try {
    const filePath = catalogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    /* A failed catalog write only costs the next scan extra metadata reads. */
  }
}

function isRootSession(rootName: RawEntry["rootName"], kind: string): boolean {
  return (rootName === "codex-sessions" || rootName === "claude-projects") && kind === "session";
}

function cachedFile(raw: RawEntry, state: ProjectCatalogState, stateKey: string): ProjectCatalogFile {
  const cached = state.files[raw.path];
  if (cached && cached.size === raw.st.size && cached.mtimeMs === raw.st.mtimeMs && cached.stateKey === stateKey) {
    return { path: raw.path, ...cached };
  }
  const meta = describe(raw.rootName, raw.root, raw.path, raw.st);
  const file: ProjectCatalogFile = {
    path: raw.path,
    rootName: raw.rootName,
    size: raw.st.size,
    mtimeMs: raw.st.mtimeMs,
    stateKey,
    project: meta.project || "other",
    kind: meta.kind,
    session: isRootSession(raw.rootName, meta.kind),
  };
  state.files[raw.path] = {
    rootName: file.rootName,
    size: file.size,
    mtimeMs: file.mtimeMs,
    stateKey: file.stateKey,
    project: file.project,
    kind: file.kind,
    session: file.session,
  };
  return file;
}

export function projectCatalogSnapshotFromRaw(raw: RawEntry[], options: { persist?: boolean } = {}): {
  projectCatalog: ProjectCatalogEntry[];
  projectByPath: Map<string, string>;
} {
  const state = readState();
  const stateKey = projectResolutionStateKey();
  const nextFiles: Record<string, CachedProjectFile> = {};
  const groups = new Map<string, ProjectCatalogEntry>();
  const projectByPath = new Map<string, string>();
  for (const entry of raw) {
    const file = cachedFile(entry, state, stateKey);
    nextFiles[file.path] = {
      rootName: file.rootName,
      size: file.size,
      mtimeMs: file.mtimeMs,
      stateKey: file.stateKey,
      project: file.project,
      kind: file.kind,
      session: file.session,
    };
    const project = file.project || "other";
    projectByPath.set(file.path, project);
    let group = groups.get(project);
    if (!group) {
      group = { project, smt: 0, conversations: 0 };
      groups.set(project, group);
    }
    group.smt = Math.max(group.smt, file.mtimeMs / 1000);
    if (file.session) group.conversations += 1;
  }
  if (options.persist !== false) writeState({ version: 1, files: nextFiles });
  return {
    projectCatalog: [...groups.values()].sort((a, b) => b.smt - a.smt || a.project.localeCompare(b.project)),
    projectByPath,
  };
}

export function projectCatalogFromRaw(raw: RawEntry[]): ProjectCatalogEntry[] {
  return projectCatalogSnapshotFromRaw(raw).projectCatalog;
}
