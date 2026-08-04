import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { projectIdentityFromRepositoryRoot, repositoryRootForPath } from "./identity";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-identity-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function createRepository(name: string, remote: string): string {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), [
    '[remote "origin"]',
    `\turl = ${remote}`,
    "",
  ].join("\n"));
  return root;
}

function createLocalRepository(name: string): string {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  return root;
}

test("scp, ssh, and https clones of one remote resolve to one identity", () => {
  const identities = [
    createRepository("clone-scp", "git@example.invalid:team/shared-repository.git"),
    createRepository("clone-ssh", "ssh://git@example.invalid/team/shared-repository.git"),
    createRepository("clone-https", "https://example.invalid/team/shared-repository.git"),
    createRepository("clone-https-bare", "https://example.invalid/team/shared-repository"),
  ].map((root) => projectIdentityFromRepositoryRoot(root)!);

  expect(identities.every(Boolean)).toBe(true);
  expect(new Set(identities.map((identity) => identity.project))).toHaveLength(1);
  expect(new Set(identities.map((identity) => identity.canonicalRemote)))
    .toEqual(new Set(["example.invalid/team/shared-repository"]));
  expect(identities[0]!.displayName).toBe("shared-repository");
});

test("an https remote never parses as an scp host", () => {
  const root = createRepository("https-host", "https://example.invalid/team/host-check.git");
  const identity = projectIdentityFromRepositoryRoot(root)!;
  expect(identity.canonicalRemote.startsWith("example.invalid/")).toBe(true);
  expect(identity.canonicalRemote).not.toContain("https");
});

test("a local repository without origin still has one stable non-unresolved identity", () => {
  const root = createLocalRepository("local-repository");
  const first = projectIdentityFromRepositoryRoot(root);
  const second = projectIdentityFromRepositoryRoot(path.join(root, "."));

  expect(first).toEqual(second);
  expect(first).toMatchObject({
    displayName: "local-repository",
    canonicalRemote: `local:${root}`,
  });
  expect(first?.project).toMatch(/^repo-[a-f0-9]{32}$/);
});

test("a vestigial .git directory without HEAD is not a repository", () => {
  const root = path.join(SANDBOX, "vestigial-home");
  // Tooling plants auxiliary files like info/exclude without ever running
  // `git init` to completion — git itself refuses such a directory.
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "**/ignored\n");

  expect(projectIdentityFromRepositoryRoot(root)).toBeNull();
  expect(repositoryRootForPath(path.join(root, "nested", "dir"))).toBeNull();
});
