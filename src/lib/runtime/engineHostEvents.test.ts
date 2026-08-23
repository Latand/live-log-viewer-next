import { describe, expect, test } from "bun:test";

import { streamingVoiceDelivery } from "./voiceDelivery";
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

  test("issue 1100: an oversized Claude tool call keeps its call identity and bounded arguments", () => {
    const content = "line of generated source\n".repeat(2_000);
    const projected = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "assistant",
        uuid: "uuid-big-write",
        message: { id: "msg_big", role: "assistant", content: [
          { type: "text", text: "Writing the file now." },
          { type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: "/repo/src/generated.ts", content } },
        ] },
      },
      phase: "completed",
      seq: 21,
    });
    const item = projected?.payload.item as Record<string, unknown>;
    expect(item).toMatchObject({ truncated: true, type: "assistant", uuid: "uuid-big-write", message: { id: "msg_big", role: "assistant" } });
    const blocks = (item.message as { content: Array<Record<string, unknown>> }).content;
    /* Prose keeps its type only — the streamed deltas already carry the text and
       a clipped authoritative body must not overwrite them. */
    expect(blocks[0]).toEqual({ type: "text" });
    expect(blocks[1]).toMatchObject({ type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: "/repo/src/generated.ts" } });
    expect([...String((blocks[1]!.input as Record<string, unknown>).content)].length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
  });

  test("issue 1100: an oversized Codex tool item keeps id, status and a clipped command, never its output", () => {
    const projected = projectEngineHostEvent("conversation_tools", "codex:thread-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "commandExecution",
        id: "call_big",
        command: "cat huge.log",
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "x".repeat(20_000),
      },
      phase: "completed",
      seq: 22,
    });
    expect(projected?.payload.item).toEqual({
      truncated: true,
      id: "call_big",
      type: "commandExecution",
      exitCode: 0,
      status: "completed",
      command: "cat huge.log",
      cwd: "/repo",
    });
    /* A result message of many tool_results stays identity-only as well. */
    const results = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "user",
        uuid: "uuid-results",
        message: { role: "user", content: Array.from({ length: 40 }, (_, index) => ({
          type: "tool_result", tool_use_id: `toolu_${index}`, is_error: index % 2 === 1, content: "y".repeat(1_000),
        })) },
      },
      phase: "completed",
      seq: 23,
    });
    const blocks = ((results?.payload.item as { message: { content: unknown[] } }).message.content);
    expect(blocks).toHaveLength(16);
    expect(blocks[1]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", is_error: true });
    expect(JSON.stringify(results)).not.toContain("yyyy");
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
});
