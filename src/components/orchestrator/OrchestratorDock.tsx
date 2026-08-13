"use client";

import { useCallback, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { OrchestratorPanel } from "./OrchestratorPanel";

const WIDTH_KEY = "llvOrchestratorPanelWidth";
export const OPEN_KEY = "llvOrchestratorPanelOpen";

export const MIN_WIDTH = 360;
export const DEFAULT_WIDTH = 440;
/** The board's own floor. The dock is PUSHED INTO the layout (PRD #976 decision
    1), so every pixel it takes is a pixel the board loses. */
export const MIN_BOARD = 320;
/** The project rail's fixed width (`ProjectRail`), which the dock sits beside. */
const RAIL_WIDTH = 248;
/** The document preview sheet's own minimum (`ArtifactPreviewHost.MIN_WIDTH`).
    Both surfaces may be open at once, and the preview overlays the board from
    the right — so the dock reserves the sheet's minimum up front and the board
    keeps {@link MIN_BOARD} with BOTH open, which is the acceptance bar. */
const PREVIEW_MIN = 380;

/** Everything the board must keep to the dock's right in the worst case. */
export const RESERVED_BESIDE_DOCK = RAIL_WIDTH + MIN_BOARD + PREVIEW_MIN;

/** The stored width, clamped to the dock's own range. A viewport too narrow to
    honour the reservation is handled in CSS (below), not here, so the stored
    preference survives a small window instead of being ground down by it. */
export function storedDockWidth(read: () => string | null): number {
  const value = Number(read());
  if (Number.isFinite(value) && value >= MIN_WIDTH) return value;
  return DEFAULT_WIDTH;
}

/** Width the drag lands on for a pointer at `clientX`, given the viewport. */
export function dockWidthForPointer(clientX: number, viewportWidth: number): number {
  const room = Math.max(MIN_WIDTH, viewportWidth - RESERVED_BESIDE_DOCK);
  return Math.min(Math.max(MIN_WIDTH, clientX - RAIL_WIDTH), room);
}

/**
 * The left dock: the orchestrator panel PUSHED INTO the Viewer layout between
 * the project rail and the board — not an overlay (PRD #976 decision 1). It is
 * a flex sibling, so the board simply gets the rest of the row.
 *
 * Width is the operator's, persisted like the document preview's
 * (`ArtifactPreviewHost`): drag the right edge, and the next session opens at
 * the same width. The CSS `min()` is the hard floor that the pointer clamp
 * cannot express — a window resized after the drag must not let a remembered
 * width squeeze the board below {@link MIN_BOARD} with the preview sheet also
 * open, and `max()` keeps the dock itself usable on a genuinely small desktop.
 */
export function OrchestratorDock({
  project,
  projectName,
  projectCwd,
  files,
  onClose,
}: {
  project: string;
  projectName: string;
  projectCwd?: string;
  files: readonly FileEntry[];
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [width, setWidth] = useState(() => storedDockWidth(() => {
    try {
      return window.localStorage.getItem(WIDTH_KEY);
    } catch {
      return null;
    }
  }));

  const resizeFrom = useCallback(() => {
    const move = (event: PointerEvent) => setWidth(dockWidthForPointer(event.clientX, window.innerWidth));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((value) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(value));
        } catch {
          /* private mode */
        }
        return value;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  return (
    <aside
      data-orchestrator-dock
      /* The operator's chosen width, before the viewport clamp below applies
         it — the CSS `max()/min()` expression is not readable back out. */
      data-orchestrator-dock-width={width}
      className="relative flex shrink-0 flex-col border-r border-border bg-card"
      style={{ width: `max(${MIN_WIDTH}px, min(${width}px, calc(100vw - ${RESERVED_BESIDE_DOCK}px)))` }}
    >
      {/* Keyed by project: the panel's draft — mandate, engine, model, account,
          and the idempotency key of an unsettled confirm — belongs to ONE
          project. The dock survives the switch (its width is the operator's,
          not the project's); the panel is re-seated on the new one and reads
          that project's own stored draft. */}
      <OrchestratorPanel
        key={project}
        project={project}
        projectName={projectName}
        projectCwd={projectCwd}
        files={files}
        onClose={onClose}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("orchPanel.resize")}
        title={t("orchPanel.resize")}
        data-orchestrator-dock-resize
        className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize hover:bg-accent/30"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeFrom();
        }}
      />
    </aside>
  );
}
