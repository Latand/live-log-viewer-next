import { describe, expect, test } from "bun:test";

import { projectEngineHostEvent } from "./engineHostEvents";

describe("projectEngineHostEvent", () => {
  test("projects a Codex user-input request into a question card", () => {
    const projected = projectEngineHostEvent("conversation_one", "codex:thread-one", {
      kind: "attention",
      id: "attention-one",
      method: "item/tool/requestUserInput",
      attention: {
        turnId: "turn-one",
        questions: [{ id: "choice", header: "Choose", question: "Continue?", options: [{ label: "Yes", description: "Proceed" }] }],
      },
      seq: 7,
    });

    expect(projected).toMatchObject({
      kind: "attention",
      producer: { eventKey: "engine-host:codex:thread-one:7" },
      payload: {
        id: "attention-one",
        conversationId: "conversation_one",
        kind: "question",
        state: "open",
        turnId: "turn-one",
        request: { question: { header: "Choose", prompt: "Continue?", options: [{ label: "Yes", description: "Proceed" }] } },
      },
    });
  });

  test("projects Claude AskUserQuestion into a question card", () => {
    const projected = projectEngineHostEvent("conversation_two", "claude:session-one", {
      kind: "attention",
      id: "attention-two",
      method: "control_request",
      attention: {
        request_id: "attention-two",
        tool_name: "AskUserQuestion",
        input: { questions: [
          { header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "Focused" }] },
          { header: "Checks", question: "Which checks?", options: [{ label: "Tests", description: "Run tests" }], multiSelect: true },
        ] },
      },
      seq: 9,
    });

    expect(projected?.payload).toMatchObject({
      kind: "question",
      request: { tool: "AskUserQuestion", question: { header: "Scope", prompt: "Which scope?" } },
    });
    expect((projected?.payload.request as { questions?: unknown[] }).questions).toHaveLength(2);
  });

  test("keeps turn lifecycle payloads aligned with the runtime journal", () => {
    expect(projectEngineHostEvent("conversation_three", "codex:thread-two", {
      kind: "turn-ended",
      turnId: "turn-two",
      status: "interrupted",
      seq: 11,
    })).toMatchObject({
      kind: "turn-ended",
      payload: { conversationId: "conversation_three", turnId: "turn-two", outcome: "interrupted" },
    });
  });
});
