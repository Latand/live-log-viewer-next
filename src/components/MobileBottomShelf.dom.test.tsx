import { afterEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";

import { MobileBottomShelf } from "./MobileBottomShelf";

/*
 * Issue #419 (reopened) — chat-first mobile shell. The handoff/hidden/readiness
 * shelf must reserve ZERO bottom rows: closed it renders nothing at all, and a
 * compact trigger opens it as an overlay sheet that folds the handoff plus the
 * hidden strips. This proves the closed/zero and trigger-opens-content contract
 * in isolation; ProjectDashboard wires the real header trigger to the same API.
 */

const dom = new HappyWindow();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

/* A minimal harness mirroring the ProjectDashboard wiring: a header trigger that
   holds the open state and the shelf overlay it controls. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      <MobileBottomShelf open={open} onClose={() => setOpen(false)} total={3} leading={<div data-testid="handoff">hand off</div>}>
        <div data-testid="strips">hidden strips</div>
      </MobileBottomShelf>
    </div>
  );
}

function mount(node: React.ReactElement) {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

test("closed, the shelf renders nothing — zero reserved height in the focused chat", () => {
  const host = mount(<Harness />);
  expect(host.querySelector('[data-testid="mobile-bottom-shelf"]')).toBeNull();
  expect(host.querySelector('[data-testid="handoff"]')).toBeNull();
  expect(host.querySelector('[data-testid="strips"]')).toBeNull();
});

test("the trigger opens the overlay sheet with the handoff and the hidden strips, and closes again", () => {
  const host = mount(<Harness />);

  flushSync(() => (host.querySelector('[data-testid="trigger"]') as HTMLButtonElement).click());
  const sheet = host.querySelector('[data-testid="mobile-bottom-shelf"]') as HTMLElement;
  expect(sheet).toBeTruthy();
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(host.querySelector('[data-testid="handoff"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="strips"]')).toBeTruthy();

  /* The 44px close control dismisses it back to zero. */
  const close = sheet.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
  expect(close.className).toContain("h-11");
  flushSync(() => close.click());
  expect(host.querySelector('[data-testid="mobile-bottom-shelf"]')).toBeNull();
});

test("with a handoff but no hidden items, the sheet still folds the handoff (total 0 hides only the strips)", () => {
  function HandoffOnly() {
    const [open, setOpen] = useState(true);
    return (
      <MobileBottomShelf open={open} onClose={() => setOpen(false)} total={0} leading={<div data-testid="handoff">hand off</div>}>
        <div data-testid="strips">hidden strips</div>
      </MobileBottomShelf>
    );
  }
  const host = mount(<HandoffOnly />);
  expect(host.querySelector('[data-testid="handoff"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="strips"]')).toBeNull();
});
