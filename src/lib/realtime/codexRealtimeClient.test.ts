import { expect, test } from "bun:test";

import {
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
