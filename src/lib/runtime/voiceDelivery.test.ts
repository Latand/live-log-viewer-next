import { describe, expect, test } from "bun:test";

import {
  acknowledgeVoiceDelivery,
  appendReadyVoiceDelivery,
  appendVoiceResponse,
  completeVoiceTurn,
  rememberAcknowledgedVoiceDelivery,
  terminalVoiceResponse,
  streamingVoiceDelivery,
  utf8ChunkAt,
  type RuntimeVoiceDelivery,
} from "./voiceDelivery";

describe("canonical voice delivery state", () => {
  test("keeps exact Unicode terminal content beyond both UI bounds and seals multi-item turns once", () => {
    const firstText = `${"first🙂界".repeat(10_000)}\n`;
    const secondText = `\u0301${"second🫶🏽".repeat(2_000)}`;
    const first = terminalVoiceResponse(
      { type: "agentMessage", id: "response-one", text: firstText },
      "event-1",
    );
    const second = terminalVoiceResponse(
      {
        type: "message",
        role: "assistant",
        id: "response-two",
        content: [
          { type: "output_text", text: secondText.slice(0, 1) },
          { type: "output_text", text: secondText.slice(1) },
        ],
      },
      "event-2",
    );
    expect(first).toEqual({ responseId: "response-one", text: firstText });
    expect(second).toEqual({ responseId: "response-two", text: secondText });

    let deliveries: RuntimeVoiceDelivery[] = [];
    deliveries = appendVoiceResponse(deliveries, "turn-one", first!);
    deliveries = appendVoiceResponse(deliveries, "turn-one", second!);
    deliveries = appendVoiceResponse(deliveries, "turn-one", first!);
    deliveries = completeVoiceTurn(deliveries, "turn-one", "completed");
    const replayed = completeVoiceTurn(deliveries, "turn-one", "completed");

    expect(replayed).toEqual(deliveries);
    expect(deliveries).toEqual([{
      deliveryId: 'voice:["turn-one",["response-one","response-two"]]',
      turnId: "turn-one",
      responses: [
        { responseId: "response-one", text: firstText },
        { responseId: "response-two", text: secondText },
      ],
      ready: true,
    }]);
    expect(new TextEncoder().encode(deliveries[0]!.responses.map((response) => response.text).join("")).length)
      .toBeGreaterThan(64 * 1024);
  });

  test("drops interrupted drafts and removes only the acknowledged stable delivery", () => {
    const pending = completeVoiceTurn(
      appendVoiceResponse([], "turn-complete", { responseId: "response", text: "done" }),
      "turn-complete",
      "completed",
    );
    const withDraft = appendVoiceResponse(pending, "turn-interrupted", {
      responseId: "draft",
      text: "unfinished",
    });

    expect(completeVoiceTurn(withDraft, "turn-interrupted", "interrupted")).toEqual(pending);
    expect(acknowledgeVoiceDelivery(pending, pending[0]!.deliveryId)).toEqual([]);
    expect(acknowledgeVoiceDelivery(pending, "unknown")).toEqual(pending);
  });

  test("keeps immutable streamed chunks distinct and removes their interrupted source turn", () => {
    const first = streamingVoiceDelivery({
      sourceTurnId: "turn-streamed",
      chunkIndex: 0,
      startOffset: 0,
      endOffset: 11,
      text: "first part ",
    });
    const second = streamingVoiceDelivery({
      sourceTurnId: "turn-streamed",
      chunkIndex: 1,
      startOffset: 11,
      endOffset: 22,
      text: "second part",
    });
    const once = appendReadyVoiceDelivery([], first);
    expect(appendReadyVoiceDelivery(once, first)).toEqual(once);
    const queued = appendReadyVoiceDelivery(once, second);
    expect(queued.map((delivery) => delivery.responses[0]!.text)).toEqual([
      "first part ",
      "second part",
    ]);
    expect(completeVoiceTurn(queued, "turn-streamed", "interrupted")).toEqual([]);
  });

  test("bounds durable acknowledgement identities and retires a replayed delivery", () => {
    let acknowledged: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      acknowledged = rememberAcknowledgedVoiceDelivery(acknowledged, `delivery-${index}`);
    }
    expect(acknowledged).toHaveLength(256);
    expect(acknowledged[0]).toBe("delivery-44");
    expect(acknowledged.at(-1)).toBe("delivery-299");

    const replayed = appendVoiceResponse([], "turn-replayed", {
      responseId: "response-replayed",
      text: "already spoken",
    });
    const deliveryId = 'voice:["turn-replayed",["response-replayed"]]';
    expect(completeVoiceTurn(
      replayed,
      "turn-replayed",
      "completed",
      rememberAcknowledgedVoiceDelivery(acknowledged, deliveryId),
    )).toEqual([]);
  });

  test("chunks on Unicode scalar boundaries without changing ordered content", () => {
    const source = `a🙂🫶🏽界e\u0301${"🌍".repeat(20)}`;
    const chunks: string[] = [];
    let offset = 0;
    while (offset < source.length) {
      const chunk = utf8ChunkAt(source, offset, 7)!;
      chunks.push(chunk.text);
      offset = chunk.nextOffset;
    }
    expect(chunks.join("")).toBe(source);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 7)).toBeTrue();
    expect(chunks.some((chunk) => chunk.includes("\ufffd"))).toBeFalse();
    expect(() => utf8ChunkAt("🙂", 1, 8)).toThrow("splits a Unicode scalar");
  });
});
