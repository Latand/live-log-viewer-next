import { describe, expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId } from "../attention";
import { attentionDecision, decisionLine } from "./decision";

/*
 * The ONE decision line (issue #1167).
 *
 * The dock badge, the toast and the island popover used to carry three parallel
 * strings for the same wait — "Agent is waiting for a reply" said nothing about
 * WHICH decision, and the popover derived its own snippet. These tests pin the
 * single derivation they now share, and pin its precedence to `attentionId`'s:
 * the surface that NAMES the wait must be talking about the signal the queue
 * COUNTED, or a toast and a badge start describing different things.
 */

const t: TFunction = (key, params) => translate("en", key, params);
const tUk: TFunction = (key, params) => translate("uk", key, params);

const NOW = 1_800_000_000;

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/transcripts/worker.jsonl",
    root: "claude-projects",
    name: "worker.jsonl",
    project: "atlas",
    title: "Worker",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 30,
    size: 10,
    activity: "live",
    proc: null,
    pid: null,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function question(overrides: Record<string, unknown> = {}): FileEntry["pendingQuestion"] {
  return {
    kind: "question",
    toolUseId: "tool-use-1",
    transcriptPath: "/transcripts/worker.jsonl",
    pid: 4242,
    paneTarget: null,
    askedAt: "2026-08-25T10:00:00.000Z",
    questions: [{ header: "Hero frame", question: "Choose the hero framing for the README", multiSelect: false, options: [] }],
    ...overrides,
  } as FileEntry["pendingQuestion"];
}

describe("the decision behind a wait is named, never merely announced", () => {
  test("a structured question is named by its header", () => {
    expect(decisionLine(t, "en", file({ pendingQuestion: question() }))).toBe("Hero frame");
  });

  test("a header-less question is the generic wording, NEVER the question body", () => {
    /* The body is a paragraph written to be read inside the conversation. On a
       badge it truncates into nonsense, so an absent header buys the generic
       word rather than a sentence fragment. */
    const bodyOnly = file({
      pendingQuestion: question({ questions: [{ header: "", question: "Which capture runs first?\nBoth are cheap.", multiSelect: false, options: [] }] }),
    });
    expect(attentionDecision(bodyOnly)).toEqual({ kind: "question", header: null });
    expect(decisionLine(t, "en", bodyOnly)).toBe("a question");

    const blank = file({
      pendingQuestion: question({ questions: [{ header: "   ", question: "Which capture runs first?", multiSelect: false, options: [] }] }),
    });
    expect(decisionLine(t, "en", blank)).toBe("a question");

    const nothing = file({ pendingQuestion: question({ questions: [] }) });
    expect(decisionLine(t, "en", nothing)).toBe("a question");
  });

  test("a plan is plan approval, whatever its questions say", () => {
    const plan = file({ pendingQuestion: question({ kind: "plan", plan: "1. read 2. write", questions: [{ header: "Ignore me", question: "?", multiSelect: false, options: [] }] }) });
    expect(attentionDecision(plan)).toEqual({ kind: "plan" });
    expect(decisionLine(t, "en", plan)).toBe("plan approval");
  });

  test("a rate-limited agent says until when, and drops the clock when the engine never reported one", () => {
    const until = file({ rateLimit: { source: "account", accountId: "primary", window: "session", resetAt: Date.parse("2026-08-25T14:30:00.000Z") / 1000 } });
    expect(decisionLine(t, "en", until)).toMatch(/^rate-limited until \d\d:\d\d$/);
    const unknown = file({ rateLimit: { source: "pane", accountId: null, window: null, resetAt: null } });
    expect(decisionLine(t, "en", unknown)).toBe("rate-limited");
  });

  test("every terminal prompt is «permission prompt» — the screen names the options, not the decision", () => {
    const scraped = [
      { since: NOW - 60, screenTail: "> 1. Yes", target: "llv:0.0", menu: { question: "Allow the write to src/?", tabs: [], options: [] } },
      { since: NOW - 60, screenTail: "\n  Do you want to proceed?  \n❯ 1. Yes\n", target: "llv:0.0", menu: null },
      { since: NOW - 60, screenTail: "   ", target: "llv:0.0", menu: null },
    ];
    for (const waitingInput of scraped) {
      const waiting = file({ waitingInput } as Partial<FileEntry>);
      expect(attentionDecision(waiting)).toEqual({ kind: "permission" });
      expect(decisionLine(t, "en", waiting)).toBe("permission prompt");
    }
  });

  test("an interrupted agent keeps the interrupted wording", () => {
    const stalled = file({ activity: "stalled", proc: "running" });
    expect(attentionDecision(stalled)).toEqual({ kind: "stalled" });
    expect(decisionLine(t, "en", stalled)).toBe("interrupted or awaiting permission");
  });

  test("a conversation carrying no signal at all names nothing", () => {
    expect(attentionDecision(file())).toBeNull();
    expect(decisionLine(t, "en", file())).toBeNull();
  });
});

describe("the role label rides along when the conversation carries one", () => {
  test("a durable role is appended, localized, after the decision", () => {
    const builder = file({
      pendingQuestion: question(),
      durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] },
    });
    expect(decisionLine(t, "en", builder)).toBe("Hero frame · Builder");
    expect(decisionLine(tUk, "uk", builder)).toBe("Hero frame · Білдер");
  });

  test("an unknown role id still attributes the wait rather than dropping it", () => {
    const custom = file({
      pendingQuestion: question(),
      durableLineage: { kind: "spawn", role: "shipwright", parentConversationId: null, reviewsConversationId: null, memberships: [] },
    });
    expect(decisionLine(t, "en", custom)).toBe("Hero frame · shipwright");
  });

  test("a role-less conversation is the decision alone — no empty separator", () => {
    const anonymous = file({
      pendingQuestion: question(),
      durableLineage: { kind: "spawn", role: null, parentConversationId: null, reviewsConversationId: null, memberships: [] },
    });
    expect(decisionLine(t, "en", anonymous)).toBe("Hero frame");
  });
});

describe("the naming follows the queue's own precedence, so one wait is never two things", () => {
  test("every signal precedence step matches attentionId's, question over rate limit over terminal over stalled", () => {
    const all = file({
      pendingQuestion: question(),
      rateLimit: { source: "account", accountId: "primary", window: "session", resetAt: null },
      waitingInput: { since: NOW - 60, screenTail: "> 1. Yes", target: "llv:0.0", menu: null },
      activity: "stalled",
      proc: "running",
    });
    expect(attentionDecision(all)).toEqual({ kind: "question", header: "Hero frame" });

    const withoutQuestion = file({ ...all, pendingQuestion: null });
    expect(attentionDecision(withoutQuestion)?.kind).toBe("rate-limit");

    const terminalOnly = file({ ...all, pendingQuestion: null, rateLimit: null });
    expect(attentionDecision(terminalOnly)?.kind).toBe("permission");
  });

  test("every file the queue counts is a file the line can name", () => {
    const counted = [
      file({ pendingQuestion: question() }),
      file({ rateLimit: { source: "pane", accountId: null, window: null, resetAt: null } }),
      file({ waitingInput: { since: NOW - 60, screenTail: "> 1. Yes", target: "llv:0.0", menu: null } }),
      file({ activity: "stalled", proc: "running" }),
    ];
    for (const entry of counted) {
      expect(attentionId(entry, NOW)).not.toBeNull();
      expect(decisionLine(t, "en", entry)).not.toBeNull();
    }
  });
});
