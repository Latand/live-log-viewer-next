import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { activeGroup, activeFailureGroup, settledGroup, nestedGroup } from "../__fixtures__/readableTools";
import { CmdGroupCard } from "./CmdGroupCard";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

beforeEach(() => {
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(async () => {}) },
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  host = null;
  document.body.replaceChildren();
});

function mount(node: ReactElement): HTMLDivElement {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  flushSync(() => root!.render(node));
  host = el as unknown as HTMLDivElement;
  return host;
}

// Re-render into the *same* root, so the component instance (and its lifecycle
// state) persists across the tick — the way an incremental re-feed updates it.
function rerender(node: ReactElement): HTMLDivElement {
  flushSync(() => root!.render(node));
  return host!;
}

function toggle(details: Element, open: boolean): void {
  (details as unknown as { open: boolean }).open = open;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

test("a live aggregate renders open with every command and output shown immediately", () => {
  const h = mount(<CmdGroupCard item={activeGroup()} />);
  const details = h.querySelector("details")!;
  // The aggregate is open without any interaction.
  expect((details as unknown as { open: boolean }).open).toBe(true);
  // Both commands and both outputs are visible right away.
  expect(h.textContent).toContain("git status --short");
  expect(h.textContent).toContain("cargo build --release");
  expect(h.textContent).toContain(" M src/index.ts");
  expect(h.textContent).toContain("Finished release target");
});

test("no nested second disclosure: the only <details> is the aggregate itself", () => {
  const h = mount(<CmdGroupCard item={activeGroup()} />);
  // The per-call rows are inline blocks, not their own collapsible <details>.
  expect(h.querySelectorAll("details").length).toBe(1);
});

test("live → settled auto-collapses the aggregate exactly once", () => {
  const h = mount(<CmdGroupCard item={activeGroup()} />);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
  // The run settles: the same group re-fed with active:false.
  rerender(<CmdGroupCard item={settledGroup()} />);
  const details = h.querySelector("details")!;
  expect((details as unknown as { open: boolean }).open).toBe(false);
  // Collapsed to the compact summary — the bodies are gone.
  expect(h.textContent).not.toContain("git status --short");
  // A further settled tick does not fight the collapse (stays closed).
  rerender(<CmdGroupCard item={settledGroup()} />);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(false);
});

test("a manual reopen after settle persists across ticks until the operator closes it", () => {
  const h = mount(<CmdGroupCard item={activeGroup()} />);
  rerender(<CmdGroupCard item={settledGroup()} />); // settle + auto-collapse
  const details = h.querySelector("details")!;
  expect((details as unknown as { open: boolean }).open).toBe(false);
  // Operator reopens it.
  toggle(details, true);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
  expect(h.textContent).toContain("git status --short");
  // A later settled re-feed keeps it open — the auto-collapse fires only once.
  rerender(<CmdGroupCard item={settledGroup()} />);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
  // Operator closes it; the choice sticks across the next tick.
  toggle(h.querySelector("details")!, false);
  rerender(<CmdGroupCard item={settledGroup()} />);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(false);
});

test("a later live→settled cycle preserves the operator's reopen — the auto-collapse fires only once", () => {
  // active → settled (auto-collapse) → operator reopens → active again → settled again.
  const h = mount(<CmdGroupCard item={activeGroup()} />);
  rerender(<CmdGroupCard item={settledGroup()} />); // first settle: auto-collapse
  const details = h.querySelector("details")!;
  expect((details as unknown as { open: boolean }).open).toBe(false);
  // Operator reopens the settled group.
  toggle(details, true);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
  // A new activity cycle: the same group goes live again, then settles again.
  rerender(<CmdGroupCard item={activeGroup()} />);
  rerender(<CmdGroupCard item={settledGroup()} />);
  // The second settle must NOT re-collapse — the operator's reopen wins.
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
  expect(h.textContent).toContain("git status --short");
});

test("a never-active error group keeps its default-open behavior", () => {
  // A historical (never live) group that carries a failure opens by default so the
  // failure is never hidden — the one-time auto-collapse only applies to a group
  // that was actually live and then settled.
  const h = mount(<CmdGroupCard item={activeFailureGroup({ active: false })} />);
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(true);
});

test("the compact summary keeps the failure status and count after collapse", () => {
  const h = mount(<CmdGroupCard item={activeFailureGroup()} />);
  rerender(<CmdGroupCard item={activeFailureGroup({ active: false })} />);
  const summary = h.querySelector("summary")!;
  // Collapsed, but the failure count is still on the compact summary line.
  expect((h.querySelector("details") as unknown as { open: boolean }).open).toBe(false);
  expect(summary.textContent).toContain("1");
  expect(summary.querySelector(".text-danger")).toBeTruthy();
});

test("nested wait/stdin follow-ups stay owned by their exec inside the live aggregate", () => {
  const h = mount(<CmdGroupCard item={nestedGroup({ active: true })} />);
  const list = h.querySelector("ol")!;
  // Two top-level blocks; the follow-ups render inside the first, inline.
  expect(list.querySelectorAll(":scope > li").length).toBe(2);
  const firstBlock = list.querySelector("li")!;
  expect(firstBlock.textContent).toContain("wait");
  expect(firstBlock.textContent).toContain("stdin");
  // Still no nested disclosure: the aggregate details is the only one.
  expect(h.querySelectorAll("details").length).toBe(1);
});

test("keyboard: the aggregate toggle is a native <summary>", () => {
  const h = mount(<CmdGroupCard item={settledGroup()} />);
  expect(h.querySelector("summary")?.tagName).toBe("SUMMARY");
});

test("reduced motion and responsive wrapping hold for the live aggregate", () => {
  const markup = renderToStaticMarkup(<CmdGroupCard item={activeGroup()} />);
  // Animated chrome opts out under prefers-reduced-motion.
  expect(markup).toContain("motion-reduce:transition-none");
  // The command wraps at 390px instead of forcing a horizontal scroll region.
  expect(markup).toContain("whitespace-pre-wrap");
  expect(markup).toContain("[overflow-wrap:anywhere]");
  expect(markup).not.toContain("overflow-x-auto");
});
