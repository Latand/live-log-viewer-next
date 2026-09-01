import { afterEach, expect, test } from "bun:test";

import type { ConversationMigration, FileEntry } from "@/lib/types";

import { cardStatus } from "./cardStatus";
import { resetWorkingSinceForTests } from "./workingSince";

/**
 * Issue #961: the shared status projection is pure and its mixed-state
 * precedence is deterministic — NEEDS YOU over HELD over RUNNING over QUEUED,
 * quiet cards project nothing. Every input is one of the authorities the board
 * already trusts; no fixture invents a parallel lifecycle.
 */

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

afterEach(() => resetWorkingSinceForTests());

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "$HOME/.claude/projects/demo/a.jsonl",
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

const holdingMigration = (held: number, targetAccountId = "acct-b"): ConversationMigration => ({
  intentId: "intent-1",
  trigger: "manual",
  phase: "waiting-turn",
  targetAccountId,
  heldDeliveries: held,
  failure: null,
});

const openTurn = { startedAt: NOW_MS - 754_000, endedAt: null };
const futureWakeup = { fireAt: NOW_MS + 12 * 60_000, reason: "poll CI" };

const everything = (): FileEntry =>
  file({
    pendingQuestion: { toolUseId: "tool-1", askedAt: new Date(NOW_MS - 5_000).toISOString() } as FileEntry["pendingQuestion"],
    migration: holdingMigration(2),
    activity: "live",
    lastTurn: openTurn,
    pendingWakeup: futureWakeup,
  });

test("quiet card projects nothing", () => {
  expect(cardStatus(file(), NOW_MS)).toBeNull();
  expect(cardStatus(file({ activity: "recent" }), NOW_MS)).toBeNull();
});

test("mixed state resolves by precedence: needs-you beats held beats running beats queued", () => {
  const all = everything();
  expect(cardStatus(all, NOW_MS)).toEqual({ kind: "needs-you" });

  const noQuestion = { ...all, pendingQuestion: null };
  expect(cardStatus(noQuestion, NOW_MS)).toEqual({ kind: "held", count: 2 });

  const noHold = { ...noQuestion, migration: undefined };
  expect(cardStatus(noHold, NOW_MS)).toEqual({ kind: "running", elapsedSeconds: 754 });

  const idle = { ...noHold, activity: "idle" as const, lastTurn: { startedAt: NOW_MS - 900_000, endedAt: NOW_MS - 60_000 } };
  expect(cardStatus(idle, NOW_MS)).toEqual({ kind: "queued" });
});

test("needs-you derives from the frozen attention authority, including its stalled TTL", () => {
  expect(cardStatus(file({ rateLimit: { resetAt: null } as FileEntry["rateLimit"] }), NOW_MS)).toEqual({ kind: "needs-you" });
  expect(cardStatus(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }), NOW_MS)).toEqual({ kind: "needs-you" });
  /* Stalled counts only while a live process still waits, within the TTL. */
  expect(cardStatus(file({ activity: "stalled", proc: "running", mtime: NOW_S - 600 }), NOW_MS)).toEqual({ kind: "needs-you" });
  expect(cardStatus(file({ activity: "stalled", proc: null, mtime: NOW_S - 600 }), NOW_MS)).toBeNull();
  expect(cardStatus(file({ activity: "stalled", proc: "running", mtime: NOW_S - 3 * 3600 }), NOW_MS)).toBeNull();
});

test("held reads the registry count level-wise: a committed switch's leftover annotation never shows", () => {
  /* The annotation targets the account the transcript ALREADY runs under —
     the activeCardMigration level rule says the switch completed. */
  const leftover = file({
    path: "$HOME/.config/agent-log-viewer/accounts/claude/acct-b/projects/demo/a.jsonl",
    migration: holdingMigration(3, "acct-b"),
  });
  expect(cardStatus(leftover, NOW_MS)).toBeNull();
  /* Zero held deliveries is not a HELD card, whatever the phase. */
  expect(cardStatus(file({ migration: holdingMigration(0) }), NOW_MS)).toBeNull();
});

