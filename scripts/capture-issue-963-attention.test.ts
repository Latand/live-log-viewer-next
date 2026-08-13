import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureDirectory } from "./capture-directory";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const options = (raw: string | undefined) => ({
  envName: "ATTENTION_CAPTURE_DIR",
  prefix: "llv-issue-963" as const,
  raw,
  repoRoot: REPO_ROOT,
});

test("the default capture root is a fresh script-labelled temp child", () => {
  const created = createCaptureDirectory(options(undefined));
  try {
    expect(path.dirname(created)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(created)).toStartWith("llv-issue-963-");
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
});

test("a dedicated script-labelled temp directory receives a unique run child", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-issue-963-parent-"));
  try {
    const created = createCaptureDirectory(options(parent));
    expect(path.dirname(created)).toBe(fs.realpathSync(parent));
    expect(path.basename(created)).toStartWith("llv-issue-963-");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the filesystem root, the temp root, and the home directory are rejected", () => {
  expect(() => createCaptureDirectory(options("/"))).toThrow("refused");
  expect(() => createCaptureDirectory(options(os.tmpdir()))).toThrow("refused");
  expect(() => createCaptureDirectory(options(os.homedir()))).toThrow("refused");
});

test("a temp directory without the script's own prefix is rejected", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "unrelated-capture-"));
  try {
    expect(() => createCaptureDirectory(options(parent))).toThrow("override leaf must start with llv-issue-963");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
