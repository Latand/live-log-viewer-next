import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
import { Sparkle } from "@/components/icons";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { lastTurnFromRecords } from "@/lib/scanner/turnDuration";

import { TurnStatusBar } from "./TurnStatusBar";
import { resetWorkingSinceForTests } from "./workingSince";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  setSystemTime();
  resetWorkingSinceForTests();
});

type StatusFile = Pick<FileEntry, "lastTurn" | "activity" | "mtime" | "pendingQuestion" | "waitingInput" | "rateLimit">
  & Partial<Pick<FileEntry, "path" | "conversationId" | "spawn" | "launch" | "lastAssistantMessageAt">>;

const file = (
  lastTurn: FileEntry["lastTurn"],
  activity: FileEntry["activity"],
  overrides: Partial<Pick<FileEntry, "mtime" | "pendingQuestion" | "waitingInput" | "rateLimit">> = {},
) => ({ lastTurn, activity, mtime: 0, pendingQuestion: null, waitingInput: null, rateLimit: null, ...overrides }) as StatusFile;

const render = (entry: StatusFile, container: HTMLElement) => {
  root ??= createRoot(container);
  flushSync(() => root!.render(<TurnStatusBar file={entry} workingLabel="working…" workingIcon={Sparkle} />));
};

test("live open turn ticks the elapsed timer every second and unmounts at terminal", () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let tick: (() => void) | null = null;
  let started = 0;
  const cleared: number[] = [];
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    started += 1;
    return started;
  };
  // @ts-expect-error test double
  globalThis.clearInterval = (id: number) => cleared.push(id);
  try {
    const t0 = Date.parse("2026-07-18T10:00:00.000Z");
    setSystemTime(new Date(t0));
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Prompt accepted at t0, agent working: the bottom slot carries the label
    // and a named timer element seeded at 0s.
    render(file({ startedAt: t0, endedAt: null }, "live"), container);
    const timer = () => container.querySelector('[role="timer"]');
    expect(container.querySelector('[data-turn-status="running"]')).not.toBeNull();
    expect(timer()?.getAttribute("aria-label")).toBe("elapsed work time");
    expect(timer()?.textContent).toBe("0s");
    expect(started).toBe(1);

    // 4 minutes 32 seconds into the turn (a long tool call in between — the
    // timer tracks the wall clock, not transcript writes).
    setSystemTime(new Date(t0 + (4 * 60 + 32) * 1000));
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("4m 32s");

    // The turn ends: the timer unmounts and its interval is cleared. The
    // response row owns the completed total.
    render(file({ startedAt: t0, endedAt: t0 + 5 * 60 * 1000 }, "recent"), container);
    expect(timer()).toBeNull();
    expect(cleared).toContain(1);
    expect(container.querySelector('[data-turn-status="finished"]')).toBeNull();
    expect(container.querySelector('[data-turn-status="running"]')).toBeNull();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test("a held delivery starts the timer at transcript receipt instead of composer send", () => {
  const realSet = globalThis.setInterval;
  let tick: (() => void) | null = null;
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  try {
    const sentAt = Date.parse("2026-07-18T10:00:00.000Z");
    const receivedAt = sentAt + 60_000;
    setSystemTime(new Date(receivedAt));
    const container = document.createElement("div");
    document.body.appendChild(container);

    const laggedDelivery = {
      sentAt,
      file: file(lastTurnFromRecords([{
        type: "user",
        timestamp: new Date(receivedAt).toISOString(),
        message: { role: "user", content: "delivered after a hold" },
      }], false), "live"),
    };
    expect(laggedDelivery.file.lastTurn?.startedAt).toBe(receivedAt);
    expect(laggedDelivery.file.lastTurn?.startedAt).not.toBe(laggedDelivery.sentAt);
    render(laggedDelivery.file, container);
    setSystemTime(new Date(receivedAt + 3000));
    flushSync(() => tick!());
    expect(container.querySelector('[role="timer"]')?.textContent).toBe("3s");
    expect(container.querySelector('[role="timer"]')?.textContent).not.toBe("1m 3s");
  } finally {
    globalThis.setInterval = realSet;
  }
});

test("live agent with no known boundary keeps the working label without a timer", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(file(null, "live"), container);
  expect(container.querySelector('[data-turn-status="running"]')?.textContent).toContain("working…");
  expect(container.querySelector('[role="timer"]')).toBeNull();
});

