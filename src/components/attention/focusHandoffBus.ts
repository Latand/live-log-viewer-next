"use client";

import type { FocusFrameIndex } from "@/lib/attention/resolve";
import type { FocusRect, ZoomIntent } from "@/lib/attention/types";

/**
 * The seam an accepted attention request crosses to reach the board (#688).
 *
 * Two surfaces already own the halves of a focus handoff and neither can see
 * the other: the scheme board knows where everything is and how to move the
 * camera, while the shell knows which project is open and how to open a
 * conversation. The overlay that answers the request sits beside both. Rather
 * than thread either through the tree, each registers here — the same idiom
 * `viewPresenceBus` already uses for exactly this problem, and for the same
 * reason: publishing a layout must never re-render the board.
 *
 * Registration is last-writer-wins with an unregister that only clears its own
 * entry, so an unmounting board cannot blank the controller a freshly mounted
 * one just published.
 */

/**
 * Where an accepted request landed, in both of the vocabularies a surface might
 * speak. The desktop board frames the rect; the phone, which shows one pane at
 * a time and has no camera, selects the anchor. Both are on the destination so
 * neither surface has to re-derive the other's, and a surface that can honour
 * neither says so rather than pretending it moved.
 */
export interface FocusDestination {
  rect: FocusRect;
  /** `inspect` zooms in until the target reads; `situate` fits it with context. */
  zoom: ZoomIntent;
  /** Board keys the anchor actually resolved under. Empty when there is no
      object to select: a geometric target, or a landing degraded to the frame a
      vanished anchor used to occupy. */
  anchorKeys: readonly string[];
}

export interface BoardFocusController {
  /** Which project's layout this controller speaks for. */
  project: string;
  /** The board as it is NOW — rebuilt on every relayout, because a rect read at
      request time is stale as soon as a sibling appears. */
  index: FocusFrameIndex;
  /** Take the view there. False means this surface cannot — the caller then
      reports `lost` rather than recording an arrival that never happened. */
  moveTo(destination: FocusDestination): boolean;
  /** Put the camera back exactly where it was — the return path, which restores
      a framing rather than framing a thing. False on a surface with no camera. */
  restoreCamera(camera: { x: number; y: number; zoom: number }): boolean;
}

export interface ShellNavigator {
  /** The open project, or null on the overview. */
  project: string | null;
  openProject(project: string): void;
  /** Open a conversation by transcript path — what `intent: "open"` means.
      This is a NAVIGATION: it places the card and glides the camera to it. */
  openPath(path: string): void;
  /**
   * Put a card into the layout WITHOUT moving the camera to it.
   *
   * `openPath` does two things at once — it materializes the node and it arms
   * the board's pending-focus channel, which flashes the node and glides the
   * camera. A handoff needs only the first: it has its own destination, at its
   * own zoom, and issues it through `moveTo`. Calling `openPath` to reveal a
   * missing card therefore bought the placement at the price of a second,
   * competing camera move that raced the one the handoff actually wanted.
   *
   * So placement is separable and this is the half that does it.
   */
  placePath(path: string): void;
}

export interface FocusHandoffBus {
  setBoard(controller: BoardFocusController | null): () => void;
  board(): BoardFocusController | null;
  setShell(navigator: ShellNavigator | null): () => void;
  shell(): ShellNavigator | null;
}

export function createFocusHandoffBus(): FocusHandoffBus {
  let board: BoardFocusController | null = null;
  let shell: ShellNavigator | null = null;
  return {
    setBoard(controller) {
      board = controller;
      return () => {
        if (board === controller) board = null;
      };
    },
    board: () => board,
    setShell(navigator) {
      shell = navigator;
      return () => {
        if (shell === navigator) shell = null;
      };
    },
    shell: () => shell,
  };
}

/** The app-wide singleton. Components import this; tests build isolated buses. */
export const focusHandoffBus: FocusHandoffBus = createFocusHandoffBus();
