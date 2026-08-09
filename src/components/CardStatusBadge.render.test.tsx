import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversationMigration, FileEntry } from "@/lib/types";

import { CardStatusBadge } from "./CardStatusBadge";

/**
 * Issue #961: one word plus colour per card, never colour alone. Each kind
 * carries its word as text, its semantic tone token, and a data hook; text
 * sits on the 10px caption floor; the only animated treatment is the
 * needs-you breath (a CSS class the reduced-motion media query stills).
 */

const NOW_MS = Date.now();
const NOW_S = NOW_MS / 1000;

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/home/user/.claude/projects/demo/a.jsonl",
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
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as unknown as FileEntry;
}

const badge = (entry: FileEntry) => renderToStaticMarkup(<CardStatusBadge file={entry} />);

test("a quiet card renders no badge at all", () => {
  expect(badge(file())).toBe("");
});

test("needs-you: warning tone, the word as text, and the one motion class", () => {
  const html = badge(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }));
  expect(html).toContain('data-card-status="needs-you"');
  expect(html).toContain("needs you");
  expect(html).toContain("text-warning");
  expect(html).toContain("card-status-attention");
  /* Caption floor: the badge face never drops below the 10px token. */
  expect(html).toContain("text-caption");
});

test("held: shows the unsettled registry count next to the word", () => {
  const migration: ConversationMigration = {
    intentId: "intent-1",
    trigger: "quota",
    phase: "waiting-turn",
    targetAccountId: "acct-b",
    heldDeliveries: 3,
    failure: null,
  };
  const html = badge(file({ migration }));
  expect(html).toContain('data-card-status="held"');
  expect(html).toContain("held");
  expect(html).toContain("×3");
  expect(html).toContain("text-accent");
  expect(html).not.toContain("card-status-attention");
});

test("running: success tone with the elapsed run time", () => {
  const html = badge(file({ activity: "live", lastTurn: { startedAt: NOW_MS - 12 * 60_000 - 30_000, endedAt: null } }));
  expect(html).toContain('data-card-status="running"');
  expect(html).toContain("working");
  expect(html).toContain("12m");
  expect(html).toContain("text-success");
});

test("queued: muted word from the wakeup authority", () => {
  const html = badge(file({ pendingWakeup: { fireAt: NOW_MS + 600_000, reason: "poll CI" } }));
  expect(html).toContain('data-card-status="queued"');
  expect(html).toContain("queued");
  expect(html).toContain("text-muted");
});
