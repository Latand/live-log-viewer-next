import path from "node:path";

import { expect, test } from "bun:test";

import {
  claudeSubagentLineage,
  claudeSubagentParentPath,
  isClaudeSubagentLeafPath,
  isClaudeWorkflowBookkeeping,
} from "./claudeNative";

const slug = "-home-agent-project";
const sid = "11111111-2222-3333-4444-555555555555";

test("direct and Workflow subagent paths resolve the same root-parent grammar", () => {
  const direct = path.join(slug, sid, "subagents", "agent-aaaa.jsonl");
  const nested = path.join(slug, sid, "subagents", "workflows", "wf-1", "agent-bbbb.jsonl");

  const directLineage = claudeSubagentLineage(direct);
  const nestedLineage = claudeSubagentLineage(nested);

  expect(directLineage?.parentName).toBe(path.join(slug, `${sid}.jsonl`));
  expect(nestedLineage?.parentName).toBe(path.join(slug, `${sid}.jsonl`));
  expect(directLineage?.nestedSegments).toEqual([]);
  expect(nestedLineage?.nestedSegments).toEqual(["workflows", "wf-1"]);
  expect(directLineage?.parentSessionId).toBe(sid);
  expect(nestedLineage?.parentSessionId).toBe(sid);
});

test("absolute parent path is lexical and survives a non-existent root", () => {
  const root = "/nonexistent/claude-projects";
  const child = path.join(root, slug, sid, "subagents", "workflows", "wf-1", "agent-bbbb.jsonl");
  expect(claudeSubagentParentPath(root, child)).toBe(path.join(root, slug, `${sid}.jsonl`));
});

test("non-subagent and out-of-root paths are rejected", () => {
  expect(claudeSubagentLineage(path.join(slug, `${sid}.jsonl`))).toBeNull();
  expect(claudeSubagentLineage(path.join(slug, sid, "subagents", "notes.txt"))).toBeNull();
  expect(claudeSubagentLineage(path.join("..", "escape", "agent-x.jsonl"))).toBeNull();
  expect(claudeSubagentParentPath("/root", "/elsewhere/agent-x.jsonl")).toBeNull();
});

test("subagent leaf paths are recognized lexically without a registered root", () => {
  const abs = `/home/user/.claude/projects/${slug}/${sid}/subagents/workflows/wf-1/agent-bbbb.jsonl`;
  expect(isClaudeSubagentLeafPath(abs)).toBe(true);
  expect(isClaudeSubagentLeafPath(`/home/user/.claude/projects/${slug}/${sid}/subagents/agent-a.jsonl`)).toBe(true);
  expect(isClaudeSubagentLeafPath(`/home/user/.claude/projects/${slug}/${sid}.jsonl`)).toBe(false);
  expect(isClaudeSubagentLeafPath(`/home/user/.claude/projects/${slug}/subagents/session.jsonl`)).toBe(false);
});

test("Workflow journal and metadata files classify as bookkeeping", () => {
  expect(isClaudeWorkflowBookkeeping(path.join(slug, sid, "subagents", "workflows", "wf-1", "journal.jsonl"))).toBe(true);
  expect(isClaudeWorkflowBookkeeping(path.join(slug, sid, "subagents", "agent-aaaa.meta.json"))).toBe(true);
  expect(isClaudeWorkflowBookkeeping(path.join(slug, sid, "subagents", "agent-aaaa.jsonl"))).toBe(false);
  expect(isClaudeWorkflowBookkeeping(path.join(slug, `${sid}.jsonl`))).toBe(false);
});
