import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { TaskCard, type TaskCardHandlers } from "./TaskCard";
import { TASK_BODY_MAX, TASK_DISCLOSURE_H, taskCardExpandable, type PlacedTask } from "./taskGeometry";

/*
 * Issue #292 production rejection: a compact task card must never scroll its
 * body internally — it clamps to a fixed preview with a fade and an in-card
 * Expand control; the expanded card shows the full body with no nested scroll,
 * lifted into the elevated overlay band the editing state already uses.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); });

const handlers: TaskCardHandlers = {
  patch: async () => null,
  remove: () => {},
  handoff: async () => {},
  draft: () => {},
  unassign: () => {},
  center: () => {},
} as unknown as TaskCardHandlers;

const longText = "Long task\n" + Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the overflowing body`).join("\n");

function task(text: string): PlacedTask {
  return {
    id: "t1", project: "demo", status: "assigned", text, placement: "board",
    pos: { x: 10, y: 10 }, assignments: [], createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-18T00:00:00Z",
  } as unknown as PlacedTask;
}

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

const camRef = { current: { x: 0, y: 0, z: 1 } };

test("a compact overflowing card clamps with a fade and Expand — no internal scrollbar (#292)", async () => {
  expect(taskCardExpandable({ text: longText })).toBe(true);
  roots.push(mount(<TaskCard task={task(longText)} files={[]} camRef={camRef} handlers={handlers} />));
  await settle();

  const body = dom.document.querySelector("[data-task-body]")!;
  expect(body.className).not.toContain("overflow-y-auto");
  expect(body.className).toContain("overflow-hidden");
  /* Preview cap reserves the disclosure row inside the geometry estimate. */
  expect((body as unknown as HTMLElement).style.maxHeight).toBe(`${TASK_BODY_MAX - TASK_DISCLOSURE_H}px`);
  expect(dom.document.querySelector("[data-task-fade]")).not.toBeNull();

  const disclosure = dom.document.querySelector("[data-task-disclosure]") as unknown as HTMLButtonElement;
  expect(disclosure).not.toBeNull();
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");

  /* Expand: full body (no cap, no fade), still no internal scroll, and the card
     lifts into the elevated overlay band (z-30, like editing). */
  flushSync(() => disclosure.click());
  await settle();
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect((body as unknown as HTMLElement).style.maxHeight).toBe("");
  expect(dom.document.querySelector("[data-task-fade]")).toBeNull();
  expect(dom.document.querySelector('[data-scheme-task="t1"]')!.className).toContain("z-30");

  /* Collapse restores the exact compact presentation. */
  flushSync(() => disclosure.click());
  await settle();
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect((body as unknown as HTMLElement).style.maxHeight).toBe(`${TASK_BODY_MAX - TASK_DISCLOSURE_H}px`);
  expect(dom.document.querySelector('[data-scheme-task="t1"]')!.className).not.toContain("z-30");
});

test("exactly 20 hard lines expose Expand; 19 keep the plain body (padding boundary, Finding)", async () => {
  /* The compact clamp is a border-box max-height: the body's 16px vertical
     padding (py-2) is spent inside TASK_BODY_MAX, so the plain preview holds
     only 19 full 17px lines (339px padded). A 20th hard line (356px padded)
     crosses the clamp and must render the fade + Expand disclosure — never a
     silently clipped last line (issue #292 contract). */
  const nineteen = Array.from({ length: 19 }, (_, i) => `l${i}`).join("\n");
  const twenty = `${nineteen}\nl19`;

  roots.push(mount(<TaskCard task={task(twenty)} files={[]} camRef={camRef} handlers={handlers} />));
  await settle();
  const body = dom.document.querySelector("[data-task-body]")!;
  expect((body as unknown as HTMLElement).style.maxHeight).toBe(`${TASK_BODY_MAX - TASK_DISCLOSURE_H}px`);
  expect(dom.document.querySelector("[data-task-fade]")).not.toBeNull();
  expect(dom.document.querySelector("[data-task-disclosure]")).not.toBeNull();
  expect(body.className).toContain("overflow-hidden");
  expect(body.className).not.toContain("overflow-y-auto");
  dom.document.body.replaceChildren();

  roots.push(mount(<TaskCard task={task(nineteen)} files={[]} camRef={camRef} handlers={handlers} />));
  await settle();
  const plain = dom.document.querySelector("[data-task-body]")!;
  expect((plain as unknown as HTMLElement).style.maxHeight).toBe(`${TASK_BODY_MAX}px`);
  expect(dom.document.querySelector("[data-task-fade]")).toBeNull();
  expect(dom.document.querySelector("[data-task-disclosure]")).toBeNull();
});

test("a short card keeps the plain body: no disclosure, no fade, full cap", async () => {
  expect(taskCardExpandable({ text: "short task" })).toBe(false);
  roots.push(mount(<TaskCard task={task("short task")} files={[]} camRef={camRef} handlers={handlers} />));
  await settle();

  expect(dom.document.querySelector("[data-task-disclosure]")).toBeNull();
  expect(dom.document.querySelector("[data-task-fade]")).toBeNull();
  const body = dom.document.querySelector("[data-task-body]")!;
  expect((body as unknown as HTMLElement).style.maxHeight).toBe(`${TASK_BODY_MAX}px`);
});
