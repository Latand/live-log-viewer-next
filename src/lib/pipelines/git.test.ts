import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commitPipelineStage, pipelineWorktreeChanges, provisionPipelineWorktree, publishPipelineBranch, resetPipelineStage, resolvePipelineBase, synchronizePipelineRetryHead } from "./git";
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

test("read-only stage records a declared report without granting source commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-output-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");

    expect(fs.readFileSync(path.join(root, "reports", "audit.md"), "utf8")).toBe("audited\n");
    const result = commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"]);
    expect(result.ok).toBeTrue();
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("reports/audit.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses source edits beside a declared report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-source-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 2;\n");

    expect(commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"])).toEqual({
      ok: false,
      error: "read-only stage audit modified undeclared worktree paths",
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(subject.lastPassedCommit);
    expect(git(root, "status", "--porcelain")).toContain("source.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only stage refuses an agent-created commit even when it contains only a declared report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-read-only-commit-"));
  try {
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "pipeline-test");
    git(root, "config", "user.name", "Pipeline Test");
    git(root, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "initial");

    const subject = pipeline();
    subject.worktreeDir = root;
    subject.lastPassedCommit = git(root, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "audit.md"), "audited\n");
    git(root, "add", "reports/audit.md");
    git(root, "commit", "-m", "agent commit");

    expect(commitPipelineStage(subject, "audit", false, realExec, ["reports/audit.md"])).toEqual({
      ok: false,
      error: "read-only stage audit created a commit",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("issue 533: manual review retry never resets clean remote 8232d71 to stale a88ddee", () => {
  const subject = pipeline();
  const synchronizedHead = "8232d71c8f1fb62f972d5f68163f15c244e0f358";
  subject.lastPassedCommit = "a88ddeeef4c2f173be867c775994997e22ab2c5b";
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${subject.branch}\n`, stderr: "" };
    if (args[0] === "ls-remote") return { code: 0, stdout: `${synchronizedHead}\trefs/heads/${subject.branch}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${synchronizedHead}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(synchronizePipelineRetryHead(subject, exec)).toEqual({ ok: true, sha: synchronizedHead });
  expect(calls.some((call) => call.includes("reset --hard"))).toBe(false);
  expect(calls.some((call) => call.startsWith("git merge "))).toBe(false);
});

test("a real dirty worktree reports its uncommitted paths and keeps every one of them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-close-"));
  const repo = path.join(root, "repo");
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.email", "pipeline-test@example.com");
    git(repo, "config", "user.name", "Pipeline Test");
    git(repo, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "renamed.txt"), "moved\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");

    fs.writeFileSync(path.join(repo, "tracked.txt"), "stage work in progress\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "never discard me\n");
    git(repo, "mv", "renamed.txt", "moved.txt");

    const subject = pipeline();
    subject.worktreeDir = repo;
    const changes = pipelineWorktreeChanges(subject, realExec);

    expect(changes).toEqual({ ok: true, paths: ["moved.txt", "tracked.txt", "untracked.txt"], truncated: false });
    /* Reading the worktree must never mutate it: the close preserves the work. */
    expect(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8")).toBe("never discard me\n");
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("stage work in progress\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree change reporting truncates long lists and surfaces an unreadable worktree", () => {
  const many: ExecPort = () => ({
    code: 0,
    stdout: Array.from({ length: 22 }, (_, index) => `?? file-${index}.txt`).join("\n"),
    stderr: "",
  });
  const reported = pipelineWorktreeChanges(pipeline(), many, 20);
  expect(reported).toMatchObject({ ok: true, truncated: true });
  expect(reported.ok && reported.paths).toHaveLength(20);

  const missing: ExecPort = () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  expect(pipelineWorktreeChanges(pipeline(), missing)).toEqual({
    ok: false,
    error: "checking the pipeline worktree: fatal: not a git repository",
  });
});

/* --- publishPipelineBranch (#729): the orchestrator owns publication ------- */

interface PublishSandbox {
  root: string;
  origin: string;
  repo: string;
  subject: Pipeline;
  commit: (name: string, body: string) => string;
  originHead: () => string;
}

function publishSandbox(withOrigin = true): PublishSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-publish-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "pipeline-test@example.com");
  git(repo, "config", "user.name", "Pipeline Test");
  git(repo, "config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  if (withOrigin) {
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
  }

  const subject = pipeline();
  subject.repoDir = repo;
  subject.worktreeDir = path.join(root, "repo-pipeline-12345678");
  subject.baseBranch = "main";
  subject.baseRef = git(repo, "rev-parse", "HEAD");
  subject.lastPassedCommit = subject.baseRef;
  const provisioned = provisionPipelineWorktree(subject, realExec);
  if (!provisioned.ok) throw new Error(provisioned.error);

  return {
    root,
    origin,
    repo,
    subject,
    commit: (name, body) => {
      fs.writeFileSync(path.join(subject.worktreeDir, name), body);
      git(subject.worktreeDir, "add", "-A");
      git(subject.worktreeDir, "commit", "-m", `stage ${name}`);
      return git(subject.worktreeDir, "rev-parse", "HEAD");
    },
    originHead: () => {
      const listed = git(subject.worktreeDir, "ls-remote", "--heads", "origin", `refs/heads/${subject.branch}`);
      return listed.split(/\s+/)[0] ?? "";
    },
  };
}