test("idle pane with no completed turn renders nothing", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(file(null, "idle"), container);
  expect(container.querySelector("[data-turn-status]")).toBeNull();
});

test("a pending question takes precedence over a live turn and uses the warning tone", () => {
  const t0 = Date.parse("2026-07-18T10:00:00.000Z");
  setSystemTime(new Date(t0 + 90 * 60 * 1000));
  const container = document.createElement("div");
  document.body.appendChild(container);

  render(file({ startedAt: t0, endedAt: null }, "live", {
    pendingQuestion: {
      kind: "question",
      toolUseId: "tool-1",
      transcriptPath: "/sessions/q.jsonl",
      pid: 42,
      paneTarget: "%1",
      askedAt: new Date(t0).toISOString(),
    },
  }), container);

  const waiting = container.querySelector('[data-turn-status="waiting"]');
  expect(waiting?.textContent).toContain("waiting for your answer");
  expect(waiting?.textContent).toContain("1:30:00");
  expect(waiting?.className).toContain("text-warning");
  expect(container.querySelector('[data-turn-status="running"]')).toBeNull();
});

test("terminal waits take precedence over a finished turn", () => {
  const t0 = Date.parse("2026-07-18T10:00:00.000Z");
  setSystemTime(new Date(t0 + 65 * 1000));
  const container = document.createElement("div");
  document.body.appendChild(container);

  render(file({ startedAt: t0, endedAt: t0 + 30_000 }, "recent", {
    waitingInput: { since: t0 / 1000, screenTail: "Continue?", target: "%1", menu: null },
  }), container);

  const waiting = container.querySelector('[data-turn-status="waiting"]');
  expect(waiting?.textContent).toContain("waiting for your answer");
  expect(waiting?.textContent).toContain("1:05");
  expect(waiting?.className).toContain("text-warning");
  expect(container.querySelector('[data-turn-status="finished"]')).toBeNull();
});

test("a rate limit still renders the operator-blocked status without an open turn", () => {
  const t0 = Date.parse("2026-07-18T10:00:00.000Z");
  setSystemTime(new Date(t0 + 65 * 1000));
  const container = document.createElement("div");
  document.body.appendChild(container);

  render(file(null, "idle", {
    mtime: t0 / 1000,
    rateLimit: { source: "account", accountId: "account-a", window: "session", resetAt: null },
  }), container);

  expect(container.querySelector('[data-turn-status="waiting"]')?.textContent).toContain("waiting for your answer");
  expect(container.querySelector('[data-turn-status="waiting"]')?.textContent).toContain("1:05");
  expect(container.querySelector('[data-turn-status="waiting"]')?.className).toContain("text-warning");
});

