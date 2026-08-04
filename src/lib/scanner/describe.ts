import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import {
  displayNameFromProjectIdentity,
  isCanonicalProjectId,
  projectIdentityFromDirectory,
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
  UNRESOLVED_PROJECT,
  UNRESOLVED_PROJECT_NAME,
} from "@/lib/projects/identity";

import type { Engine, Fmt, RootKey } from "../types";
import { cleanTitle } from "../title";
import { globalCache } from "./caches";
import { nativeCodexSessionMetaResult } from "./codexNative";
import { HEAD_READ_CHUNK_BYTES, headFingerprint, readHead, type HeadReadResult } from "./head";
import { readJsonResult, recordValue, recordsValue, stringValue } from "./json";
import { projectResolutionStateKey } from "./projectState";

export interface FileDescription {
  project: string;
  projectName: string;
  projectUnresolved?: true;
  worktree?: string;
  cwd?: string;
  sessionStartedAt?: string | null;
  nativeParentThreadId?: string | null;
  nativeForkSourceThreadId?: string | null;
  projectRoot?: string | null;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
}

export interface FileDescriptionIdentity {
  size: number;
  mtimeMs: number;
  sidecarSize: number | null;
  sidecarMtimeMs: number | null;
  complete: boolean;
}

export interface FileDescriptionResult {
  description: FileDescription;
  complete: boolean;
}

/** Everything derived from the transcript (and sidecar) bytes themselves.
    Keyed by file identity alone: reconciliation rewriting flows.json or the
    worktree map must never evict transcript-derived evidence (#287). */
type TranscriptMetadata = {
  cwd?: string;
  sessionStartedAt: string | null;
  nativeParentThreadId: string | null;
  nativeForkSourceThreadId: string | null;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
};

type CachedTranscriptMetadata = {
  identity: FileDescriptionIdentity;
  metadata: TranscriptMetadata;
};

/** Project/worktree resolution overlays the transcript metadata. It depends on
    the project-state files (flows, workflows, worktree map), so its cache keys
    on the state revision and the resolved cwd — a flow change recomputes only
    this overlay while transcript metadata stays untouched (#287). */
type ProjectOverlay = {
  project: string;
  projectName: string;
  projectUnresolved?: true;
  worktree?: string;
  projectRoot?: string | null;
};

type CachedProjectOverlay = ProjectOverlay & {
  stateKey: string;
  cwd?: string;
};

/* Earlier issue-171 builds retained full prompts in these global maps. Clear
   them during hot reload so the bounded scheme metadata shape takes effect
   without waiting for a process restart. */
globalCache<unknown>("meta-v4").clear();
globalCache<unknown>("title-v2").clear();
/* The pre-#287 composite description cache keyed transcript metadata on the
   project-state hash, so reconciliation invalidated it corpus-wide. */
globalCache<unknown>("meta-v6").clear();
const transcriptMetaCache = globalCache<CachedTranscriptMetadata>("meta-transcript-v7");
globalCache<unknown>("project-overlay-v1").clear();
const projectOverlayCache = globalCache<CachedProjectOverlay>("project-overlay-v2");
// Title and codex project live in the immutable head of a growing transcript.
// Resolved head values survive append-only growth, while the complete file
// identity invalidates same-size rewrites and truncations. A head that has not
// yet produced a title stays open so growth can still yield one.
export type ConversationSearchText = { title: string | null; firstPrompt: string | null };
type HeadMetadataCache<T> = {
  size: number;
  mtimeMs: number;
  value: T;
  headBytes: number;
  headFingerprint: string;
};
const titleCache = globalCache<HeadMetadataCache<string | null>>("title-v5");
/* Search text can be large and belongs to the list/search path. Its bounded
   cache lives with the search index; page hydration reads only its visible rows. */
globalCache<unknown>("conversation-search-v1").clear();
/* Subsumed by the split project-overlay cache above (#287). */
globalCache<unknown>("codex-project-v5").clear();
const repoSlugCache = globalCache<[number, string | null]>("repo-path-from-slug-v1");
/* The cwd follows the same append-only head reuse and rewrite invalidation. */
const cwdCache = globalCache<HeadMetadataCache<string | null>>("claude-cwd-v3");
const sessionStartedAtCache = globalCache<HeadMetadataCache<string | null>>("session-started-at-v1");

const HEAD_BYTES = HEAD_READ_CHUNK_BYTES;

function subagentSidecarPath(rootName: RootKey, pathname: string): string | null {
  if (rootName !== "claude-projects" || !path.basename(pathname).startsWith("agent-") || !pathname.endsWith(".jsonl")) {
    return null;
  }
  return pathname.slice(0, -".jsonl".length) + ".meta.json";
}

export function fileDescriptionIdentity(
  rootName: RootKey,
  pathname: string,
  st: fs.Stats,
): FileDescriptionIdentity {
  const sidecarPath = subagentSidecarPath(rootName, pathname);
  if (!sidecarPath) {
    return { size: st.size, mtimeMs: st.mtimeMs, sidecarSize: null, sidecarMtimeMs: null, complete: true };
  }
  try {
    const sidecar = fs.statSync(sidecarPath);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sidecarSize: sidecar.size,
      sidecarMtimeMs: sidecar.mtimeMs,
      complete: true,
    };
  } catch (error) {
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sidecarSize: null,
      sidecarMtimeMs: null,
      complete: (error as NodeJS.ErrnoException).code === "ENOENT",
    };
  }
}

function sameFileDescriptionIdentity(left: FileDescriptionIdentity, right: FileDescriptionIdentity): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sidecarSize === right.sidecarSize
    && left.sidecarMtimeMs === right.sidecarMtimeMs;
}

