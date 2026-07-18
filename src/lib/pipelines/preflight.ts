import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { realExec, type ExecPort } from "@/lib/workflows/provision";

import type { PipelineRepoPreflight, PipelineRepoPreflightErrorCode } from "./types";

export interface PipelineRepoPreflightPorts {
  homeDir(): string;
  stat(pathname: string): { isDirectory(): boolean };
  access(pathname: string, mode: number): void;
  exec: ExecPort;
}

const DEFAULT_PORTS: PipelineRepoPreflightPorts = {
  homeDir: os.homedir,
  stat: fs.statSync,
  access: fs.accessSync,
  exec: realExec,
};

function normalizeRepoPath(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? path.join(homeDir, trimmed.slice(1))
    : trimmed;
  return path.resolve(expanded);
}

function denied(
  ports: PipelineRepoPreflightPorts,
  pathname: string,
  mode: number,
): boolean {
  try {
    ports.access(pathname, mode);
    return false;
  } catch {
    return true;
  }
}

export function preflightPipelineRepo(
  rawPath: string,
  ports: PipelineRepoPreflightPorts = DEFAULT_PORTS,
): PipelineRepoPreflight {
  const candidate = normalizeRepoPath(rawPath, ports.homeDir());
  let stat: { isDirectory(): boolean };
  try {
    stat = ports.stat(candidate);
  } catch (error) {
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "repo_untraversable",
      path: candidate,
    };
  }
  if (!stat.isDirectory()) return { ok: false, code: "not_directory", path: candidate };
  if (denied(ports, candidate, fs.constants.R_OK)) return { ok: false, code: "repo_unreadable", path: candidate };
  if (denied(ports, candidate, fs.constants.X_OK)) return { ok: false, code: "repo_untraversable", path: candidate };

  const topLevel = ports.exec("git", ["rev-parse", "--show-toplevel"], candidate);
  if (topLevel.code !== 0 || !topLevel.stdout.trim()) return { ok: false, code: "not_git", path: candidate };
  const repoDir = path.resolve(topLevel.stdout.trim());
  if (repoDir !== candidate) {
    if (denied(ports, repoDir, fs.constants.R_OK)) return { ok: false, code: "repo_unreadable", path: repoDir };
    if (denied(ports, repoDir, fs.constants.X_OK)) return { ok: false, code: "repo_untraversable", path: repoDir };
  }

  const common = ports.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoDir);
  if (common.code !== 0 || !common.stdout.trim()) return { ok: false, code: "not_git", path: repoDir };
  const gitCommonDir = path.resolve(repoDir, common.stdout.trim());
  if (denied(ports, gitCommonDir, fs.constants.W_OK | fs.constants.X_OK)) {
    return { ok: false, code: "git_metadata_unwritable", path: gitCommonDir };
  }

  const worktreeParent = path.dirname(repoDir);
  if (denied(ports, worktreeParent, fs.constants.W_OK | fs.constants.X_OK)) {
    return { ok: false, code: "worktree_parent_unwritable", path: worktreeParent };
  }
  return { ok: true, repoDir, gitCommonDir, worktreeParent };
}

export function pipelineRepoPreflightStatus(code: PipelineRepoPreflightErrorCode): 400 | 403 {
  return code === "missing" || code === "not_directory" || code === "not_git" ? 400 : 403;
}

export function pipelineRepoPreflightError(result: Extract<PipelineRepoPreflight, { ok: false }>): string {
  switch (result.code) {
    case "missing": return `directory does not exist: ${result.path}`;
    case "not_directory": return `not a directory: ${result.path}`;
    case "repo_unreadable": return `repository is not readable: ${result.path}`;
    case "repo_untraversable": return `repository cannot be traversed: ${result.path}`;
    case "not_git": return `not a git repository: ${result.path}`;
    case "git_metadata_unwritable": return `Git metadata is not writable: ${result.path}`;
    case "worktree_parent_unwritable": return `pipeline worktree parent is not writable: ${result.path}`;
  }
}
