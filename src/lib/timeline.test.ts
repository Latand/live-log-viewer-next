import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "./types";
import { projectTimeline } from "./timeline";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-timeline-cache-test-"));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function entry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "timeline-project",
    title: "Timeline actor",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function agentMessage(message: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    payload: { type: "agent_message", message },
  }) + "\n";
}

test("timeline cache invalidates a same-size rewrite by mtime", () => {
  const pathname = path.join(SANDBOX, "same-size.jsonl");
  fs.writeFileSync(pathname, agentMessage("alpha"));
  const first = entry(pathname);
  expect(projectTimeline([first], first.project, 10).map((event) => event.label)).toEqual(["alpha"]);

  fs.writeFileSync(pathname, agentMessage("bravo"));
  fs.utimesSync(pathname, new Date(), new Date(first.mtime * 1000 + 1_000));
  const rewritten = entry(pathname);
  expect(rewritten.size).toBe(first.size);
  expect(projectTimeline([rewritten], rewritten.project, 10).map((event) => event.label)).toEqual(["bravo"]);
});

test("an incomplete timeline read stays retryable for the same identity", () => {
  const pathname = path.join(SANDBOX, "retryable-eio.jsonl");
  fs.writeFileSync(pathname, agentMessage("recovered"));
  const file = entry(pathname);
  const originalOpenSync = fs.openSync;
  let blocked = true;
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (blocked && path.resolve(String(target)) === pathname) {
      const error = new Error("timeline EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
  }) as typeof fs.openSync;
  try {
    expect(projectTimeline([file], file.project, 10)).toEqual([]);
    blocked = false;
    expect(projectTimeline([file], file.project, 10).map((event) => event.label)).toEqual(["recovered"]);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

/* Issue #1207: an OpenClaw conversation reaches a project's recent-actions
   timeline like any other. Its records wrap every role in a top-level
   `message` envelope, so neither the Claude nor the Codex arm sees one and the
   card would otherwise be scanned, attributed, rendered — and then contribute
   nothing here. Every identifier below is invented. */
test("an OpenClaw conversation contributes its prompts and answers to the timeline", () => {
  const pathname = path.join(SANDBOX, "oc-session-alpha.jsonl");
  const started = Date.now() - 60_000;
  const at = (offset: number) => new Date(started + offset).toISOString();
  const message = (id: string, offset: number, message: Record<string, unknown>) =>
    JSON.stringify({ type: "message", id, parentId: "oc-parent", timestamp: at(offset), message }) + "\n";
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session", version: 3, id: "oc-header", timestamp: at(0), cwd: SANDBOX }) + "\n",
    message("oc-user-1", 1_000, { role: "user", content: "Plant the cobalt orchard", timestamp: at(1_000) }),
    message("oc-assistant-1", 2_000, {
      role: "assistant",
      provider: "demo-provider",
      model: "demo-model",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "oc-call-1", name: "Bash", arguments: { command: "plant" } }],
    }),
    message("oc-result-1", 3_000, { role: "toolResult", toolCallId: "oc-call-1", isError: false, content: [{ type: "text", text: "planted" }] }),
    message("oc-assistant-2", 4_000, {
      role: "assistant",
      provider: "demo-provider",
      model: "demo-model",
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "not an action" }, { type: "text", text: "Three rows are in." }],
    }),
  ].join(""));
  const file = entry(pathname, { root: "openclaw-sessions", engine: "openclaw", fmt: "openclaw" });

  expect(projectTimeline([file], file.project, 10).map((event) => [event.kind, event.label]))
    .toEqual([["turn", "Three rows are in."], ["user", "Plant the cobalt orchard"]]);
});