function readSearchHead(pathname: string, size: number): { text: string; read: number } | null {
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString("utf8", 0, read), read };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const skipTitlePrefixes = ["<", "#", "Caveat:", "{", "[", "This session is being continued"];

export function projectFromSlug(slug: string): string {
  return canonicalProject(slug);
}

function worktreeFromPath(cwd: string): { repo: string; worktree: string } | null {
  const marker = path.sep + ".claude" + path.sep + "worktrees" + path.sep;
  const index = cwd.indexOf(marker);
  if (index < 0) return null;
  const rest = cwd.slice(index + marker.length).split(path.sep).filter(Boolean);
  const worktree = rest[0];
  if (!worktree) return null;
  return { repo: cwd.slice(0, index), worktree };
}

/** Nested worktree conventions: `git worktree add worktrees/<name>` (or the
    dotted `.worktrees/<name>`) puts checkouts under a container dir INSIDE the
    repo, so the parent repo is literally the path prefix before that container.
    Recognizing them by path means a deleted nested worktree still names its
    repo — no on-disk `.git` needed. `.claude/worktrees` and
    `.codex/worktrees` have dedicated recognizers, so a `worktrees` segment
    sitting directly under `.claude`/`.codex` is left to them. The FIRST
    container wins, so a worktree-of-a-worktree groups under the outermost repo. */
function worktreeFromNested(cwd: string): { repo: string; worktree: string } | null {
  const parts = cwd.split(path.sep);
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] !== "worktrees" && parts[i] !== ".worktrees") continue;
    if (parts[i - 1] === ".claude" || parts[i - 1] === ".codex") return null;
    const worktree = parts[i + 1];
    if (!worktree) return null;
    return { repo: parts.slice(0, i).join(path.sep) || path.sep, worktree };
  }
  return null;
}

function repoPathFromSlug(slug: string): string | null {
  const cached = repoSlugCache.get(slug);
  if (cached && cached[0] > Date.now()) return cached[1];

  /* Slugs for repositories outside the two conventional roots are lossy:
     separators, dots, and spaces all become dashes. Walk only filesystem
     branches whose encoded prefix can still match, then accept a unique
     existing directory (preferring a git root when ambiguity remains). */
  if (!slug.startsWith("-")) return null;
  const matches: string[] = [];
  let frontier: Array<{ pathname: string; encoded: string }> = [{ pathname: path.parse(path.resolve(path.sep)).root, encoded: "" }];
  for (let depth = 0; depth < 32 && frontier.length > 0 && matches.length < 16; depth += 1) {
    const next: Array<{ pathname: string; encoded: string }> = [];
    for (const parent of frontier) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(parent.pathname, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const encoded = parent.encoded + "-" + entry.name.replace(/[^a-zA-Z0-9]/g, "-");
        if (encoded !== slug && !slug.startsWith(encoded + "-")) continue;
        const pathname = path.join(parent.pathname, entry.name);
        let directory = entry.isDirectory();
        if (!directory && entry.isSymbolicLink()) {
          try {
            directory = fs.statSync(pathname).isDirectory();
          } catch {
            directory = false;
          }
        }
        if (!directory) continue;
        if (encoded === slug) matches.push(pathname);
        else next.push({ pathname, encoded });
      }
    }
    frontier = next.slice(0, 64);
  }
  const repositories = matches.filter(hasGitMarker);
  const resolved = repositories.length === 1
    ? repositories[0]!
    : matches.length === 1 ? matches[0]! : null;
  repoSlugCache.set(slug, [Date.now() + 10_000, resolved]);
  return resolved;
}

/** Codex creates ephemeral worktrees at `~/.codex/worktrees/<hash>/<RepoName>`
    and deletes them once the task ends. While one lives, `worktreeFromGitFile`
    resolves it to the main repo via its `.git` pointer; once deleted that read
    fails and the session can fragment into its own `-codex-worktrees-<hash>-…`
    project. Recover the repo from known local repo roots so a finished
    worktree's session keeps the same project key as a live checkout. */
function worktreeFromCodexPath(cwd: string): { repo: string; worktree: string; projectHint: string } | null {
  const marker = path.sep + ".codex" + path.sep + "worktrees" + path.sep;
  const index = cwd.indexOf(marker);
  if (index < 0) return null;
  const rest = cwd.slice(index + marker.length).split(path.sep).filter(Boolean);
  const [worktree, repoName] = rest;
  if (!worktree || !repoName) return null;
  return { repo: "", worktree, projectHint: repoName };
}

/** Main-repo root + worktree name from a linked checkout's `.git` file
    content (`gitdir: <main>/.git/worktrees/<name>`). Pure for testability. */
export function parseWorktreeGitdir(cwd: string, gitFileText: string): { repo: string; worktree: string } | null {
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(gitFileText)?.[1];
  if (!target) return null;
  const parts = path.resolve(cwd, target).split(path.sep);
  const index = parts.lastIndexOf("worktrees");
  const worktree = index >= 0 ? parts[index + 1] : undefined;
  if (!worktree || parts[index - 1] !== ".git") return null;
  return { repo: parts.slice(0, index - 1).join(path.sep) || path.sep, worktree };
}

/* A cwd's worktree resolution is one lstat + tiny read, but it runs on every
   meta recompute of a live file — cache per cwd, with a short TTL so a
   checkout that just became (or stopped being) a worktree is noticed. */
