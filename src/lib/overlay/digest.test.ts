import { expect, test } from "bun:test";

import { chipCommandOrigin, classifyDigestEvent, compactDigest, digestChips, seenAfterRender, type DigestEvent } from "./digest";

const event = (eventId: string, kind: string, at: string): DigestEvent => ({
  eventId,
  kind,
  summary: `${kind} happened`,
  at,
});

test("verdicts, failures and deploy results prompt; ordinary churn is routine", () => {
  expect(classifyDigestEvent("review-verdict")).toBe("prompt");
  expect(classifyDigestEvent("stage-failed")).toBe("prompt");
  expect(classifyDigestEvent("stage-blocked")).toBe("prompt");
  expect(classifyDigestEvent("deploy-failed")).toBe("prompt");
  expect(classifyDigestEvent("delivery-expired")).toBe("prompt");

  expect(classifyDigestEvent("stage-started")).toBe("routine");
  expect(classifyDigestEvent("stage-resumed")).toBe("routine");
  expect(classifyDigestEvent("progress")).toBe("routine");
  /* Anything unrecognised is routine: an unknown event is not a reason to
     interrupt somebody. */
  expect(classifyDigestEvent("something-new")).toBe("routine");
});

test("compact holds one chip and folds the rest into a counter", () => {
  const chips = digestChips([
    event("e1", "stage-started", "2026-07-01T10:00:00.000Z"),
    event("e2", "stage-started", "2026-07-01T10:01:00.000Z"),
    event("e3", "review-verdict", "2026-07-01T10:02:00.000Z"),
    event("e4", "stage-started", "2026-07-01T10:03:00.000Z"),
  ]);

  const compact = compactDigest(chips);

  /* 108px of timeline cannot be a feed: the newest unacknowledged one shows and
     the others become "+3 updates", which expands by growing the window. */
  expect(compact.chip!.eventId).toBe("e4");
  expect(compact.foldedCount).toBe(3);
});

test("a chip already seen stops competing for the single compact slot", () => {
  const chips = digestChips(
    [event("e1", "review-verdict", "2026-07-01T10:00:00.000Z"), event("e2", "stage-started", "2026-07-01T10:01:00.000Z")],
    new Set(["e2"]),
  );

  expect(compactDigest(chips).chip!.eventId).toBe("e1");
  expect(compactDigest(chips).foldedCount).toBe(0);
});

test("a buried window does not silently consume its own notifications", () => {
  const chips = digestChips([event("e1", "review-verdict", "2026-07-01T10:00:00.000Z")]);

  expect(seenAfterRender(chips, { visible: true, atTail: true })).toEqual(new Set(["e1"]));
  /* Rendered somewhere nobody is looking, or scrolled back from the tail, it
     stays in the counter. */
  expect(seenAfterRender(chips, { visible: false, atTail: true })).toEqual(new Set());
  expect(seenAfterRender(chips, { visible: true, atTail: false })).toEqual(new Set());
});

test("tapping a chip is the operator's own act, never the journal's", () => {
  /* Which is exactly what keeps D4 intact: the journal signals, and only the
     operator or the root agent may move a view. */
  expect(chipCommandOrigin()).toBe("operator");
});

test("a chip carries the journal's one-liner and nothing else", () => {
  const [chip] = digestChips([{
    eventId: "e1",
    kind: "review-verdict",
    summary: "Review finished: request-changes.",
    at: "2026-07-01T10:00:00.000Z",
    focus: { conversationPath: "/tmp/reviewer.jsonl" },
  }]);

  expect(Object.keys(chip!).sort()).toEqual(["at", "digestClass", "eventId", "focus", "kind", "seen", "summary"]);
  expect(chip!.summary).toBe("Review finished: request-changes.");
});
