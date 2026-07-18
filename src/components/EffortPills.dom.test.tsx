import { afterEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { EffortPills } from "./EffortPills";

/*
 * Issue #270 — the reasoning meter is an IN-FLOW slot. The old scale()
 * transform grew the bars visually while the flex row kept laying out the tiny
 * unscaled box, so inside a zoomed-out scheme node they painted over the model
 * chip («Fable / низк…»). The contract now: every dimension rides one em
 * font-size (zoom-aware, capped like other in-world text), no transform, and a
 * container-query collapse below the narrow-row threshold instead of overlap.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  setLocale("en");
});

function mount(node: React.ReactElement): HTMLElement {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/pane.jsonl", root: "claude-projects", name: "pane.jsonl", project: "project",
    title: "Conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
    mtime: 1, size: 1, activity: "live", proc: null, pid: null,
    model: "fable", effort: "high", pendingQuestion: null, waitingInput: null,
    ...overrides,
  } as FileEntry;
}

test("the meter reserves in-flow layout space: em sizing off the zoom var, no transform, no overlay positioning", () => {
  const host = mount(<EffortPills file={file()} />);
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  expect(slot).toBeTruthy();
  /* A flex item that keeps its box: shrink-0, never absolute/fixed. */
  expect(slot.className).toContain("shrink-0");
  expect(slot.className).not.toContain("absolute");
  expect(slot.className).not.toContain("fixed");
  /* The visual box IS the layout box: sizing rides the font-size, which
     follows the board's inverse zoom under the shared 2.6× in-world cap. A
     transform would grow the paint without growing the slot — banned.
     (Asserted on static markup: happy-dom's CSSOM validator drops the nested
     min()/var() calc that browsers accept, so the live DOM shows no style.) */
  const markup = renderToStaticMarkup(<EffortPills file={file()} />);
  expect(markup).toContain("font-size:calc(10px * min(var(--inv-z, 1), 2.6))");
  expect(markup).not.toContain("transform");
  expect(slot.className).toContain("h-[1.2em]");
  /* Bars size in em so they scale inside the reserved slot. */
  const bars = [...slot.querySelectorAll(":scope > span")] as HTMLElement[];
  expect(bars.every((bar) => (bar.getAttribute("style") ?? "").includes("em"))).toBe(true);
});

test("a claude tier fills its own five-slot scale and keeps the localized tooltip", () => {
  const host = mount(<EffortPills file={file({ effort: "high" })} />);
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  const bars = [...slot.querySelectorAll(":scope > span")] as HTMLElement[];
  expect(bars).toHaveLength(5);
  const filled = bars.filter((bar) => !(bar.getAttribute("style") ?? "").includes("var(--color-border)"));
  expect(filled).toHaveLength(3);
  expect(slot.getAttribute("role")).toBe("img");
  expect(slot.getAttribute("aria-label")).toBe("Reasoning effort: high");
  expect(slot.getAttribute("title")).toBe("Reasoning effort: high");
});

test("the accessible label localizes to Ukrainian", () => {
  setLocale("uk");
  const host = mount(<EffortPills file={file({ effort: "low" })} />);
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  expect(slot.getAttribute("aria-label")).toBe("Зусилля міркування: low");
});

test("a narrow identity row collapses the slot via container query instead of overlapping", () => {
  const host = mount(<EffortPills file={file()} />);
  const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
  expect(slot.className).toContain("@max-[240px]:hidden");
});

test("no reliable effort renders nothing at all", () => {
  const host = mount(<EffortPills file={file({ effort: null })} />);
  expect(host.querySelector("[data-effort-slot]")).toBeNull();
});
