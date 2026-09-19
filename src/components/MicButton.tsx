"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Check, Copy, Loader2, Mic, Square, X } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { fmtElapsed, METER_HEIGHT, METER_WIDTH, prewarmLiveToken, type UseDictationResult } from "@/hooks/useDictation";
import { micVisual } from "@/lib/dictationTimer";
import { translate, useLocale } from "@/lib/i18n";

import { Z } from "./layers";

export interface MicButtonViewProps extends UseDictationResult {
  onText: (text: string) => void;
  /** Extra external busy flag (e.g. a caller mid stop-and-send) that blocks
      starting a new recording on top of the hook's own "busy" phase. */
  busy?: boolean;
  /** Composer-anchored presentation (design doc §3.5): the idle button sheds
      its border/panel fill for a 32px visual control that keeps a 44px touch
      hit area (pseudo-element), so it reads as an icon inside the sunken input
      rather than a second bordered box beside the accent send. */
  anchored?: boolean;
}

type BackendId = "local" | "chatgpt" | "elevenlabs" | "soniox";

interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: { id: BackendId; available: boolean; keyPath: string }[];
}

const MENU_WIDTH = 300;
const MENU_GAP = 6;
const EDGE = 8;

type MenuPlacement = { left: number; top?: number; bottom?: number; maxHeight: number };

/** Above the button when the menu fits there, else below it; always inside the window. */
export function backendMenuPlacement(anchor: { top: number; bottom: number; right: number }, menuHeight: number, viewport: { width: number; height: number }): MenuPlacement {
  const left = Math.max(EDGE, Math.min(anchor.right - MENU_WIDTH, viewport.width - MENU_WIDTH - EDGE));
  const spaceAbove = anchor.top - MENU_GAP - EDGE;
  const spaceBelow = viewport.height - anchor.bottom - MENU_GAP - EDGE;
  if (menuHeight <= spaceAbove || spaceAbove >= spaceBelow) {
    return { left, bottom: viewport.height - anchor.top + MENU_GAP, maxHeight: Math.max(0, spaceAbove) };
  }
  return { left, top: anchor.bottom + MENU_GAP, maxHeight: Math.max(0, spaceBelow) };
}

/**
 * Right-click menu of the mic button: pick which transcription engine handles
 * dictation. Options carry a one-line description; an option whose credential
 * is missing opens a key panel with the exact path to drop it into, copyable.
 *
 * Portalled to the document at the popover layer and placed against the
 * window from the button's box: a composer lives inside panes that clip their
 * content (the orchestrator seat, a reader in a card) and inside modals, and
 * a menu left in place there was cut off by the composer row and drawn under
 * the chips beside it (#1858).
 */
