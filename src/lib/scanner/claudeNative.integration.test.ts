import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { readSession } from "@/lib/session/reader";

import type { RootKey } from "@/lib/types";

import { activityVerdict, transcriptTurnResult } from "./activity";
import { describe as describeFile } from "./describe";
import { discoverFilesWithProjectCatalog } from "./discover";

/**
 * Issue #339 — a fabricated Workflow subagent sidechain flows through the
 * scanner (title, activity, turn) and the session reader (messages, tools) the
 * same way a direct Claude subagent does. All prompts and identifiers here are
 * synthetic; assertions expose only classifications, counts, and these
 * fabricated values.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-native-"));
const REAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

afterAll(() => {
  if (REAL_STATE !== undefined) process.env.LLV_STATE_DIR = REAL_STATE;
  else delete process.env.LLV_STATE_DIR;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const ROOT = path.join(SANDBOX, "claude-projects");
const SLUG = "-home-agent-project";
const PARENT_SID = "11111111-2222-3333-4444-555555555555";
const DELEGATED_PROMPT = "Delegated subtask: audit the synthetic config loader";

function writeWorkflowChild(): string {
  const childDir = path.join(ROOT, SLUG, PARENT_SID, "subagents", "workflows", "wf-1");
  fs.mkdirSync(childDir, { recursive: true });
  const child = path.join(childDir, "agent-abc123.jsonl");
  const lines = [
    { type: "user", isSidechain: true, timestamp: "2026-07-20T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: DELEGATED_PROMPT }] } },
    { type: "assistant", isSidechain: true, timestamp: "2026-07-20T12:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", id: "toolu_synthetic_1", input: { file: "config.ts" } }] } },
  ];
  fs.writeFileSync(child, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  // Workflow bookkeeping beside the child — never a conversation.
  fs.writeFileSync(path.join(childDir, "journal.jsonl"), JSON.stringify({ event: "workflow_started" }) + "\n");
  return child;
}

test("a Workflow sidechain is described as a titled subagent from its first user message", () => {
  const child = writeWorkflowChild();
  const meta = describeFile("claude-projects", ROOT, child, fs.statSync(child));
  expect(meta.kind).toBe("subagent");
  expect(meta.title).toBe(DELEGATED_PROMPT);
});

test("an explicit sidecar name still wins over the transcript prompt", () => {
  const child = writeWorkflowChild();
  fs.writeFileSync(child.slice(0, -".jsonl".length) + ".meta.json", JSON.stringify({ name: "Config Auditor" }));
  const meta = describeFile("claude-projects", ROOT, child, fs.statSync(child));
  expect(meta.title).toBe("Config Auditor");
});

test("the sidechain yields real messages, tool activity, and an open turn state", () => {
  const child = writeWorkflowChild();
  const session = readSession(child, "claude");
  expect(session.messages.map((message) => message.text)).toContain(DELEGATED_PROMPT);
  expect(session.tools.length).toBeGreaterThan(0);

  const st = fs.statSync(child);
  // Trailing tool_use with no result → the subagent is mid-turn.
  expect(transcriptTurnResult(child, st.size, st.mtimeMs, false).turn.state).toBe("busy");
  const verdict = activityVerdict("claude-projects", child, st.mtimeMs / 1000, st.size);
  expect(verdict.reason).toBe("jsonl_turn_open");
});

test("discovery surfaces the Workflow subagent but never its journal bookkeeping", async () => {
  const child = writeWorkflowChild();
  const journal = path.join(path.dirname(child), "journal.jsonl");
  const roots: Record<RootKey, string> = {
    "codex-sessions": path.join(SANDBOX, "codex-sessions"),
    "claude-projects": ROOT,
    "claude-tasks": path.join(SANDBOX, "claude-tasks"),
  };
  fs.mkdirSync(roots["codex-sessions"], { recursive: true });
  fs.mkdirSync(roots["claude-tasks"], { recursive: true });

  const { files } = await discoverFilesWithProjectCatalog(roots, undefined, { persist: false });
  const paths = new Set(files.map((entry) => entry.path));
  expect(paths.has(child)).toBe(true);
  expect(paths.has(journal)).toBe(false);
  expect(files.find((entry) => entry.path === child)?.kind).toBe("subagent");
});
