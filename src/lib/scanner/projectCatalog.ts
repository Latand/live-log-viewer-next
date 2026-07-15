import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { migrateBoardProjects } from "@/lib/board/store";
import { statePath } from "@/lib/configDir";
import { forEachCooperatively, mapCooperatively } from "@/lib/cooperative";

import type { ProjectCatalogEntry } from "../types";
import { replaceConversationCatalog, type ConversationCatalogEntry } from "./conversationCatalog";
import {
  describeFile,
  fileDescriptionIdentity,
  type FileDescription,
} from "./describe";
import type { RawEntry } from "./discover";
import { PROJECT_RESOLUTION_VERSION, projectResolutionStateKey } from "./projectState";

type CachedProjectFile = {
  summaryVersion?: 2;
  summaryIncomplete?: true;
  rootName: RawEntry["rootName"];
  size: number;
  mtimeMs: number;
  sidecarSize?: number | null;
  sidecarMtimeMs?: number | null;
  stateKey: string;
  project: string;
  projectRoot?: string | null;
  kind: string;
  session: boolean;
  worktree?: string;
  cwd?: string | null;
  title?: string;
  engine?: "codex" | "claude" | "shell";
  fmt?: "codex" | "claude" | "plain";
};

export type ParsedFileSummary = FileDescription;

type ProjectCatalogFile = CachedProjectFile & {
  path: string;
  title: string;
  titleCached: boolean;
  engine: "codex" | "claude" | "shell";
  fmt: "codex" | "claude" | "plain";
};

type ProjectCatalogState = {
  version: 2;
  resolutionVersion: number;
  files: Record<string, CachedProjectFile>;
};

const CATALOG_FILE = "project-catalog.json";
const CATALOG_PERSISTENCE_DIAGNOSTIC_MS = 60_000;
let lastCatalogPersistenceDiagnosticAt = Number.NEGATIVE_INFINITY;
const projectCatalogRuntime = globalThis as typeof globalThis & {
  __llvProjectCatalogPublicationGeneration?: number;
  __llvProjectCatalogPersistenceGeneration?: number;
};

export interface ProjectCatalogScanToken {
  publication: number;
  persistence: number | null;
}

export function beginProjectCatalogScan(persist: boolean): ProjectCatalogScanToken {
  const publication = (projectCatalogRuntime.__llvProjectCatalogPublicationGeneration ?? 0) + 1;
  projectCatalogRuntime.__llvProjectCatalogPublicationGeneration = publication;
  if (!persist) return { publication, persistence: null };
  const persistence = (projectCatalogRuntime.__llvProjectCatalogPersistenceGeneration ?? 0) + 1;
  projectCatalogRuntime.__llvProjectCatalogPersistenceGeneration = persistence;
  return { publication, persistence };
}

function catalogPath(): string {
  return statePath(CATALOG_FILE);
}

function readState(): ProjectCatalogState {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath(), "utf8")) as Partial<Omit<ProjectCatalogState, "version">> & { version?: number };
    if ((raw.version !== 1 && raw.version !== 2) || !raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) {
      return { version: 2, resolutionVersion: PROJECT_RESOLUTION_VERSION, files: {} };
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
        (file.projectRoot !== undefined && file.projectRoot !== null && typeof file.projectRoot !== "string") ||
        typeof file.kind !== "string"
      ) {
        continue;
      }
      const engine = file.engine === "codex" || file.engine === "claude" || file.engine === "shell" ? file.engine : undefined;
      const fmt = file.fmt === "codex" || file.fmt === "claude" || file.fmt === "plain" ? file.fmt : undefined;
      const cwd = typeof file.cwd === "string" ? file.cwd : file.cwd === null ? null : undefined;
      const sidecarSize = typeof file.sidecarSize === "number" ? file.sidecarSize : file.sidecarSize === null ? null : undefined;
      const sidecarMtimeMs = typeof file.sidecarMtimeMs === "number"
        ? file.sidecarMtimeMs
        : file.sidecarMtimeMs === null ? null : undefined;
      const summaryComplete = file.summaryVersion === 2
        && typeof file.title === "string"
        && engine !== undefined
        && fmt !== undefined
        && cwd !== undefined
        && file.projectRoot !== undefined
        && sidecarSize !== undefined
        && sidecarMtimeMs !== undefined;
      files[pathname] = {
        summaryVersion: summaryComplete ? 2 : undefined,
        summaryIncomplete: !summaryComplete && file.summaryIncomplete === true ? true : undefined,
        rootName: file.rootName,
        size: file.size,
        mtimeMs: file.mtimeMs,
        sidecarSize,
        sidecarMtimeMs,
        stateKey: file.stateKey,
        project: file.project,
        projectRoot: typeof file.projectRoot === "string" ? file.projectRoot : file.projectRoot === null ? null : undefined,
        kind: file.kind,
        session: isConversation(file.rootName, file.kind),
        worktree: typeof file.worktree === "string" ? file.worktree : undefined,
        cwd,
        title: typeof file.title === "string" ? file.title : undefined,
        engine,
        fmt,
      };
    }
    return { version: 2, resolutionVersion: raw.resolutionVersion ?? 0, files };
  } catch {
    return { version: 2, resolutionVersion: PROJECT_RESOLUTION_VERSION, files: {} };
  }
}

