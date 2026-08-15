import { expect, test } from "bun:test";

import { captureSelectedContext, encodeSelectedContextRef } from "@/lib/selection/selectedContext";

import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "./codexStructuredUserText";
import { parseRuntimeCommand } from "./commands";
import { normalizeQueueEntry, type QueueEntry, type RuntimeEvent } from "./engineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";

/**
 * #844 §capture: the reference is admitted WITH the text, in the same parsed
 * command, or not at all. A body that names a selection the validator refuses
 * admits the turn without one rather than admitting a fabricated reference —
 * losing the badge is recoverable, attributing an instruction to the wrong
 * conversation is not.
 */

const REFERENCE = captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
  cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
  identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  revision: 5,
  now: Date.parse("2026-07-31T09:00:00.000Z"),
});

const body = (extra: Record<string, unknown>) => ({
  conversationId: "conversation_orchestrator",
  text: "Look at that one.",
  idempotencyKey: "key-1",
  ...extra,
});

test("a send carries the selected-card reference into the parsed command", () => {
  const command = parseRuntimeCommand("send", body({ selectedContext: REFERENCE }));
  expect(command.kind === "send" && command.selectedContext).toEqual(REFERENCE);
});

test("a steer carries it too — the same operator gesture reaches a busy agent", () => {
  const command = parseRuntimeCommand("steer", body({ selectedContext: REFERENCE }));
  expect(command.kind === "steer" && command.selectedContext).toEqual(REFERENCE);
});

test("an explicit empty selection survives admission as an answer", () => {
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
    revision: 6,
    now: Date.parse("2026-07-31T09:00:00.000Z"),
  });
  const command = parseRuntimeCommand("send", body({ selectedContext: empty }));
  expect(command.kind === "send" && command.selectedContext).toEqual(empty);
});

test("a send with no selected context is unchanged — the field is absent, not null", () => {
  const command = parseRuntimeCommand("send", body({}));
  expect(command.kind === "send" && "selectedContext" in command).toBe(false);
});

test("an unvalidatable reference is dropped, and the turn is still admitted", () => {
  for (const value of [{ version: 9, state: "selected" }, "conversation_atlas_a", 42, { state: "selected" }]) {
    const command = parseRuntimeCommand("send", body({ selectedContext: value }));
    expect(command.kind === "send" && "selectedContext" in command).toBe(false);
    expect(command.kind === "send" && command.text).toBe("Look at that one.");
  }
});

test("the reference is a typed record, never the encoded token, on the command", () => {
  const command = parseRuntimeCommand("send", body({ selectedContext: encodeSelectedContextRef(REFERENCE) }));
  expect(command.kind === "send" && "selectedContext" in command).toBe(false);
});

/* ------------------------------------------------------------------ *
 * Through the durable queue and onto the canonical record            *
 * ------------------------------------------------------------------ */

/** Drive one durable send effect through the real queue and collect the entry
    the host was handed. This is the replay boundary: the reference the operator
    submitted is re-read from the durable payload, never from a live view. */
async function drainOne(entries: QueueEntry[], selectedContext: unknown): Promise<void> {
  const port: StructuredDeliveryQueuePort = {
    effects: async () => [{
      id: "effect:op-one",
      kind: "runtime.send",
      eventSeq: 1,
      payload: {
        kind: "send",
        operationId: "op-one",
        conversationId: "conversation_orchestrator",
        text: "Look at that one.",
        idempotencyKey: "key-1",
        policy: "queue",
        selectedContext,
      },
    }],
    transition: async () => {},
  };
  const queue = new StructuredDeliveryQueue(port, () => ({
    attach: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {} }),
    send: async (entry: QueueEntry) => {
      entries.push(entry);
      return { outcome: "turn-started" as const, turnId: "turn-1" };
    },
    interrupt: async () => {},
    answer: async () => {},
    health: async () => ({
      status: "idle" as const,
      sessionKey: "session-one",
      endpoint: "test:host",
      pid: 1,
      processStartIdentity: "1",
      eventCursor: 0,
      protocolVersion: "test",
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
      account: null,
    }),
    release: async () => {},
  }));
  await queue.drain();
}

test("the reference replays off the durable send effect onto the queue entry", async () => {
  const entries: QueueEntry[] = [];
  await drainOne(entries, JSON.parse(JSON.stringify(REFERENCE)));
  expect(entries).toHaveLength(1);
  expect(entries[0]!.selectedContext).toEqual(REFERENCE);
});

test("a malformed durable reference is dropped, and the message is still delivered", async () => {
  const entries: QueueEntry[] = [];
  await drainOne(entries, { version: 9, state: "selected" });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.selectedContext).toBeUndefined();
  expect(entries[0]!.content?.text).toBe("Look at that one.");
});

test("the record the host writes carries the reference on the canonical marker", () => {
  const normalized = normalizeQueueEntry({
    id: "op-one",
    text: "Look at that one.",
    selectedContext: REFERENCE,
  });
  const record = encodeCodexStructuredUserText(normalized.content.text, undefined, normalized.selectedContext);
  expect(decodeCodexStructuredUserText(record)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: null,
    selectedContext: REFERENCE,
  });
});