const worktreeGitCache = globalCache<[number, { repo: string; worktree: string } | null]>("worktree-git");
const WORKTREE_TTL_MS = 60_000;
type ProjectInfo = {
  project: string;
  displayName: string;
  unresolved?: true;
  worktree?: string;
  repo?: string;
};
const projectInfoCwdCache = globalCache<[number, string, ProjectInfo | null]>("project-info-cwd-v2");
const PROJECT_INFO_CWD_TTL_MS = 10_000;
const persistedProjectCache = globalCache<[number, string, string, {
  byCwd: Map<string, { project: string; worktree?: string; repo?: string }>;
  byPath: Map<string, { project: string; worktree?: string; repo?: string }>;
  bySlug: Map<string, { project: string; worktree?: string; repo?: string }>;
}]>("persisted-project-v2");
const PERSISTED_PROJECT_TTL_MS = 10_000;

function unresolvedProjectInfo(worktree?: string): ProjectInfo {
  return {
    project: UNRESOLVED_PROJECT,
    displayName: UNRESOLVED_PROJECT_NAME,
    unresolved: true,
    ...(worktree ? { worktree } : {}),
  };
}

function aliasedProjectInfo(
  project: string,
  worktree?: string,
  repo?: string,
): ProjectInfo {
  const canonical = canonicalProject(project);
  if (canonical === project && canonical !== UNRESOLVED_PROJECT && !isCanonicalProjectId(canonical)) {
    return unresolvedProjectInfo(worktree);
  }
  const repositoryIdentity = repo ? projectIdentityFromRepositoryRoot(repo) : null;
  const displayName = repositoryIdentity?.project === canonical
    ? repositoryIdentity.displayName
    : projectAliasSnapshot().displayNames[canonical] ?? displayNameFromProjectIdentity(canonical);
  return {
    project: canonical,
    displayName,
    ...(canonical === UNRESOLVED_PROJECT ? { unresolved: true as const } : {}),
    ...(worktree ? { worktree } : {}),
    ...(repo ? { repo } : {}),
  };
}

/* A `git worktree add ../foo` checkout has NO recognizable path layout — unlike
   `.claude/worktrees/` (#1) and `.codex/worktrees/` (#3), its sibling path
   reveals nothing about the parent repo. While it lives, `worktreeFromGitFile`
   resolves it via the on-disk `.git` pointer; once deleted (and `git worktree
   prune`d) that pointer AND git's admin record are gone, so a purely path-based
   recognizer cannot exist. The only thing that survives deletion is a
   resolution we WROTE DOWN while the checkout was alive. This map is that
   record: `worktreeFromGitFile` stamps cwd→{repo,worktree} on every live
   resolution and `worktreeFromMemory` replays it after deletion, keeping the
   dead worktree's sessions grouped under the parent repo instead of
   fragmenting into a phantom `-…-<branch>` project. */
const WORKTREE_MAP_FILE = "worktree-map.json";
let worktreeMemory: { dir: string; map: Map<string, { repo: string; worktree: string }> } | null = null;
let worktreeMemoryDirty = false;

function worktreeMap(): Map<string, { repo: string; worktree: string }> {
  const dir = stateDir();
  if (worktreeMemory && worktreeMemory.dir === dir) return worktreeMemory.map;
  const map = new Map<string, { repo: string; worktree: string }>();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, WORKTREE_MAP_FILE), "utf8")) as Record<
      string,
      { repo?: unknown; worktree?: unknown }
    >;
    for (const [cwd, info] of Object.entries(raw)) {
      if (typeof info?.repo === "string" && typeof info?.worktree === "string") {
        map.set(cwd, { repo: info.repo, worktree: info.worktree });
      }
    }
  } catch {
    /* no map yet or unreadable — start empty */
  }
  worktreeMemory = { dir, map };
  worktreeMemoryDirty = false;
  return map;
}

function rememberWorktree(cwd: string, info: { repo: string; worktree: string }): void {
  const map = worktreeMap();
  const prev = map.get(cwd);
  if (prev && prev.repo === info.repo && prev.worktree === info.worktree) return;
  map.set(cwd, info);
  worktreeMemoryDirty = true;
}

/** Remembered resolution of a now-deleted `git worktree add` checkout — the
    fallback that survives the checkout being removed from disk. */
function worktreeFromMemory(cwd: string): { repo: string; worktree: string } | null {
  return worktreeMap().get(cwd) ?? null;
}

/** Flush freshly-learned worktree resolutions to disk. Called once per scan
    from `linkEntries`; a no-op when nothing new was seen. */
export function persistWorktreeMap(): void {
  if (!worktreeMemoryDirty || !worktreeMemory) return;
  worktreeMemoryDirty = false;
  try {
    fs.mkdirSync(worktreeMemory.dir, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeMemory.dir, WORKTREE_MAP_FILE),
      JSON.stringify(Object.fromEntries(worktreeMemory.map)),
    );
  } catch {
    /* best-effort: a lost map only re-fragments deleted worktrees */
  }
}

/** Linked git worktrees created anywhere (`git worktree add ../foo`), not
    only under `.claude/worktrees/`: such a checkout has a `.git` FILE whose
    gitdir points into the main repo — the session belongs to that project.
    A live resolution is also written to the persistent worktree map so the
    grouping survives the checkout later being deleted. */
function worktreeFromGitFile(cwd: string): { repo: string; worktree: string } | null {
  const cached = worktreeGitCache.get(cwd);
  if (cached && cached[0] > Date.now()) return cached[1];
  let info: { repo: string; worktree: string } | null = null;
  try {
    const gitPath = path.join(cwd, ".git");
    if (fs.lstatSync(gitPath).isFile()) {
      info = parseWorktreeGitdir(cwd, fs.readFileSync(gitPath, "utf8"));
    }
  } catch {
    /* no .git or cwd gone — a plain (or vanished) project dir */
  }
  worktreeGitCache.set(cwd, [Date.now() + WORKTREE_TTL_MS, info]);
  if (info) rememberWorktree(cwd, info);
  return info;
}

