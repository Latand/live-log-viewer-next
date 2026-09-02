import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { emptyStore } from "@/components/runtime/runtimeModel";

/**
 * The starting window of a structured launch (#1397 / #1398): a pipeline
 * stage's conversation while its first message is still queued and the launch
 * is reconciling. The window is driven the way the board drives it — the
 * `spawn:<launchId>` placeholder first, the same placeholder once the host has
 * written the first transcript records, then the scanned transcript row that
 * adopts the launch — and two things are asserted at every step:
 *
 *  - the stage's INTERNAL prompt renders exactly once (#1398): the optimistic
 *    launch bubble before the transcript has it, the transcript's own relay
 *    card after, never both and never two cards for the one message the
 *    rollout journals twice;
 *  - "working…" carries a running duration (#1397), anchored on the launch
 *    admission while no transcript turn exists and never running backwards
 *    once the later transcript anchor appears, in the footer indicator and in
 *    the header WORKING badge alike.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  IntersectionObserver: undefined,
});

let tailLines: string[] = [];

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
const actualToolCues = await import("@/hooks/useToolActivityCues");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: () => ({
    lines: tailLines,
    linesStart: 0,
    size: tailLines.length,
    loading: false,
    error: null,
    tickTime: null,
    paused: false,
    setPaused: () => undefined,
    clear: () => undefined,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => 0,
    prependGen: 0,
  }),
}));
mock.module("@/hooks/useToolActivityCues", () => ({
  ...actualToolCues,
  useToolActivityCues: () => undefined,
}));

const { LogFeed } = await import("./LogFeed");
const { CardStatusBadge } = await import("./CardStatusBadge");
const { resetOutboxForTests } = await import("./conversation/outbox");

/* The launch was admitted at T0; the host journals the first record eight
   seconds later. A timer anchored on that record would read eight seconds
   less than one anchored on the admission — the two anchors are told apart. */
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const RECORD_AT = T0 + 8_000;
const PROMPT = "You are the Builder.\n\nPinned task: the starting window renders the stage prompt exactly once.";
const INTERNAL = "<!-- llv:structured-user origin=agent sender=builder -->\n" + PROMPT;

/* The agent's first visible reply, six seconds after the prompt landed: the
   scanner's assistant evidence, on which the projection retires the launch
   facts while the turn is still open. */
const ANSWER_AT = RECORD_AT + 6_000;

/* The rollout journals the stage prompt twice: the persisted user item and
   the 0.151 thread lifecycle's item_completed echo of the very same item. */
