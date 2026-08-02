import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { FeedItem } from "./FeedItem";
import { buildFeed } from "./parse";

const codexFile = {
  path: "/sessions/conversation_voice.jsonl",
  engine: "codex",
  fmt: "codex",
  activity: "recent",
} as FileEntry;

test("the canonical voice persona developer item is first and renders through the system card", () => {
  const persona = "Your name is Alik. Speak the operator's language.";
  const lines = [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-02T10:00:00.000Z",
      payload: {
        type: "message",
        id: `msg_voice_persona_${"a".repeat(64)}`,
        role: "developer",
        content: [{ type: "input_text", text: persona }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-02T10:00:01.000Z",
      payload: {
        type: "message",
        id: "spoken-turn",
        role: "user",
        content: [{ type: "input_text", text: "Give me the status." }],
      },
    }),
  ];

  const feed = buildFeed(codexFile, lines, false, "");
  expect(feed.items.map((item) => item.kind)).toEqual(["sysmsg", "user"]);
  expect(feed.items[0]).toEqual({ kind: "sysmsg", label: "developer", text: persona });

  const first = feed.items[0];
  if (!first) throw new Error("voice persona feed item missing");
  const html = renderToStaticMarkup(<FeedItem item={first} />);
  expect(html).toContain("<details");
  expect(html).toContain("developer");
  expect(html).toContain("Your name is Alik.");
  expect(html).toContain("Speak the operator&#x27;s language.");
});