function hasGitMarker(cwd: string): boolean {
  try {
    fs.lstatSync(path.join(cwd, ".git"));
    return true;
  } catch {
    return false;
  }
}

function readStateJson(name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), name), "utf8")) as unknown;
  } catch {
    return null;
  }
}

function projectOverride(
  project: unknown,
  cwd: unknown,
  forceWorktree = false,
): { project: string; worktree?: string; repo?: string } | null {
  if (typeof project !== "string" || !project.trim() || typeof cwd !== "string" || !cwd.trim()) return null;
  const cwdProject = projectFromSlug(cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const worktree = forceWorktree || cwdProject !== project ? path.basename(cwd) : undefined;
  const repo = repositoryRootForPath(cwd);
  return { project, worktree, ...(repo ? { repo } : {}) };
}

function persistedProjects(): {
  byCwd: Map<string, { project: string; worktree?: string; repo?: string }>;
  byPath: Map<string, { project: string; worktree?: string; repo?: string }>;
  bySlug: Map<string, { project: string; worktree?: string; repo?: string }>;
} {
  const dir = stateDir();
  const stateKey = projectResolutionStateKey();
  const cached = persistedProjectCache.get("state");
  if (cached && cached[0] > Date.now() && cached[1] === dir && cached[2] === stateKey) return cached[3];
  const byCwd = new Map<string, { project: string; worktree?: string; repo?: string }>();
  const byPath = new Map<string, { project: string; worktree?: string; repo?: string }>();
  const bySlug = new Map<string, { project: string; worktree?: string; repo?: string }>();
  const rememberSlug = (value: unknown, info: { project: string; worktree?: string; repo?: string } | null) => {
    if (!info || typeof value !== "string" || !value.endsWith(".jsonl")) return;
    const slug = path.basename(path.dirname(value));
    if (slug.startsWith("-")) bySlug.set(slug, info);
  };
  const rememberPath = (value: unknown, info: { project: string; worktree?: string; repo?: string } | null) => {
    if (info && typeof value === "string" && value.trim()) byPath.set(value, info);
    rememberSlug(value, info);
  };
  const flowsFile = readStateJson("flows.json") as { flows?: unknown } | null;
  const flows = Array.isArray(flowsFile?.flows) ? flowsFile.flows : [];
  for (const value of flows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const flow = value as Record<string, unknown>;
    const info = projectOverride(flow.project, flow.cwd);
    if (!info || typeof flow.cwd !== "string") continue;
    byCwd.set(flow.cwd, info);
    rememberPath(flow.implementerPath, info);
    const rounds = Array.isArray(flow.rounds) ? flow.rounds : [];
    for (const round of rounds) {
      if (!round || typeof round !== "object" || Array.isArray(round)) continue;
      rememberPath((round as Record<string, unknown>).reviewerPath, info);
    }
  }
  const workflowsFile = readStateJson("workflows.json") as { workflows?: unknown } | null;
  const workflows = Array.isArray(workflowsFile?.workflows) ? workflowsFile.workflows : [];
  for (const value of workflows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const workflow = value as Record<string, unknown>;
    const repoInfo = projectOverride(workflow.project, workflow.repoDir);
    if (repoInfo && typeof workflow.repoDir === "string") byCwd.set(workflow.repoDir, repoInfo);
    const worktreeInfo = projectOverride(workflow.project, workflow.worktreeDir, true);
    if (worktreeInfo && typeof workflow.worktreeDir === "string") byCwd.set(workflow.worktreeDir, worktreeInfo);
    const stageRuns = Array.isArray(workflow.stageRuns) ? workflow.stageRuns : [];
    for (const run of stageRuns) {
      if (!run || typeof run !== "object" || Array.isArray(run)) continue;
      rememberPath((run as Record<string, unknown>).agentPath, worktreeInfo ?? repoInfo);
    }
    rememberPath(workflow.fixerPath, worktreeInfo ?? repoInfo);
  }
  const maps = { byCwd, byPath, bySlug };
  persistedProjectCache.set("state", [Date.now() + PERSISTED_PROJECT_TTL_MS, dir, stateKey, maps]);
  return maps;
}

/** Project identity for a real cwd, shared by both engines: resolve a
    worktree checkout to its main repository, then derive the stable key and
    human label from that repository's canonical remote. */
export function projectInfoFromCwd(cwd: string): ProjectInfo | null {
  if (!cwd.trim()) return null;
  const resolutionState = projectResolutionStateKey();
  const cached = projectInfoCwdCache.get(cwd);
  if (cached && cached[0] > Date.now() && cached[1] === resolutionState) return cached[2];
  const scratchpad = projectInfoFromClaudeTaskCwd(cwd);
  if (scratchpad) {
    projectInfoCwdCache.set(cwd, [Date.now() + PROJECT_INFO_CWD_TTL_MS, resolutionState, scratchpad]);
    return scratchpad;
  }
  const codexWorktree = worktreeFromCodexPath(cwd);
  let worktree =
    worktreeFromPath(cwd) ??
    worktreeFromNested(cwd) ??
    (codexWorktree ? worktreeFromGitFile(cwd) ?? codexWorktree : worktreeFromGitFile(cwd));
  if (!worktree && !hasGitMarker(cwd)) {
    /* An arbitrary-path worktree that has since been deleted: no live
       recognizer matched and its `.git` is gone, but a resolution we recorded
       while it was alive still names the parent repo. */
    worktree = worktreeFromMemory(cwd);
    if (!worktree) {
      const persisted = persistedProjects().byCwd.get(cwd);
      if (persisted) {
        const resolved = aliasedProjectInfo(persisted.project, persisted.worktree, persisted.repo);
        projectInfoCwdCache.set(cwd, [Date.now() + PROJECT_INFO_CWD_TTL_MS, resolutionState, resolved]);
        return resolved;
      }
    }
  }
  /* No repository claims the cwd: the directory itself is the project
     (operator decision, 2026-08-04). "Unresolved project" remains only for
     cwds that name nothing at all. */
  const directoryProjectInfo = (): ProjectInfo => {
    const identity = projectIdentityFromDirectory(cwd);
    return identity
      ? { project: identity.project, displayName: identity.displayName, ...(worktree?.worktree ? { worktree: worktree.worktree } : {}) }
      : unresolvedProjectInfo(worktree?.worktree);
  };
  const root = worktree?.repo || repositoryRootForPath(cwd);
  if (!root) {
    const resolvedInfo = codexWorktree?.projectHint
      ? aliasedProjectInfo(codexWorktree.projectHint, worktree?.worktree)
      : directoryProjectInfo();
    projectInfoCwdCache.set(cwd, [Date.now() + PROJECT_INFO_CWD_TTL_MS, resolutionState, resolvedInfo]);
    return resolvedInfo;
  }
  const identity = projectIdentityFromRepositoryRoot(root);
  const resolved = identity
    ? { project: identity.project, displayName: identity.displayName, worktree: worktree?.worktree, repo: root }
    : directoryProjectInfo();
  projectInfoCwdCache.set(cwd, [Date.now() + PROJECT_INFO_CWD_TTL_MS, resolutionState, resolved]);
  return resolved;
}

/** The project key a session running in `cwd` gets from the scanner. The
    workflow engine stamps this on new workflows so their strip lands in the
    same dashboard group as the agents the worktree will host. */
export function projectForCwd(cwd: string): string | null {
  return projectInfoFromCwd(cwd)?.project ?? null;
}

/** Resolve a conversation cwd to the repository root shared by its worktrees. */
export function projectRootForCwd(cwd: string): string | undefined {
  const scratchpad = projectInfoFromClaudeTaskCwd(cwd);
  if (scratchpad) return scratchpad.repo;
  const worktree =
    worktreeFromPath(cwd) ??
    worktreeFromNested(cwd) ??
    (worktreeFromCodexPath(cwd) ? worktreeFromGitFile(cwd) ?? worktreeFromCodexPath(cwd) : null) ??
    worktreeFromGitFile(cwd) ??
    worktreeFromMemory(cwd);
  return worktree?.repo || repositoryRootForPath(cwd) || undefined;
}

function worktreeFromSlug(slug: string): { project: string; worktree: string; repo?: string } | null {
  const codexMarker = "--codex-worktrees-";
  const markers = ["--claude-worktrees-", codexMarker, "--worktrees-"];
  let marker: string | null = null;
  let index = Number.POSITIVE_INFINITY;
  for (const candidate of markers) {
    const candidateIndex = slug.indexOf(candidate);
    if (candidateIndex >= 0 && candidateIndex < index) {
      marker = candidate;
      index = candidateIndex;
    }
  }
  if (!marker || !Number.isFinite(index)) return null;
  const suffix = slug.slice(index + marker.length);
  if (marker === codexMarker) {
    const hashEnd = suffix.indexOf("-");
    if (hashEnd <= 0) return null;
    const worktree = suffix.slice(0, hashEnd);
    const repoAndNested = suffix.slice(hashEnd + 1);
    const nestedAt = ["--claude-worktrees-", "--codex-worktrees-", "--worktrees-", "-worktrees-"]
      .map((candidate) => repoAndNested.indexOf(candidate))
      .filter((candidateIndex) => candidateIndex >= 0)
      .sort((left, right) => left - right)[0];
    const repoName = nestedAt === undefined ? repoAndNested : repoAndNested.slice(0, nestedAt);
    if (!repoName) return null;
    return { project: repoName, worktree };
  }
  const nextAt = ["--claude-worktrees-", "--codex-worktrees-", "--worktrees-", "-worktrees-"]
    .map((candidate) => suffix.indexOf(candidate))
    .filter((candidateIndex) => candidateIndex >= 0)
    .sort((left, right) => left - right)[0];
  const worktree = nextAt === undefined ? suffix : suffix.slice(0, nextAt);
  if (!worktree) return null;
  const repoSlug = slug.slice(0, index);
  const project = projectFromSlug(repoSlug);
  if (!project) return null;
  return { project, worktree, repo: repoPathFromSlug(repoSlug) ?? undefined };
}

/** Claude places nested scratchpad agents under
    `<tmp>/claude-<uid>/<encoded-cwd>/<session>/scratchpad/...`. The encoded
    cwd retains dotted worktree containers as `--worktrees-`, which is enough
    to recover the parent project after the checkout and scratchpad disappear. */
function projectInfoFromClaudeTaskCwd(cwd: string): ProjectInfo | null {
  const parts = cwd.split(path.sep);
  const container = parts.findIndex((part) => /^claude-\d+$/.test(part));
  const slug = container >= 0 ? parts[container + 1] : undefined;
  const session = container >= 0 ? parts[container + 2] : undefined;
  if (!slug || !session || parts[container + 3] !== "scratchpad") return null;
  const worktree = worktreeFromSlug(slug);
  if (worktree?.repo) {
    const identity = projectIdentityFromRepositoryRoot(worktree.repo);
    if (identity) return { ...identity, worktree: worktree.worktree, repo: worktree.repo };
  }
  if (worktree) return aliasedProjectInfo(worktree.project, worktree.worktree, worktree.repo);
  const repo = repoPathFromSlug(slug);
  if (repo) {
    const identity = projectIdentityFromRepositoryRoot(repo);
    if (identity) return { ...identity, repo };
  }
  const project = projectFromSlug(slug);
  return project ? aliasedProjectInfo(project) : null;
}

function cwdFromLines(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const record = recordValue(parsed);
      const cwd = stringValue(record?.cwd) ?? stringValue(recordValue(record?.payload)?.cwd);
      if (cwd) return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

function goodTitle(text: unknown): string | null {
  const val = typeof text === "string" ? text.trim() : "";
  return val && !skipTitlePrefixes.some((prefix) => val.startsWith(prefix)) ? val : null;
}

function userPromptFromRecord(obj: Record<string, unknown>, wantCodex: boolean): string | null {
  if (wantCodex) {
    const payload = recordValue(obj.payload) ?? {};
    if (payload.type === "user_message") {
      const prompt = typeof payload.message === "string" ? payload.message.trim() : "";
      return prompt || null;
    }
    if (payload.type === "message" && payload.role === "user") {
      const text = recordsValue(payload.content)
        .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
        .join(" ")
        .trim();
      return text || null;
    }
  } else if (obj.type === "user") {
    const content = recordValue(obj.message)?.content;
    if (typeof content === "string") return content.trim() || null;
    const text = recordsValue(content)
      .filter((part) => part.type === "text")
      .map((part) => stringValue(part.text) ?? "")
      .join(" ")
      .trim();
    return text || null;
  }
  return null;
}

function titleFromLines(lines: string[], wantCodex: boolean): string | null {
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed;
    } catch {
      continue;
    }
    if (obj.type === "summary") {
      const title = goodTitle(obj.summary);
      if (title) return title;
    }
    if (obj.type === "ai-title") {
      const title = goodTitle(obj.aiTitle);
      if (title) return title;
    }
    const title = goodTitle(userPromptFromRecord(obj, wantCodex));
    if (title) return title;
  }
  return null;
}

