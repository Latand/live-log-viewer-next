import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commitPipelineStage, provisionPipelineWorktree, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
import type { Pipeline } from "./types";
import { realExec, type ExecPort } from "@/lib/workflows/provision";

function pipeline(): Pipeline {
  return {
    id: "12345678", task: "task", taskIds: [], project: "viewer", repoDir: "/repo", worktreeDir: "/repo-pipeline-12345678",
    branch: "pipeline/task-12345678", baseBranch: "", baseRef: "", lastPassedCommit: "base",
    stages: [], runs: [], cursor: null, state: "running", pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: "now", closedAt: null,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = realExec("git", args, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("a real stale dirty checkout provisions from the freshly fetched origin/main tip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-base-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const source = path.join(root, "source");
  try {
    fs.mkdirSync(seed);
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(seed, "init", "--initial-branch=main");
    git(seed, "config", "user.email", "pipeline-test@example.com");
    git(seed, "config", "user.name", "Pipeline Test");
    git(seed, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(seed, "tracked.txt"), "old\n");
    git(seed, "add", "tracked.txt");
    git(seed, "commit", "-m", "old base");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "main");
    git(root, "clone", origin, source);
    const staleHead = git(source, "rev-parse", "HEAD");

    fs.writeFileSync(path.join(seed, "tracked.txt"), "new\n");
    git(seed, "commit", "-am", "advance main");
    git(seed, "push", "origin", "main");
    const currentMain = git(seed, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(source, "dirty.txt"), "preserve me\n");

    const subject = pipeline();
    subject.repoDir = source;
    subject.worktreeDir = path.join(root, "source-pipeline-12345678");
    const resolved = resolvePipelineBase(source, {}, realExec);
    expect(resolved).toEqual({ ok: true, baseBranch: "main", baseRef: currentMain });
    if (!resolved.ok) throw new Error(resolved.error);
    subject.baseBranch = resolved.baseBranch;
    subject.baseRef = resolved.baseRef;
    subject.lastPassedCommit = resolved.baseRef;

    expect(provisionPipelineWorktree(subject, realExec)).toEqual({ ok: true, sha: currentMain, baseBranch: "main" });
    expect(git(subject.worktreeDir, "rev-parse", "HEAD")).toBe(currentMain);
    expect(git(source, "rev-parse", "HEAD")).toBe(staleHead);
    expect(git(source, "status", "--porcelain")).toBe("?? dirty.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default base fetches and resolves origin/main without inspecting a dirty stale checkout", () => {
  const calls: string[] = [];
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse") return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(resolvePipelineBase("/repo", {}, exec)).toEqual({ ok: true, baseBranch: "main", baseRef: expectedBase });
  expect(calls).toEqual([
    "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    "git rev-parse --verify --end-of-options origin/main^{commit}",
  ]);
});

test("an explicit base resolves to an exact SHA without fetching", () => {
  const calls: string[] = [];
  const expectedBase = "1234567890abcdef1234567890abcdef12345678";
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
  };

  expect(resolvePipelineBase("/repo", { baseBranch: "release", baseRef: "release-candidate" }, exec))
    .toEqual({ ok: true, baseBranch: "release", baseRef: expectedBase });
  expect(calls).toEqual(["git rev-parse --verify --end-of-options release-candidate^{commit}"]);
});

test("an unavailable origin fails base resolution before worktree provisioning", () => {
  const exec: ExecPort = () => ({ code: 128, stdout: "", stderr: "could not read from remote" });

  expect(resolvePipelineBase("/repo", {}, exec)).toEqual({
    ok: false,
    error: "fetching origin/main: could not read from remote",
  });
});

test("an unsafe base branch is rejected before git receives it", () => {
  let calls = 0;
  const exec: ExecPort = () => {
    calls += 1;
    return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  };

  expect(resolvePipelineBase("/repo", { baseBranch: "../escaped" }, exec)).toEqual({
    ok: false,
    error: "the pipeline base branch is invalid",
  });
  expect(calls).toBe(0);
});

test("worktree provision uses the persisted exact base without reading a detached source HEAD", () => {
  const calls: string[] = [];
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const subject = pipeline();
  subject.baseBranch = "main";
  subject.baseRef = expectedBase;
  subject.lastPassedCommit = expectedBase;
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "HEAD\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(provisionPipelineWorktree(subject, exec)).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });
  expect(calls).toContain(`git worktree add -b pipeline/task-12345678 /repo-pipeline-12345678 ${expectedBase}`);
  expect(calls).not.toContain("git rev-parse --abbrev-ref HEAD");
});

test("worktree provision recovers an existing branch only at the persisted exact base", () => {
  const expectedBase = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
  const subject = pipeline();
  subject.baseBranch = "main";
  subject.baseRef = expectedBase;
  subject.lastPassedCommit = expectedBase;
  const exec: ExecPort = (_command, args) => {
    if (args[0] === "worktree") return { code: 128, stdout: "", stderr: "already exists" };
    if (args[1] === "--abbrev-ref") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    return { code: 0, stdout: `${expectedBase}\n`, stderr: "" };
  };

  expect(provisionPipelineWorktree(subject, exec)).toEqual({ ok: true, sha: expectedBase, baseBranch: "main" });

  const wrongHead: ExecPort = (_command, args) => {
    if (args[0] === "worktree") return { code: 128, stdout: "", stderr: "already exists" };
    if (args[1] === "--abbrev-ref") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" };
  };
  expect(provisionPipelineWorktree(subject, wrongHead)).toEqual({
    ok: false,
    error: "the pipeline worktree does not match its persisted base",
  });
});
test("pass commits a dirty stage and retry resets plus cleans", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: " M src/x.ts\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "stage-sha\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(commitPipelineStage(pipeline(), "build", true, exec)).toEqual({ ok: true, sha: "stage-sha" });
  expect(resetPipelineStage(pipeline(), exec)).toEqual({ ok: true, sha: "base" });
  expect(calls).toContain("git add -A");
  expect(calls).toContain("git reset --hard base");
  expect(calls).toContain("git clean -fd");
});

test("review retry preserves a local additive repair that is ahead of origin (#522)", () => {
  const subject = pipeline();
  const remoteHead = "a".repeat(40);
  const localRepair = "b".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${remoteHead}\trefs/heads/${subject.branch}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${localRepair}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${remoteHead}\n`, stderr: "" };
    if (args[0] === "merge-base" && args[2] === remoteHead) return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(synchronizePipelineRetryHead(subject, exec)).toEqual({ ok: true, sha: localRepair });
  expect(calls.some((call) => call.startsWith("git merge --ff-only"))).toBe(false);
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
});
