import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import {
  projectIdentityFromDirectory,
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
} from "@/lib/projects/identity";

/** A project the operator registered by hand, before any session exists in it. */
export interface ManualProject {
  project: string;
  displayName: string;
  /** Absolute directory the project was created from; offered as the spawn cwd. */
  root: string;
  /** Unix seconds; drives catalog recency until real sessions take over. */
  createdAt: number;
}

export interface ProjectCurationSnapshot {
  /** Projects the operator crowned; they pin to the top of the rail. */
  crowned: string[];
  manualProjects: ManualProject[];
}

interface ProjectCurationFile extends ProjectCurationSnapshot {
  schemaVersion: 1;
}

export type CreateProjectFailure = "INVALID_NAME" | "INVALID_ROOT" | "DUPLICATE_PROJECT" | "STORE_ERROR";

export type CreateProjectResult =
  | { ok: true; entry: ManualProject }
  | { ok: false; code: CreateProjectFailure; message: string };

type CurationCache = {
  file: string;
  mtimeMs: number;
  size: number;
  snapshot: ProjectCurationSnapshot;
};

let cache: CurationCache | null = null;

function curationFile(): string {
  return statePath("project-curation.json");
}

function manualProjectList(value: unknown): ManualProject[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ManualProject[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.project !== "string" || !record.project.trim()
      || typeof record.displayName !== "string" || !record.displayName.trim()
      || typeof record.root !== "string" || !record.root.trim()
      || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return null;
    entries.push({
      project: record.project,
      displayName: record.displayName,
      root: record.root,
      createdAt: record.createdAt,
    });
  }
  return entries;
}

function crownedList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string" && Boolean(item.trim()))
    ? [...new Set(value)]
    : null;
}

function readSnapshot(): ProjectCurationSnapshot {
  const file = curationFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { file, mtimeMs: -1, size: -1, snapshot: { crowned: [], manualProjects: [] } };
    return cache.snapshot;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.snapshot;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectCurationFile>;
    const crowned = parsed.schemaVersion === 1 ? crownedList(parsed.crowned) : null;
    const manualProjects = parsed.schemaVersion === 1 ? manualProjectList(parsed.manualProjects) : null;
    const snapshot = crowned && manualProjects ? { crowned, manualProjects } : { crowned: [], manualProjects: [] };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  } catch {
    const snapshot = { crowned: [], manualProjects: [] };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  }
}

export function projectCurationSnapshot(): ProjectCurationSnapshot {
  const snapshot = readSnapshot();
  return {
    crowned: [...snapshot.crowned],
    manualProjects: snapshot.manualProjects.map((entry) => ({ ...entry })),
  };
}

function writeSnapshot(snapshot: ProjectCurationSnapshot): boolean {
  const file = curationFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, ...snapshot } satisfies ProjectCurationFile, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    cache = null;
    readSnapshot();
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The next toggle retries the write.
    }
    return false;
  }
}

/** Crown or uncrown one project. Idempotent; false only on a failed write. */
export function setProjectCrown(project: string, crowned: boolean): boolean {
  const key = project.trim();
  if (!key) return false;
  const current = readSnapshot();
  const has = current.crowned.includes(key);
  if (has === crowned) return true;
  const next = crowned ? [...current.crowned, key] : current.crowned.filter((entry) => entry !== key);
  return writeSnapshot({ crowned: next, manualProjects: current.manualProjects });
}

/**
 * Register an operator-named project rooted at a directory. The identity is
 * minted exactly the way the scanner mints it for sessions running in that
 * directory (repository identity when the root is inside a git checkout,
 * directory identity otherwise), so later spawns group into this same project
 * with no extra mapping. `existingProjects` carries the canonical ids already
 * visible in the catalog; a duplicate identity is refused, never forked.
 */
export function createManualProject(
  name: string,
  root: string,
  existingProjects: ReadonlySet<string> = new Set(),
): CreateProjectResult {
  const displayName = name.trim();
  if (!displayName || displayName.length > 80) {
    return { ok: false, code: "INVALID_NAME", message: "project name must be 1-80 characters" };
  }
  const requested = root.trim();
  if (!requested || !path.isAbsolute(requested)) {
    return { ok: false, code: "INVALID_ROOT", message: "root must be an absolute directory path" };
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(requested);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, code: "INVALID_ROOT", message: "directory does not exist" };
  }
  const repositoryRoot = repositoryRootForPath(resolved);
  const identity = (repositoryRoot ? projectIdentityFromRepositoryRoot(repositoryRoot) : null)
    ?? projectIdentityFromDirectory(resolved);
  if (!identity) {
    return { ok: false, code: "INVALID_ROOT", message: "directory does not resolve to a project identity" };
  }
  const current = readSnapshot();
  if (existingProjects.has(identity.project)
    || current.manualProjects.some((entry) => entry.project === identity.project)) {
    return { ok: false, code: "DUPLICATE_PROJECT", message: "a project with this identity already exists" };
  }
  const entry: ManualProject = {
    project: identity.project,
    displayName,
    root: repositoryRoot ?? resolved,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const persisted = writeSnapshot({
    crowned: current.crowned,
    manualProjects: [...current.manualProjects, entry],
  });
  if (!persisted) return { ok: false, code: "STORE_ERROR", message: "could not persist the project" };
  return { ok: true, entry };
}

export function resetProjectCurationForTests(): void {
  cache = null;
}
