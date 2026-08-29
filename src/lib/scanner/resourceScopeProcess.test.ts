import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { discoverFilesWithProjectCatalog } from "./discover";

/* Isolated roots: this suite scans a throwaway directory and never persists. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resource-scope-proc-"));
afterAll(() => fs.rmSync(isolated, { recursive: true, force: true }));

function baselineEntry(pathname: string, pid: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "fixture",
    title: "fixture session",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: Date.now() / 1_000 - 3_600,
    size: 128,
    activity: "stalled",
    activityReason: "jsonl_turn_stalled",
    proc: "running",
    pid,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

async function resourceScope(root: string, baseline: FileEntry): Promise<FileEntry | undefined> {
  let snapshot: { files: FileEntry[] } | undefined;
  await discoverFilesWithProjectCatalog([["codex-sessions", root]], undefined, {
    persist: false,
    resourceBaseline: { files: [baseline], projectCatalog: [], complete: true },
    onResourceSnapshot: (received) => { snapshot = received; },
  });
  return snapshot?.files.find((entry) => entry.path === baseline.path);
}

test("a carried-over running pid stops reading as a running process once it is gone", async () => {
  const root = fs.mkdtempSync(path.join(isolated, "dead-"));
  const pathname = path.join(root, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(pathname, "");

  /* The pid the host was recorded under is gone; the Viewer went on reporting
     `proc: running` against it for as long as the resource scope was in
     charge (#1282). */
  const carried = await resourceScope(root, baselineEntry(pathname, 2_000_000_001));

  expect(carried).toMatchObject({ proc: "done", pid: null });
});

test("a carried-over running pid that still exists is carried unchanged", async () => {
  const root = fs.mkdtempSync(path.join(isolated, "alive-"));
  const pathname = path.join(root, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(pathname, "");

  const carried = await resourceScope(root, baselineEntry(pathname, process.pid));

  expect(carried).toMatchObject({ proc: "running", pid: process.pid });
});
