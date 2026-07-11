import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";

import { PipelineHub } from "./PipelineHub";
import { pipelineStripDomId } from "./pipelineModel";

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

test("opening the dashboard strip keeps focus on the strip after the popover closes", async () => {
  /* The sibling strip the hub navigates to. */
  const strip = document.createElement("div");
  strip.id = pipelineStripDomId("p1");
  strip.tabIndex = -1;
  document.body.append(strip);

  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<PipelineHub pipeline={pipeline} x={0} y={0} interactive moveTransition="none" />); });

  /* Open the control popover, then click the "Open dashboard strip" button. */
  const trigger = host.querySelector("button") as HTMLButtonElement;
  flushSync(() => { trigger.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const openDash = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Open dashboard strip") as HTMLButtonElement;
  expect(openDash).toBeTruthy();
  flushSync(() => { openDash.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await Promise.resolve();
  flushSync(() => {});

  /* Focus landed on the strip and was not restored to the hub trigger; the
     popover is closed. */
  expect(document.activeElement).toBe(strip);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  flushSync(() => { root.unmount(); });
  host.remove();
  strip.remove();
});
