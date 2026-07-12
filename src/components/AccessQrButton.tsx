"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Check, Copy, QrCode } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

interface AccessResponse {
  tailnetUrl: string | null;
}

type LoadState = { status: "idle" } | { status: "ready"; url: string } | { status: "unavailable" } | { status: "error" };

/**
 * Header button that renders a QR code for the tailnet URL (with the access
 * token baked in as `?k=`) so a phone can scan it and land already
 * authorized. The QR is drawn fully client-side via the `qrcode` package —
 * the token never touches an external image service or a server log.
 */
export function AccessQrButton() {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // Keyed by url so a stale QR from a previous render never flashes for the
  // wrong link (the effect that fills this in only ever calls setState from
  // its async continuation, never synchronously in the effect body).
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || state.status !== "idle") return;
    let cancelled = false;
    fetch("/api/access")
      .then((res) => res.json() as Promise<AccessResponse>)
      .then((json) => {
        if (cancelled) return;
        setState(json.tailnetUrl ? { status: "ready", url: json.tailnetUrl } : { status: "unavailable" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, state.status]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    const url = state.url;
    // Dynamic import keeps the QR renderer (and its dijkstrajs/pngjs deps) out
    // of the main bundle until someone actually opens the popover.
    import("qrcode")
      .then(({ toDataURL }) => toDataURL(url, { margin: 1, width: 220 }))
      .then((dataUrl) => {
        if (!cancelled) setQr({ url, dataUrl });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state]);

  const qrSrc = state.status === "ready" && qr && qr.url === state.url ? qr.dataUrl : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // pointerdown covers mouse, touch and pen, so a tap outside also closes
    // the popover on phones.
    const onDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const copy = useCallback(() => {
    if (state.status !== "ready") return;
    navigator.clipboard
      .writeText(state.url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => {});
  }, [state]);

  return (
    <div ref={panelRef} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("qr.showAria")}
        onClick={() => {
          // Reset to "idle" on every open so the URL is refetched: a past
          // fetch failure or a rotated token stops being sticky until reload.
          if (!open) setState({ status: "idle" });
          setOpen(!open);
        }}
        className={`flex items-center justify-center rounded-[8px] border border-line bg-panel text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          isMobile ? "h-11 w-11" : "p-1.5"
        }`}
      >
        <QrCode className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        /* The button sits near the right edge of the 248px-wide left rail, so
           a right-aligned panel would run past the left viewport edge. On sm+
           the panel opens rightward over the content area; below sm it is
           fixed and centered. */
        <div className="fixed left-1/2 top-12 z-50 flex w-[260px] -translate-x-1/2 flex-col gap-2.5 rounded-[12px] border border-line bg-panel p-3 shadow-[0_8px_28px_rgba(20,20,30,0.14)] sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-1.5 sm:translate-x-0">
          {state.status === "idle" ? (
            <span className="text-[12px] text-ink">{t("common.loading")}</span>
          ) : state.status === "error" ? (
            <span className="text-[12px] font-semibold text-err">{t("qr.failed")}</span>
          ) : state.status === "unavailable" ? (
            <span className="text-[12px] leading-relaxed text-ink">
              {t("qr.startHint")}
              <code className="break-all rounded bg-chip px-1 py-0.5 font-mono text-[11px]">
                bunx agent-log-viewer --tailscale
              </code>
            </span>
          ) : (
            <>
              {qrSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrSrc} alt={t("qr.alt")} className="mx-auto h-[220px] w-[220px]" />
              ) : (
                <span className="text-[12px] text-ink">{t("qr.generating")}</span>
              )}
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={state.url}
                  aria-label={t("qr.linkAria")}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-w-0 flex-1 truncate rounded-[8px] border border-line bg-bg px-2 py-1.5 font-mono text-[10.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
                <button
                  type="button"
                  aria-label={t("qr.copy")}
                  onClick={copy}
                  className="flex shrink-0 items-center gap-1 rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[11px] font-semibold text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                </button>
              </div>
              <span className="text-[10.5px] text-dim">{t("qr.scanHint")}</span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
