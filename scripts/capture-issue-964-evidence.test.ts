import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function readEvidence(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "evidence/issue-964/card-anatomy.json"), "utf8")) as Record<string, unknown>;
}

/**
 * Publication hygiene (#964): the committed capture summary is a public
 * surface, so every path in it must be $HOME-relative — the synthetic capture
 * home must never leak in raw or slug-encoded form.
 */
test("the committed #964 evidence carries no absolute home paths", () => {
  const evidence = fs.readFileSync(path.join(REPO_ROOT, "evidence/issue-964/card-anatomy.json"), "utf8");
  expect(evidence).not.toMatch(/(?:^|["\s])\/(?:home|tmp|Users)\//m);
  expect(evidence).not.toContain("-tmp-llv-");
});

/** The summary attests the verified anatomy facts, per theme and width —
    including a 390px entry for EVERY seeded operational state (#964 review,
    finding 2) and the mixed-row chip geometry (finding 1). */
test("the committed #964 evidence covers both themes, both widths, and every 390px state", () => {
  const evidence = readEvidence();
  expect(typeof evidence.buildHead).toBe("string");
  const keys = ["switchboard-dark", "switchboard-light", "stack", "farZoom"];
  for (const state of ["needs-you", "held", "running", "queued", "quiet", "rate-limited", "switching", "switch-failed", "settled-account"]) {
    for (const scheme of ["dark", "light"]) keys.push(`mobile-390-${state}-${scheme}`);
  }
  for (const key of keys) {
    expect(evidence[key]).toBeDefined();
  }
  /* The mixed cards' geometry rode into the switchboard facts: both fixed
     widths present, no chip clipped past its ops row. */
  for (const scheme of ["dark", "light"]) {
    const facts = evidence[`switchboard-${scheme}`] as Array<{ width: number; opsGeometry: Array<{ overflowRight: number; width: number; titled: boolean }> }>;
    for (const width of [300, 220]) {
      const mixed = facts.find((fact) => fact.width === width && fact.opsGeometry.length >= 2);
      expect(mixed).toBeDefined();
      for (const chip of mixed!.opsGeometry) {
        expect(chip.overflowRight).toBeLessThanOrEqual(0.5);
        expect(chip.width).toBeGreaterThanOrEqual(16);
        expect(chip.titled).toBe(true);
      }
    }
  }
});

/**
 * Head binding (#964 review, finding 3): the frames are captured against the
 * production build of `buildHead`; committing them necessarily creates one
 * commit past it. The enforceable invariant is that every commit after
 * buildHead is evidence-only — the rendered pixels therefore describe exactly
 * the reviewed source. Skips silently when git history is unavailable (e.g. a
 * shallow CI clone that no longer carries buildHead).
 */
test("the #964 evidence head differs from HEAD only by evidence commits", () => {
  const buildHead = readEvidence().buildHead as string;
  expect(buildHead).toMatch(/^[0-9a-f]{40}$/);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (head.status !== 0) return;
  if (head.stdout.trim() === buildHead) return;
  const diff = spawnSync("git", ["diff", "--name-only", `${buildHead}..HEAD`], { cwd: REPO_ROOT, encoding: "utf8" });
  if (diff.status !== 0) return;
  const touched = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  expect(touched.length).toBeGreaterThan(0);
  for (const file of touched) {
    expect(file.startsWith("evidence/")).toBe(true);
  }
});