function conversationTextFromLines(lines: string[], wantCodex: boolean): ConversationSearchText {
  let title: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed;
    } catch {
      continue;
    }
    if (obj.type === "summary") {
      title ??= goodTitle(obj.summary);
    }
    // Compaction successors open with the raw continuation prompt; the
    // generated ai-title record names the conversation better.
    if (obj.type === "ai-title") {
      title ??= goodTitle(obj.aiTitle);
    }
    const prompt = userPromptFromRecord(obj, wantCodex);
    if (!prompt) continue;
    firstPrompt ??= prompt;
    title ??= goodTitle(prompt);
    if (title && firstPrompt) return { title, firstPrompt };
  }
  return { title, firstPrompt };
}

interface MetadataReadResult<T> {
  value: T;
  complete: boolean;
  headPreserved: boolean;
}

function reusableGrowingHead<T>(
  cached: HeadMetadataCache<T>,
  st: fs.Stats,
  head: HeadReadResult,
): HeadMetadataCache<T> | null {
  if (st.size <= cached.size || !head.complete || !head.value || head.value.read < cached.headBytes) return null;
  const preserved = headFingerprint(head.value.bytes.subarray(0, cached.headBytes)) === cached.headFingerprint;
  if (!preserved || (cached.value === null && cached.headBytes < HEAD_BYTES)) return null;
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    value: cached.value,
    headBytes: head.value.read,
    headFingerprint: headFingerprint(head.value.bytes),
  };
}