function BackendMenu({ anchorRef, onClose }: { anchorRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  const { locale, t } = useLocale();
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<BackendId | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState<BackendId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPlacement(backendMenuPlacement(rect, rootRef.current?.scrollHeight ?? 0, { width: window.innerWidth, height: window.innerHeight }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (rootRef.current) observer?.observe(rootRef.current);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcribe/backend")
      .then((res) => res.json() as Promise<BackendInfo>)
      .then((json) => {
        if (!cancelled && Array.isArray(json.options)) setInfo(json);
      })
      .catch(() => {
        if (!cancelled) setError(translate(locale, "common.serverUnavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  /* THE MENU TAKES FOCUS. A portal leaves the tab order behind at the Dictate
     button, so a menu opened from the keyboard (Shift+F10, the context-menu
     key) was out of Tab's reach at the end of the document. The menu itself
     holds focus while its options load, then hands it to the selected option;
     Tab and the arrows cycle inside it, and closing from the keyboard or with
     a pick gives focus back to the button. */
  const optionsReady = info !== null;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ?? root.querySelector<HTMLElement>("button:not([disabled])")
      ?? root;
    target.focus();
  }, [optionsReady, keyFor]);

  const close = () => {
    const root = rootRef.current;
    const hadFocus = Boolean(root && root.contains(document.activeElement));
    onClose();
    if (hadFocus) anchorRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "Tab" ? (event.shiftKey ? -1 : 1)
      : event.key === "ArrowDown" ? 1
      : event.key === "ArrowUp" ? -1
      : 0;
    if (step === 0) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next].focus();
  };

  /* Click-away and Escape both dismiss; the menu never outlives the composer,
     and its Escape never reaches a modal it was opened in. A click away leaves
     focus wherever that click puts it. */
  useOverlayEscape(close);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);

  const pick = async (id: BackendId, available: boolean) => {
    if (!info || info.lockedByEnv || saving) return;
    if (!available) {
      setKeyFor(id);
      setCopied(false);
      return;
    }
    setSaving(id);
    setError(null);
    try {
      const res = await fetch("/api/transcribe/backend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend: id }),
      });
      const json = (await res.json()) as BackendInfo & { error?: string };
      if (!res.ok) {
        setError(json.error ?? t("mic.saveFailed"));
        return;
      }
      setInfo(json);
      close();
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setSaving(null);
    }
  };

  const keyOption = keyFor && info ? info.options.find((option) => option.id === keyFor) : null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label={t("mic.menuTitle")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-mic-backend-menu
      style={placement
        ? { left: placement.left, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight }
        : { left: -9999, top: 0, visibility: "hidden" }}
      className={`fixed ${Z.popover} w-[300px] overflow-y-auto outline-none rounded-[12px] border border-border bg-card p-1.5 shadow-2`}
    >
      {keyOption ? (
        <div className="flex flex-col gap-2 p-2">
          <span className="text-[12px] font-bold text-danger">
            {t("mic.keyTitle", { name: t(`stt.${keyOption.id}.name`) })}
          </span>
          <span className="text-[11.5px] leading-snug text-primary">{t(`stt.${keyOption.id}.fix`)}</span>
          <span className="flex items-center gap-1 rounded-[8px] border border-border bg-canvas px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-primary">{keyOption.keyPath}</code>
            <button
              type="button"
              aria-label={t("mic.copyPath")}
              title={t("mic.copyPath")}
              className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-border bg-card px-1.5 py-1 text-[10px] font-semibold text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => {
                void navigator.clipboard.writeText(keyOption.keyPath).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? t("mic.copied") : t("mic.copy")}
            </button>
          </span>
          <button
            type="button"
            className="self-start rounded-[8px] px-2 py-1 text-[11px] font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setKeyFor(null)}
          >
            ← {t("mic.back")}
          </button>
        </div>
      ) : (
        <>
          <div className="px-2 pb-1 pt-1.5 text-label font-semibold text-secondary">
            {t("mic.menuTitle")}
          </div>
          {info?.lockedByEnv ? (
            <div className="px-2 pb-1 text-[10.5px] text-danger">{t("mic.menuLocked")}</div>
          ) : null}
          {!info && !error ? (
            <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("mic.menuLoading")}
            </div>
          ) : null}
          {(info?.options ?? []).map((option) => {
            const active = info?.backend === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={Boolean(info?.lockedByEnv) || saving !== null}
                onClick={() => void pick(option.id, option.available)}
                className={`flex w-full items-start gap-2 rounded-[9px] px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                  active ? "bg-accent/10" : "hover:bg-canvas"
                }`}
              >
                <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {saving === option.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" aria-hidden />
                  ) : active ? (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                  ) : (
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: option.available ? "var(--color-success)" : "var(--color-warning)" }}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-primary">
                    {t(`stt.${option.id}.name`)}
                    {!option.available ? (
                      <span className="rounded-full bg-warning-soft px-1.5 py-px text-[9.5px] font-bold text-warning">
                        {t("mic.noKey")}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[10.5px] leading-snug text-muted">{t(`stt.${option.id}.desc`)}</span>
                </span>
              </button>
            );
          })}
          {error ? <div className="px-2 py-1 text-[10.5px] font-semibold text-danger">{error}</div> : null}
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * Presentational dictation control driven by a `useDictation` instance handed
 * down by the caller, so a composer that orchestrates its own send button
 * around the same recording (see TmuxComposer) shares one hook instance.
 * Right-click (long-press on touch) opens the transcription-backend menu.
 */
export function MicButtonView({
  phase,
  elapsed,
  maxSeconds,
  remaining,
  capStopped,
  srMessage,
  canvasRef,
  start,
  stop,
  discard,
  onText,
  busy = false,
  anchored = false,
}: MicButtonViewProps) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const visual = micVisual({ phase, elapsed, maxSeconds, capStopped });
  const handleMain = () => {
    if (busy) return;
    if (phase === "idle") void start();
    else if (phase === "rec") {
      void stop().then((text) => {
        if (text) onText(text);
      });
    }
  };

  /* Owned here so it covers every mic-hosting surface (composers and the task
     edit field alike): the near-cap warning and the cap stop are announced to
     assistive tech even when the visual cue is off-screen. Polite, and always
     mounted so a first message isn't missed by an appearing region. */
  const srRegion = (
    <span role="status" aria-live="polite" className="sr-only">
      {srMessage}
    </span>
  );

  if (phase === "rec") {
    const warn = visual === "recWarn";
    return (
      <span className="flex shrink-0 items-center gap-1">
        {srRegion}
        <button
          type="button"
          aria-label={t("mic.stopRecognize")}
          title={warn ? t("mic.timeLeft", { time: fmtElapsed(remaining) }) : undefined}
          onClick={handleMain}
          className={`flex items-center gap-1.5 rounded-control border px-2 text-label font-bold tabular-nums focus-visible:outline-none focus-visible:ring-2 ${
            isMobile ? "min-h-11" : "py-2"
          } ${
            warn
              ? "border-warning/70 bg-warning-soft text-warning focus-visible:ring-warning/50"
              : "border-danger/50 bg-danger-soft text-danger focus-visible:ring-danger/40"
          }`}
        >
          <canvas ref={canvasRef} width={METER_WIDTH} height={METER_HEIGHT} className="h-4 w-14" aria-hidden />
          {warn ? `−${fmtElapsed(remaining)}` : fmtElapsed(elapsed)}
        </button>
        <button
          type="button"
          aria-label={t("mic.cancel")}
          onClick={discard}
          className={`inline-flex items-center justify-center rounded-control border border-border bg-card text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isMobile ? "h-11 w-11" : "p-2"
          }`}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  /* The held "stopped at the cap" chip: distinct amber outline, and the
     transcription spinner rides inside it while a batch recording resolves. */
  if (visual === "capStopped") {
    return (
      <span className="flex shrink-0 items-center gap-1">
        {srRegion}
        <span className="flex items-center gap-1.5 rounded-control border border-warning/70 bg-warning-soft px-2 py-2 text-label font-bold text-warning">
          {phase === "busy" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Square className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
          )}
          {t("mic.capStopped")}
        </span>
      </span>
    );
  }

  return (
    <span className="relative inline-flex shrink-0">
      {srRegion}
      <button
        ref={buttonRef}
        type="button"
        aria-label={phase === "busy" ? t("mic.recognizing") : phase === "starting" ? t("mic.connecting") : t("mic.dictate")}
        title={phase === "busy" ? t("mic.recognizing") : phase === "starting" ? t("mic.connecting") : t("mic.dictateHint")}
        disabled={phase !== "idle" || busy}
        onClick={handleMain}
        /* Hover/focus telegraphs an imminent press — mint the live token now
           so the press itself only waits for the microphone. */
        onPointerEnter={prewarmLiveToken}
        onFocus={prewarmLiveToken}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((open) => !open);
        }}
        className={
          anchored
            ? `relative inline-flex shrink-0 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                /* 32px visual, 44px hit via the pseudo-element (rule 8). */
                isMobile ? "h-8 w-8 before:absolute before:-inset-1.5 before:content-['']" : "p-2"
              } ${phase === "starting" ? "bg-accent/10 text-accent" : "text-muted hover:bg-sunken hover:text-accent"}`
            : `inline-flex shrink-0 items-center justify-center rounded-[8px] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                isMobile ? "h-11 w-11" : "p-2"
              } ${phase === "starting" ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-card text-muted hover:text-accent"}`
        }
      >
        {phase === "busy" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : phase === "starting" ? (
          /* No pulse under reduced-motion: the accent tint alone signals it. */
          <Mic className="h-4 w-4 animate-pulse motion-reduce:animate-none" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </button>
      {menuOpen ? <BackendMenu anchorRef={buttonRef} onClose={() => setMenuOpen(false)} /> : null}
    </span>
  );
}