test("publishPipelineBranch pushes the passed commit and confirms origin carries it", () => {
  const box = publishSandbox();
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    expect(box.originHead()).toBe("");

    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "published" });
    expect(box.originHead()).toBe(passed);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch fast-forwards a branch it already published", () => {
  const box = publishSandbox();
  try {
    const first = box.commit("one.txt", "one\n");
    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: first })).toMatchObject({ ok: true, sha: first });
    const second = box.commit("two.txt", "two\n");

    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: second, publishedSha: first })).toEqual({ ok: true, sha: second, remote: "published" });
    expect(box.originHead()).toBe(second);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch refuses a diverged remote and leaves both revisions intact", () => {
  const box = publishSandbox();
  try {
    const shared = box.commit("shared.txt", "shared\n");
    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: shared })).toMatchObject({ ok: true, sha: shared });

    /* Someone else's repair lands on the remote branch; the local head does not
       contain it. Publishing it away would destroy that work. */
    const other = path.join(box.root, "other");
    git(box.root, "clone", "--branch", box.subject.branch, box.origin, other);
    git(other, "config", "user.email", "pipeline-test@example.com");
    git(other, "config", "user.name", "Pipeline Test");
    git(other, "config", "commit.gpgSign", "false");
    fs.writeFileSync(path.join(other, "repair.txt"), "remote repair\n");
    git(other, "add", "-A");
    git(other, "commit", "-m", "remote repair");
    git(other, "push", "origin", box.subject.branch);
    const remoteRepair = git(other, "rev-parse", "HEAD");

    const local = box.commit("local.txt", "local\n");
    const refused = publishPipelineBranch(box.subject, realExec, { acceptedSha: local, publishedSha: shared });

    expect(refused).toEqual({
      ok: false,
      error: "the local and remote pipeline branches diverged; choose which revision to publish before the review stage can start",
    });
    expect(box.originHead()).toBe(remoteRepair);
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(local);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch reports a repo with no origin as unavailable rather than a failure", () => {
  const box = publishSandbox(false);
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({ ok: true, sha: passed, remote: "unavailable" });
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publishPipelineBranch refuses a dirty worktree and preserves the uncommitted work", () => {
  const box = publishSandbox();
  try {
    const passed = box.commit("stage.txt", "stage work\n");
    fs.writeFileSync(path.join(box.subject.worktreeDir, "in-progress.txt"), "unfinished\n");

    expect(publishPipelineBranch(box.subject, realExec, { acceptedSha: passed })).toEqual({
      ok: false,
      error: "the pipeline worktree has uncommitted changes; choose whether to commit or discard them before retrying review",
    });
    expect(git(box.subject.worktreeDir, "status", "--porcelain")).toBe("?? in-progress.txt");
    expect(fs.readFileSync(path.join(box.subject.worktreeDir, "in-progress.txt"), "utf8")).toBe("unfinished\n");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a head already recorded as published costs no remote probe at all", () => {
  const head = "a".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: `${pipeline().branch}\n`, stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(publishPipelineBranch(pipeline(), exec, { acceptedSha: head, publishedSha: head })).toEqual({ ok: true, sha: head, remote: "published" });
  expect(calls.some((call) => call.includes("ls-remote"))).toBe(false);
  expect(calls.some((call) => call.includes("push"))).toBe(false);
  expect(calls.some((call) => call.includes("remote get-url"))).toBe(false);
});

