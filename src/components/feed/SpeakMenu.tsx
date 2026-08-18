"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Check, Loader2 } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";

export type BackendId = "openai" | "elevenlabs" | "soniox";

export interface BackendOption {
  id: BackendId;
  available: boolean;
  keyPath: string;
  model: string;
  voice: string;
  cap: number;
}

export interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: BackendOption[];
}

const MARGIN = 8;
const MENU_WIDTH = 300;

/**
 * Pure placement math for the read-aloud menu (kept out of the effect so it is
 * unit-testable). The menu hangs off the trigger's right edge and prefers to
 * open BELOW it — a context menu drops from where the pointer is — flipping
 * above only when it cannot fit below and above has more room. Both axes are
 * clamped into the viewport, so the menu is whole on screen even when the
 * message it belongs to sits at the very bottom or the very right of the feed.
 *
 * (`verdictPlacement` in the pipeline strip solves the same clipping with the
 * opposite policy — centred on its chip and above-first — so the two stay
 * separate rather than one growing a mode flag.)
 */
export function speakMenuPlacement(
  anchor: { top: number; bottom: number; right: number },
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MARGIN,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(anchor.right - content.width, viewport.width - content.width - margin));
  const roomBelow = viewport.height - anchor.bottom - margin;
  const roomAbove = anchor.top - margin;
  const flip = content.height > roomBelow && roomAbove > roomBelow;
  if (flip) return { left, top: Math.max(margin, anchor.top - margin - content.height) };
  return { left, top: Math.max(margin, Math.min(anchor.bottom + margin, viewport.height - margin - content.height)) };
}

export interface SpeakMenuProps {
  /** The Speak control the menu hangs off; also the one place a pointerdown
      does NOT dismiss, so a second right-click toggles it shut. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  info: BackendInfo;
  option: BackendOption;
  /** Characters this message would bill — the whole answer, never a slice. */
  chars: number;
  /** Whether the NEXT left click replays cached audio instead of paying. */
  freeReplay: boolean;
  tooLong: boolean;
  onPick: (backend: BackendId) => Promise<boolean>;
  onClose: (restoreFocus?: boolean) => void;
}

/**
 * Right-click menu of the read-aloud control: which provider speaks, what it
 * would cost, and what the next left click actually does. The left click never
 * routes through here — it speaks (#1024) — so everything in this menu is
 * information and provider choice, mirroring MicButton's BackendMenu.
 *
 * Rendered through a body portal at `fixed` coordinates: the previous inline
 * `absolute` popover was clipped by the message it belonged to and painted
 * under the next message in the feed.
 */
