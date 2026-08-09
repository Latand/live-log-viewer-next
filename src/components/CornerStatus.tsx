"use client";

import type { SwitchboardData } from "@/hooks/useSwitchboardData";
import { useLocale } from "@/lib/i18n";

interface Props {
  data: SwitchboardData;
  onOpen: () => void;
}

/**
 * Collapsed pill in the corner so it stops covering feed content; the live
 * preview list appears on hover/focus only. Click opens the switchboard.
 *
 * The pill carries the working/health half only: the one global needs-you
 * count (and its arrival emphasis) lives in the attention island, so a second
 * waiting counter here would drift from it (issue #963).
 */
export function CornerStatus({ data, onOpen }: Props) {
  const { t } = useLocale();

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
        className="ml-auto flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[11.5px] font-bold shadow-1 backdrop-blur hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={t("corner.openSwitchboard")}
        onClick={onOpen}
      >
        <span className={`h-2 w-2 rounded-full ${data.working.length ? "animate-pulse bg-success motion-reduce:animate-none" : "bg-muted"}`} />
        <span>{data.working.length}</span>
      </button>
    </div>
  );
}
