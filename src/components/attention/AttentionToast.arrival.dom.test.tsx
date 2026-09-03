import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The arrival banner (mobile v2 lane 8, #1439; README §2 rule 3, §4.2
 * `chat-arrival`, §4.6, §5 motion): a decision that arrives while the
 * operator reads something else shows in the shell's banner slot and
 * COLLAPSES into the bar's badge on its own after ~6 s. Under fake timers,
 * because the clock is the subject: the collapse fires once, at 6 s, and
 * neither a poll's re-render nor a fresh dismiss closure re-arms it.
 *
 * It also holds the one rule the shell cannot know: the conversation the
 * banner announces is the one on screen, so the feed already shows the
 * question and the banner says nothing.
 */

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
installActEnv();
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

const { ARRIVAL_COLLAPSE_MS, AttentionToast } = await import("./AttentionToast");
const { createMobileNav, MobileNavContext } = await import("@/components/mobile/mobileNav");
type FileEntry = import("@/lib/types").FileEntry;
type MobileNav = ReturnType<typeof createMobileNav>;

/** A same-document history the nav store can push into. */
function browserNav(): MobileNav {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=atlas" }];
  let index = 0;
  return createMobileNav({
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index > 0) index -= 1; },
    },
    href: () => entries[index]!.url,
    onPopstate: () => () => {},
  });
}

let root: Root | null = null;
let nav: MobileNav;
beforeEach(() => {
  jest.useFakeTimers();
  nav = browserNav();
  dom.document.body.replaceChildren();
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  dom.document.body.replaceChildren();
  /* happy-dom delivers hashchange on a window timer: drain anything pending
     with nothing mounted before the real clock comes back. */
  jest.advanceTimersByTime(50);
  jest.useRealTimers();
});

const NOW = Math.floor(Date.now() / 1000);

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: "worker.jsonl", path: "/transcripts/worker.jsonl", project: "alpha", title: "Migrate accounts to the new binding",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: NOW - 30, size: 10, activity: "live", proc: "running", pid: 4242, model: "opus",
    waitingInput: null,
    pendingQuestion: {
      kind: "plan", toolUseId: "tool-plan-1", transcriptPath: "/transcripts/worker.jsonl", pid: 4242, paneTarget: null, askedAt: new Date((NOW - 20) * 1000).toISOString(),
      questions: [{ header: "", question: "Approve the plan", multiSelect: false, options: [] }], plan: "1. read 2. write",
    },
    ...overrides,
  } as FileEntry;
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(<MobileNavContext.Provider value={nav}>{node}</MobileNavContext.Provider>);
  });
  return host as unknown as HTMLElement;
}

async function rerender(node: React.ReactNode): Promise<void> {
  await act(async () => { root!.render(<MobileNavContext.Provider value={nav}>{node}</MobileNavContext.Provider>); });
}

async function advance(ms: number): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

const banner = (host: HTMLElement) => host.querySelector("[data-mobile2-arrival]");

test("the banner shows over a non-board screen and collapses into the badge on its own after ~6 s, exactly once", async () => {
  nav.push({ kind: "chat", id: "/transcripts/other.jsonl" });
  let dismissed = 0;
  const host = await render(<AttentionToast file={file()} mobile onOpen={() => {}} onDismiss={() => { dismissed += 1; }} />);

  expect(banner(host)).not.toBeNull();
  expect(host.querySelector("[data-attention-toast-title]")!.textContent).toBe("Needs you · plan approval");
  expect(ARRIVAL_COLLAPSE_MS).toBe(6_000);

  await advance(ARRIVAL_COLLAPSE_MS - 1);
  expect(dismissed).toBe(0);
  await advance(1);
  expect(dismissed).toBe(1);
  /* Once: the host takes the arrival down on that call, and nothing here
     rings a second time however long the clock runs. */
  await advance(ARRIVAL_COLLAPSE_MS * 3);
  expect(dismissed).toBe(1);
});

test("a poll's re-render with a fresh dismiss closure does not re-arm the collapse", async () => {
  nav.push({ kind: "accounts" });
  const calls: string[] = [];
  const host = await render(<AttentionToast file={file()} mobile onOpen={() => {}} onDismiss={() => calls.push("first")} />);
  await advance(4_000);
  /* Two polls, two new closures, a title change on the same conversation. */
  await rerender(<AttentionToast file={file({ title: "Migrate accounts to the new binding (v2)" })} mobile onOpen={() => {}} onDismiss={() => calls.push("second")} />);
  await advance(1_000);
  await rerender(<AttentionToast file={file()} mobile onOpen={() => {}} onDismiss={() => calls.push("third")} />);
  expect(calls).toEqual([]);
  /* 6 s after the ARRIVAL, not after the last render — and the latest closure
     is the one that fires, so the host's current state is what gets updated. */
  await advance(1_000);
  expect(calls).toEqual(["third"]);
  expect(banner(host)).not.toBeNull();
});

test("the × dismisses before the clock does, and the timer that follows has nothing left to do", async () => {
  nav.push({ kind: "pipelines" });
  const calls: string[] = [];
  const host = await render(<AttentionToast file={file()} mobile onOpen={() => {}} onDismiss={() => calls.push("dismiss")} />);
  await act(async () => {
    host.querySelector("[data-attention-toast-dismiss]")!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
  });
  expect(calls).toEqual(["dismiss"]);
  /* The host would unmount the banner on that call; this one stays mounted to
     prove the clock still runs to its one collapse and no further. */
  await advance(ARRIVAL_COLLAPSE_MS);
  expect(calls).toEqual(["dismiss", "dismiss"]);
});

test("the conversation on screen is not announced to itself; leaving it brings the banner back until the clock collapses it", async () => {
  nav.push({ kind: "chat", id: "/transcripts/worker.jsonl" });
  let dismissed = 0;
  const host = await render(<AttentionToast file={file()} mobile onOpen={() => {}} onDismiss={() => { dismissed += 1; }} />);
  expect(banner(host)).toBeNull();

  /* A sibling switch to another conversation: the decision is now elsewhere. */
  await act(async () => { nav.replace({ kind: "chat", id: "/transcripts/other.jsonl" }); });
  expect(banner(host)).not.toBeNull();

  /* The clock ran the whole time; the badge takes over on schedule. */
  await advance(ARRIVAL_COLLAPSE_MS);
  expect(dismissed).toBe(1);
});

test("the body opens the conversation and the × is its own target, both 44 px", async () => {
  nav.push({ kind: "chat", id: "/transcripts/other.jsonl" });
  const events: string[] = [];
  const host = await render(<AttentionToast file={file()} mobile onOpen={() => events.push("open")} onDismiss={() => events.push("dismiss")} />);
  const open = host.querySelector("[data-attention-toast-open]")!;
  const dismiss = host.querySelector("[data-attention-toast-dismiss]")!;
  expect(open.getAttribute("aria-label")).toBe("Open Migrate accounts to the new binding");
  expect(open.className).toContain("min-h-11");
  expect(dismiss.className).toContain("h-11");
  expect(dismiss.getAttribute("aria-label")).toBe("Dismiss");
  await act(async () => { open.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never); });
  expect(events).toEqual(["open"]);
});