export function SpeakMenu({ anchorRef, info, option, chars, freeReplay, tooLong, onPick, onClose }: SpeakMenuProps) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const [saving, setSaving] = useState<BackendId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const root = rootRef.current;
    if (!anchor || !root) return;
    const rect = anchor.getBoundingClientRect();
    const next = speakMenuPlacement(
      { top: rect.top, bottom: rect.bottom, right: rect.right },
      { width: root.offsetWidth || MENU_WIDTH, height: root.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    /* Replaced only when it actually moved, so a re-measure that agrees with
       the current placement does not schedule another render. */
    setBox((previous) => (previous && previous.left === next.left && previous.top === next.top ? previous : next));
  }, [anchorRef]);

  /* After EVERY render, with no dependency list: the menu's height changes with
     what it has to say (a key warning, a save error), and measuring it once at
     mount is how a popover ends up half off the screen. */
  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  /* Click-away and Escape both dismiss; a pointerdown on the trigger is left
     alone so its own contextmenu handler can toggle the menu shut. */
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target ?? null) || anchorRef.current?.contains(target ?? null)) return;
      onClose(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose(true);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [anchorRef, onClose]);

  /* Keyboard: the menu opens on the context-menu key (Shift+F10 / the Menu key
     fire `contextmenu` on the focused trigger), so focus has to land inside it
     — on the provider currently in use — and Escape hands it back. */
  useEffect(() => {
    const root = rootRef.current;
    const items = Array.from(root?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const active = items.find((item) => item.getAttribute("aria-checked") === "true");
    (active ?? items[0] ?? root)?.focus();
  }, []);

  const pick = async (backend: BackendId) => {
    if (info.lockedByEnv || saving || backend === info.backend) return;
    setSaving(backend);
    setError(null);
    const ok = await onPick(backend);
    setSaving(null);
    if (ok) onClose(true);
    else setError(t("tts.saveFailed"));
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      tabIndex={-1}
      data-tts-menu
      aria-label={t("tts.menuTitle")}
      /* Off-screen and transparent until it has been measured — transparent
         rather than `visibility: hidden`, because a hidden element cannot take
         the focus the keyboard path moves into it on the very same commit. */
      style={box ? { left: box.left, top: box.top } : { left: -9999, top: 0, opacity: 0 }}
      className="fixed z-[80] max-h-[calc(100vh-16px)] w-[300px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[12px] border border-border bg-card p-1.5 text-left shadow-2 focus-visible:outline-none"
    >
      <div className="px-2 pb-1 pt-1.5 text-label font-semibold text-secondary">{t("tts.menuTitle")}</div>
      {/* The honesty line the confirm dialog used to carry: what the next left
          click costs, answered from the cache at render time. */}
      <div className={`px-2 text-[11.5px] font-semibold ${freeReplay ? "text-success" : "text-primary"}`}>
        {freeReplay ? t("tts.nextFree") : t("tts.nextPaid")}
      </div>
      <div className="px-2 pt-1 text-[10.5px] text-muted">{option.id} · {option.model} · {option.voice}</div>
      <div className="px-2 text-[10.5px] text-muted">{t("tts.characters", { count: chars.toLocaleString() })}</div>
      <div className="px-2 pt-1 text-[10.5px] text-primary">{t("tts.billing", { provider: option.id })}</div>
      <div className="px-2 text-[10.5px] text-primary">{t("tts.disclosure")}</div>
      <div className="px-2 pb-1 text-[10.5px] text-muted">{t("tts.seekHint")}</div>
      {tooLong ? (
        <div className="px-2 pb-1 text-[10.5px] font-semibold text-danger">
          {t("tts.tooLong", { count: MAX_TTS_MESSAGE_LENGTH.toLocaleString() })}
        </div>
      ) : null}
      {!option.available ? (
        <div className="break-all px-2 pb-1 text-[10.5px] text-danger">
          {t("tts.missingKey", { provider: option.id, path: option.keyPath })}
        </div>
      ) : null}
      {info.lockedByEnv ? <div className="px-2 pb-1 text-[10.5px] text-danger">{t("tts.menuLocked")}</div> : null}
      <div className="mt-1 border-t border-border pt-1">
        {info.options.map((candidate) => {
          const active = candidate.id === info.backend;
          return (
            <button
              key={candidate.id}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              disabled={info.lockedByEnv || saving !== null}
              onClick={() => void pick(candidate.id)}
              className={`flex w-full items-start gap-2 rounded-[9px] px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                isMobile ? "min-h-11 py-2" : "py-1.5"
              } ${active ? "bg-accent/10" : "hover:bg-canvas"}`}
            >
              <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {saving === candidate.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" aria-hidden />
                ) : active ? (
                  <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: candidate.available ? "var(--color-success)" : "var(--color-warning)" }}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-primary">
                  {candidate.id}
                  {!candidate.available ? (
                    <span className="rounded-full bg-warning-soft px-1.5 py-px text-[9.5px] font-bold text-warning">{t("tts.noKey")}</span>
                  ) : null}
                </span>
                <span className="block text-[10.5px] leading-snug text-muted">{candidate.model} · {candidate.voice}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? <div className="px-2 py-1 text-[10.5px] font-semibold text-danger">{error}</div> : null}
    </div>,
    document.body,
  );
}
