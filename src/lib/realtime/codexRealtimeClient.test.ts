import { expect, test } from "bun:test";

import {
  parseCodexRealtimeEvent,
} from "./codexRealtimeClient";

test("parses Frameless Bidi transcript, handoff, usage and error events", () => {
  expect(parseCodexRealtimeEvent({
    type: "input_transcript.added",
    item: { text: "hello" },
  })).toEqual({ kind: "transcript", role: "user", text: "hello", final: false });
  expect(parseCodexRealtimeEvent({
    type: "turn.done",
    turn: { role: "assistant", transcript: "done" },
  })).toEqual({ kind: "transcript", role: "assistant", text: "done", final: true });
  /* Native's streamed fragments carry their own id, and a done with no words
     still ends the turn of the speaker it names (#1658). */
  expect(parseCodexRealtimeEvent({
    type: "output_transcript.added",
    item: { id: "chunk-1", type: "output_transcript", text: " word" },
    start_ms: 800,
    end_ms: 1000,
  })).toEqual({ kind: "transcript", role: "assistant", text: " word", final: false, chunkId: "chunk-1" });
  expect(parseCodexRealtimeEvent({
    type: "turn.done",
    turn: { id: "turn-1", role: "user", transcript: "" },
  })).toEqual({ kind: "transcript", role: "user", text: "", final: true });
  expect(parseCodexRealtimeEvent({ type: "turn.done", turn: { transcript: "" } })).toEqual({ kind: "ignored" });
  /* The identities the native controller reads off this event, and the join
     between an utterance and the work it became (#1629). */
  expect(parseCodexRealtimeEvent({
    type: "delegation.created",
    item: {
      id: "delegation-1",
      type: "delegation",
      target: "client",
      handoff_id: "handoff-1",
      user_bidi_turn_id: "bidi-1",
    },
  })).toEqual({ kind: "handoff", handoffId: "handoff-1", itemId: "delegation-1", userBidiTurnId: "bidi-1" });
  /* The same handoff, announced flat before the item exists. */
  expect(parseCodexRealtimeEvent({
    type: "conversation.handoff.requested",
    handoff_id: "handoff-1",
    item_id: "item-1",
    user_bidi_turn_id: "bidi-1",
  })).toEqual({ kind: "handoff", handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" });
  /* An approaching limit keeps the call running, so it is not an error. */
  expect(parseCodexRealtimeEvent({
    type: "session.usage.updated",
    usage_limit: { status: "approaching" },
  })).toEqual({ kind: "usage", status: "approaching" });
  expect(parseCodexRealtimeEvent({
    type: "session.usage.updated",
    usage_limit: { status: null },
  })).toEqual({ kind: "ignored" });
  expect(parseCodexRealtimeEvent({
    type: "error",
    error: { message: "backend closed" },
  })).toEqual({ kind: "error", message: "backend closed" });
});
