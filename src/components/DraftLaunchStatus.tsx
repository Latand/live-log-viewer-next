"use client";

import { forwardRef } from "react";

import { Ban, Loader2 } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

import type { DraftPhase } from "./draftSpawn";

/**
 * The frozen-card status line for a launched/unsettled draft spawn (issue #67).
 * Presentational and pure over `{phase, target}` so every lifecycle copy —
 * booting, booting-slow, confirming, attention — is unit-testable without a DOM.
 *
 * The line is a `role="status"` live region: polite while it is still
 * converging, assertive only once recovery has given up (`attention`), so a
 * screen reader is not interrupted mid-boot. The spinner is reduced-motion safe;
 * `attention` swaps it for a static "don't relaunch" glyph. In `attention` the
 * region is focusable (`tabIndex -1`) so the pane can move focus to the guidance.
 */
export const DraftLaunchStatus = forwardRef<HTMLDivElement, { phase: DraftPhase; target: string }>(function DraftLaunchStatus(
  { phase, target },
  ref,
) {
  const { t } = useLocale();
  const attention = phase === "attention";
  const statusText = attention
    ? target
      ? t("draft.attention", { target })
      : t("draft.attentionNoTarget")
    : phase === "confirming"
      ? target
        ? t("draft.confirming", { target })
        : t("draft.confirmingNoTarget")
      : t("draft.launched", { target });

  return (
    <>
      <div
        ref={ref}
        tabIndex={attention ? -1 : undefined}
        role="status"
        aria-live={attention ? "assertive" : "polite"}
        className={`flex items-center gap-2 text-[11.5px] font-semibold outline-none ${attention ? "text-err" : "text-dim"}`}
      >
        {attention ? (
          <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        )}
        <span>{statusText}</span>
      </div>
      {phase === "booting-slow" ? <div className="text-[11px] text-dim">{t("draft.slow", { target })}</div> : null}
    </>
  );
});