test("issue 1397: the starting window times working… from the launch admission and never runs backwards", () => {
  const realSet = globalThis.setInterval;
  let tick: (() => void) | null = null;
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  try {
    const admittedAt = Date.parse("2026-09-01T09:00:00.000Z");
    /* The host journals the first user record eight seconds after admission:
       a timer re-anchored on that record would drop by eight seconds. */
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
    const container = document.createElement("div");
    document.body.appendChild(container);
    const timer = () => container.querySelector('[data-turn-status="running"] [role="timer"]');

    /* Reconciling, first message queued, no transcript turn at all: the
       working label carries the elapsed time since the launch was admitted. */
    setSystemTime(new Date(admittedAt + 45_000));
    render({ ...file(null, "live"), path: "spawn:launch_1397", conversationId, spawn }, container);
    expect(container.querySelector('[data-turn-status="running"]')?.textContent).toContain("working…");
    expect(timer()?.textContent).toBe("45s");

    /* The record lands, the agent answers within the same poll, and the board
       flips the placeholder to the scanned row in ONE render: its open turn
       starts at the record, it carries the assistant evidence, and the
       projection has already retired the launch facts on it. The counter keeps
       counting from the admission — never the record's own 52s. */
    setSystemTime(new Date(admittedAt + 60_000));
    render({
      ...file({ startedAt: recordAt, endedAt: null }, "live"),
      path: "/sessions/launch-1397.jsonl",
      conversationId,
      lastAssistantMessageAt: recordAt + 6_000,
    }, container);
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("1m");

    /* Ticking on, same open turn: still the admission, no jump. */
    setSystemTime(new Date(admittedAt + 70_000));
    render({
      ...file({ startedAt: recordAt, endedAt: null }, "live"),
      path: "/sessions/launch-1397.jsonl",
      conversationId,
      lastAssistantMessageAt: recordAt + 6_000,
    }, container);
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("1m 10s");

    /* The turn ends: nothing to time. The next turn is new work and counts
       from its own transcript start. */
    render({ ...file({ startedAt: recordAt, endedAt: admittedAt + 200_000 }, "recent"), path: "/sessions/launch-1397.jsonl", conversationId }, container);
    expect(timer()).toBeNull();
    setSystemTime(new Date(admittedAt + 305_000));
    render({ ...file({ startedAt: admittedAt + 300_000, endedAt: null }, "live"), path: "/sessions/launch-1397.jsonl", conversationId }, container);
    expect(timer()?.textContent).toBe("5s");
  } finally {
    globalThis.setInterval = realSet;
  }
});

test("issue 1397: a poll that still carries the launch chips on the open turn is the same work", () => {
  const realSet = globalThis.setInterval;
  let tick: (() => void) | null = null;
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  try {
    const admittedAt = Date.parse("2026-09-01T09:00:00.000Z");
    const recordAt = admittedAt + 8_000;
    const conversationId = "conversation_1397_chips";
    const spawn: NonNullable<FileEntry["spawn"]> = {
      launchId: "launch_1397_chips",
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
    const container = document.createElement("div");
    document.body.appendChild(container);
    const timer = () => container.querySelector('[data-turn-status="running"] [role="timer"]');
    setSystemTime(new Date(admittedAt + 45_000));
    render({ ...file(null, "live"), path: "spawn:launch_1397_chips", conversationId, spawn }, container);
    expect(timer()?.textContent).toBe("45s");

    /* The board caught the scanned row before the agent answered: the launch
       still rides it as chips. */
    setSystemTime(new Date(admittedAt + 60_000));
    render({
      ...file({ startedAt: recordAt, endedAt: null }, "live"),
      path: "/sessions/launch-1397-chips.jsonl",
      conversationId,
      launch: { ...spawn, state: "recovered", initialMessage: "delivered", deliveredAt: recordAt },
    }, container);
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("1m");

    /* Then the chips retire on the first assistant message, same open turn. */
    setSystemTime(new Date(admittedAt + 70_000));
    render({
      ...file({ startedAt: recordAt, endedAt: null }, "live"),
      path: "/sessions/launch-1397-chips.jsonl",
      conversationId,
      lastAssistantMessageAt: recordAt + 15_000,
    }, container);
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("1m 10s");
  } finally {
    globalThis.setInterval = realSet;
  }
});

test("a fresh window that never saw the starting window counts from the transcript anchor", () => {
  const admittedAt = Date.parse("2026-09-01T09:00:00.000Z");
  const recordAt = admittedAt + 8_000;
  setSystemTime(new Date(admittedAt + 60_000));
  const container = document.createElement("div");
  document.body.appendChild(container);
  render({
    ...file({ startedAt: recordAt, endedAt: null }, "live"),
    path: "/sessions/launch-1397-fresh.jsonl",
    conversationId: "conversation_1397_fresh",
    launch: {
      launchId: "launch_1397_fresh",
      clientAttemptId: null,
      accountId: null,
      conversationId: "conversation_1397_fresh",
      generation: 1,
      state: "recovered",
      initialMessage: "delivered",
      retrySafe: false,
      error: null,
      admittedAt,
      deliveredAt: recordAt,
    },
  }, container);
  expect(container.querySelector('[data-turn-status="running"] [role="timer"]')?.textContent).toBe("52s");
});
