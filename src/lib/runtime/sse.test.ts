import { expect, test } from "bun:test";

import type { RuntimeHostClient } from "./client";
import { runtimeScope, type RuntimeEvent } from "./contracts";
import { runtimeCursor, runtimeEventStream } from "./sse";

function event(seq: number): RuntimeEvent {
  return {
    schemaVersion: 1,
    seq,
    eventId: `evt-${seq}`,
    scope: runtimeScope("session", "conv-one"),
    revision: seq,
    kind: "turn-started",
    occurredAt: "2026-07-10T00:00:00.000Z",
    recordedAt: "2026-07-10T00:00:00.000Z",
    producer: { kind: "test" },
    causationId: null,
    correlationId: null,
    payload: { turnId: "turn-one" },
  };
}

test("SSE waits on host notifications and emits default message frames", async () => {
  let waits = 0;
  const client = {
    waitEvents: async () => {
      waits += 1;
      return { reset: false, floorSeq: 0, events: [event(1)] };
    },
    events: async () => { throw new Error("polling path used"); },
  } as unknown as RuntimeHostClient;
  const abort = new AbortController();
  const reader = runtimeEventStream(client, 0, abort.signal).getReader();
  const first = await reader.read();
  abort.abort();
  await reader.cancel();
  const text = new TextDecoder().decode(first.value);
  expect(waits).toBe(1);
  expect(text).toContain("id: 1\n");
  expect(text).toContain("data: {");
  expect(text).not.toContain("event: runtime");
});

test("SSE closes after an explicit retention reset", async () => {
  const client = {
    waitEvents: async () => ({ reset: true, floorSeq: 12, events: [] }),
  } as unknown as RuntimeHostClient;
  const reader = runtimeEventStream(client, 1, new AbortController().signal).getReader();
  const reset = await reader.read();
  const closed = await reader.read();
  expect(new TextDecoder().decode(reset.value)).toContain("event: reset");
  expect(closed.done).toBe(true);
});

test("SSE resumes from the larger valid query or Last-Event-ID cursor", () => {
  expect(runtimeCursor("4", "9")).toBe(9);
  expect(runtimeCursor("12", "9")).toBe(12);
  expect(runtimeCursor(null, "7")).toBe(7);
  expect(() => runtimeCursor("bad", null)).toThrow("cursor must be a non-negative sequence");
});