function cacheHeadMetadata<T>(st: fs.Stats, head: NonNullable<HeadReadResult["value"]>, value: T): HeadMetadataCache<T> {
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    value,
    headBytes: head.read,
    headFingerprint: headFingerprint(head.bytes),
  };
}

function transcriptCwd(pathname: string, st: fs.Stats): MetadataReadResult<string | null> {
  const cached = cwdCache.get(pathname);
  if (cached?.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return { value: cached.value, complete: true, headPreserved: true };
  }
  const head = readHead(pathname, st.size, st.mtimeMs, { maxBytes: HEAD_BYTES });
  if (!head.complete || !head.value) return { value: cached?.value ?? null, complete: false, headPreserved: false };
  if (cached) {
    const reused = reusableGrowingHead(cached, st, head);
    if (reused) {
      cwdCache.set(pathname, reused);
      return { value: reused.value, complete: true, headPreserved: true };
    }
  }
  const cwd = cwdFromLines(head.value.text.split("\n").slice(0, 25));
  cwdCache.set(pathname, cacheHeadMetadata(st, head.value, cwd));
  return { value: cwd, complete: true, headPreserved: false };
}

function transcriptStartedAt(pathname: string, st: fs.Stats): MetadataReadResult<string | null> {
  const cached = sessionStartedAtCache.get(pathname);
  if (cached?.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return { value: cached.value, complete: true, headPreserved: true };
  }
  const head = readHead(pathname, st.size, st.mtimeMs, { maxBytes: HEAD_BYTES });
  if (!head.complete || !head.value) return { value: cached?.value ?? null, complete: false, headPreserved: false };
  if (cached) {
    const reused = reusableGrowingHead(cached, st, head);
    if (reused) {
      sessionStartedAtCache.set(pathname, reused);
      return { value: reused.value, complete: true, headPreserved: true };
    }
  }
  let startedAt: string | null = null;
  for (const line of head.value.text.split("\n").slice(0, 10)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { timestamp?: unknown; payload?: { timestamp?: unknown } };
      const timestamp = typeof value.payload?.timestamp === "string"
        ? value.payload.timestamp
        : typeof value.timestamp === "string" ? value.timestamp : null;
      if (timestamp && Number.isFinite(Date.parse(timestamp))) {
        startedAt = new Date(timestamp).toISOString();
        break;
      }
    } catch {
      continue;
    }
  }
  sessionStartedAtCache.set(pathname, cacheHeadMetadata(st, head.value, startedAt));
  return { value: startedAt, complete: true, headPreserved: false };
}

