import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { describe, parseWorktreeGitdir, projectFromSlug } from "./describe";

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