const transcriptRecords = [
  JSON.stringify({
    timestamp: new Date(RECORD_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_user_starting_window", role: "user", content: [{ type: "input_text", text: INTERNAL }] },
  }),
  JSON.stringify({
    timestamp: new Date(RECORD_AT + 176).toISOString(),
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "thread_starting_window",
      turn_id: "turn_starting_window",
      item: {
        type: "UserMessage",
        id: "item_user_starting_window",
        client_id: "spawn_message_launch_starting_window",
        content: [{ type: "text", text: INTERNAL, text_elements: [] }],
      },
      started_at_ms: RECORD_AT + 176,
      completed_at_ms: RECORD_AT + 176,
    },
  }),
];
const answeredRecords = [
  ...transcriptRecords,
  JSON.stringify({
    timestamp: new Date(ANSWER_AT).toISOString(),
    type: "response_item",
    payload: { type: "message", id: "item_assistant_starting_window", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the pipeline spec first." }] },
  }),
];

let now = T0;
const originalDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks: Array<() => void> = [];

const roots = new Set<Root>();
beforeEach(() => {
  now = T0;
  Date.now = () => now;
  ticks = [];
  // @ts-expect-error test double: every 1 Hz timer in the window is driven by hand
  globalThis.setInterval = (fn: () => void) => {
    ticks.push(fn);
    return ticks.length;
  };
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;
  setLocale("en");
  tailLines = [];
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  Date.now = originalDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  mock.module("@/hooks/useToolActivityCues", () => actualToolCues);
});

function launchFacts(conversationId: string, launchId: string, overrides: Partial<StructuredSpawnCardState> = {}): StructuredSpawnCardState {
  return {
    launchId,
    clientAttemptId: null,
    accountId: null,
    conversationId,
    generation: 1,
    state: "reconciling",
    initialMessage: "queued",
    retrySafe: false,
    error: null,
    admittedAt: T0,
    promptAt: T0,
    promptImages: 0, prompt: PROMPT,
    promptEcho: PROMPT,
    ...overrides,
  };
}

/** The board's projection of the launch while no transcript is scanned. */
function placeholder(conversationId: string, launchId: string): FileEntry {
  return {
    path: `spawn:${launchId}`,
    root: "codex-sessions",
    name: `spawn:${launchId}`,
    project: "project",
    title: "Builder",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: T0 / 1000,
    size: 0,
    activity: "live",
    activityReason: "structured_spawn_reconciling",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId,
    generation: 1,
    spawnOrigin: "viewer",
    spawn: launchFacts(conversationId, launchId),
  } as FileEntry;
}

/** The scanned transcript row the board most often shows first (the agent's
    first reply follows the first record within one poll): the first user
    record opened a turn, the assistant evidence is on the row, and the
    projection has already retired every launch fact from it — no chips, no
    admission instant, only the transcript. */
function answered(conversationId: string, launchId: string): FileEntry {
  const { spawn: _spawn, ...rest } = placeholder(conversationId, launchId);
  return {
    ...rest,
    path: `/sessions/${launchId}.jsonl`,
    name: `${launchId}.jsonl`,
    mtime: ANSWER_AT / 1000,
    size: 3,
    activityReason: "jsonl_turn_open",
    lastTurn: { startedAt: RECORD_AT, endedAt: null },
    lastAssistantMessageAt: ANSWER_AT,
  } as FileEntry;
}

/** The scanned transcript row caught before the agent answered: the first
    user record opened a turn, the delivery receipt settled, the launch still
    rides as chips. */
function adopted(conversationId: string, launchId: string): FileEntry {
  const { spawn: _spawn, ...rest } = placeholder(conversationId, launchId);
  return {
    ...rest,
    path: `/sessions/${launchId}.jsonl`,
    name: `${launchId}.jsonl`,
    mtime: RECORD_AT / 1000,
    size: 2,
    activityReason: "jsonl_turn_open",
    lastTurn: { startedAt: RECORD_AT, endedAt: null },
    lastAssistantMessageAt: null,
    launch: launchFacts(conversationId, launchId, {
      state: "recovered",
      initialMessage: "delivered",
      deliveredAt: RECORD_AT,
      promptImages: undefined, prompt: undefined,
      promptAt: undefined,
    }),
  } as FileEntry;
}

function render(file: FileEntry, root?: Root): { host: HTMLElement; root: Root } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const mounted = root ?? createRoot(host as unknown as HTMLElement);
  roots.add(mounted);
  flushSync(() => {
    mounted.render(
      <>
        <CardStatusBadge file={file} />
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={() => undefined}
        />
      </>,
    );
  });
  return { host: host as unknown as HTMLElement, root: mounted };
}

function rerender(root: Root, file: FileEntry): void {
  flushSync(() => {
    root.render(
      <>
        <CardStatusBadge file={file} />
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={() => undefined}
          paused
          follow={false}
          setFollow={() => undefined}
        />
      </>,
    );
  });
  /* The 1 Hz timers re-read the clock. */
  flushSync(() => {
    for (const tick of ticks) tick();
  });
}

/** Every rendering of the prompt the window can show: the optimistic launch
    bubble, the transcript's relay card, a transcript user bubble. */
function promptRenderings(host: HTMLElement): number {
  return host.querySelectorAll('[data-outbox-entry], [data-feed-kind="tmsg"], [data-feed-kind="user"]').length;
}

function footerTimer(host: HTMLElement): string | null {
  return host.querySelector('[data-turn-status="running"] [role="timer"]')?.textContent ?? null;
}

function headerBadge(host: HTMLElement): string | null {
  return dom.document.querySelector('[data-card-status="running"]')?.textContent ?? null;
}

