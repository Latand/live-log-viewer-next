import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";

import { globalCache } from "./caches";
import {
  describe,
  parseWorktreeGitdir,
  persistWorktreeMap,
  projectForCwd,
  projectInfoFromCwd,
  projectFromSlug,
  projectRootForCwd,
  searchTextForTranscript,
} from "./describe";

/* The recognisers are written over `path.sep`, so a hard-coded POSIX literal
   here would assert nothing on the `windows-latest` leg of
   `platform-tests.yml`. `abs` builds the same shape for the platform under
   test; `POSIX_ONLY` marks the cases whose behaviour Windows deliberately does
   not have, each of which has a Windows counterpart below stating what it
   becomes instead. */
const DRIVE = process.platform === "win32" ? "C:" : "";
const abs = (...segments: string[]): string => DRIVE + path.sep + segments.join(path.sep);
const POSIX_ONLY = process.platform !== "win32";
const WINDOWS_ONLY = process.platform === "win32";
const CLAUDE_TASK_CONTAINER = `claude-${process.getuid?.() ?? 1000}`;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-describe-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
const REAL_HOME = process.env.HOME;

function createRepository(
  root: string,
  remote = "ssh://git@example.invalid/team/shared-repository.git",
) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), [
    '[remote "origin"]',
    `\turl = ${remote}`,
    "",
  ].join("\n"));
  return projectIdentityFromRepositoryRoot(root)!;
}

function useStateDirectory(name: string): string {
  const state = path.join(SANDBOX, name);
  process.env.LLV_STATE_DIR = state;
  fs.mkdirSync(state, { recursive: true });
  resetProjectAliasesForTests();
  return state;
}

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
  else delete process.env.HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("parseWorktreeGitdir resolves an absolute gitdir into repo + worktree name", () => {
  /* Git for Windows writes the pointer with forward slashes and a drive letter
     (`gitdir: C:/repo/.git/worktrees/<name>`); `path.resolve` normalises it
     before the split, which is why the recogniser needs no Windows form. */
  const pointer = WINDOWS_ONLY
    ? "C:/home/user/.agents/tools/live-log-viewer-next/.git/worktrees/live-log-viewer-attention-queue"
    : "/home/user/.agents/tools/live-log-viewer-next/.git/worktrees/live-log-viewer-attention-queue";
  const info = parseWorktreeGitdir(
    abs("home", "user", ".agents", "tools", "live-log-viewer-attention-queue"),
    `gitdir: ${pointer}\n`,
  );
  expect(info).toEqual({
    repo: abs("home", "user", ".agents", "tools", "live-log-viewer-next"),
    worktree: "live-log-viewer-attention-queue",
  });
});

test("parseWorktreeGitdir resolves a relative gitdir against the checkout cwd", () => {
  const info = parseWorktreeGitdir(abs("home", "user", "wt"), "gitdir: ../main/.git/worktrees/wt");
  expect(info).toEqual({ repo: abs("home", "user", "main"), worktree: "wt" });
});

test("parseWorktreeGitdir rejects gitdirs that are not linked worktrees", () => {
  const sub = abs("home", "user", "sub");
  expect(parseWorktreeGitdir(sub, `gitdir: ${abs("home", "user", "main", ".git")}`)).toBeNull();
  expect(parseWorktreeGitdir(sub, "not a git file")).toBeNull();
  /* "worktrees" segment without a .git parent is another repo layout, not a linked checkout */
  expect(parseWorktreeGitdir(sub, `gitdir: ${abs("home", "user", "worktrees", "x")}`)).toBeNull();
});

test("a repository at the filesystem root keeps a usable root path", () => {
  /* The recognisers rebuild the repo by rejoining a `path.sep` split. On POSIX
     the empty prefix is the root; on Windows the same slice leaves a bare `C:`,
     which means "the current directory on C:" and is not `C:\` — the repo would
     then name a different, cwd-dependent place each time it was read. */
  expect(parseWorktreeGitdir(abs("wt"), `gitdir: ${abs(".git", "worktrees", "wt")}`))
    .toEqual({ repo: WINDOWS_ONLY ? "C:\\" : "/", worktree: "wt" });
});

test("an absent cwd cannot inherit the Viewer process project", () => {
  expect(projectForCwd("")).toBeNull();
  expect(projectForCwd("   ")).toBeNull();
});

