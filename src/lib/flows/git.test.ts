import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { githubRepositoryFromRemote, repositoryForProjectRoot, resetRepositoryCache } from "./git";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-repo-derive-"));
  dirs.push(dir);
  return dir;
}

function gitRepo(remote?: string): string {
  const dir = tempDir();
  expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
  if (remote) expect(spawnSync("git", ["remote", "add", "origin", remote], { cwd: dir }).status).toBe(0);
  return dir;
}

afterEach(() => {
  resetRepositoryCache();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("derives owner/repo from ssh and https origin remotes", () => {
  expect(repositoryForProjectRoot(gitRepo("git@github.com:Latand/live-log-viewer-next.git"))).toBe("Latand/live-log-viewer-next");
  expect(repositoryForProjectRoot(gitRepo("https://github.com/Latand/live-log-viewer-next.git"))).toBe("Latand/live-log-viewer-next");
  /* Non-GitHub remotes and remoteless repos degrade to null, not an error. */
  expect(repositoryForProjectRoot(gitRepo("https://gitlab.com/acme/tool.git"))).toBe(null);
  expect(repositoryForProjectRoot(gitRepo())).toBe(null);
});

test("caches per root inside the TTL and refreshes after it", () => {
  const dir = gitRepo("git@github.com:Latand/first.git");
  const t0 = 1_000_000;
  expect(repositoryForProjectRoot(dir, t0)).toBe("Latand/first");
  /* The remote changes on disk; the cache still answers inside the TTL. */
  expect(spawnSync("git", ["remote", "set-url", "origin", "git@github.com:Latand/second.git"], { cwd: dir }).status).toBe(0);
  expect(repositoryForProjectRoot(dir, t0 + 60_000)).toBe("Latand/first");
  /* Past the 10-minute TTL the probe runs again. */
  expect(repositoryForProjectRoot(dir, t0 + 11 * 60_000)).toBe("Latand/second");
});

test("a missing or non-git root yields null instead of blocking the response", () => {
  const plain = tempDir();
  expect(repositoryForProjectRoot(path.join(plain, "does-not-exist"))).toBe(null);
  expect(repositoryForProjectRoot(plain)).toBe(null);
  expect(githubRepositoryFromRemote("not a url")).toBe(null);
});
