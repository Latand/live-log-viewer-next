"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The floating rendering of the voice conversation: a Chromium Document
 * Picture-in-Picture window that stays above the whole Viewer (#691).
 *
 * Resurrected from the #705 overlay family (deleted in `2834d756`) because its two
 * jobs are exactly what the new host needs and neither is obvious: getting a window
 * inside the user's gesture, and making that window look like the product.
 *
 * It is the *same* application and the *same* state — a same-origin document sharing
 * the opener's JS realm, so the floater is a React portal, not a second app. No
 * second process, no second notion of the conversation, no second WebRTC session.
 * Firefox and Safari have no equivalent and on Chromium the operator can simply
 * close the window; in both cases the identical surface stays docked in the card,
 * which is why nothing here reports an error when the window cannot be had.
 */

/** §6: default ~380×560. The OS owns move and resize from there; nothing in this
    app remembers where the operator put it (U4 — no remembered layout). */
export const PIP_DEFAULT_SIZE = { width: 380, height: 560 } as const;

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPictureInPicture | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
  return candidate && typeof candidate.requestWindow === "function" ? candidate : null;
}

export function documentPictureInPictureSupported(): boolean {
  return api() !== null;
}

/**
 * Clone the page's styles into the detached document.
 *
 * Without this the floater renders the same markup unstyled, and "the product,
 * floating" would be true only in the source. Same-origin stylesheets are copied
 * rule by rule; cross-origin ones (which throw on `cssRules`) are re-linked by
 * href. The root and body classes come across too, so the theme and the locale
 * direction the opener resolved apply here without being recomputed.
 */
function adoptStyles(target: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
      const style = target.document.createElement("style");
      style.textContent = text;
      target.document.head.appendChild(style);
    } catch {
      const href = sheet.href;
      if (!href) continue;
      const link = target.document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      target.document.head.appendChild(link);
    }
  }
  target.document.documentElement.className = document.documentElement.className;
  target.document.body.className = document.body.className;
  /* §7: the floater inherits `lang` and `dir` rather than deriving them, so the
     uk/en parity the card already has cannot drift here. */
  target.document.documentElement.lang = document.documentElement.lang;
  target.document.documentElement.dir = document.documentElement.dir;
}

export interface PictureInPictureHandle {
  supported: boolean;
  /** The detached window while it is open; null means "render docked". */
  pipWindow: Window | null;
  open: () => Promise<void>;
  close: () => void;
}

export function useDocumentPictureInPicture(): PictureInPictureHandle {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const supported = documentPictureInPictureSupported();

  const open = useCallback(async () => {
    const available = api();
    if (!available || pipWindow) return;
    let opened: Window;
    try {
      opened = await available.requestWindow({ ...PIP_DEFAULT_SIZE });
    } catch {
      /* Denied, or no user gesture behind it. The docked rendering is already on
         screen, so there is nothing to recover and nothing to report — and no
         retry loop, which would ask for a window on every render. */
      return;
    }
    adoptStyles(opened);
    setPipWindow(opened);
  }, [pipWindow]);

  const close = useCallback(() => {
    pipWindow?.close();
    setPipWindow(null);
  }, [pipWindow]);

  useEffect(() => {
    if (!pipWindow) return;
    /* The operator (or the OS) closing the window is the dock's cue. The surface
       is the same component either way, so this is a change of container, never a
       teardown of anything stateful: the call, the transcript and the draft live
       in the opener and do not notice. */
    const onClose = () => setPipWindow(null);
    pipWindow.addEventListener("pagehide", onClose);
    return () => pipWindow.removeEventListener("pagehide", onClose);
  }, [pipWindow]);

  return { supported, pipWindow, open, close };
}
