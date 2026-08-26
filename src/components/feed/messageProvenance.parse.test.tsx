import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import type { DeliveredMessageOccurrence, DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { FeedItem } from "./FeedItem";
import { MessageProvenanceProvider, provenanceLookupFor } from "./messageProvenance";
import { createFeedSession, type Item } from "./parse";

/**
 * The three provenance classes of #1117, end to end through the parser and the
 * renderer: the operator's message is the operator's bubble, an inter-agent
 * relay is the visibly labelled internal card naming the sender role, and true
 * scaffold keeps the system row. Codex carries authorship in the structured
 * marker; Claude joins the delivery ledger through the provenance context; a
 * delivery that left no per-row identity on either engine joins by occurrence.
 */

/* Assembled from parts so the invented id can never fingerprint as a real
   engine message identifier on the publication gate. */
const ENGINE_MESSAGE_ID = ["11111111", "2222", "4333", "8444", "555555555555"].join("-");

const T0 = Date.parse("2026-07-31T09:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function codexItems(lines: string[]): Item[] {
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  return session.feed(lines, 0, false).items.map((entry) => entry.item);
}

function codexUserLine(recordText: string, timestamp = at(1_000)): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: recordText }] },
  });
}

function codexEventLine(recordText: string, timestamp = at(1_000)): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "user_message", message: recordText },
  });
}

function claudeItems(lines: string[]): Item[] {
  const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
  return session.feed(lines, 0, false).items.map((entry) => entry.item);
}

/** A legacy tmux paste on Claude: a plain user row with no SDK provenance. */
function claudeUserLine(text: string, timestamp = at(1_000)): string {
  return JSON.stringify({ type: "user", timestamp, message: { role: "user", content: text } });
}

test("a codex agent-origin record renders as the internal relay card, not a user bubble", () => {
  const items = codexItems([
    codexUserLine(encodeCodexStructuredUserText("Implement issue #12 in this worktree.", undefined, null, { kind: "agent", role: "orchestrator" })),
  ]);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(0);
  const relay = items.find((item) => item.kind === "tmsg");
  expect(relay).toEqual({
    kind: "tmsg",
    ts: at(1_000),
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
    timestamp: at(1_000),
    promptSource: "sdk",
    message: { role: "user", content: [{ type: "text", text: "please rerun the failing check" }] },
  })]);
  const row = items.find((item) => item.kind === "sysmsg");
  expect(row!.kind === "sysmsg" && row!.deliveredMessage).toEqual({
    engineMessageId: ENGINE_MESSAGE_ID,
    ts: at(1_000),
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
  deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: at(1_000) },
};

interface Evidence {
  messages?: Record<string, DeliveredMessageProvenance>;
  occurrences?: DeliveredMessageOccurrence[];
}

/** Renders every row of one feed under the lookup the hook would build from
    this evidence, so the occurrence join sees the whole window. */
function renderAll(items: Item[], evidence: Evidence): string[] {
  const lookup = provenanceLookupFor(evidence, items);
  return items.map((item) => renderToStaticMarkup(
    <MessageProvenanceProvider value={lookup}>
      <FeedItem item={item} />
    </MessageProvenanceProvider>,
  ));
}

function renderWithProvenance(item: Item, evidence: Evidence): string {
  return renderAll([item], evidence)[0];
}

test("ledger evidence resolves a delivered row into the operator's own bubble", () => {
  setLocale("en");
  const html = renderWithProvenance(DELIVERED_ROW, { messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } });
  expect(html).toContain("bg-user");
  expect(html).toContain("please rerun the failing check");
  expect(html).not.toContain("system");
});