test("repository identity and display name come from the repository across arbitrary checkout roots", () => {
  const remote = "ssh://git@example.invalid/team/shared-repository.git";
  const roots = [
    path.join(SANDBOX, "home", "primary", "Projects", "shared-repository"),
    path.join(SANDBOX, "home", "primary", "dev", "shared-repository"),
    path.join(SANDBOX, "home", "primary", ".agents", "tools", "shared-repository"),
    path.join(SANDBOX, "srv", "repos", "shared-repository"),
    path.join(SANDBOX, "mnt", "data", "work", "shared-repository"),
    path.join(SANDBOX, "opt", "src", "shared-repository"),
    path.join(SANDBOX, "home", "secondary", "Projects", "shared-repository"),
  ];
  for (const root of roots) {
    createRepository(root, remote);
  }

  const identities = roots.map((root) => projectInfoFromCwd(root));
  expect(identities.every(Boolean)).toBe(true);
  expect(new Set(identities.map((identity) => identity?.project))).toHaveLength(1);
  expect(new Set(identities.map((identity) => identity?.displayName))).toEqual(new Set(["shared-repository"]));
  expect(identities[0]?.project).not.toBe(identities[0]?.displayName);
  expect(identities[0]?.project).not.toContain("Projects");
});

test("repository identity is independent of the resolver HOME", () => {
  const repository = path.join(SANDBOX, "home-independent-repository");
  createRepository(repository);
  const projects: string[] = [];
  try {
    for (const home of [path.join(SANDBOX, "resolver-a"), path.join(SANDBOX, "resolver-b")]) {
      process.env.HOME = home;
      globalCache("project-info-cwd-v2").clear();
      projects.push(projectForCwd(repository)!);
    }
  } finally {
    if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
    else delete process.env.HOME;
  }
  expect(new Set(projects)).toHaveLength(1);
});

test("a cwd with no repository projects into its directory-derived project", () => {
  // Even a deleted cwd keeps a stable directory identity — sessions survive
  // their folder being removed, mirroring the worktree-grouping invariant.
  const missing = path.join(SANDBOX, "missing-repository");
  expect(fs.existsSync(missing)).toBe(false);
  const info = projectInfoFromCwd(missing)!;
  expect(info.displayName).toBe("missing-repository");
  expect(info.project).toMatch(/^dir-[0-9a-f]{32}$/);
  expect(info.unresolved).toBeUndefined();
  expect(projectInfoFromCwd(missing)).toEqual(info);
});

test("search text hydration retries after a transient filesystem failure", () => {
  const transcript = path.join(SANDBOX, "transient-search.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Recovered search prompt" } }) + "\n");
  const size = fs.statSync(transcript).size;
  const originalOpen = fs.openSync;
  let attempts = 0;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("too many open files") as NodeJS.ErrnoException;
      error.code = "EMFILE";
      throw error;
    }
    return originalOpen(...args);
  }) as typeof fs.openSync;
  try {
    expect(() => searchTextForTranscript(transcript, size, "claude")).toThrow("too many open files");
    expect(searchTextForTranscript(transcript, size, "claude").firstPrompt).toBe("Recovered search prompt");
  } finally {
    fs.openSync = originalOpen;
  }
});

