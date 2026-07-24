import { expect, test } from "bun:test";

import {
  chunkUtf8,
  delegationContextEvents,
  parseCodexRealtimeEvent,
} from "./codexRealtimeClient";

test("parses Frameless Bidi transcript, delegation, and error events", () => {
  expect(parseCodexRealtimeEvent({
    type: "input_transcript.added",
    item: { text: "hello" },
  })).toEqual({ kind: "transcript", role: "user", text: "hello", final: false });
  expect(parseCodexRealtimeEvent({
    type: "turn.done",
    turn: { role: "assistant", transcript: "done" },
  })).toEqual({ kind: "transcript", role: "assistant", text: "done", final: true });
  expect(parseCodexRealtimeEvent({
    type: "delegation.created",
    item: { id: "delegation-1" },
  })).toEqual({ kind: "delegation", id: "delegation-1" });
  expect(parseCodexRealtimeEvent({
    type: "error",
    error: { message: "backend closed" },
  })).toEqual({ kind: "error", message: "backend closed" });
});

test("chunks handoff context on UTF-8 boundaries", () => {
  const chunks = chunkUtf8("голос ".repeat(180), 500);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe("голос ".repeat(180));
  expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 500)).toBe(true);
});

test("builds targeted delegation.context.append events", () => {
  expect(delegationContextEvents("delegation-1", "worker progress", "commentary")).toEqual([{
    type: "delegation.context.append",
    delegation_item_id: "delegation-1",
    channel: "commentary",
    content: [{ type: "input_text", text: "worker progress" }],
  }]);
});
