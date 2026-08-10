import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Publication hygiene (#964): the committed capture summary is a public
 * surface, so every path in it must be $HOME-relative — the synthetic capture
 * home must never leak in raw or slug-encoded form.
 */
test("the committed #964 evidence carries no absolute home paths", () => {
  const evidence = fs.readFileSync(
    path.resolve(import.meta.dir, "../evidence/issue-964/card-anatomy.json"),
    "utf8",
  );
  expect(evidence).not.toMatch(/(?:^|["\s])\/(?:home|tmp|Users)\//m);
  expect(evidence).not.toContain("-tmp-llv-");
});

/** The summary attests the verified anatomy facts, per theme and width. */
test("the committed #964 evidence covers both themes and both widths", () => {
  const evidence = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dir, "../evidence/issue-964/card-anatomy.json"),
    "utf8",
  )) as Record<string, unknown>;
  expect(typeof evidence.buildHead).toBe("string");
  for (const key of ["switchboard-dark", "switchboard-light", "mobile-390-switching-dark", "mobile-390-switching-light", "mobile-390-focus-dark", "mobile-390-focus-light", "stack", "farZoom"]) {
    expect(evidence[key]).toBeDefined();
  }
});
