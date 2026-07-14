"use client";

import { useLocale } from "@/lib/i18n";

/** Placeholder shown in the board content area until the persisted board state
    has loaded (#172). Holding this skeleton — rather than painting the raw scan
    snapshot — keeps the first real frame equal to the settled arrangement, so
    the board never flashes a wide node set that then culls to the pruned,
    collapsed, capped set.

    The layout is a self-sizing grid (auto-fill columns with a shared minimum),
    so it reflows without a jump from a 390px phone to a wide desktop and never
    forces the body to scroll horizontally. */
export function SchemeSkeleton() {
  const { t } = useLocale();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="grid flex-1 auto-rows-min content-start gap-2.5 overflow-hidden p-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))" }}
    >
      <span className="sr-only">{t("dash.loadingBoard")}</span>
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex animate-pulse flex-col gap-2 rounded-[10px] border border-border bg-card p-3 shadow-1 motion-reduce:animate-none"
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-sunken" />
            <span className="h-3 w-2/3 rounded bg-sunken" />
          </div>
          <span className="h-2.5 w-5/6 rounded bg-sunken" />
          <span className="h-2.5 w-1/2 rounded bg-sunken" />
        </div>
      ))}
    </div>
  );
}
