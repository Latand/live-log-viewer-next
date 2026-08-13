import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { resolveOrchCaptureRoot } from "./capture-issue-979-mobile-orchestrator";

/* The #979 capture root is `rmSync`'d wholesale before every run, so this
   resolver is the only thing between a typo'd ORCH_CAPTURE_DIR and erased data
   (#979 review). It defers to #963's rule rather than inventing a second one;
   these cases pin the behaviour this script depends on. */

test("the default capture root is the dedicated /tmp child", () => {
  expect(resolveOrchCaptureRoot(undefined)).toBe("/tmp/llv-issue-979");
});

test("a dedicated llv- child directory is accepted, trailing separator and all", () => {
  expect(resolveOrchCaptureRoot("/tmp/llv-979-review/")).toBe("/tmp/llv-979-review");
});

test("the filesystem root, the temp root, the home directory and the repository are refused", () => {
  const repo = path.resolve(import.meta.dir, "..");
  for (const target of ["/", os.tmpdir(), os.homedir(), repo, path.dirname(os.homedir())]) {
    expect(() => resolveOrchCaptureRoot(target)).toThrow("ORCH_CAPTURE_DIR");
  }
  /* An ancestor of the repository is refused even when it is named like a
     capture directory. */
  expect(() => resolveOrchCaptureRoot(path.dirname(repo))).toThrow("ORCH_CAPTURE_DIR");
});

test("a directory whose name does not say what it is gets refused", () => {
  expect(() => resolveOrchCaptureRoot("/tmp/screenshots")).toThrow("ORCH_CAPTURE_DIR");
});
