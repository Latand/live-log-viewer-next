"use client";

import { Lightbulb, LightbulbOff } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useScreenWakeLock, type KeepAwakeApi, type WakeLockEnvironment, type WakeLockStatus } from "@/hooks/useScreenWakeLock";
import { useLocale, type MessageKey } from "@/lib/i18n";

const KeepAwakeContext = createContext<KeepAwakeApi | null>(null);

/** Calls the hook. Rendered only by `KeepAwakeProvider`, and only when no outer
    provider already owns a controller. */
function KeepAwakeOwner({ children, environment }: { children: ReactNode; environment?: () => WakeLockEnvironment }) {
  /* This component re-renders only when the controller's state changes, and
     `children` is the caller's element, so passing a fresh api object costs
     nothing below — React bails out on the identical children. */
  return <KeepAwakeContext.Provider value={useScreenWakeLock(environment)}>{children}</KeepAwakeContext.Provider>;
}

/**
 * The app's one wake-lock owner (mounted in `Viewer`).
 *
 * It owns a controller only on the phone face, and only when no outer provider
 * already owns one. Both branches are on components, not hooks, so:
 *
 * - nesting providers is a no-op that reuses the outer controller — the app can
 *   never construct two and hold two sentinels;
 * - the feature is phone-**only**, not merely phone-settable. The control lives
 *   in the phone header, so a desktop-width window that once persisted the
 *   intent would otherwise hold a lock with no visible off switch. Leaving the
 *   phone face unmounts the owner, which releases the sentinel; coming back
 *   restores the persisted intent.
 *
 * `children` comes from the caller's render, so a status change re-renders this
 * provider and the context consumers only — never the board below it.
 */
export function KeepAwakeProvider({ children, environment }: { children: ReactNode; environment?: () => WakeLockEnvironment }) {
  const parent = useContext(KeepAwakeContext);
  const isMobile = useIsMobile();
  if (parent || !isMobile) return <>{children}</>;
  return <KeepAwakeOwner environment={environment}>{children}</KeepAwakeOwner>;
}

/** `null` outside a provider — surfaces render nothing rather than guessing. */
export function useKeepAwake(): KeepAwakeApi | null {
  return useContext(KeepAwakeContext);
}

/* One caption per status. Each one says what is true right now; only `active`
   claims the screen is being held (issue #712). */
const CAPTION: Record<WakeLockStatus, MessageKey> = {
  unsupported: "keepAwake.unsupported",
  insecure: "keepAwake.insecure",
  off: "keepAwake.off",
  requesting: "keepAwake.requesting",
  active: "keepAwake.active",
  waiting: "keepAwake.waiting",
  interrupted: "keepAwake.interrupted",
  blocked: "keepAwake.blocked",
  failed: "keepAwake.failed",
};

/** Statuses where no amount of tapping can produce a lock, so the switch is
    inert and the caption carries the whole explanation instead of a dead toggle. */
const HOPELESS: ReadonlySet<WakeLockStatus> = new Set<WakeLockStatus>(["unsupported", "insecure"]);

const CAPTION_ID = "keep-awake-caption";

/**
 * The phone-only «Keep screen awake» row. It lives inside the mobile header's
 * «⋯» menu, which is where the header's own width budget sends any control
 * added after issue #613 — the row itself has no room for a sixth 44px target,
 * and the focused conversation below must not lose a pixel to a setting the
 * operator touches once.
 */
export function KeepAwakeMenuRow() {
  const { t } = useLocale();
  const keepAwake = useKeepAwake();
  if (!keepAwake) return null;
  const { enabled, status, setEnabled } = keepAwake;
  const hopeless = HOPELESS.has(status);
  /* Every status except «not asked», «asking» and «held» means the operator
     wanted the screen held and it is not — those read as a warning. */
  const unmet = status !== "off" && status !== "requesting" && status !== "active";
  /* `aria-checked` follows the intent, not the momentary hold: a backgrounded
     tab has released the lock but the setting is still on, and the caption is
     what says whether anything is held. A hopeless status reads as off — the
     switch cannot be honoured at all there. */
  const checked = enabled && !hopeless;
  return (
    <div
      data-testid="keep-awake-row"
      data-wake-lock-status={status}
      className="flex flex-col gap-0.5 px-1.5 py-0.5"
    >
      <div className="flex min-h-11 items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-semibold text-primary">{t("keepAwake.label")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={t(checked ? "keepAwake.disableAria" : "keepAwake.enableAria")}
          aria-describedby={CAPTION_ID}
          title={t(CAPTION[status])}
          disabled={hopeless}
          onClick={() => setEnabled(!enabled)}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${
            status === "active" ? "border-accent/45 text-accent" : "border-border text-muted hover:text-primary"
          }`}
        >
          {checked ? <Lightbulb className="h-5 w-5" aria-hidden /> : <LightbulbOff className="h-5 w-5" aria-hidden />}
        </button>
      </div>
      {/* `role="status"` so a state the operator did not ask for — the system
          dropping the lock, a refused request — is announced, not just tinted. */}
      <span id={CAPTION_ID} role="status" className={`text-[11px] leading-snug ${unmet ? "text-warning" : "text-muted"}`}>
        {t(CAPTION[status])}
      </span>
    </div>
  );
}
