import { expect, test } from "bun:test";

import type { DurableConversationMembership } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";
import { projectRestoredFlows } from "./visibility";

test("a pinned reviewer restores its closed flow with every persisted round", () => {
  const implementerId = "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
  const reviewerId = "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1327";
  const flow = {
    id: "flow-hidden",
    state: "closed",
    implementerPath: "/implementer.jsonl",
    implementerConversationId: implementerId,
    rounds: [{ n: 1, reviewerPath: "/old-reviewer.jsonl", reviewerConversationId: reviewerId }],
  } as Flow;
  const reviewer = { path: "/resumed-reviewer.jsonl", conversationId: reviewerId } as FileEntry;
  const membership = {
    conversationId: reviewerId,
    kind: "flow",
    containerId: flow.id,
    role: "reviewer",
    slot: "reviewer:1",
    stageId: null,
    stageOrder: 1,
    round: 1,
    parentConversationId: implementerId,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as DurableConversationMembership;

  expect(projectRestoredFlows([flow], [reviewer], {
    pinnedPaths: new Set([reviewer.path]),
    memberships: { [reviewerId]: [membership] },
  })[0]).toMatchObject({ id: flow.id, state: "closed", restored: true, rounds: [{ n: 1 }] });
});
