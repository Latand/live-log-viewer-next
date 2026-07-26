"use client";

import { RotateCw, TriangleAlert } from "lucide-react";

import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";

/**
 * The one degraded-catalog treatment (issue #696).
 *
 * Every surface that would otherwise present an unconfirmed catalog as idle —
 * the overview board, the project rail, the project dashboard, the switchboard —
 * renders THIS, so a failed `/api/files` produces one wording, one attempt count
 * and one recovery action wherever the operator happens to be standing. The
 * recovery dispatches the shared files-refresh event, which cancels the pending
 * hydration backoff in `useFiles` and retries immediately.
 *
 * `size="panel"` is the full statement for a surface with room for it;
 * `size="inline"` drops the explanatory sentence for the rail's narrow column.
 */
export function CatalogFailureNotice({
  failures,
  size = "panel",
  className = "",
}: {
  failures: number;
  size?: "panel" | "inline";
  className?: string;
}) {
  const { t } = useLocale();
  if (failures <= 0) return null;
  const panel = size === "panel";
  return (
    <div
      role="alert"
      data-catalog-error="true"
      className={`flex flex-col items-center gap-2 text-center ${
        panel ? "mx-auto max-w-[420px] rounded-[10px] border border-danger/35 bg-danger-soft px-4 py-4" : "px-3 py-4"
      } ${className}`}
    >
      <span className={`inline-flex items-center gap-1.5 font-bold text-danger ${panel ? "text-[13px]" : "text-[12px]"}`}>
        <TriangleAlert className={panel ? "h-4 w-4 shrink-0" : "h-3.5 w-3.5 shrink-0"} aria-hidden />
        {t("catalog.errorTitle")}
      </span>
      {panel ? <span className="text-[12px] text-secondary">{t("catalog.errorBody")}</span> : null}
      <span className="text-[11px] font-semibold tabular-nums text-muted">{t("catalog.attempts", { count: failures })}</span>
      <button
        type="button"
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-card font-semibold text-primary hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          panel ? "px-4 text-[13px]" : "px-3 text-[12px]"
        }`}
        onClick={() => requestFilesRefresh()}
      >
        <RotateCw className="h-4 w-4" aria-hidden /> {t("catalog.retry")}
      </button>
    </div>
  );
}
