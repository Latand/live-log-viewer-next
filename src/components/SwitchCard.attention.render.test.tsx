import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { SwitchCard, type SwitchCardTone } from "./SwitchCard";

/* Issue #700: the loudest card used to be "working…", which needs nothing from
   the operator, while the two tones that are blocked ON the operator got the
   quiet treatment. */

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "demo",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as unknown as FileEntry;
}

function card(tone: SwitchCardTone): string {
  return renderToStaticMarkup(
    <SwitchCard
      file={file()}
      title="Session"
      project="demo"
      currentProject="demo"
      descendants={0}
      statusLine="awaiting an answer to a question"
      size="large"
      tone={tone}
      onOpen={() => {}}
      onArchive={() => {}}
    />,
  );
}

/** The halo ring — the strongest signal a card carries. */
const RING = /shadow-\[0_0_0_3px_color-mix/;

test("blocked work carries the attention ring; routine activity does not", () => {
  expect(card("waiting")).toMatch(RING);
  expect(card("stalled")).toMatch(RING);
  expect(card("working")).not.toMatch(RING);
  expect(card("quiet")).not.toMatch(RING);
});

test("the status line of a blocked card takes the tone color and outsizes a working one", () => {
  expect(card("waiting")).toContain("text-warning");
  expect(card("stalled")).toContain("text-danger");
  /* Larger than the 11.5px a working/quiet card's status line gets. */
  expect(card("waiting")).toContain('data-tone="waiting"');
  expect(card("waiting")).toMatch(/text-\[12\.5px\][^"]*text-warning/);
  expect(card("working")).toMatch(/text-\[11\.5px\][^"]*text-primary\/75/);
});
