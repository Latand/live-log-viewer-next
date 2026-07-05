import os from "node:os";

import { expect, test } from "bun:test";

import { parseWorktreeGitdir, projectFromSlug } from "./describe";

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
