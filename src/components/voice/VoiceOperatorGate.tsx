"use client";

import { useEffect, useRef, useState } from "react";

import { AudioLines } from "lucide-react";

import { Hint } from "@/components/Hint";
import { adoptOperatorCredentialFromPaste } from "@/components/operatorCredential";
import type { TFunction } from "@/lib/i18n";

/**
 * The voice start control's unavailable state (#stage blocker).
 *
 * Hiding the start control for a tab without the operator credential removed the
 * ONLY entry point to voice: a plain navigation to the Viewer — every fresh tab,
 * and every tab after a server restart re-mints the credential — showed nothing
 * at all. The control must stand down visibly, say why in the operator's
 * language, and offer the legitimate way in.
 *
 * That way in is the operator link (or its key) pasted into a masked field. It
 * adopts into exactly the storage the link route uses — this tab's
 * `sessionStorage`, nothing fetchable, nothing persistent beyond the tab — so
 * the standing security posture is unchanged. The value is never echoed, and a
 * wrong paste simply leaves the server to refuse the start with the localized
 * notice on the voice panel.
 */
export function VoiceOperatorGate({ t }: { t: TFunction }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <Hint label={t("voice.needsOperator")} align="right">
        <button
          type="button"
          data-testid="voice-operator-gate"
          aria-label={t("voice.needsOperator")}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-dashed border-border text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <AudioLines className="h-4 w-4 opacity-60" aria-hidden />
        </button>
      </Hint>
      {open ? (
        <div
          role="dialog"
          aria-label={t("voice.needsOperator")}
          className="absolute bottom-[calc(100%+6px)] right-0 z-40 w-[280px] rounded-surface border border-border bg-raised p-2 shadow-2"
        >
          <p className="px-1 pb-1.5 text-caption leading-snug text-secondary">
            {t("voice.operatorGateHint")}
          </p>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (adoptOperatorCredentialFromPaste(value)) {
                /* The subscribers re-render and the real start control replaces
                   this gate; nothing to clean up beyond the field. */
                setValue("");
                setRejected(false);
                setOpen(false);
                return;
              }
              setRejected(true);
            }}
          >
            <input
              /* Masked: the pasted link carries the operator secret, and the
                 screen — a screenshot, a stream — must not. */
              type="password"
              data-testid="voice-operator-gate-input"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setRejected(false);
              }}
              placeholder={t("voice.operatorGatePaste")}
              aria-label={t("voice.operatorGatePaste")}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-control border border-border bg-sunken px-2 py-1 text-label text-primary placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <button
              type="submit"
              data-testid="voice-operator-gate-apply"
              className="inline-flex shrink-0 items-center rounded-control border border-accent/40 bg-accent-soft px-2 py-1 text-label font-semibold text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("voice.operatorGateApply")}
            </button>
          </form>
          {rejected ? (
            <p role="alert" className="px-1 pt-1.5 text-caption text-danger">
              {t("voice.operatorGateInvalid")}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
