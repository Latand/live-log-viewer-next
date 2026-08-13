import { expect, test } from "bun:test";

import { parseIncumbent } from "./incumbent";

/* The panel's read of `GET /api/orchestrator/seat/status` (#978). The header
   renders numbers an operator judges rotation by, so a body it cannot trust must
   degrade to «unknown» rather than to a confident wrong figure. */

const body = {
  project: "atlas",
  designated: true,
  conversationId: "conversation_orchestrator",
  predecessorConversationId: "conversation_predecessor",
  engine: "claude",
  model: "opus",
  effort: "high",
  accountId: "work",
  cwd: "/repos/atlas",
  transcriptFacts: { bytes: 2_100_000, messageCount: 812, toolCount: 1_930, compactionCount: 1 },
  context: { tokens: 620_000, limit: 1_000_000, percent: 62, estimated: false, basis: "provider-reported usage", policy: "claude-opus-1m" },
  rotation: { recommended: true, level: "strongly_recommend", advisory: "STRONGLY_RECOMMEND_ROTATION", reasons: ["context usage 620,000 tokens"], threshold: {}, thresholdUnknown: false },
};

test("a well-formed reading keeps every field the header renders from", () => {
  const incumbent = parseIncumbent(body)!;
  expect(incumbent).toMatchObject({
    designated: true,
    engine: "claude",
    model: "opus",
    effort: "high",
    accountId: "work",
    predecessorConversationId: "conversation_predecessor",
  });
  expect(incumbent.context).toMatchObject({ tokens: 620_000, percent: 62, estimated: false });
  expect(incumbent.rotation).toMatchObject({ recommended: true, level: "strongly_recommend", reasons: ["context usage 620,000 tokens"] });
  expect(incumbent.transcriptFacts).toMatchObject({ bytes: 2_100_000, compactionCount: 1 });
});

test("a body that names no project is not a reading at all", () => {
  expect(parseIncumbent(null)).toBeNull();
  expect(parseIncumbent([])).toBeNull();
  expect(parseIncumbent({ designated: true })).toBeNull();
});

test("a vacant seat reports nothing about an incumbent, rather than half of one", () => {
  const incumbent = parseIncumbent({ project: "atlas", designated: false, engine: null, context: null, rotation: null })!;
  expect(incumbent).toMatchObject({ designated: false, engine: null, model: null, context: null, rotation: null });
});

test("a malformed number is unknown — never zero, which would read as an empty context window", () => {
  const incumbent = parseIncumbent({
    ...body,
    context: { tokens: "lots", limit: null, percent: "62", estimated: false, basis: 7 },
  })!;
  expect(incumbent.context).toEqual({ tokens: null, limit: null, percent: null, estimated: false, basis: "" });
});

test("an unrecognised engine or level degrades instead of leaking through", () => {
  const incumbent = parseIncumbent({
    ...body,
    engine: "gemini",
    rotation: { recommended: true, level: "panic", reasons: ["a reason", 7, null], thresholdUnknown: true },
  })!;
  expect(incumbent.engine).toBeNull();
  /* The server's own boolean still stands; only the wording softens. */
  expect(incumbent.rotation).toEqual({ recommended: true, level: "none", reasons: ["a reason"], thresholdUnknown: true });
});
