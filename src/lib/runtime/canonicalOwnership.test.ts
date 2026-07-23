import { expect, test } from "bun:test";

import {
  CANONICAL_ASSISTANT_OWNERSHIP_LIMIT,
  parseCanonicalOwnershipClaim,
} from "./canonicalOwnership";

test("canonical ownership accepts bounded identity-only receipts", () => {
  expect(parseCanonicalOwnershipClaim({
    conversationId: "conversation-626",
    assistantItemIds: ["assistant-1", "assistant-1"],
    launchOutboxIds: ["launch-1"],
    outboxEntryIds: ["queued-1"],
  })).toEqual({
    conversationId: "conversation-626",
    assistantItemIds: ["assistant-1"],
    launchOutboxIds: ["launch-1"],
    outboxEntryIds: ["queued-1"],
  });
});

test("canonical ownership rejects content-bearing and oversized receipts", () => {
  expect(parseCanonicalOwnershipClaim({
    conversationId: "conversation-626",
    assistantItemIds: ["assistant-1"],
    text: "private transcript content",
  })).toBeNull();
  expect(parseCanonicalOwnershipClaim({
    conversationId: "conversation-626",
    assistantItemIds: Array.from(
      { length: CANONICAL_ASSISTANT_OWNERSHIP_LIMIT + 1 },
      (_, index) => `assistant-${index}`,
    ),
  })).toBeNull();
});
