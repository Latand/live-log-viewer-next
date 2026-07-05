import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-prov-test-"));
const { buildWorkflow, normalizeTemplate } = await import("./store");
const { finishMerge, finishPr, provisionWorktree, prTitle, realExec, setupStatus, startSetup } = await import("./provision");

type Workflow = import("./types").Workflow;
type ExecResult = import("./provision").ExecResult;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wf-prov-repo-"));

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const TEMPLATE = normalizeTemplate({
  name: "demo",
  setup: "true",
  stages: [
    { kind: "implement", agent: { engine: "codex", model: null, effort: "low" }, scope: "all" },
    { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: "low" } },
  ],
})!;

function makeWorkflow(repoDir: string, overrides: Partial<Workflow> = {}): Workflow {
  const wf = buildWorkflow({
    id: "wfid1234",
    name: "demo",
    task: "Add a greeting file",
    repoDir,
    template: TEMPLATE,
    mode: "auto",
    now: "2026-07-05T00:00:00.000Z",
  });
  return { ...wf, ...overrides };
}

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

/** Fake exec that records calls and answers from a script keyed by subcommand. */
function fakeExec(script: (call: Call) => ExecResult): { exec: (c: string, a: string[], d: string) => ExecResult; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: (command, args, cwd) => {
      const call = { command, args, cwd };
      calls.push(call);
      return script(call);
    },
  };
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

/** Throwaway real repo with one commit on branch main. */
function makeRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

test("provisionWorktree composes worktree add and captures base branch/ref", () => {
  const wf = makeWorkflow("/repo");
  const { exec, calls } = fakeExec((call) => {
    if (call.args[0] === "rev-parse" && call.args[1] === "--abbrev-ref") return ok("main\n");
    if (call.args[0] === "worktree") return ok();
    if (call.args[0] === "rev-parse") return ok("abc123\n");
    return fail("unexpected");
  });
  const res = provisionWorktree(wf, exec);
  if (!res.ok) throw new Error(res.error);
  expect(res.baseBranch).toBe("main");
  expect(res.baseRef).toBe("abc123");
  expect(calls[1]).toEqual({
    command: "git",
    args: ["worktree", "add", "-b", wf.branch, wf.worktreeDir, "HEAD"],
    cwd: "/repo",
  });
  expect(calls[2]?.cwd).toBe(wf.worktreeDir);
});

test("provisionWorktree maps a detached checkout to an error", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec(() => ok("HEAD\n"));
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("detached");
});

test("provisionWorktree adopts an already-created worktree on retry", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec((call) => {
    if (call.args[0] === "worktree") return fail(`fatal: '${wf.worktreeDir}' already exists`);
    if (call.args[1] === "--abbrev-ref") return ok(call.cwd === wf.worktreeDir ? wf.branch + "\n" : "main\n");
    return ok("abc123\n");
  });
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(true);
});

test("provisionWorktree surfaces the add error when nothing usable exists", () => {
  const wf = makeWorkflow("/repo");
  const { exec } = fakeExec((call) => {
    if (call.args[0] === "worktree") return fail("fatal: disk exploded");
    if (call.cwd === wf.worktreeDir) return fail("not a git repo");
    return ok("main\n");
  });
  const res = provisionWorktree(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("disk exploded");
});

test("finishPr pushes the branch then opens the PR against the base branch", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) =>
    call.command === "gh" ? ok("https://github.com/o/r/pull/7\n") : ok(),
  );
  const res = finishPr(wf, "PR BODY", exec);
  if (!res.ok) throw new Error(res.error);
  expect(res.prUrl).toBe("https://github.com/o/r/pull/7");
  expect(calls[0]).toEqual({ command: "git", args: ["push", "-u", "origin", wf.branch], cwd: wf.worktreeDir });
  expect(calls[1]).toEqual({
    command: "gh",
    args: ["pr", "create", "--title", prTitle(wf), "--body", "PR BODY", "--base", "main", "--head", wf.branch],
    cwd: wf.worktreeDir,
  });
});

test("finishPr recovers the URL of a PR that already exists", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec((call) => {
    if (call.command === "gh" && call.args[1] === "create") return fail("a pull request already exists");
    if (call.command === "gh" && call.args[1] === "view") return ok("https://github.com/o/r/pull/7\n");
    return ok();
  });
  const res = finishPr(wf, "body", exec);
  expect(res.ok && res.prUrl).toBe("https://github.com/o/r/pull/7");
});

test("finishPr maps a rejected push to an error", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec((call) => (call.args[0] === "push" ? fail("rejected: no upstream") : ok()));
  const res = finishPr(wf, "body", exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("rejected");
});

test("finishMerge refuses when the repo checkout left the base branch", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec } = fakeExec(() => ok("feature/elsewhere\n"));
  const res = finishMerge(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("feature/elsewhere");
});

test("finishMerge aborts and surfaces a merge conflict", () => {
  const wf = makeWorkflow("/repo", { baseBranch: "main" });
  const { exec, calls } = fakeExec((call) => {
    if (call.args[1] === "--abbrev-ref") return ok("main\n");
    if (call.args[0] === "merge" && call.args[1] === "--no-ff") return fail("CONFLICT (content): README.md");
    return ok();
  });
  const res = finishMerge(wf, exec);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("CONFLICT");
  expect(calls.at(-1)?.args).toEqual(["merge", "--abort"]);
});

test("integration: provision + commit + local merge against a throwaway repo", async () => {
  const repoDir = makeRepo();
  let wf = makeWorkflow(repoDir);
  const res = provisionWorktree(wf, realExec);
  if (!res.ok) throw new Error(res.error);
  wf = { ...wf, baseBranch: res.baseBranch, baseRef: res.baseRef };
  expect(res.baseBranch).toBe("main");
  expect(fs.existsSync(path.join(wf.worktreeDir, "README.md"))).toBe(true);

  /* The detached setup command runs in the worktree and reports done. */
  const setup = startSetup(wf);
  expect(setup.pid).toBeGreaterThan(0);
  wf = { ...wf, setupPid: setup.pid };
  for (let i = 0; i < 100 && setupStatus(wf).status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(setupStatus(wf).status).toBe("done");

  fs.writeFileSync(path.join(wf.worktreeDir, "greeting.txt"), "hi\n");
  git(wf.worktreeDir, "add", ".");
  git(wf.worktreeDir, "commit", "-m", "add greeting");

  const merged = finishMerge(wf, realExec);
  if (!merged.ok) throw new Error(merged.error);
  expect(fs.existsSync(path.join(repoDir, "greeting.txt"))).toBe(true);
});

test("integration: a failing setup reports the exit code and stderr tail", async () => {
  const repoDir = makeRepo();
  const failing = normalizeTemplate({ ...TEMPLATE, setup: "echo boom >&2; exit 3" })!;
  let wf = { ...makeWorkflow(repoDir), id: "wfid9999", template: failing };
  wf = { ...wf, worktreeDir: path.join(path.dirname(repoDir), path.basename(repoDir) + "-wf-" + wf.id) };
  const res = provisionWorktree(wf, realExec);
  if (!res.ok) throw new Error(res.error);
  wf = { ...wf, setupPid: startSetup(wf).pid };
  for (let i = 0; i < 100 && setupStatus(wf).status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = setupStatus(wf);
  expect(status.status).toBe("failed");
  expect(status.detail).toContain("code 3");
  expect(status.detail).toContain("boom");
});
