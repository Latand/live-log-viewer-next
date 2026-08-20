import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { BoardHistoryEntry } from "@/lib/board/history";

import { BoardHistoryControls } from "./BoardHistoryControls";

const dom = new Window();
installActEnv();
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

/*
 * The phone has no island (issue #1054 review). Its 390px header budget is five
 * 44px targets, and global search took the slot undo used to hold; both history
 * directions moved into the «⋯» menu, where redo already lived. The row's side
 * of that fold is asserted in mobile/mobileHeaderFit.dom.test.tsx — here the
 * component simply has no mobile face left to render.
 */
test("the island is desktop chrome: the redo half is always present beside undo", async () => {
  const clicks: string[] = [];
  const { buttons } = await mount(
    <BoardHistoryControls
      canUndo
      canRedo
      undoEntry={close("Alpha")}
      redoEntry={close("Beta")}
      onUndo={() => clicks.push("undo")}
      onRedo={() => clicks.push("redo")}
    />,
  );
  expect(buttons).toHaveLength(2);
  const [undo, redo] = buttons;
  /* Compact desktop sizing — the 44px coarse-pointer face is gone with the
     mobile branch, so nothing here can be mistaken for a phone target. */
  expect(undo!.className).toContain("h-7");
  expect(undo!.className).not.toContain("h-11");
  expect(redo!.getAttribute("aria-label")).toBe("Redo — close “Beta” again (Ctrl+Shift+Z)");
  act(() => {
    redo!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent);
  });
  expect(clicks).toEqual(["redo"]);
});
