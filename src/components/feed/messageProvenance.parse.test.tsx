import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";

import { FeedItem } from "./FeedItem";
import { MessageProvenanceProvider, type ProvenanceLookup } from "./messageProvenance";
import { createFeedSession, type Item } from "./parse";

/**
 * The three provenance classes of #1117, end to end through the parser and the
 * renderer: the operator's message is the operator's bubble, an inter-agent
 * relay is the visibly labelled internal card naming the sender role, and true
 * scaffold keeps the system row. Codex carries authorship in the structured
 * marker; Claude joins the delivery ledger through the provenance context.
 */

/* Assembled from parts so the invented id can never fingerprint as a real
   engine message identifier on the publication gate. */
const ENGINE_MESSAGE_ID = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");

function codexItems(lines: string[]): Item[] {
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  return session.feed(lines, 0, false).items.map((entry) => entry.item);
}

function codexUserLine(recordText: string): string {
  return JSON.stringify({
    timestamp: "2026-07-31T09:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: recordText }] },
  });
}

function codexEventLine(recordText: string): string {
  return JSON.stringify({
    timestamp: "2026-07-31T09:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: recordText },
  });
}

function claudeItems(lines: string[]): Item[] {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  return session.feed(lines, 0, false).items.map((entry) => entry.item);
}

test("a codex agent-origin record renders as the internal relay card, not a user bubble", () => {
  const items = codexItems([
    codexUserLine(encodeCodexStructuredUserText("Implement issue #12 in this worktree.", undefined, null, { kind: "agent", role: "orchestrator" })),
  ]);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(0);
  const relay = items.find((item) => item.kind === "tmsg");
  expect(relay).toEqual({
    kind: "tmsg",
    ts: "2026-07-31T09:00:01.000Z",
    dir: "in",
    peer: "orchestrator",
    summary: "",
    text: "Implement issue #12 in this worktree.",
    internal: true,
  });
});

test("a codex operator-origin record keeps the operator's bubble", () => {
  const items = codexItems([
    codexUserLine(encodeCodexStructuredUserText("what is left on the branch?", undefined, null, { kind: "operator" })),
  ]);
  const user = items.find((item) => item.kind === "user");
  expect(user!.kind === "user" && user!.text).toBe("what is left on the branch?");
  expect(items.filter((item) => item.kind === "tmsg")).toHaveLength(0);
});

test("a codex record without the attribute keeps today's rendering", () => {
  const items = codexItems([codexUserLine(encodeCodexStructuredUserText("older send"))]);
  expect(items.find((item) => item.kind === "user")).toBeDefined();
  expect(items.filter((item) => item.kind === "tmsg")).toHaveLength(0);
});

test("the event echo of an agent-origin record settles the SAME relay card, never a second row", () => {
  const encoded = encodeCodexStructuredUserText("Round 2: fix the tail.", undefined, null, { kind: "agent", role: "reviewer" });
  const items = codexItems([codexUserLine(encoded), codexEventLine(encoded)]);
  expect(items.filter((item) => item.kind === "tmsg")).toHaveLength(1);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(0);
  const relay = items.find((item) => item.kind === "tmsg");
  expect(relay!.kind === "tmsg" && relay!.peer).toBe("reviewer");
});

test("a claude SDK-delivered message parses as a system row carrying its ledger join identity", () => {
  const items = claudeItems([JSON.stringify({
    type: "user",
    uuid: ENGINE_MESSAGE_ID,
    timestamp: "2026-07-31T09:00:01.000Z",
    promptSource: "sdk",
    message: { role: "user", content: [{ type: "text", text: "please rerun the failing check" }] },
  })]);
  const row = items.find((item) => item.kind === "sysmsg");
  expect(row!.kind === "sysmsg" && row!.deliveredMessage).toEqual({
    engineMessageId: ENGINE_MESSAGE_ID,
    ts: "2026-07-31T09:00:01.000Z",
  });
});

test("claude scaffold rows carry NO join identity — they can never be reclassified", () => {
  const items = claudeItems([
    JSON.stringify({ type: "user", uuid: "aaaa", promptSource: "sdk", isMeta: true, message: { content: "injected context" } }),
    JSON.stringify({ type: "user", uuid: "bbbb", promptSource: "command", message: { content: "command output" } }),
    JSON.stringify({ type: "user", uuid: "cccc", promptSource: "sdk", message: { content: "<task-notification type=\"idle\">done</task-notification>" } }),
  ]);
  const rows = items.filter((item) => item.kind === "sysmsg");
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.kind === "sysmsg" && row.deliveredMessage).toBeUndefined();
  }
});

const DELIVERED_ROW: Item = {
  kind: "sysmsg",
  label: "system",
  text: "please rerun the failing check",
  deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: "2026-07-31T09:00:01.000Z" },
};

function renderWithProvenance(item: Item, provenance: Record<string, DeliveredMessageProvenance>): string {
  const lookup: ProvenanceLookup = (id) => (id ? provenance[id] ?? null : null);
  return renderToStaticMarkup(
    <MessageProvenanceProvider value={lookup}>
      <FeedItem item={item} />
    </MessageProvenanceProvider>,
  );
}

test("ledger evidence resolves a delivered row into the operator's own bubble", () => {
  setLocale("en");
  const html = renderWithProvenance(DELIVERED_ROW, {
    [ENGINE_MESSAGE_ID]: { origin: "operator" },
  });
  expect(html).toContain("bg-user");
  expect(html).toContain("please rerun the failing check");
  expect(html).not.toContain("system");
});

test("ledger evidence resolves a delivered row into the internal card naming the sender role", () => {
  setLocale("en");
  const html = renderWithProvenance(DELIVERED_ROW, {
    [ENGINE_MESSAGE_ID]: { origin: "agent", senderRole: "orchestrator" },
  });
  expect(html).toContain("internal");
  expect(html).toContain("orchestrator");
  /* Visible by default: the body renders without any expansion. */
  expect(html).toContain("please rerun the failing check");
  expect(html).not.toContain("bg-user");
});

test("without evidence the delivered row keeps the current system style", () => {
  setLocale("en");
  const html = renderToStaticMarkup(<FeedItem item={DELIVERED_ROW} />);
  const resolved = renderWithProvenance(DELIVERED_ROW, {});
  expect(html).toBe(resolved);
  expect(html).not.toContain("bg-user");
});
