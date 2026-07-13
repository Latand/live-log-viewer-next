import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { WakeupEventInfo } from "../parse";
import { WakeupCard } from "./WakeupCard";

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

function wakeup(over: Partial<WakeupEventInfo> = {}): WakeupEventInfo {
  return { fireAt: 0, delaySeconds: 5, reason: "r", prompt: "p", superseded: false, failed: false, ...over };
}

test("stops the countdown interval once the wakeup fires", () => {
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
    const base = Date.parse("2026-07-07T10:00:00.000Z");
    setSystemTime(new Date(base));
    const fireAt = base + 5000;

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<WakeupCard wakeup={wakeup({ fireAt })} />));

    // While pending, the 1s interval is running.
    expect(started).toBe(1);
    expect(cleared).toHaveLength(0);

    // The clock passes the fire time; the next tick re-renders with now > fireAt.
    setSystemTime(new Date(fireAt + 1000));
    flushSync(() => tick && tick());

    // The card is now fired: the interval was cleared and none was re-armed.
    expect(cleared).toContain(1);
    expect(started).toBe(1);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});