test("an unreachable remote gets one time-bounded read per publication call (#999)", () => {
  const head = "a".repeat(40);
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "branch") return { code: 0, stdout: `${pipeline().branch}\n`, stderr: "" };
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (command === "git" && args[0] === "remote") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
    if (command === "timeout") return { code: 124, stdout: "", stderr: "" };
    return { code: 128, stdout: "", stderr: "remote read must be bounded" };
  };

  expect(publishPipelineBranch(pipeline(), exec, { acceptedSha: head })).toEqual({
    ok: true,
    sha: head,
    remote: "unreachable",
    detail: "checking the remote pipeline branch: git remote read timed out after 5s",
  });
  expect(calls.filter((call) => call.includes("ls-remote"))).toEqual([
    `timeout --signal=KILL 5s git ls-remote --heads origin refs/heads/${pipeline().branch}`,
  ]);
  expect(calls.some((call) => call.startsWith("sleep "))).toBe(false);
});

test("publication pushes only the immutable accepted revision when the branch advances mid-publish", () => {
  const box = publishSandbox();
  try {
    const accepted = box.commit("accepted.txt", "accepted\n");
    let racy: string | null = null;

    /* The branch advances in the window between the publisher capturing the
       accepted revision and the push running — here on the remote probe, which
       sits exactly in that window. Pushing `refs/heads/<branch>` would carry
       this unaccepted commit to origin and leave review fenced on a target that
       never passed; pushing the accepted object cannot. */
    const racing: ExecPort = (command, args, cwd) => {
      if (command === "timeout" && args.includes("ls-remote") && racy === null) {
        racy = box.commit("racy.txt", "never accepted\n");
      }
      return realExec(command, args, cwd);
    };

    const published = publishPipelineBranch(box.subject, racing, { acceptedSha: accepted });

    expect(racy).not.toBeNull();
    expect(racy).not.toBe(accepted);
    /* The local branch really did move on mid-publish ... */
    expect(git(box.subject.worktreeDir, "rev-parse", "HEAD")).toBe(racy!);
    /* ... and origin carries exactly the accepted revision, never the racy one. */
    expect(published).toEqual({ ok: true, sha: accepted, remote: "published" });
    expect(box.originHead()).toBe(accepted);
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("a worktree that has moved past the accepted revision publishes nothing", () => {
  const box = publishSandbox();
  try {
    const accepted = box.commit("accepted.txt", "accepted\n");
    const advanced = box.commit("later.txt", "later\n");

    const result = publishPipelineBranch(box.subject, realExec, { acceptedSha: accepted });

    expect(result).toEqual({
      ok: false,
      error: `the pipeline worktree is at ${advanced}, not the accepted revision ${accepted}; nothing was published`,
    });
    expect(box.originHead()).toBe("");
  } finally {
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test("publication refuses an accepted revision that is not an exact commit SHA", () => {
  const calls: string[] = [];
  const exec: ExecPort = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  };

  expect(publishPipelineBranch(pipeline(), exec, { acceptedSha: "HEAD" })).toEqual({
    ok: false,
    error: "the accepted pipeline revision is not an exact commit SHA: HEAD",
  });
  expect(calls).toEqual([]);
});