test("running requires the open-turn condition; elapsed is null without a turn boundary", () => {
  expect(cardStatus(file({ activity: "live", lastTurn: openTurn }), NOW_MS)).toEqual({ kind: "running", elapsedSeconds: 754 });
  expect(cardStatus(file({ activity: "live", lastTurn: null }), NOW_MS)).toEqual({ kind: "running", elapsedSeconds: null });
  /* A closed turn on a live-looking card is not running. */
  expect(cardStatus(file({ activity: "live", lastTurn: { startedAt: NOW_MS - 900_000, endedAt: NOW_MS - 60_000 } }), NOW_MS)).toBeNull();
});

test("queued follows the wakeup authority and clears once the fire time passes", () => {
  expect(cardStatus(file({ pendingWakeup: futureWakeup }), NOW_MS)).toEqual({ kind: "queued" });
  expect(cardStatus(file({ pendingWakeup: { fireAt: NOW_MS - 1_000, reason: "done" } }), NOW_MS)).toBeNull();
});

test("issue 1397: the WORKING badge times the starting window from the launch admission and never runs backwards", () => {
  const admittedAt = NOW_MS - 45_000;
  const recordAt = admittedAt + 8_000;
  const conversationId = "conversation_1397";
  const spawn: NonNullable<FileEntry["spawn"]> = {
    launchId: "launch_1397",
    clientAttemptId: null,
    accountId: null,
    conversationId,
    generation: 1,
    state: "reconciling",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
    admittedAt,
  };
  /* Reconciling, first message queued, no transcript turn: the badge still
     carries a duration, counted from the admission. */
  const starting = file({ path: "spawn:launch_1397", conversationId, activity: "live", spawn });
  expect(cardStatus(starting, NOW_MS)).toEqual({ kind: "running", elapsedSeconds: 45 });

  /* The first record lands eight seconds after admission and opens the turn,
     and the agent answers within the same poll: the scanned row that replaces
     the placeholder in ONE render already carries the assistant evidence and
     no launch facts at all (the projection retired the chips on it). The badge
     keeps counting from the admission; 52 would be the record's own count. */
  const answered = file({
    path: "/sessions/launch-1397.jsonl",
    conversationId,
    activity: "live",
    lastTurn: { startedAt: recordAt, endedAt: null },
    lastAssistantMessageAt: recordAt + 6_000,
  });
  expect(cardStatus(answered, NOW_MS + 15_000)).toEqual({ kind: "running", elapsedSeconds: 60 });
  expect(cardStatus(answered, NOW_MS + 25_000)).toEqual({ kind: "running", elapsedSeconds: 70 });

  /* A poll that still carries the launch facts on the same open turn is the
     same work: still the admission. */
  const adopted = file({
    ...answered,
    lastAssistantMessageAt: null,
    launch: { ...spawn, state: "recovered", initialMessage: "delivered", deliveredAt: recordAt },
  });
  expect(cardStatus(adopted, NOW_MS + 30_000)).toEqual({ kind: "running", elapsedSeconds: 75 });

  /* The turn ends and a later one opens: new work, its own start. */
  expect(cardStatus(file({ path: "/sessions/launch-1397.jsonl", conversationId, activity: "recent", lastTurn: { startedAt: recordAt, endedAt: NOW_MS + 100_000 } }), NOW_MS + 100_000)).toBeNull();
  const nextTurn = file({ path: "/sessions/launch-1397.jsonl", conversationId, activity: "live", lastTurn: { startedAt: NOW_MS + 300_000, endedAt: null } });
  expect(cardStatus(nextTurn, NOW_MS + 305_000)).toEqual({ kind: "running", elapsedSeconds: 5 });

  /* A window that never saw the starting window reads the transcript anchor. */
  resetWorkingSinceForTests();
  expect(cardStatus(answered, NOW_MS + 15_000)).toEqual({ kind: "running", elapsedSeconds: 52 });
});
