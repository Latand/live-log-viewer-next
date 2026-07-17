import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";

import type { TaskStatusStack } from "./scheme/taskStacks";
import { TaskStacksStrip } from "./TaskStacksStrip";

const dom = new Window();
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
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

afterEach(() => {
  setLocale("en");
  mobile = false;
  document.body.replaceChildren();
});

function task(id: string, status: BoardTask["status"], text: string): BoardTask {
  return {
    id,
    project: "demo",
    status,
    text,
    placement: "pinned",
    pos: { x: 740, y: 120 },
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as BoardTask;
}

const stacks: TaskStatusStack[] = [
  { status: "inbox", items: [task("i1", "inbox", "Triage the flaky gate\ndetails"), task("i2", "inbox", "Write the runbook")] },
  { status: "done", items: [task("d1", "done", "Ship the hotfix")] },
];

function render(ui: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(ui));
  return { host, root };
}

test("the strip is one counted header until expanded, then Kanban rows with accessible labels", () => {
  const { host, root } = render(<TaskStacksStrip stacks={stacks} onOpen={() => {}} />);
  const header = host.querySelector('[data-testid="task-stacks"] button') as HTMLButtonElement;
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(host.textContent).toContain(translate("en", "taskStacks.title"));
  expect(host.textContent).toContain("3");
  expect(host.textContent).not.toContain("Triage the flaky gate");

  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const rows = [...host.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label")?.includes("tasks"));
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "inbox tasks · 2",
    "done tasks · 1",
  ]);
  flushSync(() => root.unmount());
});

test("expanding a status row lists chips; a chip requests board expansion", () => {
  let opened: BoardTask | null = null;
  const { host, root } = render(<TaskStacksStrip stacks={stacks} onOpen={(item) => { opened = item; }} />);
  const header = host.querySelector('[data-testid="task-stacks"] button') as HTMLButtonElement;
  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const inboxRow = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "inbox tasks · 2")!;
  flushSync(() => inboxRow.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const chip = [...host.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Triage the flaky gate"))!;
  expect(chip).toBeTruthy();
  flushSync(() => chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(opened!.id).toBe("i1");
  flushSync(() => root.unmount());
});

test("phone rows keep 44px-class tap targets", () => {
  mobile = true;
  const { host, root } = render(<TaskStacksStrip stacks={stacks} onOpen={() => {}} />);
  const header = host.querySelector('[data-testid="task-stacks"] button') as HTMLButtonElement;
  expect(header.className).toContain("min-h-11");
  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const inboxRow = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "inbox tasks · 2")!;
  expect(inboxRow.className).toContain("min-h-11");
  flushSync(() => root.unmount());
});

test("no stacked tasks renders nothing", () => {
  const { host, root } = render(<TaskStacksStrip stacks={[]} onOpen={() => {}} />);
  expect(host.querySelector('[data-testid="task-stacks"]')).toBe(null);
  flushSync(() => root.unmount());
});

test("explicit expansion pins persist across a reload (durable per project)", async () => {
  const { loadExpandedTasks, persistExpandedTasks } = await import("./scheme/taskStacks");
  persistExpandedTasks("demo", new Set(["t1", "t2"]));
  persistExpandedTasks("other", new Set(["z9"]));
  /* A fresh load — the moral equivalent of a page refresh — reads the same
     durable pin set back, per project. */
  expect([...loadExpandedTasks("demo")].sort()).toEqual(["t1", "t2"]);
  expect([...loadExpandedTasks("other")]).toEqual(["z9"]);
  window.localStorage.setItem("llvTaskExpand:demo", "not json");
  expect(loadExpandedTasks("demo").size).toBe(0);
  window.localStorage.removeItem("llvTaskExpand:demo");
  window.localStorage.removeItem("llvTaskExpand:other");
});