test("ledger evidence resolves a delivered row into the internal card naming the sender role", () => {
  setLocale("en");
  const html = renderWithProvenance(DELIVERED_ROW, {
    messages: { [ENGINE_MESSAGE_ID]: { origin: "agent", senderRole: "orchestrator" } },
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

/* The occurrence join (#1117 rounds 2–3): a legacy tmux paste writes only
   engine input, so its transcript row is a plain user bubble on both engines.
   The delivery's own settled receipt — content digest, settlement time, the
   origin stamped at admission — is the evidence that re-attributes it, and it
   attaches to exactly one row: the one nearest the settlement. */

const MANDATE = "Implement issue #12 in this worktree, then report back.";
const RELAYED_TEXT = "Review round findings are below.\n\nP1 — the held command drops its origin.";

function occurrence(text: string, deliveredAt: string, provenance: DeliveredMessageProvenance): DeliveredMessageOccurrence {
  return { textDigest: messageTextDigest(text), deliveredAt, ...provenance };
}

test("a generic legacy MCP send into a tmux-owned claude conversation renders as the internal card naming the sender role", () => {
  setLocale("en");
  const items = claudeItems([claudeUserLine(MANDATE, at(1_000))]);
  expect(items.find((item) => item.kind === "user")).toBeDefined();
  const [html] = renderAll(items, {
    occurrences: [occurrence(MANDATE, at(0), { origin: "agent", senderRole: "orchestrator" })],
  });
  expect(html).toContain("internal");
  expect(html).toContain("orchestrator");
  expect(html).toContain("Implement issue #12");
  expect(html).not.toContain("bg-user");
});

test("a generic legacy MCP send into a tmux-owned codex conversation renders as the internal card naming the sender role", () => {
  setLocale("en");
  const items = codexItems([codexUserLine(MANDATE, at(1_000)), codexEventLine(MANDATE, at(1_200))]);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
  const [html] = renderAll(items, {
    occurrences: [occurrence(MANDATE, at(0), { origin: "agent", senderRole: "orchestrator" })],
  });
  expect(html).toContain("internal");
  expect(html).toContain("orchestrator");
  expect(html).not.toContain("bg-user");
});

test("a legacy operator send keeps the operator's bubble on both engines", () => {
  setLocale("en");
  const evidence: Evidence = { occurrences: [occurrence("what is left on the branch?", at(0), { origin: "operator" })] };
  for (const items of [
    claudeItems([claudeUserLine("what is left on the branch?", at(1_000))]),
    codexItems([codexUserLine("what is left on the branch?", at(1_000))]),
  ]) {
    const [html] = renderAll(items, evidence);
    expect(html).toContain("bg-user");
    expect(html).not.toContain("internal");
  }
});

test("an over-32k agent-origin delivery — whose record keeps only the digest — renders as the internal card on both engines", () => {
  setLocale("en");
  /* Past the 32,000-byte envelope bound the legacy hold blanks its text and
     keeps the digest of what was sent; the row's own digest must meet it.
     Real prose, so the parser's blob heuristic still sees a message row. */
  const largeRelay = ["Findings, in full:", ...Array.from({ length: 600 }, () => "P1 — the held record keeps no digest past the envelope bound.")].join("\n");
  expect(new TextEncoder().encode(largeRelay).length).toBeGreaterThan(32_000);
  const evidence: Evidence = { occurrences: [occurrence(largeRelay, at(0), { origin: "agent", senderRole: "orchestrator" })] };
  for (const items of [
    claudeItems([claudeUserLine(largeRelay, at(1_000))]),
    codexItems([codexUserLine(largeRelay, at(1_000)), codexEventLine(largeRelay, at(1_200))]),
  ]) {
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
    const [html] = renderAll(items, evidence);
    expect(html).toContain("internal");
    expect(html).toContain("orchestrator");
    expect(html).not.toContain("bg-user");
  }
});

test("two identical rows — a relay and the operator's own message — resolve by settlement time on claude", () => {
  setLocale("en");
  const relayEvidence: Evidence = { occurrences: [occurrence(RELAYED_TEXT, at(0), { origin: "agent", senderRole: "reviewer" })] };
  /* The relay landed first; the operator repeated its text minutes later. */
  const relayFirst = claudeItems([claudeUserLine(RELAYED_TEXT, at(1_000)), claudeUserLine(RELAYED_TEXT, at(4 * 60_000))]);
  const [relay, operator] = renderAll(relayFirst, relayEvidence);
  expect(relay).toContain("internal");
  expect(relay).toContain("reviewer");
  expect(operator).toContain("bg-user");
  expect(operator).not.toContain("internal");
  /* Mirrored: the operator said it first, the relay repeated it. */
  const operatorFirst = claudeItems([claudeUserLine(RELAYED_TEXT, at(-4 * 60_000)), claudeUserLine(RELAYED_TEXT, at(1_000))]);
  const [earlier, later] = renderAll(operatorFirst, relayEvidence);
  expect(earlier).toContain("bg-user");
  expect(earlier).not.toContain("internal");
  expect(later).toContain("internal");
});

test("two identical rows — a relay and the operator's own message — resolve by settlement time on codex", () => {
  setLocale("en");
  const relayEvidence: Evidence = { occurrences: [occurrence(RELAYED_TEXT, at(0), { origin: "agent", senderRole: "reviewer" })] };
  const relayFirst = codexItems([
    codexUserLine(RELAYED_TEXT, at(1_000)),
    codexEventLine(RELAYED_TEXT, at(1_100)),
    codexUserLine(RELAYED_TEXT, at(4 * 60_000)),
    codexEventLine(RELAYED_TEXT, at(4 * 60_000 + 100)),
  ]);
  expect(relayFirst.filter((item) => item.kind === "user")).toHaveLength(2);
  const [relay, operator] = renderAll(relayFirst, relayEvidence);
  expect(relay).toContain("internal");
  expect(relay).toContain("reviewer");
  expect(operator).toContain("bg-user");
  expect(operator).not.toContain("internal");
  const operatorFirst = codexItems([
    codexUserLine(RELAYED_TEXT, at(-4 * 60_000)),
    codexUserLine(RELAYED_TEXT, at(1_000)),
  ]);
  const [earlier, later] = renderAll(operatorFirst, relayEvidence);
  expect(earlier).toContain("bg-user");
  expect(later).toContain("internal");
});

test("an operator bubble with different text, or one with no evidence at all, never changes", () => {
  setLocale("en");
  const evidence: Evidence = { occurrences: [occurrence(RELAYED_TEXT, at(0), { origin: "agent", senderRole: "reviewer" })] };
  const [html] = renderAll([{ kind: "user", ts: at(500), text: "ship it once the checks pass" }], evidence);
  expect(html).toContain("bg-user");
  expect(html).not.toContain("internal");
  const [bare] = renderAll([{ kind: "user", ts: at(500), text: RELAYED_TEXT }], {});
  expect(bare).toContain("bg-user");
});

test("a delivered claude row whose ledger id never resolved falls back to the occurrence join", () => {
  setLocale("en");
  const historicalRelay: Item = {
    kind: "sysmsg",
    label: "system",
    text: RELAYED_TEXT,
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: at(2_000) },
  };
  const html = renderWithProvenance(historicalRelay, {
    occurrences: [occurrence(RELAYED_TEXT, at(0), { origin: "agent", senderRole: "reviewer" })],
  });
  expect(html).toContain("internal");
  expect(html).toContain("reviewer");
});

test("a ledger-resolved relay consumes its occurrence, so an identical operator message keeps its bubble", () => {
  setLocale("en");
  const structuredRelay: Item = {
    kind: "sysmsg",
    label: "system",
    text: RELAYED_TEXT,
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: at(1_000) },
  };
  const operatorRepeat: Item = { kind: "user", ts: at(3 * 60_000), text: RELAYED_TEXT };
  const [relay, operator] = renderAll([structuredRelay, operatorRepeat], {
    messages: { [ENGINE_MESSAGE_ID]: { origin: "agent", senderRole: "reviewer" } },
    occurrences: [occurrence(RELAYED_TEXT, at(0), { origin: "agent", senderRole: "reviewer" })],
  });
  expect(relay).toContain("internal");
  expect(operator).toContain("bg-user");
  expect(operator).not.toContain("internal");
});

/*
 * #1166 rides the same seam, as one more fact about the SAME delivery: an
 * occurrence can say that its delivery was an orchestrator seat's mandate, and
 * then the row is the seat's card rather than 8 KB of the operator's own words.
 * Because the fact belongs to the delivery, identical bytes from anywhere else
 * are unaffected.
 */

/** 8 KB of seat scaffold, standing in for the mandate here. */
const SEAT_MANDATE = "You are the orchestrator for this project.\n\nOwn the board and report status first.";

test("a delivered mandate replaces the operator bubble it used to be rendered as", () => {
  setLocale("en");
  const [html] = renderAll([{ kind: "user", ts: at(1_000), text: SEAT_MANDATE }], {
    occurrences: [occurrence(SEAT_MANDATE, at(0), { origin: "agent", mandate: { kind: "version", version: 4 } })],
  });
  expect(html).toContain("data-mandate-card");
  expect(html).toContain("Mandate v4");
  expect(html).not.toContain("bg-user");
});

test("the same bytes with no mandate delivery behind them stay the operator's own message", () => {
  setLocale("en");
  /* The operator pasted the mandate into the composer themselves. Same text,
     same row shape, no seat delivery — so it is still them talking. */
  const [pasted] = renderAll([{ kind: "user", ts: at(1_000), text: SEAT_MANDATE }], {
    occurrences: [occurrence(SEAT_MANDATE, at(0), { origin: "operator" })],
  });
  expect(pasted).toContain("bg-user");
  expect(pasted).not.toContain("data-mandate-card");
  /* And with no evidence at all the row is untouched. */
  const [unattributed] = renderAll([{ kind: "user", ts: at(1_000), text: SEAT_MANDATE }], {});
  expect(unattributed).toContain("bg-user");
  expect(unattributed).not.toContain("data-mandate-card");
});

test("a claude row delivered as the mandate becomes the card instead of a system row", () => {
  setLocale("en");
  const html = renderWithProvenance({
    kind: "sysmsg",
    label: "system",
    text: SEAT_MANDATE,
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: at(2_000) },
  }, {
    occurrences: [occurrence(SEAT_MANDATE, at(2_000), { origin: "agent", mandate: { kind: "custom" } })],
  });
  expect(html).toContain("data-mandate-card");
  /* A bespoke mandate reads the same on this surface as in the dock. */
  expect(html).toContain("Mandate custom");
});

test("a mandate the server could not name is still the card, with no qualifier", () => {
  setLocale("en");
  const [html] = renderAll([{ kind: "user", ts: at(1_000), text: SEAT_MANDATE }], {
    occurrences: [occurrence(SEAT_MANDATE, at(0), { origin: "agent", mandate: { kind: "unqualified" } })],
  });
  expect(html).toContain("data-mandate-card");
  expect(html).toContain("Mandate");
  expect(html).not.toContain("Mandate v");
  expect(html).not.toContain("custom");
  expect(html).not.toContain("bg-user");
});

test("an agent relay that carries the mandate text stays the internal card", () => {
  setLocale("en");
  const [html] = renderAll([{ kind: "user", ts: at(1_000), text: SEAT_MANDATE }], {
    occurrences: [occurrence(SEAT_MANDATE, at(0), { origin: "agent", senderRole: "orchestrator" })],
  });
  expect(html).toContain("internal");
  expect(html).toContain("orchestrator");
  expect(html).not.toContain("data-mandate-card");
});
