"use client";

import { useCallback, useEffect, useState } from "react";

import { PIP_DEFAULT_SIZE } from "@/lib/overlay/layout";

/**
 * The desktop rendering of the root conversation: a Chromium document
 * Picture-in-Picture window that floats above the editor (#691 D2).
 *
 * It is the *same* application and the *same* state — no second process, no
 * second notion of the conversation. Firefox and Safari have no equivalent, and
 * on Chromium the operator can simply close the window; in both cases the
 * identical component docks in the page instead. Because the conversation state
 * is server-side, nothing is lost or duplicated crossing that boundary, which
 * is the entire reason D2 insists on one component with three renderings.
 */

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
 * Without this the popped-out window renders the same markup unstyled, and
 * "identical component" would be true only in the source. Same-origin
 * stylesheets are copied rule by rule; cross-origin ones (which throw on
 * `cssRules`) are re-linked by href.
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
}

export interface PictureInPictureHandle {
  supported: boolean;
  /** The detached window while it is open; null means "render the dock". */
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
      opened = await available.requestWindow({ width: PIP_DEFAULT_SIZE.width, height: PIP_DEFAULT_SIZE.height });
    } catch {
      /* Denied, or no user gesture behind it. The dock is already on screen,
         so there is nothing to recover and nothing to report. */
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
    /* The operator closing the window with its own control is the dock's cue —
       the component is the same, so this is a change of container, not a
       teardown of anything stateful. */
    const onClose = () => setPipWindow(null);
    pipWindow.addEventListener("pagehide", onClose);
    return () => pipWindow.removeEventListener("pagehide", onClose);
  }, [pipWindow]);

  return { supported, pipWindow, open, close };
}