function projectInfoFromTranscript(pathname: string): ProjectInfo | null {
  const persisted = persistedProjects().byPath.get(pathname);
  return persisted ? aliasedProjectInfo(persisted.project, persisted.worktree, persisted.repo) : null;
}

function projectInfoFromSlug(slug: string): ProjectInfo | null {
  const persisted = persistedProjects().bySlug.get(slug);
  return persisted ? aliasedProjectInfo(persisted.project, persisted.worktree, persisted.repo) : null;
}

function scanJsonlTitle(pathname: string, st: fs.Stats, wantCodex: boolean): MetadataReadResult<string | null> {
  const cached = titleCache.get(pathname);
  if (cached?.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return { value: cached.value, complete: true, headPreserved: true };
  }
  const head = readHead(pathname, st.size, st.mtimeMs, { maxBytes: HEAD_BYTES });
  if (!head.complete || !head.value) return { value: cached?.value ?? null, complete: false, headPreserved: false };
  if (cached) {
    const reused = reusableGrowingHead(cached, st, head);
    if (reused) {
      titleCache.set(pathname, reused);
      return { value: reused.value, complete: true, headPreserved: true };
    }
  }
  const title = titleFromLines(head.value.text.split("\n").slice(0, 151), wantCodex);
  titleCache.set(pathname, cacheHeadMetadata(st, head.value, title));
  return { value: title, complete: true, headPreserved: false };
}

/** Title and first-prompt hydration owned entirely by list/search requests. */
export function searchTextForTranscript(pathname: string, size: number, engine: "codex" | "claude"): ConversationSearchText {
  const head = readSearchHead(pathname, size);
  if (!head) return { title: null, firstPrompt: null };
  return conversationTextFromLines(head.text.split("\n").slice(0, 151), engine === "codex");
}

function deriveTranscriptMetadata(
  rootName: RootKey,
  pathname: string,
  st: fs.Stats,
  identity: FileDescriptionIdentity,
): { metadata: TranscriptMetadata; complete: boolean; cwdComplete: boolean } {
  const fn = path.basename(pathname);
  let cwd: string | undefined;
  let cwdComplete = identity.complete;
  let sessionStartedAt: string | null = null;
  let nativeParentThreadId: string | null = null;
  let nativeForkSourceThreadId: string | null = null;
  let title: string | null = null;
  let engine: Engine = "claude";
  let kind = "";
  let fmt: Fmt = "plain";
  let complete = identity.complete;
  if (rootName === "codex-sessions") {
    const cwdRead = complete
      ? transcriptCwd(pathname, st)
      : { value: null, complete: false, headPreserved: false };
    complete &&= cwdRead.complete;
    cwdComplete = cwdRead.complete;
    cwd = cwdRead.value ?? undefined;
    if (complete) {
      const startedAtRead = transcriptStartedAt(pathname, st);
      complete &&= startedAtRead.complete;
      sessionStartedAt = startedAtRead.value;
    }
    if (complete) {
      /* One read of the identity header serves both edges it carries: the
         engine-native subagent parent (#339) and the provider-fork source
         (#708). Carrying the fork edge on the description is what keeps
         migration reconciliation off a second bounded prefix read per
         transcript — including a restart served from the persisted scan
         snapshot, where no in-process header cache survives. */
      const sessionMeta = nativeCodexSessionMetaResult(pathname, st.size, st.mtimeMs);
      complete &&= sessionMeta.complete;
      nativeParentThreadId = sessionMeta.parent;
      nativeForkSourceThreadId = sessionMeta.forkedFrom;
    }
    engine = "codex";
    kind = "session";
    fmt = "codex";
    if (complete) {
      const titleRead = scanJsonlTitle(pathname, st, true);
      complete &&= titleRead.complete;
      title = titleRead.value;
    }
    title ??= "Codex session";
  } else if (rootName === "claude-projects") {
    const cwdRead = complete
      ? transcriptCwd(pathname, st)
      : { value: null, complete: false, headPreserved: false };
    complete &&= cwdRead.complete;
    cwdComplete = cwdRead.complete;
    cwd = cwdRead.value ?? undefined;
    if (complete) {
      const startedAtRead = transcriptStartedAt(pathname, st);
      complete &&= startedAtRead.complete;
      sessionStartedAt = startedAtRead.value;
    }
    fmt = "claude";
    if (fn.startsWith("agent-")) {
      kind = "subagent";
      const sidecar = complete
        ? identity.sidecarSize === null
          ? { value: null, complete: identity.complete }
          : readJsonResult(pathname.slice(0, -".jsonl".length) + ".meta.json")
        : { value: null, complete: false };
      complete &&= sidecar.complete;
      const meta = sidecar.value ?? {};
      title = stringValue(meta.description) ?? stringValue(meta.name) ?? null;
      /* Workflow subagents (issue #339) ship no sidecar name/description. Their
         transcript still carries the delegated sidechain prompt, so the first
         real user message names the card instead of a generic «Subagent …». */
      if (!title && complete) {
        const titleRead = scanJsonlTitle(pathname, st, false);
        complete &&= titleRead.complete;
        title = titleRead.value;
      }
      title ??= "Subagent " + fn.slice("agent-".length).split(".")[0];
    } else {
      kind = "session";
      if (complete) {
        const titleRead = scanJsonlTitle(pathname, st, false);
        complete &&= titleRead.complete;
        title = titleRead.value;
      }
      title ??= "Claude session";
    }
  } else if (rootName === "claude-tasks") {
    engine = "shell";
    kind = "background";
    title = "Background task " + fn.split(".")[0];
  }
  return {
    metadata: {
      cwd,
      sessionStartedAt,
      nativeParentThreadId,
      nativeForkSourceThreadId,
      title: cleanTitle(title ?? fn, 120),
      engine,
      kind,
      fmt,
    },
    complete,
    cwdComplete,
  };
}

