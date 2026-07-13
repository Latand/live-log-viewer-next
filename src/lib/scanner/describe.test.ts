import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { describe, parseWorktreeGitdir, persistWorktreeMap, projectForCwd, projectFromSlug, searchTextForTranscript } from "./describe";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-describe-test-"));
const REAL_STATE = process.env.LLV_STATE_DIR;

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("parseWorktreeGitdir resolves an absolute gitdir into repo + worktree name", () => {
  const info = parseWorktreeGitdir(
    "/home/u/.agents/tools/live-log-viewer-attention-queue",
    "gitdir: /home/u/.agents/tools/live-log-viewer-next/.git/worktrees/live-log-viewer-attention-queue\n",
  );
  expect(info).toEqual({
    repo: "/home/u/.agents/tools/live-log-viewer-next",
    worktree: "live-log-viewer-attention-queue",
  });
});

test("parseWorktreeGitdir resolves a relative gitdir against the checkout cwd", () => {
  const info = parseWorktreeGitdir("/home/u/wt", "gitdir: ../main/.git/worktrees/wt");
  expect(info).toEqual({ repo: "/home/u/main", worktree: "wt" });
});

test("parseWorktreeGitdir rejects gitdirs that are not linked worktrees", () => {
  expect(parseWorktreeGitdir("/home/u/sub", "gitdir: /home/u/main/.git")).toBeNull();
  expect(parseWorktreeGitdir("/home/u/sub", "not a git file")).toBeNull();
  /* "worktrees" segment without a .git parent is another repo layout, not a linked checkout */
  expect(parseWorktreeGitdir("/home/u/sub", "gitdir: /home/u/worktrees/x")).toBeNull();
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
  /* Codex removes `~/.codex/worktrees/<hash>/<Repo>` after the task, so the
     on-disk `.git` pointer is gone — a path with no filesystem presence must
     still resolve to the repo name a live checkout of the same repo produces. */
  const dead = path.join(os.homedir(), ".codex", "worktrees", "2d25", "CelestiaCompose");
  const liveRepo = path.join(os.homedir(), "Projects", "CelestiaCompose");
  expect(projectForCwd(dead)).toBe("CelestiaCompose");
  expect(projectForCwd(dead)).toBe(projectForCwd(liveRepo));
});

test("a deleted nested checkout inside a Codex worktree groups under the main repo", () => {
  const dead = path.join(
    os.homedir(),
    ".codex",
    "worktrees",
    "deleted-catalog-fixture",
    "CelestiaCompose",
    "worktrees",
    "deleted-child",
  );
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe("CelestiaCompose");
});

test("a deleted worktree scratchpad cwd groups under the encoded parent repo", () => {
  const repo = path.join(os.homedir(), ".agents", "tools", "live-log-viewer-next");
  const worktree = path.join(repo, ".worktrees", "runtime-host-spike");
  const slug = worktree.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 1000}`, slug, "deleted-session", "scratchpad", "probes");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
});

test("a main-checkout scratchpad cwd groups under its encoded project", () => {
  const repo = path.join(os.homedir(), ".agents", "tools", "live-log-viewer-next");
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 1000}`, slug, "deleted-session", "scratchpad", "probes");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
});

test("the outer nested worktree wins over a later specialized container", () => {
  const repo = path.join(SANDBOX, "outer-repo");
  const dead = path.join(repo, "worktrees", "outer", ".codex", "worktrees", "inner-hash", "InnerRepo");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe(projectForCwd(repo));
});

test("a scratchpad encoded from nested worktrees keeps the outer project", () => {
  const repo = path.join(os.homedir(), ".agents", "tools", "live-log-viewer-next");
  const nested = path.join(repo, ".worktrees", "outer", ".claude", "worktrees", "inner");
  const slug = nested.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 1000}`, slug, "deleted-session", "scratchpad");
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

test("a scratchpad encoded from a deleted Codex worktree keeps the repo project", () => {
  const codexWorktree = path.join(
    os.homedir(),
    ".codex",
    "worktrees",
    "2d25",
    "CelestiaCompose",
    "worktrees",
    "inner",
  );
  const slug = codexWorktree.replace(/[^a-zA-Z0-9]/g, "-");
  const dead = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 1000}`, slug, "deleted-session", "scratchpad");
  expect(fs.existsSync(dead)).toBe(false);
  expect(projectForCwd(dead)).toBe("CelestiaCompose");
});

