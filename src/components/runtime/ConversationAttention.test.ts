import { expect, test } from "bun:test";

import type { RuntimeAttention } from "./runtimeModel";
import { approvalResolution, questionResolution, questionsResolution } from "./ConversationAttention";

function attention(engine: "codex" | "claude"): RuntimeAttention {
  return {
    id: "question-one",
    conversationId: "conversation-one",
    kind: "question",
    state: "open",
    unowned: false,
    createdAt: "2026-07-14T00:00:00.000Z",
    request: {
      question: { prompt: "Continue?", options: [{ label: "Yes" }] },
      protocol: {
        engine,
        method: engine === "codex" ? "item/tool/requestUserInput" : "control_request",
        questionId: "scope",
        input: { questions: [{ question: "Continue?" }] },
      },
    },
  };
}

test("Codex question cards emit requestUserInput answers", () => {
  expect(questionResolution(attention("codex"), 0)).toEqual({
    answers: { scope: { answers: ["Yes"] } },
  });
});

test("Claude question cards emit permission-tool input updates", () => {
  expect(questionResolution(attention("claude"), 0)).toEqual({
    behavior: "allow",
    updatedInput: { questions: [{ question: "Continue?" }], answers: { "Continue?": "Yes" } },
  });
});

test("Codex multi-question cards return every selected answer", () => {
  const request = attention("codex");
  request.request.questions = [
    { prompt: "First?", options: [{ label: "One" }] },
    { prompt: "Second?", options: [{ label: "Two" }, { label: "Three" }], multiSelect: true },
  ];
  request.request.protocol!.questionIds = ["first", "second"];
  expect(questionsResolution(request, [[0], [0, 1]])).toEqual({
    answers: {
      first: { answers: ["One"] },
      second: { answers: ["Two", "Three"] },
    },
  });
});

test("subscription host approval responses match each engine protocol", () => {
  expect(approvalResolution(attention("codex"), true)).toEqual({ decision: "accept" });
  expect(approvalResolution(attention("claude"), true)).toEqual({ behavior: "allow" });
  expect(approvalResolution(attention("claude"), false)).toEqual({ behavior: "deny", message: "Denied in Viewer" });
});
