import { describe, expect, test } from "bun:test";

import { BRIDGE_ASK_TTL_SECONDS } from "@/lib/bridge/types";
import { en } from "@/lib/i18n/en";
import type { FileEntry, PendingQuestion } from "@/lib/types";

import { buildAttentionQueue } from "../attention";
import { attentionSnippet } from "./snippet";

/**
 * The queue row's words, which must name the same signal the row was ENQUEUED
 * under. #1168 added one that ages out on the clock rather than on a poll, so
 * the wording has to age out with it.
 */

const NOW = 1_800_000_000;
const t = ((key: keyof typeof en) => en[key] as string) as Parameters<typeof attentionSnippet>[0];

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function question(toolUseId: string, header: string): PendingQuestion {
  return {
    kind: "question",
    toolUseId,
    transcriptPath: "/t",
    pid: 1,
    paneTarget: null,
    askedAt: new Date((NOW - 10) * 1000).toISOString(),
    questions: [{ header, question: header, options: [], multiSelect: false }],
  };
}

function snippetFor(file: FileEntry, now: number): string {
  const item = buildAttentionQueue([file], now)[0];
  return item ? attentionSnippet(t, item, now) : "";
}

describe("attentionSnippet", () => {
  test("an open orchestrator ask names the decision, above the seat's own prompt", () => {
    const seat = entry({
      path: "/seat",
      bridgeAsk: { id: "lane-4-blocked", at: new Date((NOW - 900) * 1000).toISOString() },
      pendingQuestion: question("toolu_local", "pick a base branch"),
    });
    expect(snippetFor(seat, NOW)).toBe(en["status.awaitingDecision"] as string);
  });

  test("an expired ask hands the words back to the signal the queue fell through to", () => {
    const seat = entry({
      path: "/seat",
      bridgeAsk: { id: "lane-4-blocked", at: new Date((NOW - BRIDGE_ASK_TTL_SECONDS - 1) * 1000).toISOString() },
      pendingQuestion: question("toolu_local", "pick a base branch"),
    });
    expect(snippetFor(seat, NOW)).toBe("pick a base branch");
  });

  test("nothing else is disturbed: the stalled tail keeps its historical wording", () => {
    const stalled = entry({ path: "/stall", activity: "stalled", proc: "running", mtime: NOW - 60 });
    expect(snippetFor(stalled, NOW)).toBe(en["status.stalled"] as string);
  });
});
