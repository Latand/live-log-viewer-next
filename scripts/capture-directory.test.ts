import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCaptureDirectory } from "./capture-directory";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

test("each run is fresh and the stable latest link resolves to the newest run", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-directory-"));
  const parent = path.join(sandbox, "llv-issue-963-parent");
  fs.mkdirSync(parent);

  try {
    const options = {
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963" as const,
      raw: parent,
      repoRoot: REPO_ROOT,
    };
    const first = createCaptureDirectory(options);
    const second = createCaptureDirectory(options);
    const latest = path.join(parent, "llv-issue-963-latest");

    expect(path.dirname(first)).toBe(fs.realpathSync(parent));
    expect(path.basename(first)).toStartWith("llv-issue-963-");
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(latest)).toBe(second);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a refusal names the caller's own environment variable", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-variable-"));
  const wrongPrefix = path.join(sandbox, "llv-issue-963-parent");
  fs.mkdirSync(wrongPrefix);

  try {
    expect(() => createCaptureDirectory({
      envName: "ORCH_CAPTURE_DIR",
      prefix: "llv-issue-978",
      raw: wrongPrefix,
      repoRoot: REPO_ROOT,
    })).toThrow("ORCH_CAPTURE_DIR refused");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a non-symlink latest marker is preserved and blocks allocation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-capture-latest-refusal-"));
  const parent = path.join(sandbox, "llv-issue-963-parent");
  const latest = path.join(parent, "llv-issue-963-latest");
  const sentinel = path.join(latest, "keep.txt");
  fs.mkdirSync(latest, { recursive: true });
  fs.writeFileSync(sentinel, "keep", "utf8");

  try {
    expect(() => createCaptureDirectory({
      envName: "ATTENTION_CAPTURE_DIR",
      prefix: "llv-issue-963",
      raw: parent,
      repoRoot: REPO_ROOT,
    })).toThrow("latest marker must be a symbolic link");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    expect(fs.readdirSync(parent)).toEqual(["llv-issue-963-latest"]);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
