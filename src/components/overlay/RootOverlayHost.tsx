"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { DOCK_WIDTH, PIP_DEFAULT_SIZE, snapForAttentionRequest, type SheetSnap } from "@/lib/overlay/layout";

import { RootOverlay, type RootOverlayProps } from "./RootOverlay";
import { RootSheet } from "./RootSheet";
import { useDocumentPictureInPicture } from "./useDocumentPictureInPicture";

/**
 * Which of the three renderings is on screen (#691 D2).
 *
 * This host owns exactly that decision and nothing else. The conversation state
 * is server-side and the component is the same in all three cases, so crossing
 * any of these boundaries loses and duplicates nothing — which is the whole
 * reason D2 insists on one component with three renderings rather than three
 * surfaces that each know how to be a conversation.
 */

export type RootOverlayHostProps = Omit<RootOverlayProps, "surface" | "height" | "density"> & {
  /** Phone-width viewport: the sheet, not the window. */
  mobile: boolean;
  /** Visual viewport height minus the bottom inset. */
  usableHeight: number;
  /** Test seam for the PiP capability, which happy-dom cannot provide. */
  pictureInPicture?: ReturnType<typeof useDocumentPictureInPicture>;
};

export function RootOverlayHost({ mobile, usableHeight, pictureInPicture, ...overlay }: RootOverlayHostProps) {
  const fallback = useDocumentPictureInPicture();
  const pip = pictureInPicture ?? fallback;
  const [snap, setSnap] = useState<SheetSnap>("half");
  const [measured, setMeasured] = useState<{ window: Window; height: number } | null>(null);
  const [answeredRequestId, setAnsweredRequestId] = useState<string | null>(null);

  const requestId = overlay.attention?.request.id ?? null;

  /* A handoff never raises the conversation over the work it is pointing at; if
     it moves the sheet at all, it moves it down. Adjusting during render rather
     than in an effect keeps it to one pass — the sheet must never be seen at
     the wrong height first and corrected afterwards. */
  if (requestId !== answeredRequestId) {
    setAnsweredRequestId(requestId);
    if (requestId) setSnap((current) => snapForAttentionRequest(current));
  }

  /* The arrangement is a fact about the window, so the window is measured
     rather than assumed — and the first measurement is read directly, so no
     render ever shows the wrong arrangement while an effect catches up. */
  useEffect(() => {
    const opened = pip.pipWindow;
    if (!opened) return;
    const onResize = () => setMeasured({ window: opened, height: opened.innerHeight || PIP_DEFAULT_SIZE.height });
    opened.addEventListener("resize", onResize);
    return () => opened.removeEventListener("resize", onResize);
  }, [pip.pipWindow]);

  const windowHeight = measured?.window === pip.pipWindow
    ? measured.height
    : pip.pipWindow?.innerHeight || PIP_DEFAULT_SIZE.height;

  if (mobile) {
    return (
      <RootSheet
        {...overlay}
        snap={snap}
        onSnapChange={setSnap}
        usableHeight={usableHeight}
      />
    );
  }

  if (pip.pipWindow) {
    return createPortal(
      <RootOverlay {...overlay} surface="window" height={windowHeight} onToggleDock={pip.close} />,
      pip.pipWindow.document.body as unknown as Element,
    );
  }

  /* No window: the identical component docks bottom-right at the same width.
     One control crosses the boundary — pop out, dock. */
  return (
    <div
      data-testid="root-overlay-dock"
      className="fixed bottom-3 right-3 z-40 overflow-hidden rounded-[12px] border border-border shadow-2"
      style={{ width: DOCK_WIDTH }}
    >
      <RootOverlay
        {...overlay}
        surface="dock"
        height={PIP_DEFAULT_SIZE.height}
        /* Firefox and Safari have no document Picture-in-Picture, so there is
           nothing to pop out to and the control does not pretend otherwise. */
        onToggleDock={pip.supported ? () => { void pip.open(); } : undefined}
      />
    </div>
  );
}
