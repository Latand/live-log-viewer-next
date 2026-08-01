import { expect, test } from "bun:test";

import { createViewBus, type ViewSlice } from "./viewPresenceBus";

/**
 * What the view bus has to add for #844: the two things a selected-card
 * reference needs that paths alone cannot supply.
 *
 * - IDENTITY. `viewSessionId`/`deviceId` are minted inside the presence
 *   publisher's effect and, until now, never left it. Binding a voice call to a
 *   window needs them at submission time, so the publisher reports them here.
 * - NAMES. The bus carries transcript PATHS; a reference is keyed by
 *   `conversationId`. The surface that owns `FileEntry` objects reports the
 *   mapping, so capture never has to guess an identity from a path.
 *
 * The selection revision is derived rather than reported: the bus already sees
 * every slice report, so it can count the ones that actually MOVED the
 * selection. A camera settle is not a selection change and must not look like
 * one.
 */

const slice = (focusedPath: string | null, selectedPaths: string[] = []): ViewSlice => ({
  mode: "list",
  focusedPath,
  selectedPaths,
  visiblePaths: [],
  camera: null,
});

test("identity is absent until the publisher reports it, and readable afterwards", () => {
  const bus = createViewBus();
  expect(bus.getIdentity()).toBeNull();
  bus.reportIdentity({ viewSessionId: "vs-1", deviceId: "dev-1" });
  expect(bus.getIdentity()).toEqual({ viewSessionId: "vs-1", deviceId: "dev-1" });
});

test("card identities start empty and replace wholesale — the reporter owns the set", () => {
  const bus = createViewBus();
  expect(bus.getCards()).toEqual([]);
  bus.reportCards([{ path: "a.jsonl", conversationId: "conversation_a" }]);
  bus.reportCards([{ path: "b.jsonl", conversationId: "conversation_b" }]);
  expect(bus.getCards()).toEqual([{ path: "b.jsonl", conversationId: "conversation_b" }]);
});

test("the selection revision advances only when the selection actually moves", () => {
  const bus = createViewBus();
  const first = bus.getSelectionRevision();
  bus.reportSlice(slice("a.jsonl", ["a.jsonl"]));
  const afterSelect = bus.getSelectionRevision();
  expect(afterSelect).toBeGreaterThan(first);

  /* An identical report is dropped by the bus; a report that changes only what
     is VISIBLE is a scroll, not a selection. Neither may advance the revision,
     or a reference would look stale to a voice session the instant the operator
     panned the board. */
  bus.reportSlice(slice("a.jsonl", ["a.jsonl"]));
  bus.reportSlice({ ...slice("a.jsonl", ["a.jsonl"]), visiblePaths: ["a.jsonl", "b.jsonl"] });
  expect(bus.getSelectionRevision()).toBe(afterSelect);

  bus.reportSlice(slice("b.jsonl", ["a.jsonl"]));
  expect(bus.getSelectionRevision()).toBe(afterSelect + 1);
  bus.reportSlice(slice("b.jsonl", ["a.jsonl", "b.jsonl"]));
  expect(bus.getSelectionRevision()).toBe(afterSelect + 2);
});

test("identity and card reports notify subscribers, so a badge re-renders", () => {
  const bus = createViewBus();
  let notified = 0;
  bus.subscribe(() => {
    notified += 1;
  });
  bus.reportIdentity({ viewSessionId: "vs-1", deviceId: "dev-1" });
  bus.reportCards([{ path: "a.jsonl", conversationId: "conversation_a" }]);
  expect(notified).toBe(2);
  /* A report that reproduces the current value stays silent, exactly as the
     context and slice channels already do. */
  bus.reportIdentity({ viewSessionId: "vs-1", deviceId: "dev-1" });
  bus.reportCards([{ path: "a.jsonl", conversationId: "conversation_a" }]);
  expect(notified).toBe(2);
});
