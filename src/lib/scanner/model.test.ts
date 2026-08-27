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

/* OpenClaw fixtures (#1207). Every id, model and provider below is invented. */
function openclawEntry(pathname: string, lines: unknown[]): FileEntry {
  fs.writeFileSync(pathname, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "openclaw-sessions",
    name: path.basename(pathname),
    project: "proj",
    title: "session",
    engine: "openclaw",
    kind: "session",
    fmt: "openclaw",
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
}

function openclawAssistant(model: string, provider: string): Record<string, unknown> {
  return {
    type: "message",
    id: `oc-assistant-${model}-${provider}`,
    parentId: "oc-parent",
    timestamp: "2026-08-27T09:00:00.000Z",
    message: { role: "assistant", provider, model, api: "demo-api", stopReason: "stop", content: [] },
  };
}

test("an OpenClaw card shows the model the newest real provider record ran on", () => {
  const entry = openclawEntry(path.join(SANDBOX, "openclaw-model.jsonl"), [
    { type: "session", version: 3, id: "oc-session-alpha", timestamp: "2026-08-27T08:59:00.000Z", cwd: SANDBOX },
    openclawAssistant("demo-model-1", "demo-provider"),
    openclawAssistant("demo-model-2", "demo-provider"),
  ]);
  expect(entryModels(entry)).toEqual({ display: "demo-model-2", launch: "demo-model-2" });
});

test("a synthetic-provider record cannot replace the displayed OpenClaw model", () => {
  const entry = openclawEntry(path.join(SANDBOX, "openclaw-synthetic-model.jsonl"), [
    { type: "session", version: 3, id: "oc-session-beta", timestamp: "2026-08-27T08:59:00.000Z", cwd: SANDBOX },
    openclawAssistant("demo-model-1", "demo-provider"),
    openclawAssistant("delivery-mirror", "openclaw"),
  ]);
  expect(entryModels(entry)).toEqual({ display: "demo-model-1", launch: "demo-model-1" });
});

test("an OpenClaw session with only synthetic records reports no model", () => {
  const entry = openclawEntry(path.join(SANDBOX, "openclaw-only-synthetic.jsonl"), [
    { type: "session", version: 3, id: "oc-session-gamma", timestamp: "2026-08-27T08:59:00.000Z", cwd: SANDBOX },
    openclawAssistant("gateway-injected", "openclaw"),
  ]);
  expect(entryModels(entry)).toEqual({ display: null, launch: null });
});
