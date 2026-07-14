import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardHistoryEntry } from "@/lib/board/history";

import { BoardHistoryControls } from "./BoardHistoryControls";

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
});

const close = (title: string): BoardHistoryEntry => ({ kind: "close", path: `${title}.jsonl`, title });

async function mount(node: React.ReactElement): Promise<{ buttons: HTMLButtonElement[]; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  /* Async act flushes the useSyncExternalStore hydration re-render (locale) that
     a bare sync render would leave uncommitted and warn about. */
  await act(async () => root!.render(node));
  const buttons = [...container.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  return { buttons, container };
}

test("both arrows are disabled with an empty history", async () => {
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo={false}
      canRedo={false}
      undoEntry={null}
      redoEntry={null}
      onUndo={() => {}}
      onRedo={() => {}}
      isMobile={false}
    />,
  );
  expect(buttons).toHaveLength(2);
  const [undo, redo] = buttons;
  expect(undo!.disabled).toBe(true);
  expect(redo!.disabled).toBe(true);
  /* Edge tooltips explain why the control is inert. */
  expect(undo!.getAttribute("title")).toBe("Nothing to undo");
  expect(redo!.getAttribute("title")).toBe("Nothing to redo");
});

test("undo enabled, tooltip names the card the next undo restores", async () => {
  const clicks: string[] = [];
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo
      canRedo={false}
      undoEntry={close("Alpha")}
      redoEntry={null}
      onUndo={() => clicks.push("undo")}
      onRedo={() => clicks.push("redo")}
      isMobile={false}
    />,
  );
  const [undo, redo] = buttons;
  expect(undo!.disabled).toBe(false);
  expect(redo!.disabled).toBe(true);
  expect(undo!.getAttribute("title")).toBe("Undo — reopen “Alpha”");
  act(() => {
    undo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  /* The disabled redo swallows its click. */
  act(() => {
    redo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(clicks).toEqual(["undo"]);
});

test("mobile sizing meets the 44px touch target", async () => {
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo
      canRedo
      undoEntry={close("Alpha")}
      redoEntry={close("Beta")}
      onUndo={() => {}}
      onRedo={() => {}}
      isMobile
    />,
  );
  for (const btn of buttons) {
    expect(btn.className).toContain("h-11");
    expect(btn.className).toContain("w-11");
  }
});
