import { expect, test } from "bun:test";

import { needsDecisionPipelineRows } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildAttentionQueue } from "../attention";
import { buildMobileAttentionQueue, isCurrentAttentionEntry, nextMobileAttention } from "./attentionQueue";

/*
 * One list for the phone (README §4.1, §4.6): conversations waiting on the
 * operator and pipelines in `needs_decision`, joined in the board's order;
 * «Next ›» skips the item on screen and wraps.
 */

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function waiting(path: string, since: number): FileEntry {
  return {
    root: "claude-projects", name: path, path, project: PROJECT, title: path, engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: "opus", pendingQuestion: null,
    waitingInput: { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null },
  } as FileEntry;
}

function pipeline(id: string, state: Pipeline["state"], completedAt: number): Pipeline {
  return {
    id, task: `Lane ${id}`, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/1", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "review-loop" }],
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["one"] }, completedAt: new Date(completedAt * 1_000).toISOString() }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1_000).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const conversations = buildAttentionQueue([waiting("/p/new.jsonl", NOW - 100), waiting("/p/old.jsonl", NOW - 900)], NOW, PROJECT);
const pipelines = needsDecisionPipelineRows([pipeline("p-decide", "needs_decision", NOW - 3_600), pipeline("p-run", "running", NOW - 60)], PROJECT, NOW);

test("conversations and needs_decision pipelines are ONE list, conversations in queue order first, then the pipelines", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  expect(entries.map((entry) => `${entry.kind}:${entry.kind === "conversation" ? entry.item.file.path : entry.row.id}`)).toEqual([
    "conversation:/p/old.jsonl",
    "conversation:/p/new.jsonl",
    "pipeline:p-decide",
  ]);
  /* A running pipeline is not a decision, so it is not in the list — and the
     badge that counts this list agrees with the board's Needs-you section. */
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => entry.id.length > 0)).toBe(true);
});

test("Next from the board (nothing on screen) opens the head; backward opens the tail", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  expect(nextMobileAttention(entries, { kind: "board" })).toBe(entries[0]!);
  expect(nextMobileAttention(entries, null)).toBe(entries[0]!);
  expect(nextMobileAttention(entries, { kind: "board" }, -1)).toBe(entries[2]!);
});

test("Next skips the item the operator is looking at and wraps past the end, across both kinds", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  /* From the first conversation: the second. */
  expect(nextMobileAttention(entries, { kind: "chat", id: "/p/old.jsonl" })).toBe(entries[1]!);
  /* From the last conversation: the pipeline. */
  expect(nextMobileAttention(entries, { kind: "chat", id: "/p/new.jsonl" })).toBe(entries[2]!);
  /* From the pipeline: wraps to the first conversation. */
  expect(nextMobileAttention(entries, { kind: "pipeline", id: "p-decide" })).toBe(entries[0]!);
  /* Backward wraps the other way. */
  expect(nextMobileAttention(entries, { kind: "chat", id: "/p/old.jsonl" }, -1)).toBe(entries[2]!);
  /* A screen showing something not in the list is the same as the board. */
  expect(nextMobileAttention(entries, { kind: "chat", id: "/p/elsewhere.jsonl" })).toBe(entries[0]!);
  expect(nextMobileAttention(entries, { kind: "accounts" })).toBe(entries[0]!);
});

test("the item on screen is never the answer: one entry, and that one open, has no Next", () => {
  const only = buildMobileAttentionQueue(conversations.slice(0, 1), []);
  expect(nextMobileAttention(only, { kind: "chat", id: conversations[0]!.file.path })).toBeNull();
  expect(nextMobileAttention(only, { kind: "board" })).toBe(only[0]!);
  expect(nextMobileAttention([], { kind: "board" })).toBeNull();
});

test("the current entry is keyed the way the screens are: the conversation by its path, the pipeline by its id", () => {
  const entries = buildMobileAttentionQueue(conversations, pipelines);
  expect(isCurrentAttentionEntry(entries[0]!, { kind: "chat", id: "/p/old.jsonl" })).toBe(true);
  expect(isCurrentAttentionEntry(entries[0]!, { kind: "pipeline", id: "/p/old.jsonl" })).toBe(false);
  expect(isCurrentAttentionEntry(entries[2]!, { kind: "pipeline", id: "p-decide" })).toBe(true);
  expect(isCurrentAttentionEntry(entries[2]!, { kind: "chat", id: "p-decide" })).toBe(false);
  expect(isCurrentAttentionEntry(entries[2]!, null)).toBe(false);
});
