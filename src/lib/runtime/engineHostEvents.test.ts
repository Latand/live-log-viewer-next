import { describe, expect, test } from "bun:test";

import { streamingVoiceDelivery } from "./voiceDelivery";
import { projectEngineHostEvent } from "./engineHostEvents";
import { completeRuntimeLiveTurnItem, runtimeLiveTurnItems } from "./liveTurn";

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

  test("attention resolutions carry the attentionId every reducer keys on (#765)", () => {
    /* The journal prunes by `payload.attentionId` and the client store reads
       the same field; a payload carrying only `id` retired the card nowhere. */
    expect(projectEngineHostEvent("conversation_four", "claude:session-two", {
      kind: "attention-resolved",
      id: "attention-four",
      resolution: "server-resolved",
      seq: 13,
    })).toMatchObject({
      kind: "attention-resolved",
      payload: { attentionId: "attention-four", id: "attention-four", conversationId: "conversation_four", state: "resolved" },
    });
  });

  test("a turn-ended resolution retires the question as cancelled, not answered (#765)", () => {
    expect(projectEngineHostEvent("conversation_five", "claude:session-three", {
      kind: "attention-resolved",
      id: "attention-five",
      resolution: "turn-ended",
      seq: 17,
    })).toMatchObject({
      kind: "attention-resolved",
      payload: { attentionId: "attention-five", state: "cancelled", resolution: "turn-ended" },
    });
  });

  test("projects the full terminal assistant response separately from the bounded UI item", () => {
    const text = `${"🙂界".repeat(40_000)}\n`;
    const projected = projectEngineHostEvent("conversation_voice", "codex:thread-voice", {
      kind: "item",
      turnId: "turn-voice",
      item: { type: "agentMessage", id: "response-voice", text },
      phase: "completed",
      seq: 12,
    });

    expect(projected?.payload.item).toEqual({
      truncated: true,
      id: "response-voice",
      type: "agentMessage",
    });
    expect(projected?.payload.voiceResponse).toEqual({
      responseId: "response-voice",
      text,
    });
    expect(new TextEncoder().encode((projected?.payload.voiceResponse as { text: string }).text).length)
      .toBeGreaterThan(64 * 1024);
  });

  test("projects an early semantic chunk and lets an explicit terminal override suppress replay", () => {
    const delivery = streamingVoiceDelivery({
      sourceTurnId: "turn-stream",
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 19,
      text: "substantial phrase ",
    });
    expect(projectEngineHostEvent("conversation_voice", "codex:thread-voice", {
      kind: "voice-chunk",
      turnId: "turn-stream",
      delivery,
      seq: 13,
    })).toMatchObject({
      kind: "voice-chunk",
      payload: { conversationId: "conversation_voice", turnId: "turn-stream", voiceDelivery: delivery },
    });
    expect(projectEngineHostEvent("conversation_voice", "codex:thread-voice", {
      kind: "item",
      turnId: "turn-stream",
      item: { type: "agentMessage", id: "response-stream", text: "substantial phrase " },
      phase: "completed",
      voiceResponse: null,
      seq: 14,
    })?.payload.voiceResponse).toBeUndefined();
  });

  test("projects durable receiver acknowledgement onto the pending session delivery", () => {
    expect(projectEngineHostEvent("conversation_voice", "codex:thread-voice", {
      kind: "realtime-delivery-acknowledged",
      deliveryId: "voice-delivery-one",
      digest: "digest-one",
      seq: 13,
    })).toMatchObject({
      kind: "voice-delivery-acknowledged",
      payload: {
        conversationId: "conversation_voice",
        deliveryId: "voice-delivery-one",
      },
    });
  });

  test("does not retain canonical voice payloads for Claude sessions that cannot open Live Mode", () => {
    const projected = projectEngineHostEvent("conversation_claude", "claude:session-one", {
      kind: "item",
      turnId: "turn-claude",
      item: { type: "assistant", id: "response-claude", text: "completed" },
      phase: "completed",
      seq: 14,
    });
    expect(projected?.payload.voiceResponse).toBeUndefined();
  });

  test("preserves bounded live tool descriptors when completed engine items carry large result bodies", () => {
    const command = "bun test src/lib/runtime/engineHostEvents.test.ts";
    const codex = projectEngineHostEvent("conversation_codex_tool", "codex:thread-tool", {
      kind: "item",
      turnId: "turn-codex-tool",
      item: {
        type: "commandExecution",
        id: "codex-tool-item",
        command,
        cwd: "$HOME/project",
        aggregatedOutput: "x".repeat(32 * 1024),
      },
      phase: "completed",
      seq: 15,
    });
    expect(codex?.payload.item).toMatchObject({
      type: "commandExecution",
      id: "codex-tool-item",
      command,
      cwd: "$HOME/project",
    });
    expect(JSON.stringify(codex?.payload.item)).not.toContain("aggregatedOutput");

    const claude = projectEngineHostEvent("conversation_claude_tool", "claude:session-tool", {
      kind: "item",
      turnId: "turn-claude-tool",
      item: {
        type: "assistant",
        uuid: "claude-tool-message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "p".repeat(30 * 1024) },
            {
              type: "tool_use",
              id: "claude-tool-item",
              name: "Bash",
              input: { command: `apply_patch ${"x".repeat(32 * 1024)}` },
            },
          ],
        },
      },
      phase: "completed",
      seq: 16,
    });
    expect(claude?.payload.item).toMatchObject({
      type: "assistant",
      uuid: "claude-tool-message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "p".repeat(30 * 1024) },
          {
            type: "tool_use",
            id: "claude-tool-item",
            name: "Bash",
            input: { command: expect.stringContaining("apply_patch") },
          },
        ],
      },
    });
    expect(JSON.stringify(claude?.payload.item).length).toBeLessThan(64 * 1024);

    const oversized = projectEngineHostEvent("conversation_claude_tool", "claude:session-tool", {
      kind: "item",
      turnId: "turn-claude-tool",
      item: {
        type: "assistant",
        uuid: "claude-oversized-message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "large prose ".repeat(6 * 1024) },
            { type: "tool_use", id: "claude-small-tool", name: "Read", input: { file_path: "src/lib/runtime/liveTurn.ts" } },
          ],
        },
      },
      phase: "completed",
      seq: 17,
    });
    const live = completeRuntimeLiveTurnItem(
      null,
      "turn-claude-tool",
      oversized?.payload.item,
      "2026-08-06T10:10:00.000Z",
    );
    expect(runtimeLiveTurnItems(live)[0]).toMatchObject({
      kind: "assistant",
      omittedChars: expect.any(Number),
    });
    expect(runtimeLiveTurnItems(live)[0]?.omittedChars).toBeGreaterThan(0);
  });
});
