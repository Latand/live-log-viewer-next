import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
import { Sparkle } from "@/components/icons";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { TurnStatusBar } from "./TurnStatusBar";

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

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  setSystemTime();
});

const file = (lastTurn: FileEntry["lastTurn"], activity: FileEntry["activity"]) =>
  ({ lastTurn, activity }) as Pick<FileEntry, "lastTurn" | "activity">;

const render = (entry: Pick<FileEntry, "lastTurn" | "activity">, container: HTMLElement) => {
  root ??= createRoot(container);
  flushSync(() => root!.render(<TurnStatusBar file={entry} workingLabel="working…" workingIcon={Sparkle} />));
};

test("live open turn ticks the elapsed timer every second and freezes at terminal", () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let tick: (() => void) | null = null;
  let started = 0;
  const cleared: number[] = [];
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    started += 1;
    return started;
  };
  // @ts-expect-error test double
  globalThis.clearInterval = (id: number) => cleared.push(id);
  try {
    const t0 = Date.parse("2026-07-18T10:00:00.000Z");
    setSystemTime(new Date(t0));
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Prompt accepted at t0, agent working: the bottom slot carries the label
    // and a named timer element seeded at 0:00.
    render(file({ startedAt: t0, endedAt: null }, "live"), container);
    const timer = () => container.querySelector('[role="timer"]');
    expect(container.querySelector('[data-turn-status="running"]')).not.toBeNull();
    expect(timer()?.getAttribute("aria-label")).toBe("elapsed work time");
    expect(timer()?.textContent).toBe("0:00");
    expect(started).toBe(1);

    // 4 minutes 32 seconds into the turn (a long tool call in between — the
    // timer tracks the wall clock, not transcript writes).
    setSystemTime(new Date(t0 + (4 * 60 + 32) * 1000));
    flushSync(() => tick!());
    expect(timer()?.textContent).toBe("4:32");

    // The turn ends: the timer unmounts (its interval cleared) and the frozen
    // total spans initiating prompt → last activity, not the last action.
    render(file({ startedAt: t0, endedAt: t0 + 5 * 60 * 1000 }, "recent"), container);
    expect(timer()).toBeNull();
    expect(cleared).toContain(1);
    const finished = container.querySelector('[data-turn-status="finished"]');
    expect(finished?.textContent).toContain("Worked for 5m");
    expect(container.querySelector('[data-turn-status="running"]')).toBeNull();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test("a new prompt after a finished turn resets the timer to the new receipt", () => {
  const realSet = globalThis.setInterval;
  let tick: (() => void) | null = null;
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  try {
    const t0 = Date.parse("2026-07-18T10:00:00.000Z");
    setSystemTime(new Date(t0));
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(file({ startedAt: t0 - 60 * 60 * 1000, endedAt: t0 - 30 * 60 * 1000 }, "idle"), container);
    expect(container.querySelector('[data-turn-status="finished"]')).not.toBeNull();

    // Second prompt lands at t0+10s and the scanner reopens the boundary: the
    // timer restarts from the NEW receipt, not the previous turn's start.
    const t1 = t0 + 10_000;
    render(file({ startedAt: t1, endedAt: null }, "live"), container);
    setSystemTime(new Date(t1 + 3000));
    flushSync(() => tick!());
    expect(container.querySelector('[role="timer"]')?.textContent).toBe("0:03");
  } finally {
    globalThis.setInterval = realSet;
  }
});

test("live agent with no known boundary keeps the working label without a timer", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(file(null, "live"), container);
  expect(container.querySelector('[data-turn-status="running"]')?.textContent).toContain("working…");
  expect(container.querySelector('[role="timer"]')).toBeNull();
});

test("idle pane with no completed turn renders nothing", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(file(null, "idle"), container);
  expect(container.querySelector("[data-turn-status]")).toBeNull();
});
