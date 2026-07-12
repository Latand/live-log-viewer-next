import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TargetChecklist } from "./TargetChecklist";
import { TaskSheet } from "./TaskSheet";

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
// The mobile sheet forces its controls to 44px regardless of viewport, so a
// mobile-matching matchMedia stub also exercises the useIsMobile-gated composer
// controls (deadline pill, attachment remove) at their phone size.
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver !== "function") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
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

function failedTask(): BoardTask {
  return {
    id: "t1", project: "orbit-api", status: "assigned", text: "Ship the limiter", placement: "unplaced",
    createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z",
    assignments: [{ path: "/a.jsonl", panePid: null, state: "failed", error: "delivery failed", at: "2026-07-12T00:00:00Z" }],
  };
}

test("task detail view: failed-assignment row and its Retry are 44px targets", () => {
  const files = [conv("/a.jsonl", "Alpha")];
  const { host, root } = mount(
    <TaskSheet project="orbit-api" tasks={[failedTask()]} files={files} initialView={{ taskId: "t1" }} onClose={() => {}} />,
  );
  const retry = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "retry delivery");
  expect(retry).toBeDefined();
  expect(meets44(retry!)).toBe(true);
  // The failed row itself carries the ⚠ edge and must stay a 44px block.
  const row = retry!.closest("div");
  expect(row).not.toBeNull();
  expect(meets44(row!)).toBe(true);
  flushSync(() => root.unmount());
});

test("task create view: the deadline pill is a 44px target", () => {
  const { host, root } = mount(
    <TaskSheet project="orbit-api" tasks={[]} files={[]} initialView="new" onClose={() => {}} />,
  );
  const dueInput = host.querySelector('input[type="datetime-local"]');
  expect(dueInput).not.toBeNull();
  const pill = dueInput!.closest("label");
  expect(pill).not.toBeNull();
  expect(meets44(pill!)).toBe(true);
  flushSync(() => root.unmount());
});
