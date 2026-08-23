import { describe, expect, test } from "bun:test";

import { streamingVoiceDelivery } from "./voiceDelivery";
import { projectEngineHostEvent } from "./engineHostEvents";
import { normalizeRuntimeLiveTurn, projectRuntimeLiveTurnItem, runtimeLiveTurnItems } from "./liveTurn";

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
    /* Prose is dropped — the streamed deltas already carry the text and a
       clipped authoritative body must not overwrite them; the call stays. */
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: "/repo/src/generated.ts" } });
    expect([...String((blocks[0]!.input as Record<string, unknown>).content)].length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
  });

  test("issue 1100 review: an oversized Claude message keeps EVERY tool call and result identity past the 16th block, end to end", () => {
    /* 24 parallel calls with large inputs in ONE message: bounded arguments do
       not fit 8 KiB, so the projection falls back to identity-only calls — and
       every one of them reaches the live turn as a row that says its arguments
       were omitted. */
    const calls = Array.from({ length: 24 }, (_, index) => ({
      type: "tool_use", id: `toolu_many_${index}`, name: index % 2 ? "Read" : "Bash",
      input: { command: `echo ${index} && ${"x".repeat(600)}`, file_path: `/repo/file-${index}.ts` },
    }));
    const projected = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "assistant", uuid: "uuid-many", message: { id: "msg_many", role: "assistant", content: [{ type: "text", text: "Fanning out." }, ...calls] } },
      phase: "completed",
      seq: 31,
    });
    const item = projected?.payload.item as Record<string, unknown>;
    expect(item.truncated).toBeTrue();
    const blocks = (item.message as { content: Array<Record<string, unknown>>; omittedToolCalls?: number }).content;
    expect(blocks.map((block) => block.id)).toEqual(calls.map((call) => call.id));
    expect((item.message as { omittedToolCalls?: number }).omittedToolCalls).toBeUndefined();
    expect(blocks.every((block) => block.inputOmitted === true)).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
    const rows = runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", item, "completed", "2026-08-23T09:00:00.000Z"));
    expect(rows.filter((row) => row.tool).map((row) => row.itemId)).toEqual(calls.map((call) => call.id));
    expect(rows.filter((row) => row.tool).every((row) => row.tool?.argsOmitted === true && row.tool.status === "run")).toBeTrue();

    /* Their 24 results in one user message (beyond the old 16-block cut): every
       call id survives with its outcome, so every row settles. */
    const results = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "user", uuid: "uuid-many-results",
        message: { role: "user", content: calls.map((call, index) => ({
          type: "tool_result", tool_use_id: call.id, is_error: index === 23, content: "z".repeat(2_000),
        })) },
      },
      phase: "completed",
      seq: 32,
    });
    const resultBlocks = ((results?.payload.item as { message: { content: Array<Record<string, unknown>> } }).message.content);
    expect(resultBlocks).toHaveLength(24);
    expect(resultBlocks[23]).toEqual({ type: "tool_result", tool_use_id: "toolu_many_23", is_error: true });
    expect(JSON.stringify(results)).not.toContain("zzzz");
    let live = projectRuntimeLiveTurnItem(null, "turn-tools", item, "completed", "2026-08-23T09:00:00.000Z");
    live = projectRuntimeLiveTurnItem(live, "turn-tools", results?.payload.item, "completed", "2026-08-23T09:00:01.000Z");
    const settled = runtimeLiveTurnItems(live).filter((row) => row.tool);
    expect(settled).toHaveLength(24);
    expect(settled.map((row) => row.tool?.status)).toEqual([...Array.from({ length: 23 }, () => "ok" as const), "err" as const]);
  });

  test("issue 1100 review: 20 calls oversized by one large input keep all 20 rows WITH arguments (the reviewer's probe)", () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({
      type: "tool_use", id: `toolu_probe_${index}`, name: index === 0 ? "Write" : "Bash",
      input: index === 0 ? { file_path: "/repo/big.ts", content: "w".repeat(20_000) } : { command: `echo ${index}` },
    }));
    const projected = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "assistant", uuid: "uuid-probe", message: { id: "msg_probe", role: "assistant", content: calls } },
      phase: "completed",
      seq: 34,
    });
    const item = projected?.payload.item as Record<string, unknown>;
    expect(item.truncated).toBeTrue();
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
    const rows = runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", item, "completed", "2026-08-23T09:00:00.000Z")).filter((row) => row.tool);
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.itemId)).toEqual(calls.map((call) => call.id));
    expect(rows.every((row) => !row.tool?.argsOmitted)).toBeTrue();
    expect(rows[5]?.tool?.args).toEqual({ command: "echo 5" });
    expect(String(rows[0]?.tool?.args.content).length).toBeLessThanOrEqual(256);
  });

  test("issue 1100 review: when even the identities overflow, the dropped tail is counted and the live turn shows the omission", () => {
    /* Pathological: hundreds of calls whose ids alone exceed the 8 KiB item
       bound. The leading identities that fit survive in order; the rest are
       counted on the message rather than silently lost. */
    const calls = Array.from({ length: 400 }, (_, index) => ({
      type: "tool_use", id: `toolu_flood_${String(index).padStart(4, "0")}_${"i".repeat(40)}`, name: "Read", input: { file_path: `/repo/${index}.ts` },
    }));
    const projected = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "assistant", uuid: "uuid-flood", message: { id: "msg_flood", role: "assistant", content: calls } },
      phase: "completed",
      seq: 33,
    });
    const item = projected?.payload.item as Record<string, unknown>;
    const message = item.message as { content: Array<Record<string, unknown>>; omittedToolCalls?: number };
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
    expect(message.content.length).toBeGreaterThan(0);
    expect(message.content.length).toBeLessThan(400);
    expect(message.omittedToolCalls).toBe(400 - message.content.length);
    expect(message.content.map((block) => block.id)).toEqual(calls.slice(0, message.content.length).map((call) => call.id));
    let live = projectRuntimeLiveTurnItem(null, "turn-tools", item, "completed", "2026-08-23T09:00:00.000Z");
    /* A replayed item (refresh / journal replay) must not stack a second marker. */
    live = projectRuntimeLiveTurnItem(live, "turn-tools", item, "completed", "2026-08-23T09:00:00.000Z");
    const rows = runtimeLiveTurnItems(live);
    const omission = rows.filter((row) => !row.tool && (row.omittedItems ?? 0) > 0);
    expect(omission).toHaveLength(1);
    expect(omission[0]?.omittedItems).toBe(message.omittedToolCalls);
    /* Explicit accounting across the whole bounded window: rows shown plus
       rows declared omitted equals the calls the message issued — the 544
       descriptor bound folds the oldest rows into the same count. */
    const shownTools = rows.filter((row) => row.tool).length;
    const foldedAway = rows.reduce((total, row) => total + (row.tool ? 0 : (row.omittedItems ?? 0)), 0);
    expect(shownTools + foldedAway).toBe(400);
  });

  test("issue 1100 review: an oversized result batch cannot leave calls running — retained results settle their rows, omitted outcomes settle as `unknown`, a dropped failure never reads as ok (the reviewer's 400-result probe)", () => {
    const at = (second: number) => `2026-08-23T09:00:${String(second).padStart(2, "0")}.000Z`;
    const calls = Array.from({ length: 400 }, (_, index) => ({
      type: "tool_use", id: `toolu_batch_${String(index).padStart(4, "0")}_${"i".repeat(40)}`, name: "Read", input: { file_path: `/repo/${index}.ts` },
    }));
    /* 400 calls issued across 16 ordinary messages: every call is a running row. */
    let live = null as ReturnType<typeof projectRuntimeLiveTurnItem>;
    for (let message = 0; message < 16; message += 1) {
      const projected = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
        kind: "item",
        turnId: "turn-tools",
        item: { type: "assistant", uuid: `uuid-batch-${message}`, message: { id: `msg_batch_${message}`, role: "assistant", content: calls.slice(message * 25, message * 25 + 25) } },
        phase: "completed",
        seq: 100 + message,
      });
      live = projectRuntimeLiveTurnItem(live, "turn-tools", projected?.payload.item, "completed", at(message));
    }
    expect(runtimeLiveTurnItems(live).filter((row) => row.tool)).toHaveLength(400);
    expect(runtimeLiveTurnItems(live).every((row) => !row.tool || row.tool.status === "run")).toBeTrue();

    /* ONE user message with all 400 results, each with a body: the identities
       alone overflow the item bound, so the leading results survive and the
       trailing ones — the last call's failure among them — are counted. */
    const results = projectEngineHostEvent("conversation_tools", "claude:session-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "user", uuid: "uuid-batch-results",
        message: { role: "user", content: calls.map((call, index) => ({
          type: "tool_result", tool_use_id: call.id, is_error: index === 5 || index === 399, content: "z".repeat(2_000),
        })) },
      },
      phase: "completed",
      seq: 120,
    });
    const item = results?.payload.item as Record<string, unknown>;
    const message = item.message as { content: Array<Record<string, unknown>>; omittedToolResults?: number };
    expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.stringify(item)).not.toContain("zzzz");
    expect(message.content.length).toBeGreaterThan(0);
    expect(message.content.length).toBeLessThan(400);
    expect(message.omittedToolResults).toBe(400 - message.content.length);

    live = projectRuntimeLiveTurnItem(live, "turn-tools", item, "completed", at(20));
    /* Replay of the same bounded message must not change anything. */
    const once = JSON.stringify(live);
    live = projectRuntimeLiveTurnItem(live, "turn-tools", item, "completed", at(20));
    expect(JSON.stringify(live)).toBe(once);

    const rows = runtimeLiveTurnItems(live).filter((row) => row.tool);
    expect(rows).toHaveLength(400);
    expect(rows.filter((row) => row.tool?.status === "run")).toHaveLength(0);
    const kept = message.content.length;
    /* Retained results carry their real outcome, in order. */
    expect(rows.slice(0, kept).map((row) => row.tool?.status)).toEqual(calls.slice(0, kept).map((_, index) => (index === 5 ? "err" : "ok")));
    /* Every omitted outcome is accounted on its own row: exactly the count the
       message declared, none of them claiming success — the dropped failure of
       the last call included. */
    const unknown = rows.filter((row) => row.tool?.status === "unknown");
    expect(unknown).toHaveLength(message.omittedToolResults!);
    expect(rows.slice(kept).every((row) => row.tool?.status === "unknown")).toBeTrue();
    expect(rows.at(-1)?.itemId).toBe(calls[399]!.id);
    expect(rows.at(-1)?.tool?.status).toBe("unknown");
    expect(unknown.every((row) => row.completedAt === at(20))).toBeTrue();
    /* The snapshot keeps the distinction. */
    const restored = runtimeLiveTurnItems(normalizeRuntimeLiveTurn(JSON.parse(JSON.stringify(live)))).filter((row) => row.tool);
    expect(restored.map((row) => row.tool?.status)).toEqual(rows.map((row) => row.tool?.status));
  });

  test("issue 1100 review: an oversized FAILED Codex tool keeps its terminal outcome, so the live row is an error", () => {
    const at = "2026-08-23T09:00:00.000Z";
    const mcp = projectEngineHostEvent("conversation_tools", "codex:thread-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: {
        type: "mcpToolCall", id: "call_mcp_fail", server: "viewer", tool: "get_pipeline", arguments: { pipelineId: "p1" },
        status: "completed", error: { message: "pipeline not found", detail: "d".repeat(2_000) }, result: "r".repeat(12_000),
      },
      phase: "completed",
      seq: 41,
    });
    const mcpItem = mcp?.payload.item as Record<string, unknown>;
    expect(mcpItem).toMatchObject({ truncated: true, id: "call_mcp_fail", type: "mcpToolCall", server: "viewer", tool: "get_pipeline" });
    expect(typeof mcpItem.error).toBe("string");
    expect(JSON.stringify(mcpItem)).not.toContain("rrrr");
    expect(runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", mcpItem, "completed", at))[0]?.tool).toMatchObject({ name: "mcp__viewer__get_pipeline", status: "err" });

    const dynamic = projectEngineHostEvent("conversation_tools", "codex:thread-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "dynamicToolCall", id: "call_dyn_fail", tool: "lint", arguments: { files: ["a.ts"] }, status: "completed", success: false, contentItems: "c".repeat(12_000) },
      phase: "completed",
      seq: 42,
    });
    const dynamicItem = dynamic?.payload.item as Record<string, unknown>;
    expect(dynamicItem).toMatchObject({ truncated: true, id: "call_dyn_fail", success: false });
    expect(runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", dynamicItem, "completed", at))[0]?.tool).toMatchObject({ name: "lint", status: "err" });

    const image = projectEngineHostEvent("conversation_tools", "codex:thread-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "imageGeneration", id: "call_img_fail", status: "completed", failure: "content policy", revisedPrompt: "p".repeat(12_000) },
      phase: "completed",
      seq: 43,
    });
    const imageItem = image?.payload.item as Record<string, unknown>;
    expect(imageItem).toMatchObject({ truncated: true, id: "call_img_fail", failure: "content policy" });
    expect(runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", imageItem, "completed", at))[0]?.tool).toMatchObject({ name: "imagegen", status: "err" });

    /* A successful oversized call stays a success. */
    const ok = projectEngineHostEvent("conversation_tools", "codex:thread-tools", {
      kind: "item",
      turnId: "turn-tools",
      item: { type: "mcpToolCall", id: "call_mcp_ok", server: "viewer", tool: "list_tasks", status: "completed", result: "r".repeat(12_000) },
      phase: "completed",
      seq: 44,
    });
    expect(runtimeLiveTurnItems(projectRuntimeLiveTurnItem(null, "turn-tools", ok?.payload.item, "completed", at))[0]?.tool).toMatchObject({ status: "ok" });
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
    expect(blocks).toHaveLength(40);
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
