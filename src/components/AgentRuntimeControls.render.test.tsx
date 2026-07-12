import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { AgentRuntimeControls } from "./AgentRuntimeControls";

function entry(engine: "claude" | "codex"): FileEntry {
  return {
    path: `/${engine}.jsonl`, root: engine === "codex" ? "codex-sessions" : "claude-projects",
    name: `${engine}.jsonl`, project: "viewer", title: engine, engine, kind: "session", fmt: engine,
    parent: null, mtime: 1, size: 1, activity: "idle", proc: "running", pid: 10,
    model: engine === "codex" ? "gpt-5.6-sol" : "sonnet", effort: "high", fast: engine === "codex",
    pendingQuestion: null, waitingInput: null,
  };
}

test("running codex controls expose model, effort, and speed", () => {
  const html = renderToStaticMarkup(<AgentRuntimeControls file={entry("codex")} />);
  expect(html).toContain('aria-label="Running agent model"');
  expect(html).toContain('aria-label="Running agent reasoning effort"');
  expect(html).toContain("fast");
  expect(html).toContain("GPT-5.6-Sol");
});

test("running claude controls hide the codex speed toggle", () => {
  const html = renderToStaticMarkup(<AgentRuntimeControls file={entry("claude")} />);
  expect(html).toContain("Sonnet");
  expect(html).not.toContain('type="checkbox"');
});
