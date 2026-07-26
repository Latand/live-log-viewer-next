"use client";

import { useEffect, useRef, useState } from "react";

import { useCoarsePointer } from "@/hooks/useCoarsePointer";

import { Check, Copy } from "../icons";
import { tr } from "./parse";

/** Clipboard write with a hidden-textarea fallback: the viewer is also opened
    over plain-http LAN origins where navigator.clipboard does not exist. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied — try the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Ghost icon button that copies `text` and flashes a checkmark. `label`
    names what gets copied (defaults to a plain "copy").

    The 44px branch is sized off `(pointer: coarse)` — the same query
    `ACTION_GUTTER` reserves its wide gutter from — because the big target
    exists for a finger, and a finger is exactly what that query reports. It
    used to read `useIsMobile()`'s `(max-width: 767px)` viewport query instead,
    so a fine pointer under 768px (a desktop window dragged narrow, a
    split-screen pane, responsive-design mode without touch emulation) put a
    44px control against a 28px gutter and covered 22px of the message body.
    Size and gutter now read one axis and cannot disagree. */
export function CopyButton({ text, label, className = "" }: { text: string; label?: string; className?: string }) {
  const coarse = useCoarsePointer();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const title = copied ? tr("common.copied") : (label ?? tr("common.copy"));
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={(event) => {
        /* Feed buttons live inside <summary> collapsibles and message rows —
           a copy must not toggle or select what it sits on. */
        event.preventDefault();
        event.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_400);
        });
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-[6px] border border-border bg-card text-muted shadow-1 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${coarse ? "h-11 w-11" : "p-1"} ${className}`}
    >
      {copied ? <Check className={coarse ? "h-4 w-4 text-success" : "h-3 w-3 text-success"} aria-hidden /> : <Copy className={coarse ? "h-4 w-4" : "h-3 w-3"} aria-hidden />}
    </button>
  );
}