function persistenceDiagnostic(operation: string, target: string, error: unknown): void {
  const now = Date.now();
  if (now - lastCatalogPersistenceDiagnosticAt < CATALOG_PERSISTENCE_DIAGNOSTIC_MS) return;
  lastCatalogPersistenceDiagnosticAt = now;
  const detail = error instanceof Error ? `${error.message}${"code" in error && error.code ? ` (${String(error.code)})` : ""}` : String(error);
  console.error(`[project catalog] ${operation} failed for ${target}: ${detail}; a later scan will retry`);
}

function writeState(state: ProjectCatalogState): void {
  let temporary: string | undefined;
  let operation = "create state directory";
  let target = catalogPath();
  try {
    const filePath = catalogPath();
    target = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filePath), 0o700);
    temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    operation = "write temporary index";
    target = temporary;
    fs.writeFileSync(temporary, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
    operation = "rename temporary index";
    target = filePath;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (temporary !== undefined) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The write may have failed before the temp file was created.
      }
    }
    persistenceDiagnostic(operation, target, error);
  }
}

function isConversation(rootName: RawEntry["rootName"], kind: string): boolean {
  return rootName === "codex-sessions" || (rootName === "claude-projects" && (kind === "session" || kind === "subagent"));
}

function engineForRoot(rootName: RawEntry["rootName"]): ProjectCatalogFile["engine"] {
  if (rootName === "codex-sessions") return "codex";
  if (rootName === "claude-projects") return "claude";
  return "shell";
}

function fmtForRoot(rootName: RawEntry["rootName"]): ProjectCatalogFile["fmt"] {
  if (rootName === "codex-sessions") return "codex";
  if (rootName === "claude-projects") return "claude";
  return "plain";
}

function fallbackTitle(raw: RawEntry, kind: string): string {
  const filename = path.basename(raw.path);
  if (kind === "subagent") return "Subagent " + filename.slice("agent-".length).split(".")[0];
  if (raw.rootName === "codex-sessions") return "Codex session";
  if (raw.rootName === "claude-projects") return "Claude session";
  return "Background task " + filename.split(".")[0];
}

function cachedFile(raw: RawEntry, state: ProjectCatalogState, stateKey: string): ProjectCatalogFile {
  const cached = state.files[raw.path];
  const identity = fileDescriptionIdentity(raw.rootName, raw.path, raw.st);
  if (
    state.resolutionVersion === PROJECT_RESOLUTION_VERSION &&
    identity.complete &&
    cached &&
    cached.size === raw.st.size &&
    cached.mtimeMs === raw.st.mtimeMs &&
    (cached.summaryVersion !== 2 || (
      cached.sidecarSize === identity.sidecarSize &&
      cached.sidecarMtimeMs === identity.sidecarMtimeMs
    )) &&
    cached.stateKey === stateKey &&
    cached.projectRoot !== undefined
  ) {
    if (cached.summaryVersion !== 2) {
      const described = describeFile(raw.rootName, raw.root, raw.path, raw.st, stateKey, identity);
      const meta = described.description;
      const refreshProjectMetadata = cached.summaryIncomplete === true;
      return {
        ...cached,
        summaryVersion: described.complete ? 2 : undefined,
        summaryIncomplete: refreshProjectMetadata && !described.complete ? true : undefined,
        sidecarSize: identity.sidecarSize,
        sidecarMtimeMs: identity.sidecarMtimeMs,
        path: raw.path,
        project: refreshProjectMetadata ? meta.project || "other" : cached.project,
        projectRoot: refreshProjectMetadata ? meta.projectRoot ?? null : cached.projectRoot,
        kind: refreshProjectMetadata ? meta.kind : cached.kind,
        session: isConversation(raw.rootName, refreshProjectMetadata ? meta.kind : cached.kind),
        worktree: refreshProjectMetadata ? meta.worktree : cached.worktree,
        cwd: meta.cwd,
        title: meta.title,
        titleCached: true,
        engine: meta.engine,
        fmt: meta.fmt,
      };
    }
    return {
      path: raw.path,
      ...cached,
      session: isConversation(raw.rootName, cached.kind),
      cwd: cached.cwd ?? undefined,
      title: cached.title ?? fallbackTitle(raw, cached.kind),
      titleCached: typeof cached.title === "string",
      engine: cached.engine ?? engineForRoot(raw.rootName),
      fmt: cached.fmt ?? fmtForRoot(raw.rootName),
    };
  }
  const described = describeFile(raw.rootName, raw.root, raw.path, raw.st, stateKey, identity);
  const meta = described.description;
  const file: ProjectCatalogFile = {
    summaryVersion: described.complete ? 2 : undefined,
    summaryIncomplete: described.complete ? undefined : true,
    path: raw.path,
    rootName: raw.rootName,
    size: raw.st.size,
    mtimeMs: raw.st.mtimeMs,
    sidecarSize: identity.sidecarSize,
    sidecarMtimeMs: identity.sidecarMtimeMs,
    stateKey,
    project: meta.project || "other",
    projectRoot: meta.projectRoot ?? null,
    kind: meta.kind,
    session: isConversation(raw.rootName, meta.kind),
    worktree: meta.worktree,
    cwd: meta.cwd,
    title: meta.title,
    titleCached: true,
    engine: meta.engine,
    fmt: meta.fmt,
  };
  state.files[raw.path] = {
    summaryVersion: file.summaryVersion,
    summaryIncomplete: file.summaryIncomplete,
    rootName: file.rootName,
    size: file.size,
    mtimeMs: file.mtimeMs,
    sidecarSize: file.sidecarSize,
    sidecarMtimeMs: file.sidecarMtimeMs,
    stateKey: file.stateKey,
    project: file.project,
    projectRoot: file.projectRoot,
    kind: file.kind,
    session: file.session,
    worktree: file.worktree,
    cwd: file.cwd ?? null,
    title: file.titleCached ? file.title : undefined,
    engine: file.engine,
    fmt: file.fmt,
  };
  return file;
}

