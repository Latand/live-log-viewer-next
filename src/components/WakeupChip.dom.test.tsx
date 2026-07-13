import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { PendingWakeup } from "@/lib/types";

import { WakeupChip } from "./WakeupChip";

const dom = new Window();
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  setSystemTime();
});

test("a wakeup scheduled after a long null period renders against the current clock", async () => {
  const t0 = Date.parse("2026-07-07T06:00:00.000Z");
  setSystemTime(new Date(t0));

  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Mount long-lived with no wakeup — this seeds `now` at 06:00 and runs the
  // fire-time effect for the initial (null) fire time.
  await act(async () => root!.render(<WakeupChip wakeup={null} />));

  // Hours pass, then a 12-minute wakeup is scheduled at 08:00.
  const later = t0 + 2 * 60 * 60 * 1000;
  setSystemTime(new Date(later));
  const wakeup: PendingWakeup = { fireAt: later + 12 * 60 * 1000, reason: "r" };
  await act(async () => root!.render(<WakeupChip wakeup={wakeup} />));

  const text = container.textContent ?? "";
  // The fire-time-change refresh rebased `now`, so it reads ~12 min, not ~2 h.
  expect(text).toContain("12 min");
  expect(text).not.toContain("2 h");
});

test("on the map, tapping the chip reveals the reason and never bubbles to the camera", async () => {
  setSystemTime(new Date(Date.parse("2026-07-07T08:00:00.000Z")));

  // A parent surrogate for the scheme board's pointer/tap listener.
  const board = document.createElement("div");
  let boardTaps = 0;
  board.addEventListener("click", () => (boardTaps += 1));
  document.body.appendChild(board);
  const container = document.createElement("div");
  board.appendChild(container);
  root = createRoot(container);

  const wakeup: PendingWakeup = { fireAt: Date.now() + 12 * 60 * 1000, reason: "watching the deploy queue" };
  // The map passes pointer-events-auto so the chip is tappable inside the
  // pointer-events-none lite layer.
  await act(async () => root!.render(<WakeupChip wakeup={wakeup} className="pointer-events-auto" />));

  const btn = container.querySelector("[data-wakeup]") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.getAttribute("aria-expanded")).toBe("false");

  await act(async () => {
    btn.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  });

  // The reason disclosure opened; the tap did not reach the camera listener.
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent ?? "").toContain("watching the deploy queue");
  expect(boardTaps).toBe(0);
});
