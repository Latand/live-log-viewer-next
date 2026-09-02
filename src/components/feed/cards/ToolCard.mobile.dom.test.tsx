import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { diffFromApplyPatch } from "../diff";
import { execFailure, toolEvent } from "../__fixtures__/readableTools";
import type { ToolEvent } from "../parse";
import { ToolCard } from "./ToolCard";

/*
 * Mobile v2 (#1439, lane 4; README §2.6): on the phone a tool call is one
 * quiet line. The parser opens an edit's diff (#90) and a failure's output by
 * default; that default is the desktop's. On the phone the line renders closed
 * with no body until the operator taps it, and the tap opens it in place. The
 * desktop keeps the parser's `open`.
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === "(max-width:767px)" ? narrowViewport : false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

const dom = new Window({ url: "http://localhost/" });
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

/* The operator's tap on the summary: the browser flips `open` and fires
   `toggle`, which is what React's onToggle sees. */
function toggle(details: Element, open: boolean): void {
  (details as unknown as { open: boolean }).open = open;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

const isOpen = (details: Element) => (details as unknown as { open: boolean }).open;
const body = (host: Element) => host.querySelector("details > div");

/** A running edit whose diff the parser opened by default (#90). */
function runningEdit(): ToolEvent {
  const patch = ["*** Begin Patch", "*** Update File: src/components/cardStatus.ts", "@@", "-const stale = true;", "+const stale = false;", "*** End Patch"].join("\n");
  const model = diffFromApplyPatch(patch);
  return toolEvent({
    id: "edit-run",
    family: "edit",
    tool: "Edit",
    icon: "edit",
    summary: "src/components/cardStatus.ts",
    status: "run",
    statusLabel: "running",
    open: true,
    body: { type: "diff", files: model.files, filesTruncated: model.filesTruncated },
  });
}

test("phone: a running edit renders closed with no body until tapped, then opens in place", () => {
  narrowViewport = true;
  const host = mount(<ToolCard event={runningEdit()} />);
  const details = host.querySelector("details")!;
  expect(details.getAttribute("class")).not.toContain("ml-9");
  expect(isOpen(details)).toBe(false);
  expect(body(host)).toBeNull();
  expect(host.textContent).not.toContain("cardStatus.ts;");
  expect(host.textContent).not.toContain("stale");
  const line = host.querySelector("[data-mobile-tool-line]")!;
  expect(line.getAttribute("data-mobile-tool-line")).toBe("running");
  /* The tap opens it: the diff mounts under the line. */
  toggle(details, true);
  expect(isOpen(details)).toBe(true);
  expect(body(host)).toBeTruthy();
  expect(host.textContent).toContain("stale");
  /* And closes it again, taking the body with it. */
  toggle(details, false);
  expect(isOpen(details)).toBe(false);
  expect(body(host)).toBeNull();
});

test("phone: a lone failed exec renders closed with no body until tapped", () => {
  narrowViewport = true;
  const host = mount(<ToolCard event={execFailure} />);
  const details = host.querySelector("details")!;
  expect(isOpen(details)).toBe(false);
  expect(body(host)).toBeNull();
  expect(host.textContent).not.toContain("expected true to be false");
  /* The line is still never quiet about the failure itself. */
  const line = host.querySelector("[data-mobile-tool-line]")!;
  expect(line.getAttribute("data-mobile-tool-line")).toBe("failed");
  expect(line.getAttribute("class")).toContain("text-danger");
  expect(line.textContent).toContain("exit 3");
  toggle(details, true);
  expect(body(host)).toBeTruthy();
  expect(host.textContent).toContain("expected true to be false");
});

test("desktop: the parser's open stays — the edit's diff and the failure's output are mounted from the start", () => {
  narrowViewport = false;
  const host = mount(
    <>
      <ToolCard event={runningEdit()} />
      <ToolCard event={execFailure} />
    </>,
  );
  const all = host.querySelectorAll("details");
  expect(all).toHaveLength(2);
  for (const details of all) {
    expect(isOpen(details)).toBe(true);
    expect(details.getAttribute("class")).toContain("ml-9");
    expect(details.querySelector("details > div")).toBeTruthy();
  }
  expect(host.textContent).toContain("stale");
  expect(host.textContent).toContain("expected true to be false");
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
});
