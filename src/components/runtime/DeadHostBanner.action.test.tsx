import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/* Finding 5: dead-host Re-check must route through the runtime-bus refresh (so a
   recovered host actually clears the banner) and surface failures rather than
   discarding the snapshot. `refreshRuntime` is mocked to exercise both paths. */

let refreshResult = true;
let refreshCalls = 0;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  refreshRuntime: () => { refreshCalls += 1; return Promise.resolve(refreshResult); },
}));

const { DeadHostBanner } = await import("./DeadHostBanner");

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const file: FileEntry = {
  path: "/c.jsonl", root: "codex-sessions", name: "c.jsonl", project: "viewer", title: "c",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1,
  activity: "idle", proc: null, pid: null, model: "gpt", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

afterEach(() => { refreshResult = true; refreshCalls = 0; document.body.replaceChildren(); });

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<DeadHostBanner file={file} />));
  return { host, root };
}

const recheckBtn = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(translate("en", "deadHost.recheck")))!;

test("Re-check calls the runtime-bus refresh (not a discarded snapshot fetch)", async () => {
  const { host, root } = mount();
  flushSync(() => recheckBtn(host).dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  await new Promise((r) => setTimeout(r, 0));
  expect(refreshCalls).toBe(1);
  flushSync(() => root.unmount());
});

test("a failed refresh shows the error alert", async () => {
  refreshResult = false;
  const { host, root } = mount();
  flushSync(() => recheckBtn(host).dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  await new Promise((r) => setTimeout(r, 0));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(translate("en", "deadHost.recheckFailed"));
  flushSync(() => root.unmount());
});
