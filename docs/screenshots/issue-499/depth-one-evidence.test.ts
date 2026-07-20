/**
 * Issue #499 (repair round) — regression guard for the release publish path.
 *
 * `publish.yml` runs `bun test` after `actions/checkout@v4`, whose default
 * `fetch-depth: 1` produces a DEPTH-ONE checkout: only the reviewed HEAD commit
 * and its tree are present, so the capture manifest's ancestor `sourceRevision`
 * is absent. `evidence.test.ts` validates the committed capture evidence
 * against that revision's git tree and its committed harness bytes, so the
 * workflow deepens history to it (deepen-to-evidence-revision.sh) before
 * `bun test`.
 *
 * This test reproduces the release checkout locally and proves BOTH halves of
 * that contract from a fresh depth-one `file://` clone of the reviewed HEAD:
 *
 *   RED   — a bare depth-one checkout cannot resolve the ancestor
 *           `sourceRevision`, so the FULL evidence suite fails there (this is
 *           the review finding, mechanically reproduced).
 *   GREEN — after running the EXACT deepen step publish.yml runs
 *           (deepen-to-evidence-revision.sh), the untouched full evidence
 *           suite — including the sourceRevision tree and harness-bytes
 *           assertions — passes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { loadManifest } from "./generate-stills";

const DIR = import.meta.dir;
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd }).toString().trim();
const repoRoot = git(DIR, "rev-parse", "--show-toplevel");
const EVIDENCE_SUITE = "docs/screenshots/issue-499/evidence.test.ts";
const DEEPEN_SCRIPT = "docs/screenshots/issue-499/deepen-to-evidence-revision.sh";

/** Run the focused evidence suite in `cwd` with the same runner publish.yml
    uses (bun); return its exit code without throwing. */
function runEvidenceSuite(cwd: string): number {
  try {
    execFileSync(process.execPath, ["test", EVIDENCE_SUITE], { cwd, stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof (error as { status?: number }).status === "number" ? (error as { status: number }).status : 1;
  }
}

function ancestorPresent(cwd: string, rev: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "the committed capture evidence verifies from the depth-one release checkout only after publish.yml's deepen step — RED bare, GREEN deepened",
  () => {
    // Dependencies live at the reviewed tree's node_modules; publish.yml runs
    // `bun install` before `bun test`, so this is always populated in CI.
    const nodeModules = join(repoRoot, "node_modules");
    expect(existsSync(nodeModules)).toBe(true);

    const work = mkdtempSync(join(tmpdir(), "issue-499-depth-one-"));
    const clone = join(work, "checkout");
    try {
      // A `file://` clone is required for a genuinely shallow local checkout —
      // git ignores `--depth` for plain local-path clones. `--depth 1` matches
      // actions/checkout@v4's default fetch-depth.
      execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${repoRoot}`, clone], { stdio: "ignore" });
      symlinkSync(nodeModules, join(clone, "node_modules"));

      const sourceRevision = loadManifest().sourceRevision;

      // The checkout is genuinely depth-one: shallow, and the manifest's
      // recorded ancestor sourceRevision is absent — the exact condition the
      // release publish hits.
      expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
      expect(ancestorPresent(clone, sourceRevision)).toBe(false);

      // RED: without the deepen step, the full evidence suite cannot resolve the
      // ancestor sourceRevision tree/harness bytes and fails.
      expect(runEvidenceSuite(clone)).not.toBe(0);

      // Apply the EXACT remedy publish.yml applies before `bun test`.
      execFileSync("bash", [DEEPEN_SCRIPT], { cwd: clone, stdio: "ignore" });

      // The deepen step made the ancestor sourceRevision reachable and connected.
      expect(ancestorPresent(clone, sourceRevision)).toBe(true);
      expect(() => execFileSync("git", ["merge-base", "--is-ancestor", sourceRevision, "HEAD"], { cwd: clone })).not.toThrow();

      // GREEN: the untouched full evidence suite — including the sourceRevision
      // tree and harness-bytes provenance assertions — now passes.
      expect(runEvidenceSuite(clone)).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  180_000,
);
