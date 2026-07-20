/**
 * Issue #499 (repair round) — regression guard for the evidence deepen strategy.
 *
 * `deepen-to-evidence-revision.sh` makes the capture manifest's ancestor
 * `sourceRevision` reachable from a depth-one release checkout before the
 * evidence suite validates against it. An earlier version deepened with a FIXED
 * ceiling (20 chunks of 10 = 200 commits), so it spuriously failed whenever the
 * reviewed HEAD sat more than 200 commits ahead of the recorded revision — even
 * though the remote could still serve that ancestor (the review High).
 *
 * These deterministic regressions drive the REAL script against synthetic
 * `file://` remotes (the script reads its cwd's manifest and deepens the cwd's
 * checkout), proving it now:
 *
 *   1. reaches a sourceRevision MORE THAN 200 commits behind HEAD (the old
 *      ceiling would have stopped short and failed),
 *   2. terminates and fails loudly for a MISSING revision (remote history
 *      exhausted, object never found), and
 *   3. fails loudly for an UNRELATED revision present in the repo but not an
 *      ancestor of HEAD (the final ancestry gate is preserved).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

const DIR = import.meta.dir;
const SCRIPT = join(DIR, "deepen-to-evidence-revision.sh");
const MANIFEST_REL = "docs/screenshots/issue-499/capture-manifest.json";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd }).toString().trim();

/** Build a `file://` remote with `count` linear empty commits; return its path
    and the SHAs of its root (oldest) and tip commits. */
function makeRemote(work: string, count: number): { path: string; root: string; tip: string } {
  const path = join(work, "remote");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "evidence@test.invalid");
  git(path, "config", "user.name", "evidence");
  git(path, "config", "commit.gpgsign", "false");
  for (let i = 1; i <= count; i++) git(path, "commit", "-q", "--allow-empty", "-m", `c${i}`);
  const tip = git(path, "rev-parse", "HEAD");
  const root = git(path, "rev-list", "--max-parents=0", "HEAD");
  return { path, root, tip };
}

/** A genuinely shallow depth-one clone, matching actions/checkout@v4's default
    fetch-depth. `--depth` is honored for `file://` clones (not plain paths). */
function shallowClone(work: string, remote: string): string {
  const clone = join(work, "checkout");
  execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${remote}`, clone], { stdio: "ignore" });
  return clone;
}

/** Write the manifest the script reads for its sourceRevision, into `clone`. */
function writeManifest(clone: string, sourceRevision: string): void {
  const dir = join(clone, "docs/screenshots/issue-499");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(clone, MANIFEST_REL), JSON.stringify({ sourceRevision }, null, 2));
}

/** Run the REAL script with cwd = clone; return its exit code without throwing. */
function runDeepen(clone: string): number {
  try {
    execFileSync("bash", [SCRIPT], { cwd: clone, stdio: "ignore", timeout: 60_000 });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

function withWork(body: (work: string) => void): void {
  const work = mkdtempSync(join(tmpdir(), "issue-499-deepen-"));
  try {
    body(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test(
  "reaches a sourceRevision more than 200 commits behind HEAD — the fixed-200 ceiling would have failed",
  () => {
    withWork((work) => {
      // 230 commits: the root is 229 behind the tip, well past the old 200 cap.
      const remote = makeRemote(work, 230);
      const clone = shallowClone(work, remote.path);
      writeManifest(clone, remote.root);

      // The checkout starts genuinely depth-one, and the target really is more
      // than 200 commits behind HEAD (measured on the remote, which holds the
      // full graph; the shallow clone has only its tip). The old ceiling matters.
      expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
      const distance = Number(git(remote.path, "rev-list", "--count", `${remote.root}..${remote.tip}`));
      expect(distance).toBeGreaterThan(200);

      // Progress-checked deepening reaches the far ancestor and connects it.
      expect(runDeepen(clone)).toBe(0);
      expect(() =>
        execFileSync("git", ["merge-base", "--is-ancestor", remote.root, "HEAD"], { cwd: clone }),
      ).not.toThrow();
    });
  },
  120_000,
);

test(
  "fails loudly (and terminates) for a sourceRevision missing from remote history",
  () => {
    withWork((work) => {
      const remote = makeRemote(work, 8);
      const clone = shallowClone(work, remote.path);
      // A syntactically valid SHA that no commit in the remote resolves to.
      writeManifest(clone, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

      // History is exhausted without ever finding the object: non-zero exit,
      // and the run returns (the 60s process timeout guards against a spin).
      expect(runDeepen(clone)).not.toBe(0);
    });
  },
  120_000,
);

test(
  "fails loudly for an unrelated revision present in the repo but not an ancestor of HEAD",
  () => {
    withWork((work) => {
      const remote = makeRemote(work, 8);
      const clone = shallowClone(work, remote.path);

      // Fabricate a commit that EXISTS in the clone but sits off HEAD's history.
      const head = git(clone, "rev-parse", "HEAD");
      git(clone, "checkout", "-q", "-b", "unrelated");
      git(clone, "config", "user.email", "evidence@test.invalid");
      git(clone, "config", "user.name", "evidence");
      git(clone, "config", "commit.gpgsign", "false");
      git(clone, "commit", "-q", "--allow-empty", "-m", "unrelated");
      const unrelated = git(clone, "rev-parse", "HEAD");
      git(clone, "checkout", "-q", head);
      writeManifest(clone, unrelated);

      // The object resolves, so the final ancestry gate — not the object check —
      // is what rejects it. That gate is preserved: non-zero exit.
      expect(() => execFileSync("git", ["cat-file", "-e", `${unrelated}^{commit}`], { cwd: clone })).not.toThrow();
      expect(runDeepen(clone)).not.toBe(0);
    });
  },
  120_000,
);
