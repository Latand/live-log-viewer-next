import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { TargetChecklist } from "./TargetChecklist";
import { TaskSheet } from "./TaskSheet";

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
// useIsMobile leans on matchMedia; the phone task sheet sizes its controls
// unconditionally, so a desktop-defaulting stub is enough for these assertions.
if (typeof dom.matchMedia !== "function") {
  // @ts-expect-error test stub
  dom.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

function conv(path: string, title: string): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "orbit-api", title,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 2, size: 1, activity: "idle",
    proc: "done", pid: null, pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

function mount(node: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

/** A control clears the 44px minimum when it declares a full-height class. */
function meets44(el: Element): boolean {
  const c = el.className;
  return /\b(h-11|min-h-11|h-12)\b/.test(c);
}

test("task sheet list view: header close and create action are 44px targets", () => {
  const { host, root } = mount(
    <TaskSheet project="orbit-api" tasks={[]} files={[]} initialView="list" onClose={() => {}} />,
  );
  const close = host.querySelector('button[aria-label="Close"]');
  expect(close).not.toBeNull();
  expect(meets44(close!)).toBe(true);
  const create = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("new task"));
  expect(create).toBeDefined();
  expect(meets44(create!)).toBe(true);
  flushSync(() => root.unmount());
});

test("target checklist rows and the all-children control are 44px targets", () => {
  const files = [conv("/a.jsonl", "Alpha"), conv("/b.jsonl", "Beta")];
  const { host, root } = mount(
    <TargetChecklist files={files} project="orbit-api" checked={new Set()} onChange={() => {}} />,
  );
  const rows = [...host.querySelectorAll("label")];
  expect(rows.length).toBe(2);
  for (const row of rows) expect(meets44(row)).toBe(true);
  // Checkboxes are the real hit target inside each 44px label row.
  expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(2);
  flushSync(() => root.unmount());
});
