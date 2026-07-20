"use client";

import { forwardRef } from "react";

import { Ban, Loader2 } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

import type { DraftPhase } from "./draftSpawn";

/**
 * The frozen-card status line for a launched/unsettled draft spawn (issue #67).
 * Presentational and pure over `{phase, target, structured}` so every lifecycle
 * copy — booting, booting-slow, confirming, attention — is unit-testable
 * without a DOM.
 *
 * `structured` names the composer host capability (issue #266): a structured
 * (pane-less) spawn has no tmux window to point at, so its copy drops the tmux
 * wording and the `{target}` reference. A legacy tmux spawn keeps the
 * pane-and-target copy verbatim.
 *
 * The line is a `role="status"` live region: polite while it is still
 * converging, assertive only once recovery has given up (`attention`), so a
 * screen reader is not interrupted mid-boot. The spinner is reduced-motion safe;
 * `attention` swaps it for a static "don't relaunch" glyph. In `attention` the
 * region is focusable (`tabIndex -1`) so the pane can move focus to the guidance.
 */
export const DraftLaunchStatus = forwardRef<HTMLDivElement, { phase: DraftPhase; target: string; structured?: boolean; error?: string | null }>(function DraftLaunchStatus(
  { phase, target, structured = false, error },
  ref,
) {
  const { t } = useLocale();
  const attention = phase === "attention";
  const statusText = attention
    ? error || (structured
      ? t("draft.attentionStructured")
      : target
      ? t("draft.attention", { target })
      : t("draft.attentionNoTarget"))
    : phase === "confirming"
      ? structured
        ? t("draft.confirmingStructured")
        : target
        ? t("draft.confirming", { target })
        : t("draft.confirmingNoTarget")
      : structured
        ? t("draft.launchedStructured")
        : t("draft.launched", { target });

  return (
    <>
      <div
        ref={ref}
        tabIndex={attention ? -1 : undefined}
        role="status"
        aria-live={attention ? "assertive" : "polite"}
        className={`flex items-center gap-2 text-[11.5px] font-semibold outline-none ${attention ? "text-danger" : "text-muted"}`}
      >
        {attention ? (
          <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        )}
        <span>{statusText}</span>
      </div>
      {phase === "booting-slow" ? <div className="text-[11px] text-muted">{structured ? t("draft.slowStructured") : t("draft.slow", { target })}</div> : null}
    </>
  );
});