function resolveProjectOverlay(
  rootName: RootKey,
  root: string,
  pathname: string,
  cwd: string | undefined,
  cwdAuthoritative: boolean,
  stateKey: string,
): ProjectOverlay {
  const cached = projectOverlayCache.get(pathname);
  if (cwdAuthoritative && cached && cached.stateKey === stateKey && cached.cwd === cwd) {
    return {
      project: cached.project,
      projectName: cached.projectName,
      projectUnresolved: cached.projectUnresolved,
      worktree: cached.worktree,
      projectRoot: cached.projectRoot,
    };
  }
  let info: ProjectInfo | null = null;
  if (rootName === "codex-sessions") {
    info = (cwd ? projectInfoFromCwd(cwd) : null) ?? projectInfoFromTranscript(pathname);
  } else if (rootName === "claude-projects") {
    const rel = path.relative(root, pathname);
    const slug = rel.split(path.sep)[0] ?? "";
    const worktreeInfo = worktreeFromSlug(slug);
    info = (cwd ? projectInfoFromCwd(cwd) : null)
      ?? projectInfoFromTranscript(pathname)
      ?? (worktreeInfo
        ? aliasedProjectInfo(worktreeInfo.project, worktreeInfo.worktree, worktreeInfo.repo)
        : aliasedProjectInfo(projectFromSlug(slug)));
  } else if (rootName === "claude-tasks") {
    const rel = path.relative(root, pathname);
    const slug = rel.split(path.sep)[0] ?? "";
    info = projectInfoFromSlug(slug) ?? aliasedProjectInfo(projectFromSlug(slug));
  }
  info ??= unresolvedProjectInfo();
  const overlay: ProjectOverlay = {
    project: info.project,
    projectName: info.displayName,
    projectUnresolved: info.unresolved,
    worktree: info.worktree,
    projectRoot: cwd ? projectRootForCwd(cwd) ?? null : undefined,
  };
  if (cwdAuthoritative) projectOverlayCache.set(pathname, { ...overlay, stateKey, cwd });
  return overlay;
}

/** Refresh state-backed project attribution from a durable complete summary.
    A resolver-version migration can reuse transcript metadata while deriving
    the current project, worktree, and canonical root. */
export function reprojectFileDescription(
  rootName: RootKey,
  root: string,
  pathname: string,
  description: FileDescription,
  stateKey = projectResolutionStateKey(),
): FileDescription {
  const overlay = resolveProjectOverlay(rootName, root, pathname, description.cwd, true, stateKey);
  return {
    ...description,
    project: overlay.project,
    projectName: overlay.projectName,
    projectUnresolved: overlay.projectUnresolved,
    worktree: overlay.worktree,
    projectRoot: overlay.projectRoot,
  };
}

export function describeFile(
  rootName: RootKey,
  root: string,
  pathname: string,
  st: fs.Stats,
  stateKey = projectResolutionStateKey(),
  identity = fileDescriptionIdentity(rootName, pathname, st),
): FileDescriptionResult {
  const cachedMeta = transcriptMetaCache.get(pathname);
  let metadata: TranscriptMetadata;
  let complete: boolean;
  let cwdAuthoritative: boolean;
  if (identity.complete && cachedMeta && sameFileDescriptionIdentity(cachedMeta.identity, identity)) {
    metadata = cachedMeta.metadata;
    complete = true;
    cwdAuthoritative = true;
  } else {
    const derived = deriveTranscriptMetadata(rootName, pathname, st, identity);
    metadata = derived.metadata;
    complete = derived.complete;
    cwdAuthoritative = derived.cwdComplete;
    if (complete) transcriptMetaCache.set(pathname, { identity, metadata });
  }
  const overlay = resolveProjectOverlay(rootName, root, pathname, metadata.cwd, cwdAuthoritative, stateKey);
  const description: FileDescription = {
    project: overlay.project,
    projectName: overlay.projectName,
    projectUnresolved: overlay.projectUnresolved,
    worktree: overlay.worktree,
    cwd: metadata.cwd,
    sessionStartedAt: metadata.sessionStartedAt,
    nativeParentThreadId: metadata.nativeParentThreadId,
    nativeForkSourceThreadId: metadata.nativeForkSourceThreadId,
    projectRoot: overlay.projectRoot,
    title: metadata.title,
    engine: metadata.engine,
    kind: metadata.kind,
    fmt: metadata.fmt,
  };
  return { description, complete };
}

export function describe(
  rootName: RootKey,
  root: string,
  pathname: string,
  st: fs.Stats,
  stateKey = projectResolutionStateKey(),
  identity = fileDescriptionIdentity(rootName, pathname, st),
): FileDescription {
  return describeFile(rootName, root, pathname, st, stateKey, identity).description;
}
