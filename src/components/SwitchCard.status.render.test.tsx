import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { SwitchCard } from "./SwitchCard";

/**
 * Issue #961: the switch card carries the same status vocabulary as the board
 * cards — one projected word, quiet cards none — beside its existing free-text
 * status line, which stays untouched.
 */

const NOW_S = Date.now() / 1000;

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
    mtime: NOW_S - 30,
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

function card(entry: FileEntry): string {
  return renderToStaticMarkup(
    <SwitchCard
      file={entry}
      title="Session"
      project="demo"
      currentProject="demo"
      descendants={0}
      statusLine="working on the release"
      size="large"
      tone="working"
      onOpen={() => {}}
      onArchive={() => {}}
    />,
  );
}

test("a blocked switch card carries the needs-you word; a quiet one carries none", () => {
  const blocked = card(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }));
  expect(blocked).toContain('data-card-status="needs-you"');
  expect(blocked).toContain("needs you");
  expect(card(file())).not.toContain("data-card-status");
});

test("the existing status line survives beside the projected word", () => {
  const blocked = card(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }));
  expect(blocked).toContain("working on the release");
});
