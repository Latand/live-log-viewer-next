import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";

import type { ExecResult } from "@/lib/workflows/provision";

import { clearPipelinePreflightCache, preflightPipelineRepo, type PipelineRepoPreflightPorts } from "./preflight";
import type { PipelineRepoPreflightErrorCode } from "./types";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(over: {
  stat?: "directory" | "file" | NodeJS.ErrnoException;
  denied?: Array<{ path: string; mode: number }>;
  topLevel?: string | null | ExecResult;
  gitCommonDir?: string | ExecResult;
} = {}) {
  const calls: string[] = [];
  const denied = over.denied ?? [];
  const ports: PipelineRepoPreflightPorts = {
    homeDir: () => "/home/user",
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
        if (over.topLevel && typeof over.topLevel === "object") return over.topLevel;
        return over.topLevel === null
          ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" }
          : { code: 0, stdout: `${over.topLevel ?? "/srv/repo"}\n`, stderr: "" };
      }
      if (args.includes("--git-common-dir")) {
        if (over.gitCommonDir && typeof over.gitCommonDir === "object") return over.gitCommonDir;
        return { code: 0, stdout: `${over.gitCommonDir ?? "/srv/repo/.git"}\n`, stderr: "" };
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  };
  return { ports, calls };
}

beforeEach(() => clearPipelinePreflightCache());

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
      "git:rev-parse --show-toplevel:/home/user/repo",
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

  describe("probe fidelity (#353 AC3)", () => {
    test("a spawn/timeout failure (code null) never masquerades as not_git", () => {
      const { ports } = harness({ topLevel: { code: null, stdout: "", stderr: "spawnSync git ETIMEDOUT" } });
      const result = preflightPipelineRepo("/candidate", ports);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("probe_failed");
      expect(result.detail).toContain("ETIMEDOUT");
    });

    test("a transient non-zero exit without the not-a-repo message is probe_failed, preserving stderr", () => {
      const { ports } = harness({
        topLevel: { code: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at '/srv/repo'" },
      });
      const result = preflightPipelineRepo("/candidate", ports);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("probe_failed");
      expect(result.detail).toContain("dubious ownership");
    });

    test("a genuine not-a-git-repository verdict is still reported as not_git", () => {
      const { ports } = harness({ topLevel: null });
      expect(preflightPipelineRepo("/candidate", ports)).toEqual({ ok: false, code: "not_git", path: "/candidate" });
    });

    test("a failing git-common-dir probe preserves the transient reason instead of not_git", () => {
      const { ports } = harness({
        gitCommonDir: { code: null, stdout: "", stderr: "spawnSync git ENOMEM" },
      });
      const result = preflightPipelineRepo("/candidate", ports);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("probe_failed");
      expect(result.detail).toContain("ENOMEM");
    });
  });

  describe("preflight cache (#353 AC2)", () => {
    test("a repeated request for a valid repository reuses the probe without re-running git", () => {
      const first = harness();
      expect(preflightPipelineRepo("/candidate", first.ports, { cache: true }).ok).toBe(true);
      const firstGit = first.calls.filter((call) => call.startsWith("git:"));
      expect(firstGit.length).toBe(2);

      // A second request keyed by the canonical repoDir the picker returns must
      // not re-probe git — creation reuses the picker's valid preflight (#353 AC2).
      const second = harness();
      expect(preflightPipelineRepo("/srv/repo", second.ports, { cache: true })).toEqual({
        ok: true,
        repoDir: "/srv/repo",
        gitCommonDir: "/srv/repo/.git",
        worktreeParent: "/srv",
      });
      expect(second.calls.filter((call) => call.startsWith("git:"))).toEqual([]);
    });

    test("failures are never cached (fidelity re-probes every time)", () => {
      const first = harness({ topLevel: null });
      expect(preflightPipelineRepo("/candidate", first.ports, { cache: true }).ok).toBe(false);
      const second = harness();
      // The same path now resolves — no stale cached failure short-circuits it.
      expect(preflightPipelineRepo("/candidate", second.ports, { cache: true }).ok).toBe(true);
      expect(second.calls.some((call) => call.startsWith("git:"))).toBe(true);
    });

    test("the cache is opt-in; the default path always re-probes", () => {
      const first = harness();
      expect(preflightPipelineRepo("/candidate", first.ports).ok).toBe(true);
      const second = harness();
      expect(preflightPipelineRepo("/srv/repo", second.ports).ok).toBe(true);
      expect(second.calls.some((call) => call.startsWith("git:"))).toBe(true);
    });
  });
});
