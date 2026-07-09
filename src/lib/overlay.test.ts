import { expect, test } from "bun:test";

import { handleOverlayEscape, type OverlayKeyEvent } from "./overlay";

function escapeEvent(key = "Escape"): OverlayKeyEvent & { stopped: boolean } {
  const event = {
    key,
    stopped: false,
    stopPropagation() {
      this.stopped = true;
    },
  };
  return event;
}

test("Escape stops propagation, closes the overlay, and reports handled", () => {
  const event = escapeEvent();
  let closed = false;
  const handled = handleOverlayEscape(event, () => {
    closed = true;
  });
  expect(handled).toBe(true);
  expect(event.stopped).toBe(true);
  expect(closed).toBe(true);
});

test("a non-Escape key passes through untouched so typing still bubbles", () => {
  const event = escapeEvent("a");
  let closed = false;
  const handled = handleOverlayEscape(event, () => {
    closed = true;
  });
  expect(handled).toBe(false);
  expect(event.stopped).toBe(false);
  expect(closed).toBe(false);
});

// Behavioral routing: reproduce DOM bubble order for the mobile drawer + nested
// account sheet. Listeners run inner (dialog subtree) → outer (drawer's window
// handler); a stopped event never reaches the outer handler. This proves the
// exact finding-5 contract without a DOM harness.
function dispatchEscape(handlers: Array<(event: OverlayKeyEvent) => void>): void {
  const event = escapeEvent();
  for (const handler of handlers) {
    if (event.stopped) break;
    handler(event);
  }
}

test("first Escape closes only the account sheet and returns focus; second reaches the drawer", () => {
  const focus: string[] = [];
  const state = { sheetOpen: true, drawerOpen: true, activeFocus: "sheet" };

  // The nested sheet's dialog-subtree handler (present only while it is mounted).
  const sheetHandler = (event: OverlayKeyEvent) =>
    handleOverlayEscape(event, () => {
      state.sheetOpen = false;
      state.activeFocus = "accountTrigger";
      focus.push("accountTrigger");
    });
  // The project drawer's window-level Escape handler, always registered.
  const drawerHandler = (event: OverlayKeyEvent) => {
    if (event.key === "Escape") state.drawerOpen = false;
  };

  // First press: focus is inside the open sheet, so both handlers are in the
  // bubble chain, sheet first.
  dispatchEscape([sheetHandler, drawerHandler]);
  expect(state.sheetOpen).toBe(false);
  expect(state.drawerOpen).toBe(true);
  expect(state.activeFocus).toBe("accountTrigger");
  expect(focus).toEqual(["accountTrigger"]);

  // Second press: the sheet is unmounted, so only the drawer handler remains.
  dispatchEscape([drawerHandler]);
  expect(state.drawerOpen).toBe(false);
});
