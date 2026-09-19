"use client";

import { Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchoredBox } from "@/components/feed/SpeakMenu";
import { useModalLayer } from "@/components/modalLayer";
import { useLocale } from "@/lib/i18n";

import { SeatTickActions, SeatTickBody, SeatTickDot, useSeatTickDraft } from "./SeatTickBody";
import { seatTickReading } from "./seatTickView";
import { useSeatTickSettings, type SeatTickSettingsRead } from "./useSeatTickSettings";
import { Z } from "@/components/layers";

/*
 * The seat tick beside the orchestrator's own controls (#1681).
 *
 * One chip in the incumbent row, immediately before Rotate, so it appears in
 * both hosts of that row — the dock at every width and the kanban seat's
 * inline header — from one mount. The face is two tokens, because at the
 * dock's 360 px floor the row has no space for a sentence: a timer glyph, the
 * configured schedule in a word, and a 6 px dot for the actual state. The
 * whole closed summary rides the `title` and the accessible label.
 *
 * The popover is PORTALLED to the body at fixed coordinates. It has to be: the
 * kanban seat clips its panel with `overflow: hidden` and the dock is 360 px at
 * its floor, so an in-flow popover is clipped in both hosts — the same failure
 * `SpeakMenu` was moved out of the feed for, which is why the placement math
 * here is that module's rather than a second copy.
 */

const POPOVER_WIDTH = 320;

export function SeatTickChip({ project, projectName, className = "" }: { project: string; projectName: string; className?: string }) {
  const { t } = useLocale();
  /* WHICH project's popover is open, rather than whether one is: a project
     switch under an open popover would otherwise leave it describing the
     previous project's tick for a round-trip, and this closes it in render. */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === project;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const read = useSeatTickSettings(project, true);
  const reading = seatTickReading(read, Date.now(), t);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-seat-tick-chip={reading.state}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("seatTick.chipAria", { line: reading.line })}
        title={reading.line}
        onClick={() => setOpenFor((previous) => (previous === project ? null : project))}
        className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-border bg-card px-2 text-caption font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${className}`}
      >
        <Timer className="h-3 w-3" aria-hidden />
        <span data-seat-tick-face className="max-w-[72px] truncate">{reading.chip}</span>
        <SeatTickDot tone={reading.tone} />
      </button>
      {open ? (
        <SeatTickPopover
          anchorRef={anchorRef}
          project={project}
          projectName={projectName}
          read={read}
          onClose={() => setOpenFor(null)}
        />
      ) : null}
    </>
  );
}

function SeatTickPopover({ anchorRef, project, projectName, read, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  project: string;
  projectName: string;
  read: SeatTickSettingsRead;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const state = useSeatTickDraft(read.record);
  /* `onScreen` is consumed, not dropped (`SpeakAlert`'s reason, #1030): this
     popover deliberately does not lock body scroll, so the surface underneath
     it scrolls while it is open, and the placement math CLAMPS a scrolled-away
     anchor back to the viewport edge rather than following it off. Clamped
     there it is a 320 px panel pointing at nothing. */
  const { style, onScreen } = useAnchoredBox(anchorRef, rootRef, POPOVER_WIDTH);
  /* Escape, the Tab trap and focus return are the layer's, as they are for
     every other dialog here. Body scroll is NOT locked: this popover hangs off
     a row inside a scrolling panel, and locking the page under it would freeze
     the surface the operator is reading. */
  useModalLayer({ containerRef: rootRef, onClose, lockScroll: false });

  /* The one thing the layer does not answer: a pointer outside. A pointerdown
     on the chip itself is left alone so a second click toggles it shut. */
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target ?? null) || anchorRef.current?.contains(target ?? null)) return;
      onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [anchorRef, onClose]);

  /* A fresh read the moment it opens: the chip's 60 s cadence is for a face,
     and the popover states ages to the minute. */
  useEffect(() => {
    void read.refresh();
    // Once, on open: the poll inside the hook keeps it current after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Gone with its chip. Closing rather than hiding, so the layer, the outside
     listener and the focus return all unwind the way Escape unwinds them. */
  useEffect(() => {
    if (!onScreen) onClose();
  }, [onScreen, onClose]);

  if (typeof document === "undefined" || !onScreen) return null;
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("seatTick.dialogAria", { project: projectName })}
      tabIndex={-1}
      data-seat-tick-popover={project}
      style={style}
      className={`fixed ${Z.popover} flex max-h-[70vh] w-80 max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-surface border border-border bg-card shadow-2 outline-none`}
    >
      <SeatTickBody
        project={project}
        projectName={projectName}
        read={read}
        state={state}
        surface="desktop"
        actions={<SeatTickActions read={read} state={state} offDefault={read.record?.effective.isDefault === false} surface="desktop" />}
      />
    </div>,
    document.body,
  );
}
