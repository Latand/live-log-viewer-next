import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry, StructuredSpawnCardState } from "@/lib/types";

import { LaunchHistory } from "./LaunchHistory";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => {
  setLocale("en");
  document.body.replaceChildren();
});

function receipt(overrides: Partial<FileEntry>, spawn: Partial<StructuredSpawnCardState>): FileEntry {
  return {
    path: `spawn:${spawn.launchId ?? "aaaa"}`,
    root: "claude-projects",
    name: "spawn",
    project: "-agents-tools-live-log-viewer-next",
    title: "Claude",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: Date.now() / 1000 - 3_600,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    pendingQuestion: null,
    waitingInput: null,
    spawn: {
      launchId: "aaaa",
      clientAttemptId: null,
      accountId: "default",
      state: "failed",
      initialMessage: "failed",
      retrySafe: true,
      error: "structured spawn failed before host binding",
      ...spawn,
    },
    ...overrides,
  } as FileEntry;
}

const items = [
  receipt({ title: "Builder launch" }, { launchId: "4be75120", state: "failed", retrySafe: true, error: "structured spawn failed before host binding" }),
  receipt({ title: "Recovered launch" }, { launchId: "b44f4882", state: "recovered", initialMessage: "delivered", retrySafe: false, error: null }),
];

function render(ui: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(ui));
  return { host, root };
}

test("collapsed launch history shows one counted header and hides reasons and retry", () => {
  const { host, root } = render(<LaunchHistory items={items} onRetry={() => {}} />);
  const header = host.querySelector('[data-testid="launch-history"] button') as HTMLButtonElement;
  expect(header).toBeTruthy();
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(host.textContent).toContain(translate("en", "launchHistory.title"));
  expect(host.textContent).toContain("2");
  expect(host.textContent).not.toContain("structured spawn failed before host binding");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes(translate("en", "launchHistory.retryLabel")))).toBe(false);
  flushSync(() => root.unmount());
});

test("expanding the history reveals the exact failure reason and the retry affordance", () => {
  let retried: FileEntry | null = null;
  const { host, root } = render(<LaunchHistory items={items} onRetry={(file) => { retried = file; }} />);
  const header = host.querySelector('[data-testid="launch-history"] button') as HTMLButtonElement;
  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("structured spawn failed before host binding");
  expect(host.textContent).toContain(translate("en", "launchHistory.failed"));
  expect(host.textContent).toContain(translate("en", "launchHistory.recovered"));
  const retry = [...host.querySelectorAll("button")].filter((button) => button.textContent?.includes(translate("en", "launchHistory.retryLabel")));
  /* Only the retry-safe FAILED receipt offers retry; the recovered one never does. */
  expect(retry).toHaveLength(1);
  flushSync(() => retry[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(retried!.spawn!.launchId).toBe("4be75120");
  flushSync(() => root.unmount());
});

test("an empty history renders nothing", () => {
  const { host, root } = render(<LaunchHistory items={[]} onRetry={() => {}} />);
  expect(host.querySelector('[data-testid="launch-history"]')).toBe(null);
  flushSync(() => root.unmount());
});
