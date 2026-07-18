import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardHistoryEntry } from "@/lib/board/history";

import { BoardHistoryControls } from "./BoardHistoryControls";

const dom = new Window();
useActEnv();
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
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
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

test("desktop: the island stays hidden until the log has something to act on", async () => {
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
  /* Resting chrome hygiene (finding 2): no disabled two-button box before the
     first close. */
  expect(buttons).toHaveLength(0);
});

test("desktop: undo enabled, the label names the card and discloses the shortcut", async () => {
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
  expect(buttons).toHaveLength(2);
  const [undo, redo] = buttons;
  expect(undo!.disabled).toBe(false);
  expect(redo!.disabled).toBe(true);
  /* Styled Hint (finding 4): the label rides aria-label, not a native title,
     and names the shortcut the feature ships. */
  expect(undo!.getAttribute("title")).toBeNull();
  expect(undo!.getAttribute("aria-label")).toBe("Undo — reopen “Alpha” (Ctrl+Z)");
  expect(redo!.getAttribute("aria-label")).toBe("Nothing to redo");
  act(() => {
    undo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  /* The disabled redo swallows its click. */
  act(() => {
    redo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(clicks).toEqual(["undo"]);
});

test("mobile: a single undo button, only while an undo is possible, at a 44px target", async () => {
  const clicks: string[] = [];
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo
      canRedo
      undoEntry={close("Alpha")}
      redoEntry={close("Beta")}
      onUndo={() => clicks.push("undo")}
      onRedo={() => clicks.push("redo")}
      isMobile
    />,
  );
  /* Finding 1: redo lives on Ctrl+Shift+Z / the «⋯» menu, so the toolbar spends
     one 44px slot, not two. */
  expect(buttons).toHaveLength(1);
  const [undo] = buttons;
  expect(undo!.className).toContain("h-11");
  expect(undo!.className).toContain("w-11");
  expect(undo!.getAttribute("aria-label")).toBe("Undo — reopen “Alpha” (Ctrl+Z)");
  act(() => {
    undo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(clicks).toEqual(["undo"]);
});

test("mobile: nothing renders when there is no undo", async () => {
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo={false}
      canRedo
      undoEntry={null}
      redoEntry={close("Beta")}
      onUndo={() => {}}
      onRedo={() => {}}
      isMobile
    />,
  );
  expect(buttons).toHaveLength(0);
});
