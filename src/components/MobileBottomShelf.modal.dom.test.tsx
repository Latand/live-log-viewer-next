import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { MobileBottomShelf } from "./MobileBottomShelf";

/*
 * Issue #419 (reopened) — the chat-first hidden/handoff shelf is a real modal
 * dialog, matching MobilePipelineDockSheet (PR #431): aria-modal, focus moves
 * into it on open, Tab is trapped in both directions, Escape closes it, focus
 * returns to the opener on close, and the body scroll locks while it is up.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
};

let roots: Root[] = [];
beforeEach(() => {
  for (const key of Object.keys(OVERRIDES)) G[key] = OVERRIDES[key];
  dom.document.body.replaceChildren();
  roots = [];
});
afterEach(() => {
  for (const r of roots) flushSync(() => r.unmount());
  roots = [];
  dom.document.body.replaceChildren();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        open shelf
      </button>
      <MobileBottomShelf open={open} onClose={() => setOpen(false)} total={2} leading={<button type="button" data-testid="handoff">hand off</button>}>
        <button type="button" data-testid="strip">hidden strip</button>
      </MobileBottomShelf>
    </div>
  );
}

function mount(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

function openShelf(host: HTMLElement): HTMLElement {
  const opener = host.querySelector('[data-testid="opener"]') as unknown as HTMLElement;
  opener.focus();
  flushSync(() => opener.click());
  return host.querySelector('[data-testid="mobile-bottom-shelf"]') as unknown as HTMLElement;
}

const pressKey = (init: { key: string; shiftKey?: boolean }) => {
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as never);
  });
};

test("the shelf is a modal dialog that takes focus on open and locks body scroll", () => {
  const host = mount();
  const sheet = openShelf(host);
  expect(sheet).not.toBeNull();
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  /* Focus moved off the opener and into the dialog subtree. */
  const active = dom.document.activeElement as unknown as Node | null;
  expect(active !== null && (sheet.contains(active as never) || active === (sheet as unknown as Node))).toBe(true);
  /* Body scroll is locked while the modal is up. */
  expect(dom.document.body.style.overflow).toBe("hidden");
});

test("Escape closes the shelf, restores body scroll, and returns focus to the opener", () => {
  const host = mount();
  openShelf(host);
  pressKey({ key: "Escape" });
  expect(host.querySelector('[data-testid="mobile-bottom-shelf"]')).toBeNull();
  expect(dom.document.body.style.overflow).toBe("");
  expect(dom.document.activeElement).toBe(host.querySelector('[data-testid="opener"]') as never);
});

test("the close button also restores focus to the opener", () => {
  const host = mount();
  const sheet = openShelf(host);
  const close = sheet.querySelector('button[aria-label="Close"]') as unknown as HTMLElement;
  flushSync(() => close.click());
  expect(host.querySelector('[data-testid="mobile-bottom-shelf"]')).toBeNull();
  expect(dom.document.activeElement).toBe(host.querySelector('[data-testid="opener"]') as never);
});

test("Tab is trapped inside the shelf in both directions", () => {
  const host = mount();
  const sheet = openShelf(host);
  const focusables = [...sheet.querySelectorAll("button")] as unknown as HTMLElement[];
  expect(focusables.length).toBeGreaterThan(0);
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;

  /* Tab from the last focusable wraps to the first — never out of the sheet. */
  last.focus();
  pressKey({ key: "Tab" });
  expect(dom.document.activeElement).toBe(first as never);

  /* Shift+Tab from the first wraps to the last. */
  first.focus();
  pressKey({ key: "Tab", shiftKey: true });
  expect(dom.document.activeElement).toBe(last as never);
});
