import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Publication hygiene (#961 review): the committed capture summary is a public
 * surface, so every path in it must be $HOME-relative — the synthetic capture
 * home must never leak in raw or slug-encoded form.
 */
test("the committed #961 evidence carries no absolute home paths", () => {
  const evidence = fs.readFileSync(
    path.resolve(import.meta.dir, "../evidence/issue-961/status-vocabulary.json"),
    "utf8",
  );
  expect(evidence).not.toMatch(/(?:^|["\s])\/(?:home|tmp|Users)\//m);
  expect(evidence).not.toContain("-tmp-llv-");
  /* The scrub keeps the payload useful: the stack key survives, rebased. */
  expect(evidence).toContain("$HOME/");
});
