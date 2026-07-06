import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stateDir } from "@/lib/configDir";

import type { Engine, Fmt, RootKey } from "../types";
import { cleanTitle } from "../title";
import { globalCache } from "./caches";
import { readJson, recordValue, recordsValue, stringValue } from "./json";

interface Meta {
  project: string;
  worktree?: string;
  title: string;
  engine: Engine;
  kind: string;
  fmt: Fmt;
}

const metaCache = globalCache<[number, Meta]>("meta-v2");
// Title and codex project live in the immutable head of a growing transcript,
// so both are keyed by path and kept for good once resolved. A live file grows
// on every poll, so a size-keyed meta cache would re-read the whole file each
// tick; these caches read only the head and stop reading once the answer is
// fixed. A head that has not yet produced a title (empty/short file) is left
// open so growth can still yield one.
const titleCache = globalCache<[number, string | null]>("title");
const codexProjectCache = globalCache<{ project: string; worktree?: string }>("codex-project-v2");
/* The cwd sits in the immutable head, so it follows the title-cache rule:
   keyed by path, re-read only while unresolved and the head still short. */
const cwdCache = globalCache<[number, string | null]>("claude-cwd");

const HEAD_BYTES = 131_072;

function readHead(pathname: string, size: number): { text: string; read: number } | null {
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      return { text: buf.toString("utf8", 0, read), read };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Claude project slugs encode the cwd with "/" and "." replaced by "-":
// "-home-user-Projects-my-app" → "my-app", plain home dir → its basename.
const homeSlug = "-" + os.homedir().split(path.sep).filter(Boolean).join("-");
const slugPrefixes = [homeSlug + "-Projects-", homeSlug + "-"];
const skipTitlePrefixes = ["<", "#", "Caveat:", "{", "[", "This session is being continued"];

export function projectFromSlug(slug: string): string {
  if (slug === homeSlug) return path.basename(os.homedir());
  for (const prefix of slugPrefixes) {
    if (slug.startsWith(prefix)) return slug.slice(prefix.length) || slug;
  }
  return slug;
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
const persistedProjectCache = globalCache<[number, string, {
  byCwd: Map<string, { project: string; worktree?: string }>;
  byPath: Map<string, { project: string; worktree?: string }>;
  bySlug: Map<string, { project: string; worktree?: string }>;
}]>("persisted-project");
const PERSISTED_PROJECT_TTL_MS = 10_000;

/** Linked git worktrees created anywhere (`git worktree add ../foo`), not
    only under `.claude/worktrees/`: such a checkout has a `.git` FILE whose
    gitdir points into the main repo — the session belongs to that project. */
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

function projectOverride(project: unknown, cwd: unknown, forceWorktree = false): { project: string; worktree?: string } | null {
  if (typeof project !== "string" || !project.trim() || typeof cwd !== "string" || !cwd.trim()) return null;
  const cwdProject = projectFromSlug(cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const worktree = forceWorktree || cwdProject !== project ? path.basename(cwd) : undefined;
  return { project, worktree };
}

function persistedProjects(): {
  byCwd: Map<string, { project: string; worktree?: string }>;
  byPath: Map<string, { project: string; worktree?: string }>;
  bySlug: Map<string, { project: string; worktree?: string }>;
} {
  const dir = stateDir();
  const cached = persistedProjectCache.get("state");
  if (cached && cached[0] > Date.now() && cached[1] === dir) return cached[2];
  const byCwd = new Map<string, { project: string; worktree?: string }>();
  const byPath = new Map<string, { project: string; worktree?: string }>();
  const bySlug = new Map<string, { project: string; worktree?: string }>();
  const rememberSlug = (value: unknown, info: { project: string; worktree?: string } | null) => {
    if (!info || typeof value !== "string" || !value.endsWith(".jsonl")) return;
    const slug = path.basename(path.dirname(value));
    if (slug.startsWith("-")) bySlug.set(slug, info);
  };
  const rememberPath = (value: unknown, info: { project: string; worktree?: string } | null) => {
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
  persistedProjectCache.set("state", [Date.now() + PERSISTED_PROJECT_TTL_MS, dir, maps]);
  return maps;
}

/** Project identity for a real cwd, shared by both engines: resolve a
    worktree checkout to its main repo, then name the project the way Claude
    slugs name it (`projectFromSlug` of the dashed path). One naming scheme
    means a codex session, a claude session, and any worktree of the same repo
    all land in the SAME sidebar group instead of lookalike neighbors. */
function projectInfoFromCwd(cwd: string): { project: string; worktree?: string } | null {
  const worktree = worktreeFromPath(cwd) ?? worktreeFromGitFile(cwd);
  if (!worktree && !hasGitMarker(cwd)) {
    const persisted = persistedProjects().byCwd.get(cwd);
    if (persisted) return persisted;
  }
  const root = worktree ? worktree.repo : cwd;
  const project = projectFromSlug(root.replace(/[^a-zA-Z0-9]/g, "-"));
  return project ? { project, worktree: worktree?.worktree } : null;
}

/** The project key a session running in `cwd` gets from the scanner. The
    workflow engine stamps this on new workflows so their strip lands in the
    same dashboard group as the agents the worktree will host. */
export function projectForCwd(cwd: string): string | null {
  return projectInfoFromCwd(cwd)?.project ?? null;
}

function worktreeFromSlug(slug: string): { project: string; worktree: string } | null {
  const marker = "--claude-worktrees-";
  const index = slug.indexOf(marker);
  if (index < 0) return null;
  const worktree = slug.slice(index + marker.length);
  if (!worktree) return null;
  const repoSlug = slug.slice(0, index);
  const project = repoSlug.split("--").at(-1)?.split("-").filter(Boolean).at(-1);
  if (!project) return null;
  const dashedProject = repoSlug.slice(repoSlug.lastIndexOf("-" + project) + 1) || project;
  return { project: dashedProject, worktree };
}

function cwdFromLines(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const cwd = stringValue(recordValue(parsed)?.cwd);
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
    // Compaction successors open with the raw continuation prompt; the
    // generated ai-title record names the conversation better.
    if (obj.type === "ai-title") {
      const title = goodTitle(obj.aiTitle);
      if (title) return title;
    }
    if (wantCodex) {
      const payload = recordValue(obj.payload) ?? {};
      if (payload.type === "user_message") {
        const title = goodTitle(payload.message);
        if (title) return title;
      }
      if (payload.type === "message" && payload.role === "user") {
        const text = recordsValue(payload.content)
          .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
          .join(" ")
          .trim();
        const title = goodTitle(text);
        if (title) return title;
      }
    } else if (obj.type === "user") {
      const content = recordValue(obj.message)?.content;
      if (typeof content === "string") {
        const title = goodTitle(content);
        if (title) return title;
      }
      const text = recordsValue(content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join(" ")
        .trim();
      const title = goodTitle(text);
      if (title) return title;
    }
  }
  return null;
}

function transcriptCwd(pathname: string, size: number): string | null {
  const cached = cwdCache.get(pathname);
  if (cached && (cached[1] !== null || cached[0] >= HEAD_BYTES)) return cached[1];
  const head = readHead(pathname, size);
  if (!head) return cached?.[1] ?? null;
  const cwd = cwdFromLines(head.text.split("\n").slice(0, 25));
  cwdCache.set(pathname, [head.read, cwd]);
  return cwd;
}

function projectInfoFromTranscript(pathname: string): { project: string; worktree?: string } | null {
  return persistedProjects().byPath.get(pathname) ?? null;
}

function projectInfoFromSlug(slug: string): { project: string; worktree?: string } | null {
  return persistedProjects().bySlug.get(slug) ?? null;
}

function scanJsonlTitle(pathname: string, size: number, wantCodex: boolean): string | null {
  const cached = titleCache.get(pathname);
  if (cached && (cached[1] !== null || cached[0] >= HEAD_BYTES)) return cached[1];
  const head = readHead(pathname, size);
  if (!head) return cached?.[1] ?? null;
  const title = titleFromLines(head.text.split("\n").slice(0, 151), wantCodex);
  titleCache.set(pathname, [head.read, title]);
  return title;
}

export function describe(rootName: RootKey, root: string, pathname: string, st: fs.Stats): Meta {
  const cached = metaCache.get(pathname);
  if (cached?.[0] === st.size) return cached[1];
  const rel = path.relative(root, pathname);
  const fn = path.basename(pathname);
  let project = "other";
  let worktree: string | undefined;
  let title: string | null = null;
  let engine: Engine = "claude";
  let kind = "";
  let fmt: Fmt = "plain";
  if (rootName === "codex-jobs") {
    const slug = rel.split(path.sep)[0] ?? "";
    const parts = slug.split("-");
    const suffix = parts.at(-1) ?? "";
    project = parts.length >= 2 && suffix.length >= 12 ? parts.slice(0, -1).join("-") : slug;
    engine = "codex";
    kind = "job";
    const job = readJson(pathname.replace(/\.log$/, ".json"));
    if (job) {
      const bits = [stringValue(job.kindLabel) ?? "", stringValue(job.title) ?? ""].filter(Boolean);
      const head = bits.join(" · ");
      const summary = (stringValue(job.summary) ?? "").split(/\s+/).join(" ").trim();
      title = (head + (summary ? " — " + summary : "")) || fn;
    } else title = fn;
  } else if (rootName === "codex-sessions") {
    const cachedProject = codexProjectCache.get(pathname);
    if (cachedProject) {
      project = cachedProject.project;
      worktree = cachedProject.worktree;
    } else {
      project = "";
      const head = readHead(pathname, st.size);
      if (head) {
        try {
          const first = JSON.parse(head.text.split("\n")[0] ?? "{}");
          const cwd = stringValue(recordValue(first.payload)?.cwd) ?? "";
          const info = projectInfoFromCwd(cwd);
          project = info?.project ?? "";
          worktree = info?.worktree;
        } catch {
          project = "";
        }
      }
      if (!project) {
        const info = projectInfoFromTranscript(pathname);
        project = info?.project ?? "";
        worktree = info?.worktree;
      }
      if (project) codexProjectCache.set(pathname, { project, worktree });
    }
    if (!project) project = "codex";
    engine = "codex";
    kind = "session";
    fmt = "codex";
    title = scanJsonlTitle(pathname, st.size, true) ?? "Codex session";
  } else if (rootName === "claude-projects") {
    const slug = rel.split(path.sep)[0] ?? "";
    const worktreeInfo = worktreeFromSlug(slug);
    project = worktreeInfo?.project ?? projectFromSlug(slug);
    worktree = worktreeInfo?.worktree;
    /* The slug alone cannot tell a sibling worktree checkout from a real
       standalone project — only the cwd's git metadata can. When it proves a
       worktree, the session regroups under its main repo's project name. */
    const cwd = transcriptCwd(pathname, st.size);
    const info = cwd ? projectInfoFromCwd(cwd) : projectInfoFromTranscript(pathname);
    const persistedInfo = projectInfoFromTranscript(pathname);
    if (info && (worktreeInfo || info.worktree || persistedInfo)) {
      project = info.project;
      worktree = info.worktree ?? worktree;
    }
    fmt = "claude";
    if (fn.startsWith("agent-")) {
      kind = "subagent";
      const meta = readJson(pathname.slice(0, -".jsonl".length) + ".meta.json") ?? {};
      title =
        stringValue(meta.description) ??
        stringValue(meta.name) ??
        "Subagent " + fn.slice("agent-".length).split(".")[0];
    } else {
      kind = "session";
      title = scanJsonlTitle(pathname, st.size, false) ?? "Claude session";
    }
  } else if (rootName === "claude-tasks") {
    const slug = rel.split(path.sep)[0] ?? "";
    const info = projectInfoFromSlug(slug);
    project = info?.project ?? projectFromSlug(slug);
    worktree = info?.worktree;
    engine = "shell";
    kind = "background";
    title = "Background task " + fn.split(".")[0];
  }
  const meta = {
    project,
    worktree,
    title: cleanTitle(title ?? fn, 120),
    engine,
    kind,
    fmt,
  };
  metaCache.set(pathname, [st.size, meta]);
  return meta;
}
