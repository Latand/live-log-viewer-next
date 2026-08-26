import { describe, expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId, buildAttentionQueue, STALLED_ATTENTION_TTL } from "../attention";
import { decisionLine } from "./decision";

/*
 * The ONE decision line (issue #1167).
 *
 * The dock badge, the toast and the island popover used to carry three parallel
 * strings for the same wait — "Agent is waiting for a reply" said nothing about
 * WHICH decision, and the popover derived its own snippet. These tests pin the
 * single derivation they now share, and pin it to the queue's own reading: the
 * surface that NAMES a wait must be talking about a signal the queue COUNTED,
 * or a toast and a badge start describing different things.
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

/** The line as an English surface renders it, on the queue's own clock. */
const line = (entry: FileEntry, now: number = NOW) => decisionLine(t, "en", entry, now);

function membership(role: string): NonNullable<FileEntry["durableLineage"]>["memberships"][number] {
  return {
    kind: "pipeline",
    containerId: "pipeline-atlas",
    role,
    slot: "implement:1",
    stageId: "implement",
    stageOrder: 0,
    round: 1,
    parentConversationId: null,
  };
}

function lineage(overrides: Partial<NonNullable<FileEntry["durableLineage"]>> = {}): FileEntry["durableLineage"] {
  return { kind: "spawn", role: null, parentConversationId: null, reviewsConversationId: null, memberships: [], ...overrides };
}

describe("the decision behind a wait is named, never merely announced", () => {
  test("a structured question is named by its header", () => {
    expect(line(file({ pendingQuestion: question() }))).toBe("Hero frame");
  });

  test("a header-less question is the generic wording, NEVER the question body", () => {
    /* The body is a paragraph written to be read inside the conversation. On a
       badge it truncates into nonsense, so an absent header buys the generic
       word rather than a sentence fragment. */
    const bodyOnly = file({
      pendingQuestion: question({ questions: [{ header: "", question: "Which capture runs first?\nBoth are cheap.", multiSelect: false, options: [] }] }),
    });
    expect(line(bodyOnly)).toBe("a question");

    const blank = file({
      pendingQuestion: question({ questions: [{ header: "   ", question: "Which capture runs first?", multiSelect: false, options: [] }] }),
    });
    expect(line(blank)).toBe("a question");

    const nothing = file({ pendingQuestion: question({ questions: [] }) });
    expect(line(nothing)).toBe("a question");
  });

  test("a plan is plan approval, whatever its questions say", () => {
    const plan = file({ pendingQuestion: question({ kind: "plan", plan: "1. read 2. write", questions: [{ header: "Ignore me", question: "?", multiSelect: false, options: [] }] }) });
    expect(line(plan)).toBe("plan approval");
  });

  test("a rate-limited agent says until when, and drops the clock when the engine never reported one", () => {
    const until = file({ rateLimit: { source: "account", accountId: "primary", window: "session", resetAt: Date.parse("2026-08-25T14:30:00.000Z") / 1000 } });
    expect(line(until)).toMatch(/^rate-limited until \d\d:\d\d$/);
    const unknown = file({ rateLimit: { source: "pane", accountId: null, window: null, resetAt: null } });
    expect(line(unknown)).toBe("rate-limited");
  });

  test("every terminal prompt is «permission prompt» — the screen names the options, not the decision", () => {
    const scraped = [
      { since: NOW - 60, screenTail: "> 1. Yes", target: "llv:0.0", menu: { question: "Allow the write to src/?", tabs: [], options: [] } },
      { since: NOW - 60, screenTail: "\n  Do you want to proceed?  \n❯ 1. Yes\n", target: "llv:0.0", menu: null },
      { since: NOW - 60, screenTail: "   ", target: "llv:0.0", menu: null },
    ];
    for (const waitingInput of scraped) {
      expect(line(file({ waitingInput } as Partial<FileEntry>))).toBe("permission prompt");
    }
  });

  test("an interrupted agent keeps the interrupted wording", () => {
    expect(line(file({ activity: "stalled", proc: "running" }))).toBe("interrupted or awaiting permission");
  });

  test("a conversation carrying no signal at all names nothing", () => {
    expect(line(file())).toBeNull();
  });
});

/*
 * The queue decides WHETHER a conversation is waiting; this module only decides
 * what to call it. A line that outran that gate is how a toast came to announce
 * «interrupted or awaiting permission» over an agent that had already exited,
 * with no matching row anywhere in the popover behind it.
 */