test("a deleted nested worktree (repo/worktrees/<name>) still groups under its parent repo", () => {
  /* `git worktree add worktrees/foo` and the dotted `.worktrees/foo` nest the
     checkout inside the repo, so the repo is the path prefix — recognizable by
     path even after the checkout is deleted, no on-disk `.git` required. */
  const repo = `${os.homedir()}/Projects/CelestiaCompose`;
  const nested = `${repo}/worktrees/memory-ui-redesign`;
  const nestedDotted = `${repo}/.worktrees/some-branch`;
  const deepNested = `${repo}/worktrees/issue-1424/worktrees/pr-tools`; // worktree of a worktree
  expect(projectForCwd(nested)).toBe(projectForCwd(repo));
  expect(projectForCwd(nestedDotted)).toBe(projectForCwd(repo));
  expect(projectForCwd(deepNested)).toBe(projectForCwd(repo));
  expect(projectForCwd(nested)).toBe("CelestiaCompose");
});

test("a nested `worktrees` segment under .claude/.codex is left to its own recognizer", () => {
  /* `.codex/worktrees/<hash>/<Repo>` must resolve via the codex recognizer to
     the repo name, not be mis-read as a repo ending in `.codex`. */
  const codex = `${os.homedir()}/.codex/worktrees/2d25/CelestiaCompose`;
  expect(projectForCwd(codex)).toBe("CelestiaCompose");
});

test("a deleted arbitrary-path git worktree still groups under its parent repo project", () => {
  /* `git worktree add ../live-log-viewer-workflows` has no recognizable path
     layout, so once deleted only a resolution recorded while it was alive ties
     it back to the main repo. Live checkout → `.git` pointer is read AND
     remembered; delete it → the remembered map keeps the same project name. */
  const base = path.join(SANDBOX, "wt-del"); // isolated so cwd keys don't collide with other tests
  const state = path.join(base, "state");
  process.env.LLV_STATE_DIR = state;
  fs.mkdirSync(state, { recursive: true });
  const repo = path.join(base, "live-log-viewer-next");
  const worktree = path.join(base, "live-log-viewer-branchx");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "live-log-viewer-branchx"), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(repo, ".git", "worktrees", "live-log-viewer-branchx")}\n`,
  );

  const live = projectForCwd(worktree);
  expect(live).toBe(projectForCwd(repo));
  persistWorktreeMap();

  fs.rmSync(worktree, { recursive: true, force: true });
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

test("a worktree's main repo slugifies to the same project name its own sessions use", () => {
  const repo = `${os.homedir()}/.agents/tools/live-log-viewer-next`;
  const slugOfRepo = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const slugFromClaudeDir = "-" + os.homedir().split("/").filter(Boolean).join("-") + "--agents-tools-live-log-viewer-next";
  expect(slugOfRepo).toBe(slugFromClaudeDir);
  expect(projectFromSlug(slugOfRepo)).toBe("-agents-tools-live-log-viewer-next");
});

test("stale flow cwd keeps a removed sibling worktree under its saved project", () => {
  const state = path.join(SANDBOX, "state");
  process.env.LLV_STATE_DIR = state;
  const cwd = path.join(SANDBOX, "live-log-viewer-workflows");
  const project = "-agents-tools-live-log-viewer-next";
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
  expect(meta.project).toBe(project);
  expect(meta.worktree).toBe("live-log-viewer-workflows");
});

test("stale flow slug keeps orphan background tasks under the saved project", () => {
  const state = path.join(SANDBOX, "task-state");
  process.env.LLV_STATE_DIR = state;
  const cwd = path.join(SANDBOX, "live-log-viewer-workflows");
  const project = "-agents-tools-live-log-viewer-next";
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
  expect(meta.project).toBe(project);
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