function claudeSlug(raw: RawEntry): string | null {
  if (raw.rootName !== "claude-projects" && raw.rootName !== "claude-tasks") return null;
  return path.relative(raw.root, raw.path).split(path.sep)[0] || null;
}

function unambiguousMigrations(
  changes: ReadonlyMap<string, ReadonlySet<string>>,
  groups: ReadonlyMap<string, ProjectCatalogEntry>,
): Map<string, string> {
  const migrations = new Map<string, string>();
  for (const [source, targets] of changes) {
    if ((groups.get(source)?.conversations ?? 0) > 0) continue;
    if (targets.size !== 1) continue;
    let target = targets.values().next().value;
    const seen = new Set([source]);
    while (target && (groups.get(target)?.conversations ?? 0) === 0) {
      if (seen.has(target)) {
        target = undefined;
        break;
      }
      seen.add(target);
      const next = changes.get(target);
      if (next?.size !== 1) break;
      target = next.values().next().value;
    }
    if (target && target !== source && (groups.get(target)?.conversations ?? 0) > 0) migrations.set(source, target);
  }
  return migrations;
}

export async function projectCatalogSnapshotFromRaw(raw: RawEntry[], options: {
  persist?: boolean;
  persistIndex?: boolean;
  excludedSummaryPaths?: ReadonlySet<string>;
  scanToken?: ProjectCatalogScanToken;
  complete?: boolean;
} = {}): Promise<{
  projectCatalog: ProjectCatalogEntry[];
  projectByPath: Map<string, string>;
  conversationCatalog: ConversationCatalogEntry[];
  summaryByPath: Map<string, ParsedFileSummary>;
  complete: boolean;
}> {
  const persistIndex = options.persist !== false || options.persistIndex === true;
  const scanToken = options.scanToken ?? beginProjectCatalogScan(persistIndex);
  const state = readState();
  const stateKey = projectResolutionStateKey();
  const nextFiles: Record<string, CachedProjectFile> = {};
  const groups = new Map<string, ProjectCatalogEntry>();
  const rootCandidates = new Map<string, Map<string, { count: number; newest: number }>>();
  const projectByPath = new Map<string, string>();
  const previousProjects = new Map<string, string | undefined>();
  await forEachCooperatively(raw, (entry) => {
    previousProjects.set(entry.path, state.files[entry.path]?.project);
  });
  const files = await mapCooperatively(raw, (entry) => cachedFile(entry, state, stateKey));
  const complete = options.complete !== false && files.every((file) => file.summaryVersion === 2);
  const claudeSessionProjects = new Map<string, string>();
  await forEachCooperatively(raw, (entry, index) => {
    const file = files[index]!;
    const slug = file.rootName === "claude-projects" && file.session ? claudeSlug(entry) : null;
    if (slug) claudeSessionProjects.set(slug, file.project);
  });
  await forEachCooperatively(raw, (_entry, index) => {
    const slug = claudeSlug(raw[index]!);
    const project = slug ? claudeSessionProjects.get(slug) : undefined;
    if (project) files[index]!.project = project;
  });
  const changes = new Map<string, Set<string>>();
  await forEachCooperatively(files, (file) => {
    nextFiles[file.path] = {
      summaryVersion: file.summaryVersion,
      summaryIncomplete: file.summaryIncomplete,
      rootName: file.rootName,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sidecarSize: file.sidecarSize,
      sidecarMtimeMs: file.sidecarMtimeMs,
      stateKey: file.stateKey,
      project: file.project,
      projectRoot: file.projectRoot,
      kind: file.kind,
      session: file.session,
      worktree: file.worktree,
      cwd: file.cwd ?? null,
      title: file.titleCached ? file.title : undefined,
      engine: file.engine,
      fmt: file.fmt,
    };
    const previousProject = previousProjects.get(file.path);
    if (previousProject && previousProject !== file.project) {
      const targets = changes.get(previousProject) ?? new Set<string>();
      targets.add(file.project);
      changes.set(previousProject, targets);
    }
    const project = file.project || "other";
    projectByPath.set(file.path, project);
    let group = groups.get(project);
    if (!group) {
      group = { project, smt: 0, conversations: 0 };
      groups.set(project, group);
    }
    group.smt = Math.max(group.smt, file.mtimeMs / 1000);
    if (file.session) group.conversations += 1;
    if (file.projectRoot && !options.excludedSummaryPaths?.has(file.path)) {
      const candidates = rootCandidates.get(project) ?? new Map<string, { count: number; newest: number }>();
      const candidate = candidates.get(file.projectRoot) ?? { count: 0, newest: 0 };
      candidate.count += 1;
      candidate.newest = Math.max(candidate.newest, file.mtimeMs);
      candidates.set(file.projectRoot, candidate);
      rootCandidates.set(project, candidates);
    }
  });
  await forEachCooperatively([...rootCandidates], ([project, candidates]) => {
    const projectRoot = [...candidates]
      .sort(([leftPath, left], [rightPath, right]) =>
        right.count - left.count || right.newest - left.newest || leftPath.localeCompare(rightPath))[0]?.[0];
    if (projectRoot) groups.get(project)!.projectRoot = projectRoot;
  });
  await forEachCooperatively([...(options.excludedSummaryPaths ?? [])], (pathname) => {
    const file = nextFiles[pathname];
    const group = file ? groups.get(file.project || "other") : undefined;
    if (file?.session && group && group.conversations > 0) group.conversations -= 1;
  });
  const conversationCatalog: ConversationCatalogEntry[] = [];
  const summaryByPath = new Map<string, ParsedFileSummary>();
  await forEachCooperatively(files, (file, index) => {
    summaryByPath.set(file.path, {
      project: file.project || "other",
      worktree: file.worktree,
      cwd: file.cwd ?? undefined,
      projectRoot: file.projectRoot,
      title: file.title,
      engine: file.engine,
      kind: file.kind,
      fmt: file.fmt,
    });
    if (!file.session || (file.engine !== "codex" && file.engine !== "claude")) return;
    conversationCatalog.push({
      path: file.path,
      root: file.rootName,
      name: path.relative(raw[index]!.root, file.path),
      project: file.project || "other",
      worktree: file.worktree,
      title: file.title,
      firstPrompt: "",
      engine: file.engine,
      kind: file.kind,
      fmt: file.fmt,
      mtime: file.mtimeMs / 1000,
      size: file.size,
    });
  });
  const isCurrentPublication = projectCatalogRuntime.__llvProjectCatalogPublicationGeneration === scanToken.publication;
  const isCurrentPersistence = scanToken.persistence !== null
    && projectCatalogRuntime.__llvProjectCatalogPersistenceGeneration === scanToken.persistence;
  if (isCurrentPublication && complete) replaceConversationCatalog(conversationCatalog);
  if (isCurrentPersistence && persistIndex && complete) {
    let boardHealed = true;
    if (options.persist !== false) {
      try {
        boardHealed = migrateBoardProjects(unambiguousMigrations(changes, groups));
      } catch {
        boardHealed = false;
      }
    }
    if (boardHealed) {
      writeState({ version: 2, resolutionVersion: PROJECT_RESOLUTION_VERSION, files: nextFiles });
    } else {
      console.error("[project catalog] board project migration deferred; a later scan will retry");
    }
  }
  return {
    projectCatalog: [...groups.values()]
      .filter((entry) => entry.conversations > 0)
      .sort((a, b) => b.smt - a.smt || a.project.localeCompare(b.project)),
    projectByPath,
    conversationCatalog,
    summaryByPath,
    complete,
  };
}

export async function projectCatalogFromRaw(raw: RawEntry[]): Promise<ProjectCatalogEntry[]> {
  return (await projectCatalogSnapshotFromRaw(raw)).projectCatalog;
}
