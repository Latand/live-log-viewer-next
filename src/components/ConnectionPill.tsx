"use client";

import { useEffect, useRef, useState } from "react";

import type { ConnectionState } from "@/components/runtime/runtimeModel";
import { useLocale, type TFunction } from "@/lib/i18n";

import { useRuntime } from "@/hooks/useRuntime";

/** Visual tone per connection state, in the dashboard token palette. */
const TONE: Record<ConnectionState, { dot: string; text: string; pulse: boolean }> = {
  live: { dot: "bg-ok", text: "text-ok", pulse: true },
  reconnecting: { dot: "bg-[#e0ae45]", text: "text-[#b8860b]", pulse: true },
  degraded: { dot: "bg-[#e0ae45]", text: "text-[#b8860b]", pulse: false },
  offline: { dot: "bg-err", text: "text-err", pulse: false },
};

const ANNOUNCE_KEY: Record<ConnectionState, "runtime.announce.live" | "runtime.announce.reconnecting" | "runtime.announce.degraded" | "runtime.announce.offline"> = {
  live: "runtime.announce.live",
  reconnecting: "runtime.announce.reconnecting",
  degraded: "runtime.announce.degraded",
  offline: "runtime.announce.offline",
};

export interface ConnectionPillViewProps {
  connection: ConnectionState;
  /** Non-null while the transient resynced note is up. */
  resynced: boolean;
  /** True for a legacy tmux session — pinned to derived provenance. */
  legacy?: boolean;
  compact?: boolean;
  /** Announcement text, already throttled by the wrapper. */
  announce: string;
  t: TFunction;
}

/**
 * Presentational connection indicator. `role="status"` + `aria-live="polite"`
 * announces state changes once (the wrapper throttles flapping). Receipt/state
 * words are text, never color alone; all motion respects `motion-reduce`.
 */
export function ConnectionPillView({ connection, resynced, legacy, compact, announce, t }: ConnectionPillViewProps) {
  const tone = TONE[connection];
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-panel/95 font-bold shadow-card backdrop-blur ${
        compact ? "px-2 py-0.5 text-[10.5px]" : "px-2.5 py-1 text-[11.5px]"
      }`}
      data-connection={connection}
    >
      <span
        className={`h-2 w-2 rounded-full ${tone.dot} ${tone.pulse ? "animate-pulse motion-reduce:animate-none" : ""}`}
        aria-hidden
      />
      <span className={tone.text}>{t(`runtime.${connection}`)}</span>
      {legacy ? <span className="text-dim">· {t("runtime.legacyProvenance")}</span> : null}
      {resynced ? (
        <span className="rounded-full bg-accent/10 px-1.5 text-[10px] font-bold text-accent">{t("runtime.resynced")}</span>
      ) : null}
      {/* One polite announcement per settled transition. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}

/** Debounce announcements so reconnect flapping never spams a screen reader. */
function useThrottledAnnounce(value: string, delayMs = 600): string {
  const [announced, setAnnounced] = useState(value);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    const timer = window.setTimeout(() => {
      if (latest.current === value) setAnnounced(value);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return announced;
}

export interface ConnectionPillProps {
  legacy?: boolean;
  compact?: boolean;
}

/**
 * The tab's runtime connection pill. Renders nothing while slice-one is
 * disabled (the flag is off), so it is inert on the landing page until the
 * backend routes exist and the flag flips on.
 */
export function ConnectionPill({ legacy, compact }: ConnectionPillProps) {
  const { t } = useLocale();
  const { enabled, connection, resyncedAt } = useRuntime();
  const resynced = resyncedAt !== null;
  const announce = useThrottledAnnounce(resynced ? t("runtime.announce.resynced") : t(ANNOUNCE_KEY[connection]));
  if (!enabled) return null;
  return (
    <div className={compact ? "pointer-events-auto absolute right-2 top-1.5 z-30" : "pointer-events-auto fixed bottom-3 left-3 z-20"}>
      <ConnectionPillView connection={connection} resynced={resynced} legacy={legacy} compact={compact} announce={announce} t={t} />
    </div>
  );
}
