"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Check, Loader2 } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";

import { subscribeTtsCache } from "./ttsSession";

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
const ALERT_WIDTH = 224;

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
  /* One clamp for both branches: the flipped side used to carry only the lower
     bound, so an anchor scrolled far below the fold placed the menu below the
     fold with it. */
  const wanted = flip ? anchor.top - margin - content.height : anchor.bottom + margin;
  return { left, top: Math.max(margin, Math.min(wanted, viewport.height - margin - content.height)) };
}

/**
 * Whether the trigger is still on screen at all. A popover anchored to a
 * scrolled-away trigger has nothing to point at, and `speakMenuPlacement`
 * clamps rather than following it off the edge — so the caller that must
 * disappear with its message (the alert) asks this instead of being pinned to
 * the viewport edge for the rest of the session (#1030). Touching an edge still
 * counts as on screen, so a degenerate zero rect never hides anything.
 */
function anchorOnScreen(rect: { top: number; bottom: number; left: number; right: number }, viewport: { width: number; height: number }): boolean {
  return rect.bottom >= 0 && rect.top <= viewport.height && rect.right >= 0 && rect.left <= viewport.width;
}

/**
 * Keeps an anchored popover placed against the viewport: measures it after
 * every render (its height changes with what it has to say, and measuring once
 * at mount is how a popover ends up half off the screen) and again on scroll
 * and resize. Returns the style for its `fixed` root — off-screen and
 * transparent until the first measurement, transparent rather than
 * `visibility: hidden` because a hidden element cannot take the focus the
 * keyboard path moves into it on the very same commit.
 *
 * Shared by the menu and the refusal alert, which are the same popover anchored
 * to the same trigger: an inline `absolute` alert is clipped by the message row
 * (`.feed-cv` carries `content-visibility: auto`, hence paint containment) and
 * painted over by the next message, which is what #1024 condemned.
 *
 * Also reports whether the trigger is still on screen, which is measured even
 * while the caller renders nothing — a caller that hides itself when the
 * trigger scrolls away has to be able to come back when it scrolls in again.
 */
export function useAnchoredBox(
  anchorRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  fallbackWidth = MENU_WIDTH,
): { style: CSSProperties; onScreen: boolean } {
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const [onScreen, setOnScreen] = useState(true);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setOnScreen(anchorOnScreen(rect, viewport));
    /* Nothing rendered to place — the visibility above is what brings it back. */
    const root = rootRef.current;
    if (!root) return;
    const next = speakMenuPlacement(
      { top: rect.top, bottom: rect.bottom, right: rect.right },
      { width: root.offsetWidth || fallbackWidth, height: root.offsetHeight },
      viewport,
    );
    /* Replaced only when it actually moved, so a re-measure that agrees with
       the current placement does not schedule another render. */
    setBox((previous) => (previous && previous.left === next.left && previous.top === next.top ? previous : next));
  }, [anchorRef, rootRef, fallbackWidth]);

  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return { style: box ? { left: box.left, top: box.top } : { left: -9999, top: 0, opacity: 0 }, onScreen };
}

/**
 * Everything the left click refuses or fails at: a message past the ceiling, a
 * provider with no key, an expired replay, a provider or playback error. Since
 * #1024 this is the only feedback a refused left click gives, so it goes
 * through the same portal as the menu instead of being clipped inside the
 * message row. Key paths break anywhere, the way the old dialog wrapped them.
 *
 * Only ever shown while the menu is CLOSED — both hang off the same trigger at
 * the same coordinates, so an open menu carries the same text in its own
 * notice slot rather than being painted over by it.
 *
 * It also has to END (#1030). Portalling it to `fixed` coordinates took away
 * the exit the inline alert had — scrolling out of sight with the message it
 * belongs to — and the placement math clamps a scrolled-away anchor back onto
 * the screen, so a refusal that nothing clears parked itself at the viewport
 * edge over the rest of the session. Two ends, both borrowed from the menu
 * rather than invented: it goes away with its trigger (`onScreen`), and an
 * outside pointerdown or Escape dismisses it. Neither can fire while the menu
 * owns those keys and clicks, because this is unmounted for as long as the menu
 * is open. Pointerdowns inside the alert are left alone so the key path it
 * names can be selected and copied, and the trigger keeps its own click.
 */
export function SpeakAlert({
  anchorRef,
  onDismiss,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { style, onScreen } = useAnchoredBox(anchorRef, rootRef, ALERT_WIDTH);

  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target ?? null) || anchorRef.current?.contains(target ?? null)) return;
      onDismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [anchorRef, onDismiss]);

  if (typeof document === "undefined" || !onScreen) return null;
  return createPortal(
    <div
      ref={rootRef}
      role="alert"
      data-tts-alert
      style={style}
      className="fixed z-[80] w-56 max-w-[calc(100vw-16px)] break-all rounded-[10px] border border-border bg-card p-2 text-[11px] text-danger shadow-2"
    >
      {children}
    </div>,
    document.body,
  );
}

export interface SpeakMenuProps {
  /** The Speak control the menu hangs off; also the one place a pointerdown
      does NOT dismiss, so a second right-click toggles it shut. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  info: BackendInfo;
  option: BackendOption;
  /** Characters this message would bill — the whole answer, never a slice. */
  chars: number;
  /** A refusal or failure raised while this menu is open — the alert popover
      would land on top of it, so the menu says it instead. */
  notice: string | null;
  /** Whether the NEXT left click would replay cached audio instead of paying.
      A callback, not a snapshot: another card's long answer can evict these
      chunks while this menu is open, and the line has to follow. */
  freeReplay: () => boolean;
  /** Whether this control is reading right now — then the next left click is a
      stop, and costs nothing either way. */
  active: boolean;
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
export function SpeakMenu({ anchorRef, info, option, chars, notice, freeReplay, active, tooLong, onPick, onClose }: SpeakMenuProps) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const { style } = useAnchoredBox(anchorRef, rootRef);
  const [saving, setSaving] = useState<BackendId | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Only a re-render trigger: the cost line is answered by the tts cache, and
     an open menu has to stop advertising a free replay the moment the chunks
     behind it are evicted. */
  const [, setCacheTick] = useState(0);
  useEffect(() => subscribeTtsCache(() => setCacheTick((tick) => tick + 1)), []);

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
      style={style}
      className="fixed z-[80] max-h-[calc(100vh-16px)] w-[300px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[12px] border border-border bg-card p-1.5 text-left shadow-2 focus-visible:outline-none"
    >
      <div className="px-2 pb-1 pt-1.5 text-label font-semibold text-secondary">{t("tts.menuTitle")}</div>
      {/* The honesty line the confirm dialog used to carry: what the next left
          click actually does. While this control is reading, that click is a
          stop — saying "paid synthesis" there is the same lie the dialog was
          removed for. Otherwise it is a replay or a purchase, asked of the
          cache on every render this menu is subscribed to. */}
      <div className={`px-2 text-[11.5px] font-semibold ${active ? "text-secondary" : freeReplay() ? "text-success" : "text-primary"}`}>
        {active ? t("tts.nextStop") : freeReplay() ? t("tts.nextFree") : t("tts.nextPaid")}
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
      {error ?? notice ? <div className="break-all px-2 py-1 text-[10.5px] font-semibold text-danger">{error ?? notice}</div> : null}
    </div>,
    document.body,
  );
}
