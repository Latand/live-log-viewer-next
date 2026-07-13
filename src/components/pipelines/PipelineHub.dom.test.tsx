import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";

import { PipelineHub } from "./PipelineHub";

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
/* No control button in this test should reach the network; stub fetch so a
   mis-click can't hang on a real request. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;

const pipeline = {
  id: "p1", task: "t", state: "running",
  stages: [{ id: "build", kind: "run" }, { id: "review", kind: "review-loop" }],
  cursor: { stageId: "build", state: "running" }, runs: [],
} as unknown as Pipeline;

afterEach(() => document.body.replaceChildren());
process.on("exit", () => { globalThis.fetch = realFetch; });

test("the hub is the single control surface — no legacy 'open dashboard strip' escape hatch (#136)", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<PipelineHub pipeline={pipeline} x={0} y={0} interactive moveTransition="none" />); });

  /* Open the control popover. */
  const trigger = host.querySelector("button") as HTMLButtonElement;
  flushSync(() => { trigger.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });

  /* The persistent dashboard band is gone (#136), so the popover no longer
     offers a jump to it — the on-canvas hub owns the controls end to end. */
  const openDash = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Open dashboard strip");
  expect(openDash).toBeUndefined();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  /* Closing the popover restores focus to the hub trigger. */
  flushSync(() => { trigger.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await Promise.resolve();
  flushSync(() => {});
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  flushSync(() => { root.unmount(); });
  host.remove();
});
