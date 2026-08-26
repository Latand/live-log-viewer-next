import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { captureSelectedContext } from "@/lib/selection/selectedContext";

import { FeedItem } from "./FeedItem";
import { createFeedSession, type Item } from "./parse";

/**
 * The round trip that makes the badge evidence rather than decoration: what the
 * composer submitted, persisted onto the canonical structured-user record, read
 * back out of the transcript, and rendered by the SAME badge component.
 */

const REFERENCE = captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
  cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
  identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  revision: 4,
  now: Date.parse("2026-07-31T09:00:00.000Z"),
});

function userItems(recordText: string): Item[] {
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  const line = JSON.stringify({
    timestamp: "2026-07-31T09:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: recordText }] },
  });
  return session.feed([line], 0, false).items.map((entry) => entry.item);
}

test("a persisted record's reference reaches the rendered user row", () => {
  const items = userItems(encodeCodexStructuredUserText("Look at that one.", undefined, REFERENCE));
  const user = items.find((item) => item.kind === "user");
  expect(user).toBeDefined();
  expect(user!.kind === "user" && user!.text).toBe("Look at that one.");
  expect(user!.kind === "user" && user!.selectedContext).toEqual(REFERENCE);
});

test("a record with no reference produces a row with none — nothing is invented", () => {
  const items = userItems(encodeCodexStructuredUserText("Look at that one."));
  const user = items.find((item) => item.kind === "user");
  expect(user!.kind === "user" && user!.selectedContext).toBeUndefined();
});

test("the transcript row renders the same badge the composer showed", () => {
  setLocale("en");
  const items = userItems(encodeCodexStructuredUserText("Look at that one.", undefined, REFERENCE));
  const user = items.find((item) => item.kind === "user")!;
  const html = renderToStaticMarkup(<FeedItem item={user} />);
  expect(html).toContain("Worker A");
  expect(html).toMatch(/aria-label="[^"]*Worker A[^"]*"/);
  expect(html).toContain("Look at that one.");
});

test("a row sent with an explicit empty selection carries the reference and shows no chip", () => {
  setLocale("en");
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
    revision: 5,
    now: Date.parse("2026-07-31T09:00:00.000Z"),
  });
  const items = userItems(encodeCodexStructuredUserText("Anything running?", undefined, empty));
  const user = items.find((item) => item.kind === "user")!;
  /* The record still says the operator asked with nothing selected (#844) — the
     reference survives the round trip — while the row itself stays clean: a chip
     repeating that over every bare operator message is the noise of #1148. */
  expect(user.kind === "user" && user.selectedContext).toEqual(empty);
  const html = renderToStaticMarkup(<FeedItem item={user} />);
  expect(html).toContain("Anything running?");
  expect(html).not.toContain("data-selected-context");
  expect(html.toLowerCase()).not.toContain("nothing selected");
});

test("a row with no reference renders no badge markup at all", () => {
  setLocale("en");
  const items = userItems(encodeCodexStructuredUserText("Look at that one."));
  const user = items.find((item) => item.kind === "user")!;
  expect(renderToStaticMarkup(<FeedItem item={user} />)).not.toContain("data-selected-context");
});