test("a deleted codex worktree still groups under its parent repo project", () => {
  const state = useStateDirectory("deleted-codex-state");
  const liveRepo = path.join(SANDBOX, "deleted-codex-main");
  const identity = createRepository(liveRepo);
  expect(persistProjectAliases([
    { source: "shared-repository", target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const dead = path.join(state, ".codex", "worktrees", "2d25", "shared-repository");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(identity.project);
  expect(projectForCwd(dead)).toBe(projectForCwd(liveRepo));
});

test("a Claude worktree keeps its parent project after the checkout is removed", () => {
  useStateDirectory("deleted-claude-state");
  const repo = path.join(SANDBOX, "deleted-claude-main");
  const identity = createRepository(repo);
  const worktree = path.join(repo, ".claude", "worktrees", "topic");
  fs.mkdirSync(worktree, { recursive: true });

  const live = projectInfoFromCwd(worktree);
  expect(live).toMatchObject({ project: identity.project, worktree: "topic", repo });

  fs.rmSync(worktree, { recursive: true, force: true });
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();
  expect(fs.existsSync(worktree)).toBe(false);
  expect(projectInfoFromCwd(worktree)).toEqual(live);
  expect(projectForCwd(worktree)).toBe(projectForCwd(repo));
});

test("a deleted nested checkout inside a Codex worktree groups under the main repo", () => {
  const state = useStateDirectory("deleted-nested-codex-state");
  const identity = createRepository(path.join(SANDBOX, "deleted-nested-codex-main"));
  expect(persistProjectAliases([
    { source: "shared-repository", target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const dead = path.join(
    state,
    ".codex",
    "worktrees",
    "deleted-catalog-fixture",
    "shared-repository",
    "worktrees",
    "deleted-child",
  );
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(identity.project);
});

test.if(POSIX_ONLY)("a deleted worktree scratchpad cwd groups under the encoded parent repo", () => {
  const repo = path.join(SANDBOX, "scratchpad-worktree-repository");
  createRepository(repo);
  const worktree = path.join(repo, ".worktrees", "runtime-host-spike");
  const slug = worktree.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad", "probes");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
  expect(projectRootForCwd(dead)).toBe(repo);
});

test.if(POSIX_ONLY)("a main-checkout scratchpad cwd groups under its encoded project", () => {
  const repo = path.join(SANDBOX, "scratchpad-main-repository");
  createRepository(repo);
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad", "probes");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
});

test.if(POSIX_ONLY)("a deleted scratchpad encoded from an external repository keeps its canonical root", () => {
  const repo = path.join(SANDBOX, "external-root", "repo.with-hyphen");
  createRepository(repo);
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad", "probes");

  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
  expect(projectRootForCwd(dead)).toBe(repo);

  const missingSlug = path.join(SANDBOX, "removed-external-repo").replace(/[^a-zA-Z0-9]/g, "-");
  const missing = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, missingSlug, "deleted-session", "scratchpad");
  expect(projectRootForCwd(missing)).toBeUndefined();
});

test("the outer nested worktree wins over a later specialized container", () => {
  const repo = path.join(SANDBOX, "outer-repo");
  createRepository(repo);
  const dead = path.join(repo, "worktrees", "outer", ".codex", "worktrees", "inner-hash", "InnerRepo");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
});

test.if(POSIX_ONLY)("a scratchpad encoded from nested worktrees keeps the outer project", () => {
  const repo = path.join(SANDBOX, "nested-scratchpad-repository");
  createRepository(repo);
  const nested = path.join(repo, ".worktrees", "outer", ".claude", "worktrees", "inner");
  const slug = nested.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
  const root = path.join(SANDBOX, "nested-scratchpad-transcripts");
  const transcript = path.join(root, "nested-scratchpad", "session.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd: dead, message: { content: "Nested scratchpad" } }) + "\n");
  expect(describe("claude-projects", root, transcript, fs.statSync(transcript))).toMatchObject({
    project: projectForCwd(repo),
    worktree: "outer",
  });
});

test.if(POSIX_ONLY)("a scratchpad encoded from a deleted Codex worktree keeps the repo project", () => {
  const state = useStateDirectory("deleted-codex-scratchpad-state");
  const identity = createRepository(path.join(SANDBOX, "deleted-codex-scratchpad-main"));
  expect(persistProjectAliases([
    { source: "shared-repository", target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const codexWorktree = path.join(
    state,
    ".codex",
    "worktrees",
    "2d25",
    "shared-repository",
    "worktrees",
    "inner",
  );
  const slug = codexWorktree.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(identity.project);
});

/* The Windows counterparts of the five scratchpad cases above. Recogniser #1
   (`projectInfoFromClaudeTaskCwd`) and the slug walk it leans on
   (`repoPathFromSlug`) are the two pieces of the grouping algorithm that
   Windows does not get in phase 1, and AGENTS.md is explicit that a recogniser
   must not be allowed to stop matching quietly. These say out loud what they
   become: the container is still recognised and the key is still stable, but it
   is the slug's key rather than the repository's, because the frontier walk
   that recovers a repository path from a slug starts at the POSIX root and a
   Windows slug starts at a drive letter. Nothing in the design claims to know
   what Claude Code names that container on Windows — the layout has never been
   observed — so the case that would settle it is listed as deferred, not
   asserted here. */
test.if(WINDOWS_ONLY)("a Windows scratchpad slug lands in Unresolved rather than under its repository", () => {
  /* Measured on the Windows leg, and worse than "it groups by its slug": with
     no repository path recovered there is no canonical project id either, and
     `aliasedProjectInfo` answers Unresolved for a bare slug. Every scratchpad
     session on Windows therefore pools together instead of grouping per
     repository. That is the honest degrade until the slug walk learns drive
     roots; the README says so. */
  const repo = path.join(SANDBOX, "windows-scratchpad-repository");
  createRepository(repo);
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  // A Windows slug opens with a drive letter, and the slug walk starts at the
  // POSIX root, which is precisely why it recovers nothing.
  expect(slug.startsWith("-")).toBe(false);
  expect(slug).toMatch(/^[A-Za-z]--/);
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad", "probes");

  expect(fs.existsSync(dead)).toBe(false);
  expect(projectInfoFromCwd(dead)).toMatchObject({ unresolved: true });
  expect(projectRootForCwd(dead)).toBeUndefined();
  expect(projectForCwd(dead)).not.toBe(projectForCwd(repo));
  // Still stable across reads, which is the part that must not regress.
  expect(projectForCwd(dead)).toBe(projectForCwd(dead));
});

test.if(WINDOWS_ONLY)("a Windows worktree slug still names its worktree", () => {
  /* `worktreeFromSlug` is pure string work over the encoded `--worktrees-`
     marker, so it keeps working; only the repository-path recovery beneath it
     goes away. */
  const repo = path.join(SANDBOX, "windows-scratchpad-worktree-repo");
  createRepository(repo);
  const worktree = path.join(repo, ".worktrees", "runtime-host-spike");
  const slug = worktree.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, slug, "deleted-session", "scratchpad", "probes");

  expect(projectInfoFromCwd(dead)?.worktree).toBe("runtime-host-spike");
  expect(projectRootForCwd(dead)).toBeUndefined();
});

test("a deleted nested worktree (repo/worktrees/<name>) still groups under its parent repo", () => {
  /* `git worktree add worktrees/foo` and the dotted `.worktrees/foo` nest the
     checkout inside the repo, so the repo is the path prefix — recognizable by
     path even after the checkout is deleted, no on-disk `.git` required. */
  const repo = path.join(SANDBOX, "deleted-nested-worktree-main");
  const identity = createRepository(repo);
  const nested = path.join(repo, "worktrees", "memory-ui-redesign");
  const nestedDotted = path.join(repo, ".worktrees", "some-branch");
  // worktree of a worktree
  const deepNested = path.join(repo, "worktrees", "issue-1424", "worktrees", "pr-tools");
  expect(fs.existsSync(nested)).toBe(false);
  expect(projectForCwd(nested)).toBe(projectForCwd(repo));
  expect(projectForCwd(nestedDotted)).toBe(projectForCwd(repo));
  expect(projectForCwd(deepNested)).toBe(projectForCwd(repo));
  expect(projectForCwd(nested)).toBe(identity.project);
  expect(projectInfoFromCwd(nested)?.worktree).toBe("memory-ui-redesign");
});

test("conversation metadata carries the exact cwd and its canonical project root", () => {
  const repo = path.join(SANDBOX, "cwd-project");
  const cwd = path.join(repo, ".worktrees", "issue-173");
  const root = path.join(SANDBOX, "cwd-transcripts");
  const transcript = path.join(root, "cwd-project", "session.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd, message: { content: "Prefill cwd" } }) + "\n");

  expect(describe("claude-projects", root, transcript, fs.statSync(transcript))).toMatchObject({
    cwd,
    projectRoot: repo,
  });
});

test("conversation metadata marks an unresolved deleted scratchpad root explicitly", () => {
  const missingSlug = path.join(SANDBOX, "removed-external-repo").replace(/[^a-zA-Z0-9]/g, "-");
  const cwd = path.join(os.tmpdir(), CLAUDE_TASK_CONTAINER, missingSlug, "deleted-session", "scratchpad");
  const root = path.join(SANDBOX, "unresolved-scratchpad-transcripts");
  const transcript = path.join(root, "removed-external-repo", "session.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd, message: { content: "Prefill cwd" } }) + "\n");

  expect(fs.existsSync(cwd)).toBe(false);
  expect(describe("claude-projects", root, transcript, fs.statSync(transcript))).toMatchObject({ cwd, projectRoot: null });
});

test("growing Codex transcripts retain cwd metadata after the project cache warms", () => {
  const repo = path.join(SANDBOX, "codex-cwd-project");
  const cwd = path.join(repo, ".worktrees", "issue-174");
  const root = path.join(SANDBOX, "codex-cwd-transcripts");
  const transcript = path.join(root, "2026", "07", "rollout-cwd.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");

  expect(describe("codex-sessions", root, transcript, fs.statSync(transcript))).toMatchObject({ cwd, projectRoot: repo });
  fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "continue" } }) + "\n");
  expect(describe("codex-sessions", root, transcript, fs.statSync(transcript))).toMatchObject({ cwd, projectRoot: repo });
});

test("a project-state change recomputes only the overlay, never transcript metadata (#287)", () => {
  const base = path.join(SANDBOX, "identity-split");
  const state = path.join(base, "state");
  fs.mkdirSync(state, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const repo = path.join(base, "live-log-viewer-next");
  createRepository(repo);
  const worktree = path.join(base, "live-log-viewer-split-branch");
  const root = path.join(base, "codex-root");
  const transcript = path.join(root, "2026", "07", "rollout-split.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { cwd: worktree } }) + "\n");
  const st = fs.statSync(transcript);

  /* The checkout does not exist yet: without repository evidence the cwd is
     held in the visible unresolved group. */
  const before = describe("codex-sessions", root, transcript, st, "state-a");
  expect(before.cwd).toBe(worktree);
  expect(before.worktree).toBeUndefined();

  // The checkout appears (reconciliation would rewrite the project state and
  // change the resolution state key with it).
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "live-log-viewer-split-branch"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "live-log-viewer-split-branch", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(repo, ".git", "worktrees", "live-log-viewer-split-branch")}\n`,
  );

  /* The cwd-resolution and .git-pointer memos hold the unresolved lookup for
     10–60 s in production; expire them so the overlay recompute sees the live
     checkout the way a later scan generation would. */
  globalCache("project-info-cwd-v2").clear();
  globalCache("worktree-git").clear();

  /* The overlay recomputes under the new state key without touching the
     transcript bytes: metadata is keyed by file identity alone. */
  const realOpenSync = fs.openSync;
  const realReadFileSync = fs.readFileSync;
  let transcriptReads = 0;
  const countTranscript = (target: fs.PathOrFileDescriptor | fs.PathLike) => {
    if (String(target) === transcript) transcriptReads += 1;
  };
  fs.openSync = ((target: fs.PathLike, ...rest: [number | string, (fs.Mode | null)?]) => {
    countTranscript(target);
    return realOpenSync(target, ...rest);
  }) as typeof fs.openSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    countTranscript(target);
    return (realReadFileSync as (...args: unknown[]) => ReturnType<typeof fs.readFileSync>)(target, ...rest);
  }) as typeof fs.readFileSync;
  let after;
  try {
    after = describe("codex-sessions", root, transcript, st, "state-b");
  } finally {
    fs.openSync = realOpenSync;
    fs.readFileSync = realReadFileSync;
  }
  expect(transcriptReads).toBe(0);
  expect(after.cwd).toBe(worktree);
  expect(after.title).toBe(before.title);
  expect(projectForCwd(repo)).toBe(after.project);
  expect(after.worktree).toBe("live-log-viewer-split-branch");
});

test("a nested `worktrees` segment under .claude/.codex is left to its own recognizer", () => {
  const state = useStateDirectory("nested-recognizer-state");
  const identity = createRepository(path.join(SANDBOX, "nested-recognizer-main"));
  expect(persistProjectAliases([
    { source: "shared-repository", target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const codex = path.join(state, ".codex", "worktrees", "2d25", "shared-repository");
  expect(projectForCwd(codex)).toBe(identity.project);
});

test("a wrong-HOME durable mapping is corrected by repository evidence after worktree deletion", () => {
  /* `git worktree add ../live-log-viewer-workflows` has no recognizable path
     layout, so once deleted only a resolution recorded while it was alive ties
     it back to the main repo. Live checkout → `.git` pointer is read AND
     remembered; delete it → the remembered map keeps the same project name. */
  const base = path.join(SANDBOX, "wt-del"); // isolated so cwd keys don't collide with other tests
  const state = path.join(base, "state");
  process.env.LLV_STATE_DIR = state;
  fs.mkdirSync(state, { recursive: true });
  const repo = path.join(base, "live-log-viewer-next");
  const identity = createRepository(repo);
  const worktree = path.join(base, "live-log-viewer-branchx");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "live-log-viewer-branchx"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "live-log-viewer-branchx", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(repo, ".git", "worktrees", "live-log-viewer-branchx")}\n`,
  );
  fs.writeFileSync(path.join(state, "flows.json"), JSON.stringify({
    flows: [{
      project: "-wrong-home-shared-repository",
      cwd: worktree,
      implementerPath: path.join(base, "missing-transcript.jsonl"),
      rounds: [],
    }],
  }));

  const live = projectForCwd(worktree);
  expect(live).toBe(identity.project);
  persistWorktreeMap();

  fs.rmSync(worktree, { recursive: true, force: true });
  globalCache("worktree-git").clear();
  globalCache("project-info-cwd-v2").clear();
  /* Drop the in-memory map by rebinding to a different state dir, then back —
     the second lookup must reload the resolution from disk, proving it
     survives a process restart, not just an in-memory cache. */
  const other = path.join(base, "wt-map-other");
  fs.mkdirSync(other, { recursive: true });
  process.env.LLV_STATE_DIR = other;
  projectForCwd(worktree);
  process.env.LLV_STATE_DIR = state;
  expect(projectForCwd(worktree)).toBe(live);
});

test("a pre-change slug follows its repository alias", () => {
  useStateDirectory("slug-alias-state");
  const identity = createRepository(path.join(SANDBOX, "slug-alias-main"));
  const legacy = "-legacy-root-shared-repository";
  expect(persistProjectAliases([
    { source: legacy, target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  expect(projectFromSlug(legacy)).toBe(identity.project);
});

test("stale flow cwd keeps a removed sibling worktree under its saved project", () => {
  const state = useStateDirectory("stale-flow-state");
  const cwd = path.join(SANDBOX, "live-log-viewer-workflows");
  const identity = createRepository(path.join(SANDBOX, "stale-flow-main"));
  const project = "-legacy-root-shared-repository";
  expect(persistProjectAliases([
    { source: project, target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const root = path.join(SANDBOX, "claude-projects");
  const slug = "-home-latand--agents-tools-live-log-viewer-workflows";
  const transcript = path.join(root, slug, "session.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "flows.json"),
    JSON.stringify({
      flows: [
        {
          project,
          cwd,
          implementerPath: transcript,
          rounds: [],
        },
      ],
    }),
  );
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "user", cwd, message: { content: "Investigate grouping" } }) + "\n",
  );

  const meta = describe("claude-projects", root, transcript, fs.statSync(transcript));
  expect(meta.project).toBe(identity.project);
  expect(meta.worktree).toBe("live-log-viewer-workflows");
});

test("stale flow slug keeps orphan background tasks under the saved project", () => {
  const state = useStateDirectory("task-state");
  const cwd = path.join(SANDBOX, "live-log-viewer-workflows");
  const identity = createRepository(path.join(SANDBOX, "stale-task-main"));
  const project = "-legacy-root-shared-repository";
  expect(persistProjectAliases([
    { source: project, target: identity.project, displayName: identity.displayName },
  ])).toBe(true);
  const slug = "-home-latand--agents-tools-live-log-viewer-workflows";
  const transcript = path.join(os.homedir(), ".claude", "projects", slug, "session.jsonl");
  const root = path.join(SANDBOX, "claude-1000");
  const task = path.join(root, slug, "session", "tasks", "abc.output");
  fs.mkdirSync(path.dirname(task), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "flows.json"),
    JSON.stringify({
      flows: [
        {
          project,
          cwd,
          implementerPath: transcript,
          rounds: [],
        },
      ],
    }),
  );
  fs.writeFileSync(task, "done\n");

  const meta = describe("claude-tasks", root, task, fs.statSync(task));
  expect(meta.project).toBe(identity.project);
  expect(meta.worktree).toBe("live-log-viewer-workflows");
});

test("conversation prompts stay in the search-only metadata path", () => {
  const root = path.join(SANDBOX, "codex-first-prompt");
  const transcript = path.join(root, "session.jsonl");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "Investigate cobalt orchard" },
  }) + "\n");

  const stat = fs.statSync(transcript);
  expect(describe("codex-sessions", root, transcript, stat)).toEqual(expect.objectContaining({
    title: "Investigate cobalt orchard",
  }));
  expect(searchTextForTranscript(transcript, stat.size, "codex")).toEqual({
    title: "Investigate cobalt orchard",
    firstPrompt: "Investigate cobalt orchard",
  });
});

test("a Codex description carries the provider-fork source from the first session_meta row (#708)", () => {
  const sourceId = "019f9557-0000-\x37000-8000-00000000aaaa";
  const forkId = "019f9c11-0000-\x37000-8000-00000000bbbb";
  const root = path.join(SANDBOX, "codex-fork-metadata");
  const fork = path.join(root, `rollout-${forkId}.jsonl`);
  const plain = path.join(root, `rollout-${sourceId}.jsonl`);
  fs.mkdirSync(root, { recursive: true });
  /* A fork is a full snapshot: its own header comes first and the source
     conversation's replayed `session_meta` follows. The description must report
     row one, or migration reconciliation loses the edge back to the source. */
  fs.writeFileSync(fork, [
    JSON.stringify({ type: "session_meta", payload: { id: forkId, forked_from_id: sourceId, cwd: "/repo/fork-metadata" } }),
    JSON.stringify({ type: "session_meta", payload: { id: sourceId, cwd: "/repo/fork-metadata" } }),
    "",
  ].join("\n"));
  fs.writeFileSync(plain, JSON.stringify({ type: "session_meta", payload: { id: sourceId, cwd: "/repo/fork-metadata" } }) + "\n");

  expect(describe("codex-sessions", root, fork, fs.statSync(fork))).toMatchObject({
    nativeForkSourceThreadId: sourceId,
    nativeParentThreadId: null,
  });
  /* An ordinary rollout reports a resolved absence, never an absent field: a
     consumer distinguishes "read, no fork" from "nobody has read this yet". */
  expect(describe("codex-sessions", root, plain, fs.statSync(plain)).nativeForkSourceThreadId).toBeNull();
});

/* ── OpenClaw (#1207) ──────────────────────────────────────────────────────
   Every identifier below is invented; no OpenClaw record was copied. */

const OPENCLAW_STATE = path.join(SANDBOX, "openclaw-state");

function openclawTranscript(name: string, cwd: string, prompt: string): string {
  const sessions = path.join(OPENCLAW_STATE, "agents", "primary", "sessions");
  const transcript = path.join(sessions, name);
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "session", version: 3, id: "oc-header-" + name, timestamp: "2026-08-27T09:00:00.000Z", cwd }),
    JSON.stringify({
      type: "message",
      id: "oc-user-1",
      parentId: null,
      timestamp: "2026-08-27T09:00:01.000Z",
      message: { role: "user", content: prompt, timestamp: "2026-08-27T09:00:01.000Z" },
    }),
  ].join("\n") + "\n");
  return transcript;
}

function withOpenclawStateDir<T>(state: string, run: () => T): T {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = state;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
}

test("an OpenClaw transcript is titled and searched by its first prompt", () => {
  const workspace = path.join(OPENCLAW_STATE, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const transcript = openclawTranscript("oc-session-title.jsonl", workspace, "Draft the cobalt orchard note");
  const root = path.dirname(transcript);
  const stat = fs.statSync(transcript);

  withOpenclawStateDir(OPENCLAW_STATE, () => {
    expect(describe("openclaw-sessions", root, transcript, stat)).toMatchObject({
      title: "Draft the cobalt orchard note",
      engine: "openclaw",
      fmt: "openclaw",
      kind: "session",
      cwd: workspace,
      sessionStartedAt: "2026-08-27T09:00:00.000Z",
    });
  });
  expect(searchTextForTranscript(transcript, stat.size, "openclaw")).toEqual({
    title: "Draft the cobalt orchard note",
    firstPrompt: "Draft the cobalt orchard note",
  });
});

/* The invariant AGENTS.md names: the workspace is itself a remote-less git
   repository, so the ordinary resolvers would mint `repo-…` while it exists and
   `dir-…` once it is gone, fragmenting every channel-bound session at once. The
   fixture is reached through a symlink so a `realpathSync` regression — which
   resolves while the path exists and stops once it does not — fails the case. */
test("the OpenClaw workspace keeps one project identity before and after deletion", () => {
  useStateDirectory("openclaw-workspace-identity");
  const state = path.join(SANDBOX, "openclaw-deletion", "real-state");
  const link = path.join(SANDBOX, "openclaw-deletion", "linked-state");
  const workspace = path.join(link, "workspace");
  fs.mkdirSync(path.join(state, "workspace", ".git"), { recursive: true });
  fs.symlinkSync(state, link);
  /* The measured workspace is a real git repository with no `origin`, which is
     exactly the shape that mints `repo-…` alive and `dir-…` once deleted. */
  fs.writeFileSync(path.join(state, "workspace", ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(state, "workspace", ".git", "config"), "[core]\n\tbare = false\n");

  const alive = withOpenclawStateDir(link, () => projectInfoFromCwd(workspace, "openclaw-alive"));
  expect(alive).toEqual({ project: expect.stringMatching(/^dir-[0-9a-f]{32}$/), displayName: "OpenClaw" });
  expect(withOpenclawStateDir(link, () => projectRootForCwd(workspace))).toBeUndefined();

  fs.rmSync(state, { recursive: true, force: true });
  /* A directory symlink on Windows is removed with rmdir, not unlink; Bun's
     `rm` answers EFAULT for one. The recogniser under test is platform-neutral,
     so only its teardown forks. */
  if (WINDOWS_ONLY) fs.rmdirSync(link);
  else fs.rmSync(link, { force: true });
  expect(fs.existsSync(workspace)).toBe(false);

  const dead = withOpenclawStateDir(link, () => projectInfoFromCwd(workspace, "openclaw-dead"));
  expect(dead).toEqual(alive!);
});

test("a repository nested under the OpenClaw workspace keeps repository attribution", () => {
  useStateDirectory("openclaw-nested-repository");
  const state = path.join(SANDBOX, "openclaw-nested", "state");
  const workspace = path.join(state, "workspace");
  const nested = path.join(workspace, "checkout");
  fs.mkdirSync(nested, { recursive: true });
  const identity = createRepository(nested, "ssh://git@example.invalid/team/openclaw-nested.git");

  withOpenclawStateDir(state, () => {
    expect(projectInfoFromCwd(nested, "openclaw-nested")).toMatchObject({ project: identity.project });
    expect(projectForCwd(workspace)).toMatch(/^dir-[0-9a-f]{32}$/);
  });
});

test("the OpenClaw overlay routes a transcript's workspace cwd through the recognizer", () => {
  useStateDirectory("openclaw-overlay");
  const state = path.join(SANDBOX, "openclaw-overlay-state");
  const workspace = path.join(state, "workspace");
  const sessions = path.join(state, "agents", "primary", "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, "oc-session-overlay.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({
    type: "session",
    version: 3,
    id: "oc-header-overlay",
    timestamp: "2026-08-27T09:00:00.000Z",
    cwd: workspace,
  }) + "\n");

  withOpenclawStateDir(state, () => {
    expect(describe("openclaw-sessions", sessions, transcript, fs.statSync(transcript), "openclaw-overlay")).toMatchObject({
      project: projectForCwd(workspace)!,
      projectName: "OpenClaw",
      projectRoot: null,
    });
  });
});

test("a workspace directory outside any OpenClaw state directory is not recognized", () => {
  useStateDirectory("openclaw-foreign-workspace");
  const foreign = path.join(SANDBOX, "not-openclaw", "workspace");
  fs.mkdirSync(foreign, { recursive: true });
  const info = withOpenclawStateDir(path.join(SANDBOX, "openclaw-elsewhere"), () =>
    projectInfoFromCwd(foreign, "openclaw-foreign"));
  expect(info).toMatchObject({ displayName: "workspace" });
});

function writeGrokSession(cwd: string, sessionId: string, lines: unknown[], summary?: Record<string, unknown>) {
  const encoded = encodeURIComponent(cwd);
  const dir = path.join(SANDBOX, "grok-sessions", encoded, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  if (summary) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
  return transcript;
}

test("a Grok chat history is its own engine and takes the generated title from summary.json", () => {
  useStateDirectory("grok-summary-title");
  const repo = path.join(SANDBOX, "grok-summary-repository");
  const identity = createRepository(repo);
  const transcript = writeGrokSession(repo, "session-alpha", [
    { type: "user", content: [{ type: "text", text: "<user_query>\nInspect the orchard\n</user_query>" }] },
  ], {
    generated_title: "Orchard inspection",
    created_at: "2026-08-27T09:00:00.000Z",
    reasoning_effort: "high",
  });
  expect(describe("grok-sessions", path.join(SANDBOX, "grok-sessions"), transcript, fs.statSync(transcript))).toMatchObject({
    engine: "grok",
    fmt: "grok",
    kind: "session",
    title: "Orchard inspection",
    sessionStartedAt: "2026-08-27T09:00:00.000Z",
    project: identity.project,
    projectName: identity.displayName,
    cwd: repo,
  });
});

test("a Grok session without summary.json titles from the operator user_query", () => {
  useStateDirectory("grok-query-title");
  const cwd = path.join(SANDBOX, "grok-query-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const transcript = writeGrokSession(cwd, "session-beta", [
    { type: "user", content: [{ type: "text", text: "<user_info>\nskipped</user_info>" }], synthetic_reason: "system_reminder" },
    { type: "user", content: [{ type: "text", text: "<user_query>\nPlant the cobalt orchard\n</user_query>" }] },
  ]);
  expect(describe("grok-sessions", path.join(SANDBOX, "grok-sessions"), transcript, fs.statSync(transcript))).toMatchObject({
    engine: "grok",
    title: "Plant the cobalt orchard",
    cwd,
  });
});
