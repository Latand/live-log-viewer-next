"use client";

import { useEffect, useRef, useState } from "react";

import type { SwitchboardData } from "@/hooks/useSwitchboardData";
import { useLocale } from "@/lib/i18n";

interface Props {
  data: SwitchboardData;
  onOpen: () => void;
}

/**
 * Collapsed pill in the corner so it stops covering feed content; the live
 * preview list appears on hover/focus only. Click opens the switchboard.
 */
export function CornerStatus({ data, onOpen }: Props) {
  const { t } = useLocale();
  const waitingCount = data.waiting.length;
  const prevWaiting = useRef(waitingCount);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (waitingCount > prevWaiting.current) {
      setPulse(true);
      const timer = window.setTimeout(() => setPulse(false), 900);
      prevWaiting.current = waitingCount;
      return () => window.clearTimeout(timer);
    }
    prevWaiting.current = waitingCount;
  }, [waitingCount]);

  return (
    <div className="group absolute bottom-3 right-3 z-20">
      {data.livePreview.length ? (
        <div className="pointer-events-none mb-1.5 hidden w-[300px] rounded-[8px] border border-border bg-card/95 px-3 py-2 shadow-1 backdrop-blur group-focus-within:block group-hover:block">
          {data.livePreview.map((item) => (
            <div key={item.file.path} className="flex min-w-0 gap-1.5 py-0.5 text-[10.5px]">
              <span className="min-w-0 flex-1 truncate font-semibold">{item.title}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{item.statusLine || t("status.working")}</span>
            </div>
          ))}
        </div>
      ) : null}
      <button
        className={`ml-auto flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[11.5px] font-bold shadow-1 backdrop-blur transition-transform hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          pulse ? "scale-110 border-warning/70" : ""
        } motion-reduce:transition-none`}
        aria-label={t("corner.openSwitchboard")}
        onClick={onOpen}
      >
        <span className={`h-2 w-2 rounded-full ${data.working.length ? "animate-pulse bg-success" : "bg-muted"}`} />
        <span>{data.working.length}</span>
        <span className={waitingCount ? "text-warning" : "text-muted"}>{t("corner.waitingCount", { count: waitingCount })}</span>
      </button>
    </div>
  );
}
