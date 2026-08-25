"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { setLeftShellInset } from "../shellLayout";
import { OrchestratorPanel } from "./OrchestratorPanel";

/** The width every project shared before #1011. Since the split it serves as a
    seed: a project that has never been sized falls back to it, so operators
    coming from the single global preference keep their width everywhere.
    Nothing writes it. */
const LEGACY_WIDTH_KEY = "llvOrchestratorPanelWidth";
/** One project's own width (#1011). Projects are isolated surfaces — a dock
    dragged wide for a mandate-heavy project must not resize every other one. */
const widthKey = (project: string) => `${LEGACY_WIDTH_KEY}:${project}`;
/** The open/closed flag every project shared before #1149, now the same kind of
    seed `LEGACY_WIDTH_KEY` is: a project that has never been opened or closed
    answers with it, so an operator coming from the single global preference
    finds the dock where they left it everywhere. Nothing writes it. It keeps
    its pre-#1149 name because it is the same key holding the same value — only
    its role narrowed. */
export const OPEN_KEY = "llvOrchestratorPanelOpen";
/** One project's own open state (#1149). The dock is a per-project surface —
    closing it in a project the operator only glances at must not close it in
    the one they are running. */
const projectOpenKey = (project: string) => `${OPEN_KEY}:${project}`;

export const MIN_WIDTH = 360;
export const DEFAULT_WIDTH = 440;
/** The board's own floor. The dock is PUSHED INTO the layout (PRD #976 decision
    1), so every pixel it takes is a pixel the board loses. */
export const MIN_BOARD = 320;
/** The project rail's fixed width (`ProjectRail`), which the dock sits beside. */
export const RAIL_WIDTH = 248;
/** The document preview sheet's own minimum (`ArtifactPreviewHost.MIN_WIDTH`).
    The dock bounds itself against the sheet's MINIMUM and no more: the sheet
    yields the rest, budgeting around this dock's real width through
    `../shellLayout`, so opening a document never shrinks the panel the operator
    is working in. Between the two clamps the board keeps {@link MIN_BOARD} with
    both surfaces open, which is the acceptance bar. */
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

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The width to open `project` at: its own, else the pre-#1011 global one as a
    seed, else the default. Only ABSENCE falls through to the seed — a project
    that has been sized answers for itself, nonsense included. */
function projectDockWidth(project: string): number {
  return storedDockWidth(() => readStorage(widthKey(project)) ?? readStorage(LEGACY_WIDTH_KEY));
}

/** Whether the dock opens for `project`: its own remembered answer, else the
    pre-#1149 global one as a seed, else closed. Only ABSENCE falls through to
    the seed — a project that has answered for itself outranks it, «closed»
    included. */
export function dockOpenFor(project: string): boolean {
  return (readStorage(projectOpenKey(project)) ?? readStorage(OPEN_KEY)) === "1";
}

/** Remember what the operator just did to THIS project's dock. */
export function rememberDockOpen(project: string, open: boolean): void {
  try {
    window.localStorage.setItem(projectOpenKey(project), open ? "1" : "0");
  } catch {
    /* private mode */
  }
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
 * Width is the operator's, persisted PER PROJECT (#1011) the way the document
 * preview persists its own (`ArtifactPreviewHost`): drag the right edge, and
 * that project opens at the same width next session while every other project
 * keeps the width it was left at. The CSS `min()` is the hard floor that the
 * pointer clamp cannot express — a window resized after the drag must not let
 * a remembered width squeeze the board below {@link MIN_BOARD} with the preview
 * sheet also open, and `max()` keeps the dock itself usable on a genuinely
 * small desktop.
 *
 * The other half of that guarantee lives in the sheet: this dock publishes the
 * row it occupies (`../shellLayout`) and the sheet budgets around it, so a
 * document opened at its remembered 560px yields to the dock instead of burying
 * the board — which is what left only 192px of board on a 1440px screen.
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
  const [width, setWidth] = useState(() => projectDockWidth(project));

  /* A project switch re-reads the width, because the width now BELONGS to the
     project (#1011). The adjustment happens during render, so the dock never
     paints — nor publishes to `../shellLayout` — a frame of the project the
     operator just left. */
  const [sizedProject, setSizedProject] = useState(project);
  if (sizedProject !== project) {
    setSizedProject(project);
    setWidth(projectDockWidth(project));
  }

  /* The row this dock occupies, for the preview sheet to budget around —
     published live through the resize drag, and given back on close.

     LAYOUT phase, so the published row and the committed width are one atomic
     change: a passive effect publishes a frame late, and a project switch that
     widens the dock would paint that frame with the sheet still budgeting for
     the narrower one, taking the board under {@link MIN_BOARD}. */
  useLayoutEffect(() => {
    setLeftShellInset(RAIL_WIDTH + width);
    return () => setLeftShellInset(0);
  }, [width]);

  /* The drag in flight, so a project switch can end it. A pointerup released
     outside the window never reaches these listeners, so a drag can still be
     armed when the operator moves to another project. */
  const endDrag = useRef<(() => void) | null>(null);

  const resizeFrom = useCallback(() => {
    /* A drag belongs to the project it started on, and carries its own width:
       both are captured here so a switch mid-drag lands the dragged width on
       the project the operator sized, leaving the new project's own width
       alone. Reading the width back out of state at pointerup would write
       whatever the switch loaded into the wrong project's key. */
    const owner = project;
    let dragged: number | null = null;
    const move = (event: PointerEvent) => {
      dragged = dockWidthForPointer(event.clientX, window.innerWidth);
      setWidth(dragged);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      endDrag.current = null;
      if (dragged === null) return;
      try {
        window.localStorage.setItem(widthKey(owner), String(dragged));
      } catch {
        /* private mode */
      }
    };
    endDrag.current?.();
    endDrag.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }, [project]);

  /* End an unfinished drag when the project changes under it, or when the dock
     closes: the width it produced is settled on its owner, and the dock the
     operator is now looking at stops following the pointer.

     LAYOUT phase again, and for the sharper reason: this cleanup runs inside
     the commit, so the listeners are gone before the switch is observable. A
     passive cleanup leaves them live until after paint, and any pointermove in
     that gap — a drag whose pointerup was released outside the window stays
     armed indefinitely — drags the dock of the project just opened. */
  useLayoutEffect(() => () => endDrag.current?.(), [project]);

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
          project. The dock survives the switch, resized to the new project's
          own remembered width; the panel is re-seated on it and reads that
          project's own stored draft.

          The key STAYS, and instant switching (#1149) is bought outside the
          subtree instead: the seat and incumbent hooks keep this tab's answers
          in a map keyed by project, and the feed keeps its own per-path
          transcript snapshot (`useLogTail`), so the re-seated panel paints the
          project's live conversation in its first commit and revalidates
          behind it. Dropping the key would keep the subtree alive but leave
          five pieces of one project's draft state on another project's panel —
          a much larger change for the same paint. */}
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
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/30"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeFrom();
        }}
      />
    </aside>
  );
}
