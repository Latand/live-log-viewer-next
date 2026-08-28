import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  declaresPackage,
  dependencyChanges,
  dependencyDeclarationVerdict,
  describeChange,
} from "./dependency-declaration-gate";

const gate = join(import.meta.dir, "dependency-declaration-gate.ts");

const manifest = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) => ({
  name: "fixture",
  dependencies,
  devDependencies,
});

describe("dependency change detection", () => {
  test("an untouched dependency set produces no change", () => {
    const before = manifest({ next: "16.3.2" }, { eslint: "^10" });
    expect(dependencyChanges(before, manifest({ next: "16.3.2" }, { eslint: "^10" }))).toEqual([]);
  });

  test("every kind of movement is reported with the version on both sides", () => {
    const changes = dependencyChanges(
      manifest({ next: "16.3.2", removed: "^1" }),
      manifest({ next: "16.2.10", added: "^2" }),
    );
    expect(changes.map(describeChange)).toEqual([
      "added added as ^2 in dependencies",
      "next 16.3.2 -> 16.2.10 in dependencies",
      "removed removed from dependencies (was ^1)",
    ]);
  });
});

describe("what counts as declaring a package", () => {
  test("the package's own name in the description declares it, whatever the case", () => {
    expect(declaresPackage("This restores Next 16.3.2 on Bun 1.4.0.", "next")).toBe(true);
    expect(declaresPackage("bumps `@types/node` to 26", "@types/node")).toBe(true);
  });

  test("a different package whose name contains it does not", () => {
    expect(declaresPackage("pins eslint-config-next to 16.3.2", "next")).toBe(false);
    expect(declaresPackage("mentions nextauth and nothing else", "next")).toBe(false);
  });
});

describe("the verdict", () => {
  const declaredChange = {
    basePackage: manifest({ next: "16.2.10" }),
    mergedPackage: manifest({ next: "16.3.2" }),
    baseLockfile: "lock-before",
    mergedLockfile: "lock-after",
  };

  test("a change the description names passes", () => {
    const verdict = dependencyDeclarationVerdict({
      ...declaredChange,
      declaration: "Restores next to 16.3.2 now that the image runs a Bun that loads it.",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  test("a change the description never mentions fails, naming the package and both versions", () => {
    const verdict = dependencyDeclarationVerdict({
      basePackage: manifest({ next: "16.3.2" }),
      mergedPackage: manifest({ next: "16.2.10" }),
      baseLockfile: "lock-after",
      mergedLockfile: "lock-before",
      declaration: "fix(board): collapse a lane on completion\n\nCloses #1249",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toContain("next 16.3.2 -> 16.2.10 in dependencies");
  });

  test("an unchanged dependency set passes however silent the description is", () => {
    const verdict = dependencyDeclarationVerdict({
      basePackage: manifest({ next: "16.3.2" }),
      mergedPackage: manifest({ next: "16.3.2" }),
      baseLockfile: "lock",
      mergedLockfile: "lock",
      declaration: "",
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.changes).toEqual([]);
  });

  test("a dependency change without a lockfile change still fails, as it did before", () => {
    const verdict = dependencyDeclarationVerdict({
      ...declaredChange,
      mergedLockfile: "lock-before",
      declaration: "Bumps next to 16.3.2.",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join("\n")).toContain("without changing bun.lock");
  });

  test("without a pull request description only the lockfile rule applies", () => {
    const verdict = dependencyDeclarationVerdict({ ...declaredChange, declaration: null });
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join("\n")).toContain("the declaration rule was not applied");
  });
});

// The mechanism behind #1246, built out of real commits: a branch that predates
// a dependency bump is updated onto the default branch, the update resolves
// package.json and bun.lock to the branch's older side, and the merge that
// lands carries a revert the pull request never mentions.
describe("a stale branch whose merge reverts a bump", () => {
  const root = mkdtempSync(join(tmpdir(), "llv-dependency-gate-"));
  const repository = join(root, "repository");
  const identity = ["gate", "@", "invalid.test"].join("");

  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gate fixture",
      GIT_COMMITTER_NAME: "gate fixture",
      GIT_AUTHOR_EMAIL: identity,
      GIT_COMMITTER_EMAIL: identity,
    },
  }).trim();

  const write = (file: string, contents: string) => writeFileSync(join(repository, file), contents);
  const writeManifest = (version: string) =>
    write("package.json", `${JSON.stringify(manifest({ next: version }), null, 2)}\n`);

  execFileSync("git", ["init", "--initial-branch=main", "--quiet", repository]);
  writeManifest("16.2.10");
  write("bun.lock", "resolved for 16.2.10\n");
  write("viewer.ts", "export const board = 1;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "the revision both sides branch from");
  const branchPoint = git("rev-parse", "HEAD");

  writeManifest("16.3.2");
  write("bun.lock", "resolved for 16.3.2\n");
  git("commit", "--quiet", "-a", "-m", "chore(deps): bump next to 16.3.2");
  const base = git("rev-parse", "HEAD");

  git("checkout", "--quiet", "-b", "feature", branchPoint);
  write("viewer.ts", "export const board = 2;\n");
  git("commit", "--quiet", "-a", "-m", "fix(board): a change about something else");
  // The branch is updated onto the default branch and the resolution keeps the
  // branch's own package.json and lockfile - the accident, exactly.
  git("merge", "--quiet", "--no-commit", "--no-ff", base);
  writeManifest("16.2.10");
  write("bun.lock", "resolved for 16.2.10\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Merge branch 'main' into feature");

  // What GitHub offers as the pull request's merge ref, and what would land.
  git("checkout", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "-m", "merge ref", "feature");

  const runGate = (declaration: string | null) => {
    const args = [gate, "--repository", repository, "--merge", "HEAD"];
    if (declaration !== null) {
      const file = join(root, "declaration.md");
      writeFileSync(file, declaration);
      args.push("--declaration", file);
    }
    const result = Bun.spawnSync([process.execPath, ...args], { cwd: repository });
    return {
      code: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
    };
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("the merge reverts the bump even though the branch is about something else", () => {
    expect(git("show", "HEAD:package.json")).toContain('"next": "16.2.10"');
    expect(git("show", `${base}:package.json`)).toContain('"next": "16.3.2"');
  });

  test("a pull request that says nothing about it is refused, and told what it changed", () => {
    const { code, output } = runGate("fix(board): a change about something else\n\nCloses #1\n");
    expect(code).toBe(1);
    expect(output).toContain("next 16.3.2 -> 16.2.10 in dependencies");
    expect(output).toContain("does not mention");
  });

  test("the same merge passes once the pull request declares the revert", () => {
    const { code, output } = runGate(
      "fix(board): a change about something else\n\nThis also pins next back to 16.2.10 until the image"
      + " runs a Bun that loads the newer compiled runtime.\n",
    );
    expect(code).toBe(0);
    expect(output).toContain("next 16.3.2 -> 16.2.10 in dependencies");
  });
});
