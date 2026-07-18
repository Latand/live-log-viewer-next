import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { preflightPipelineRepo, type PipelineRepoPreflightPorts } from "./preflight";
import type { PipelineRepoPreflightErrorCode } from "./types";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(over: {
  stat?: "directory" | "file" | NodeJS.ErrnoException;
  denied?: Array<{ path: string; mode: number }>;
  topLevel?: string | null;
  gitCommonDir?: string;
} = {}) {
  const calls: string[] = [];
  const denied = over.denied ?? [];
  const ports: PipelineRepoPreflightPorts = {
    homeDir: () => "/home/operator",
    stat: (pathname) => {
      calls.push(`stat:${pathname}`);
      if (over.stat instanceof Error) throw over.stat;
      return { isDirectory: () => over.stat !== "file" };
    },
    access: (pathname, mode) => {
      calls.push(`access:${pathname}:${mode}`);
      if (denied.some((entry) => entry.path === pathname && entry.mode === mode)) throw failure("EACCES");
    },
    exec: (_command, args, cwd) => {
      calls.push(`git:${args.join(" ")}:${cwd}`);
      if (args.includes("--show-toplevel")) {
        return over.topLevel === null
          ? { code: 128, stdout: "", stderr: "not a repository" }
          : { code: 0, stdout: `${over.topLevel ?? "/srv/repo"}\n`, stderr: "" };
      }
      if (args.includes("--git-common-dir")) {
        return { code: 0, stdout: `${over.gitCommonDir ?? "/srv/repo/.git"}\n`, stderr: "" };
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  };
  return { ports, calls };
}

describe("pipeline repository preflight", () => {
  test("returns the canonical repository, Git metadata, and future worktree parent", () => {
    const { ports, calls } = harness();

    expect(preflightPipelineRepo("~/repo/../repo", ports)).toEqual({
      ok: true,
      repoDir: "/srv/repo",
      gitCommonDir: "/srv/repo/.git",
      worktreeParent: "/srv",
    });
    expect(calls.filter((call) => call.startsWith("git:"))).toEqual([
      "git:rev-parse --show-toplevel:/home/operator/repo",
      "git:rev-parse --path-format=absolute --git-common-dir:/srv/repo",
    ]);
    expect(calls.some((call) => call.includes("fetch") || call.includes("worktree"))).toBe(false);
  });

  test("distinguishes every repository-admission failure", () => {
    const cases: Array<{
      name: string;
      over: Parameters<typeof harness>[0];
      expected: { code: PipelineRepoPreflightErrorCode; path: string };
    }> = [
      { name: "missing", over: { stat: failure("ENOENT") }, expected: { code: "missing", path: "/candidate" } },
      { name: "not a directory", over: { stat: "file" }, expected: { code: "not_directory", path: "/candidate" } },
      { name: "unreadable", over: { denied: [{ path: "/candidate", mode: fs.constants.R_OK }] }, expected: { code: "repo_unreadable", path: "/candidate" } },
      { name: "untraversable", over: { denied: [{ path: "/candidate", mode: fs.constants.X_OK }] }, expected: { code: "repo_untraversable", path: "/candidate" } },
      { name: "not git", over: { topLevel: null }, expected: { code: "not_git", path: "/candidate" } },
      { name: "Git metadata read-only", over: { denied: [{ path: "/srv/repo/.git", mode: fs.constants.W_OK | fs.constants.X_OK }] }, expected: { code: "git_metadata_unwritable", path: "/srv/repo/.git" } },
      { name: "worktree parent read-only", over: { denied: [{ path: "/srv", mode: fs.constants.W_OK | fs.constants.X_OK }] }, expected: { code: "worktree_parent_unwritable", path: "/srv" } },
    ];

    for (const item of cases) {
      const { ports } = harness(item.over);
      expect(preflightPipelineRepo("/candidate", ports), item.name).toEqual({ ok: false, ...item.expected });
    }
  });
});
