"use client";

import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import type { CardMigrationState } from "@/lib/accounts/migration";

/**
 * One-line account-migration status ribbon under a conversation card's header
 * (rendered into `BranchPane`'s `banner` slot, the SwitchCard status line, and
 * the mobile strip). Origin-blind: an auto-balance migration looks identical to
 * a manual one — authorship lives only in the panel banner (Fable UX-A3).
 *
 * Never color-only: every state carries its own text (WCAG + the project's
 * "state legibility never leans on color alone" rule). `role="status"` so the
 * text is announced politely when it appears; the spinner respects
 * `prefers-reduced-motion` via `motion-reduce:animate-none`.
 */
export interface MigrationRibbonProps {
  /** `done`/`rolled-back` render nothing here — the feed divider marks a commit
      and a rollback leaves the intent silently. */
  state: CardMigrationState | null;
  /** Target account label, shown while switching. */
  targetLabel: string;
  /** Current account label, for the "Keep on «…»" per-session rollback action. */
  currentLabel?: string;
  /** Secret-free server failure detail appended to the failed state. */
  error?: string | null;
  /** Actionable, secret-free error from the last retry/keep attempt. Announced
      assertively so a swallowed recovery failure can never pass silently. */
  actionError?: string | null;
  onRetry?: () => void;
  onKeep?: () => void;
}

/**
 * The one-time "done" seam at the top of a successor's transcript (Fable P5):
 * a divider naming the account the conversation continued from. Informational
 * only — the archived predecessor stays linked in the migration chain server
 * side. Hidden until the server supplies the predecessor label.
 */
export function MigrationDivider({ predecessorLabel }: { predecessorLabel?: string }) {
  const { t } = useLocale();
  if (!predecessorLabel) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-sunken px-2.5 py-1 text-[10.5px] font-semibold text-muted">
      <span aria-hidden>⇄</span>
      <span className="min-w-0 truncate">{t("migrate.divider", { label: predecessorLabel })}</span>
    </div>
  );
}

const TONE: Record<"pending" | "switching" | "failed", string> = {
  pending: "border-warning/45 bg-warning-soft text-warning",
  switching: "border-accent/35 bg-accent/5 text-accent",
  failed: "border-danger/40 bg-danger-soft text-danger",
};

export function MigrationRibbon({ state, targetLabel, currentLabel, error, actionError, onRetry, onKeep }: MigrationRibbonProps) {
  const { t } = useLocale();
  if (state !== "pending" && state !== "switching" && state !== "failed") return null;

  return (
    <div
      role="status"
      aria-label={t("migrate.ribbonAria")}
      className={`flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2.5 py-1 text-[11px] font-semibold ${TONE[state]}`}
    >
      {state === "pending" ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{t("migrate.cardPending")}</span>
        </span>
      ) : null}

      {state === "switching" ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          <span className="min-w-0 truncate">{t("migrate.cardSwitching", { label: targetLabel })}</span>
        </span>
      ) : null}

      {state === "failed" ? (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate" title={error ?? undefined}>
              {t("migrate.cardFailed")}
              {error ? ` — ${error}` : ""}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <RotateCcw className="h-3 w-3" aria-hidden /> {t("migrate.cardRetry")}
              </button>
            ) : null}
            {onKeep && currentLabel ? (
              <button
                type="button"
                onClick={onKeep}
                className="inline-flex items-center rounded-[7px] border border-border bg-canvas px-2 py-0.5 text-[11px] font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("migrate.cardKeep", { label: currentLabel })}
              </button>
            ) : null}
          </span>
        </>
      ) : null}

      {actionError ? (
        <span role="alert" aria-live="assertive" className="w-full text-[10.5px] font-semibold text-danger" title={actionError}>
          {t("migrate.recoveryFailed", { detail: actionError })}
        </span>
      ) : null}
    </div>
  );
}
