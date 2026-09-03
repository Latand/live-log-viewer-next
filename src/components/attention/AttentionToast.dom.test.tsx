import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The toast NAMES the decision (issue #1167).
 *
 * It used to say «Agent is waiting for a reply» over every wait there is — a
 * plan, a permission prompt, a rate-limit wall and a five-option question all
 * read the same, so the only way to learn what an agent wanted was to open it.
 * It now carries the same line the island popover row and the orchestrator dock
 * badge carry, and it stays a two-target surface: open, or dismiss.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { AttentionToast } = await import("./AttentionToast");
const { AttentionQueueRow } = await import("./AttentionIsland");
const { buildAttentionQueue, STALLED_ATTENTION_TTL } = await import("../attention");
type FileEntry = import("@/lib/types").FileEntry;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  return host;
}

async function unmount() {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
}

const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
  });

/* The wall clock, because the components derive attention eligibility on it:
   a stalled transcript counts only while a process is behind it and the signal
   is fresh, so its fixtures have to age against the same clock the render uses. */
const NOW = Math.floor(Date.now() / 1000);

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects",
    name: "worker.jsonl",
    path: "/transcripts/worker.jsonl",
    project: "alpha",
    title: "Ship the rollout",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 30,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 4242,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

const question = {
  kind: "question" as const,
  toolUseId: "tool-use-1",
  transcriptPath: "/transcripts/worker.jsonl",
  pid: 4242,
  paneTarget: null,
  askedAt: "2026-08-25T10:00:00.000Z",
  questions: [{ header: "Rollout window", question: "Approve the proposed rollout window", multiSelect: false, options: [] }],
};

const title = (host: HTMLElement) => host.querySelector("[data-attention-toast-title]")?.textContent ?? null;

test("the title is the decision plus the role, and the body stays the conversation", async () => {
  const host = await render(
    <AttentionToast
      file={file({
        pendingQuestion: question,
        durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] },
      } as Partial<FileEntry>)}
      mobile={false}
      onOpen={() => {}}
      onDismiss={() => {}}
    />,
  );

  expect(title(host)).toBe("Rollout window · Builder");
  expect(host.textContent).toContain("Ship the rollout");
});

/**
 * Every kind of wait the queue counts, with the ONE line it must read as.
 *
 * A terminal prompt is «permission prompt» whatever the screen is drawing, and
 * a header-less question is the generic word rather than a slice of its own
 * body: a title assembled from scraped text names the OPTIONS on screen, not
 * the decision, and «❯ 1. Yes» is what that produced.
 */
const WAITS: Array<[string, Partial<FileEntry>, string]> = [
  ["a question, by its header", { pendingQuestion: question }, "Rollout window"],
  [
    "a header-less question, by the generic word",
    { pendingQuestion: { ...question, questions: [{ header: "", question: "Which capture runs first?", multiSelect: false, options: [] }] } },
    "a question",
  ],
  ["a plan", { pendingQuestion: { ...question, kind: "plan", plan: "1. read 2. write" } }, "plan approval"],
  ["a wall", { rateLimit: { source: "account", accountId: "primary", window: "session", resetAt: null } }, "rate-limited"],
  [
    "a terminal prompt, whatever the menu says",
    { waitingInput: { since: NOW - 60, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: { question: "Allow the write to src/?", tabs: [], options: [] } } },
    "permission prompt",
  ],
  ["an interrupted turn", { activity: "stalled", mtime: NOW - 60 }, "interrupted or awaiting permission"],
];

test("a plan, a wall, a terminal prompt and an interrupted turn each name themselves", async () => {
  for (const [, overrides, expected] of WAITS) {
    const host = await render(
      <AttentionToast file={file(overrides as Partial<FileEntry>)} mobile={false} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(title(host)).toBe(expected);
    await unmount();
  }
});

test("the toast title and the island popover row are the SAME line, for every kind of wait", async () => {
  for (const [, overrides] of WAITS) {
    const entry = file(overrides as Partial<FileEntry>);
    const item = buildAttentionQueue([entry], NOW)[0]!;

    let host = await render(<AttentionToast file={entry} mobile={false} onOpen={() => {}} onDismiss={() => {}} />);
    const toastLine = title(host);
    await unmount();

    host = await render(<AttentionQueueRow item={item} onOpen={() => {}} />);
    const rowLine = host.querySelector("[data-attention-decision]")?.textContent ?? null;
    await unmount();

    /* Not the generic fallback either: a counted wait always has a name. */
    expect(toastLine).not.toBe("Agent is waiting for a reply");
    expect(rowLine).toBe(toastLine);
  }
});

test("a toast still up after its question was answered elsewhere falls back rather than inventing a decision", async () => {
  const host = await render(<AttentionToast file={file()} mobile={false} onOpen={() => {}} onDismiss={() => {}} />);
  expect(title(host)).toBe("Agent is waiting for a reply");
});

/**
 * The toast holds a file the operator has not dismissed, so it outlives its own
 * signal routinely — and it must never name a decision the popover behind it
 * does not list. An interrupted transcript is only a wait while a process is
 * still behind it and the signal is fresh; past either, the toast falls back to
 * the generic wording instead of announcing a prompt nobody is holding.
 */
const ABANDONED: Array<[string, Partial<FileEntry>]> = [
  ["the agent already exited", { activity: "stalled", proc: "done", mtime: NOW - 60 }],
  ["the interruption is dead context", { activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL - 60 }],
];

test("an interrupted turn nobody is behind names no decision, on the toast or in the queue", async () => {
  for (const [, overrides] of ABANDONED) {
    const entry = file(overrides as Partial<FileEntry>);
    expect(buildAttentionQueue([entry], NOW)).toHaveLength(0);

    const host = await render(<AttentionToast file={entry} mobile={false} onOpen={() => {}} onDismiss={() => {}} />);
    expect(title(host)).toBe("Agent is waiting for a reply");
    await unmount();
  }
});

/* On the phone the toast is the ARRIVAL BANNER (mobile v2 lane 8, #1439): the
   shell's one banner slot reads «Needs you · <decision>» over the title, the
   body opens, × dismisses, both at 44 px. The collapse timer and the
   own-conversation rule are in AttentionToast.arrival.dom.test.tsx, under fake
   timers. */
test("the phone banner names the decision under «Needs you», and open and dismiss stay separate 44 px targets", async () => {
  const events: string[] = [];
  const host = await render(
    <AttentionToast
      file={file({ pendingQuestion: question } as Partial<FileEntry>)}
      mobile
      onOpen={() => events.push("open")}
      onDismiss={() => events.push("dismiss")}
    />,
  );

  expect(title(host)).toBe("Needs you · Rollout window");
  expect(host.textContent).toContain("Ship the rollout");
  /* The phone root is the arrival hook, never `data-attention-toast`: the
     shell's banner slot is the one receipt the capture gate measures. */
  expect(host.querySelector("[data-attention-toast]")).toBeNull();
  const banner = host.querySelector("[data-mobile2-arrival]")!;
  expect(banner.getAttribute("data-mobile2-arrival")).toBe("/transcripts/worker.jsonl");
  expect(banner.className).toContain("min-h-11");
  const open = host.querySelector("[data-attention-toast-open]")!;
  const dismiss = host.querySelector("[data-attention-toast-dismiss]")!;
  expect(open.className).toContain("min-h-11");
  expect(dismiss.className).toContain("h-11");
  expect(dismiss.className).toContain("w-11");
  await click(open);
  await click(dismiss);
  expect(events).toEqual(["open", "dismiss"]);
});
