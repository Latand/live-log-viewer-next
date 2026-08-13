import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { resolveCaptureRoot } from "./capture-issue-963-attention";

/* The capture root is rmSync'd wholesale before every run, so the resolver is
   the only thing between a typo'd ATTENTION_CAPTURE_DIR and erased data
   (issue #963 review): broad targets must be rejected before any removal. */

test("the default capture root resolves to the dedicated /tmp child", () => {
  expect(resolveCaptureRoot(undefined)).toBe("/tmp/llv-issue-963");
});

test("a dedicated llv- child directory is accepted", () => {
  expect(resolveCaptureRoot("/tmp/llv-963-custom/")).toBe("/tmp/llv-963-custom");
});

test("the filesystem root, the temp root, and the home directory are rejected", () => {
  expect(() => resolveCaptureRoot("/")).toThrow("dedicated child directory");
  expect(() => resolveCaptureRoot(os.tmpdir())).toThrow("dedicated child directory");
  expect(() => resolveCaptureRoot(os.homedir())).toThrow("dedicated child directory");
});

test("an ancestor of a protected directory is rejected even with an llv- name", () => {
  const parent = path.dirname(os.homedir());
  expect(() => resolveCaptureRoot(parent)).toThrow("dedicated child directory");
  expect(() => resolveCaptureRoot("/srv/llv-area", "/srv/llv-area/checkout")).toThrow("dedicated child directory");
});

test("the repository itself is rejected", () => {
  const repo = path.resolve(import.meta.dir, "..");
  expect(() => resolveCaptureRoot(repo)).toThrow("dedicated child directory");
});

test("a directory without the dedicated llv- basename is rejected", () => {
  expect(() => resolveCaptureRoot("/tmp/data")).toThrow('start with "llv-"');
});

/* Reused by every capture script whose root is deleted wholesale (#978 review),
   so the refusal has to name the override the operator actually typed. */
test("the refusal names the caller's own override variable", () => {
  expect(() => resolveCaptureRoot(os.tmpdir(), undefined, "ORCH_CAPTURE_DIR"))
    .toThrow("ORCH_CAPTURE_DIR must be a dedicated child directory");
  expect(() => resolveCaptureRoot("/tmp/data", undefined, "ORCH_CAPTURE_DIR"))
    .toThrow('ORCH_CAPTURE_DIR basename must start with "llv-"');
});
