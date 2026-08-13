"use client";

import { useSyncExternalStore } from "react";

/*
 * How many pixels of the desktop shell's row are consumed to the LEFT of the
 * board — the project rail plus the orchestrator dock, when that dock is open
 * (PRD #976 decision 1). Zero when nothing is docked, and on the phone.
 *
 * It exists for one reader: the document preview sheet, which is a fixed
 * portal anchored to the right edge. Being fixed, it takes no space in the row
 * and cannot see a surface pushed into the row on the other side — so with both
 * open it happily covered the board down to 192px on a 1440px screen.
 *
 * The coordination runs ONE WAY, dock → sheet, and that direction is the whole
 * design. The dock is a persistent surface the operator sized on purpose and
 * bounds itself against the sheet's MINIMUM; the sheet is opened on demand,
 * remembers a width that is merely a preference, and has the slack to give. The
 * reverse — shrinking the dock to fit a remembered sheet width — cannot hold the
 * board's floor anyway (at 1440 the dock hits its own 360px minimum and the
 * board still ends up at 272px), and it would resize a surface the operator was
 * working in because they opened a document. A single direction is also what
 * keeps the two clamps from chasing each other.
 *
 * A module-level store rather than context, for the same reason the preview bus
 * is one: the reader renders inside a portal, and neither surface should drag
 * the whole shell into its render.
 */

let inset = 0;
const listeners = new Set<() => void>();

/** Published by the desktop dock while it is mounted; 0 when it closes. */
export function setLeftShellInset(next: number): void {
  const value = Number.isFinite(next) && next > 0 ? next : 0;
  if (value === inset) return;
  inset = value;
  for (const listener of [...listeners]) listener();
}

export function leftShellInset(): number {
  return inset;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live inset, for a surface that overlays the row from the right. Zero on
    the server, where nothing is docked yet. */
export function useLeftShellInset(): number {
  return useSyncExternalStore(subscribe, leftShellInset, () => 0);
}