describe("only a wait the queue counts is a wait the line will name", () => {
  test("an interrupted transcript whose agent already exited is nobody's to answer", () => {
    const abandoned = file({ activity: "stalled", proc: "done" });
    expect(attentionId(abandoned, NOW)).toBeNull();
    expect(line(abandoned)).toBeNull();
  });

  test("an interrupted transcript past the stalled TTL is dead context, not a pending prompt", () => {
    const expired = file({ activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL - 1 });
    expect(attentionId(expired, NOW)).toBeNull();
    expect(line(expired)).toBeNull();

    /* The far side of the same boundary still counts, and still gets named. */
    const fresh = file({ activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL + 1 });
    expect(line(fresh)).toBe("interrupted or awaiting permission");
  });

  test("every file the queue counts is a file the line can name, and no other file is", () => {
    const counted = [
      file({ pendingQuestion: question() }),
      file({ rateLimit: { source: "pane", accountId: null, window: null, resetAt: null } }),
      file({ waitingInput: { since: NOW - 60, screenTail: "> 1. Yes", target: "llv:0.0", menu: null } }),
      file({ activity: "stalled", proc: "running" }),
    ];
    for (const entry of counted) {
      expect(attentionId(entry, NOW)).not.toBeNull();
      expect(line(entry)).not.toBeNull();
    }

    const uncounted = [
      file(),
      file({ activity: "stalled", proc: "done" }),
      file({ activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL - 60 }),
    ];
    for (const entry of uncounted) {
      expect(buildAttentionQueue([entry], NOW)).toHaveLength(0);
      expect(line(entry)).toBeNull();
    }
  });
});

describe("the role label rides along when the conversation's evidence names one", () => {
  test("a durable role is appended, localized, after the decision", () => {
    const builder = file({ pendingQuestion: question(), durableLineage: lineage({ role: "builder" }) });
    expect(line(builder)).toBe("Hero frame · Builder");
    expect(decisionLine(tUk, "uk", builder, NOW)).toBe("Hero frame · Білдер");
  });

  test("an unknown role id still attributes the wait rather than dropping it", () => {
    const custom = file({ pendingQuestion: question(), durableLineage: lineage({ role: "shipwright" }) });
    expect(line(custom)).toBe("Hero frame · shipwright");
  });

  /*
   * A pipeline or flow seat is real evidence of the job an agent was given, and
   * the registry has always read it that way (`conversationAgentRole` falls
   * through to the newest membership). The read model routinely carries
   * `role: null` beside one — an adopted stage records the membership and no
   * conversation role — and that agent was rendering as nobody.
   */
  test("a membership-only agent is attributed by its container seat", () => {
    const staged = file({ pendingQuestion: question(), durableLineage: lineage({ role: null, memberships: [membership("builder")] }) });
    expect(line(staged)).toBe("Hero frame · Builder");
    expect(decisionLine(tUk, "uk", staged, NOW)).toBe("Hero frame · Білдер");
  });

  test("the newest seat wins, and the conversation's own role outranks every seat", () => {
    const rotated = file({
      pendingQuestion: question(),
      durableLineage: lineage({ role: null, memberships: [membership("builder"), membership("reviewer")] }),
    });
    expect(line(rotated)).toBe("Hero frame · Reviewer");

    const declared = file({
      pendingQuestion: question(),
      durableLineage: lineage({ role: "orchestrator", memberships: [membership("builder")] }),
    });
    expect(line(declared)).toBe("Hero frame · Orchestrator");
  });

  test("a seat with no role of its own attributes nobody", () => {
    /* A role-less pipeline stage records the literal placeholder «agent», which
       is the absence of a role spelled as a word — «· agent» is noise. */
    const unnamed = file({ pendingQuestion: question(), durableLineage: lineage({ role: null, memberships: [membership("agent")] }) });
    expect(line(unnamed)).toBe("Hero frame");

    const anonymous = file({ pendingQuestion: question(), durableLineage: lineage({ role: null }) });
    expect(line(anonymous)).toBe("Hero frame");

    const untracked = file({ pendingQuestion: question() });
    expect(line(untracked)).toBe("Hero frame");
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
    expect(line(all)).toBe("Hero frame");
    expect(line(file({ ...all, pendingQuestion: null }))).toBe("rate-limited");
    expect(line(file({ ...all, pendingQuestion: null, rateLimit: null }))).toBe("permission prompt");
    expect(line(file({ ...all, pendingQuestion: null, rateLimit: null, waitingInput: null }))).toBe("interrupted or awaiting permission");
  });
});
