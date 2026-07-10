import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { entryModels } from "./model";
import type { FileEntry } from "../types";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-model-test-"));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("keeps Claude's raw dated model id for resume while presenting its short label", () => {
  const pathname = path.join(SANDBOX, "session.jsonl");
  fs.writeFileSync(pathname, JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-1-20250805" } }) + "\n");
  const stat = fs.statSync(pathname);
  const entry: FileEntry = {
    path: pathname,
    root: "claude-projects",
    name: "session.jsonl",
    project: "proj",
    title: "session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };

  expect(entryModels(entry)).toEqual({ display: "opus-4-1", launch: "claude-opus-4-1-20250805" });
});