test("issue 1398: the stage's INTERNAL prompt renders exactly once before and after its transcript record lands", () => {
  const conversationId = "conversation_prompt_once";
  const launchId = "launch_prompt_once";
  now = T0 + 45_000;

  /* Reconciling, first message queued, nothing journaled yet: the optimistic
     launch bubble is the prompt's one rendering. */
  const { host, root } = render(placeholder(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")?.getAttribute("data-launch-state")).toBe("reconciling");
  expect(host.querySelector("[data-launch-chips]")?.getAttribute("data-launch-initial")).toBe("queued");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);

  /* The host journals the prompt (twice, as the rollout does) while the board
     still projects the reconciling placeholder: the durable transcript row
     wins and the optimistic bubble retires: one INTERNAL card. */
  tailLines = transcriptRecords;
  now = T0 + 53_000;
  rerender(root, placeholder(conversationId, launchId));
  const internalCards = host.querySelectorAll('[data-feed-kind="tmsg"]');
  expect(internalCards).toHaveLength(1);
  expect(internalCards[0]?.textContent).toContain("internal");
  expect(internalCards[0]?.textContent).toContain("builder");
  expect(host.querySelectorAll("[data-outbox-entry]")).toHaveLength(0);
  expect(promptRenderings(host)).toBe(1);

  /* The scanned transcript adopts the launch: still exactly one. */
  now = T0 + 60_000;
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelectorAll('[data-feed-kind="tmsg"]')).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);

  /* The agent answers and the launch facts retire from the row: still one. */
  tailLines = answeredRecords;
  now = T0 + 70_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelectorAll('[data-feed-kind="tmsg"]')).toHaveLength(1);
  expect(promptRenderings(host)).toBe(1);
});

test("issue 1397: working… carries the elapsed time from the launch admission and never runs backwards", () => {
  const conversationId = "conversation_elapsed";
  const launchId = "launch_elapsed";
  now = T0 + 45_000;

  /* Reconciling, first message queued, no transcript turn: the footer says
     working… with a running duration, and so does the header WORKING badge. */
  const { host, root } = render(placeholder(conversationId, launchId));
  const footer = host.querySelector('[data-turn-status="running"]');
  expect(footer?.textContent).toContain("working…");
  expect(footerTimer(host)).toBe("45s");
  expect(headerBadge(host)).toContain("working");
  expect(headerBadge(host)).toContain("45s");

  /* The first transcript record lands eight seconds after the admission, the
     agent answers within the same poll, and the board flips the placeholder
     to the scanned row in ONE render: its open turn starts at the record, it
     carries the assistant evidence, and the projection has already retired
     every launch fact from it. The counter keeps counting from the admission
     — never the record's own 52s. */
  tailLines = answeredRecords;
  now = T0 + 60_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).toBeNull();
  expect(footerTimer(host)).toBe("1m");
  expect(footerTimer(host)).not.toBe("52s");
  expect(headerBadge(host)).toContain("1m");
  expect(headerBadge(host)).not.toContain("52s");

  /* Ticking on, still from the admission. */
  now = T0 + 61_000;
  rerender(root, answered(conversationId, launchId));
  expect(footerTimer(host)).toBe("1m 1s");
  expect(headerBadge(host)).toContain("1m 1s");
});

test("issue 1397: a poll that still carries the launch chips on the open turn is the same work, and its retirement is no jump either", () => {
  const conversationId = "conversation_elapsed_chips";
  const launchId = "launch_elapsed_chips";
  now = T0 + 45_000;
  const { host, root } = render(placeholder(conversationId, launchId));
  expect(footerTimer(host)).toBe("45s");
  expect(headerBadge(host)).toContain("45s");

  /* The board caught the scanned row before the agent answered: the launch
     still rides it as chips, the open turn starts at the record. */
  tailLines = transcriptRecords;
  now = T0 + 53_000;
  rerender(root, adopted(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).not.toBeNull();
  expect(footerTimer(host)).toBe("53s");
  expect(headerBadge(host)).toContain("53s");

  /* The agent answers and the chips retire, same open turn: still the admission. */
  tailLines = answeredRecords;
  now = T0 + 60_000;
  rerender(root, answered(conversationId, launchId));
  expect(host.querySelector("[data-launch-chips]")).toBeNull();
  expect(footerTimer(host)).toBe("1m");
  expect(headerBadge(host)).toContain("1m");
});
